import { all, get, run, toJson, parseJson } from '../db/index.js';
import { newId, now } from '../utils/helpers.js';
import { callAIWithFallback } from './provider.js';
import * as P from './prompts.js';
import { tokenize } from './local-engine.js';
import { embeddingConfigured, embedViaApi, storeEmbedding, tfidfVector, vectorCosine } from './embedding.js';

/**
 * 社群问答助手（W2）编排层。
 *
 * 流程：问句 + 图谱扩展词 → 向量召回（embedding / TF-IDF 双路）→ 混合重排
 *       → assistant-answer 生成（无 Key 模板兜底）→ 会话落库。
 * 永不抛错，单点失败整体降级。
 */

const SESSION_LIMIT = 20; // 会话 messages FIFO 上限
const CONTEXT_TURNS = 6; // 送 LLM 的最近轮数
const TOP_K = 8; // 检索返回条数
const CANDIDATE_LIMIT = 300; // 候选帖子上限

const truncate = (s, n) => {
  const t = String(s || '');
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
const fmtDate = (ts) => {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
};

/* ---------------- 图谱个性化（W1 复用） ---------------- */

/** 提问者 top5 兴趣节点名 + 别名 → 查询扩展词；同时给出生动描述 */
function interestProfile(userId) {
  const rows = all(
    `SELECT n.name, n.aliases, ui.weight FROM user_interests ui
     JOIN interest_nodes n ON n.id = ui.node_id
     WHERE ui.user_id = ? ORDER BY ui.weight DESC LIMIT 5`,
    userId,
  );
  const words = [];
  const brief = rows.map((r) => `${r.name}(${Math.round(r.weight)})`).join('、');
  for (const r of rows) {
    if (r.name) words.push(r.name);
    for (const a of parseJson(r.aliases, [])) if (a) words.push(a);
  }
  return { words: [...new Set(words)], brief };
}

/* ---------------- 检索 ---------------- */

/** 有意义的词项（中文 2-gram + 拉丁词），用于关键词命中 */
function meaningfulTerms(text) {
  const set = new Set();
  for (const t of tokenize(text)) if (t.length >= 2) set.add(t);
  return [...set];
}

function keywordHit(question, content) {
  const terms = meaningfulTerms(question);
  if (!terms.length) return 0;
  let hits = 0;
  for (const t of terms) if (content.includes(t)) hits += 1;
  return hits / terms.length;
}

function tagOverlap(probes, tags, topics) {
  const hay = [...tags, ...topics];
  if (!hay.length) return 0;
  // 二值：只要带一个和问句相关的标签就计满。ai_tags / topics 是 AI 或人打的、
  // 语义可靠，按「命中标签占帖子标签的比例」会被无关标签稀释（10 个标签里命中 1 个只拿 0.1）。
  for (const tag of hay) {
    for (const p of probes) {
      if (tag.includes(p) || p.includes(tag)) return 1;
    }
  }
  return 0;
}

/** 两种模式的重排权重：embedding 余弦可信，TF-IDF 余弦弱、要更倚重标签与关键词 */
const RERANK = {
  embedding: { v: 0.6, t: 0.25, k: 0.15 },
  tfidf: { v: 0.4, t: 0.35, k: 0.25 },
};

function loadCandidates() {
  return all(
    `SELECT p.id, p.content, p.ai_tags, p.topics, p.created_at, u.nickname AS author
     FROM posts p JOIN users u ON u.id = p.author_id
     ORDER BY p.created_at DESC LIMIT ?`,
    CANDIDATE_LIMIT,
  );
}

/** 给定问句向量与各帖向量，算混合分并排序；expansionWords 只作个性化微调（小加分，不喧宾夺主） */
function scorePosts(posts, qv, vectors, question, probes, mode, expansionWords = []) {
  const w = RERANK[mode] || RERANK.tfidf;
  const scored = [];
  for (const p of posts) {
    const pv = vectors.get(p.id);
    if (!pv?.length) continue; // 无向量（embedding 缺失且补算失败）跳过
    const v = vectorCosine(qv, pv);
    const t = tagOverlap(probes, parseJson(p.ai_tags, []), parseJson(p.topics, []));
    const k = keywordHit(question, p.content);
    const score = w.v * v + w.t * t + w.k * k + interestBoost(p, expansionWords);
    if (score > 0) scored.push({ ...p, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, TOP_K);
}

/** 帖子标签/话题命中用户兴趣时的轻微加成 —— 用于在「同样相关」的帖子里偏向自己感兴趣的 */
function interestBoost(p, expansionWords) {
  if (!expansionWords.length) return 0;
  const hay = [...parseJson(p.ai_tags, []), ...parseJson(p.topics, [])];
  for (const tag of hay) {
    for (const w of expansionWords) {
      if (tag.includes(w) || w.includes(tag)) return 0.08;
    }
  }
  return 0;
}

async function retrieve(question, expansionWords) {
  const posts = loadCandidates();
  if (!posts.length) return [];
  // 标签/关键词探针只取问句本身 —— 显式意图压过个人兴趣；
  // 兴趣扩展词只作轻微个性化加分（interestBoost），不进探针、不混进问句向量。
  const probes = meaningfulTerms(question);

  if (embeddingConfigured()) {
    try {
      const stored = new Map(
        all("SELECT post_id, embedding FROM post_vectors WHERE kind = 'embedding'").map((r) => [
          r.post_id,
          parseJson(r.embedding, null),
        ]),
      );
      // 惰性补索引：没向量的帖子现算现存
      const missing = posts.filter((p) => !stored.get(p.id)?.length);
      if (missing.length) {
        const vecs = await embedViaApi(missing.map((p) => p.content), {});
        vecs.forEach((v, i) => {
          if (v?.length) {
            stored.set(missing[i].id, v);
            storeEmbedding(missing[i].id, v);
          }
        });
      }
      const qv = (await embedViaApi([question], {}))[0];
      if (qv?.length) return scorePosts(posts, qv, stored, question, probes, 'embedding', expansionWords);
      // qv 为空则退回 TF-IDF 路径
    } catch (err) {
      console.warn('[assistant] embedding 检索失败，回退 TF-IDF:', err?.message || err);
    }
  }

  const corpus = posts.map((p) => p.content);
  const qv = tfidfVector(question, corpus);
  const vectors = new Map(posts.map((p) => [p.id, tfidfVector(p.content, corpus)]));
  return scorePosts(posts, qv, vectors, question, probes, 'tfidf', expansionWords);
}

/* ---------------- 生成 ---------------- */

/** 无 Key 模板兜底：答案可读、引用可点、溯源完整 */
function localAnswer(hits) {
  if (!hits.length) return { answer: '社区里暂时没有找到相关内容，换个说法试试？', citations: [] };
  const lines = hits.map((h, i) => `${i + 1}. ${truncate(h.content, 40)}`).join('\n');
  return {
    answer: `根据社区动态，找到 ${hits.length} 条相关内容：\n${lines}`,
    citations: hits.map((h) => ({ post_id: h.id, quote: truncate(h.content, 40) })),
  };
}

/* ---------------- 会话 ---------------- */

function loadSession(userId) {
  return get('SELECT * FROM assistant_sessions WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1', userId);
}

function createSession(userId) {
  const id = newId('as');
  const ts = now();
  run(
    'INSERT INTO assistant_sessions (id,user_id,messages,created_at,updated_at) VALUES (?,?,?,?,?)',
    id, userId, '[]', ts, ts,
  );
  return get('SELECT * FROM assistant_sessions WHERE id = ?', id);
}

/* ---------------- 对外主入口 ---------------- */

export async function ask(userId, question, sessionId) {
  try {
    const q = String(question || '').trim();
    if (!q) return { ok: false, error: '问题不能为空' };

    let session = sessionId
      ? get('SELECT * FROM assistant_sessions WHERE id = ? AND user_id = ?', sessionId, userId)
      : null;
    if (!session) session = loadSession(userId) || createSession(userId);
    const messages = parseJson(session.messages, []);

    const profile = interestProfile(userId);
    const hits = await retrieve(q, profile.words);

    const snippets = hits.map((h) => ({
      id: h.id,
      author: h.author || '同学',
      time: fmtDate(h.created_at),
      content: truncate(h.content, 200),
    }));
    const history = messages.slice(-CONTEXT_TURNS * 2).map((m) => ({ role: m.role, content: m.content }));

    const gen = await callAIWithFallback(
      {
        task: 'assistant-answer',
        userId,
        system: P.ASSISTANT_SYSTEM,
        messages: [{ role: 'user', content: P.assistantPrompt(q, history, snippets, profile.brief) }],
        json: true,
        maxTokens: 800,
        temperature: 0.6,
      },
      () => localAnswer(hits),
    );

    const data = gen.data || {};
    const answer = typeof data.answer === 'string' && data.answer ? data.answer : localAnswer(hits).answer;
    const validIds = new Set(hits.map((h) => h.id));
    const citations = (Array.isArray(data.citations) ? data.citations : [])
      .filter((c) => c && validIds.has(c.post_id))
      .map((c) => ({ post_id: c.post_id, quote: truncate(c.quote, 60) }));

    const sources = hits.map((h) => ({
      post_id: h.id,
      author: h.author || '同学',
      excerpt: truncate(h.content, 40),
      ts: h.created_at,
    }));

    const ts = now();
    const next = [
      ...messages,
      { role: 'user', content: q, ts },
      { role: 'assistant', content: answer, citations, ts },
    ].slice(-SESSION_LIMIT);
    run('UPDATE assistant_sessions SET messages = ?, updated_at = ? WHERE id = ?', toJson(next), ts, session.id);

    return {
      ok: true,
      session_id: session.id,
      answer,
      citations,
      sources,
      degraded: gen.degraded,
      hits: hits.length,
    };
  } catch (err) {
    console.warn('[assistant] ask 失败:', err?.message || err);
    return { ok: false, error: String(err?.message || err) };
  }
}

export function history(userId) {
  const session = loadSession(userId);
  return session ? parseJson(session.messages, []) : [];
}

/** 重开会话：新建一条会话行（旧行保留不再读取，history 永远取最新） */
export function reset(userId) {
  createSession(userId);
  return { ok: true };
}
