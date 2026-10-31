import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, ensureDataDir } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let db;

export function getDb() {
  if (db) return db;
  ensureDataDir();
  db = new DatabaseSync(config.dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

export function migrate() {
  const d = getDb();
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  d.exec(sql);
  ensureColumns(d);
  return d;
}

/**
 * schema.sql 里全是 CREATE TABLE IF NOT EXISTS —— 建新表没问题，
 * 但给已经存在的表补列时不会生效（表已存在就整段跳过）。
 * 所以新增列要在这里单独 ALTER 一次，否则老库上查询会报 no such column。
 */
function ensureColumns(d) {
  const addIfMissing = (table, column, ddl) => {
    const cols = d.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some((c) => c.name === column)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  };
  addIfMissing('group_members', 'last_read_at', 'last_read_at INTEGER');
}

/* ---------------- 查询辅助 ---------------- */

export const all = (sql, ...params) => getDb().prepare(sql).all(...params);
export const get = (sql, ...params) => getDb().prepare(sql).get(...params);
export const run = (sql, ...params) => getDb().prepare(sql).run(...params);

/** 事务包装。node:sqlite 无内建事务助手，手动 BEGIN/COMMIT。 */
export function tx(fn) {
  const d = getDb();
  d.exec('BEGIN');
  try {
    const out = fn(d);
    d.exec('COMMIT');
    return out;
  } catch (err) {
    try {
      d.exec('ROLLBACK');
    } catch {
      /* 回滚失败时保留原始错误 */
    }
    throw err;
  }
}

/* ---------------- JSON 字段辅助 ---------------- */

export function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export const toJson = (v) => JSON.stringify(v ?? null);
