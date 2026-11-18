/**
 * 兴趣图谱管线测试（走独立临时库）。
 *
 * spec §9：归一化、权重 delta、同源 24h 去重、衰减、evidence FIFO、回写画像。
 * AI 固定走本地引擎（AI_PROVIDER=local），保证用例确定性。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 环境必须在导入业务模块前设置：ESM 导入会提升，config 在首次导入时读 env
const tmpDb = path.join(os.tmpdir(), `tongpin-test-graph-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
process.env.AI_PROVIDER = 'local';
process.env.ANTHROPIC_API_KEY = '';
process.env.OPENAI_API_KEY = '';

const { migrate, run, get, all, parseJson, toJson } = await import('../src/db/index.js');
const ig = await import('../src/ai/interest-graph.js');

const DAY = 24 * 60 * 60 * 1000;

function makeUser(id) {
  const ts = Date.now();
  run(
    'INSERT INTO users (id,email,password_hash,nickname,created_at,last_active_at) VALUES (?,?,?,?,?,?)',
    id, `${id}@test.dev`, 'x', `测试-${id}`, ts, ts,
  );
  run('INSERT INTO personas (user_id,vector,updated_at) VALUES (?,?,?)', id, '[50,50,50,50,50,50]', ts);
}

/** 把该用户所有证据的时间戳拨回 N 毫秒前（用于过期去重/衰减） */
function ageEvidence(userId, msAgo) {
  const rows = all('SELECT node_id, evidence FROM user_interests WHERE user_id = ?', userId);
  for (const r of rows) {
    const ev = parseJson(r.evidence, []).map((e) => ({ ...e, at: Date.now() - msAgo }));
    run('UPDATE user_interests SET evidence = ? WHERE user_id = ? AND node_id = ?', toJson(ev), userId, r.node_id);
  }
}

before(() => {
  migrate();
  makeUser('u_main');
  makeUser('u_alias');
  makeUser('u_decay');
  makeUser('u_fifo');
});

after(() => {
  try {
    fs.rmSync(tmpDb, { force: true });
    fs.rmSync(`${tmpDb}-wal`, { force: true });
    fs.rmSync(`${tmpDb}-shm`, { force: true });
  } catch {
    /* 临时库清理失败不影响测试结果 */
  }
});

test('ensureSeeded 幂等地种入 14 类规范节点', () => {
  ig.ensureSeeded();
  ig.ensureSeeded();
  const c = get("SELECT COUNT(*) AS c FROM interest_nodes WHERE status = 'confirmed'")?.c;
  assert.equal(c, 14);
});

test('四个接入点按基准 delta 累加权重，流水可溯源', async () => {
  // 「我喜欢编程」只命中 1 个词 → 抽取强度 18
  // effectiveDelta = base × 18/15，clamp [3, 1.5×base]：interview 30 / post 18 / profile 12 / group 6
  const text = '我喜欢编程';
  for (const source of ['interview', 'post', 'profile', 'group']) {
    const r = await ig.extractAndApply('u_main', { source, sourceId: 's1', text });
    assert.equal(r.applied, 1, `${source} 应成功入图`);
  }
  const row = get(
    `SELECT ui.weight FROM user_interests ui JOIN interest_nodes n ON n.id = ui.node_id
     WHERE ui.user_id = 'u_main' AND n.name = '编程开发'`,
  );
  assert.equal(Math.round(row.weight), 30 + 18 + 12 + 6);

  const logs = all("SELECT reason, delta FROM interest_weight_log WHERE user_id = 'u_main' ORDER BY id");
  const byReason = Object.fromEntries(logs.map((l) => [l.reason, l.delta]));
  assert.equal(byReason.interview, 30);
  assert.equal(byReason.post, 18);
  assert.equal(byReason.profile, 12);
  assert.equal(byReason.group, 6);
});

test('同源同节点 24h 内只计一次', async () => {
  const before = get(
    `SELECT ui.weight FROM user_interests ui JOIN interest_nodes n ON n.id = ui.node_id
     WHERE ui.user_id = 'u_main' AND n.name = '编程开发'`,
  ).weight;
  const r = await ig.extractAndApply('u_main', { source: 'interview', sourceId: 's2', text: '我喜欢编程' });
  assert.equal(r.applied, 0, '24h 内重复证据应被去重');
  const after = get(
    `SELECT ui.weight FROM user_interests ui JOIN interest_nodes n ON n.id = ui.node_id
     WHERE ui.user_id = 'u_main' AND n.name = '编程开发'`,
  ).weight;
  assert.equal(after, before);
});

test('去重窗口过期后同源可再次计入', async () => {
  ageEvidence('u_main', 25 * 60 * 60 * 1000); // 25 小时前
  const r = await ig.extractAndApply('u_main', { source: 'interview', sourceId: 's3', text: '我喜欢编程' });
  assert.equal(r.applied, 1);
});

test('别名归一进规范节点，不新建重名节点', async () => {
  // 「编程」是「编程开发」的别名；强意图句式会再产一个候选「编程」，应并入而不新建
  const r = await ig.extractAndApply('u_alias', { source: 'interview', sourceId: 'a1', text: '最近在学编程' });
  assert.equal(r.applied, 1);
  assert.equal(get("SELECT COUNT(*) AS c FROM interest_nodes WHERE name = '编程'")?.c, 0);
  const row = get(
    `SELECT n.name AS name FROM user_interests ui JOIN interest_nodes n ON n.id = ui.node_id
     WHERE ui.user_id = 'u_alias'`,
  );
  assert.equal(row.name, '编程开发');
});

test('强意图句式自动建新节点', async () => {
  await ig.extractAndApply('u_alias', { source: 'post', sourceId: 'a2', text: '最近迷上滑板速降' });
  const n = get("SELECT name, status FROM interest_nodes WHERE name = '滑板速降'");
  assert.ok(n, '应自动创建新节点');
  assert.equal(n.status, 'auto');
});

test('节点名剥掉语气词残渣，不产出「露营了」这类脏名字', async () => {
  assert.equal(ig.cleanNodeName('露营了'), '露营');
  assert.equal(ig.cleanNodeName('了露营'), '露营');
  assert.equal(ig.cleanNodeName('陶艺呢'), '陶艺');
  await ig.extractAndApply('u_alias', { source: 'post', sourceId: 'a3', text: '彻底迷上陶艺了' });
  assert.ok(get("SELECT name FROM interest_nodes WHERE name = '陶艺'"), '应创建干净节点名「陶艺」');
  assert.equal(get("SELECT COUNT(*) AS c FROM interest_nodes WHERE name = '陶艺了'")?.c, 0);
});

test('30 天无证据按 ×0.9/档衰减，下限 5', async () => {
  await ig.extractAndApply('u_decay', { source: 'interview', sourceId: 'd1', text: '我喜欢编程' });
  // 拨回 61 天 → 2 档衰减：weight × 0.81
  run('UPDATE user_interests SET updated_at = ? WHERE user_id = ?', Date.now() - 61 * DAY, 'u_decay');
  ig.getOwnGraph('u_decay'); // 惰性衰减在这里触发
  const w = get('SELECT weight FROM user_interests WHERE user_id = ?', 'u_decay').weight;
  assert.ok(Math.abs(w - 30 * 0.81) < 0.01, `期望 24.3，实际 ${w}`);
  assert.ok(get("SELECT COUNT(*) AS c FROM interest_weight_log WHERE user_id = 'u_decay' AND reason = 'decay'")?.c >= 1);

  // 下限：5 分的节点不再衰减
  run('UPDATE user_interests SET weight = 5, updated_at = ? WHERE user_id = ?', Date.now() - 100 * DAY, 'u_decay');
  ig.getOwnGraph('u_decay');
  assert.equal(get('SELECT weight FROM user_interests WHERE user_id = ?', 'u_decay').weight, 5);
});

test('evidence FIFO 上限 8 条', async () => {
  await ig.extractAndApply('u_fifo', { source: 'profile', sourceId: 'f1', text: '我喜欢编程' });
  // 手工铺满 8 条旧证据（避开 post：下一次入图用 post，不能触发 24h 去重）
  const old = Date.now() - 5 * DAY;
  const filled = Array.from({ length: 8 }, (_, i) => ({
    source_type: i % 2 ? 'interview' : 'group',
    source_id: `old${i}`,
    quote: `旧证据${i}`,
    at: old,
  }));
  run('UPDATE user_interests SET evidence = ? WHERE user_id = ?', toJson(filled), 'u_fifo');

  const r = await ig.extractAndApply('u_fifo', { source: 'post', sourceId: 'f2', text: '我喜欢编程' });
  assert.equal(r.applied, 1);
  const ev = parseJson(get('SELECT evidence FROM user_interests WHERE user_id = ?', 'u_fifo').evidence, []);
  assert.equal(ev.length, 8, '超过 8 条应淘汰最旧的');
  assert.equal(ev[ev.length - 1].source_type, 'post');
  assert.equal(ev[0].source_id, 'old1', '最旧的 old0 应被淘汰');
});

test('入图后单向回写 personas.interests', () => {
  const p = get('SELECT interests FROM personas WHERE user_id = ?', 'u_main');
  const interests = parseJson(p.interests, []);
  assert.ok(interests.some((i) => i.name === '编程开发' && i.weight > 0));
});

test('图谱读取与统计', () => {
  const g = ig.getOwnGraph('u_main');
  assert.ok(g.nodes.length > 0);
  assert.ok(g.nodes[0].evidence !== undefined);
  assert.ok(Array.isArray(g.edges));

  const pub = ig.getPublicGraph('u_main');
  assert.ok(pub.nodes.length <= 10);
  assert.equal(pub.nodes[0].evidence, undefined, '公开版不应带证据明细');

  const ctx = ig.getGraphContext('u_main');
  assert.ok(ctx.weights.size > 0);
  assert.ok(ctx.names.size > 0);

  const stats = ig.graphStats();
  assert.ok(stats.nodes >= 14);
  assert.ok(stats.users_in_graph >= 1);
});
