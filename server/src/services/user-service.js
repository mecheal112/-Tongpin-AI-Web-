import bcrypt from 'bcryptjs';
import { all, get, run } from '../db/index.js';
import { newId, now, HttpError } from '../utils/helpers.js';
import { extractAndApply } from '../ai/interest-graph.js';

/** 数据库行 -> 对外的用户对象（剔除密码等敏感字段） */
export function hydrateUser(row) {
  if (!row) return null;
  const { password_hash, ...rest } = row;
  return {
    ...rest,
    is_demo: Boolean(row.is_demo),
  };
}

export function findByEmail(email) {
  return get('SELECT * FROM users WHERE email = ?', String(email || '').trim().toLowerCase());
}

export function findById(id) {
  return get('SELECT * FROM users WHERE id = ?', id);
}

export function requireUser(id) {
  const u = findById(id);
  if (!u) throw new HttpError(404, '用户不存在');
  return u;
}

export async function createUser({ email, password, nickname, ...rest }) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (findByEmail(normalizedEmail)) {
    throw new HttpError(409, '该邮箱已被注册');
  }
  const id = newId('u');
  const ts = now();
  const hash = await bcrypt.hash(password, 10);

  run(
    `INSERT INTO users (id,email,password_hash,nickname,school,college,major,grade,gender,bio,contact_pref,role,status,persona_stage,created_at,last_active_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    normalizedEmail,
    hash,
    nickname || normalizedEmail.split('@')[0],
    rest.school || null,
    rest.college || null,
    rest.major || null,
    rest.grade || null,
    rest.gender || null,
    rest.bio || null,
    rest.contact_pref || '都可',
    rest.role || 'user',
    'active',
    0,
    ts,
    ts,
  );
  return hydrateUser(findById(id));
}

export async function verifyPassword(user, password) {
  return bcrypt.compare(String(password || ''), user.password_hash);
}

export function touchActive(id) {
  run('UPDATE users SET last_active_at = ? WHERE id = ?', now(), id);
}

export function updateProfile(id, fields) {
  const ALLOWED = ['nickname', 'avatar', 'school', 'college', 'major', 'grade', 'gender', 'bio', 'contact_pref'];
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!ALLOWED.includes(k)) continue;
    sets.push(`${k} = ?`);
    vals.push(v === '' ? null : v);
  }
  if (!sets.length) return hydrateUser(findById(id));
  vals.push(id);
  run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, ...vals);
  // 兴趣图谱：简介是兴趣证据之一（异步入图，失败不影响保存）
  if (typeof fields.bio === 'string' && fields.bio.trim()) {
    extractAndApply(id, { source: 'profile', sourceId: id, text: fields.bio });
  }
  return hydrateUser(findById(id));
}

/** 简单的内存级在线状态（单实例部署够用） */
const online = new Map(); // userId -> lastSeen

export function markOnline(userId) {
  online.set(userId, Date.now());
  touchActive(userId);
}

export function markOffline(userId) {
  online.delete(userId);
}

export function isOnline(userId) {
  const t = online.get(userId);
  return Boolean(t && Date.now() - t < 120000);
}

export function onlineIds() {
  const cutoff = Date.now() - 120000;
  return [...online.entries()].filter(([, t]) => t > cutoff).map(([id]) => id);
}

/** 管理后台：用户列表 */
export function listUsers({ limit = 50, offset = 0, q = '' } = {}) {
  const like = `%${q}%`;
  const rows = q
    ? all(
        `SELECT * FROM users WHERE nickname LIKE ? OR email LIKE ? OR school LIKE ? OR major LIKE ?
         ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        like, like, like, like, limit, offset,
      )
    : all('SELECT * FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?', limit, offset);
  return rows.map(hydrateUser);
}

export function countUsers() {
  return get('SELECT COUNT(*) AS n FROM users').n;
}
