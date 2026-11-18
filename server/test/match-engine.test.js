/**
 * 匹配引擎测试（纯函数，无数据库）。
 *
 * spec §9「匹配：图谱相似度 > 平面相似度的构造用例、空图谱回退不报错」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  graphInterestSim,
  interestOverlap,
  complementarity,
  computeMatch,
  rankCandidates,
} from '../src/ai/match-engine.js';

/** 构造图谱上下文：weights {nodeId: weight}，edges [[a,b], ...]，names 默认用 id */
function mkCtx(weights, edges = []) {
  const w = new Map(Object.entries(weights));
  const names = new Map(Object.keys(weights).map((k) => [k, k]));
  const neighbors = new Map();
  for (const [a, b] of edges) {
    if (!neighbors.has(a)) neighbors.set(a, new Set());
    neighbors.get(a).add(b);
    if (!neighbors.has(b)) neighbors.set(b, new Set());
    neighbors.get(b).add(a);
  }
  return { weights: w, names, neighbors };
}

const persona = (id, extra = {}) => ({
  user_id: id,
  vector: [50, 50, 50, 50, 50, 50],
  interests: [],
  values: [],
  goals: [],
  rhythm: '灵活',
  ...extra,
});

test('图谱相似度：同节点加权重合', () => {
  const a = mkCtx({ 摄影: 80, 阅读: 40 });
  const b = mkCtx({ 摄影: 60, 游戏: 30 });
  const r = graphInterestSim(a, b);
  assert.ok(r.score > 0 && r.score < 100);
  assert.deepEqual(r.common, ['摄影']);
});

test('图谱相似度：一跳邻居折半计入', () => {
  // A 的「摄影」与 B 的「设计」有边：无同节点，但邻居重合要给分
  const a = mkCtx({ 摄影: 80 }, [['摄影', '设计']]);
  const b = mkCtx({ 设计: 80 }, [['摄影', '设计']]);
  const r = graphInterestSim(a, b);
  assert.ok(r.score > 0, '邻居重合应产生非零相似度');
  assert.ok(r.score < 30, '邻居折半后不应超过直接重合的分');
});

test('图谱相似度：完全不相交为 0', () => {
  const r = graphInterestSim(mkCtx({ 摄影: 80 }), mkCtx({ 游戏: 80 }));
  assert.equal(r.score, 0);
});

test('空图谱上下文安全返回 0', () => {
  const empty = { weights: new Map(), names: new Map(), neighbors: new Map() };
  const r = graphInterestSim(empty, mkCtx({ 摄影: 80 }));
  assert.equal(r.score, 0);
});

test('互补盲区用节点规范名，不产生 DIM_ 占位符', () => {
  const ctxA = mkCtx({ 摄影: 80 }, [['摄影', '设计']]);
  const ctxB = mkCtx({ 潜水: 50, 摄影: 30 });
  const r = complementarity(persona('a'), persona('b', { interests: [{ name: '潜水', weight: 50 }] }), ctxA, ctxB);
  for (const n of r.notes) assert.ok(!String(n).startsWith('DIM_'), `不应出现占位符: ${n}`);
  assert.ok(r.newInterests.includes('潜水'));
  assert.ok(r.notes.some((n) => n.includes('潜水')), '盲区文案应点出节点名');
});

test('2 跳可达内的节点不算盲区', () => {
  // B 的「设计」经 A 的「摄影」一跳可达，不应被列为图谱盲区。
  // 双方平面兴趣都带上「设计」，排除 bOnly 回退项的干扰，单测图谱判定。
  const ctxA = mkCtx({ 摄影: 80 }, [['摄影', '设计']]);
  const ctxB = mkCtx({ 设计: 50 });
  const a = persona('a', { interests: [{ name: '设计', weight: 40 }] });
  const b = persona('b', { interests: [{ name: '设计', weight: 50 }] });
  const r = complementarity(a, b, ctxA, ctxB);
  assert.ok(!r.newInterests.includes('设计'));
});

test('computeMatch 有无图谱都能算分', () => {
  const a = persona('a', { interests: [{ name: '摄影', weight: 80 }] });
  const b = persona('b', { interests: [{ name: '摄影', weight: 60 }], rhythm: '夜猫型' });

  const noGraph = computeMatch(a, b, {});
  assert.ok(noGraph.score >= 12 && noGraph.score <= 98);
  assert.ok(noGraph.breakdown.resonance !== undefined);

  const graphs = new Map([
    ['a', mkCtx({ 摄影: 80 })],
    ['b', mkCtx({ 摄影: 60 })],
  ]);
  const withGraph = computeMatch(a, b, { graphs });
  assert.ok(withGraph.score >= 12 && withGraph.score <= 98);
  assert.ok(withGraph.common.includes('摄影'));
});

test('空图谱自动回退平面相似度，结果不报错', () => {
  const a = persona('a', { interests: [{ name: '摄影', weight: 80 }] });
  const b = persona('b', { interests: [{ name: '摄影', weight: 60 }] });
  const empty = { weights: new Map(), names: new Map(), neighbors: new Map() };
  const graphs = new Map([
    ['a', empty],
    ['b', empty],
  ]);
  const r = computeMatch(a, b, { graphs });
  const flat = interestOverlap(a.interests, b.interests);
  assert.equal(r.breakdown.interest, Math.round(flat.score));
});

test('rankCandidates 排除自己并按分数排序', () => {
  const me = persona('me', { interests: [{ name: '摄影', weight: 80 }] });
  const pool = [
    persona('p1', { interests: [{ name: '摄影', weight: 80 }], rhythm: '灵活' }),
    persona('p2', { interests: [{ name: '游戏', weight: 80 }], vector: [10, 10, 10, 10, 10, 10] }),
    me,
  ];
  const ranked = rankCandidates(me, pool, { limit: 5 });
  assert.equal(ranked.length, 2);
  assert.ok(ranked[0].score >= ranked[1].score);
  assert.ok(!ranked.some((r) => r.candidate.user_id === 'me'));
});
