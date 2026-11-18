import { Router } from 'express';
import { wrap, badRequest, notFound, pagination, now } from '../utils/helpers.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { all, get, run } from '../db/index.js';
import { hydrateUser, listUsers, countUsers } from '../services/user-service.js';
import { aiStatus } from '../ai/provider.js';

export const router = Router();
router.use(requireAuth, requireAdmin);

/** 概览 */
router.get(
  '/stats',
  wrap(async (_req, res) => {
    const db = (sql, ...p) => get(sql, ...p);
    const day = Date.now() - 86400000;
    const week = Date.now() - 7 * 86400000;

    res.json({
      ok: true,
      stats: {
        users: db('SELECT COUNT(*) AS n FROM users').n,
        personas: db('SELECT COUNT(*) AS n FROM personas').n,
        posts: db('SELECT COUNT(*) AS n FROM posts').n,
        comments: db('SELECT COUNT(*) AS n FROM comments').n,
        matches: db('SELECT COUNT(*) AS n FROM matches').n,
        connections: db("SELECT COUNT(*) AS n FROM matches WHERE a_action='connected' AND b_action='connected'").n,
        conversations: db('SELECT COUNT(*) AS n FROM conversations').n,
        messages: db('SELECT COUNT(*) AS n FROM messages').n,
        groups: db('SELECT COUNT(*) AS n FROM groups').n,
        activeToday: db('SELECT COUNT(*) AS n FROM users WHERE last_active_at > ?', day).n,
        newThisWeek: db('SELECT COUNT(*) AS n FROM users WHERE created_at > ?', week).n,
        pendingReports: db("SELECT COUNT(*) AS n FROM reports WHERE status='pending'").n,
        flaggedPosts: db("SELECT COUNT(*) AS n FROM posts WHERE mod_status='flagged'").n,
      },
      ai: aiStatus(),
    });
  }),
);

/** AI 调用观测 */
router.get(
  '/ai-logs',
  wrap(async (req, res) => {
    const { limit, offset } = pagination(req.query, { limit: 50 });
    const rows = all('SELECT * FROM ai_logs ORDER BY created_at DESC LIMIT ? OFFSET ?', limit, offset);

    // 按任务聚合，看各条 AI 链路的表现
    const byTask = all(
      `SELECT task, provider, COUNT(*) AS calls,
              SUM(ok) AS ok_calls,
              AVG(latency_ms) AS avg_latency,
              SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out
       FROM ai_logs GROUP BY task, provider ORDER BY task`,
    );

    res.json({ ok: true, logs: rows, byTask });
  }),
);

/** 用户管理 */
router.get(
  '/users',
  wrap(async (req, res) => {
    const { limit, offset } = pagination(req.query, { limit: 50 });
    const q = String(req.query.q || '');
    res.json({ ok: true, users: listUsers({ limit, offset, q }), total: countUsers() });
  }),
);

router.post(
  '/users/:id/status',
  wrap(async (req, res) => {
    const { status } = req.body || {};
    if (!['active', 'muted', 'banned'].includes(status)) throw badRequest('status 不合法');
    const user = get('SELECT * FROM users WHERE id = ?', req.params.id);
    if (!user) throw notFound('用户不存在');
    if (user.role === 'admin' && status === 'banned') throw badRequest('不能封禁管理员');

    run('UPDATE users SET status = ? WHERE id = ?', status, req.params.id);
    res.json({ ok: true, user: hydrateUser(get('SELECT * FROM users WHERE id = ?', req.params.id)) });
  }),
);

/** 内容管理 */
router.get(
  '/posts',
  wrap(async (req, res) => {
    const { limit, offset } = pagination(req.query, { limit: 50 });
    const status = String(req.query.status || '');
    const rows = status
      ? all(
          `SELECT p.*, u.nickname FROM posts p JOIN users u ON u.id = p.author_id
           WHERE p.mod_status = ? ORDER BY p.created_at DESC LIMIT ? OFFSET ?`,
          status, limit, offset,
        )
      : all(
          `SELECT p.*, u.nickname FROM posts p JOIN users u ON u.id = p.author_id
           ORDER BY p.created_at DESC LIMIT ? OFFSET ?`,
          limit, offset,
        );
    res.json({ ok: true, posts: rows });
  }),
);

router.post(
  '/posts/:id/moderate',
  wrap(async (req, res) => {
    const { status } = req.body || {};
    if (!['ok', 'flagged', 'blocked'].includes(status)) throw badRequest('status 不合法');
    run('UPDATE posts SET mod_status = ? WHERE id = ?', status, req.params.id);
    res.json({ ok: true });
  }),
);

router.post(
  '/comments/:id/moderate',
  wrap(async (req, res) => {
    const { status } = req.body || {};
    if (!['ok', 'flagged', 'blocked'].includes(status)) throw badRequest('status 不合法');
    run('UPDATE comments SET mod_status = ? WHERE id = ?', status, req.params.id);
    res.json({ ok: true });
  }),
);

/** 举报处理 */
router.get(
  '/reports',
  wrap(async (req, res) => {
    const { limit, offset } = pagination(req.query, { limit: 50 });
    const rows = all(
      `SELECT r.*, u.nickname AS reporter_name FROM reports r
       JOIN users u ON u.id = r.reporter_id
       ORDER BY r.status = 'pending' DESC, r.created_at DESC LIMIT ? OFFSET ?`,
      limit, offset,
    );
    res.json({ ok: true, reports: rows });
  }),
);

router.post(
  '/reports/:id/resolve',
  wrap(async (req, res) => {
    const { status } = req.body || {};
    if (!['resolved', 'dismissed'].includes(status)) throw badRequest('status 不合法');
    run('UPDATE reports SET status = ? WHERE id = ?', status, req.params.id);
    res.json({ ok: true });
  }),
);

/** 平台数据：匹配质量分析 */
router.get(
  '/match-quality',
  wrap(async (_req, res) => {
    // 各分数段的互动率 —— 用来验证匹配算法是否真的预测了连接
    const buckets = [
      { label: '90+', min: 90, max: 101 },
      { label: '80-89', min: 80, max: 90 },
      { label: '70-79', min: 70, max: 80 },
      { label: '60-69', min: 60, max: 70 },
      { label: '<60', min: 0, max: 60 },
    ];

    const result = buckets.map((b) => {
      const row = get(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN a_action='like' OR b_action='like' THEN 1 ELSE 0 END) AS liked,
                SUM(CASE WHEN a_action='connected' AND b_action='connected' THEN 1 ELSE 0 END) AS connected
         FROM matches WHERE score >= ? AND score < ?`,
        b.min, b.max,
      );
      return {
        bucket: b.label,
        total: row.total || 0,
        liked: row.liked || 0,
        connected: row.connected || 0,
        likeRate: row.total ? Math.round((row.liked / row.total) * 100) : 0,
        connectRate: row.total ? Math.round((row.connected / row.total) * 100) : 0,
      };
    });

    // 脚手架效果：AI 介入过的会话是否更容易持续
    const scaffoldStats = all(
      `SELECT scaffold_state, COUNT(*) AS n FROM conversations GROUP BY scaffold_state`,
    );

    res.json({ ok: true, buckets: result, scaffoldStats });
  }),
);
