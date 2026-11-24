import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { adjustTour, runResilient, WARNINGS } from '../src/agent/citywalk/resilience.js';
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

const FIXED_NOW = '2026-11-20T00:00:00.000Z';
const validate = (script) => validateAgainstSchema(script, SCHEMA).issues ?? [];
const ids = (script) => script.route.map((stop) => stop.id);
const hash = (script) => createHash('sha256').update(JSON.stringify(script)).digest('hex');

const baseFor = (budgetMin) =>
  runResilient({
    pois: POIS,
    validate,
    now: FIXED_NOW,
    source: 'deepworks',
    input: { text: `成都 ${budgetMin} 分钟`, budgetMin },
  }).script;

/* 用例 1：追加偏好后站点集合发生变化 */
test('用例1 追加偏好后站点集合与基础路线不一致', () => {
  const base = baseFor(180);
  const adjusted = adjustTour(base, '换成喝茶主题');

  assert.notDeepEqual(ids(adjusted.script), ids(base), '偏好调整后路线应发生变化');
  assert.ok(ids(adjusted.script).includes('cd-005'), '喝茶应命中宽窄巷子');
  assert.equal(adjusted.rejected, false);
  assert.equal(adjusted.script.route.length + adjusted.script.meta.dropped.length, POIS.length, '候选守恒');
  assert.equal(validateAgainstSchema(adjusted.script, SCHEMA).valid, true);
});

/* 用例 2：strict 模式下总时长不超预算 */
test('用例2 strict 模式下总时长不超过预算上限', () => {
  for (const budgetMin of [180, 60]) {
    const base = baseFor(budgetMin);
    const adjusted = adjustTour(base, '喝茶');

    assert.equal(adjusted.script.meta.budget.mode, 'strict');
    assert.ok(
      adjusted.script.meta.budget.total_min <= budgetMin,
      `预算 ${budgetMin} 时总时长 ${adjusted.script.meta.budget.total_min} 超限`,
    );
    assert.equal(validateAgainstSchema(adjusted.script, SCHEMA).valid, true);
  }
});

/* 用例 3：同输入两次运行完全一致 */
test('用例3 同输入连续运行两次输出 deep-equal 且哈希一致', () => {
  const base = baseFor(180);
  const first = adjustTour(base, '喝茶');
  const second = adjustTour(base, '喝茶');

  assert.deepEqual(first.script, second.script);
  assert.equal(hash(first.script), hash(second.script));
  assert.equal(first.script.meta.generated_at, FIXED_NOW, '时间戳必须固定，不能引入当前时间');
});

/* 用例 4：连续两次不同偏好，结构与预算都合规 */
test('用例4 连续两次追加不同偏好后结构合法、预算合规', () => {
  const base = baseFor(180);
  const round1 = adjustTour(base, '喝茶');
  const round2 = adjustTour(round1.script, '顺便看熊猫', { preferences: round1.preferences });

  assert.deepEqual(
    Object.keys(round2.preferences.categories).sort(),
    ['历史街区', '自然保护地'].sort(),
    '第二轮应继承第一轮偏好并合并新类别',
  );
  assert.ok(round2.warnings.includes(WARNINGS.PREFERENCE_PARTIAL_UNREACHABLE), '熊猫无坐标必须明示');
  assert.ok(round2.script.meta.budget.total_min <= 180);
  assert.equal(round2.script.route.length + round2.script.meta.dropped.length, POIS.length, '候选守恒');
  assert.equal(validateAgainstSchema(round2.script, SCHEMA).valid, true);
});
