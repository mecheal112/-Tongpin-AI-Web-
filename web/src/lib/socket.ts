import { io, type Socket } from 'socket.io-client';
import { getToken } from '@/api';

/**
 * Socket 单例。只有登录后才建立连接，
 * 登出时断开，避免拿着失效令牌反复重连。
 */

let socket: Socket | null = null;

export function connectSocket(): Socket | null {
  const token = getToken();
  if (!token) return null;
  if (socket?.connected) return socket;

  socket?.disconnect();
  socket = io({
    path: '/socket.io',
    auth: { token },
    transports: ['websocket', 'polling'],
    reconnectionDelay: 1000,
    reconnectionDelayMax: 8000,
  });
  return socket;
}

export function getSocket(): Socket | null {
  return socket;
}

export function disconnectSocket() {
  socket?.disconnect();
  socket = null;
}
