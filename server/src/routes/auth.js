import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { wrap, signToken, badRequest, unauthorized } from '../utils/helpers.js';
import { createUser, findByEmail, verifyPassword, hydrateUser, touchActive, updateProfile } from '../services/user-service.js';
import { requireAuth } from '../middleware/auth.js';
import { DEMO_PASSWORD } from '../config.js';
import { aiStatus } from '../ai/provider.js';
import { all } from '../db/index.js';

export const router = Router();

const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: '操作过于频繁，请稍后再试' },
});

const registerSchema = z.object({
  email: z.string().email('请输入有效的邮箱'),
  password: z.string().min(6, '密码至少 6 位').max(72),
  nickname: z.string().min(1, '请填写昵称').max(20),
  school: z.string().max(40).optional(),
  college: z.string().max(40).optional(),
  major: z.string().max(40).optional(),
  grade: z.string().max(10).optional(),
  gender: z.string().max(10).optional(),
});

router.post(
  '/register',
  authLimiter,
  wrap(async (req, res) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);

    const user = await createUser(parsed.data);
    const token = signToken(user);
    res.json({ ok: true, token, user });
  }),
);

router.post(
  '/login',
  authLimiter,
  wrap(async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) throw badRequest('请输入邮箱和密码');

    const row = findByEmail(email);
    if (!row) throw unauthorized('邮箱或密码不正确');
    if (row.status === 'banned') throw unauthorized('该账号已被封禁');

    const ok = await verifyPassword(row, password);
    if (!ok) throw unauthorized('邮箱或密码不正确');

    touchActive(row.id);
    const user = hydrateUser(row);
    res.json({ ok: true, token: signToken(user), user });
  }),
);

router.get(
  '/me',
  requireAuth,
  wrap(async (req, res) => {
    res.json({ ok: true, user: req.user, ai: aiStatus() });
  }),
);

router.patch(
  '/me',
  requireAuth,
  wrap(async (req, res) => {
    const user = updateProfile(req.user.id, req.body || {});
    res.json({ ok: true, user });
  }),
);

/** 一键体验：方便评审快速切换预置账号查看不同视角 */
router.post(
  '/demo-login',
  authLimiter,
  wrap(async (req, res) => {
    const { email } = req.body || {};
    const row = findByEmail(email);
    if (!row || !row.is_demo) throw unauthorized('不是有效的体验账号');
    touchActive(row.id);
    const user = hydrateUser(row);
    res.json({ ok: true, token: signToken(user), user });
  }),
);

/** 演示账号清单（只暴露昵称和邮箱，密码是公开的演示密码） */
router.get(
  '/demo-accounts',
  wrap(async (_req, res) => {
    const rows = all('SELECT email, nickname, college, major, grade FROM users WHERE is_demo = 1 LIMIT 20');
    res.json({
      ok: true,
      password: DEMO_PASSWORD,
      accounts: rows,
      ai: aiStatus(),
    });
  }),
);
