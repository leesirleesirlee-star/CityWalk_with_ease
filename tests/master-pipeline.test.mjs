import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMasterPipeline } from '../src/agent/citywalk/masterPipeline.js';
import { validateAgainstSchema } from '../tools/schema-check.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'knowledge', 'tour_script.schema.json'), 'utf8'));

test('总控入口：标准输入产出符合 1.1.0 契约的完整脚本', () => {
  const result = runMasterPipeline('成都半天，想喝茶、拍照、少走路，预算3小时');

  assert.equal(result.ok, true, `期望成功，实际 stage=${result.stage} error=${JSON.stringify(result.error)}`);
  assert.equal(result.stage, 'done');
  assert.equal(result.error, null);

  const script = result.script;
  assert.ok(script, '应产出脚本');
  assert.equal(script.schema_version, '1.1.0');
  assert.ok(script.route.length > 0, '至少 1 站');
  const candidateCount = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'cities', 'chengdu', 'pois.geojson'), 'utf8')).features.length;
  assert.equal(script.route.length + script.meta.dropped.length, candidateCount, 'route + dropped 应等于候选总数');
  assert.equal(result.intent.budget_min, 180, '「预算3小时」应解析为 180 分钟');
  assert.equal(result.intent.pace, 'relaxed', '「少走路」应解析为 relaxed');
  assert.ok(script.route.every((stop) => typeof stop.commentary === 'string' || stop.commentary === null));

  const check = validateAgainstSchema(script, schema);
  assert.equal(check.valid, true, `schema 校验应通过：${JSON.stringify(check.issues)}`);
  assert.equal(result.validation.valid, true);
});

test('总控入口：空输入、乱码与极端预算均降级返回，不抛异常', () => {
  const cases = [
    { label: '空输入', input: '' },
    { label: '纯空白', input: '   ' },
    { label: '乱码', input: '   ' },
    { label: '极低预算', input: '成都30分钟看看' },
    { label: '非字符串', input: null },
  ];

  for (const item of cases) {
    let result;
    assert.doesNotThrow(() => {
      result = runMasterPipeline(item.input);
    }, `${item.label} 不应抛异常`);

    assert.equal(typeof result.ok, 'boolean', `${item.label} 应返回结构化结果`);
    assert.ok(Array.isArray(result.logs) && result.logs.length > 0, `${item.label} 应保留执行日志`);
    assert.ok(result.intent, `${item.label} 应保留解析后的参数`);

    if (result.script) {
      const check = validateAgainstSchema(result.script, schema);
      assert.equal(check.valid, true, `${item.label} 降级产物仍应满足契约`);
      assert.ok(result.intent.budget_min >= 30 && result.intent.budget_min <= 720);
    } else {
      assert.equal(result.ok, false, `${item.label} 无脚本时 ok 应为 false`);
      assert.ok(result.error && result.error.code, `${item.label} 应给出结构化错误码`);
    }
  }

  const empty = runMasterPipeline('');
  assert.ok(
    empty.warnings.some((w) => w.includes('EMPTY_INPUT')),
    '空输入应留下 EMPTY_INPUT 警告，而不是静默使用默认值',
  );
});
