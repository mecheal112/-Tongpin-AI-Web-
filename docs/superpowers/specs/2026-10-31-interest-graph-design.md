# W1 兴趣图谱（Interest Graph）设计文档

- 日期：2026-10-31
- 状态：已评审通过（口头），待书面确认
- 上下文：「同频」决赛演示版本（约 2026-11-14 前完成）剩余工作包 W1，预估 4~5 天
- 相关工作包：W0 快速修复（与本文档同批实现，见 §9）、W2 社群 AI 助手/RAG（本图谱是其数据地基）、W3 AI 话题/活动策划

---

## 1. 背景与目标

比赛选题「同趣汇」承诺：*AI 自动分析用户发布内容、爱好描述，动态生成个人兴趣图谱*，技术亮点为**知识图谱 + LLM + RAG**。当前代码中「兴趣图谱」只是 `personas.interests` 的 `[{name, weight}]` 平面标签列表（`server/src/db/schema.sql:42`），没有图结构、没有从发帖内容回流、与选题文案名不副实。

**W1 目标**：建立真正的兴趣知识图谱层——

1. 从访谈、自述、发帖内容持续抽取兴趣概念入图，权重随证据动态涨跌；
2. 图谱驱动匹配（相似度计算 + 可读的匹配理由）；
3. 画像页可视化图谱，证据可点击溯源。

**演示故事（30 秒）**：发一条带新兴趣的动态 → 图谱长出新节点/权重上涨 → 次日匹配理由中出现该节点。

**验收场景**：评委断网、无 AI Key 时，图谱仍完整可演示（本地引擎降级路径）。

## 2. 范围

**做**：图谱数据层、抽取入图管线（4 个接入点）、权重动态、图谱可视化页、匹配引擎集成、图谱统计 API、本地降级、单元测试。

**不做（YAGNI）**：图数据库、embedding/向量检索（留给 W2 视富余情况）、全社区大图、节点编辑后台、用户手动增删节点、时间线动画。

## 3. 数据模型

`server/src/db/schema.sql` 新增三张表（现有 `personas.interests` **保留不动**，作为缓存与降级视图；入图后按 §4.5 单向回写保持一致）：

```sql
CREATE TABLE IF NOT EXISTS interest_nodes (
  id          TEXT PRIMARY KEY,          -- nanoid
  name        TEXT NOT NULL UNIQUE,      -- 规范名，如「摄影设计」
  aliases     TEXT NOT NULL DEFAULT '[]',-- 别名 JSON，如 ["摄影","拍照"]
  category    TEXT NOT NULL,             -- 14 类之一（沿用 local-engine 词表分类）
  parent_id   TEXT REFERENCES interest_nodes(id),  -- 层级（可空）
  status      TEXT NOT NULL DEFAULT 'auto',        -- auto | confirmed
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS interest_edges (
  from_node   TEXT NOT NULL REFERENCES interest_nodes(id),
  to_node     TEXT NOT NULL REFERENCES interest_nodes(id),
  type        TEXT NOT NULL,             -- sub_of | related | co_occurs
  weight      REAL NOT NULL DEFAULT 1,
  PRIMARY KEY (from_node, to_node, type)
);

CREATE TABLE IF NOT EXISTS user_interests (
  user_id     TEXT NOT NULL REFERENCES users(id),
  node_id     TEXT NOT NULL REFERENCES interest_nodes(id),
  weight      REAL NOT NULL DEFAULT 0,   -- 0-100
  evidence    TEXT NOT NULL DEFAULT '[]',-- 最多 8 条，FIFO 淘汰
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, node_id)
);

CREATE TABLE IF NOT EXISTS interest_weight_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  node_id     TEXT NOT NULL,
  delta       REAL NOT NULL,
  reason      TEXT NOT NULL,             -- interview | post | profile | group | decay
  created_at  TEXT NOT NULL
);
```

**evidence 条目结构**：`{source_type: interview|post|profile|group, source_id, quote, at}`。`quote` 为贡献证据的原文片段（访谈答案 / 动态正文截断 80 字）。

## 4. 抽取与入图管线

### 4.1 AI 任务 `interest-extract`

- 在 `server/src/ai/prompts.js` 新增任务提示词；输入 = 文本 + 当前节点目录（名称+别名，限 200 条）；输出 JSON：

```json
[{
  "node": "摄影设计",        // 优先匹配目录内规范名
  "create": false,            // 目录没有时 true，同时给 suggest_name
  "suggest_name": "",
  "relation": "related",      // sub_of | related | co_occurs，用于与文本中同时出现的其他节点连边
  "delta": 15,
  "quote": "周末背着相机去扫街"
}]
```

- 走 `server/src/ai/provider.js` 现有 `callAIWithFallback` 链路，全量记 `ai_logs`（沿用现有任务日志）。

### 4.2 本地兜底（`server/src/ai/local-engine.js` 扩展）

- 14 类兴趣词表命中 → 对应节点（含别名匹配）；文本内共现的节点两两连 `co_occurs` 边；
- 无 Key / 超时 / 解析失败时启用，产出格式与 AI 版一致（`quote` 取命中句）。

### 4.3 归一化与节点治理

- 同义词归一：AI 返回目录外名称且别名表能命中已有节点时，并入该节点（别名追加）；
- `create: true` 时自动建节点（`status='auto'`），名字取 `suggest_name`；仅进 `interest_nodes`，不做人工审核（admin 只看统计）；
- 防节点爆炸：单次抽取上限 5 个节点；全局节点数超 300 后，提示词目录只送 top 频 300。

### 4.4 四个接入点（含权重规则）

| 接入点 | 触发时机 | delta | 说明 |
|---|---|---|---|
| 访谈 | `persona.js` 完成收尾 / 快速提炼成功 | +25 | `source_type=interview`，quote=关键答案 |
| 发帖 | 帖子通过审核入库后（`posts.js`） | +15 | `source_type=post`，**打通「标签只属于帖子不属于人」的断层** |
| 资料 | 修改简介保存成功后（`user-service.js`） | +10 | `source_type=profile` |
| 入组 | 加入同频局成功后（`groups.js`） | +5 | `source_type=group`，弱信号 |

- **涨跌**：实际 delta = 接入点基准 ×（抽取强度 / 15），clamp 到 [3, 1.5×基准]（抽取强度即 §4.1 的 `delta` 字段 0-30，缺省 15）；同源同节点 24h 内只计一次；**衰减**：每连续 30 天无新证据 weight ×0.9（惰性计算：读写该用户图谱时按 `updated_at` 折算，不跑定时任务），下限 5，记 `reason=decay` 的 weight_log；
- weight 上限 100；`user_interests.evidence` 每 (user, node) 最多 8 条 FIFO。

### 4.5 同步策略

入图成功后，重算该用户 `personas.interests`（取 weight top 的节点，name=规范名），保持两处一致；单节点失败不影响帖子/访谈主流程（try/catch + 日志）。

## 5. 可视化

- 新页面 `/graph`（登录可见），画像页（`PersonaView.vue`）加「查看兴趣图谱」入口；
- 手写 SVG 力导向图（约 150 行，**不引第三方依赖**）：
  - 节点大小 = weight，颜色 = category（14 类调色沿用现有标签色系）；
  - 边：`sub_of` 实线、`related` 虚线、`co_occurs` 细线；
  - 点击节点 → 侧栏证据面板（evidence 列表：来源类型 + quote + 时间，post 可点击跳转 `/post/:id`）；
  - 屏幕 < 768px 时降级为按 category 分组的标签云列表（不做移动端力导向图）。
- stretch（时间富余才做）：互选两人「图谱对照」小视图（交集高亮、互补侧列）。

## 6. 匹配集成（`server/src/ai/match-engine.js`）

- **共鸣度兴趣项**：由平面加权重合改为图谱感知——
  `interest_sim = 0.7 × 同节点加权重合 + 0.3 × 一跳邻居折半重合`；
- **互补度**：对方图谱中、我方 2 跳内可达的节点（**对方** `user_interests.weight` ≥ 40）为「能带给你新东西」来源；**文案直接用节点规范名**（顺带根治 `DIM_LOW_*` 占位符泄漏，W0 一并删除该字符串生成路径）；
- **理由生成**：`match-reason` 提示词注入图谱上下文（双方 top 节点、交集节点、互补节点、桥路径如「摄影设计 → 露营」），本地兜底理由同样改用节点名拼装；
- 未入图用户（图谱为空）自动回退现有平面算法，结果不劣于现状。

## 7. API

| 端点 | 权限 | 说明 |
|---|---|---|
| `GET /api/graph/own` | 登录 | 自己完整图谱：nodes + edges + evidence |
| `GET /api/graph/user/:id` | 登录 | 他人公开裁剪版：top 10 节点，无 evidence 明细 |
| `GET /api/admin/graph/stats` | admin | 节点/边/入图用户数、覆盖率、top 节点、7 日新增 |

路由文件 `server/src/routes/graph.js`，挂载于 `server/src/index.js`。

## 8. 降级与演示安全

- 全链路（抽取、归一、理由）保留本地引擎降级，`AI_FALLBACK=true` 语义沿用；
- 演示彩排按「断网 + 无 Key」标准各跑一遍，图谱页与匹配理由必须完整可读；
- `GET /api/health` 增加 `graph` 字段（节点数、入图用户数）便于现场自检。

## 9. 与 W0 快速修复同批实现（0.5 天，穿插在 W1 首日）

1. `DIM_LOW_*` 文案泄漏（由 §6 取代其生成源，删除旧字符串路径）；
2. 「喜欢我的人」列表接入前端（`GET /match/received`，匹配页加一个入口区块）；
3. 举报入口：消息长按/菜单加举报按钮（接 `POST /chat/messages/:id/report`）；动态卡加举报（补一个轻量 `POST /posts/:id/report`，复用 reports 表）；
4. 管理后台 AI 观测文案纠偏（本地引擎调用不记日志——要么补记，要么改文案，选**改文案**，成本低）；
5. 头像：资料页加「头像 URL」输入框（接现有 `updateProfile.avatar` 字段，不做上传）；
6. `seed.js` 注释「24 位」改「23 位」。

## 10. 测试与验收标准

**自动化**（`server` 侧新增 `npm test`，用 node:test）：

- 归一化：别名并入、自动建节点、单次 5 节点上限；
- 权重：delta 累加、同源 24h 去重、衰减折算、上下限、evidence FIFO；
- 匹配：图谱相似度 > 平面相似度的构造用例、空图谱回退不报错；
- 本地兜底：无 Key 时 extract 输出格式合法。

**人工验收（演示动线）**：

1. 新注册账号走访谈 → `/graph` 出现访谈产生的节点，点击可见访谈证据；
2. 发一条「最近迷上露营」的动态 → 图谱新增/增强「露营」类节点，证据=该动态；
3. 次日匹配理由（或刷新推荐）中出现该节点相关表述；
4. 断网无 Key 重跑 1~3，全部可用。

## 11. 风险与对策

| 风险 | 对策 |
|---|---|
| LLM 抽取输出不合规 | 强制 JSON + `extractJson` 容错 + 本地兜底，单点失败不阻塞主流程 |
| 节点爆炸/命名混乱 | 目录优先匹配、5 节点/次上限、300 目录截断、别名归一 |
| 演示现场网络/Key 问题 | 双路径验收（§8）、health 自检字段 |
| 时间超支 | stretch 项（图谱对照）最先砍；可视化移动端降级已内置 |

## 12. 里程碑

| 天 | 产出 |
|---|---|
| D1 | W0 修复 + schema 迁移 + 入图管线（本地兜底先行） |
| D2 | AI 抽取任务 + 4 个接入点打通 + 权重动态 |
| D3 | `/graph` 可视化 + 证据面板 |
| D4 | 匹配集成 + 理由提示词 + 测试补齐 |
| D5 | 无 Key 断网彩排 + 修复 + 人工验收 1~4 |
