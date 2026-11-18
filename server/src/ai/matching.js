import { callAIWithFallback } from './provider.js';
import * as P from './prompts.js';
import { rankCandidates, computeMatch } from './match-engine.js';
import { DIMENSIONS } from './local-engine.js';
import { all, get, run, parseJson, toJson } from '../db/index.js';
import { newId, now } from '../utils/helpers.js';
import { hydratePersona, loadPersona } from './persona.js';
import { getGraphContext } from './interest-graph.js';
import { notifyOnce } from '../services/notify-service.js';

/**
 * 匹配服务：候选池准备 -> 引擎排序 -> AI 生成可读理由 -> 落库
 */

/** 拉取带画像的候选池（排除自己、已 ban、无画像的人） */
export function loadCandidatePool({ excludeIds = [] } = {}) {
  const rows = all(
    `SELECT p.*, u.nickname, u.school, u.college, u.major, u.grade, u.gender, u.bio, u.contact_pref, u.avatar, u.last_active_at
     FROM personas p
     JOIN users u ON u.id = p.user_id
     WHERE u.status = 'active' AND u.persona_stage = 2`,
  );
  return rows.map(hydratePersona).filter((r) => !excludeIds.includes(r.user_id));
}

/** 我近期已互动/已推荐过的人 -> 惩罚系数 */
export function recentPenaltyMap(userId) {
  const map = new Map();
  const fb = all('SELECT target_id, action FROM match_feedback WHERE user_id = ?', userId);
  for (const f of fb) map.set(f.target_id, f.action === 'pass' ? 1 : 0.85);

  const shown = all(
    `SELECT user_a, user_b, a_action, b_action, created_at FROM matches
     WHERE user_a = ? OR user_b = ? ORDER BY created_at DESC LIMIT 200`,
    userId,
    userId,
  );
  for (const m of shown) {
    const other = m.user_a === userId ? m.user_b : m.user_a;
    const days = (Date.now() - m.created_at) / 86400000;
    if (!map.has(other)) map.set(other, days < 3 ? 0.75 : days < 14 ? 0.4 : 0.15);
  }
  return map;
}

/** 生成每日推荐并写入 matches 表 */
export async function generateMatches(userId, { limit = 6, source = 'daily' } = {}) {
  const me = loadPersona(userId);
  if (!me) return { ok: false, error: 'no-persona' };

  const pool = loadCandidatePool({ excludeIds: [userId] });
  if (!pool.length) return { ok: true, matches: [] };

  const corpus = pool.map((p) => p.raw_text || '');
  // 图谱上下文整批取一次，排序与理由生成共用
  const graphs = new Map();
  graphs.set(userId, getGraphContext(userId));
  for (const p of pool) graphs.set(p.user_id, getGraphContext(p.user_id));

  const ranked = rankCandidates(me, pool, {
    limit,
    recentPenalty: recentPenaltyMap(userId),
    corpus,
    graphs,
  });

  const results = [];
  for (const r of ranked) {
    const other = r.candidate;
    const pair = orderPair(userId, other.user_id);

    // 已存在则更新分数，避免重复插入
    const existing = get('SELECT id, reason FROM matches WHERE user_a = ? AND user_b = ?', pair.a, pair.b);

    const reason = existing?.reason
      ? existing.reason
      : await buildReason(me, other, r, userId, graphs);

    const id = existing?.id || newId('mt');
    if (existing) {
      run(
        'UPDATE matches SET score=?, breakdown=?, complement=?, source=? WHERE id=?',
        r.score,
        toJson(r.breakdown),
        toJson({ notes: r.complementNotes, common: r.common, newInterests: r.newInterests }),
        source,
        id,
      );
    } else {
      run(
        `INSERT INTO matches (id,user_a,user_b,score,breakdown,reason,complement,source,created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        id,
        pair.a,
        pair.b,
        r.score,
        toJson(r.breakdown),
        reason,
        toJson({ notes: r.complementNotes, common: r.common, newInterests: r.newInterests }),
        source,
        now(),
      );
    }

    results.push({
      id,
      user: publicProfile(other),
      score: r.score,
      breakdown: r.breakdown,
      reason,
      common: r.common,
      complement: r.complementNotes,
      newInterests: r.newInterests,
      myAction: pair.aUserId === userId ? await actionOf(id, 'a') : await actionOf(id, 'b'),
    });
  }

  // 今日推荐每天最多提醒一次。
  // 之前是每次生成都推一条，而 /daily 在推荐不足时会重新生成，
  // 用户刷新几次就会收到一串重复通知，把通知中心淹掉。
  if (results.length && source === 'daily') {
    notifyOnce(userId, 'match', '今日同频已更新', '去匹配页看看今天和谁合拍', '/match', {
      windowMs: 86400000,
      key: 'daily-match',
    });
  }

  return { ok: true, matches: results };
}

async function actionOf(matchId, side) {
  const row = get(`SELECT ${side}_action AS a FROM matches WHERE id = ?`, matchId);
  return row?.a || 'none';
}

/** 统一 user_a < user_b 的顺序，保证 (a,b) 唯一约束生效 */
export function orderPair(u1, u2) {
  const [a, b] = [u1, u2].sort();
  return { a, b, aUserId: a === u1 ? u1 : u2 };
}

/** 双方图谱的可读摘要：高频节点、共享节点、桥路径（A 的兴趣经关联通向 B 的兴趣） */
function graphBrief(ctxA, ctxB) {
  if (!ctxA?.weights?.size || !ctxB?.weights?.size) return null;
  const top = (ctx) =>
    [...ctx.weights.entries()].sort((x, y) => y[1] - x[1]).slice(0, 6).map(([n]) => ctx.names.get(n) || n);
  const shared = [];
  const bridges = [];
  for (const [node] of ctxA.weights) {
    const nameA = ctxA.names.get(node) || node;
    if (ctxB.weights.has(node)) shared.push(nameA);
    for (const n2 of ctxA.neighbors.get(node) || []) {
      if (ctxB.weights.has(n2) && !ctxA.weights.has(n2)) {
        bridges.push(`${nameA} → ${ctxB.names.get(n2) || n2}`);
      }
    }
  }
  return {
    topA: top(ctxA),
    topB: top(ctxB),
    shared: shared.slice(0, 5),
    bridges: [...new Set(bridges)].slice(0, 4),
  };
}

/** 用 AI 生成匹配理由；失败则用引擎给出的结构化线索拼一段人话 */
async function buildReason(me, other, scored, userId, graphs) {
  const brief = graphBrief(graphs?.get(me.user_id ?? me.id), graphs?.get(other.user_id ?? other.id));
  const res = await callAIWithFallback(
    {
      task: 'match-reason',
      userId,
      system: P.MATCH_REASON_SYSTEM,
      messages: [{ role: 'user', content: P.matchReasonPrompt(me, other, brief) }],
      json: true,
      fast: true,
      temperature: 0.7,
      maxTokens: 600,
    },
    () => localReason(me, other, scored),
  );
  const d = res.data || localReason(me, other, scored);
  // 把互补点合并进结果，供前端展示。
  // 模型可能给出数字/对象等非字符串元素，下游多处要 startsWith，
  // 所以在这里统一收敛成字符串数组，别把脏数据带进库里。
  if (Array.isArray(d.complement)) {
    scored.complementNotes = d.complement
      .filter((n) => typeof n === 'string' || typeof n === 'number')
      .map((n) => String(n));
  }
  return d.reason || localReason(me, other, scored).reason;
}

/** 本地理由生成：用引擎算出的真实线索拼装，不是模板空话 */
function localReason(me, other, scored) {
  const bits = [];
  const common = scored.common || [];
  if (common.length) bits.push(`你们都对${common.slice(0, 2).join('和')}有兴趣`);
  else if ((me.interests || []).length && (other.interests || []).length) {
    bits.push(`你的${me.interests[0].name}和对方的${other.interests[0].name}正好能聊到一块`);
  }

  const dims = scored.breakdown?.compatDetail || [];
  const rhythmPart = dims.find((d) => d.key === 'rhythm');
  if (rhythmPart && rhythmPart.score >= 90) bits.push('作息节奏也很接近，约起来不费劲');
  else if (rhythmPart && rhythmPart.score <= 40) bits.push(`不过你们作息差异挺大（你在${me.rhythm}、对方在${other.rhythm}），需要一点迁就`);

  const bd = scored.breakdown || {};
  if (bd.complement >= 60) bits.push('对方身上有你不熟知的领域，聊起来会有新东西');
  if (scored.newInterests?.length) bits.push(`对方还对${scored.newInterests.slice(0, 2).join('、')}有兴趣`);

  if (!bits.length) bits.push('你们的画像有不少重叠，值得聊一聊');

  return {
    reason: `${bits.slice(0, 3).join('；')}。`,
    complement: (scored.complementNotes || []).slice(0, 3),
    common: common.slice(0, 3),
  };
}

/**
 * 对外公开的资料（不含邮箱等敏感字段）。
 *
 * 刻意不返回 vector 和 ideal_match：前者是把一个人压成六个数字，
 * 后者是 TA 内心的择偶描述。这两样都属于私密画像，只该在本人视角
 * （/persona/me）出现，别人看到的应该是经过解读的兴趣与摘要。
 */
export function publicProfile(p) {
  return {
    id: p.user_id ?? p.id,
    nickname: p.nickname,
    avatar: p.avatar || null,
    school: p.school,
    college: p.college,
    major: p.major,
    grade: p.grade,
    gender: p.gender,
    bio: p.bio,
    contact_pref: p.contact_pref,
    summary: p.summary,
    interests: p.interests || [],
    values: p.values || [],
    goals: p.goals || [],
    rhythm: p.rhythm,
    dimensions: DIMENSIONS,
    last_active_at: p.last_active_at,
  };
}

/* ---------------- 反馈 ---------------- */

export function recordFeedback(userId, targetId, action) {
  // match_feedback 主键是 (user_id, target_id)，用冲突更新表达最新态度
  run(
    `INSERT INTO match_feedback (id,user_id,target_id,action,created_at) VALUES (?,?,?,?,?)
     ON CONFLICT(user_id,target_id) DO UPDATE SET action=excluded.action, created_at=excluded.created_at`,
    newId('mfb'),
    userId,
    targetId,
    action,
    now(),
  );

  const pair = orderPair(userId, targetId);
  const side = userId === pair.a ? 'a_action' : 'b_action';

  // connected 是终态：已经建立的关系不该因为再点一次「想认识」被打回 like。
  // 只有明确的 pass 才允许退出连接。
  const row = get('SELECT * FROM matches WHERE user_a = ? AND user_b = ?', pair.a, pair.b);
  if (row && (row.a_action === 'connected' || row.b_action === 'connected') && action !== 'pass') {
    return;
  }

  run(`UPDATE matches SET ${side} = ? WHERE user_a = ? AND user_b = ?`, action, pair.a, pair.b);
}

/** 双方都 like -> 建立会话并激活破冰脚手架 */
export function evaluateMutual(matchId) {
  const m = get('SELECT * FROM matches WHERE id = ?', matchId);
  if (!m) return { mutual: false };

  // 已经是 connected：是既成事实，不是这次才互选上的
  if (m.a_action === 'connected' && m.b_action === 'connected') {
    return { mutual: true, alreadyConnected: true, match: m };
  }

  const mutual = m.a_action === 'like' && m.b_action === 'like';
  if (mutual) {
    run('UPDATE matches SET a_action=?, b_action=? WHERE id=?', 'connected', 'connected', matchId);
  }
  return { mutual, alreadyConnected: false, match: m };
}

export { computeMatch };
