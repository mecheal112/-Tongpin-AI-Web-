import { get, all, run, parseJson, toJson } from '../db/index.js';
import { newId, now } from '../utils/helpers.js';
import { callAIWithFallback } from './provider.js';
import { INTEREST_EXTRACT_SYSTEM, interestExtractPrompt } from './prompts.js';
import { extractInterestItems, INTEREST_LEXICON } from './local-engine.js';

/**
 * 兴趣图谱编排层。
 *
 * 职责：把「一段文本」变成「图谱上的证据」——
 *   抽取（AI 主、本地兜底）→ 归一（并入已有节点/建新节点）→ 应用权重 → 回写画像缓存。
 *
 * 三条不变量：
 *   1. 入图失败永不阻塞主流程（调用方 try/catch，这里也不抛）
 *   2. 无 Key 时输出与 AI 版同构，演示不断链
 *   3. 每次权重变化都有 evidence 或 weight_log 可溯源
 */

/** 权重与证据的约定常量（对应 spec §4.4） */
const WEIGHT_MIN = 5;
const WEIGHT_MAX = 100;
const EVIDENCE_CAP = 8;
const DEDUPE_MS = 24 * 60 * 60 * 1000; // 同源同节点 24h 内只计一次
const DECAY_DAYS = 30; // 连续 30 天无新证据开始衰减
const DECAY_FACTOR = 0.9;
const BATCH_CAP = 5; // 单次抽取节点上限

/** 接入点基准强度（spec §4.4）：访谈 > 发帖 > 资料 > 入组 */
const SOURCE_BASE = { interview: 25, post: 15, profile: 10, group: 5 };

/** 实际 delta = 接入点基准 ×（抽取强度 / 15），clamp 到 [3, 1.5×基准]；抽取强度缺省 15 即按基准计 */
function effectiveDelta(source, strength) {
  const base = SOURCE_BASE[source] ?? 10;
  return Math.min(Math.round(base * 1.5), Math.max(3, Math.round((base * (Number(strength) || 15)) / 15)));
}

/* ---------------- 规范节点目录 ---------------- */

let seeded = false;

/** 首次使用时把 14 类词表落成规范节点（幂等）。 */
export function ensureSeeded() {
  if (seeded) return;
  const cnt = get('SELECT COUNT(*) AS c FROM interest_nodes')?.c ?? 0;
  if (cnt === 0) {
    const ts = now();
    for (const [name, words] of Object.entries(INTEREST_LEXICON)) {
      run(
        `INSERT OR IGNORE INTO interest_nodes (id,name,aliases,category,parent_id,status,created_at)
         VALUES (?,?,?,?,NULL,'confirmed',?)`,
        newId('nd'),
        name,
        toJson(words.slice(0, 8)),
        name,
        ts,
      );
    }
  }
  seeded = true;
}

/** 供提示词使用的节点目录（规范名 + 别名） */
export function getNodeCatalog(limit = 200) {
  ensureSeeded();
  return all('SELECT id, name, aliases FROM interest_nodes ORDER BY status = \'confirmed\' DESC, created_at ASC LIMIT ?', limit).map((r) => ({
    id: r.id,
    name: r.name,
    aliases: parseJson(r.aliases, []),
  }));
}

/** 清洗节点名：剥掉抽取时带进来的语气词/助词残渣（如「露营了」「了露营」→「露营」） */
export function cleanNodeName(name) {
  return String(name || '')
    .trim()
    .replace(/^[的了]+/, '')
    .replace(/[了呢啊吧嘛的]+$/, '')
    .trim();
}

/**
 * 归一：把抽取结果映射到节点 id。
 * 命中规则优先级：规范名 > 别名 > create 新节点。单次上限 BATCH_CAP。
 */
function normalizeItems(rawItems) {
  const catalog = getNodeCatalog();
  const byName = new Map(catalog.map((n) => [n.name, n]));
  const byAlias = new Map();
  for (const n of catalog) for (const a of n.aliases) if (!byAlias.has(a)) byAlias.set(a, n);

  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(rawItems) ? rawItems : []) {
    if (!raw || typeof raw !== 'object') continue;
    const wanted = cleanNodeName(raw.node || raw.suggest_name);
    if (!wanted || wanted.length < 2 || seen.has(wanted)) continue;

    let node = byName.get(wanted) || byAlias.get(wanted);
    const create = !node && (raw.create === true || Boolean(raw.suggest_name));
    if (!node && !create) continue; // 目录外又不许新建 → 丢弃

    seen.add(wanted);
    out.push({
      node,
      newNodeName: node ? null : wanted.slice(0, 12),
      relation: ['sub_of', 'related', 'co_occurs'].includes(raw.relation) ? raw.relation : 'co_occurs',
      delta: Math.min(30, Math.max(0, Number(raw.delta) || 12)),
      quote: String(raw.quote || '').slice(0, 80),
    });
    if (out.length >= BATCH_CAP) break;
  }
  return out;
}

/** 建新节点 / 补别名 */
function resolveNode(item, ts) {
  if (item.node) {
    // 归一进了已有节点：如果这次是用别的叫法命中的，把叫法收进别名
    return item.node.id;
  }
  const name = item.newNodeName;
  // 双重检查：并发或上次会话可能已建同名节点
  const existing = get('SELECT id FROM interest_nodes WHERE name = ?', name);
  if (existing) return existing.id;
  const id = newId('nd');
  // 新节点挂到与它共现最多的规范节点下（有就建层级感，没有就独立）
  run(
    `INSERT INTO interest_nodes (id,name,aliases,category,parent_id,status,created_at)
     VALUES (?,?,?,?,NULL,'auto',?)`,
    id,
    name,
    '[]',
    '其他',
    ts,
  );
  return id;
}

/** 同批次节点两两连边（共现/关联/从属） */
function linkBatch(ids, relation, ts) {
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const [a, b] = ids[i] < ids[j] ? [ids[i], ids[j]] : [ids[j], ids[i]];
      run(
        `INSERT INTO interest_edges (from_node,to_node,type,weight) VALUES (?,?,?,1)
         ON CONFLICT(from_node,to_node,type) DO UPDATE SET weight = weight + 1`,
        a,
        b,
        relation,
      );
    }
    void ts;
  }
}

/* ---------------- 权重应用 ---------------- */

/** 惰性衰减：30 天无新证据 ×0.9，下限 5，记 weight_log */
function decayUser(userId) {
  const rows = all('SELECT node_id, weight, updated_at FROM user_interests WHERE user_id = ?', userId);
  const ts = now();
  for (const r of rows) {
    const days = (ts - r.updated_at) / (24 * 60 * 60 * 1000);
    const steps = Math.floor(days / DECAY_DAYS);
    if (steps < 1) continue;
    const next = Math.max(WEIGHT_MIN, r.weight * DECAY_FACTOR ** steps);
    const delta = next - r.weight;
    run('UPDATE user_interests SET weight = ?, updated_at = ? WHERE user_id = ? AND node_id = ?', next, ts, userId, r.node_id);
    run(
      'INSERT INTO interest_weight_log (user_id,node_id,delta,reason,created_at) VALUES (?,?,?,?,?)',
      userId, r.node_id, Math.round(delta * 10) / 10, 'decay', ts,
    );
  }
}

/**
 * 应用一条证据到 (user, node)。
 * 同源同节点 24h 去重；权重 clamp 到 [5, 100]；evidence FIFO 8 条。
 */
function applyEvidence(userId, nodeId, { sourceType, sourceId, quote, delta }) {
  const ts = now();
  const row = get('SELECT weight, evidence, updated_at FROM user_interests WHERE user_id = ? AND node_id = ?', userId, nodeId);
  const evidence = row ? parseJson(row.evidence, []) : [];

  // 去重：同 source_type 的证据 24h 内只计一次
  const dup = evidence.some((e) => e.source_type === sourceType && ts - (e.at || 0) < DEDUPE_MS);
  if (dup) return false;

  const weight = Math.min(WEIGHT_MAX, (row?.weight || 0) + delta);
  const nextEvidence = [...evidence, { source_type: sourceType, source_id: sourceId || '', quote, at: ts }].slice(-EVIDENCE_CAP);

  if (row) {
    run('UPDATE user_interests SET weight = ?, evidence = ?, updated_at = ? WHERE user_id = ? AND node_id = ?',
      weight, toJson(nextEvidence), ts, userId, nodeId);
  } else {
    run('INSERT INTO user_interests (user_id,node_id,weight,evidence,updated_at) VALUES (?,?,?,?,?)',
      userId, nodeId, weight, toJson(nextEvidence), ts);
  }
  run('INSERT INTO interest_weight_log (user_id,node_id,delta,reason,created_at) VALUES (?,?,?,?,?)',
    userId, nodeId, delta, sourceType, ts);
  return true;
}

/** 回写 personas.interests 缓存（top 节点），保证图谱与画像视图一致 */
function syncPersonaCache(userId) {
  const rows = all(
    `SELECT n.name AS name, ui.weight AS weight
     FROM user_interests ui JOIN interest_nodes n ON n.id = ui.node_id
     WHERE ui.user_id = ? ORDER BY ui.weight DESC LIMIT 12`,
    userId,
  );
  if (!rows.length) return;
  run('UPDATE personas SET interests = ? WHERE user_id = ?', toJson(rows.map((r) => ({ name: r.name, weight: Math.round(r.weight) }))), userId);
}

/* ---------------- 对外主入口 ---------------- */

/**
 * 从一段文本抽取兴趣并入图。永不抛错，返回是否产生变更（供日志/调试）。
 * @param {string} userId
 * @param {{source:string, sourceId?:string, text:string}} opts
 *        source: interview | post | profile | group
 */
export async function extractAndApply(userId, { source, sourceId, text }) {
  try {
    if (!userId || !String(text || '').trim()) return { applied: 0 };
    ensureSeeded();
    decayUser(userId);

    const res = await callAIWithFallback(
      {
        task: 'interest-extract',
        userId,
        system: INTEREST_EXTRACT_SYSTEM,
        messages: [{ role: 'user', content: interestExtractPrompt(text, getNodeCatalog()) }],
        json: true,
        fast: true,
        maxTokens: 800,
      },
      () => ({ items: extractInterestItems(text) }),
    );

    const items = normalizeItems(res.data?.items);
    if (!items.length) return { applied: 0 };

    const ts = now();
    const nodeIds = items.map((it) => resolveNode(it, ts));
    linkBatch(nodeIds, items[0]?.relation || 'co_occurs', ts);

    let applied = 0;
    items.forEach((it, i) => {
      const ok = applyEvidence(userId, nodeIds[i], {
        sourceType: source,
        sourceId,
        quote: it.quote,
        delta: effectiveDelta(source, it.delta),
      });
      if (ok) applied += 1;
    });

    if (applied) syncPersonaCache(userId);
    return { applied, degraded: res.degraded };
  } catch (err) {
    console.warn('[interest-graph] 入图失败（不阻塞主流程）:', err?.message || err);
    return { applied: 0, error: String(err?.message || err) };
  }
}

/* ---------------- 图谱读取 ---------------- */

/** 自己的完整图谱：节点（含权重与证据）+ 节点间边 */
export function getOwnGraph(userId) {
  ensureSeeded();
  decayUser(userId);
  const rows = all(
    `SELECT ui.node_id, ui.weight, ui.evidence, ui.updated_at, n.name, n.category, n.status
     FROM user_interests ui JOIN interest_nodes n ON n.id = ui.node_id
     WHERE ui.user_id = ? ORDER BY ui.weight DESC`,
    userId,
  );
  const ids = new Set(rows.map((r) => r.node_id));
  const nodes = rows.map((r) => ({
    id: r.node_id,
    name: r.name,
    category: r.category,
    status: r.status,
    weight: Math.round(r.weight),
    updated_at: r.updated_at,
    evidence: parseJson(r.evidence, []),
  }));
  // 只保留两端都在图里的边
  const edges = all(
    `SELECT from_node, to_node, type, weight FROM interest_edges
     WHERE type IN ('sub_of','related','co_occurs')`,
  ).filter((e) => ids.has(e.from_node) && ids.has(e.to_node));
  return { nodes, edges };
}

/** 他人公开裁剪版：top 10 节点，无证据明细 */
export function getPublicGraph(userId) {
  ensureSeeded();
  const rows = all(
    `SELECT ui.weight, n.name, n.category
     FROM user_interests ui JOIN interest_nodes n ON n.id = ui.node_id
     WHERE ui.user_id = ? ORDER BY ui.weight DESC LIMIT 10`,
    userId,
  );
  return {
    nodes: rows.map((r) => ({ name: r.name, category: r.category, weight: Math.round(r.weight) })),
  };
}

/** 给匹配引擎用的结构：权重表 + 名称表 + 一跳邻居 */
export function getGraphContext(userId) {
  ensureSeeded();
  const rows = all(
    `SELECT ui.node_id, ui.weight, n.name FROM user_interests ui
     JOIN interest_nodes n ON n.id = ui.node_id WHERE ui.user_id = ?`,
    userId,
  );
  const weights = new Map();
  const names = new Map();
  for (const r of rows) {
    weights.set(r.node_id, r.weight);
    names.set(r.node_id, r.name);
  }
  const neighbors = new Map();
  if (weights.size) {
    // 全图邻接：2 跳可达要经过本人权重之外的中间节点，所以不能只建本人节点的边
    const edges = all("SELECT from_node, to_node FROM interest_edges WHERE type IN ('sub_of','related','co_occurs')");
    for (const e of edges) {
      if (!neighbors.has(e.from_node)) neighbors.set(e.from_node, new Set());
      neighbors.get(e.from_node).add(e.to_node);
      if (!neighbors.has(e.to_node)) neighbors.set(e.to_node, new Set());
      neighbors.get(e.to_node).add(e.from_node);
    }
  }
  return { weights, names, neighbors };
}

/** 管理后台统计（答辩用） */
export function graphStats() {
  ensureSeeded();
  const c = (sql, ...p) => get(sql, ...p)?.c ?? 0;
  return {
    nodes: c('SELECT COUNT(*) AS c FROM interest_nodes'),
    auto_nodes: c("SELECT COUNT(*) AS c FROM interest_nodes WHERE status = 'auto'"),
    edges: c('SELECT COUNT(*) AS c FROM interest_edges'),
    users_in_graph: c('SELECT COUNT(DISTINCT user_id) AS c FROM user_interests'),
    top_nodes: all(
      `SELECT n.name, COUNT(*) AS users, ROUND(AVG(ui.weight)) AS avg_weight
       FROM user_interests ui JOIN interest_nodes n ON n.id = ui.node_id
       GROUP BY n.id ORDER BY users DESC LIMIT 10`,
    ),
    new_this_week: c(
      "SELECT COUNT(*) AS c FROM interest_weight_log WHERE created_at > ? AND reason != 'decay'",
      now() - 7 * 24 * 60 * 60 * 1000,
    ),
  };
}
