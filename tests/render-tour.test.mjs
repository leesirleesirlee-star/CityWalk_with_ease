import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseTourScript, legStyleOf, classifyDrop } from '../src/ui/renderTour.js';

const readSample = (name) =>
  JSON.parse(fs.readFileSync(new URL(`../data/cities/chengdu/${name}`, import.meta.url), 'utf8'));

const base = readSample('tour_script.chengdu.json');
const degraded = readSample('tour_script.chengdu-degraded.json');

test('render-tour：模块可在 node 环境 import（无 DOM 副作用）', () => {
  assert.equal(typeof parseTourScript, 'function');
  assert.equal(typeof legStyleOf, 'function');
  assert.equal(typeof classifyDrop, 'function');
});

test('render-tour：fallback_straight 判定为虚线', () => {
  const model = parseTourScript(base);
  assert.equal(model.stops.length, 2);
  assert.equal(model.stops[0].leg, null, '首站不应有 leg');
  assert.equal(model.stops[1].leg.status, 'fallback_straight');
  assert.equal(model.stops[1].leg.style.dash, '8 6');
  assert.notEqual(model.stops[1].leg.style.stroke, '#8f8f8f');
});

test('render-tour：network 判定为实线、unavailable 判定为灰色虚线', () => {
  assert.equal(legStyleOf('network').dash, null);
  assert.equal(legStyleOf('network').stroke, '#2f9e63');
  assert.equal(legStyleOf('unavailable').dash, '4 6');
  assert.equal(legStyleOf('unavailable').stroke, '#8f8f8f');
  assert.equal(legStyleOf('something_else').dash, '4 6', '未知状态按降级虚线处理');
});

test('render-tour：warnings 原样进入渲染模型', () => {
  const m1 = parseTourScript(base);
  assert.equal(m1.warnings.length, 1);
  assert.match(m1.warnings[0], /路网未验证/);

  const m2 = parseTourScript(degraded);
  assert.equal(m2.warnings.length, 1);
  assert.match(m2.warnings[0], /DEGRADED_SAMPLE/);
  assert.match(m2.warnings[0], /fallback_straight/);
});

test('render-tour：reason 含 coord_source=unmatched 一律显示「缺少坐标」', () => {
  const model = parseTourScript(base);
  const missing = model.drops.filter((d) => d.bucket === 'missingCoord');
  assert.equal(missing.length, 5);
  missing.forEach((d) => {
    assert.equal(d.label, '缺少坐标');
    assert.equal(d.kind, 'score_below_threshold', 'kind 仍是评分枚举，但展示口径必须是缺少坐标');
    assert.match(d.reason, /coord_source=unmatched/);
  });
  assert.equal(model.dropSummary.missingCoord, 5);
  assert.equal(model.dropSummary.overBudget, 3);
  assert.equal(model.drops.filter((d) => d.label === '评分过低').length, 0, '本样例不应出现「评分过低」');
});

test('render-tour：其余 kind 按枚举映射，预算超限不写成评分过低', () => {
  assert.deepEqual(classifyDrop({ kind: 'budget_exceeded', reason: '加入后总时长 192.6 分钟超过上限 180 分钟' }), {
    bucket: 'overBudget',
    label: '超出预算',
  });
  assert.deepEqual(classifyDrop({ kind: 'score_below_threshold', reason: '综合评分 0.003 低于阈值' }), {
    bucket: 'lowScore',
    label: '评分过低',
  });
  assert.equal(classifyDrop({ kind: 'closed', reason: '临时闭馆' }).label, '已关闭');
  assert.equal(classifyDrop({ kind: 'not_selected', reason: '未进入前 N' }).label, '未入选');
  assert.equal(classifyDrop({ kind: 'user_removed', reason: '用户手动删掉' }).label, '用户移除');
  assert.equal(classifyDrop({ kind: 'unknown_kind', reason: 'x' }).label, '其他原因');
});

test('render-tour：空 route 与非法输入', () => {
  const empty = parseTourScript({ schema_version: '1.1.0', meta: { validation: { warnings: [] }, dropped: [] }, route: [] });
  assert.deepEqual(empty.stops, []);
  assert.deepEqual(empty.drops, []);
  assert.deepEqual(empty.dropSummary, {});
  assert.throws(() => parseTourScript(null), /tour_script 为空/);
});
