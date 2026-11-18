/**
 * 社群助手问答（W2）测试（走独立临时库）。
 *
 * spec：检索召回 → 混合重排 → 生成（无 Key 模板兜底）→ 会话 FIFO。
 * AI 固定走本地引擎（AI_PROVIDER=local、双 Key 置空），
 * 向量固定走 TF-IDF 路径（embeddingConfigured() 为 false），保证确定性。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDb = path.join(os.tmpdir(), `tongpin-test-assistant-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
process.env.AI_PROVIDER = 'local';
process.env.ANTHROPIC_API_KEY = '';
process.env.OPENAI_API_KEY = '';

const { migrate, run, get, all, parseJson } = await import('../src/db/index.js');
const assistant = await import('../src/ai/assistant.js');

function makeUser(id) {
  const ts = Date.now();
  run(
    'INSERT INTO users (id,email,password_hash,nickname,created_at,last_active_at) VALUES (?,?,?,?,?,?)',
    id, `${id}@test.dev`, 'x', `测试-${id}`, ts, ts,
  );
  run('INSERT INTO personas (user_id,vector,updated_at) VALUES (?,?,?)', id, '[50,50,50,50,50,50]', ts);
}

function makePost(authorId, content, topics = [], tags = [], createdAt = Date.now()) {
  run(
    `INSERT INTO posts (id,author_id,content,topics,mod_status,ai_tags,created_at)
     VALUES (?,?,?,?,?,?,?)`,
    `po_${authorId}_${Math.random().toString(36).slice(2, 10)}`, authorId, content,
    JSON.stringify(topics), 'ok', JSON.stringify(tags), createdAt,
  );
}

before(() => {
  migrate();
  makeUser('u_ask');
  makeUser('u_other');
});

after(() => {
  try {
    fs.rmSync(tmpDb, { force: true });
    fs.rmSync(`${tmpDb}-wal`, { force: true });
    fs.rmSync(`${tmpDb}-shm`, { force: true });
  } catch {
    /* 清理失败不影响测试结果 */
  }
});

test('空库提问返回空态文案，不抛错', async () => {
  const r = await assistant.ask('u_ask', '最近有什么活动？');
  assert.equal(r.ok, true);
  assert.match(r.answer, /暂时没有找到相关内容/);
  assert.equal(r.citations.length, 0);
  assert.equal(r.hits, 0);
});

test('命中相关帖子：答案带出处，引用 post_id 都在来源集合内', async () => {
  makePost('u_other', '今晚操场夜跑，缺一个配速差不多的搭子', ['运动健身'], ['跑步']);
  makePost('u_other', '下周三期中考，求高数复习资料', ['学习搭子'], ['高数']);
  makePost('u_other', '摄影社团周末外拍，欢迎新人', ['兴趣同好'], ['摄影']);

  const r = await assistant.ask('u_ask', '有人一起跑步吗');
  assert.equal(r.ok, true);
  assert.ok(r.hits >= 1, '应至少命中一条帖子');
  assert.match(r.answer, /找到 \d+ 条相关内容/);

  const ids = new Set(r.sources.map((s) => s.post_id));
  assert.ok(ids.size >= 1);
  for (const c of r.citations) assert.ok(ids.has(c.post_id), '引用必须落在来源集合内');

  // 标签命中（跑步）应让「夜跑」帖排最前
  assert.match(r.sources[0].excerpt, /夜跑|配速/, '相关帖子应排第一');
});

test('会话持久化：history 返回一问一答', async () => {
  const r = await assistant.ask('u_ask', '高数复习有什么建议？');
  assert.ok(r.session_id);
  const msgs = assistant.history('u_ask');
  assert.ok(msgs.length >= 2);
  assert.equal(msgs[0].role, 'user');
  assert.equal(msgs[msgs.length - 1].role, 'assistant');
});

test('单活跃会话 FIFO：超过 20 条只保留最近 20 条', async () => {
  for (let i = 0; i < 12; i += 1) await assistant.ask('u_ask', `问题${i} 最近有什么活动`);
  const msgs = assistant.history('u_ask');
  assert.ok(msgs.length <= 20, `期望 ≤20，实际 ${msgs.length}`);
  assert.equal(msgs.length, 20, '超过上限应正好截断到 20');
});

test('reset 重开新会话：history 回到空', async () => {
  await assistant.ask('u_ask', '随便聊聊');
  assistant.reset('u_ask');
  const msgs = assistant.history('u_ask');
  assert.equal(msgs.length, 0);
});

test('空问题返回错误', async () => {
  const r = await assistant.ask('u_ask', '   ');
  assert.equal(r.ok, false);
  assert.match(r.error, /问题不能为空/);
});

test('retrieve 不把不同向量空间混比：无 Key 走 TF-IDF', () => {
  // 无 Key 时不产生任何 embedding 向量行
  const c = get("SELECT COUNT(*) AS c FROM post_vectors WHERE kind = 'embedding'");
  assert.equal(c.c, 0);
});
