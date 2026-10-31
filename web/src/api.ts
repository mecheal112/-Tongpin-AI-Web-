/**
 * 后端接口封装。
 *
 * 统一处理令牌注入、错误抛出与 401 登出，页面里不用重复写这些。
 */

const TOKEN_KEY = 'tongpin_token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(t: string) {
  localStorage.setItem(TOKEN_KEY, t);
}
export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  status: number;
  code?: string;
  payload?: unknown;
  constructor(status: number, message: string, code?: string, payload?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

/** 令牌失效时通知外层跳登录 */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  let data: any = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
  }

  if (!res.ok) {
    if (res.status === 401) {
      clearToken();
      onUnauthorized?.();
    }
    throw new ApiError(res.status, data?.error || `请求失败(${res.status})`, data?.code, data);
  }

  return data as T;
}

export const api = {
  get: <T>(p: string) => request<T>('GET', p),
  post: <T>(p: string, b?: unknown) => request<T>('POST', p, b),
  patch: <T>(p: string, b?: unknown) => request<T>('PATCH', p, b),
  del: <T>(p: string) => request<T>('DELETE', p),
};

/* ---------------- 各模块接口 ---------------- */

export const authApi = {
  register: (b: Record<string, unknown>) => api.post<{ ok: true; token: string; user: any }>('/auth/register', b),
  login: (email: string, password: string) =>
    api.post<{ ok: true; token: string; user: any }>('/auth/login', { email, password }),
  demoLogin: (email: string) => api.post<{ ok: true; token: string; user: any }>('/auth/demo-login', { email }),
  me: () => api.get<{ ok: true; user: any; ai: any }>('/auth/me'),
  updateMe: (b: Record<string, unknown>) => api.patch<{ ok: true; user: any }>('/auth/me', b),
  demoAccounts: () =>
    api.get<{ ok: true; password: string; accounts: any[]; ai: any }>('/auth/demo-accounts'),
};

export const personaApi = {
  me: () => api.get<any>('/persona/me'),
  startSession: () => api.post<any>('/persona/session'),
  turn: (id: string, message: string) => api.post<any>(`/persona/session/${id}/turn`, { message }),
  restart: (id: string) => api.post<any>(`/persona/session/${id}/restart`),
  quick: (text: string) => api.post<any>('/persona/quick', { text }),
  tune: (b: { vector?: number[]; rhythm?: string }) => api.patch<any>('/persona/me', b),
};

export const matchApi = {
  daily: (limit = 6) => api.get<any>(`/match/daily?limit=${limit}`),
  explore: (limit = 12) => api.get<any>(`/match/explore?limit=${limit}`),
  received: () => api.get<any>('/match/received'),
  connections: () => api.get<any>('/match/connections'),
  detail: (id: string) => api.get<any>(`/match/${id}`),
  /** 只读地看某人的资料卡，不产生任何表态 */
  profile: (userId: string) => api.get<any>(`/match/profile/${userId}`),
  act: (id: string, action: 'like' | 'pass') => api.post<any>(`/match/${id}/action`, { action }),
  /** 主动发起连接（会记录一次 like） */
  direct: (userId: string) => api.post<any>(`/match/direct/${userId}`),
};

export const chatApi = {
  conversations: () => api.get<any>('/chat/conversations'),
  openWith: (userId: string) => api.post<any>(`/chat/with/${userId}`),
  detail: (id: string) => api.get<any>(`/chat/${id}`),
  icebreakers: (id: string) => api.get<any>(`/chat/${id}/icebreakers`),
  send: (id: string, content: string, kind?: string) => api.post<any>(`/chat/${id}/messages`, { content, kind }),
  nudge: (id: string) => api.post<any>(`/chat/${id}/nudge`),
  scaffold: (id: string, action: 'recall' | 'retire') => api.post<any>(`/chat/${id}/scaffold`, { action }),
  read: (id: string) => api.post<any>(`/chat/${id}/read`),
  report: (msgId: string, reason: string, detail = '') =>
    api.post<any>(`/chat/messages/${msgId}/report`, { reason, detail }),
};

export const postApi = {
  list: (limit = 20, offset = 0, topic = '') =>
    api.get<any>(`/posts?limit=${limit}&offset=${offset}${topic ? `&topic=${encodeURIComponent(topic)}` : ''}`),
  topics: () => api.get<any>('/posts/topics'),
  create: (content: string, topics?: string[]) => api.post<any>('/posts', { content, topics }),
  get: (id: string) => api.get<any>(`/posts/${id}`),
  remove: (id: string) => api.del<any>(`/posts/${id}`),
  like: (id: string) => api.post<any>(`/posts/${id}/like`),
  report: (id: string, reason: string, detail = '') => api.post<any>(`/posts/${id}/report`, { reason, detail }),
  comments: (id: string) => api.get<any>(`/posts/${id}/comments`),
  comment: (id: string, content: string) => api.post<any>(`/posts/${id}/comments`, { content }),
};

export const groupApi = {
  list: (category = '') => api.get<any>(`/groups${category ? `?category=${encodeURIComponent(category)}` : ''}`),
  mine: () => api.get<any>('/groups/mine'),
  categories: () => api.get<any>('/groups/categories'),
  detail: (id: string) => api.get<any>(`/groups/${id}`),
  create: (b: Record<string, unknown>) => api.post<any>('/groups', b),
  recommend: (id: string) => api.get<any>(`/groups/${id}/recommend`),
  invite: (id: string, userId: string) => api.post<any>(`/groups/${id}/invite`, { userId }),
  /** 申请加入，需发起人通过 */
  join: (id: string, message = '') => api.post<any>(`/groups/${id}/join`, { message }),
  cancelJoin: (id: string) => api.post<any>(`/groups/${id}/join/cancel`),
  /** 同频局角标要的两个数字：待审批申请数 + 群聊未读 */
  summary: () =>
    api.get<{ ok: true; total: number; byGroup: { groupId: string; count: number }[]; chatUnread: number }>(
      '/groups/summary',
    ),
  requests: (id: string) => api.get<any>(`/groups/${id}/requests`),
  decide: (id: string, userId: string, action: 'approve' | 'reject') =>
    api.post<any>(`/groups/${id}/requests/${userId}`, { action }),
  leave: (id: string) => api.post<any>(`/groups/${id}/leave`),
  /** 发起人可以关自己的小组；管理员可以关任意小组（下架违规内容） */
  close: (id: string) => api.del<any>(`/groups/${id}`),

  /* 群聊 */
  messages: (id: string, limit = 60) => api.get<any>(`/groups/${id}/messages?limit=${limit}`),
  send: (id: string, content: string) => api.post<any>(`/groups/${id}/messages`, { content }),
};

export const graphApi = {
  /** 自己的完整图谱：节点（含权重与证据）+ 节点间边 */
  own: () => api.get<{ ok: true; graph: import('./types').InterestGraph }>('/graph/own'),
  /** 他人公开裁剪版：top 10 节点，无证据明细 */
  user: (id: string) =>
    api.get<{ ok: true; graph: { nodes: { name: string; category: string; weight: number }[] } }>(`/graph/user/${id}`),
  /** 管理后台图谱统计 */
  stats: () => api.get<any>('/graph/admin/stats'),
};

export const notifApi = {
  list: () => api.get<{ ok: true; notifications: any[]; unread: number; chat: number }>('/notifications'),
  unread: () => api.get<{ ok: true; unread: number; chat: number }>('/notifications/unread-count'),
  read: (ids?: string[]) =>
    api.post<{ ok: true; unread: number; chat: number }>('/notifications/read', { ids }),
};

export const adminApi = {
  stats: () => api.get<any>('/admin/stats'),
  aiLogs: () => api.get<any>('/admin/ai-logs'),
  users: (q = '') => api.get<any>(`/admin/users${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  setUserStatus: (id: string, status: string) => api.post<any>(`/admin/users/${id}/status`, { status }),
  posts: (status = '') => api.get<any>(`/admin/posts${status ? `?status=${status}` : ''}`),
  moderatePost: (id: string, status: string) => api.post<any>(`/admin/posts/${id}/moderate`, { status }),
  reports: () => api.get<any>('/admin/reports'),
  resolveReport: (id: string, status: string) => api.post<any>(`/admin/reports/${id}/resolve`, { status }),
  matchQuality: () => api.get<any>('/admin/match-quality'),
};
