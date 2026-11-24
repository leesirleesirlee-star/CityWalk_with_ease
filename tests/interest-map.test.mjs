import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapInterests, preferencesFromInterests } from '../src/agent/citywalk/interestMap.js';
import { planTour } from '../src/agent/citywalk/planner.js';
import { runResilient, WARNINGS } from '../src/agent/citywalk/resilience.js';
import { validateAgainstSchema } from '../tools/schema-check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'knowledge', 'tour_script.schema.json'), 'utf8'),
);
const GEO = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'cities', 'chengdu', 'pois.geojson'), 'utf8'));

const POIS = GEO.features.map((feature) => {
  const p = feature.properties;
  const c = feature.geometry?.coordinates;
  return {
    id: p.poi_id,
    name: p.name,
    category: p.category,
    coord_source: p.coord_source,
    lat: Array.isArray(c) ? c[1] : null,
    lng: Array.isArray(c) ? c[0] : null,
  };
});

const CITY = { id: 'chengdu', name: '成都', pack_version: '0.1.0' };
const FIXED_NOW = '2026-11-20T00:00:00.000Z';
const validate = (script) => validateAgainstSchema(script, SCHEMA).issues ?? [];

test('单词映射：看熊猫 → 自然保护地，并带回知识库依据', () => {
  const { categories, hits } = mapInterests('想去看熊猫');
  assert.deepEqual(categories, { 自然保护地: 1.5 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].term, '看熊猫', '长词优先：应命中「看熊猫」而不是「熊猫」');
  assert.match(hits[0].basis, /竹林/);
});

test('场景词映射：夜景 / 酒吧 → 河岸夜景', () => {
  assert.deepEqual(mapInterests('晚上找个酒吧坐坐').categories, { 河岸夜景: 1.4 });
  assert.deepEqual(mapInterests('想看夜景').categories, { 河岸夜景: 1.4 });
});

test('多词多类：喝茶 + 看熊猫 → 历史街区 1.3 / 自然保护地 1.5', () => {
  const { categories } = mapInterests('喝茶,看熊猫');
  assert.deepEqual(categories, { 历史街区: 1.3, 自然保护地: 1.5 });
});

test('长词优先且同类不叠乘：竹林归熊猫基地，喝茶+茶馆+茶仍是 1.3', () => {
  assert.deepEqual(mapInterests('竹林').categories, { 自然保护地: 1.5 });
  assert.deepEqual(mapInterests('竹子').categories, { 古典园林: 1.3 });
  assert.deepEqual(mapInterests('喝茶,茶馆,茶').categories, { 历史街区: 1.3 });
});

test('零命中返回 null，不伪造类别', () => {
  assert.equal(preferencesFromInterests('极光,冰川'), null);
  assert.equal(preferencesFromInterests('   '), null);
  assert.equal(mapInterests('极光').hits.length, 0);
});

test('映射结果接入选点：喝茶在预算 60 时改选宽窄巷子且过 schema', () => {
  const preferences = preferencesFromInterests('喝茶');
  const base = planTour({ city: CITY, pois: POIS, budgetMin: 60 });
  const pref = planTour({ city: CITY, pois: POIS, budgetMin: 60, preferences });

  assert.ok(base.selected.length >= 1, `基础路线至少 1 站，实际 ${base.selected.join(',')}`);
  assert.ok(pref.selected.includes('cd-005'), `应命中宽窄巷子，实际 ${pref.selected.join(',')}`);
  assert.notDeepEqual(pref.selected, base.selected, '偏好应改变选点结果');
  const check = validateAgainstSchema(pref.script, SCHEMA);
  assert.equal(check.valid, true, JSON.stringify(check.issues));
});

test('命中类别但无坐标时，退回基线并给出「无可达站点」而非「未匹配」', () => {
  const preferences = preferencesFromInterests('看熊猫');
  assert.ok(preferences, '映射层应识别出自然保护地');
  assert.deepEqual(preferences.categories, { 自然保护地: 1.5 });

  const baseline = runResilient({ pois: POIS, validate, now: FIXED_NOW, input: { text: '成都 3 小时' } });
  const result = runResilient({
    pois: POIS,
    validate,
    now: FIXED_NOW,
    input: { text: '成都 3 小时，想去看熊猫' },
    preferences,
  });

  assert.ok(result.warnings.includes(WARNINGS.PREFERENCE_UNREACHABLE));
  assert.ok(!result.warnings.includes(WARNINGS.PREFERENCE_UNMATCHED));
  assert.deepEqual(
    result.script.route.map((s) => s.id),
    baseline.script.route.map((s) => s.id),
    '无可达站点时必须退回基线，不能假装偏好生效',
  );
  assert.equal(result.validation.valid, true);
});

test('部分类别不可达：仍按可达类别推荐，并明示熊猫那部分没生效', () => {
  const preferences = preferencesFromInterests('喝茶,看熊猫');
  assert.deepEqual(preferences.categories, { 历史街区: 1.3, 自然保护地: 1.5 });

  const result = runResilient({
    pois: POIS,
    validate,
    now: FIXED_NOW,
    input: { text: '成都 3 小时，喝茶顺便看熊猫' },
    preferences,
  });

  assert.ok(result.warnings.includes(WARNINGS.PREFERENCE_PARTIAL_UNREACHABLE));
  assert.ok(
    result.script.route.some((stop) => stop.id === 'cd-005'),
    '可达类别（历史街区）仍应生效',
  );
  assert.equal(result.validation.valid, true);
});

test('口语一个类别都没解析出来时，产物也要留下未匹配痕迹', () => {
  const result = runResilient({
    pois: POIS,
    validate,
    now: FIXED_NOW,
    input: { text: '成都 3 小时' },
    preferences: null,
    preferenceText: '极光,冰川',
  });

  assert.ok(result.warnings.includes(WARNINGS.PREFERENCE_UNMATCHED));
  assert.equal(result.validation.valid, true);
});
