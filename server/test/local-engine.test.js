/**
 * 本地语义引擎测试（无 Key 兜底路径）。
 *
 * spec §9「本地兜底：无 Key 时 extract 输出格式合法」——
 * 兜底输出必须与 AI 抽取同构，否则降级后图谱管线直接断掉。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractInterestItems, scorePersona, INTEREST_LEXICON } from '../src/ai/local-engine.js';

test('词表命中的抽取输出与 AI 版同构', () => {
  const items = extractInterestItems('我喜欢编程，周末玩摄影');
  assert.ok(Array.isArray(items) && items.length >= 2);
  const names = items.map((it) => it.node);
  assert.ok(names.includes('编程开发'));
  assert.ok(names.includes('摄影设计'));
  for (const it of items) {
    assert.equal(typeof it.node, 'string');
    assert.ok(it.delta >= 0 && it.delta <= 30);
    assert.equal(typeof it.quote, 'string');
    assert.ok(['sub_of', 'related', 'co_occurs'].includes(it.relation));
  }
});

test('强意图句式生成候选新节点（演示时图谱能长新节点）', () => {
  const items = extractInterestItems('最近迷上滑板速降，每周都去');
  const fresh = items.find((it) => it.create === true);
  assert.ok(fresh, '应产生 create 候选');
  assert.equal(fresh.suggest_name, '滑板速降');
  assert.equal(fresh.node, '滑板速降');
});

test('空文本与纯寒暄不产出节点', () => {
  assert.deepEqual(extractInterestItems(''), []);
  assert.deepEqual(extractInterestItems('今天天气不错，哈哈哈'), []);
});

test('单次抽取上限 5 个节点', () => {
  const text = Object.values(INTEREST_LEXICON).flat().slice(0, 30).join('，');
  assert.ok(extractInterestItems(text).length <= 5);
});

test('scorePersona 输出 6 个 0-100 分值', () => {
  const vec = scorePersona('我热爱社交聚会，也喜欢深度长谈，做事非常有计划');
  assert.equal(vec.length, 6);
  for (const v of vec) assert.ok(v >= 0 && v <= 100);
});

test('否定词会反转关键词信号', () => {
  const inner = scorePersona('我不太擅长社交，讨厌聚会，喜欢一个人安静地待着');
  const outer = scorePersona('我热爱社交，聚会永远冲在最前面，认识新朋友让我兴奋');
  assert.ok(inner[0] < outer[0], '被否定的社交信号不应打成外向');
});
