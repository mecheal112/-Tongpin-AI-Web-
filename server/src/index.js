import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';
import cookieParser from 'cookie-parser';

import { config, isProd, aiConfigured } from './config.js';
import { migrate } from './db/index.js';
import { attachUser, errorHandler } from './middleware/auth.js';
import { initRealtime } from './realtime/index.js';
import { aiStatus } from './ai/provider.js';
import { graphStats } from './ai/interest-graph.js';

import { router as authRouter } from './routes/auth.js';
import { router as personaRouter } from './routes/persona.js';
import { router as matchRouter } from './routes/match.js';
import { router as chatRouter } from './routes/chat.js';
import { router as postsRouter } from './routes/posts.js';
import { router as groupsRouter } from './routes/groups.js';
import { router as notifRouter } from './routes/notifications.js';
import { router as adminRouter } from './routes/admin.js';
import { router as graphRouter } from './routes/graph.js';

const app = express();
const server = http.createServer(app);

app.set('trust proxy', 1);
app.use(
  helmet({
    contentSecurityPolicy: false, // 前端为独立构建产物，内联样式较多，这里不启用严格 CSP
    crossOriginEmbedderPolicy: false,
  }),
);
app.use(compression());
app.use(cors({ origin: config.corsOrigin, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
if (!isProd) app.use(morgan('dev'));

app.use(attachUser);

/* ---------------- API ---------------- */

app.get('/api/health', (_req, res) => {
  let graph = { nodes: 0, users_in_graph: 0 };
  try {
    const s = graphStats();
    graph = { nodes: s.nodes, users_in_graph: s.users_in_graph };
  } catch {
    /* 图谱未初始化不影响健康检查 */
  }
  res.json({
    ok: true,
    service: '同频 Tongpin',
    env: config.env,
    uptime: Math.round(process.uptime()),
    ai: aiStatus(),
    graph,
    time: Date.now(),
  });
});

app.use('/api/auth', authRouter);
app.use('/api/persona', personaRouter);
app.use('/api/match', matchRouter);
app.use('/api/chat', chatRouter);
app.use('/api/posts', postsRouter);
app.use('/api/groups', groupsRouter);
app.use('/api/notifications', notifRouter);
app.use('/api/admin', adminRouter);
app.use('/api/graph', graphRouter);

/* ---------------- 静态前端（生产） ---------------- */

const webDist = path.join(config.rootDir, 'web', 'dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist, { maxAge: isProd ? '7d' : 0, index: false }));

  // SPA 回退：非 /api 与 /socket.io 的路径统一交给前端路由
  app.get(/^\/(?!api\/|socket\.io\/).*/, (_req, res) => {
    res.sendFile(path.join(webDist, 'index.html'));
  });
  console.log(`[同频] 已挂载前端构建产物: ${webDist}`);
}

/* ---------------- 兜底 ---------------- */

app.use('/api', (_req, res) => {
  res.status(404).json({ ok: false, error: '接口不存在' });
});

app.use(errorHandler);

/* ---------------- 启动 ---------------- */

migrate();
initRealtime(server, { corsOrigin: config.corsOrigin });

server.listen(config.port, () => {
  const ai = aiStatus();
  console.log('');
  console.log('  ┌─────────────────────────────────────────────┐');
  console.log('  │   同频 Tongpin — AI 驱动的大学同频社交平台   │');
  console.log('  └─────────────────────────────────────────────┘');
  console.log(`  服务地址   http://localhost:${config.port}`);
  console.log(`  运行环境   ${config.env}`);
  console.log(`  数据库     ${config.dbPath}`);
  console.log(`  AI 引擎    ${ai.configured ? `${ai.provider} / ${ai.model}` : '本地语义引擎（未配置模型 API）'}`);
  if (!ai.configured) {
    console.log('             配置 .env 中的 AI_PROVIDER 与 API Key 可切换为大模型驱动');
  }
  if (!fs.existsSync(webDist)) {
    console.log('  前端      未构建，开发模式请另开终端运行 npm run dev:web');
  }
  console.log('');
});

const shutdown = () => {
  console.log('\n[同频] 正在关闭服务...');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export { app, server };
