# 同频 Tongpin

> AI 驱动的大学同频社交平台 —— 基于多维画像的兴趣社交 Web 应用

「同频」是一个面向大学校园的兴趣社交平台，核心通过 **AI 多维画像** 对用户进行兴趣建模，并据此实现智能匹配、同频局（兴趣小组）、破冰话题推荐与社群 AI 助手，帮助同学找到"同频"的人。

## ✨ 核心特性

- **AI 多维画像（Persona）**：通过问答与行为分析，构建用户的兴趣画像与维度评分
- **智能匹配引擎**：基于兴趣图谱与画像相似度，推荐"同频"的用户
- **兴趣图谱（Interest Graph）**：可视化展示用户兴趣标签与关联关系
- **同频局（Groups）**：兴趣小组的创建、加入、审批与群聊
- **社群 AI 助手（Assistant）**：基于本地语义向量 RAG 的混合检索问答助手
- **破冰话题推荐**：为匹配成功的用户生成破冰话题
- **实时聊天**：基于 WebSocket 的实时消息
- **内容审核**：AI 驱动的违规内容检测

## 🛠 技术栈

| 层 | 技术 |
|----|------|
| 前端 | Vue 3 + TypeScript + Vite + Pinia |
| 后端 | Node.js (Express) |
| 数据库 | SQLite |
| AI 能力 | 可插拔 Provider（Anthropic / OpenAI 兼容），内置本地语义引擎兜底 |
| 实时通信 | WebSocket（socket.io） |

## 📁 项目结构

```
.
├── server/               # 后端服务（Express + SQLite）
│   └── src/
│       ├── ai/           # AI 引擎（画像、匹配、图谱、助手、RAG、审核）
│       ├── routes/       # REST 路由
│       ├── services/     # 业务服务层
│       ├── db/           # 数据库 schema / seed
│       └── realtime/     # WebSocket 实时通信
├── web/                  # 前端（Vue 3 + Vite + TypeScript）
│   └── src/
│       ├── views/        # 页面视图
│       ├── components/   # 通用组件
│       ├── stores/       # Pinia 状态
│       └── api.ts        # API 封装
├── docs/                 # 设计文档与实现计划
└── screenshots/          # 界面截图
```

## 🚀 快速开始

### 环境要求

- Node.js >= 22.5.0

### 安装与运行

```bash
# 安装依赖
npm install

# 初始化数据库（含演示数据）
npm run seed

# 启动开发环境（同时启动 server 与 web）
npm run dev
```

启动后：
- 前端：`http://localhost:5173`
- 后端：`http://localhost:8787`

### 配置

复制 `.env.example` 为 `.env`，按需配置：

```bash
cp .env.example .env
```

默认运行在内置本地语义引擎上，全部 AI 功能可用。如需切换为大模型驱动，在 `.env` 中取消对应 Provider 的注释并填入自己的 Key（支持 Anthropic Claude 或任意 OpenAI 兼容服务，如 DeepSeek / 通义千问 / 月之暗面 / 智谱 / 本地 Ollama）。

## 📝 常用脚本

| 命令 | 说明 |
|------|------|
| `npm run dev` | 同时启动前后端开发环境 |
| `npm run dev:server` | 仅启动后端 |
| `npm run dev:web` | 仅启动前端 |
| `npm run seed` | 初始化数据库与演示数据 |
| `npm run build` | 构建前端 |
| `npm run test` | 运行后端测试 |
| `npm run typecheck` | 前端类型检查 |

## 📄 文档

- [兴趣图谱设计](./docs/superpowers/specs/2026-10-31-interest-graph-design.md)
- [社群 AI 助手 / RAG 设计](./docs/superpowers/specs/2026-10-31-w2-assistant-rag-design.md)
- [配置说明](./docs/配置说明.md)

## ⚠️ 安全说明

- `.env` 文件已被 `.gitignore` 排除，请勿提交任何真实密钥
- 仓库中仅包含 `.env.example` 模板作为配置参考
