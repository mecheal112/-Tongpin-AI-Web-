/** 与后端接口对应的类型定义 */

export interface User {
  id: string;
  email?: string;
  nickname: string;
  avatar?: string | null;
  school?: string | null;
  college?: string | null;
  major?: string | null;
  grade?: string | null;
  gender?: string | null;
  bio?: string | null;
  contact_pref?: string | null;
  role: 'user' | 'admin';
  is_demo: boolean;
  status: 'active' | 'muted' | 'banned';
  persona_stage: number;
}

export interface Interest {
  name: string;
  weight: number;
}

/**
 * 对外公开的画像对象。
 * 后端 publicProfile() 会把人当作 id 字段返回（内部是 user_id），
 * 所以这里两种都允许，页面里用 id 即可。
 */
export interface Persona {
  id: string;
  user_id?: string;
  nickname: string;
  avatar?: string | null;
  vector: number[];
  interests: Interest[];
  values: string[];
  goals: string[];
  rhythm: string;
  summary: string;
  ideal_match: string;
  raw_text?: string;
  school?: string | null;
  college?: string | null;
  major?: string | null;
  grade?: string | null;
  gender?: string | null;
  bio?: string | null;
  contact_pref?: string | null;
}

export interface Dimension {
  key: string;
  label: string;
  low: string;
  high: string;
}

/** 兴趣图谱（W1）：证据条目，source 决定溯源跳转 */
export interface GraphEvidence {
  source_type: 'interview' | 'post' | 'profile' | 'group';
  source_id: string;
  quote: string;
  at: number;
}

export interface GraphNode {
  id: string;
  name: string;
  category: string;
  status: 'confirmed' | 'auto';
  weight: number;
  updated_at: number;
  evidence: GraphEvidence[];
}

export interface GraphEdge {
  from_node: string;
  to_node: string;
  type: 'sub_of' | 'related' | 'co_occurs';
  weight: number;
}

export interface InterestGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface MatchBreakdown {
  resonance?: number;
  complement?: number;
  compatibility?: number;
  freshness?: number;
  vector?: number;
  interest?: number;
  value?: number;
  text?: number;
  compatDetail?: { key: string; label: string; score: number }[];
}

export interface MatchItem {
  id: string | null;
  user: Persona;
  score: number;
  breakdown: MatchBreakdown;
  reason: string;
  common: string[];
  complement: string[];
  newInterests: string[];
  myAction: 'none' | 'like' | 'pass' | 'connected';
  theirAction?: string;
  source?: string;
  explorable?: boolean;
}

export interface ConversationSummary {
  id: string;
  user: { id: string; nickname: string; avatar?: string | null; summary?: string; college?: string | null };
  lastMessage: string;
  lastAt: number;
  unread: number;
  scaffoldState: ScaffoldState;
  online: boolean;
}

export type ScaffoldState = 'none' | 'active' | 'fading' | 'retired';

export interface Message {
  id: string;
  conv_id: string;
  sender_id: string | null;
  kind: 'text' | 'icebreak' | 'nudge' | 'system';
  content: string;
  read_at?: number | null;
  created_at: number;
}

export interface Icebreaker {
  text: string;
  angle: string;
  target: string;
}

export interface Nudge {
  needed: boolean;
  state?: 'flowing' | 'stalled' | 'unbalanced';
  suggestion?: string;
  reason?: string;
  retired?: boolean;
}

export interface Post {
  id: string;
  content: string;
  topics: string[];
  aiTags: string[];
  modStatus: string;
  likeCount: number;
  commentCount: number;
  liked: boolean;
  createdAt: number;
  author: {
    id: string;
    nickname: string;
    avatar?: string | null;
    college?: string | null;
    major?: string | null;
    grade?: string | null;
  };
}

export interface Comment {
  id: string;
  post_id: string;
  author_id: string;
  content: string;
  created_at: number;
  nickname: string;
  avatar?: string | null;
}

export interface Group {
  id: string;
  title: string;
  description: string;
  category: string;
  wanted: string;
  capacity: number;
  memberCount: number;
  meetAt?: number | null;
  location: string;
  isOnline: boolean;
  status: string;
  owner: { id: string; nickname: string; avatar?: string | null };
  isMember: boolean;
  isOwner: boolean;
  /** 我已提交入组申请，等待发起人通过 */
  joinPending?: boolean;
  /** 待审批的申请数（仅发起人可见） */
  pendingCount?: number;
  /** 群聊里还没看过的消息数（仅成员） */
  unreadCount?: number;
  createdAt: number;
  members?: {
    id: string;
    nickname: string;
    avatar?: string | null;
    college?: string | null;
    major?: string | null;
    grade?: string | null;
    role: string;
    joined_at: number;
  }[];
}

export interface RecommendedMember {
  id: string;
  nickname: string;
  avatar?: string | null;
  summary?: string;
  interests: string[];
  reason: string;
  role_hint: string;
}

export interface Notification {
  id: string;
  user_id: string;
  type: string;
  title: string;
  body: string;
  link: string;
  read_at: number | null;
  created_at: number;
}

export interface Moderation {
  status: 'ok' | 'flagged' | 'blocked';
  score: number;
  labels: string[];
  need_support: boolean;
  reason: string;
}

export interface AiStatus {
  configured: boolean;
  provider: string;
  model: string;
  fallbackEnabled: boolean;
}

export interface DemoAccount {
  email: string;
  nickname: string;
  college?: string | null;
  major?: string | null;
  grade?: string | null;
}

export interface AssistantCitation {
  post_id: string;
  quote: string;
}

export interface AssistantSource {
  post_id: string;
  author: string;
  excerpt: string;
  ts: number;
}

export interface AssistantMessage {
  role: 'user' | 'assistant';
  content: string;
  citations?: AssistantCitation[];
  ts?: number;
}

export interface AssistantAskResult {
  ok: boolean;
  session_id: string;
  answer: string;
  citations: AssistantCitation[];
  sources: AssistantSource[];
  degraded: boolean;
  hits: number;
}

export interface AdminStats {
  users: number;
  personas: number;
  posts: number;
  comments: number;
  matches: number;
  connections: number;
  conversations: number;
  messages: number;
  groups: number;
  activeToday: number;
  newThisWeek: number;
  pendingReports: number;
  flaggedPosts: number;
}
