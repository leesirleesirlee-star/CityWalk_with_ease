import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  planTour,
  scorePoi,
  normalizePreferences,
  PREFERENCE_BOOST,
} from '../src/agent/citywalk/planner.js';
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

const plan = (overrides = {}) => planTour({ city: CITY, pois: POIS, budgetMin: 180, ...overrides });

test('不传 / 传 null / 传空偏好：脚本完全一致（零影响）', () => {
  const base = plan();
  for (const preferences of [undefined, null, {}, [], { categories: [] }, { categories: [''] }]) {
    const other = plan({ preferences });
    assert.deepEqual(other.script, base.script, `preferences=${JSON.stringify(preferences)} 改变了输出`);
    assert.equal(other.summary.preference_hits, 0);
  }
});

test('scorePoi：命中类别价值 ×1.3，未命中保持原值', () => {
  const garden = POIS.find((p) => p.category === '古典园林');
  const plain = scorePoi(garden);
  const boosted = scorePoi(garden, { preferences: { categories: ['古典园林'] } });

  assert.equal(plain.preference_matched, false);
  assert.equal(plain.value, plain.base_value);
  assert.equal(boosted.preference_matched, true);
  assert.equal(boosted.base_value, plain.base_value);
  assert.equal(boosted.value, Math.round(plain.base_value * PREFERENCE_BOOST * 10000) / 10000);
  assert.ok(boosted.score > plain.score, '偏好命中后 score 应提升');
  assert.ok(boosted.score < 1, 'score 必须恒小于 1');

  const other = scorePoi(garden, { preferences: { categories: ['历史街区'] } });
  assert.equal(other.preference_matched, false);
  assert.equal(other.value, plain.value);
});

test('偏好权重夹在 1..2，非法值退回默认 1.3', () => {
  assert.equal(normalizePreferences({ categories: ['a'], weight: 9 }).weight, 2);
  assert.equal(normalizePreferences({ categories: ['a'], weight: 0 }).weight, 1);
  assert.equal(normalizePreferences({ categories: ['a'], weight: Number.NaN }).weight, PREFERENCE_BOOST);
  assert.equal(normalizePreferences({ categories: ['a'] }).weight, PREFERENCE_BOOST);
  assert.equal(normalizePreferences(null), null);
  assert.equal(normalizePreferences({ categories: [] }), null);
});

test('偏好改变选点：预算 60 时，常选望江楼，偏好历史街区改选宽窄巷子', () => {
  const base = plan({ budgetMin: 60 });
  const pref = plan({ budgetMin: 60, preferences: { categories: ['历史街区'] } });

  assert.deepEqual(base.selected, ['cd-009']);
  assert.ok(pref.selected.includes('cd-005'), `偏好应命中宽窄巷子，实际 ${pref.selected}`);
  assert.equal(pref.summary.preference_hits >= 1, true);
  assert.notDeepEqual(pref.selected, base.selected);
});

test('偏好结果仍是合法 1.1.0 脚本，且 reason 标注命中', () => {
  const result = plan({ budgetMin: 180, preferences: { categories: ['历史街区'] } });
  const v = validateAgainstSchema(result.script, SCHEMA);
  assert.equal(v.valid, true, JSON.stringify(v.issues));

  const hit = result.script.route.find((r) => r.id === 'cd-005');
  assert.ok(hit, '宽窄巷子应在路线内');
  assert.match(hit.reason, /偏好命中 历史街区/);
  for (const r of result.script.route) {
    assert.ok(r.score < 1, `${r.id} score 越界`);
  }
});

test('偏好不会把无坐标点拉进路线', () => {
  const pref = plan({ budgetMin: 180, preferences: { categories: ['寺院', '自然保护地'] } });
  for (const id of ['cd-001', 'cd-006']) {
    assert.ok(!pref.selected.includes(id), `${id} 无坐标，不得入选`);
    assert.ok(pref.dropped.some((d) => d.id === id), `${id} 必须进 dropped`);
  }
});
