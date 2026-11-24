import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planWithGuard } from '../src/agent/citywalk/routeGuard.js';
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

const run = (overrides = {}) =>
  planWithGuard({ city: CITY, pois: POIS, budgetMin: 180, ...overrides });

const assertContract = (result) => {
  assert.ok(result.script, '应产出脚本');
  const v = validateAgainstSchema(result.script, SCHEMA);
  assert.equal(v.valid, true, JSON.stringify(v.issues));
  assert.equal(result.selected.length + result.dropped.length, POIS.length, '候选必须守恒');
  assert.equal(new Set(result.selected).size, result.selected.length, '路线内不得重复站点');
};

test('基线：预算 180 选出 2 站，契约与守恒成立', () => {
  const r = run();
  assert.equal(r.guard.status, 'ok');
  assert.deepEqual(r.selected, ['cd-009', 'cd-010']);
  assertContract(r);
});

test('删站重算：移除武侯祠后不再出现，且进 dropped(user_removed)', () => {
  const r = run({ removedIds: ['cd-010'] });
  assertContract(r);
  assert.ok(!r.selected.includes('cd-010'), '已删站点不得重新入选');
  const d = r.dropped.find((x) => x.id === 'cd-010');
  assert.equal(d.kind, 'user_removed');
  assert.match(d.reason, /重算/);
});

test('重算幂等：同一输入连续两次结果完全一致', () => {
  const a = run({ removedIds: ['cd-010'] });
  const b = run({ removedIds: ['cd-010'] });
  assert.deepEqual(a.script, b.script);
  assert.deepEqual(a.selected, b.selected);
  assert.deepEqual(a.guard, b.guard);
});

test('偏好调整：切换偏好后路线改变，且仍合法', () => {
  const base = run();
  const pref = run({ preferences: { categories: ['历史街区'] } });
  assertContract(pref);
  assert.notDeepEqual(pref.selected, base.selected);
  assert.ok(pref.selected.includes('cd-005'));
  assert.equal(pref.summary.preference_hits, 1);
});

test('偏好 + 删站交叉：偏好点被删后不报错，命中数归零', () => {
  const r = run({ preferences: { categories: ['历史街区'] }, removedIds: ['cd-005'] });
  assertContract(r);
  assert.ok(!r.selected.includes('cd-005'));
  assert.equal(r.summary.preference_hits, 0);
  assert.equal(r.dropped.find((x) => x.id === 'cd-005').kind, 'user_removed');
});

test('删到只剩一个点且预算不足：触发保底，summary 预算以用户输入为准', () => {
  const r = run({ budgetMin: 30, removedIds: ['cd-003', 'cd-007', 'cd-009', 'cd-010'] });
  assertContract(r);
  assert.equal(r.guard.status, 'fallback_1_stop');
  assert.deepEqual(r.selected, ['cd-005']);
  assert.equal(r.summary.budget_min, 30, 'summary 不得显示放宽后的预算');
  assert.equal(r.summary.relaxed_budget_min, r.summary.total_min);
  assert.equal(r.script.meta.budget.input_min, 30);
  assert.ok(r.summary.total_min > 30);
  assert.equal(r.summary.feasible, false);
  assert.match(r.script.route[0].reason, /保底入选/);
});

test('删光全部点位：no_route，不产出脚本', () => {
  const r = run({ removedIds: POIS.map((p) => p.id) });
  assert.equal(r.script, null);
  assert.equal(r.guard.status, 'no_route');
  assert.equal(r.guard.code, 'all_removed');
  assert.equal(r.dropped.length, POIS.length);
});

test('多轮重算：连续删站不产生幽灵站点', () => {
  let removed = [];
  const history = [];
  for (const id of ['cd-010', 'cd-005', 'cd-007']) {
    removed = [...removed, id];
    const r = run({ removedIds: removed });
    assertContract(r);
    for (const gone of removed) {
      assert.ok(!r.selected.includes(gone), `${gone} 已删除却仍出现`);
    }
    history.push(r.selected.join(','));
  }
  assert.equal(new Set(history).size >= 1, true);
});
