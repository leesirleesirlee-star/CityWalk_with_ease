import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateBudget,
  estimateWalkMinutes,
  normalizeBudget,
  normalizeMode,
  normalizePace,
  PACE_SPEED_KMH,
  STAY_MIN_BY_CATEGORY,
  DEFAULT_STAY_MIN,
} from '../src/agent/citywalk/budget.js';

// 840m @ balanced(4.2km/h) = 12.0 分钟，用于构造精确边界。
const WALK_12MIN_M = 840;

test('strict 恰好等于预算 → 可行，overflow 为 0', () => {
  const walk = estimateWalkMinutes(WALK_12MIN_M, 'balanced');
  assert.equal(walk, 12);
  const result = evaluateBudget({
    candidates: [{ id: 'a', name: 'A', category: '寺院', stay_min: 30 }],
    budgetMin: 30 + walk,
    mode: 'strict',
    pace: 'balanced',
    walkMeters: WALK_12MIN_M,
  });
  assert.equal(result.total_min, 42);
  assert.equal(result.budget_min, 42);
  assert.equal(result.overflow_min, 0);
  assert.equal(result.feasible, true);
  assert.equal(result.breakdown.walk_min, 12);
  assert.equal(result.breakdown.stay_min, 30);
});

test('strict 超预算 → 不可行，total_min 与超限量数值正确', () => {
  const result = evaluateBudget({
    candidates: [{ id: 'a', category: '寺院', stay_min: 30 }],
    budgetMin: 30,
    mode: 'strict',
    pace: 'balanced',
    walkMeters: WALK_12MIN_M,
  });
  assert.equal(result.feasible, false);
  assert.equal(result.total_min, 42);
  assert.equal(result.overflow_min, 12);
  assert.equal(result.allowance_min, 0);
});

test('三档步速单调：packed ≤ balanced ≤ relaxed（时长递增）', () => {
  assert.ok(PACE_SPEED_KMH.relaxed < PACE_SPEED_KMH.balanced);
  assert.ok(PACE_SPEED_KMH.balanced < PACE_SPEED_KMH.packed);
  const fast = estimateWalkMinutes(2000, 'packed');
  const normal = estimateWalkMinutes(2000, 'balanced');
  const slow = estimateWalkMinutes(2000, 'relaxed');
  assert.ok(fast < normal, `${fast} < ${normal}`);
  assert.ok(normal < slow, `${normal} < ${slow}`);
});

test('空候选 / 缺停留字段 → 结构化降级，不 throw', () => {
  const empty = evaluateBudget({ candidates: [], budgetMin: 120 });
  assert.equal(empty.total_min, 0);
  assert.equal(empty.feasible, true);
  assert.equal(empty.degraded, true);
  assert.ok(empty.reasons.length > 0);

  const missing = evaluateBudget({
    candidates: [{ id: 'b', category: '历史街区' }],
    budgetMin: 120,
    walkMeters: 0,
  });
  assert.equal(missing.items[0].stay_source, 'category');
  assert.equal(missing.items[0].stay_min, STAY_MIN_BY_CATEGORY['历史街区']);
  assert.equal(missing.degraded, true);

  const unknown = evaluateBudget({
    candidates: [{ id: 'c', category: '未登记类别' }],
    budgetMin: 120,
  });
  assert.equal(unknown.items[0].stay_source, 'default');
  assert.equal(unknown.items[0].stay_min, DEFAULT_STAY_MIN);

  assert.doesNotThrow(() => evaluateBudget());
  assert.doesNotThrow(() => evaluateBudget({ candidates: null }));
});

test('确定性：同一输入连续两次结果 deep-equal', () => {
  const input = {
    candidates: [
      { id: 'a', category: '城市公园', stay_min: 45, walk_m: 600 },
      { id: 'b', category: '历史祠庙', walk_m: 900 },
    ],
    budgetMin: 180,
    mode: 'flexible',
    pace: 'relaxed',
  };
  assert.deepEqual(evaluateBudget(input), evaluateBudget(input));
});

test('flexible 允许有限超出，超出上限来自常量表', () => {
  const within = evaluateBudget({
    candidates: [{ id: 'a', category: '寺院', stay_min: 30 }],
    budgetMin: 40,
    mode: 'flexible',
    pace: 'balanced',
    walkMeters: WALK_12MIN_M,
  });
  assert.equal(within.total_min, 42);
  assert.equal(within.allowance_min, 8);
  assert.equal(within.feasible, true);

  const beyond = evaluateBudget({
    candidates: [{ id: 'a', category: '寺院', stay_min: 100 }],
    budgetMin: 40,
    mode: 'flexible',
    pace: 'balanced',
    walkMeters: WALK_12MIN_M,
  });
  assert.equal(beyond.feasible, false);
  assert.equal(beyond.overflow_min, 72);
});

test('归一化：非法输入退回默认值且标记 degraded，不抛异常', () => {
  assert.deepEqual(normalizeBudget('abc'), { budget_min: 240, source: 'fallback', degraded: true });
  assert.deepEqual(normalizeBudget({ duration_budget_min: 90 }), { budget_min: 90, source: 'duration_budget_min', degraded: false });
  assert.deepEqual(normalizeMode('turbo'), { mode: 'strict', degraded: true });
  assert.deepEqual(normalizePace('sprint'), { pace: 'balanced', degraded: true });
  assert.equal(estimateWalkMinutes(-5, 'balanced'), 0);
  assert.equal(estimateWalkMinutes(Number.NaN, 'balanced'), 0);
});
