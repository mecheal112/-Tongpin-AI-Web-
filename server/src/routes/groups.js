import { Router } from 'express';
import { z } from 'zod';
import { wrap, badRequest, notFound, forbidden, pagination, newId, now } from '../utils/helpers.js';
import { requireAuth, requireActive } from '../middleware/auth.js';
import { all, get, run, parseJson } from '../db/index.js';
import { recommendMembers } from '../ai/group-match.js';
import { extractAndApply } from '../ai/interest-graph.js';
import { moderate } from '../ai/moderation.js';
import { notify } from '../services/notify-service.js';
import {
  isMember,
  memberIds,
  groupUnreadCount,
  groupUnreadTotal,
  markGroupRead,
  seedGroupChat,
  postGroupMessage,
  postSystemMessage,
  listGroupMessages,
  requestJoin,
  pendingRequests,
  pendingRequestCount,
  myPendingRequest,
  decideRequest,
  clearRequest,
  syncGroupCapacity,
} from '../services/group-service.js';
import { emitToUser, emitToGroup } from '../realtime/index.js';

export const router = Router();

const CATEGORIES = ['学习搭子', '运动健身', '兴趣同好', '竞赛组队', '科研项目', '求职交流', '志愿公益', '其他'];

router.get(
  '/categories',
  wrap(async (_req, res) => res.json({ ok: true, categories: CATEGORIES })),
);

router.get(
  '/',
  wrap(async (req, res) => {
    const { limit, offset } = pagination(req.query, { limit: 20 });
    const category = String(req.query.category || '').trim();

    const rows = category
      ? all(
          `SELECT g.*, u.nickname AS owner_name, u.avatar AS owner_avatar,
                  (SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id) AS member_count
           FROM groups g JOIN users u ON u.id = g.owner_id
           WHERE g.status != 'closed' AND g.category = ?
           ORDER BY g.created_at DESC LIMIT ? OFFSET ?`,
          category, limit, offset,
        )
      : all(
          `SELECT g.*, u.nickname AS owner_name, u.avatar AS owner_avatar,
                  (SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id) AS member_count
           FROM groups g JOIN users u ON u.id = g.owner_id
           WHERE g.status != 'closed'
           ORDER BY g.created_at DESC LIMIT ? OFFSET ?`,
          limit, offset,
        );

    res.json({ ok: true, groups: rows.map((r) => shapeGroup(r, req.user?.id)) });
  }),
);

/** 我参与的小组 */
router.get(
  '/mine',
  requireAuth,
  wrap(async (req, res) => {
    const rows = all(
      `SELECT g.*, u.nickname AS owner_name, u.avatar AS owner_avatar,
              (SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id) AS member_count
       FROM groups g JOIN users u ON u.id = g.owner_id
       JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = ?
       ORDER BY g.created_at DESC`,
      req.user.id,
    );
    res.json({ ok: true, groups: rows.map((r) => shapeGroup(r, req.user.id)) });
  }),
);

/**
 * 同频局角标需要的全部数字，一次给全。
 *
 * 两件事共用一个角标：等我审批的入组申请（我要处理），以及我还没看的群聊消息
 * （我要读）。分开取会让两次数值对不上，所以合成一个接口。
 * 必须注册在 /:id 之前，否则会被当成一个小组 id。
 */
router.get(
  '/summary',
  requireAuth,
  wrap(async (req, res) => {
    const rows = all(
      `SELECT r.group_id, COUNT(*) AS n
       FROM group_join_requests r JOIN groups g ON g.id = r.group_id
       WHERE g.owner_id = ? AND r.status = 'pending'
       GROUP BY r.group_id`,
      req.user.id,
    );
    res.json({
      ok: true,
      total: rows.reduce((sum, r) => sum + r.n, 0),
      byGroup: rows.map((r) => ({ groupId: r.group_id, count: r.n })),
      chatUnread: groupUnreadTotal(req.user.id),
    });
  }),
);

router.get(
  '/:id',
  wrap(async (req, res) => {
    const row = get(
      `SELECT g.*, u.nickname AS owner_name, u.avatar AS owner_avatar,
              (SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id) AS member_count
       FROM groups g JOIN users u ON u.id = g.owner_id WHERE g.id = ?`,
      req.params.id,
    );
    if (!row) throw notFound('小组不存在');

    const members = all(
      `SELECT u.id, u.nickname, u.avatar, u.college, u.major, u.grade, gm.role, gm.joined_at
       FROM group_members gm JOIN users u ON u.id = gm.user_id
       WHERE gm.group_id = ? ORDER BY gm.role = 'owner' DESC, gm.joined_at ASC`,
      row.id,
    );

    res.json({ ok: true, group: { ...shapeGroup(row, req.user?.id), members } });
  }),
);

const createSchema = z.object({
  title: z.string().min(2, '标题至少 2 个字').max(40),
  description: z.string().max(1000).optional(),
  category: z.string().max(20).optional(),
  wanted: z.string().max(300).optional(),
  capacity: z.number().int().min(2).max(50).optional(),
  meetAt: z.number().optional(),
  location: z.string().max(60).optional(),
  isOnline: z.boolean().optional(),
});

router.post(
  '/',
  requireActive,
  wrap(async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);
    const d = parsed.data;

    const id = newId('gp');
    const ts = now();
    run(
      `INSERT INTO groups (id,owner_id,title,description,category,wanted,capacity,meet_at,location,is_online,status,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, req.user.id, d.title, d.description || '', CATEGORIES.includes(d.category) ? d.category : '其他',
      d.wanted || '', d.capacity || 6, d.meetAt || null, d.location || '', d.isOnline === false ? 0 : 1, 'open', ts,
    );
    run('INSERT INTO group_members (group_id,user_id,role,joined_at) VALUES (?,?,?,?)', id, req.user.id, 'owner', ts);
    // 兴趣图谱：发起小组也是兴趣信号（异步入图，失败不影响建组）
    extractAndApply(req.user.id, {
      source: 'group',
      sourceId: id,
      text: [d.title, d.category, d.description].filter(Boolean).join('。'),
    });

    const row = get(
      `SELECT g.*, u.nickname AS owner_name, u.avatar AS owner_avatar, 1 AS member_count
       FROM groups g JOIN users u ON u.id = g.owner_id WHERE g.id = ?`,
      id,
    );

    // 建组即建群聊：小组后续的沟通都在这里发生，不用再手动开一个
    seedGroupChat(row);
    res.json({ ok: true, group: shapeGroup(row, req.user.id) });
  }),
);

/** AI 推荐合适的组员 */
router.get(
  '/:id/recommend',
  requireAuth,
  wrap(async (req, res) => {
    const group = get('SELECT * FROM groups WHERE id = ?', req.params.id);
    if (!group) throw notFound('小组不存在');
    if (group.owner_id !== req.user.id) throw badRequest('只有发起人可以查看推荐人选');

    const memberRows = all(
      `SELECT u.id, u.nickname FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = ?`,
      group.id,
    );
    const { loadPersona } = await import('../ai/persona.js');
    const memberInterests = memberRows
      .flatMap((m) => loadPersona(m.id)?.interests || [])
      .map((i) => i.name);

    const result = await recommendMembers(
      { ...group, memberIds: memberRows.map((m) => m.id), memberInterests },
      req.user.id,
    );
    res.json({ ok: true, ...result });
  }),
);

/** 邀请某人加入 */
router.post(
  '/:id/invite',
  requireActive,
  wrap(async (req, res) => {
    const group = get('SELECT * FROM groups WHERE id = ?', req.params.id);
    if (!group) throw notFound('小组不存在');

    // 只有组内成员能以小组名义邀请别人，否则任何人都能给任意用户发邀请通知
    const caller = get('SELECT 1 AS x FROM group_members WHERE group_id = ? AND user_id = ?', group.id, req.user.id);
    if (!caller) throw forbidden('只有小组成员可以邀请别人');

    const { userId } = req.body || {};
    if (!userId) throw badRequest('缺少 userId');
    if (userId === req.user.id) throw badRequest('不用邀请自己');

    const target = get("SELECT id FROM users WHERE id = ? AND status = 'active'", userId);
    if (!target) throw notFound('用户不存在');

    const exists = get('SELECT 1 AS x FROM group_members WHERE group_id = ? AND user_id = ?', group.id, userId);
    if (exists) throw badRequest('对方已经在小组里了');

    notify(userId, 'group', `${req.user.nickname} 邀请你加入「${group.title}」`, group.description.slice(0, 60), `/group/${group.id}`);
    emitToUser(userId, 'notification', { type: 'group', title: `邀请你加入「${group.title}」`, link: `/group/${group.id}` });
    res.json({ ok: true });
  }),
);

/**
 * 申请加入。不再直接入组 —— 先落一条待审批申请，等发起人同意。
 * 这样发起人对小组的成员构成有控制权，群聊也不会被陌生人直接看到。
 */
router.post(
  '/:id/join',
  requireActive,
  wrap(async (req, res) => {
    const group = get('SELECT * FROM groups WHERE id = ?', req.params.id);
    if (!group) throw notFound('小组不存在');

    if (isMember(group.id, req.user.id)) throw badRequest('你已经在这个小组里了');

    const count = get('SELECT COUNT(*) AS n FROM group_members WHERE group_id = ?', group.id).n;
    if (count >= group.capacity) throw badRequest('小组人数已满');

    const req_ = requestJoin(group.id, req.user.id, String(req.body?.message || '').slice(0, 200));
    if (!req_.ok) throw badRequest('你已经在这个小组里了');

    // 通知发起人有新的入组申请，带上申请人自己的话方便判断
    const applicant = get('SELECT nickname FROM users WHERE id = ?', req.user.id);
    notify(
      group.owner_id,
      'group',
      `${applicant?.nickname || '有人'} 申请加入「${group.title}」`,
      String(req.body?.message || '').slice(0, 60),
      `/group/${group.id}`,
    );
    emitToUser(group.owner_id, 'notification', {
      type: 'group',
      title: `${applicant?.nickname || '有人'} 申请加入「${group.title}」`,
      link: `/group/${group.id}`,
    });
    // 单独推一个事件：发起人此刻正开着小组详情页时，申请列表能立刻出现
    emitToUser(group.owner_id, 'group:join-request', {
      groupId: group.id,
      pendingCount: pendingRequestCount(group.id),
    });

    res.json({ ok: true, pending: true, resubmitted: Boolean(req_.resubmitted) });
  }),
);

/** 撤销我提交的入组申请 */
router.post(
  '/:id/join/cancel',
  requireAuth,
  wrap(async (req, res) => {
    const group = get('SELECT * FROM groups WHERE id = ?', req.params.id);
    if (!group) throw notFound('小组不存在');
    if (isMember(group.id, req.user.id)) throw badRequest('你已经是小组成员');

    const mine = myPendingRequest(group.id, req.user.id);
    if (!mine) throw badRequest('没有待处理的申请');

    clearRequest(group.id, req.user.id);
    res.json({ ok: true });
  }),
);

/** 待审批列表（仅发起人） */
router.get(
  '/:id/requests',
  requireAuth,
  wrap(async (req, res) => {
    const group = get('SELECT * FROM groups WHERE id = ?', req.params.id);
    if (!group) throw notFound('小组不存在');
    if (group.owner_id !== req.user.id) throw forbidden('只有发起人可以查看申请');

    res.json({ ok: true, requests: pendingRequests(group.id) });
  }),
);

/** 审批入组申请（仅发起人） */
router.post(
  '/:id/requests/:userId',
  requireActive,
  wrap(async (req, res) => {
    const group = get('SELECT * FROM groups WHERE id = ?', req.params.id);
    if (!group) throw notFound('小组不存在');
    if (group.owner_id !== req.user.id) throw forbidden('只有发起人可以审批');

    const approved = req.body?.action === 'approve';
    if (!approved && req.body?.action !== 'reject') throw badRequest('action 只能是 approve 或 reject');

    const targetId = req.params.userId;
    const result = decideRequest(group.id, targetId, approved);
    if (!result.ok) {
      if (result.error === 'full') throw badRequest('小组人数已满');
      throw notFound('没有待处理的申请');
    }

    const me = get('SELECT nickname FROM users WHERE id = ?', req.user.id);
    const applicant = get('SELECT nickname FROM users WHERE id = ?', targetId);
    if (approved) {
      syncGroupCapacity(group);
      notify(targetId, 'group', `你已加入「${group.title}」`, `${me?.nickname || '发起人'} 通过了你的申请，去群聊打个招呼吧`, `/group/${group.id}`);
      emitToUser(targetId, 'notification', {
        type: 'group',
        title: `你已加入「${group.title}」`,
        link: `/group/${group.id}`,
      });
      // 告诉发起人确认结果，让「我点过通过」这件事有回执
      emitToUser(group.owner_id, 'group:member-changed', {
        groupId: group.id,
        pendingCount: pendingRequestCount(group.id),
      });
    } else {
      notify(targetId, 'group', `「${group.title}」的加入申请未通过`, '', `/group/${group.id}`);
      emitToUser(targetId, 'notification', {
        type: 'group',
        title: `「${group.title}」的加入申请未通过`,
        link: `/group/${group.id}`,
      });
      emitToUser(group.owner_id, 'group:member-changed', {
        groupId: group.id,
        pendingCount: pendingRequestCount(group.id),
      });
    }

    res.json({ ok: true, approved, nickname: applicant?.nickname, memberCount: syncGroupCapacity(group) });
  }),
);

router.post(
  '/:id/leave',
  requireAuth,
  wrap(async (req, res) => {
    const group = get('SELECT * FROM groups WHERE id = ?', req.params.id);
    if (!group) throw notFound('小组不存在');
    if (group.owner_id === req.user.id) throw badRequest('发起人不能退出，可以关闭小组');
    if (!isMember(group.id, req.user.id)) throw badRequest('你不在这个小组里');

    const me = get('SELECT nickname FROM users WHERE id = ?', req.user.id);
    run('DELETE FROM group_members WHERE group_id = ? AND user_id = ?', group.id, req.user.id);
    clearRequest(group.id, req.user.id);
    syncGroupCapacity(group);

    postSystemMessage(group.id, `${me?.nickname || '有人'} 退出了小组`);
    res.json({ ok: true });
  }),
);

/* ---------------- 群聊 ---------------- */

/** 群聊消息列表（仅成员） */
router.get(
  '/:id/messages',
  requireAuth,
  wrap(async (req, res) => {
    const group = get('SELECT * FROM groups WHERE id = ?', req.params.id);
    if (!group) throw notFound('小组不存在');
    if (!isMember(group.id, req.user.id)) throw forbidden('只有小组成员可以查看群聊');

    const { limit = 60, offset = 0 } = pagination(req.query, { limit: 60, max: 100 });
    const rows = listGroupMessages(group.id, { limit, offset });

    // 把发送者昵称一起带上，前端不用再逐个查
    const senders = new Map(
      memberIds(group.id).map((uid) => {
        const u = get('SELECT id, nickname, avatar FROM users WHERE id = ?', uid);
        return [uid, u];
      }),
    );

    // 拉消息就等于看了 —— 在这里落已读，不另开一个「标记已读」接口，
    // 少一个前端可能忘记调的步骤。
    if (offset === 0) markGroupRead(group.id, req.user.id);

    res.json({
      ok: true,
      messages: rows.map((m) => ({
        ...m,
        sender: m.sender_id ? senders.get(m.sender_id) || null : null,
      })),
    });
  }),
);

/** 发群聊消息（仅成员） */
const groupMsgSchema = z.object({ content: z.string().min(1, '消息不能为空').max(2000) });

router.post(
  '/:id/messages',
  requireActive,
  wrap(async (req, res) => {
    const group = get('SELECT * FROM groups WHERE id = ?', req.params.id);
    if (!group) throw notFound('小组不存在');
    if (!isMember(group.id, req.user.id)) throw forbidden('只有小组成员可以在群聊里发言');

    const parsed = groupMsgSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);

    const content = parsed.data.content.trim();
    const check = await moderate(content, req.user.id);
    if (check.status === 'blocked') {
      return res.status(422).json({ ok: false, error: '这条消息没有通过安全审核', moderation: check });
    }

    const msg = postGroupMessage(group.id, req.user.id, content);
    const sender = get('SELECT id, nickname, avatar FROM users WHERE id = ?', req.user.id);
    const payload = { ...msg, sender };

    emitToGroup(group.id, 'group:message', payload);

    // 没开群聊的成员收不到 group:message（他们不在房间里），
    // 所以单独推一个轻量事件让红点亮起来。只推事件、不推消息本身，
    // 免得把未读内容的正文提前泄给不看的人。
    for (const uid of memberIds(group.id)) {
      if (uid !== req.user.id) emitToUser(uid, 'group:unread', { groupId: group.id });
    }

    res.json({ ok: true, message: payload, moderation: check.status !== 'ok' ? check : undefined });
  }),
);

/**
 * 关闭小组。
 *
 * 发起人当然能关自己的小组。管理员也留着这条能力 —— 用于下架违规小组，
 * 走的是和「关闭自己的小组」同一个动作，所以状态语义一致（都是 closed）。
 *
 * 注意判定顺序：先看是不是发起人，再放行管理员。管理员关别人的小组时
 * 要单独回一句「已由管理员关闭」，否则前端拿到 ok 之后没法解释
 * 为什么自己不是发起人却关成功了。
 */
router.delete(
  '/:id',
  requireAuth,
  wrap(async (req, res) => {
    const group = get('SELECT * FROM groups WHERE id = ?', req.params.id);
    if (!group) throw notFound('小组不存在');

    const isOwner = group.owner_id === req.user.id;
    const isAdmin = req.user.role === 'admin';
    if (!isOwner && !isAdmin) throw forbidden('只有发起人可以关闭小组');

    run("UPDATE groups SET status = 'closed' WHERE id = ?", group.id);

    // 不是自己关的，得让组里人知道小组为什么没了
    if (!isOwner) {
      const me = get('SELECT nickname FROM users WHERE id = ?', req.user.id);
      for (const uid of memberIds(group.id)) {
        notify(uid, 'group', `「${group.title}」已被关闭`, '该小组因不符合社区规范已被管理员关闭', `/group/${group.id}`);
      }
      postSystemMessage(group.id, `该小组已被管理员关闭`);
      emitToGroup(group.id, 'group:closed', { groupId: group.id });
    }

    res.json({ ok: true, closedByAdmin: !isOwner });
  }),
);

function shapeGroup(row, userId) {  const isMember = userId
    ? Boolean(get('SELECT 1 AS x FROM group_members WHERE group_id = ? AND user_id = ?', row.id, userId))
    : false;
  // 申请状态要带给前端，否则点了加入之后界面不知道该显示什么
  const pending = userId ? Boolean(myPendingRequest(row.id, userId)) : false;
  const isOwner = userId === row.owner_id;

  return {
    id: row.id,
    title: row.title,
    description: row.description,
    category: row.category,
    wanted: row.wanted,
    capacity: row.capacity,
    memberCount: row.member_count,
    meetAt: row.meet_at,
    location: row.location,
    isOnline: Boolean(row.is_online),
    status: row.status,
    owner: { id: row.owner_id, nickname: row.owner_name, avatar: row.owner_avatar },
    isMember,
    isOwner,
    joinPending: pending,
    pendingCount: isOwner ? pendingRequestCount(row.id) : 0,
    // 角标只告诉人「同频局有动静」，卡片上的未读才告诉他「是哪一个」
    unreadCount: isMember ? groupUnreadCount(row.id, userId) : 0,
    createdAt: row.created_at,
  };
}
