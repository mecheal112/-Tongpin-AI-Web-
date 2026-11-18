import { run, get, all } from '../db/index.js';
import { newId, now } from '../utils/helpers.js';

export function notify(userId, type, title, body = '', link = '') {
  run(
    `INSERT INTO notifications (id,user_id,type,title,body,link,created_at) VALUES (?,?,?,?,?,?,?)`,
    newId('ntf'),
    userId,
    type,
    title,
    body,
    link,
    now(),
  );
}

/**
 * 同类通知在窗口内只发一条。
 *
 * 通知的价值来自稀缺性：同一个「今日推荐」每天推一次是有用的提醒，
 * 每刷新一次推一次就变成了骚扰，用户会开始无视整个通知中心。
 * 所以对批量生成的、非事件驱动的通知统一用这个入口。
 */
export function notifyOnce(userId, type, title, body = '', link = '', { windowMs = 86400000, key = '' } = {}) {
  const since = now() - windowMs;
  const existing = key
    ? get(
        'SELECT id FROM notifications WHERE user_id = ? AND type = ? AND link = ? AND title = ? AND created_at > ? LIMIT 1',
        userId, type, link, title, since,
      )
    : get(
        'SELECT id FROM notifications WHERE user_id = ? AND type = ? AND created_at > ? LIMIT 1',
        userId, type, since,
      );
  if (existing) return false;
  notify(userId, type, title, body, link);
  return true;
}

export function listNotifications(userId, { limit = 30, offset = 0 } = {}) {
  return all(
    'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
    userId,
    limit,
    offset,
  );
}

export function unreadCount(userId) {
  return get('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL', userId).n;
}

/** 未读私信数：只算别人发给我的，自己发的不计 */
export function chatUnreadCount(userId) {
  return get(
    `SELECT COUNT(*) AS n FROM messages m
     JOIN conversations c ON c.id = m.conv_id
     WHERE (c.user_a = ? OR c.user_b = ?)
       AND m.sender_id IS NOT NULL
       AND m.sender_id != ?
       AND m.read_at IS NULL`,
    userId,
    userId,
    userId,
  ).n;
}

export function markRead(userId, ids) {
  if (!ids?.length) {
    run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', now(), userId);
    return;
  }
  const placeholders = ids.map(() => '?').join(',');
  run(
    `UPDATE notifications SET read_at = ? WHERE user_id = ? AND id IN (${placeholders}) AND read_at IS NULL`,
    now(),
    userId,
    ...ids,
  );
}

/** 会话查找或创建，统一 user_a < user_b */
export function findOrCreateConversation(u1, u2) {
  const [a, b] = [u1, u2].sort();
  const existing = get('SELECT * FROM conversations WHERE user_a = ? AND user_b = ?', a, b);
  if (existing) return existing;

  const id = newId('cv');
  const ts = now();
  run(
    `INSERT INTO conversations (id,user_a,user_b,last_message,last_at,scaffold_state,created_at)
     VALUES (?,?,?,?,?,?,?)`,
    id, a, b, '', ts, 'none', ts,
  );
  return get('SELECT * FROM conversations WHERE id = ?', id);
}

export function conversationFor(convId, userId) {
  const conv = get('SELECT * FROM conversations WHERE id = ?', convId);
  if (!conv) return null;
  if (conv.user_a !== userId && conv.user_b !== userId) return null;
  return conv;
}

export function otherParty(conv, userId) {
  return conv.user_a === userId ? conv.user_b : conv.user_a;
}
