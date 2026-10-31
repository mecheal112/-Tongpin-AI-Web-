import { Router } from 'express';
import { z } from 'zod';
import { wrap, badRequest, newId, now, notFound } from '../utils/helpers.js';
import { requireAuth, requireActive } from '../middleware/auth.js';
import { all, get, run, toJson, parseJson } from '../db/index.js';
import { personaTurn, extractPersonaFromText, loadPersona, savePersona, DIMENSIONS, MIN_TURNS } from '../ai/persona.js';

export const router = Router();
router.use(requireAuth);

/** 当前画像状态 */
router.get(
  '/me',
  wrap(async (req, res) => {
    const persona = loadPersona(req.user.id);
    const session = get(
      "SELECT * FROM persona_sessions WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1",
      req.user.id,
    );
    res.json({
      ok: true,
      stage: req.user.persona_stage,
      persona,
      dimensions: DIMENSIONS,
      minTurns: MIN_TURNS,
      session: session
        ? { id: session.id, turnCount: session.turn_count, messages: parseJson(session.messages, []) }
        : null,
    });
  }),
);

/** 开始/继续访谈会话 */
router.post(
  '/session',
  requireActive,
  wrap(async (req, res) => {
    let session = get(
      "SELECT * FROM persona_sessions WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1",
      req.user.id,
    );
    if (!session) {
      const id = newId('ps');
      const ts = now();
      const greeting = {
        role: 'assistant',
        content: '你好，我是同频的画像助手。接下来我会问你一些问题，大概六七个，用来了解你是个什么样的人，这样之后才能帮你找到真正合拍的人。准备好了我们就开始——先说说，最近一周你花时间最多的一件事是什么？',
        ts,
      };
      run(
        `INSERT INTO persona_sessions (id,user_id,status,messages,turn_count,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?)`,
        id, req.user.id, 'active', toJson([greeting]), 0, ts, ts,
      );
      run('UPDATE users SET persona_stage = 1 WHERE id = ? AND persona_stage = 0', req.user.id);
      session = get('SELECT * FROM persona_sessions WHERE id = ?', id);
    }
    res.json({
      ok: true,
      session: { id: session.id, turnCount: session.turn_count, messages: parseJson(session.messages, []) },
      dimensions: DIMENSIONS,
      minTurns: MIN_TURNS,
    });
  }),
);

const turnSchema = z.object({ message: z.string().min(1, '说点什么吧').max(1000) });

/** 推进一轮访谈 */
router.post(
  '/session/:id/turn',
  requireActive,
  wrap(async (req, res) => {
    const parsed = turnSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);

    const session = get('SELECT * FROM persona_sessions WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
    if (!session) throw notFound('会话不存在');
    if (session.status !== 'active') throw badRequest('该会话已结束');

    const history = parseJson(session.messages, []);
    const result = await personaTurn({
      user: req.user,
      session,
      history,
      userMessage: parsed.data.message,
    });

    const ts = now();
    const nextMessages = [
      ...history,
      { role: 'user', content: parsed.data.message, ts },
      { role: 'assistant', content: result.reply, ts: now() },
    ];

    run(
      `UPDATE persona_sessions SET messages = ?, turn_count = turn_count + 1, status = ?, updated_at = ?
       WHERE id = ?`,
      toJson(nextMessages),
      result.done ? 'done' : 'active',
      now(),
      session.id,
    );

    res.json({
      ok: true,
      done: result.done,
      reply: result.reply,
      persona: result.persona ? loadPersona(req.user.id) : null,
      provider: result.provider,
      degraded: result.degraded,
    });
  }),
);

/** 放弃当前会话，重新开始 */
router.post(
  '/session/:id/restart',
  wrap(async (req, res) => {
    run("UPDATE persona_sessions SET status = 'abandoned', updated_at = ? WHERE id = ? AND user_id = ?", now(), req.params.id, req.user.id);
    res.json({ ok: true });
  }),
);

/** 快速画像：直接粘贴一段自我介绍，由 AI 提炼 */
const quickSchema = z.object({ text: z.string().min(30, '至少写 30 个字，信息太少提炼不出画像').max(4000) });

router.post(
  '/quick',
  requireActive,
  wrap(async (req, res) => {
    const parsed = quickSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);

    const result = await extractPersonaFromText(req.user.id, parsed.data.text);
    res.json({ ok: true, persona: loadPersona(req.user.id), degraded: result.degraded });
  }),
);

/** 手动微调画像向量 —— 让用户对 AI 的判断有最终话语权 */
const tuneSchema = z.object({
  vector: z.array(z.number().min(0).max(100)).length(6).optional(),
  rhythm: z.string().max(10).optional(),
});

router.patch(
  '/me',
  wrap(async (req, res) => {
    const parsed = tuneSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('参数不合法');
    const persona = loadPersona(req.user.id);
    if (!persona) throw notFound('还没有画像');

    savePersona(req.user.id, {
      ...persona,
      vector: parsed.data.vector ? parsed.data.vector.map(Math.round) : persona.vector,
      rhythm: parsed.data.rhythm || persona.rhythm,
      raw_text: persona.raw_text,
    });
    res.json({ ok: true, persona: loadPersona(req.user.id) });
  }),
);
