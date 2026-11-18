# W2 社群 AI 助手 / RAG 设计文档

- 日期：2026-10-31
- 状态：设计已分段评审通过，待书面确认
- 上下文：「同频」决赛演示版本（约 2026-11-14 前完成）工作包 W2，预估 3.5 天
- 相关工作包：W1 兴趣图谱（已落地，本文档用其 `getGraphContext` 做个性化）、W3 AI 话题/活动策划（W2 完成后启动，工期视余量）

---

## 1. 背景与目标

选题「同趣汇」技术承诺为**知识图谱 + LLM + RAG**。W1 已落地知识图谱层；本工作包补上 RAG：**社群问答助手**——用户用自然语言提问（「最近有什么露营相关的分享？」），系统检索社区动态并生成带引用溯源的回答，点引用直达原帖。

**演示故事（30 秒）**：问一句话 → 答案引用真实帖子 `[1][2]` → 点引用卡片跳进原帖 → 追问「第一条详细说说」多轮接住。

**验收场景**：评委断网、无 AI Key 时，问答链路仍完整可演示（TF-IDF 向量 + 模板作答降级）。

**已拍板的决策**：

| 决策点 | 结论 |
|---|---|
| 助手形态 | 社群问答助手（非群聊助手、非内容发现流） |
| 检索语料 | **仅社区动态**（正文/topics/ai_tags）；同频局、群聊、图谱不进语料 |
| 交互形态 | 多轮对话页 `/assistant`，侧边栏入口 |
| 架构 | 方案 C：混合向量 RAG + 图谱个性化（「知识图谱 + LLM + RAG」三件套闭环） |
| 工期 | 3.5 天（W3 视余量缩水） |

图谱在本包中的角色：**个性化上下文**（问句扩展 + 措辞贴人），不作检索语料——与 W1 spec「本图谱是 W2 数据地基」的叙述在此意义上兑现。

## 2. 范围

**做**：向量索引层（embedding/TF-IDF 双路）、检索管线（召回+混合重排）、`assistant-answer` 生成任务、多轮会话、`/assistant` 对话页、图谱个性化、无 Key 全链路降级、单元测试。

**不做（YAGNI）**：群聊/图谱/同频局语料检索、流式输出、会话列表管理、语音/图片提问、答案评分反馈、W3 话题/活动策划联动。

## 3. 数据模型

`server/src/db/schema.sql` 新增两张表（沿用现有 JSON-on-TEXT 风格）：

```sql
CREATE TABLE IF NOT EXISTS post_vectors (
  post_id     TEXT PRIMARY KEY REFERENCES posts(id),
  embedding   TEXT NOT NULL,              -- JSON 数组
  kind        TEXT NOT NULL,              -- 'embedding' | 'tfidf'
  model       TEXT NOT NULL,              -- 'text-embedding-3-small' | 'tfidf-v1'
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assistant_sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  messages    TEXT NOT NULL DEFAULT '[]', -- FIFO 20 条：{role, content, citations, ts}
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
```

**索引时机**：发帖入库后随现有标签任务顺带向量化；存量帖**惰性补索引**（查询时发现无向量现算现用），不设单独补索引脚本。

## 4. 检索与生成管线

### 4.1 向量化（`server/src/ai/embedding.js` 新增）

- **有 Key**：调 OpenAI 兼容 `/embeddings`（默认 `text-embedding-3-small`，1536 维），批量 16 条/次，全量记 `ai_logs`；
- **无 Key**：TF-IDF 向量（词表 hash 到固定 256 维 + L2 归一，复用并扩展 `local-engine.vectorize`），**查询时对最近 1000 帖现算**（语料即 IDF，不落库），输出与 embedding 同构；
- 统一接口 `embedTexts(texts) → number[][]`。两种向量**不跨空间比较**：`post_vectors.kind` 标明来源，检索时 kind 不匹配则整体切 TF-IDF 路径。

### 4.2 查询扩展与个性化（复用 W1 `getGraphContext`）

1. 取提问者图谱 top5 节点的名称+别名作为软扩展词，追加进**重排关键词集**（不进向量文本，避免污染语义）；
2. 生成提示词注入「提问者兴趣」（如「你图谱里的『摄影设计』权重 38」），**只影响措辞与举例排序，不编造事实**。

### 4.3 召回 + 混合重排

```
score = 0.6 × cos(问句, 帖子) + 0.25 × tag_overlap + 0.15 × keyword_hit
```

- `tag_overlap`：问句扩展词与 `ai_tags`/`topics` 的 Jaccard；
- `keyword_hit`：问句关键词（含图谱扩展词）在正文命中的归一化比例；
- 取 top 6~8 条；全部命中 0 分时走「没找到」路径（不硬凑答案）。

### 4.4 生成任务 `assistant-answer`（`prompts.js` 扩展）

- 输入：问句 + 近 6 轮对话 + 编号检索片段（每条：post_id/作者/时间/正文截断 200 字）；
- 输出 JSON：`{answer: string, citations: [{post_id, quote}]}`；答案中用 `[1][2]` 标注出处，**只允许引用给定片段**；
- 防幻觉校验：`citations.post_id` 不在检索结果内则丢弃该条引用；答案文本过一遍 `moderation` 本地词表；
- 走 `callAIWithFallback` 链路，全量记 `ai_logs`。

### 4.5 多轮会话

- `assistant_sessions.messages` 每用户单活跃会话（沿用 `persona_sessions` 模式），FIFO 20 条；
- 送 LLM 只取近 6 轮；追问「第一条详细说说」依赖 `[n]` 编号与最近引用列表在上下文中；
- `reset` 即换新会话行（schema 不加 status 字段）；旧会话行保留但不再读取，`history` 永远取最新会话。

## 5. API

| 端点 | 权限 | 说明 |
|---|---|---|
| `POST /api/assistant/ask` | 登录 | `{question, session_id?}` → 自动建/续会话，返回 `{session_id, answer, citations, sources, degraded}`；`sources` 条目 = `{post_id, author, excerpt(40字), ts}` |
| `GET /api/assistant/history` | 登录 | 当前活跃会话的 messages |
| `POST /api/assistant/reset` | 登录 | 归档当前会话，重开一个 |

路由文件 `server/src/routes/assistant.js`，挂载于 `server/src/index.js`。

## 6. 前端 `/assistant`（`web/src/views/AssistantView.vue` 新增）

- 消息流：用户/AI 气泡；AI 答案里的 `[n]` 渲染为可点锚标，滚动定位到对应引用卡片；
- 引用卡片：帖子摘要 40 字 + 作者 + 时间 + 「查看原帖 →」（`/post/:id`）；
- 顶部快捷提问 chips：「最近大家在聊什么」「有什么露营相关的分享」「有什么摄影活动」；
- 入口：侧边栏加「社群助手」（排在「社区」下方）；空态 / loading（「正在翻阅社区动态…」）/ 错误 toast，复用现有组件样式。

## 7. 降级与演示安全

| 故障 | 行为 |
|---|---|
| 无 Key / 断网 | 检索切 TF-IDF + 模板作答（「根据社区动态，找到 N 条相关内容：」+ 摘要 + 引用卡片照常），`degraded: true` |
| LLM 超时/解析失败 | 同上模板兜底 |
| 向量空间不匹配 | 整体检索切 TF-IDF 路径 |
| 检索 0 命中 | 直说「没找到相关内容」+ 建议换问法 |
| 会话写入失败 | 照常返回答案，仅丢历史（try/catch + 日志） |

全链路永不 500、永不阻塞主流程。演示彩排按「断网 + 无 Key」标准跑一遍验收动线。

## 8. 测试与验收标准

**自动化**（`server/test/assistant.test.js`，node:test，独立临时库）：

- 检索：同义表述（「户外过夜」→「露营」帖）语义召回、tag 重排生效、0 命中不崩；
- 向量：TF-IDF 输出形状合法、kind 不匹配整体切路径；
- 引用防幻觉：citations 超出检索集被丢弃；
- 兜底：无 Key 输出格式合法、`degraded: true`、引用 post_id 真实存在；
- 会话：FIFO 20 条截断、reset 归档重开。

**人工验收（演示动线）**：

1. 发 2~3 条不同主题帖（含「露营」）→ `/assistant` 问「最近有什么露营相关的分享」→ 答案带 `[n]` 引用，卡片可点跳原帖；
2. 追问「第一条详细说说」→ 多轮上下文正确接住；
3. 断网无 Key 重跑 1~2 → TF-IDF + 模板兜底，答案完整可读；
4. 换兴趣不同的账号问同一问题 → 答案措辞/排序有个人化差异。

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| embedding API 不稳定/不可用 | TF-IDF 同构接口整体兜底，切换对上层无感 |
| LLM 引用幻觉 | citations post_id 白名单校验 + 提示词限定只基于给定片段 |
| 答案内容不当 | 生成文本过 `moderation` 本地词表，命中则降级模板 |
| 检索质量差（语料少/标签弱） | 混合重排三路信号互补；演示前预埋 2~3 条高质量种子帖 |
| 时间超支 | 图谱个性化最先砍（退回纯 RAG）；快捷 chips、锚标定位属 UI 细节可简化 |

## 10. 里程碑

| 天 | 产出 |
|---|---|
| D1 | 两张新表 + `embedding.js` 双路向量 + 检索管线（召回+重排）+ 惰性补索引 |
| D2 | `assistant-answer` 任务 + 会话编排 + 无 Key 模板兜底 + `routes/assistant.js` |
| D3 | `/assistant` 前端 + 图谱个性化 + 引用卡片 + 侧边栏入口 |
| D3.5 | 测试补齐 + 断网彩排 + 验收动线 1~4 + 修 bug |
