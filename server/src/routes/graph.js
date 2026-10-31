import { Router } from 'express';
import { wrap, notFound } from '../utils/helpers.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { get } from '../db/index.js';
import { getOwnGraph, getPublicGraph, graphStats } from '../ai/interest-graph.js';

export const router = Router();

/** 自己的完整图谱：节点（含权重与证据）+ 节点间边 */
router.get(
  '/own',
  requireAuth,
  wrap(async (req, res) => {
    res.json({ ok: true, graph: getOwnGraph(req.user.id) });
  }),
);

/** 他人公开裁剪版：top 10 节点，无证据明细 */
router.get(
  '/user/:id',
  requireAuth,
  wrap(async (req, res) => {
    const exists = get('SELECT id FROM users WHERE id = ?', req.params.id);
    if (!exists) throw notFound('用户不存在');
    res.json({ ok: true, graph: getPublicGraph(req.params.id) });
  }),
);

/** 管理后台：图谱统计（节点数、覆盖率、top 节点，答辩用） */
router.get(
  '/admin/stats',
  requireAuth,
  requireAdmin,
  wrap(async (_req, res) => {
    res.json({ ok: true, stats: graphStats() });
  }),
);
