import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runResilient, WARNINGS, isGarbled, sanitizePois } from '../src/agent/citywalk/resilience.js';
import { validateAgainstSchema } from '../tools/schema-check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = JSON.parse(fs.readFileSync(path.join(ROOT, 'knowledge', 'tour_script.schema.json'), 'utf8'));

const POIS = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'cities', 'chengdu', 'pois.geojson'), 'utf8')).features.map(
  (feature) => {
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
  },
);

const FIXED_NOW = '2026-11-20T00:00:00.000Z';
const validate = (script) => validateAgainstSchema(script, SCHEMA).issues ?? [];

const run = (overrides = {}) =>
  runResilient({ pois: POIS, validate, source: 'deepworks', now: FIXED_NOW, ...overrides });

const ids = (result) => (result.script ? result.script.route.map((stop) => stop.id) : []);

/* 场景 1：预算极低，选不出任何站点 → 保底 1 站 + 警告，不报错、不返回空数组 */
test('场景1 预算极低：保底 1 站，schema 合法，预算如实标注', () => {
  const result = run({ input: { text: '成都 20 分钟', budgetMin: 20 } });

  assert.equal(result.guard.status, 'fallback_1_stop');
  assert.equal(result.script.route.length, 1, 'route 必须保底 1 站（schema minItems=1）');
  assert.ok(result.warnings.includes(WARNINGS.BUDGET_TOO_LOW));
  assert.equal(result.script.meta.budget.input_min, 20, '不能把放宽后的预算伪装成用户预算');
  assert.ok(result.script.meta.budget.total_min > 20, '超时应如实暴露');
  assert.equal(result.script.route.length + result.script.meta.dropped.length, POIS.length, '候选必须守恒');

  const check = validateAgainstSchema(result.script, SCHEMA);
  assert.equal(check.valid, true, `schema 校验失败：${JSON.stringify(check.issues)}`);
});

/* 场景 2：偏好关键词零命中 → 退回无偏好基线选点，结果与不传偏好一致 */
test('场景2 偏好零命中：退回基线选点，结果与无偏好一致', () => {
  const baseline = run({ input: { text: '成都 3 小时', budgetMin: 180 } });
  const result = run({
    input: { text: '成都 3 小时，想看极光和冰川', budgetMin: 180 },
    preferences: { categories: ['极光', '冰川'] },
  });

  assert.ok(result.warnings.includes(WARNINGS.PREFERENCE_UNMATCHED));
  assert.deepEqual(ids(result), ids(baseline), '零命中时必须退回基线，不能伪造偏好路线');
  assert.equal(
    result.script.meta.budget.total_min,
    baseline.script.meta.budget.total_min,
    '选点与耗时都应与基线一致',
  );
  assert.equal(result.guard.status, 'ok', '零命中不是空路线，不应触发保底');

  const check = validateAgainstSchema(result.script, SCHEMA);
  assert.equal(check.valid, true, `schema 校验失败：${JSON.stringify(check.issues)}`);
});

/* 场景 3：路网文件缺失 / 解析失败 → 全部腿 fallback_straight + 警告 */
test('场景3 路网缺失或解析失败：腿一律 fallback_straight 并明示直线估算', () => {
  const missing = run({ input: { text: '成都 3 小时', budgetMin: 180 } });
  assert.equal(missing.network.available, false);
  assert.ok(missing.warnings.includes(WARNINGS.NETWORK_MISSING));
  for (const stop of missing.script.route) {
    if (stop.leg) assert.equal(stop.leg.routing_status, 'fallback_straight');
  }

  // 注入一个「文件存在但 JSON 坏掉」的假 fs，覆盖 parse_error 分支
  const brokenFs = { existsSync: () => true, readFileSync: () => '{ not json' };
  const broken = run({ input: { text: '成都 3 小时', budgetMin: 180 }, fsImpl: brokenFs });
  assert.equal(broken.network.status, 'parse_error');
  assert.ok(broken.warnings.includes(WARNINGS.NETWORK_MISSING));
  for (const stop of broken.script.route) {
    if (stop.leg) assert.equal(stop.leg.routing_status, 'fallback_straight');
  }

  assert.equal(validateAgainstSchema(missing.script, SCHEMA).valid, true);
  assert.equal(validateAgainstSchema(broken.script, SCHEMA).valid, true);
});

/* 场景 4：站点无资产（用户选 B：只写 warnings，不污染 route[].reason） */
test('场景4 资产缺失：只汇总一条全局警告，不改 route[].reason', () => {
  const result = run({ input: { text: '成都 3 小时', budgetMin: 180 } });

  const assetWarnings = result.warnings.filter((text) => text.includes('资产'));
  assert.equal(assetWarnings.length, 1, '全量缺失只允许一条汇总警告');
  assert.equal(assetWarnings[0], WARNINGS.ASSETS_MISSING);
  assert.ok(result.assets.all_missing);
  assert.equal(result.assets.missing_count, result.script.route.length);
  for (const stop of result.script.route) {
    assert.ok(!stop.reason.includes('资产'), 'route.reason 不应承载全局能力边界');
  }

  assert.equal(validateAgainstSchema(result.script, SCHEMA).valid, true);
});

/* 场景 5：输入乱码 / 超长 → 默认参数（成都、180 分钟、balanced）+ 警告 */
test('场景5 输入乱码或超长：归一到默认参数并明示', () => {
  assert.equal(isGarbled('\uFFFD\uFFFD\uFFFD\uFFFD'), true);
  assert.equal(isGarbled('成都半天喝茶'), false);

  const baseline = run({ input: { text: '成都 3 小时', budgetMin: 180 } });
  for (const text of ['\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD', '成'.repeat(2500)]) {
    const result = run({ input: text });
    assert.ok(result.warnings.includes(WARNINGS.INPUT_DEGRADED), `未提示解析失败：${text.slice(0, 8)}`);
    assert.equal(result.request.city.id, 'chengdu');
    assert.equal(result.request.budget_min, 180);
    assert.equal(result.request.pace, 'balanced', '契约无 normal，必须落到 balanced');
    assert.deepEqual(ids(result), ids(baseline));
    assert.equal(validateAgainstSchema(result.script, SCHEMA).valid, true);
  }

  // 完全没给输入属于「用默认值」，不是「解析失败」
  const absent = run({});
  assert.ok(!absent.warnings.includes(WARNINGS.INPUT_DEGRADED));
});

/* 场景 6：单站字段缺失 → 跳过 + dropped(kind=closed)，不拖垮整条路线 */
test('场景6 单站字段缺失：跳过并记入 dropped(kind=closed)，路线仍成立', () => {
  const dirty = [
    ...POIS,
    { id: 'bad-name', name: '', category: '城市公园', lat: 30.6, lng: 104.0 },
    { name: '缺 id 点位', category: '城市公园', lat: 30.61, lng: 104.01 },
    { id: 'bad-coord', name: '缺坐标点位', category: '城市公园' },
  ];

  const { clean, dropped } = sanitizePois(dirty);
  assert.equal(clean.length, POIS.length);
  assert.equal(dropped.length, 3);
  for (const item of dropped) {
    assert.equal(item.kind, 'closed', '契约没有 data_invalid，按用户决策借用 closed');
    assert.match(item.reason, /字段缺失/);
    assert.ok(item.id.length > 0, 'dropped.id 有 minLength 约束');
    assert.ok(item.name.length > 0, 'dropped.name 有 minLength 约束');
  }

  const result = run({ input: { text: '成都 3 小时', budgetMin: 180 }, pois: dirty });
  assert.ok(result.warnings.includes(WARNINGS.FIELD_MISSING(3)));
  assert.equal(result.script.route.length + result.script.meta.dropped.length, dirty.length, '候选必须守恒');
  assert.ok(!ids(result).some((id) => id.startsWith('bad-') || id.startsWith('missing-')));

  const check = validateAgainstSchema(result.script, SCHEMA);
  assert.equal(check.valid, true, `schema 校验失败：${JSON.stringify(check.issues)}`);
});
