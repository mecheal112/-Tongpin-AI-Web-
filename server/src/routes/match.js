import { Router } from 'express';
import { z } from 'zod';
import { wrap, badRequest, notFound, pagination, newId, now } from '../utils/helpers.js';
import { requireAuth, requireActive } from '../middleware/auth.js';
import { all, get, run, parseJson } from '../db/index.js';
import { generateMatches, recordFeedback, evaluateMutual, publicProfile, loadCandidatePool, orderPair } from '../ai/matching.js';
import { loadPersona } from '../ai/persona.js';
import { findOrCreateConversation, notify } from '../services/notify-service.js';
import { generateIcebreakers } from '../ai/icebreak.js';
import { emitToUser } from '../realtime/index.js';

export const router = Router();
router.use(requireAuth);

/** 今日推荐（首次访问自动生成） */
router.get(
  '/daily',
  wrap(async (req, res) => {
    const me = loadPersona(req.user.id);
    if (!me) {
      return res.json({ ok: true, needsPersona: true, matches: [] });
    }

    const { limit = 6 } = req.query;
    const n = Math.min(Math.max(Number.parseInt(limit, 10) || 6, 1), 12);

    // 已有今日未处理的推荐则直接返回，避免每次刷新都重新算
    const todays = loadMatchRows(req.user.id).filter((m) => m.created_at > Date.now() - 86400000);
    if (todays.length >= n) {
      return res.json({ ok: true, matches: todays.slice(0, n), cached: true });
    }

    const result = await generateMatches(req.user.id, { limit: n });
    if (!result.ok) return res.json({ ok: true, needsPersona: true, matches: [] });

    res.json({ ok: true, matches: loadMatchRows(req.user.id).slice(0, n) });
  }),
);

/** 探索模式：拉取更大范围的候选，用不同权重（更偏互补和新奇） */
router.get(
  '/explore',
  wrap(async (req, res) => {
    const me = loadPersona(req.user.id);
    if (!me) return res.json({ ok: true, needsPersona: true, matches: [] });

    const { limit = 12 } = req.query;
    const n = Math.min(Math.max(Number.parseInt(limit, 10) || 12, 1), 30);

    const pool = loadCandidatePool({ excludeIds: [req.user.id] });
    const seen = new Set(loadMatchRows(req.user.id).map((m) => m.user.id));
    const fresh = pool.filter((p) => !seen.has(p.user_id));

    // 探索页优先给没推荐过的人，按画像重合度粗排
    const { rankCandidates } = await import('../ai/match-engine.js');
    const corpus = pool.map((p) => p.raw_text || '');
    const ranked = rankCandidates(me, fresh.length ? fresh : pool, { limit: n, corpus });

    res.json({
      ok: true,
      matches: ranked.map((r) => ({
        id: null,
        user: publicProfile(r.candidate),
        score: r.score,
        breakdown: r.breakdown,
        reason: '',
        common: r.common,
        complement: r.complementNotes || [],
        newInterests: r.newInterests,
        myAction: 'none',
        explorable: true,
      })),
    });
  }),
);

/** 我收到的推荐 */
router.get(
  '/received',
  wrap(async (req, res) => {
    res.json({ ok: true, matches: loadMatchRows(req.user.id, { onlyIncoming: true }) });
  }),
);

/** 已建立连接的人 */
router.get(
  '/connections',
  wrap(async (req, res) => {
    const rows = all(
      `SELECT m.* FROM matches m
       WHERE (m.user_a = ? AND m.a_action = 'connected') OR (m.user_b = ? AND m.b_action = 'connected')
       ORDER BY m.created_at DESC`,
      req.user.id,
      req.user.id,
    );
    res.json({ ok: true, connections: rows.map((r) => shapeMatch(r, req.user.id)) });
  }),
);

/**
 * 某人的资料卡（只读）。
 *
 * 资料页只需要「看」，不该产生任何副作用。以前前端借 POST /direct 拿数据，
 * 结果光是点进主页就等于表了白，所以单独开这个只读入口。
 * 已有匹配记录就带上分数与理由，没有就只给公开资料，不建记录。
 */
router.get(
  '/profile/:userId',
  wrap(async (req, res) => {
    const targetId = req.params.userId;
    if (targetId === req.user.id) throw badRequest('这是你自己的资料');

    const target = get("SELECT id FROM users WHERE id = ? AND status != 'banned'", targetId);
    if (!target) throw notFound('用户不存在');

    const pair = orderPair(req.user.id, targetId);
    const row = get('SELECT * FROM matches WHERE user_a = ? AND user_b = ?', pair.a, pair.b);

    // 已经有匹配记录：带上分数、理由和我的表态
    if (row) return res.json({ ok: true, match: shapeMatch(row, req.user.id) });

    const other = loadPersona(targetId);
    if (!other) throw notFound('对方还没有完成画像');

    res.json({
      ok: true,
      match: {
        id: null,
        user: publicProfile(other),
        score: 0,
        breakdown: {},
        reason: '',
        common: [],
        complement: [],
        newInterests: [],
        myAction: 'none',
      },
    });
  }),
);

/** 对方资料卡（含匹配理由） */
router.get(
  '/:id',
  wrap(async (req, res) => {
    const row = get(
      `SELECT m.* FROM matches m
       WHERE m.id = ? AND (m.user_a = ? OR m.user_b = ?)`,
      req.params.id,
      req.user.id,
      req.user.id,
    );
    if (!row) throw notFound('匹配记录不存在');
    res.json({ ok: true, match: shapeMatch(row, req.user.id) });
  }),
);

const actionSchema = z.object({ action: z.enum(['like', 'pass']) });

/** 对匹配表态 */
router.post(
  '/:id/action',
  requireActive,
  wrap(async (req, res) => {
    const parsed = actionSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('action 只能是 like 或 pass');

    const row = get('SELECT * FROM matches WHERE id = ? AND (user_a = ? OR user_b = ?)', req.params.id, req.user.id, req.user.id);
    if (!row) throw notFound('匹配记录不存在');

    const otherId = row.user_a === req.user.id ? row.user_b : row.user_a;
    recordFeedback(req.user.id, otherId, parsed.data.action);

    const { mutual, alreadyConnected } = evaluateMutual(row.id);

    let conversationId = null;
    if (mutual) {
      const conv = findOrCreateConversation(req.user.id, otherId);
      conversationId = conv.id;
      // 建立连接即准备破冰内容
      await generateIcebreakers(conv.id, req.user.id);

      // 只有这次才互选上才推「互相看对眼」；已经连上的别反复推
      if (!alreadyConnected && row.a_action !== 'connected' && row.b_action !== 'connected') {
        notify(
          otherId,
          'match',
          '你们互相看对眼了',
          '去打个招呼吧，我准备了几个开场白',
          `/chat/${conv.id}`,
        );
      }
    } else if (parsed.data.action === 'like') {
      // 单方面表达兴趣：告诉对方有人想认识，并给出查看资料的入口
      const me = get('SELECT nickname FROM users WHERE id = ?', req.user.id);
      notify(
        otherId,
        'like',
        `${me?.nickname || '有人'} 想认识你`,
        '点开看看 TA 的资料，觉得合适就回应一下',
        `/user/${req.user.id}`,
      );
      emitToUser(otherId, 'notification', {
        type: 'like',
        title: `${me?.nickname || '有人'} 想认识你`,
        link: `/user/${req.user.id}`,
      });
    }

    res.json({ ok: true, mutual, conversationId });
  }),
);

/** 直接向某人发起连接（探索页 / 资料页） */
router.post(
  '/direct/:userId',
  requireActive,
  wrap(async (req, res) => {
    const targetId = req.params.userId;
    if (targetId === req.user.id) throw badRequest('不能和自己连接');

    const target = get("SELECT id FROM users WHERE id = ? AND status = 'active'", targetId);
    if (!target) throw notFound('用户不存在');

    const { orderPair, computeMatch, publicProfile: pp } = await import('../ai/matching.js');
    const pair = orderPair(req.user.id, targetId);
    let row = get('SELECT * FROM matches WHERE user_a = ? AND user_b = ?', pair.a, pair.b);

    if (!row) {
      const me = loadPersona(req.user.id);
      const other = loadPersona(targetId);
      // explore 是单对单即时算分，把双方图谱上下文一并传入
      const { getGraphContext } = await import('../ai/interest-graph.js');
      const graphs = new Map();
      graphs.set(req.user.id, getGraphContext(req.user.id));
      graphs.set(targetId, getGraphContext(targetId));
      const r = me && other ? computeMatch(me, other, { graphs }) : { score: 50, breakdown: {}, common: [], complementNotes: [], newInterests: [] };
      const id = newId('mt');
      run(
        `INSERT INTO matches (id,user_a,user_b,score,breakdown,reason,complement,source,created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        id, pair.a, pair.b, r.score, JSON.stringify(r.breakdown), '', JSON.stringify({ notes: r.complementNotes, common: r.common, newInterests: r.newInterests }), 'explore', now(),
      );
      row = get('SELECT * FROM matches WHERE id = ?', id);
    }

    recordFeedback(req.user.id, targetId, 'like');
    const { mutual, alreadyConnected } = evaluateMutual(row.id);

    let conversationId = null;
    if (mutual) {
      const conv = findOrCreateConversation(req.user.id, targetId);
      conversationId = conv.id;
      await generateIcebreakers(conv.id, req.user.id);

      if (!alreadyConnected && row.a_action !== 'connected' && row.b_action !== 'connected') {
        notify(
          targetId,
          'match',
          '你们互相看对眼了',
          '去打个招呼吧，我准备了几个开场白',
          `/chat/${conv.id}`,
        );
      }
    } else {
      // 单方面发起：让对方收到一条可点进资料的提醒
      const me = get('SELECT nickname FROM users WHERE id = ?', req.user.id);
      notify(
        targetId,
        'like',
        `${me?.nickname || '有人'} 想认识你`,
        '点开看看 TA 的资料，觉得合适就回应一下',
        `/user/${req.user.id}`,
      );
      emitToUser(targetId, 'notification', {
        type: 'like',
        title: `${me?.nickname || '有人'} 想认识你`,
        link: `/user/${req.user.id}`,
      });
    }

    res.json({ ok: true, matchId: row.id, mutual, conversationId });
  }),
);

/* ---------------- 内部辅助 ---------------- */

function loadMatchRows(userId, { onlyIncoming = false } = {}) {
  const rows = all(
    `SELECT m.* FROM matches m
     WHERE (m.user_a = ? OR m.user_b = ?)
     ORDER BY m.score DESC, m.created_at DESC
     LIMIT 100`,
    userId,
    userId,
  );

  const list = rows
    .map((r) => shapeMatch(r, userId))
    .filter((m) => m.user);

  if (onlyIncoming) {
    return list.filter((m) => m.theirAction === 'like' && m.myAction === 'none');
  }
  return list;
}

function shapeMatch(row, userId) {
  const otherId = row.user_a === userId ? row.user_b : row.user_a;
  const persona = loadPersona(otherId);
  if (!persona) return { id: row.id, user: null };

  const isA = row.user_a === userId;
  const comp = parseJson(row.complement, {});

  return {
    id: row.id,
    user: publicProfile(persona),
    score: row.score,
    breakdown: parseJson(row.breakdown, {}),
    reason: row.reason,
    common: comp.common || [],
    complement: comp.notes || [],
    newInterests: comp.newInterests || [],
    myAction: isA ? row.a_action : row.b_action,
    theirAction: isA ? row.b_action : row.a_action,
    source: row.source,
    createdAt: row.created_at,
  };
}
