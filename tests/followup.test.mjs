import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  runMasterPipeline,
  createTourSession,
  followUpTour,
} from '../src/agent/citywalk/masterPipeline.js';
import { adjustTour } from '../src/agent/citywalk/resilience.js';
import { validateAgainstSchema } from '../tools/schema-check.mjs';

const SCHEMA = JSON.parse(fs.readFileSync(new URL('../knowledge/tour_script.schema.json', import.meta.url), 'utf8'));
const PROMPT = '成都半天，想喝茶、拍照，预算3小时';

function newSession() {
  const base = runMasterPipeline(PROMPT);
  assert.equal(base.ok, true, '基线必须生成成功');
  return { base, session: createTourSession(base, PROMPT) };
}

const ids = (script) => script.route.map((stop) => stop.id);

test('追加人文偏好后，站点顺序与 adjustTour 行为一致', () => {
  const { base, session } = newSession();
  const expected = adjustTour(base.script, '多看历史人文');
  const result = followUpTour(session, '多看历史人文');

  assert.equal(result.ok, true);
  assert.equal(result.kind, 'preference');
  assert.deepEqual(ids(result.script), ids(expected.script));
  assert.ok(Object.keys(result.preferences?.categories ?? {}).length > 0, '偏好权重应被累积');
});

test('连续两次追问后输出结构合法且预算合规', () => {
  const { session } = newSession();
  const first = followUpTour(session, '多看历史人文');
  assert.equal(first.ok, true);
  const second = followUpTour(session, '再加一站');
  assert.equal(second.ok, true);
  assert.equal(second.kind, 'count');

  const { valid, issues } = validateAgainstSchema(second.script, SCHEMA);
  assert.equal(valid, true, issues.join('；'));
  assert.ok(
    second.script.meta.budget.total_min <= second.intent.budget_min,
    `total_min=${second.script.meta.budget.total_min} budget=${second.intent.budget_min}`,
  );
  assert.equal(session.history.length, 2);
});

test('重置指令清空上下文并回到初始参数结果', () => {
  const { base, session } = newSession();
  const initialIds = ids(base.script);
  const initialBudget = base.intent.budget_min;

  followUpTour(session, '多看历史人文');
  followUpTour(session, '放慢节奏');
  const reset = followUpTour(session, '重新来');

  assert.equal(reset.ok, true);
  assert.equal(reset.kind, 'reset');
  assert.deepEqual(ids(reset.script), initialIds);
  assert.equal(reset.intent.budget_min, initialBudget);
  assert.equal(reset.preferences, null);
  assert.equal(session.history.at(-1), '已清空追问上下文，按初始参数重新生成。');
});

test('无法识别的追问返回结构化提示且不改动当前路线', () => {
  const { session } = newSession();
  const before = ids(session.script);

  let result;
  assert.doesNotThrow(() => {
    result = followUpTour(session, '给我来点魔法');
  });

  assert.equal(result.ok, false);
  assert.equal(result.kind, 'unknown');
  assert.equal(typeof result.message, 'string');
  assert.ok(result.message.length > 0);
  assert.deepEqual(ids(result.script), before);
  assert.equal(result.session, session);
});
