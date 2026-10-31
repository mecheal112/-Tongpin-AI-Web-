# W2 社群 AI 助手 / RAG · 实现计划

Spec：`docs/superpowers/specs/2026-10-31-w2-assistant-rag-design.md`（已批准）
顺序执行，每项完成即自测；T1~T3 是索引地基，T4~T6 是管线与 API，T7 前端，T8~T9 收尾。

## 任务清单

- [ ] **T1 · 数据层**（spec §3）：schema.sql 加 `post_vectors`（post_id PK / embedding / kind / model / updated_at）与 `assistant_sessions`（id / user_id / messages / created_at / updated_at）；`db/index.js` 启动迁移幂等建表
- [ ] **T2 · 向量化双路**（spec §4.1）：新增 `ai/embedding.js`，统一接口 `embedTexts(texts) → number[][]`——有 Key 走 OpenAI 兼容 `/embeddings`（批量 16 条、记 ai_logs）；无 Key 用 TF-IDF（扩展 `local-engine.vectorize`：词表 hash 到 256 维 + L2 归一）；kind 不匹配整体切 TF-IDF 路径，两空间不混比
- [ ] **T3 · 索引管线**（spec §3）：发帖入库后随标签任务顺带向量化入 `post_vectors`；存量帖惰性补索引（检索时发现无向量现算现用，try/catch 不阻塞）
- [ ] **T4 · 检索管线**（spec §4.2~4.3）：问句向量 cosine 召回 top-20 → 混合重排 `0.6×向量 + 0.25×tag Jaccard + 0.15×关键词命中` → top 6~8；图谱 `getGraphContext` top5 节点+别名作软扩展词（只进重排关键词集）；全 0 分走空结果
- [ ] **T5 · 生成任务**（spec §4.4）：`prompts.js` 加 `assistant-answer`（问句+近 6 轮+编号片段 → `{answer, citations}` JSON）；citations post_id 白名单校验（越界丢弃）+ 答案过 moderation 本地词表；无 Key 模板兜底（摘要列表 + 引用照常），输出 `degraded` 标记
- [ ] **T6 · 会话编排 + API**（spec §4.5、§5）：`ai/assistant.js` 编排 ask 主流程（扩展→召回→重排→生成→组装 sources），永不抛错；`routes/assistant.js` 三个端点 `POST /ask`、`GET /history`、`POST /reset`（单活跃会话、messages FIFO 20、reset 换新会话行），挂 `index.js`
- [ ] **T7 · 前端**（spec §6）：`/assistant` 页（消息流气泡、`[n]` 锚标点击定位引用卡片、引用卡片「查看原帖 →」跳 `/post/:id`、快捷 chips、空态/loading/错误 toast）、`api.ts` 三接口、router、侧边栏「社群助手」入口（排「社区」下方）
- [ ] **T8 · 测试**（spec §8）：`server/test/assistant.test.js` node:test 独立临时库——语义召回（「户外过夜」→「露营」帖）、tag 重排、0 命中不崩、TF-IDF 输出形状、kind 不匹配切路径、引用防幻觉、无 Key 兜底格式、会话 FIFO/reset；`npm test` 全绿
- [ ] **T9 · 彩排验收**（spec §8）：人工动线 1~4（含断网无 Key 各一遍），修 bug

## 关键约定

- 不引新依赖：TF-IDF 手写、向量 JSON 存 TEXT、SVG/前端复用现有样式
- 所有 AI 调用走 `callAIWithFallback`，无 Key / 断网全链路可演示（TF-IDF + 模板兜底同构）
- 失败永不阻塞、接口永不 500（try/catch + 日志 + `degraded` 标记）
- 两向量空间不混比：检索时 `post_vectors.kind` 与当前可用向量器一致才比 cosine，否则整体切 TF-IDF
- citations 的 `post_id` 必须在本次检索结果内，越界丢弃（防幻觉溯源）
- 个性化只影响措辞与排序，不编造事实
