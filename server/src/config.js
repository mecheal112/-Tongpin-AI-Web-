import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// server/src/config.js -> 上溯两级即项目根目录
export const ROOT_DIR = path.resolve(__dirname, '..', '..');

dotenv.config({ path: path.join(ROOT_DIR, '.env') });

const int = (v, d) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : d;
};
const bool = (v, d) => {
  if (v === undefined || v === '') return d;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
};

const dbPath = process.env.DB_PATH || 'data/tongpin.db';

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: int(process.env.PORT, 8787),
  rootDir: ROOT_DIR,

  jwtSecret: process.env.JWT_SECRET || 'tongpin-dev-secret-change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',

  dbPath: path.isAbsolute(dbPath) ? dbPath : path.join(ROOT_DIR, dbPath),

  corsOrigin: (process.env.CORS_ORIGIN || 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  ai: {
    // 未配置时使用本地引擎，功能不降级为"不可用"，只是从大模型驱动变为本地算法驱动
    provider: (process.env.AI_PROVIDER || '').trim().toLowerCase() || 'local',
    anthropicKey: process.env.ANTHROPIC_API_KEY || '',
    anthropicBase: (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, ''),
    openaiKey: process.env.OPENAI_API_KEY || '',
    openaiBase: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    model: process.env.AI_MODEL || '',
    modelFast: process.env.AI_MODEL_FAST || '',
    timeoutMs: int(process.env.AI_TIMEOUT_MS, 45000),
    fallback: bool(process.env.AI_FALLBACK, true),
  },

  seedDemo: bool(process.env.SEED_DEMO, true),
};

export const isProd = config.env === 'production';

/** 该 provider 是否真正具备远端调用能力 */
export function aiConfigured() {
  const p = config.ai.provider;
  if (p === 'anthropic') return Boolean(config.ai.anthropicKey);
  if (p === 'openai') return Boolean(config.ai.openaiKey);
  return false;
}

export const DEMO_PASSWORD = 'Tongpin@2026';

/** 默认模型名 */
export const DEFAULT_MODELS = {
  anthropic: { main: 'claude-sonnet-5', fast: 'claude-haiku-4-5-20251001' },
  openai: { main: 'gpt-4o-mini', fast: 'gpt-4o-mini' },
};

export function ensureDataDir() {
  const dir = path.dirname(config.dbPath);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
