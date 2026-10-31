import { Router } from 'express';
import { z } from 'zod';
import { wrap, badRequest, notFound, pagination, newId, now } from '../utils/helpers.js';
import { requireAuth, requireActive } from '../middleware/auth.js';
import { all, get, run } from '../db/index.js';
import { conversationFor, otherParty, notify } from '../services/notify-service.js';
import { loadPersona } from '../ai/persona.js';
import { generateIcebreakers, evaluateNudge, advanceScaffold, recallScaffold, localNudge } from '../ai/icebreak.js';
import { moderate } from '../ai/moderation.js';
import { isOnline } from '../services/user-service.js';
import { emitToUser, emitToConversation } from '../realtime/index.js';

export const router = Router();
router.use(requireAuth);

/** 会话列表 */
router.get(
  '/conversations',
  wrap(async (req, res) => {
    const rows = all(
      `SELECT c.* FROM conversations c WHERE c.user_a = ? OR c.user_b = ?
       ORDER BY c.last_at DESC LIMIT 60`,
      req.user.id,
      req.user.id,
    );

    const list = rows.map((c) => {
      const otherId = otherParty(c, req.user.id);
      const persona = loadPersona(otherId);
      const unread = get(
        'SELECT COUNT(*) AS n FROM messages WHERE conv_id = ? AND sender_id != ? AND read_at IS NULL',
        c.id,
        req.user.id,
      ).n;
      return {
        id: c.id,
        user: persona
          ? { id: otherId, nickname: persona.nickname, avatar: persona.avatar, summary: persona.summary, college: persona.college }
          : { id: otherId, nickname: '已注销用户' },
        lastMessage: c.last_message,
        lastAt: c.last_at,
        unread,
        scaffoldState: c.scaffold_state,
        online: isOnline(otherId),
      };
    });

    res.json({ ok: true, conversations: list });
  }),
);

/** 开启或获取与某人的会话 */
router.post(
  '/with/:userId',
  requireActive,
  wrap(async (req, res) => {
    const otherId = req.params.userId;
    if (otherId === req.user.id) throw badRequest('不能和自己聊天');
    const { findOrCreateConversation } = await import('../services/notify-service.js');
    const conv = findOrCreateConversation(req.user.id, otherId);
    res.json({ ok: true, conversationId: conv.id });
  }),
);

/** 会话详情（含消息与破冰建议） */
router.get(
  '/:id',
  wrap(async (req, res) => {
    const conv = conversationFor(req.params.id, req.user.id);
    if (!conv) throw notFound('会话不存在');

    const { limit = 50, offset = 0 } = pagination(req.query, { limit: 50, max: 100 });
    const otherId = otherParty(conv, req.user.id);
    const persona = loadPersona(otherId);

    const rows = all(
      'SELECT * FROM messages WHERE conv_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
      conv.id,
      limit,
      offset,
    ).reverse();

    // 拉取更早的消息时，只看这一段做卡壳判断
    const nudge = evaluateNudgeSync(conv, rows, req.user.id);

    res.json({
      ok: true,
      conversation: {
        id: conv.id,
        scaffoldState: conv.scaffold_state,
        user: persona
          ? { id: otherId, nickname: persona.nickname, avatar: persona.avatar, summary: persona.summary, interests: (persona.interests || []).map((i) => i.name), college: persona.college, grade: persona.grade, online: isOnline(otherId) }
          : { id: otherId, nickname: '已注销用户' },
      },
      messages: rows,
      nudge,
    });
  }),
);

/** 破冰开场白 */
router.get(
  '/:id/icebreakers',
  wrap(async (req, res) => {
    const conv = conversationFor(req.params.id, req.user.id);
    if (!conv) throw notFound('会话不存在');
    const result = await generateIcebreakers(conv.id, req.user.id);
    res.json(result);
  }),
);

/** 发送消息 */
const sendSchema = z.object({
  content: z.string().min(1, '消息不能为空').max(2000),
  kind: z.enum(['text', 'icebreak']).optional(),
});

router.post(
  '/:id/messages',
  requireActive,
  wrap(async (req, res) => {
    const conv = conversationFor(req.params.id, req.user.id);
    if (!conv) throw notFound('会话不存在');

    const parsed = sendSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);

    const content = parsed.data.content.trim();
    const check = await moderate(content, req.user.id);
    if (check.status === 'blocked') {
      return res.status(422).json({ ok: false, error: '这条消息没有通过安全审核', moderation: check });
    }

    const id = newId('msg');
    const ts = now();
    run(
      `INSERT INTO messages (id,conv_id,sender_id,kind,content,created_at) VALUES (?,?,?,?,?,?)`,
      id, conv.id, req.user.id, parsed.data.kind || 'text', content, ts,
    );
    run('UPDATE conversations SET last_message = ?, last_at = ? WHERE id = ?', content.slice(0, 80), ts, conv.id);

    // 推进脚手架生命周期：聊起来了就该退场
    const state = advanceScaffold(conv.id);

    const otherId = otherParty(conv, req.user.id);
    const msg = { id, conv_id: conv.id, sender_id: req.user.id, kind: parsed.data.kind || 'text', content, created_at: ts };

    emitToConversation(conv.id, 'message:new', msg);
    notify(otherId, 'message', '收到新消息', content.slice(0, 40), `/chat/${conv.id}`);
    emitToUser(otherId, 'notification', { type: 'message', title: '收到新消息', body: content.slice(0, 40), link: `/chat/${conv.id}` });

    res.json({ ok: true, message: msg, scaffoldState: state, moderation: check.status !== 'ok' ? check : undefined });
  }),
);

/** 请求 AI 介入建议 */
router.post(
  '/:id/nudge',
  wrap(async (req, res) => {
    const conv = conversationFor(req.params.id, req.user.id);
    if (!conv) throw notFound('会话不存在');
    const result = await evaluateNudge(conv.id, req.user.id);
    res.json({ ok: true, ...result });
  }),
);

/** 手动召回 / 关闭脚手架 */
router.post(
  '/:id/scaffold',
  wrap(async (req, res) => {
    const conv = conversationFor(req.params.id, req.user.id);
    if (!conv) throw notFound('会话不存在');
    const { action } = req.body || {};

    if (action === 'recall') {
      recallScaffold(conv.id, req.user.id);
      return res.json({ ok: true, scaffoldState: 'active' });
    }
    if (action === 'retire') {
      run("UPDATE conversations SET scaffold_state = 'retired' WHERE id = ?", conv.id);
      return res.json({ ok: true, scaffoldState: 'retired' });
    }
    throw badRequest('action 只能是 recall 或 retire');
  }),
);

/** 标记已读 */
router.post(
  '/:id/read',
  wrap(async (req, res) => {
    const conv = conversationFor(req.params.id, req.user.id);
    if (!conv) throw notFound('会话不存在');
    run('UPDATE messages SET read_at = ? WHERE conv_id = ? AND sender_id != ? AND read_at IS NULL', now(), conv.id, req.user.id);
    res.json({ ok: true });
  }),
);

/** 举报消息 */
router.post(
  '/messages/:id/report',
  wrap(async (req, res) => {
    const msg = get('SELECT * FROM messages WHERE id = ?', req.params.id);
    if (!msg) throw notFound('消息不存在');
    run(
      `INSERT INTO reports (id,reporter_id,target_type,target_id,reason,detail,created_at) VALUES (?,?,?,?,?,?,?)`,
      newId('rp'), req.user.id, 'message', msg.id, String(req.body?.reason || '其他').slice(0, 40), String(req.body?.detail || '').slice(0, 500), now(),
    );
    res.json({ ok: true });
  }),
);

/** 同步版卡壳判断，避免 GET 会话时等待 AI */
function evaluateNudgeSync(conv, messages, viewerId) {
  if (conv.scaffold_state === 'retired') return { needed: false, retired: true };
  const otherId = otherParty(conv, viewerId);
  const me = { id: viewerId, interests: (loadPersona(viewerId)?.interests) || [] };
  const other = { id: otherId, interests: (loadPersona(otherId)?.interests) || [] };
  return localNudge(messages, me, other);
}
