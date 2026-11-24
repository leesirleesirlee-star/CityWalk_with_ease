import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planTour, scorePoi, DROP_KINDS, TRACE_LABELS } from '../src/agent/citywalk/planner.js';
import { validateAgainstSchema } from '../tools/schema-check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'knowledge', 'tour_script.schema.json'), 'utf8'),
);

const CITY = { id: 'chengdu', name: '成都', pack_version: '0.1.0' };

const POIS = [
  { id: 'cd-003', name: '锦里', category: '民俗夜市', lat: 30.6488068, lng: 104.0469491, coord_source: 'overpass' },
  { id: 'cd-005', name: '宽窄巷子', category: '历史街区', lat: 30.6661912, lng: 104.051265, coord_source: 'overpass' },
  { id: 'cd-007', name: '人民公园', category: '城市公园', lat: 30.6594137, lng: 104.0554652, coord_source: 'overpass' },
  { id: 'cd-009', name: '望江楼公园', category: '古典园林', lat: 30.6320131, lng: 104.0894282, coord_source: 'overpass' },
  { id: 'cd-010', name: '武侯祠', category: '历史祠庙', lat: 30.6483863, lng: 104.0454567, coord_source: 'overpass' },
  { id: 'cd-001', name: '大慈寺', category: '寺院', coord_source: 'unmatched' },
  { id: 'cd-002', name: '东郊记忆', category: '工业遗址艺术区', coord_source: 'unmatched' },
  { id: 'cd-004', name: '九眼桥', category: '河岸夜景', coord_source: 'unmatched' },
  { id: 'cd-006', name: '成都大熊猫繁育研究基地', category: '自然保护地', coord_source: 'unmatched' },
  { id: 'cd-008', name: '太古里', category: '潮流街区', coord_source: 'unmatched' },
];

const plan = (overrides = {}) =>
  planTour({ city: CITY, pois: POIS, budgetMin: 180, mode: 'strict', pace: 'balanced', ...overrides });

const invariant = (result, total = POIS.length) => {
  assert.equal(result.selected.length + result.dropped.length, total);
  assert.equal(result.summary.selected_count + result.summary.dropped_count, result.summary.candidate_count);
};

test('5 档预算 × strict：全部不超时，且 selected + dropped === 总数', () => {
  for (const budget of [30, 60, 90, 120, 180]) {
    const result = plan({ budgetMin: budget });
    assert.ok(
      result.summary.total_min <= budget,
      `budget=${budget} total=${result.summary.total_min} 超预算`,
    );
    assert.ok(result.summary.total_min <= result.summary.limit_min);
    invariant(result);
  }
});

test('极小预算 30 分钟：selected 可为空，dropped 装满且理由齐全，不 throw', () => {
  const result = plan({ budgetMin: 30 });
  assert.equal(result.selected.length, 0);
  assert.equal(result.dropped.length, POIS.length);
  for (const d of result.dropped) {
    assert.ok(d.reason.length >= 4, `${d.id} reason 过短`);
    assert.ok(DROP_KINDS.includes(d.kind), `${d.id} kind 非法：${d.kind}`);
    assert.ok(d.id && d.name);
  }
  assert.doesNotThrow(() => plan({ budgetMin: 30 }));
});

test('候选为空数组：结构化空结果 + reasons[]，不 throw', () => {
  const result = planTour({ city: CITY, pois: [], budgetMin: 120 });
  assert.equal(result.script.route.length, 0);
  assert.equal(result.dropped.length, 0);
  assert.ok(result.summary.reasons.length > 0);
  assert.equal(result.script.meta.budget.total_min, 0);
  assert.doesNotThrow(() => planTour({ city: CITY, pois: null, budgetMin: 120 }));
});

test('coord_source=unmatched 的 POI 必须被排除并计入 dropped', () => {
  const result = plan({ budgetMin: 600 });
  const unmatchedIds = POIS.filter((p) => p.coord_source === 'unmatched').map((p) => p.id);
  for (const id of unmatchedIds) {
    assert.equal(result.selected.includes(id), false, `${id} 不应入选`);
    const entry = result.dropped.find((d) => d.id === id);
    assert.ok(entry, `${id} 未进 dropped`);
    assert.equal(entry.kind, 'score_below_threshold');
    assert.match(entry.reason, /unmatched/);
  }
  invariant(result);
});

test('确定性：同输入两次调用 deep-equal', () => {
  const a = plan({ budgetMin: 150, mode: 'flexible', pace: 'relaxed' });
  const b = plan({ budgetMin: 150, mode: 'flexible', pace: 'relaxed' });
  assert.deepEqual(a, b);
});

test('删站重算：total 变小、legs 少一条、被删站 kind=user_removed', () => {
  // 只用两站，保证删掉一站后没有替补，total 必然变小。
  const pair = POIS.slice(0, 2);
  const base = planTour({ city: CITY, pois: pair, budgetMin: 300 });
  assert.equal(base.selected.length, 2);
  const removedId = base.selected[1];
  const removed = planTour({ city: CITY, pois: pair, budgetMin: 300, removedIds: [removedId] });

  assert.ok(removed.summary.total_min < base.summary.total_min);
  const legsOf = (r) => r.script.route.filter((x) => x.leg !== null).length;
  assert.equal(legsOf(base), 1);
  assert.equal(legsOf(removed), 0);
  assert.equal(removed.selected.includes(removedId), false);
  const entry = removed.dropped.find((d) => d.id === removedId);
  assert.equal(entry.kind, 'user_removed');
  invariant(removed, pair.length);
});

test('所有腿为 fallback_straight，首站 leg 为 null', () => {
  const result = plan({ budgetMin: 300 });
  assert.equal(result.script.route[0].leg, null);
  for (const stop of result.script.route.slice(1)) {
    assert.equal(stop.leg.routing_status, 'fallback_straight');
    assert.ok(stop.leg.walk_min >= 0);
  }
});

test('产出的 script 通过 1.1.0 schema 校验', () => {
  const result = plan({ budgetMin: 180 });
  const { valid, issues } = validateAgainstSchema(result.script, SCHEMA);
  assert.equal(valid, true, (issues || []).slice(0, 3).join(' / '));
  assert.equal(result.script.meta.schema_version, '1.1.0');
  assert.equal(result.script.meta.agent_trace.length, 5);
  const durations = result.script.meta.agent_trace.map((t) => t.duration_ms);
  assert.equal(new Set(durations).size, 5);
  for (const d of durations) assert.ok(d > 0);
  assert.deepEqual(result.script.meta.agent_trace.map((t) => t.step), [1, 2, 3, 4, 5]);
  assert.deepEqual(result.script.meta.agent_trace.map((t) => t.label), [...TRACE_LABELS]);
});

test('scorePoi 可单独调用，score 落在 0..1', () => {
  const s = scorePoi(POIS[0], { pace: 'balanced' });
  assert.ok(s.score >= 0 && s.score <= 1);
  assert.ok(s.raw_score > 0);
  assert.equal(s.usable, true);
});

test('flexible 不超 allowance，strict 不超 budget', () => {
  const strict = plan({ budgetMin: 120, mode: 'strict' });
  assert.ok(strict.summary.total_min <= 120);
  const flexible = plan({ budgetMin: 120, mode: 'flexible' });
  assert.ok(flexible.summary.total_min <= flexible.summary.limit_min);
  assert.ok(flexible.summary.allowance_min > 0);
});
