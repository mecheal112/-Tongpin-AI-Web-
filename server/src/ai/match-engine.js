import { numCosine, normManhattan, cosine, vectorize, cosine as cos, DIMENSIONS } from './local-engine.js';

/**
 * 匹配引擎。
 *
 * 这是产品的核心算法。设计上刻意区别于主流社交产品的「推荐热门」：
 *
 *   总分 = 共鸣度 × w1 + 互补度 × w2 + 约束兼容 × w3 + 新鲜度 × w4
 *
 *  - 共鸣度：人格向量 + 兴趣图谱的重合程度 —— 「你们像不像」
 *  - 互补度：刻意寻找能补足对方的部分 —— 「对方能不能给你新东西」
 *              这一项是对信息茧房的对冲：只推相似的人，用户会困在同温层
 *  - 约束兼容：作息、社交偏好、年级等现实约束 —— 「能不能真的约上」
 *              很多匹配算法忽略这点，导致「聊得好但约不到」
 *  - 新鲜度：对近期已推荐过的人降权，避免反复推同一批
 *
 * 所有子分都归一到 0..100，权重可调。
 */

export const MATCH_WEIGHTS = {
  resonance: 0.42,
  complement: 0.24,
  compatibility: 0.26,
  freshness: 0.08,
};

/** 兴趣图谱重合度（加权重合系数） */
export function interestOverlap(a = [], b = []) {
  if (!a.length || !b.length) return { score: 0, common: [] };
  const mapB = new Map(b.map((i) => [i.name, i.weight || 50]));
  let sumMin = 0;
  let sumMax = 0;
  const common = [];
  const seen = new Set();
  for (const i of a) {
    const wa = i.weight || 50;
    const wb = mapB.get(i.name);
    if (wb !== undefined) {
      sumMin += Math.min(wa, wb);
      common.push(i.name);
      seen.add(i.name);
    }
    sumMax += wa;
  }
  for (const i of b) {
    if (!seen.has(i.name)) sumMax += i.weight || 50;
  }
  const score = sumMax === 0 ? 0 : (sumMin / sumMax) * 100;
  return { score, common };
}

/**
 * 图谱感知的兴趣相似度（spec §6）：
 *   interest_sim = 0.7 × 同节点加权重合 + 0.3 × 一跳邻居折半重合
 * ctx = { weights: Map<nodeId, weight>, names: Map<nodeId, name>, neighbors: Map<nodeId, Set> }
 * 没有图谱数据时由调用方回退 interestOverlap。
 */
export function graphInterestSim(ctxA, ctxB) {
  const wa = ctxA?.weights;
  const wb = ctxB?.weights;
  if (!wa?.size || !wb?.size) return { score: 0, common: [] };

  let sumMin = 0;
  let sumMax = 0;
  let neighborMin = 0;
  const common = [];
  const seen = new Set();

  for (const [node, w] of wa) {
    const w2 = wb.get(node);
    if (w2 !== undefined) {
      sumMin += Math.min(w, w2);
      common.push(ctxA.names.get(node) || node);
      seen.add(node);
    }
    sumMax += w;
  }
  for (const [node, w] of wb) {
    if (!seen.has(node)) sumMax += w;
  }

  // 一跳邻居重合：A 的节点与 B 的节点有边相连（同节点已计过），折半计入
  for (const [node, w] of wa) {
    if (seen.has(node)) continue;
    for (const n2 of ctxA.neighbors.get(node) || []) {
      const w2 = wb.get(n2);
      if (w2 !== undefined && !seen.has(n2)) neighborMin += Math.min(w, w2) * 0.5;
    }
  }

  const direct = sumMax ? sumMin / sumMax : 0;
  const neighbor = sumMax ? neighborMin / sumMax : 0;
  return { score: (0.7 * direct + 0.3 * neighbor) * 100, common };
}

/** 从 A 的图谱出发，2 跳内可达的节点集合（含 A 自己的节点） */
function twoHopReach(ctx) {
  const reach = new Set(ctx.weights.keys());
  const frontier = [...reach];
  for (let hop = 0; hop < 2; hop += 1) {
    const next = [];
    for (const node of frontier) {
      for (const n2 of ctx.neighbors.get(node) || []) {
        if (!reach.has(n2)) {
          reach.add(n2);
          next.push(n2);
        }
      }
    }
    frontier.length = 0;
    frontier.push(...next);
  }
  return reach;
}

/**
 * 从 A 的视角计算互补性：B 有哪些 A 没有的兴趣/A 缺的能力。
 * 传入图谱上下文（ctxA/ctxB）时按「对方 2 跳外的高权重节点」识别盲区，
 * 文案一律用节点规范名；无图谱时回退到画像兴趣名。
 */
export function complementarity(a, b, ctxA, ctxB) {
  const aNames = new Set((a.interests || []).map((i) => i.name));
  const bOnly = (b.interests || []).filter((i) => !aNames.has(i.name));

  // 图谱盲区：对方权重 ≥ 40、且在我方 2 跳可达范围之外的节点
  const graphNew = [];
  if (ctxA?.weights?.size && ctxB?.weights?.size) {
    const reach = twoHopReach(ctxA);
    for (const [node, w] of ctxB.weights) {
      if (w >= 40 && !reach.has(node)) {
        const name = ctxB.names.get(node) || node;
        if (!graphNew.includes(name)) graphNew.push(name);
      }
    }
  }

  const va = a.vector || [];
  const vb = b.vector || [];

  // 维度互补：一方明显高、另一方明显低，说明对方能带来不同视角
  const dimGains = [];
  const n = Math.min(va.length, vb.length);
  for (let i = 0; i < n; i += 1) {
    dimGains.push(vb[i] - va[i]);
  }

  // 互补度来自两块：新兴趣的覆盖 + 人格维度的差异带来的视角补充
  const newInterestNames = [...new Set([...graphNew, ...bOnly.map((i) => i.name)])];
  const newInterestScore = Math.min(100, newInterestNames.length * 22);
  // 适度差异最好，差异过大会难相处。用倒 U 型曲线。
  let diffScore = 0;
  if (n > 0) {
    const avgAbs = dimGains.reduce((s, d) => s + Math.abs(d), 0) / n;
    diffScore = Math.exp(-((avgAbs - 26) ** 2) / (2 * 20 ** 2)) * 100;
  }

  const score = newInterestScore * 0.55 + diffScore * 0.45;

  // 互补性的自然语言描述，给 AI 生成理由时当素材。全部是可直接展示的人话。
  const notes = [];
  if (graphNew.length) notes.push(`对方的${graphNew.slice(0, 2).join('、')}是你的盲区，聊起来会有新东西`);
  else if (bOnly.length) notes.push(`对方对${bOnly.slice(0, 2).map((i) => i.name).join('、')}有兴趣，是你的盲区`);
  for (let i = 0; i < n; i += 1) {
    const d = DIMENSIONS[i];
    if (!d) break;
    if (dimGains[i] >= 28) notes.push(`对方比你更${d.high}（${d.label}），看事情的角度会很不一样`);
    else if (dimGains[i] <= -28) notes.push(`对方的${d.low}正好能补你的${d.high}`);
  }

  return { score: Math.min(100, score), newInterests: newInterestNames, notes };
}

/** 现实约束兼容性 */
export function compatibility(a, b) {
  const parts = [];
  let total = 0;
  let weightSum = 0;

  // 作息：同类型满分，灵活型 70 分，冲突型 25 分
  const rhythmScore = (() => {
    const ra = a.rhythm || '灵活';
    const rb = b.rhythm || '灵活';
    if (ra === '灵活' || rb === '灵活') return 72;
    return ra === rb ? 100 : 25;
  })();
  parts.push({ key: 'rhythm', label: '作息节奏', score: rhythmScore, weight: 0.35 });
  total += rhythmScore * 0.35;
  weightSum += 0.35;

  // 社交偏好
  const cpA = a.contact_pref || '都可';
  const cpB = b.contact_pref || '都可';
  const cpScore = cpA === '都可' || cpB === '都可' ? 78 : cpA === cpB ? 100 : 40;
  parts.push({ key: 'contact', label: '交往方式', score: cpScore, weight: 0.2 });
  total += cpScore * 0.2;
  weightSum += 0.2;

  // 同校加成（能真的见到面）
  const schoolScore = a.school && b.school ? (a.school === b.school ? 100 : 45) : 70;
  parts.push({ key: 'school', label: '地理位置', score: schoolScore, weight: 0.25 });
  total += schoolScore * 0.25;
  weightSum += 0.25;

  // 年级相近：共同话题更多，但跨年级也有价值，所以差距只做温和惩罚
  const gA = Number.parseInt(String(a.grade || '').replace(/\D/g, ''), 10);
  const gB = Number.parseInt(String(b.grade || '').replace(/\D/g, ''), 10);
  let gradeScore = 75;
  if (Number.isFinite(gA) && Number.isFinite(gB)) {
    const d = Math.abs(gA - gB);
    gradeScore = d === 0 ? 100 : d === 1 ? 82 : d === 2 ? 58 : 40;
  }
  parts.push({ key: 'grade', label: '年级跨度', score: gradeScore, weight: 0.2 });
  total += gradeScore * 0.2;
  weightSum += 0.2;

  return { score: weightSum ? total / weightSum : 50, parts };
}

/** 价值观重合 */
export function valueOverlap(a = [], b = []) {
  if (!a.length || !b.length) return 60;
  const sb = new Set(b);
  const common = a.filter((v) => sb.has(v));
  return Math.min(100, 45 + common.length * 22);
}

/* ---------------- 总分计算 ---------------- */

/**
 * @param {object} a 用户A的画像 {vector, interests, values, rhythm, raw_text, ...}
 * @param {object} b 用户B的画像
 * @param {object} [opts]
 * @param {Map<string,number>} [opts.recentPenalty] 已推荐过的人 -> 惩罚系数 0..1
 * @param {string[]} [opts.corpus] TF-IDF 语料
 * @param {Map<string,object>} [opts.graphs] userId -> 图谱上下文（getGraphContext 的结果），
 *        双方都有图谱时兴趣相似度与互补识别走图谱，否则回退平面兴趣
 */
export function computeMatch(a, b, opts = {}) {
  const { recentPenalty, corpus = [], graphs } = opts;
  const ctxA = graphs?.get(a.user_id ?? a.id);
  const ctxB = graphs?.get(b.user_id ?? b.id);
  const useGraph = Boolean(ctxA?.weights?.size && ctxB?.weights?.size);

  // 1) 共鸣度：人格向量 + 兴趣 + 价值观 + 文本语义
  const vectorSim = numCosine(a.vector || [], b.vector || []);
  const manhattanSim = normManhattan(a.vector || [], b.vector || []);
  const vectorScore = (vectorSim * 0.55 + manhattanSim * 0.45) * 100;

  const { score: interestScore, common } = useGraph
    ? graphInterestSim(ctxA, ctxB)
    : interestOverlap(a.interests, b.interests);
  const valueScore = valueOverlap(a.values, b.values);

  let textScore = 0;
  if (a.raw_text && b.raw_text) {
    textScore = cosine(vectorize(a.raw_text, corpus), vectorize(b.raw_text, corpus)) * 100;
  }

  const resonance =
    vectorScore * 0.38 +
    interestScore * 0.34 +
    valueScore * 0.18 +
    (a.raw_text && b.raw_text ? textScore * 0.1 : 0) +
    (a.raw_text && b.raw_text ? 0 : 6); // 无文本时补一点点基线，避免被过度惩罚

  // 2) 互补度（双向取高者：只要一方能获得增益就有价值）
  const compAB = complementarity(a, b, ctxA, ctxB);
  const compBA = complementarity(b, a, ctxB, ctxA);
  const complement = Math.max(compAB.score, compBA.score) * 0.7 + Math.min(compAB.score, compBA.score) * 0.3;

  // 3) 现实兼容
  const compat = compatibility(a, b);

  // 4) 新鲜度
  let freshness = 100;
  if (recentPenalty && recentPenalty.size) {
    const p = recentPenalty.get(b.user_id ?? b.id);
    if (p !== undefined) freshness = Math.max(5, 100 - p * 100);
  }

  const raw =
    resonance * MATCH_WEIGHTS.resonance +
    complement * MATCH_WEIGHTS.complement +
    compat.score * MATCH_WEIGHTS.compatibility +
    freshness * MATCH_WEIGHTS.freshness;

  // 收敛到更可读的区间：低分不会低到没意义，高分不会轻易满分
  const score = Math.round(Math.min(98, Math.max(12, raw)));

  return {
    score,
    breakdown: {
      resonance: Math.round(resonance),
      complement: Math.round(complement),
      compatibility: Math.round(compat.score),
      freshness: Math.round(freshness),
      vector: Math.round(vectorScore),
      interest: Math.round(interestScore),
      value: Math.round(valueScore),
      text: Math.round(textScore),
      compatDetail: compat.parts,
    },
    common,
    complementNotes: [...new Set([...compAB.notes, ...compBA.notes])],
    newInterests: [...new Set([...compAB.newInterests, ...compBA.newInterests])],
  };
}

/**
 * 生成候选并排序。
 * @param {object} me 当前用户+画像
 * @param {Array} pool 候选池（已带画像）
 * @param {object} opts
 */
export function rankCandidates(me, pool, opts = {}) {
  const { limit = 10, exclude = new Set(), recentPenalty, corpus = [], graphs } = opts;

  const scored = [];
  for (const cand of pool) {
    const cid = cand.user_id ?? cand.id;
    if (cid === (me.user_id ?? me.id)) continue;
    if (exclude.has(cid)) continue;
    const r = computeMatch(me, cand, { recentPenalty, corpus, graphs });
    scored.push({ ...r, candidate: cand });
  }

  scored.sort((x, y) => y.score - x.score);

  // 多样性注入：避免前 N 个全是同一类人（同一学院/同一兴趣单一化）
  return diversify(scored, limit);
}

/**
 * 多样性重排：在保持分数优先的前提下，惩罚连续出现的高度相似候选人。
 * 这是对抗「推荐同温层」的第三道防线（前两道是互补度权重和新鲜度惩罚）。
 */
export function diversify(scored, limit) {
  if (scored.length <= 2) return scored.slice(0, limit);

  const out = [];
  const rest = [...scored];

  while (out.length < limit && rest.length) {
    let bestIdx = 0;
    let bestVal = -Infinity;
    for (let i = 0; i < rest.length; i += 1) {
      const cand = rest[i];
      // 与已选出的人计算相似度，相似的降权
      let overlapPenalty = 0;
      for (const picked of out) {
        const shared = cand.common.filter((c) => picked.common.includes(c)).length;
        overlapPenalty += shared * 6;
        if (cand.candidate.college && cand.candidate.college === picked.candidate.college) {
          overlapPenalty += 5;
        }
      }
      const val = cand.score - overlapPenalty;
      if (val > bestVal) {
        bestVal = val;
        bestIdx = i;
      }
    }
    out.push(rest.splice(bestIdx, 1)[0]);
  }
  return out;
}

export { cos };
