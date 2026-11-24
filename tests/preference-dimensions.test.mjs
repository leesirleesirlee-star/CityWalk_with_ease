import assert from 'node:assert/strict';
import test from 'node:test';

import { runMasterPipeline } from '../src/agent/citywalk/masterPipeline.js';
import { parseFuzzyTime, buildPreferenceProfile } from '../src/agent/citywalk/interestMap.js';

function run(text) {
  const result = runMasterPipeline(text);
  assert.equal(result.ok, true, `${text} 应生成合法脚本`);
  return result;
}

test('T4.13 人群维度：带老人解析为 relaxed 且停留系数 1.2', () => {
  const result = run('成都半天，带爸妈逛逛，不要太累');
  const prefs = result.intent.preferences;
  assert.equal(prefs.crowd, 'elderly');
  assert.equal(prefs.crowd_label, '带长辈');
  assert.equal(result.intent.pace, 'relaxed');
  assert.equal(result.intent.stay_factor, 1.2);
  assert.ok(prefs.hits.includes('带爸妈'));
});

test('T4.13 餐饮维度：找美食加权 1.5，不安排餐饮降权 0.3', () => {
  const need = run('成都4小时，找美食，顺路吃点小吃');
  assert.equal(need.intent.preferences.dining, 'need');
  assert.equal(need.intent.preferences.dining_label, '需要餐饮');
  assert.equal(need.intent.preferences.weightOf('民俗夜市'), 1.5);
  assert.equal(need.intent.preferences.weightOf('历史街区'), 1.5);

  const skip = run('成都3小时，只逛景点，不安排吃饭');
  assert.equal(skip.intent.preferences.dining, 'skip');
  assert.equal(skip.intent.preferences.dining_label, '不安排餐饮');
  assert.equal(skip.intent.preferences.weightOf('民俗夜市'), 0.3);
  assert.equal(skip.intent.preferences.weightOf('历史街区'), 0.3);
});

test('T4.13 模糊时间：半天/大半天/一上午/一下午映射正确', () => {
  assert.equal(parseFuzzyTime('成都半天').minutes, 240);
  assert.equal(parseFuzzyTime('成都大半天').minutes, 300);
  assert.equal(parseFuzzyTime('成都一上午').minutes, 180);
  assert.equal(parseFuzzyTime('成都一下午').minutes, 240);
  assert.equal(parseFuzzyTime('成都一整天').minutes, 480);
  assert.equal(parseFuzzyTime('成都3小时'), null);

  assert.equal(run('成都大半天随便走走').intent.budget_min, 300);
  assert.equal(run('成都半天随便走走').intent.budget_min, 240);
  // 显式数字优先级高于模糊词
  assert.equal(run('成都半天，预算2小时').intent.budget_min, 120);
});

test('T4.13 多维组合：人群 + 餐饮 + 节奏同时命中', () => {
  const profile = buildPreferenceProfile('成都一下午，带娃找美食，慢慢看');
  assert.equal(profile.crowd, 'family');
  assert.equal(profile.dining, 'need');
  assert.equal(profile.tempo, 'deep');
  assert.equal(profile.stay_factor, 1.56); // 1.2 × 1.3
  assert.equal(profile.pace, 'relaxed');
  assert.equal(profile.weightOf('民俗夜市'), 1.5);

  const result = run('成都一下午，带娃找美食，慢慢看');
  assert.equal(result.intent.budget_min, 240);
  assert.equal(result.intent.stay_factor, 1.56);
});

test('T4.13 兼容性：经典三组输入站点集合与预算稳定', () => {
  const cases = [
    ['成都半天，想喝茶、拍照、少走路，预算3小时', 180, 134, 3, 21],
    ['成都4小时，多看历史人文景点', 240, 178, 4, 20],
    ['成都3小时，尽量少走路，休闲为主', 180, 134, 3, 21],
  ];
  for (const [text, budget, total, stops, dropped] of cases) {
    const result = run(text);
    assert.equal(result.intent.budget_min, budget, `${text} 预算`);
    assert.equal(result.script.meta.budget.total_min, total, `${text} 总时长`);
    assert.equal(result.script.route.length, stops, `${text} 站点数`);
    assert.equal(result.script.meta.dropped.length, dropped, `${text} dropped 数`);
    // 新维度未命中时不应改变选点
    assert.equal(result.intent.preferences.dining, null);
    assert.equal(result.intent.preferences.crowd, null);
    assert.equal(result.intent.preferences.tempo, null);
  }
});
