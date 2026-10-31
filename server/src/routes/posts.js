import { Router } from 'express';
import { z } from 'zod';
import { wrap, badRequest, notFound, pagination, newId, now } from '../utils/helpers.js';
import { requireAuth, requireActive } from '../middleware/auth.js';
import { all, get, run, toJson, parseJson } from '../db/index.js';
import { moderate, generateTags } from '../ai/moderation.js';
import { loadPersona } from '../ai/persona.js';
import { extractAndApply } from '../ai/interest-graph.js';
import { publicProfile } from '../ai/matching.js';
import { notify } from '../services/notify-service.js';
import { emitToUser } from '../realtime/index.js';

export const router = Router();

/** 动态流（无需登录也可浏览，但登录后能看到个性化标记） */
router.get(
  '/',
  wrap(async (req, res) => {
    const { limit, offset } = pagination(req.query, { limit: 20 });
    const topic = String(req.query.topic || '').trim();

    const rows = topic
      ? all(
          `SELECT p.*, u.nickname, u.avatar, u.college, u.major, u.grade FROM posts p
           JOIN users u ON u.id = p.author_id
           WHERE p.mod_status != 'blocked' AND p.topics LIKE ?
           ORDER BY p.created_at DESC LIMIT ? OFFSET ?`,
          `%${topic}%`, limit, offset,
        )
      : all(
          `SELECT p.*, u.nickname, u.avatar, u.college, u.major, u.grade FROM posts p
           JOIN users u ON u.id = p.author_id
           WHERE p.mod_status != 'blocked'
           ORDER BY p.created_at DESC LIMIT ? OFFSET ?`,
          limit, offset,
        );

    const likedSet = req.user ? new Set(all('SELECT post_id FROM post_likes WHERE user_id = ?', req.user.id).map((r) => r.post_id)) : new Set();

    res.json({
      ok: true,
      posts: rows.map((r) => shapePost(r, req.user?.id, likedSet)),
      hasMore: rows.length >= limit,
    });
  }),
);

/** 热门话题 */
router.get(
  '/topics',
  wrap(async (_req, res) => {
    const rows = all("SELECT topics FROM posts WHERE mod_status != 'blocked' ORDER BY created_at DESC LIMIT 500");
    const counter = new Map();
    for (const r of rows) {
      for (const t of parseJson(r.topics, [])) counter.set(t, (counter.get(t) || 0) + 1);
    }
    const topics = [...counter.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24).map(([name, count]) => ({ name, count }));
    res.json({ ok: true, topics });
  }),
);

/** 发布动态 —— 经 AI 审核与打标 */
const postSchema = z.object({
  content: z.string().min(1, '写点什么吧').max(2000),
  topics: z.array(z.string().max(20)).max(5).optional(),
});

router.post(
  '/',
  requireActive,
  wrap(async (req, res) => {
    const parsed = postSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);

    const content = parsed.data.content.trim();
    const check = await moderate(content, req.user.id);

    if (check.status === 'blocked') {
      return res.status(422).json({
        ok: false,
        error: '这条内容没有通过社区安全审核',
        moderation: check,
      });
    }

    // 并发做审核与打标，省一轮往返时间
    const tags = await generateTags(content, req.user.id);
    const topics = [...new Set([...(parsed.data.topics || []), ...tags])];

    const id = newId('po');
    const ts = now();
    run(
      `INSERT INTO posts (id,author_id,content,topics,mod_status,mod_reason,mod_score,ai_tags,created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      id, req.user.id, content, toJson(topics), check.status === 'flagged' ? 'flagged' : 'ok',
      check.reason, check.score, toJson(tags), ts,
    );

    const row = get(
      `SELECT p.*, u.nickname, u.avatar, u.college, u.major, u.grade FROM posts p
       JOIN users u ON u.id = p.author_id WHERE p.id = ?`,
      id,
    );

    // 兴趣图谱：动态内容回流到作者的兴趣画像（异步，失败不影响发帖）
    extractAndApply(req.user.id, { source: 'post', sourceId: id, text: content });

    // 自伤类内容：给作者本人一条支持提示，而不是冷冰冰地拦截
    if (check.need_support) {
      notify(
        req.user.id,
        'system',
        '看到你发的内容，有点担心你',
        '如果最近状态不好，学校心理中心可以预约免费咨询，也可以找信任的人聊聊。你不是一个人。',
        '/help',
      );
      emitToUser(req.user.id, 'notification', { type: 'system', title: '看到你发的内容，有点担心你', link: '/help' });
    }

    res.json({
      ok: true,
      post: shapePost(row, req.user.id, new Set()),
      moderation: check.status !== 'ok' ? check : undefined,
    });
  }),
);

router.get(
  '/:id',
  wrap(async (req, res) => {
    const row = get(
      `SELECT p.*, u.nickname, u.avatar, u.college, u.major, u.grade FROM posts p
       JOIN users u ON u.id = p.author_id WHERE p.id = ?`,
      req.params.id,
    );
    if (!row || row.mod_status === 'blocked') throw notFound('动态不存在');
    const liked = req.user ? get('SELECT 1 AS x FROM post_likes WHERE post_id = ? AND user_id = ?', row.id, req.user.id) : null;
    res.json({ ok: true, post: shapePost(row, req.user?.id, new Set(liked ? [row.id] : [])) });
  }),
);

router.delete(
  '/:id',
  requireAuth,
  wrap(async (req, res) => {
    const row = get('SELECT * FROM posts WHERE id = ?', req.params.id);
    if (!row) throw notFound('动态不存在');
    if (row.author_id !== req.user.id && req.user.role !== 'admin') throw badRequest('只能删除自己的动态');
    run('DELETE FROM posts WHERE id = ?', row.id);
    res.json({ ok: true });
  }),
);

/** 举报动态（与消息举报同构，进 reports 表由管理后台处理） */
router.post(
  '/:id/report',
  requireActive,
  wrap(async (req, res) => {
    const post = get('SELECT * FROM posts WHERE id = ?', req.params.id);
    if (!post) throw notFound('动态不存在');
    if (post.author_id === req.user.id) throw badRequest('不能举报自己的动态');
    run(
      `INSERT INTO reports (id,reporter_id,target_type,target_id,reason,detail,created_at) VALUES (?,?,?,?,?,?,?)`,
      newId('rp'), req.user.id, 'post', post.id,
      String(req.body?.reason || '其他').slice(0, 40), String(req.body?.detail || '').slice(0, 500), now(),
    );
    res.json({ ok: true });
  }),
);

/** 点赞（幂等切换） */
router.post(
  '/:id/like',
  requireActive,
  wrap(async (req, res) => {
    const post = get('SELECT * FROM posts WHERE id = ?', req.params.id);
    if (!post) throw notFound('动态不存在');

    const existing = get('SELECT 1 AS x FROM post_likes WHERE post_id = ? AND user_id = ?', post.id, req.user.id);
    if (existing) {
      run('DELETE FROM post_likes WHERE post_id = ? AND user_id = ?', post.id, req.user.id);
      run('UPDATE posts SET like_count = MAX(0, like_count - 1) WHERE id = ?', post.id);
    } else {
      run('INSERT INTO post_likes (post_id,user_id,created_at) VALUES (?,?,?)', post.id, req.user.id, now());
      run('UPDATE posts SET like_count = like_count + 1 WHERE id = ?', post.id);
      if (post.author_id !== req.user.id) {
        notify(post.author_id, 'like', `${req.user.nickname} 赞了你的动态`, post.content.slice(0, 40), `/post/${post.id}`);
        emitToUser(post.author_id, 'notification', { type: 'like', title: `${req.user.nickname} 赞了你的动态`, link: `/post/${post.id}` });
      }
    }
    const updated = get('SELECT like_count FROM posts WHERE id = ?', post.id);
    res.json({ ok: true, liked: !existing, likeCount: updated.like_count });
  }),
);

/** 评论 */
const commentSchema = z.object({ content: z.string().min(1, '评论不能为空').max(500) });

router.get(
  '/:id/comments',
  wrap(async (req, res) => {
    const { limit, offset } = pagination(req.query, { limit: 30 });
    const rows = all(
      `SELECT c.*, u.nickname, u.avatar FROM comments c
       JOIN users u ON u.id = c.author_id
       WHERE c.post_id = ? AND c.mod_status != 'blocked'
       ORDER BY c.created_at ASC LIMIT ? OFFSET ?`,
      req.params.id, limit, offset,
    );
    res.json({ ok: true, comments: rows });
  }),
);

router.post(
  '/:id/comments',
  requireActive,
  wrap(async (req, res) => {
    const parsed = commentSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);

    const post = get('SELECT * FROM posts WHERE id = ?', req.params.id);
    if (!post) throw notFound('动态不存在');

    const content = parsed.data.content.trim();
    const check = await moderate(content, req.user.id);
    if (check.status === 'blocked') {
      return res.status(422).json({ ok: false, error: '这条评论没有通过安全审核', moderation: check });
    }

    const id = newId('cm');
    run(
      'INSERT INTO comments (id,post_id,author_id,content,mod_status,created_at) VALUES (?,?,?,?,?,?)',
      id, post.id, req.user.id, content, check.status === 'flagged' ? 'flagged' : 'ok', now(),
    );
    run('UPDATE posts SET comment_count = comment_count + 1 WHERE id = ?', post.id);

    if (post.author_id !== req.user.id) {
      notify(post.author_id, 'comment', `${req.user.nickname} 评论了你的动态`, content.slice(0, 40), `/post/${post.id}`);
      emitToUser(post.author_id, 'notification', { type: 'comment', title: `${req.user.nickname} 评论了你的动态`, link: `/post/${post.id}` });
    }

    const row = get(
      `SELECT c.*, u.nickname, u.avatar FROM comments c JOIN users u ON u.id = c.author_id WHERE c.id = ?`,
      id,
    );
    res.json({ ok: true, comment: row });
  }),
);

function shapePost(row, userId, likedSet) {
  return {
    id: row.id,
    content: row.content,
    topics: parseJson(row.topics, []),
    aiTags: parseJson(row.ai_tags, []),
    modStatus: row.mod_status,
    likeCount: row.like_count,
    commentCount: row.comment_count,
    liked: likedSet.has(row.id),
    createdAt: row.created_at,
    author: {
      id: row.author_id,
      nickname: row.nickname,
      avatar: row.avatar,
      college: row.college,
      major: row.major,
      grade: row.grade,
    },
  };
}
