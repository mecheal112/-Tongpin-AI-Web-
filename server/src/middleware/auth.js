import { verifyToken } from '../utils/helpers.js';
import { get } from '../db/index.js';
import { unauthorized, forbidden } from '../utils/helpers.js';
import { hydrateUser } from '../services/user-service.js';

/** 解析 Bearer token，挂载 req.user（不强制） */
export function attachUser(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.cookies?.token;
  if (token) {
    const payload = verifyToken(token);
    if (payload?.uid) {
      const row = get('SELECT * FROM users WHERE id = ?', payload.uid);
      if (row && row.status !== 'banned') req.user = hydrateUser(row);
    }
  }
  next();
}

/** 强制登录 */
export function requireAuth(req, _res, next) {
  if (!req.user) return next(unauthorized());
  next();
}

/** 强制管理员 */
export function requireAdmin(req, _res, next) {
  if (!req.user) return next(unauthorized());
  if (req.user.role !== 'admin') return next(forbidden('需要管理员权限'));
  next();
}

/** 被禁言/封禁的用户不能写入内容 */
export function requireActive(req, _res, next) {
  if (!req.user) return next(unauthorized());
  if (req.user.status === 'muted') return next(forbidden('账号已被禁言，暂时无法发布内容'));
  next();
}

/** 全局错误处理 */
export function errorHandler(err, _req, res, _next) {
  const status = err.status || 500;
  if (status >= 500) console.error('[error]', err);
  res.status(status).json({
    ok: false,
    error: err.message || '服务器内部错误',
    code: err.code,
  });
}
