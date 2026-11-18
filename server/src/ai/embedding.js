import { config } from '../config.js';
import { tokenize } from './local-engine.js';
import { run } from '../db/index.js';
import { newId, now } from '../utils/helpers.js';

/**
 * 向量化统一层（W2 社群助手的检索地基）。
 *
 * 两条路径输出同构的稠密 number[] 向量：
 *  - embedding：OpenAI 兼容 /embeddings（text-embedding-3-small，1536 维）
 *  - tfidf：本地字符 n-gram TF-IDF，hash 到固定 256 维 + L2 归一（断网/无 Key 兜底）
 *
 * 两个向量空间不可混比：上层按 embeddingConfigured() 决定用哪条路径，
 * 检索时整条链路只在一个空间内比较。
 */

export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const TFIDF_MODEL = 'tfidf-v1';
const TFIDF_DIM = 256;

/** embeddings 仅由 OpenAI 兼容接口提供（Anthropic 不提供该端点） */
export function embeddingConfigured() {
  return Boolean(config.ai.openaiKey);
}

/** 稳定哈希：把任意 token 折进 0..TFIDF_DIM-1 */
function hashTerm(term) {
  let h = 0;
  for (let i = 0; i < term.length; i += 1) h = (h * 31 + term.charCodeAt(i)) >>> 0;
  return h % TFIDF_DIM;
}

/**
 * 本地 TF-IDF → 256 维稠密向量（L2 归一）。
 * @param {string} text   目标文本
 * @param {string[]} corpus 语料（用于 IDF；为空时退化为 TF 归一化）
 */
export function tfidfVector(text, corpus = []) {
  const tf = new Map();
  // 只取 2-gram 与拉丁词：单个汉字（「人/一/起/吗」这类）在短文里几乎全是噪声，
  // 会让不相关帖子靠功能字撞出虚高余弦，把真正命中的帖子挤下去。
  for (const t of tokenize(text)) if (t.length >= 2) tf.set(t, (tf.get(t) || 0) + 1);
  if (!tf.size) return new Array(TFIDF_DIM).fill(0);

  const n = corpus.length || 1;
  const vec = new Array(TFIDF_DIM).fill(0);
  for (const [term, freq] of tf) {
    let df = 0;
    for (const doc of corpus) if (doc.includes(term)) df += 1;
    const idf = df > 0 ? Math.log((n + 1) / (df + 1)) + 1 : 1;
    vec[hashTerm(term)] += (1 + Math.log(freq)) * idf;
  }

  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return norm ? vec.map((v) => v / norm) : vec;
}

/** 稠密向量余弦相似度（两空间各算各的，长度不同视为不可比） */
export function vectorCosine(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

function logEmbed({ userId, model, latency, ok, error }) {
  try {
    run(
      `INSERT INTO ai_logs (id,user_id,task,provider,model,latency_ms,ok,error,tokens_in,tokens_out,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      newId('ail'),
      userId || null,
      'embed',
      ok ? 'openai' : 'openai', // 仅 OpenAI 兼容接口提供 embedding
      model,
      Math.round(latency || 0),
      ok ? 1 : 0,
      error ? String(error).slice(0, 500) : '',
      0,
      0,
      now(),
    );
  } catch {
    /* 审计失败不影响主流程 */
  }
}

/**
 * 发帖入库后为其计算并存储 embedding。永不抛错。
 * 无 Key 时直接跳过（TF-IDF 路径在查询时现算，不落库）。
 * @returns {boolean} 是否写入了向量
 */
/** 把一个已算好的向量写入 post_vectors（供惰性补索引复用） */
export function storeEmbedding(postId, vec) {
  run(
    `INSERT INTO post_vectors (post_id, embedding, kind, model, updated_at) VALUES (?,?,?,?,?)
     ON CONFLICT(post_id) DO UPDATE SET embedding = excluded.embedding, kind = excluded.kind, model = excluded.model, updated_at = excluded.updated_at`,
    postId,
    JSON.stringify(vec),
    'embedding',
    EMBEDDING_MODEL,
    now(),
  );
}

export async function indexPost(postId, text) {
  if (!embeddingConfigured() || !postId || !String(text || '').trim()) return false;
  try {
    const [vec] = await embedViaApi([String(text).trim()], {});
    if (!vec?.length) return false;
    storeEmbedding(postId, vec);
    return true;
  } catch {
    return false;
  }
}

/**
 * 调用 OpenAI 兼容 /embeddings，批量返回 number[][]（按输入顺序）。
 * 失败时抛错，由调用方决定是否降级到 TF-IDF。
 */
export async function embedViaApi(texts, { userId } = {}) {
  const started = Date.now();
  const body = { model: EMBEDDING_MODEL, input: texts };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.ai.timeoutMs);
  try {
    const res = await fetch(`${config.ai.openaiBase}/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.ai.openaiKey}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = `OpenAI embeddings ${res.status}: ${data?.error?.message || JSON.stringify(data).slice(0, 200)}`;
      logEmbed({ userId, model: EMBEDDING_MODEL, latency: Date.now() - started, ok: false, error: msg });
      throw new Error(msg);
    }

    const vectors = (data.data || [])
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
    logEmbed({ userId, model: EMBEDDING_MODEL, latency: Date.now() - started, ok: true });
    return vectors;
  } catch (err) {
    const msg = err?.name === 'AbortError' ? 'timeout' : err?.message || String(err);
    logEmbed({ userId, model: EMBEDDING_MODEL, latency: Date.now() - started, ok: false, error: msg });
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
