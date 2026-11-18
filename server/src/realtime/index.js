import { Server } from 'socket.io';
import { verifyToken } from '../utils/helpers.js';
import { markOnline, markOffline, isOnline } from '../services/user-service.js';
import { conversationFor, otherParty } from '../services/notify-service.js';
import { isMember as isGroupMember, markGroupRead } from '../services/group-service.js';

/**
 * 实时层。单实例内存态，故不需要 Redis adapter。
 * 房间约定：
 *   user:<id>   —— 用于向特定用户推送通知
 *   conv:<id>   —— 用于向会话双方推送消息
 *   group:<id>  —— 用于向小组成员推送群聊消息
 */

let io;

export function initRealtime(httpServer, { corsOrigin }) {
  io = new Server(httpServer, {
    cors: { origin: corsOrigin, credentials: true },
    path: '/socket.io',
    pingTimeout: 25000,
  });

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    const payload = token ? verifyToken(token) : null;
    if (!payload?.uid) return next(new Error('unauthorized'));
    socket.data.userId = payload.uid;
    next();
  });

  io.on('connection', (socket) => {
    const userId = socket.data.userId;
    socket.join(`user:${userId}`);
    markOnline(userId);

    // 通知好友我在线
    broadcastPresence(userId, true);

    socket.on('conv:join', ({ convId }) => {
      if (!convId) return;
      const conv = conversationFor(convId, userId);
      if (conv) socket.join(`conv:${convId}`);
    });

    socket.on('conv:leave', ({ convId }) => {
      if (convId) socket.leave(`conv:${convId}`);
    });

    // 进群聊房间要校验成员身份，否则任何登录用户都能监听任意小组的消息
    socket.on('group:join', ({ groupId }) => {
      if (!groupId) return;
      if (isGroupMember(groupId, userId)) socket.join(`group:${groupId}`);
    });

    socket.on('group:leave', ({ groupId }) => {
      if (groupId) socket.leave(`group:${groupId}`);
    });

    // 群聊页面开着时收到新消息，客户端回一个已读，否则红点会一直亮着
    socket.on('group:read', ({ groupId }) => {
      if (!groupId) return;
      if (!isGroupMember(groupId, userId)) return;
      markGroupRead(groupId, userId);
    });

    // 正在输入
    socket.on('typing', ({ convId, typing }) => {
      if (!convId) return;
      const conv = conversationFor(convId, userId);
      if (!conv) return;
      socket.to(`conv:${convId}`).emit('typing', { convId, userId, typing: Boolean(typing) });
    });

    socket.on('ping:alive', () => {
      markOnline(userId);
    });

    socket.on('disconnect', () => {
      markOffline(userId);
      broadcastPresence(userId, false);
    });
  });

  return io;
}

function broadcastPresence(userId, online) {
  if (!io) return;
  io.emit('presence', { userId, online });
}

export function emitToUser(userId, event, payload) {
  if (!io) return;
  io.to(`user:${userId}`).emit(event, payload);
}

export function emitToConversation(convId, event, payload) {
  if (!io) return;
  io.to(`conv:${convId}`).emit(event, payload);
}

export function emitToGroup(groupId, event, payload) {
  if (!io) return;
  io.to(`group:${groupId}`).emit(event, payload);
}

export function getIo() {
  return io;
}
