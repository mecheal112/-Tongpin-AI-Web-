-- ============================================================
--  同频 Tongpin 数据库结构
--  SQLite (Node 内置 node:sqlite)，WAL 模式
-- ============================================================

PRAGMA foreign_keys = ON;

-- ---------- 用户 ----------
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  nickname      TEXT NOT NULL,
  avatar        TEXT,
  -- 基础资料
  school        TEXT,
  college       TEXT,          -- 学院
  major         TEXT,          -- 专业
  grade         TEXT,          -- 年级：大一/大二/...
  gender        TEXT,
  bio           TEXT,
  -- 社交偏好
  contact_pref  TEXT,          -- 线上/线下/都可
  -- 状态
  role          TEXT NOT NULL DEFAULT 'user',   -- user | admin
  is_demo       INTEGER NOT NULL DEFAULT 0,     -- 评审体验账号标记
  status        TEXT NOT NULL DEFAULT 'active', -- active | muted | banned
  -- 画像完成度：0 未开始，1 访谈中，2 已完成
  persona_stage INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_persona_stage ON users(persona_stage);

-- ---------- 人格画像 ----------
-- 由 AI 对话式访谈生成。这是整个匹配引擎的数据基础。
CREATE TABLE IF NOT EXISTS personas (
  user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- 6 维人格向量，取值 0..100，以 JSON 数组存储
  -- [社交能量, 探索开放度, 结构条理, 情绪共情, 表达活跃, 深度偏好]
  vector      TEXT NOT NULL,
  -- 兴趣图谱：[{name, weight}]，由访谈中抽取
  interests   TEXT NOT NULL DEFAULT '[]',
  -- 价值观与目标关键词
  values_json TEXT NOT NULL DEFAULT '[]',
  goals       TEXT NOT NULL DEFAULT '[]',
  -- 作息：早起型/夜猫型 等
  rhythm      TEXT NOT NULL DEFAULT '灵活',
  -- AI 生成的一句话画像摘要
  summary     TEXT NOT NULL DEFAULT '',
  -- AI 提炼的「理想同频对象」描述
  ideal_match TEXT NOT NULL DEFAULT '',
  -- 自由文本，用于语义相似度兜底
  raw_text    TEXT NOT NULL DEFAULT '',
  -- 画像版本，重做访谈时 +1
  version     INTEGER NOT NULL DEFAULT 1,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_personas_rhythm ON personas(rhythm);

-- ---------- 画像访谈会话 ----------
CREATE TABLE IF NOT EXISTS persona_sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'active',   -- active | done | abandoned
  messages    TEXT NOT NULL DEFAULT '[]',       -- [{role, content, ts}]
  turn_count  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_psess_user ON persona_sessions(user_id, status);

-- ---------- 匹配 ----------
CREATE TABLE IF NOT EXISTS matches (
  id          TEXT PRIMARY KEY,
  user_a      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  score       REAL NOT NULL,          -- 总匹配分 0..100
  breakdown   TEXT NOT NULL DEFAULT '{}',  -- 各维度得分明细
  reason      TEXT NOT NULL DEFAULT '',    -- AI 生成的匹配理由
  -- 互补性增益：B 在哪些方面补足了 A
  complement  TEXT NOT NULL DEFAULT '[]',
  source      TEXT NOT NULL DEFAULT 'daily', -- daily | explore | group
  -- 双方反馈
  a_action    TEXT NOT NULL DEFAULT 'none',  -- none | like | pass | connected
  b_action    TEXT NOT NULL DEFAULT 'none',
  created_at  INTEGER NOT NULL,
  UNIQUE(user_a, user_b)
);
CREATE INDEX IF NOT EXISTS idx_matches_a ON matches(user_a, a_action);
CREATE INDEX IF NOT EXISTS idx_matches_b ON matches(user_b, b_action);

-- ---------- 用户对匹配的反馈（用于改进推荐） ----------
CREATE TABLE IF NOT EXISTS match_feedback (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action     TEXT NOT NULL,      -- like | pass
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, target_id)
);

-- ---------- 会话（私信） ----------
CREATE TABLE IF NOT EXISTS conversations (
  id           TEXT PRIMARY KEY,
  user_a       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_message TEXT NOT NULL DEFAULT '',
  last_at      INTEGER NOT NULL,
  -- 破冰状态：AI 脚手架的生命周期
  -- none 未激活 | active 活跃介入 | fading 正在退场 | retired 已完全退场
  scaffold_state TEXT NOT NULL DEFAULT 'none',
  created_at   INTEGER NOT NULL,
  UNIQUE(user_a, user_b)
);

CREATE TABLE IF NOT EXISTS messages (
  id        TEXT PRIMARY KEY,
  conv_id   TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id TEXT,                       -- NULL 表示 AI 脚手架消息
  kind      TEXT NOT NULL DEFAULT 'text', -- text | icebreak | nudge | system
  content   TEXT NOT NULL,
  read_at   INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conv_id, created_at);

-- ---------- 动态社区 ----------
CREATE TABLE IF NOT EXISTS posts (
  id          TEXT PRIMARY KEY,
  author_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content     TEXT NOT NULL,
  -- 话题标签，JSON 数组
  topics      TEXT NOT NULL DEFAULT '[]',
  -- AI 审核
  mod_status  TEXT NOT NULL DEFAULT 'ok',   -- ok | flagged | blocked
  mod_reason  TEXT NOT NULL DEFAULT '',
  mod_score   REAL NOT NULL DEFAULT 0,
  like_count  INTEGER NOT NULL DEFAULT 0,
  comment_count INTEGER NOT NULL DEFAULT 0,
  -- AI 生成的动态摘要标签（用于语义检索）
  ai_tags     TEXT NOT NULL DEFAULT '[]',
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC);

CREATE TABLE IF NOT EXISTS post_likes (
  post_id    TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, user_id)
);

CREATE TABLE IF NOT EXISTS comments (
  id         TEXT PRIMARY KEY,
  post_id    TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content    TEXT NOT NULL,
  mod_status TEXT NOT NULL DEFAULT 'ok',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id, created_at);

-- ---------- 同频局（组队活动） ----------
CREATE TABLE IF NOT EXISTS groups (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category    TEXT NOT NULL DEFAULT '其他',
  -- 期望的成员特质，用于 AI 推荐人选
  wanted      TEXT NOT NULL DEFAULT '',
  capacity    INTEGER NOT NULL DEFAULT 6,
  meet_at     INTEGER,
  location    TEXT NOT NULL DEFAULT '',
  is_online   INTEGER NOT NULL DEFAULT 1,
  status      TEXT NOT NULL DEFAULT 'open',  -- open | full | closed
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_groups_status ON groups(status, created_at DESC);

CREATE TABLE IF NOT EXISTS group_members (
  group_id   TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'member',  -- owner | member
  joined_at   INTEGER NOT NULL,
  -- 上次读到群聊的哪一刻。未读 = 这之后的消息，所以它是红点的唯一依据。
  -- 老数据里为 NULL，用 joined_at 兜底（入组后没看过就算没读）。
  last_read_at INTEGER,
  PRIMARY KEY (group_id, user_id)
);

-- ---------- 入组申请 ----------
-- 加入同频局需要发起人同意，所以「想加入」先落成一条申请，
-- 通过后才真正写进 group_members 并进群聊。
CREATE TABLE IF NOT EXISTS group_join_requests (
  id         TEXT PRIMARY KEY,
  group_id   TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message    TEXT NOT NULL DEFAULT '',       -- 申请人自述，方便发起人判断
  status     TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | cancelled
  created_at INTEGER NOT NULL,
  handled_at INTEGER,
  UNIQUE(group_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_joinreq_pending ON group_join_requests(group_id, status, created_at DESC);

-- ---------- 小组群聊 ----------
-- 单独一张表，不和 1:1 的 conversations 混在一起：
-- 私聊的核心是「两个人的破冰」，群聊是「一组人協作」，生命周期和权限都不同。
CREATE TABLE IF NOT EXISTS group_messages (
  id         TEXT PRIMARY KEY,
  group_id   TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  sender_id  TEXT,                       -- NULL 表示系统消息
  kind       TEXT NOT NULL DEFAULT 'text', -- text | system
  content    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gmsg_group ON group_messages(group_id, created_at);

-- ---------- 通知 ----------
CREATE TABLE IF NOT EXISTS notifications (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,   -- match | message | like | comment | group | system
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  link       TEXT NOT NULL DEFAULT '',
  read_at    INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, created_at DESC);

-- ---------- 举报 ----------
CREATE TABLE IF NOT EXISTS reports (
  id          TEXT PRIMARY KEY,
  reporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL,   -- user | post | comment | message
  target_id   TEXT NOT NULL,
  reason      TEXT NOT NULL,
  detail      TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'pending', -- pending | resolved | dismissed
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at DESC);

-- ---------- 兴趣图谱 ----------
-- 规范化的兴趣概念节点。14 类种子节点在 migrate 时兜底写入，
-- 运行期抽取可自动建新节点（status='auto'）。
CREATE TABLE IF NOT EXISTS interest_nodes (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,      -- 规范名，如「摄影设计」
  aliases     TEXT NOT NULL DEFAULT '[]',-- 别名 JSON，如 ["摄影","拍照"]
  category    TEXT NOT NULL,             -- 14 类之一
  parent_id   TEXT REFERENCES interest_nodes(id),
  status      TEXT NOT NULL DEFAULT 'auto',  -- auto | confirmed
  created_at  INTEGER NOT NULL
);

-- 节点关系：sub_of 层级 / related 关联 / co_occurs 文本共现
CREATE TABLE IF NOT EXISTS interest_edges (
  from_node   TEXT NOT NULL REFERENCES interest_nodes(id) ON DELETE CASCADE,
  to_node     TEXT NOT NULL REFERENCES interest_nodes(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  weight      REAL NOT NULL DEFAULT 1,
  PRIMARY KEY (from_node, to_node, type)
);

-- 用户兴趣：权重 + 证据（哪条动态/哪句访谈贡献的）
CREATE TABLE IF NOT EXISTS user_interests (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  node_id     TEXT NOT NULL REFERENCES interest_nodes(id) ON DELETE CASCADE,
  weight      REAL NOT NULL DEFAULT 0,   -- 0-100
  evidence    TEXT NOT NULL DEFAULT '[]',-- [{source_type,source_id,quote,at}]，FIFO 上限 8
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, node_id)
);
CREATE INDEX IF NOT EXISTS idx_uinterests_weight ON user_interests(user_id, weight DESC);

-- 权重变更流水（涨跌溯源，「图谱演化」演示的数据源）
CREATE TABLE IF NOT EXISTS interest_weight_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  node_id     TEXT NOT NULL,
  delta       REAL NOT NULL,
  reason      TEXT NOT NULL,             -- interview | post | profile | group | decay
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_iwlog_user ON interest_weight_log(user_id, created_at DESC);

-- ---------- AI 调用审计 ----------
CREATE TABLE IF NOT EXISTS ai_logs (
  id         TEXT PRIMARY KEY,
  user_id    TEXT,
  task       TEXT NOT NULL,      -- persona | match | icebreak | moderate | summary
  provider   TEXT NOT NULL,      -- anthropic | openai | local
  model      TEXT NOT NULL DEFAULT '',
  latency_ms INTEGER NOT NULL DEFAULT 0,
  ok         INTEGER NOT NULL DEFAULT 1,
  error      TEXT NOT NULL DEFAULT '',
  tokens_in  INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ailogs_created ON ai_logs(created_at DESC);
