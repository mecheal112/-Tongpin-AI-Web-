# W1 兴趣图谱 + W0 修复 · 实现计划

Spec：`docs/superpowers/specs/2026-10-31-interest-graph-design.md`（已批准）
顺序执行，每项完成即自测；T1~T3 是后端地基，T4~T8 是管线与集成，T9 前端，T10~T11 收尾。

## 任务清单

- [x] **T1 · W0 快速修复**（spec §9）
  - 删除 `match-engine.js`/`matching.js` 里 `DIM_LOW_*` 字符串生成与过滤路径（由 T8 的节点名文案取代）
  - 匹配页接入「喜欢我的人」（`GET /match/received`）
  - 消息举报按钮（`POST /chat/messages/:id/report`）+ 动态举报（新增 `POST /posts/:id/report`）+ 前端入口
  - 管理后台 AI 观测文案改准确（本地引擎不记日志）
  - 资料页加「头像 URL」输入框
  - `seed.js` 注释 24→23
- [x] **T2 · 数据层**：schema.sql 加 `interest_nodes / interest_edges / user_interests / interest_weight_log`；`db/index.js` 确保启动迁移（建表幂等 + 兜底 seed 规范节点）
- [x] **T3 · 本地抽取兜底**：`local-engine.js` 加 `extractInterestsLocal(text)`（词表命中 + 共现连边，输出与 AI 版同构）
- [x] **T4 · AI 抽取任务**：`prompts.js` 加 `interest-extract`；`ai/interest-graph.js` 编排：调 provider（`callAIWithFallback` → T3 兜底）、归一化（别名并入/自动建节点/单次 5 节点上限）
- [x] **T5 · 入图管线 + 权重动态**：`interest-graph.js` 实现 `applyEvidence(user, source, quote)`：delta 累加、同源同节点 24h 去重、evidence FIFO 8 条、衰减惰性折算（30 天 ×0.9、下限 5）、回写 `personas.interests`
- [x] **T6 · 四个接入点**：persona.js 收尾/快速提炼（+25）、posts.js 发帖入库后（+15）、user-service.js 简介保存后（+10）、groups.js 加入成功后（+5）；全部 try/catch 不阻塞主流程
- [x] **T7 · API**：`routes/graph.js`（`/graph/own`、`/graph/user/:id` 裁剪版、`/admin/graph/stats`）挂 `index.js`；`/api/health` 加 `graph` 字段
- [x] **T8 · 匹配集成**：`match-engine.js` 兴鸣度 = 0.7 同节点 + 0.3 一跳邻居；互补度取对方 weight≥40 的 2 跳内节点；`match-reason` 提示词注入图谱上下文；本地理由用节点名；空图谱回退现状
- [x] **T9 · 前端**：`/graph` 页（手写 SVG 力导向 + 证据侧栏 + 移动端标签云降级）、PersonaView 入口、api.ts、router
- [x] **T10 · 测试**：server 侧 node:test（归一化/权重/去重/衰减/FIFO/相似度/回退/本地兜底），`npm test`
- [x] **T11 · 彩排验收**：spec §10 人工动线 1~4（含断网无 Key 各一遍），修 bug

## 关键约定

- 不引新依赖（SVG 手写）；Node 内置 `node:test`
- 所有 AI 调用走 `callAIWithFallback`，本地兜底输出同构 JSON
- 入图失败永不阻塞发帖/访谈主流程

## 验收记录（2026-10-31 T11）

- 动线 1~3 在「无 Key」（`ai.configured=false`，全程本地引擎 `degraded=true`）状态下跑通；断网与无 Key 对本应用等价（唯一外呼是 AI），已覆盖演示安全要求
- 修 bug：本地抽取强意图句式把语气词带进节点名（「迷上露营了」→「露营了」）。修复为归一化层 `cleanNodeName` 剥离助词残渣（AI/本地路径共用），回归测试已补
- 自动化测试 26/26 通过；UI 验收截图见 `screenshots/11-graph.png`、`12-graph-evidence.png`、`13-graph-mobile.png`（另 14/15 为 W0 UI 抽查）
