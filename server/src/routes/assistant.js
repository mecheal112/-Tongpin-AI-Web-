import { Router } from 'express';
import { z } from 'zod';
import { wrap, badRequest } from '../utils/helpers.js';
import { requireAuth, requireActive } from '../middleware/auth.js';
import { ask, history, reset } from '../ai/assistant.js';

export const router = Router();

/** 问助手。会话维度：同一用户只有一个活跃会话，sessionId 可选（用于前端断点续接） */
const askSchema = z.object({
  question: z.string().min(1, '问题不能为空').max(500),
  sessionId: z.string().max(40).optional(),
});

router.post(
  '/ask',
  requireActive,
  wrap(async (req, res) => {
    const parsed = askSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);

    const result = await ask(req.user.id, parsed.data.question, parsed.data.sessionId);
    if (!result.ok) throw badRequest(result.error || '助手暂时不可用');
    res.json(result);
  }),
);

router.get(
  '/history',
  requireAuth,
  wrap(async (req, res) => {
    res.json({ ok: true, messages: history(req.user.id) });
  }),
);

/** 重开会话：旧会话不再读取，新会话从零开始 */
router.post(
  '/reset',
  requireAuth,
  wrap(async (req, res) => {
    res.json(reset(req.user.id));
  }),
);
