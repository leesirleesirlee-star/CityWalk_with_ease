import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planTour } from '../src/agent/citywalk/planner.js';
import {
  planWithGuard,
  diagnoseEmpty,
  pickFallbackStop,
} from '../src/agent/citywalk/routeGuard.js';
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

const guard = (overrides = {}) =>
  planWithGuard({ city: CITY, pois: POIS, budgetMin: 180, mode: 'strict', pace: 'balanced', ...overrides });

test('常规预算：guard=ok，脚本与 planTour 完全一致（零影响）', () => {
  const g = guard();
  const p = planTour({ city: CITY, pois: POIS, budgetMin: 180 });
  assert.equal(g.guard.status, 'ok');
  assert.equal(g.guard.overrun_min, 0);
  assert.deepEqual(g.script, p.script);
  assert.deepEqual(g.selected, p.selected);
});

test('极小预算 30：保底 1 站，input_min 还原，且通过 1.1.0 schema', () => {
  const g = guard({ budgetMin: 30 });
  assert.equal(g.guard.status, 'fallback_1_stop');
  assert.equal(g.guard.code, 'budget_or_score');
  assert.equal(g.script.route.length, 1);
  assert.equal(g.script.meta.budget.input_min, 30);
  assert.ok(g.summary.total_min > 30, '保底必然超出原预算');
  assert.ok(g.guard.overrun_min > 0);
  assert.match(g.script.route[0].reason, /保底入选/);
  assert.ok(
    g.script.meta.agent_trace.at(-1).warnings.some((w) => w.includes('空路线兜底')),
    '降级必须写进 agent_trace.warnings',
  );

  const v = validateAgainstSchema(g.script, SCHEMA);
  assert.equal(v.valid, true, JSON.stringify(v.issues));
});

test('保底后候选守恒：selected + dropped === 候选总数', () => {
  const g = guard({ budgetMin: 30 });
  assert.equal(g.selected.length + g.dropped.length, POIS.length);
  assert.equal(g.summary.selected_count + g.summary.dropped_count, g.summary.candidate_count);
  assert.equal(g.summary.candidate_count, POIS.length);
  assert.ok(!g.dropped.some((d) => d.id === g.selected[0]), '入选点不得同时出现在 dropped');
});

test('空候选 / 空数组 / null：no_route，不产出非法脚本', () => {
  for (const pois of [[], null]) {
    const g = planWithGuard({ city: CITY, pois, budgetMin: 120 });
    assert.equal(g.script, null);
    assert.equal(g.guard.status, 'no_route');
    assert.equal(g.guard.code, 'no_candidates');
  }
});

test('全部坐标缺失：no_route(all_unmatched)，不做假保底', () => {
  const pois = POIS.filter((p) => p.coord_source === 'unmatched');
  assert.equal(diagnoseEmpty({ pois }).code, 'all_unmatched');
  assert.equal(pickFallbackStop({ pois }), null);
  const g = planWithGuard({ city: CITY, pois, budgetMin: 180 });
  assert.equal(g.script, null);
  assert.equal(g.guard.code, 'all_unmatched');
});

test('全部闭馆：no_route(all_closed)', () => {
  const pois = POIS.map((p) => ({ ...p, opening_hours: 'closed' }));
  assert.equal(diagnoseEmpty({ pois }).code, 'all_closed');
  const g = planWithGuard({ city: CITY, pois, budgetMin: 180 });
  assert.equal(g.script, null);
  assert.equal(g.guard.status, 'no_route');
  assert.equal(g.guard.code, 'all_closed');
});

test('全部被移除：no_route(all_removed)', () => {
  const removedIds = POIS.map((p) => p.id);
  assert.equal(diagnoseEmpty({ pois: POIS, removedIds }).code, 'all_removed');
  const g = planWithGuard({ city: CITY, pois: POIS, removedIds, budgetMin: 180 });
  assert.equal(g.script, null);
  assert.equal(g.guard.code, 'all_removed');
  for (const d of g.dropped) assert.equal(d.kind, 'user_removed');
});

test('保底点选择确定性：同输入两次结果一致，且取耗时最短', () => {
  const a = pickFallbackStop({ pois: POIS });
  const b = pickFallbackStop({ pois: POIS.slice().reverse() });
  assert.equal(a.id, b.id);
  assert.ok(a.coord_source !== 'unmatched');
});
