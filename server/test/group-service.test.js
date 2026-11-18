/**
 * 同频局 service 测试（走独立临时库）。
 * 覆盖：入组申请、审批（满员复查 + 事务语义）、退组清申请、容量同步、群聊未读。
 * AI 固定走本地引擎（AI_PROVIDER=local），避免外部调用。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 环境必须在导入业务模块前设置：ESM 导入会提升，config 在首次导入时读 env
const tmpDb = path.join(os.tmpdir(), `tongpin-test-group-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
process.env.AI_PROVIDER = 'local';
process.env.ANTHROPIC_API_KEY = '';
process.env.OPENAI_API_KEY = '';

const { migrate, run, get } = await import('../src/db/index.js');
const gs = await import('../src/services/group-service.js');

function makeUser(id) {
  const ts = Date.now();
  run(
    'INSERT INTO users (id,email,password_hash,nickname,created_at,last_active_at) VALUES (?,?,?,?,?,?)',
    id, `${id}@test.dev`, 'x', `测试-${id}`, ts, ts,
  );
  run('INSERT INTO personas (user_id,vector,updated_at) VALUES (?,?,?)', id, '[50,50,50,50,50,50]', ts);
}

/** 建组并让 owner 成为成员（对齐 create 路由的行为） */
function makeGroup(id, ownerId, capacity = 2) {
  const ts = Date.now();
  run(
    `INSERT INTO groups (id,owner_id,title,description,category,capacity,status,created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    id, ownerId, `小组-${id}`, '测试小组', '测试', capacity, 'open', ts,
  );
  run('INSERT INTO group_members (group_id,user_id,role,joined_at) VALUES (?,?,?,?)', id, ownerId, 'owner', ts);
}

function memberCount(groupId) {
  return get('SELECT COUNT(*) AS n FROM group_members WHERE group_id = ?', groupId).n;
}

before(() => {
  migrate();
  makeUser('u_owner');
  makeUser('u_a');
  makeUser('u_b');
  makeUser('u_c');
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

test('申请入组：新建 / 重复申请合并 / 已通过后拒绝', () => {
  makeGroup('g1', 'u_owner', 3);
  const r1 = gs.requestJoin('g1', 'u_a', '我想加入');
  assert.equal(r1.ok, true);
  assert.equal(r1.resubmitted, false);
  assert.equal(gs.pendingRequestCount('g1'), 1);

  const r2 = gs.requestJoin('g1', 'u_a', '再申请一次');
  assert.equal(r2.ok, true);
  assert.equal(r2.resubmitted, true);
  assert.equal(gs.pendingRequestCount('g1'), 1); // 只保留一条，不重复计数

  gs.decideRequest('g1', 'u_a', true);
  const r3 = gs.requestJoin('g1', 'u_a', '还想加');
  assert.equal(r3.ok, false);
  assert.equal(r3.error, 'already-member');
});

test('审批通过：写入成员 + 系统消息；重复审批拒绝', () => {
  makeGroup('g2', 'u_owner', 3);
  gs.requestJoin('g2', 'u_b', '');
  const res = gs.decideRequest('g2', 'u_b', true);
  assert.equal(res.ok, true);
  assert.ok(gs.isMember('g2', 'u_b'));
  assert.equal(memberCount('g2'), 2); // owner + u_b
  assert.ok(gs.listGroupMessages('g2').some((m) => m.kind === 'system' && m.content.includes('加入了小组')));
  assert.equal(gs.decideRequest('g2', 'u_b', true).error, 'no-request');
});

test('审批拒绝：不写入成员', () => {
  makeGroup('g3', 'u_owner', 3);
  gs.requestJoin('g3', 'u_c', '');
  gs.decideRequest('g3', 'u_c', false);
  assert.ok(!gs.isMember('g3', 'u_c'));
  assert.equal(memberCount('g3'), 1); // 仅 owner
});

test('满员复查：容量已满时审批返回 full，不写入成员', () => {
  makeGroup('g4', 'u_owner', 2); // owner 已占 1 席
  gs.requestJoin('g4', 'u_a', '');
  gs.requestJoin('g4', 'u_b', '');
  // 批 u_a 到 2 人（满员）
  assert.equal(gs.decideRequest('g4', 'u_a', true).ok, true);
  assert.equal(memberCount('g4'), 2);
  // 再批 u_b → 满员拒绝，成员不增加
  const full = gs.decideRequest('g4', 'u_b', true);
  assert.equal(full.ok, false);
  assert.equal(full.error, 'full');
  assert.equal(memberCount('g4'), 2);
  assert.ok(!gs.isMember('g4', 'u_b'));
});

test('容量同步 + 退组清申请', () => {
  makeGroup('g5', 'u_owner', 2);
  gs.requestJoin('g5', 'u_a', '');
  gs.decideRequest('g5', 'u_a', true);

  const g5 = get("SELECT * FROM groups WHERE id = 'g5'");
  assert.equal(gs.syncGroupCapacity(g5), 2);
  assert.equal(get("SELECT status FROM groups WHERE id = 'g5'").status, 'full');

  // 退组 → 释放容量 + 清空申请
  run('DELETE FROM group_members WHERE group_id = ? AND user_id = ?', 'g5', 'u_a');
  gs.clearRequest('g5', 'u_a');
  const g5b = get("SELECT * FROM groups WHERE id = 'g5'");
  assert.equal(gs.syncGroupCapacity(g5b), 1);
  assert.equal(get("SELECT status FROM groups WHERE id = 'g5'").status, 'open');
  assert.equal(gs.myPendingRequest('g5', 'u_a'), undefined);
});

test('群聊未读：只数他人真人消息，已读后归零', () => {
  makeGroup('g6', 'u_owner', 3);
  gs.requestJoin('g6', 'u_a', '');
  gs.decideRequest('g6', 'u_a', true);
  // 审批产生的系统消息不计入未读
  assert.equal(gs.groupUnreadCount('g6', 'u_a'), 0);

  gs.postGroupMessage('g6', 'u_owner', '大家好');
  assert.equal(gs.groupUnreadCount('g6', 'u_a'), 1);
  assert.equal(gs.groupUnreadTotal('u_a'), 1);
  // 自己发的消息不计为自己的未读
  assert.equal(gs.groupUnreadCount('g6', 'u_owner'), 0);

  gs.markGroupRead('g6', 'u_a');
  assert.equal(gs.groupUnreadCount('g6', 'u_a'), 0);
  assert.equal(gs.groupUnreadTotal('u_a'), 0);
});
