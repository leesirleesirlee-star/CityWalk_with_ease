import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAgainstSchema } from '../tools/schema-check.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schema = JSON.parse(
  fs.readFileSync(path.join(root, 'knowledge', 'tour_script.schema.json'), 'utf8'),
);
const fixture = JSON.parse(
  fs.readFileSync(path.join(root, 'tests', 'fixtures', 'tour_script.sample.json'), 'utf8'),
);
const clone = () => structuredClone(fixture);

test('1.1.0 fixture 通过 schema 校验', () => {
  const { valid, issues } = validateAgainstSchema(fixture, schema);
  assert.equal(valid, true, `fixture 不合法：\n${issues.join('\n')}`);
  assert.equal(fixture.schema_version, '1.1.0');
});

test('1.1.0 预算账本自洽：total = walk + stay 且不超预算', () => {
  const budget = fixture.meta.budget;
  assert.equal(
    budget.total_min,
    Math.round(budget.breakdown.walk_min + budget.breakdown.stay_min),
    'total_min 必须等于步行与停留之和',
  );
  assert.ok(budget.total_min <= budget.input_min, '总时长不得超过输入预算');
  assert.equal(budget.mode, 'strict');
});

test('1.1.0 入选与舍弃之和等于候选总数', () => {
  const candidates = 10; // CityPack chengdu 当前登记的景点数
  assert.equal(
    fixture.route.length + fixture.meta.dropped.length,
    candidates,
    '任何一个候选都必须有去处：要么入选，要么在 dropped 里说明原因',
  );
  const ids = new Set([
    ...fixture.route.map((s) => s.id),
    ...fixture.meta.dropped.map((d) => d.id),
  ]);
  assert.equal(ids.size, candidates, '不允许同一个候选同时出现在 route 和 dropped');
});

test('1.1.0 站点 leg 链首尾相接，首站 leg 为 null', () => {
  assert.equal(fixture.route[0].leg, null, '首站不应有 leg');
  for (let i = 1; i < fixture.route.length; i += 1) {
    const prev = fixture.route[i - 1];
    const stop = fixture.route[i];
    assert.equal(stop.leg.from_id, prev.id, `第 ${i + 1} 站 leg.from_id 必须等于上一站 id`);
    assert.equal(stop.leg.to_id, stop.id, `第 ${i + 1} 站 leg.to_id 必须等于本站 id`);
    assert.ok(stop.leg.distance_m > 0, 'leg 距离必须为正');
    assert.ok(stop.leg.walk_min > 0, 'leg 步行时间必须为正');
  }
});

test('1.1.0 五步 agent_trace 每步都有耗时与摘要', () => {
  const steps = fixture.meta.agent_trace;
  assert.equal(steps.length, 5);
  for (const [i, step] of steps.entries()) {
    assert.equal(step.step, i + 1, `第 ${i + 1} 步编号应为 ${i + 1}`);
    assert.ok(step.duration_ms > 0, 'duration_ms 必须大于 0，否则等于没跑');
    assert.ok(step.input_summary.length > 0 && step.output_summary.length > 0);
    assert.ok(Array.isArray(step.evidence_refs));
  }
});

test('1.1.0 变异：删除 commentary 必须判 invalid', () => {
  const bad = clone();
  delete bad.route[0].commentary;
  const { valid, issues } = validateAgainstSchema(bad, schema);
  assert.equal(valid, false);
  assert.ok(issues.some((i) => /commentary/.test(i)), issues.join(' | '));
});

test('1.1.0 变异：routing_status 取值非法必须判 invalid', () => {
  const bad = clone();
  bad.route[2].leg.routing_status = 'straight_guess';
  const { valid, issues } = validateAgainstSchema(bad, schema);
  assert.equal(valid, false);
  assert.ok(issues.some((i) => /routing_status/.test(i)), issues.join(' | '));
});

test('1.1.0 变异：agent_trace 少于五步必须判 invalid', () => {
  const bad = clone();
  bad.meta.agent_trace = bad.meta.agent_trace.slice(0, 4);
  const { valid, issues } = validateAgainstSchema(bad, schema);
  assert.equal(valid, false);
});

test('1.1.0 变异：预算 breakdown 缺 stay_min 必须判 invalid', () => {
  const bad = clone();
  delete bad.meta.budget.breakdown.stay_min;
  const { valid, issues } = validateAgainstSchema(bad, schema);
  assert.equal(valid, false);
  assert.ok(issues.some((i) => /stay_min/.test(i)), issues.join(' | '));
});

test('1.1.0 变异：dropped 缺少 kind 必须判 invalid', () => {
  const bad = clone();
  delete bad.meta.dropped[0].kind;
  const { valid } = validateAgainstSchema(bad, schema);
  assert.equal(valid, false);
});

test('1.1.0 与 1.0.0 互不串味：1.0.0 字段塞进 1.1.0 必须判 invalid', () => {
  const bad = clone();
  bad.route[0].poi_id = 'cd_renmin_park';
  const { valid } = validateAgainstSchema(bad, schema);
  assert.equal(valid, false, '1.1.0 不应接受 1.0.0 的 route 字段');
});
