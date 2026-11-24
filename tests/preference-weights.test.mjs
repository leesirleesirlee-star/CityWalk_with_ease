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
const round4 = (v) => Math.round(v * 10000) / 10000;
const poiOf = (id) => POIS.find((p) => p.id === id);

test('按类别权重：历史街区 1.5 / 民俗夜市 1.2 各自生效，未列出的走默认 1.3', () => {
  const preferences = { categories: { 历史街区: 1.5, 民俗夜市: 1.2 } };
  const pref = normalizePreferences(preferences);

  assert.equal(pref.weightOf('历史街区'), 1.5);
  assert.equal(pref.weightOf('民俗夜市'), 1.2);
  assert.equal(pref.weightOf('城市公园'), PREFERENCE_BOOST);

  const wide = scorePoi(poiOf('cd-005'), { preferences });
  assert.equal(wide.preference_matched, true);
  assert.equal(wide.value, round4(wide.base_value * 1.5));

  const jinli = scorePoi(poiOf('cd-003'), { preferences });
  assert.equal(jinli.value, round4(jinli.base_value * 1.2));

  const park = scorePoi(poiOf('cd-007'), { preferences });
  assert.equal(park.preference_matched, false);
  assert.equal(park.value, park.base_value);
});

test('weights 写法与 categories 对象等价，可与 categories 数组混用', () => {
  const byCategories = normalizePreferences({ categories: { 历史街区: 1.5 } });
  const byWeights = normalizePreferences({ weights: { 历史街区: 1.5 } });
  assert.equal(byCategories.weightOf('历史街区'), byWeights.weightOf('历史街区'));

  const mixed = normalizePreferences({
    categories: ['历史街区', '民俗夜市'],
    weights: { 历史街区: 1.6 },
  });
  assert.equal(mixed.weightOf('历史街区'), 1.6, '显式权重覆盖默认值');
  assert.equal(mixed.weightOf('民俗夜市'), PREFERENCE_BOOST, '未给权重的类别走默认');
  assert.equal(mixed.categories.size, 2);
});

test('每类权重独立夹在 1..2，非法值回落到默认权重', () => {
  const pref = normalizePreferences({
    categories: { 历史街区: 9, 民俗夜市: 0, 城市公园: 'x' },
  });
  assert.equal(pref.weightOf('历史街区'), 2);
  assert.equal(pref.weightOf('民俗夜市'), 1);
  assert.equal(pref.weightOf('城市公园'), PREFERENCE_BOOST);

  const withDefault = normalizePreferences({ categories: { 历史街区: 'x' }, weight: 1.7 });
  assert.equal(withDefault.weightOf('历史街区'), 1.7, '非法类权重应回落到调用方给的默认权重');
});

test('reason 记录实际倍率，不再统一写成 1.3', () => {
  const result = plan({ budgetMin: 60, preferences: { categories: { 历史街区: 1.5 } } });
  const hit = result.script.route.find((stop) => stop.id === 'cd-005');

  assert.ok(hit, `偏好应命中宽窄巷子，实际 ${result.selected.join(',')}`);
  assert.match(hit.reason, /偏好命中 历史街区/);
  assert.match(hit.reason, /×1\.5/);
  assert.doesNotMatch(hit.reason, /×1\.3/);

  const check = validateAgainstSchema(result.script, SCHEMA);
  assert.equal(check.valid, true, JSON.stringify(check.issues));
});

test('二次归一不丢按类权重，空偏好仍完全零影响', () => {
  const first = normalizePreferences({ categories: { 历史街区: 1.5 } });
  const second = normalizePreferences(first);
  assert.equal(second.weightOf('历史街区'), 1.5);
  assert.equal(second, first, '已归一对象应原样返回');

  const base = plan();
  for (const preferences of [undefined, null, {}, { categories: [] }, { categories: [''] }, { weights: {} }]) {
    const other = plan({ preferences });
    assert.deepEqual(other.script, base.script, `preferences=${JSON.stringify(preferences)} 改变了输出`);
  }
});
