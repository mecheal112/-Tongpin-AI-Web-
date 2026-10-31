import { run, get, all } from '../db/index.js';
import { newId, now } from '../utils/helpers.js';
import { extractAndApply } from '../ai/interest-graph.js';

/**
 * 同频局：入组审批 + 群聊。
 *
 * 这两个是绑在一起的 —— 小组的存在感来自群聊，而群聊的成员必须
 * 和 group_members 严格一致。所以审批通过的地方就是同时进群聊的地方，
 * 不允许出现「在群里但不在成员列表」这种撕裂状态。
 */

export function isMember(groupId, userId) {
  return Boolean(
    get('SELECT 1 AS x FROM group_members WHERE group_id = ? AND user_id = ?', groupId, userId),
  );
}

export function memberIds(groupId) {
  return all('SELECT user_id FROM group_members WHERE group_id = ?', groupId).map((r) => r.user_id);
}

/** 写一条群聊消息 */
export function postGroupMessage(groupId, senderId, content, kind = 'text') {
  const id = newId('gm');
  const ts = now();
  run(
    `INSERT INTO group_messages (id,group_id,sender_id,kind,content,created_at) VALUES (?,?,?,?,?,?)`,
    id, groupId, senderId, kind, content, ts,
  );
  return { id, group_id: groupId, sender_id: senderId, kind, content, created_at: ts };
}

/** 系统消息：进群、审批结果这类事件写进群聊流，让变化对所有人可见 */
export function postSystemMessage(groupId, content) {
  return postGroupMessage(groupId, null, content, 'system');
}

export function listGroupMessages(groupId, { limit = 60, offset = 0 } = {}) {
  return all(
    'SELECT * FROM group_messages WHERE group_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
    groupId, limit, offset,
  ).reverse();
}

/* ---------------- 群聊未读 ---------------- */

/**
 * 未读的判定：这之后的消息算没读，基准是 last_read_at，没读过就退回 joined_at
 * （刚通过审批入组的人不该继承入组前的聊天记录）。
 *
 * 只数真人发的消息。系统消息（进群、退群、被关闭）不计 —— 红点的含义是
 * 「有人跟你说话」，成员变动不是。这和私信那边 chatUnreadCount 的口径一致。
 */
const UNREAD_PREDICATE = `
  m.sender_id IS NOT NULL
  AND m.sender_id != ?
  AND m.created_at > COALESCE(gm.last_read_at, gm.joined_at)`;

export function groupUnreadCount(groupId, userId) {
  return get(
    `SELECT COUNT(*) AS n FROM group_messages m
     JOIN group_members gm ON gm.group_id = m.group_id AND gm.user_id = ?
     WHERE m.group_id = ? AND ${UNREAD_PREDICATE}`,
    userId, groupId, userId,
  ).n;
}

/** 所有小组的群聊未读合计。已关闭的小组不再计，否则会留下永远清不掉的红点。 */
export function groupUnreadTotal(userId) {
  return get(
    `SELECT COUNT(*) AS n FROM group_messages m
     JOIN group_members gm ON gm.group_id = m.group_id AND gm.user_id = ?
     JOIN groups g ON g.id = m.group_id
     WHERE g.status != 'closed' AND ${UNREAD_PREDICATE}`,
    userId, userId,
  ).n;
}

export function markGroupRead(groupId, userId) {
  run(
    'UPDATE group_members SET last_read_at = ? WHERE group_id = ? AND user_id = ?',
    now(), groupId, userId,
  );
}

/** 建群后立刻给发起人开一条「开场」系统消息，群聊不至于空白 */
export function seedGroupChat(group) {
  postSystemMessage(
    group.id,
    `「${group.title}」已创建，这里是小组的群聊。成员通过申请后会自动加入。`,
  );
}

/** 申请入组。同一人重复申请只保留最新一条 pending。 */
export function requestJoin(groupId, userId, message = '') {
  const existing = get('SELECT * FROM group_join_requests WHERE group_id = ? AND user_id = ?', groupId, userId);
  if (existing?.status === 'approved') return { ok: false, error: 'already-member' };

  const ts = now();
  if (existing) {
    run(
      "UPDATE group_join_requests SET status = 'pending', message = ?, created_at = ?, handled_at = NULL WHERE id = ?",
      message, ts, existing.id,
    );
    return { ok: true, requestId: existing.id, resubmitted: true };
  }

  const id = newId('jr');
  run(
    `INSERT INTO group_join_requests (id,group_id,user_id,message,status,created_at) VALUES (?,?,?,?,?,?)`,
    id, groupId, userId, message, 'pending', ts,
  );
  return { ok: true, requestId: id, resubmitted: false };
}

export function pendingRequests(groupId) {
  return all(
    `SELECT r.*, u.nickname, u.avatar, u.college, u.major, u.grade
     FROM group_join_requests r JOIN users u ON u.id = r.user_id
     WHERE r.group_id = ? AND r.status = 'pending'
     ORDER BY r.created_at ASC`,
    groupId,
  );
}

export function pendingRequestCount(groupId) {
  return get(
    "SELECT COUNT(*) AS n FROM group_join_requests WHERE group_id = ? AND status = 'pending'",
    groupId,
  ).n;
}

/** 我发出的、还在等待的申请 */
export function myPendingRequest(groupId, userId) {
  return get(
    "SELECT * FROM group_join_requests WHERE group_id = ? AND user_id = ? AND status = 'pending'",
    groupId, userId,
  );
}

/**
 * 审批。通过时同步写入 group_members 并广播进群事件，
 * 这两步必须一起成功，否则会出现成员与群聊不一致。
 */
export function decideRequest(groupId, userId, approved) {
  const req = get('SELECT * FROM group_join_requests WHERE group_id = ? AND user_id = ?', groupId, userId);
  if (!req || req.status !== 'pending') return { ok: false, error: 'no-request' };

  const ts = now();
  run(
    'UPDATE group_join_requests SET status = ?, handled_at = ? WHERE id = ?',
    approved ? 'approved' : 'rejected', ts, req.id,
  );

  if (approved) {
    if (!isMember(groupId, userId)) {
      run(
        'INSERT INTO group_members (group_id,user_id,role,joined_at) VALUES (?,?,?,?)',
        groupId, userId, 'member', ts,
      );
    }
    const user = get('SELECT nickname FROM users WHERE id = ?', userId);
    postSystemMessage(groupId, `${user?.nickname || '新成员'} 加入了小组`);
    // 兴趣图谱：入组是弱兴趣信号（异步入图，失败不影响审批）
    const g = get('SELECT title, category, description FROM groups WHERE id = ?', groupId);
    if (g) {
      extractAndApply(userId, {
        source: 'group',
        sourceId: groupId,
        text: [g.title, g.category, g.description].filter(Boolean).join('。'),
      });
    }
  }

  return { ok: true, request: req, userId };
}

/** 退出小组时把申请记录一并撤掉，否则会卡在 approved 状态无法再申请 */
export function clearRequest(groupId, userId) {
  run(
    "UPDATE group_join_requests SET status = 'cancelled', handled_at = ? WHERE group_id = ? AND user_id = ? AND status = 'pending'",
    now(), groupId, userId,
  );
}

/** 满员时把状态标成 full，退出后回到 open */
export function syncGroupCapacity(group) {
  const count = get('SELECT COUNT(*) AS n FROM group_members WHERE group_id = ?', group.id).n;
  if (count >= group.capacity) run("UPDATE groups SET status = 'full' WHERE id = ?", group.id);
  else if (group.status === 'full') run("UPDATE groups SET status = 'open' WHERE id = ?", group.id);
  return count;
}
