import { nanoid } from 'nanoid';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';

export const newId = (prefix = '') => (prefix ? `${prefix}_${nanoid(16)}` : nanoid(16));
export const now = () => Date.now();

export function signToken(user) {
  return jwt.sign({ uid: user.id, role: user.role }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
  });
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, config.jwtSecret);
  } catch {
    return null;
  }
}

/** 把 async 路由包起来，异常统一交给错误中间件 */
export const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (msg, code) => new HttpError(400, msg || '请求参数有误', code);
export const unauthorized = (msg) => new HttpError(401, msg || '请先登录');
export const forbidden = (msg) => new HttpError(403, msg || '没有权限');
export const notFound = (msg) => new HttpError(404, msg || '资源不存在');

/** 分页参数解析 */
export function pagination(query, { limit = 20, max = 50 } = {}) {
  const n = Number.parseInt(query.limit ?? '', 10);
  const offset = Number.parseInt(query.offset ?? '', 10);
  return {
    limit: Number.isFinite(n) ? Math.min(Math.max(n, 1), max) : limit,
    offset: Number.isFinite(offset) && offset > 0 ? offset : 0,
  };
}

export const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
