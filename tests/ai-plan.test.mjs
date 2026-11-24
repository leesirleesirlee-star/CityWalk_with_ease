import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateAiPlan } from '../server/agent/validate-plan.js';
import { composeAiScript } from '../server/agent/composer.js';
import { buildMessages } from '../server/agent/prompt.js';
import { callDeepSeek } from '../server/agent/deepseek.js';
import { validateAgainstSchema } from '../tools/schema-check.mjs';
import { parseMasterIntent } from '../src/agent/citywalk/masterPipeline.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = JSON.parse(fs.readFileSync(path.join(ROOT, 'knowledge', 'tour_script.schema.json'), 'utf8'));

/** 3 个假 POI：坐标真实可算步行距离，summary 来自 catalog（不编造）。 */
const CATALOG = [
  {
    id: 'p1',
    name: '人民公园',
    category: '城市公园',
    tags: ['城市公园', '自然', '茶文化'],
    lat: 30.6594137,
    lng: 104.0554652,
    stay_min: 45,
    rating: 4.5,
    open: '06:00-22:00',
    summary: '人民公园是成都老牌城市公园，鹤鸣茶社是本地喝茶场景的代表。',
  },
  {
    id: 'p2',
    name: '宽窄巷子',
    category: '历史街区',
    tags: ['历史街区', '历史', '建筑'],
    lat: 30.6661912,
    lng: 104.051265,
    stay_min: 45,
    rating: 4.6,
    open: '全天',
    summary: '宽窄巷子由三条清代老巷组成，是成都历史街区的代表。',
  },
  {
    id: 'p3',
    name: '武侯祠',
    category: '历史祠庙',
    tags: ['历史祠庙', '历史'],
    lat: 30.6483863,
    lng: 104.0454567,
    stay_min: 40,
    rating: 4.7,
    open: '08:00-20:00',
    summary: '武侯祠是纪念诸葛亮与刘备的祠庙，成都三国文化地标。',
  },
];

const INTENT = {
  city_id: 'chengdu',
  city_name: '成都',
  budget_min: 240,
  mode: 'strict',
  pace: 'balanced',
  interests: ['历史', '茶文化'],
  constraints: ['low_walk'],
  start_time: '09:00',
};

function makePlan(stops = [
  { poi_id: 'p2', why: '先看历史街区，清早人少适合拍照', stay_min: 45 },
  { poi_id: 'p1', why: '在公园茶馆歇脚，体验成都慢生活', stay_min: 45 },
  { poi_id: 'p3', why: '以三国文化收尾，动线由北向南顺路', stay_min: 40 },
]) {
  return {
    interests: ['历史', '茶文化'],
    constraints: ['low_walk'],
    pace: 'balanced',
    stops,
    route_reason: '先历史街区再公园茶馆，最后三国祠庙，整体由北向南顺路。',
  };
}

function compose(plan, intentOverrides = {}) {
  return composeAiScript({
    text: '成都半天，想看历史、喝茶，少走路，预算4小时',
    intent: { ...INTENT, ...intentOverrides },
    plan: { ...plan, model: 'deepseek-chat', elapsed_ms: 1234 },
    catalog: CATALOG,
    now: '2026-11-24T00:00:00.000Z',
  });
}

test('ai-plan：合法 fixture 组装出 1.1.0 脚本并通过 schema', () => {
  const result = compose(makePlan());
  assert.equal(result.ok, true, JSON.stringify(result.errors || []));
  const { script } = result;

  assert.equal(script.schema_version, '1.1.0');
  assert.equal(script.meta.schema_version, '1.1.0');
  assert.equal(script.meta.source, 'llm');
  assert.equal(script.meta.pipeline_version, '1.1.0');
  assert.deepEqual(script.meta.city, { id: 'chengdu', name: '成都', pack_version: '0.1.0' });
  assert.equal(script.meta.budget.mode, 'strict');
  assert.equal(script.meta.budget.input_min, 240);
  assert.ok(Number.isInteger(script.meta.budget.total_min));
  assert.equal(script.meta.budget.breakdown.stay_min, 130);
  assert.equal(script.meta.dropped.length, 0);

  // 站序完全保持 AI 顺序（不重排）
  assert.equal(script.route.map((stop) => stop.id).join('->'), 'p2->p1->p3');
  assert.equal(script.route[0].leg, null);
  for (const stop of script.route.slice(1)) {
    assert.equal(stop.leg.routing_status, 'fallback_straight');
    assert.ok(stop.leg.distance_m >= 0);
    assert.ok(stop.leg.walk_min >= 0);
    assert.ok(stop.leg.from_id && stop.leg.to_id);
  }
  for (const [index, stop] of script.route.entries()) {
    assert.equal(stop.order, index + 1);
    assert.equal(stop.stay_min, [45, 45, 40][index]);
    assert.ok(stop.score >= 0 && stop.score <= 1);
    assert.ok(stop.reason.length >= 6);
    assert.deepEqual(stop.assets, { panorama: null, model3d: null, photo: null });
    // commentary 必须来自 catalog.summary，不得编造
    assert.equal(stop.commentary, CATALOG.find((poi) => poi.id === stop.id).summary);
    assert.ok(Number.isFinite(stop.lat) && Number.isFinite(stop.lng));
  }

  assert.equal(script.meta.agent_trace.length, 5);
  assert.deepEqual(
    script.meta.agent_trace.map((step) => step.label),
    ['解析需求', '加载城市包', 'AI 选点', '预算校验', '组装脚本'],
  );
  for (const step of script.meta.agent_trace) {
    assert.ok(Number.isInteger(step.duration_ms) && step.duration_ms >= 1);
    assert.ok(step.input_summary.length >= 1 && step.output_summary.length >= 1);
    assert.ok(Array.isArray(step.evidence_refs) && Array.isArray(step.warnings));
  }
  // 「AI 选点」步骤写明模型名与耗时
  assert.match(script.meta.agent_trace[2].output_summary, /deepseek-chat/);
  assert.match(script.meta.agent_trace[2].output_summary, /1234ms/);

  assert.equal(script.meta.validation.valid, true);
  assert.deepEqual(script.meta.validation.issues, []);
  assert.equal(script.meta.stats.poi_count, 3);
  assert.equal(script.meta.stats.total_duration_min, script.meta.budget.total_min);
  assert.ok(script.meta.stats.interest_coverage >= 0 && script.meta.stats.interest_coverage <= 1);
  assert.ok(['low', 'medium', 'high'].includes(script.meta.stats.walk_intensity));

  const check = validateAgainstSchema(script, SCHEMA);
  assert.equal(check.valid, true, `schema 校验应通过：${check.issues.join('；')}`);
});

test('ai-plan：未知 POI ID 丢弃并记录，有效站仍可组装', () => {
  const raw = JSON.stringify({
    ...makePlan(),
    stops: [
      { poi_id: 'p1', why: '公园喝茶体验成都慢生活', stay_min: 40 },
      { poi_id: 'ghost', why: '不存在的点', stay_min: 30 },
      { poi_id: 'p3', why: '三国文化收尾且顺路', stay_min: 35 },
    ],
  });
  const validated = validateAiPlan(raw, { catalog: CATALOG, budgetMin: 240 });

  assert.equal(validated.ok, true);
  assert.equal(validated.plan.stops.length, 2);
  assert.deepEqual(validated.plan.stops.map((stop) => stop.poi_id), ['p1', 'p3']);
  assert.ok(validated.warnings.some((warning) => warning.includes('未知 POI id')));
  assert.ok(validated.plan.dropped.some((item) => item.id === 'ghost' && item.reason === 'unknown_id'));

  const composed = compose(validated.plan);
  assert.equal(composed.ok, true);
  assert.equal(composed.script.route.length, 2);
});

test('ai-plan：重复站点去重，`json 围栏可解析', () => {
  const raw = '```json\n' + JSON.stringify({
    interests: ['历史'],
    constraints: ['low_walk', 'unknown_code'],
    pace: 'packed',
    route_reason: '去重后仍保留两站，按历史偏好串联。',
    stops: [
      { poi_id: 'p1', why: '先在公园喝茶体验市井生活', stay_min: 30 },
      { poi_id: 'p1', why: '重复出现的公园', stay_min: 30 },
      { poi_id: 'p2', why: '再到历史街区看清代老巷', stay_min: 50 },
    ],
  }) + '\n```';
  const validated = validateAiPlan(raw, { catalog: CATALOG, budgetMin: 240 });

  assert.equal(validated.ok, true);
  assert.deepEqual(validated.plan.stops.map((stop) => stop.poi_id), ['p1', 'p2']);
  assert.equal(validated.plan.pace, 'packed');
  assert.deepEqual(validated.plan.constraints, ['low_walk']);
  assert.ok(validated.warnings.some((warning) => warning.includes('重复 POI')));
  assert.ok(validated.warnings.some((warning) => warning.includes('unknown_code')));
});

test('ai-plan：stay_min 会被 clamp 到 15–120', () => {
  const raw = JSON.stringify({
    ...makePlan(),
    stops: [
      { poi_id: 'p1', why: '公园喝茶体验成都慢生活', stay_min: 5 },
      { poi_id: 'p2', why: '历史街区看清代码头的古巷', stay_min: 999 },
    ],
  });
  const validated = validateAiPlan(raw, { catalog: CATALOG, budgetMin: 240 });
  assert.equal(validated.ok, true);
  assert.deepEqual(validated.plan.stops.map((stop) => stop.stay_min), [15, 120]);
});

test('ai-plan：有效站 < 2 返回 NO_CANDIDATES', () => {
  const raw = JSON.stringify({
    ...makePlan(),
    stops: [
      { poi_id: 'p1', why: '公园喝茶体验成都慢生活', stay_min: 30 },
      { poi_id: 'ghost-a', why: '不存在', stay_min: 30 },
      { poi_id: 'ghost-b', why: '不存在', stay_min: 30 },
    ],
  });
  const validated = validateAiPlan(raw, { catalog: CATALOG, budgetMin: 240 });

  assert.equal(validated.ok, false);
  assert.equal(validated.plan, null);
  assert.equal(validated.errors[0].code, 'NO_CANDIDATES');
});

test('ai-plan：非法 JSON 返回 INVALID_JSON', () => {
  const validated = validateAiPlan('这不是 JSON', { catalog: CATALOG, budgetMin: 240 });
  assert.equal(validated.ok, false);
  assert.equal(validated.errors[0].code, 'INVALID_JSON');
});

test('ai-plan：超预算从队尾截断并记录 cut_stops，至少留 2 站', () => {
  const result = compose(makePlan(), { budget_min: 70 });

  assert.equal(result.ok, true, JSON.stringify(result.errors || []));
  assert.equal(result.script.route.length, 2, '预算 70 分钟应截断到 2 站');
  assert.equal(result.cut_stops.length, 1);
  assert.equal(result.cut_stops[0].id, 'p3');
  assert.ok(result.cut_stops[0].reason.includes('70'));
  assert.ok(result.script.meta.budget.total_min <= 70, '截断后总时长应回到预算内');
  assert.ok(result.script.meta.budget.total_min > 0);
  assert.ok(result.script.meta.agent_trace[3].warnings.length >= 1, '预算校验步骤需记录截断');
  assert.equal(validateAgainstSchema(result.script, SCHEMA).valid, true);
});

test('ai-plan：prompt 的候选表包含所有必需列且预算固定', () => {
  const messages = buildMessages({ text: '成都半天 喝茶', intent: INTENT, catalog: CATALOG });
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content, /成都城市漫游规划师/);
  const user = messages[1].content;
  assert.match(user, /id \| name \| category \| tags \| lat,lng \| stay_min \| rating \| open/);
  assert.match(user, /预算 240 分钟/);
  assert.match(user, /不得修改/);
  assert.match(user, /p1 \| 人民公园/);
  assert.match(user, /只输出 JSON/);
});

test('ai-plan：compose 拒绝不足 2 站的计划', () => {
  const result = compose(makePlan([{ poi_id: 'p1', why: '公园喝茶体验成都慢生活', stay_min: 30 }]));
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'NO_CANDIDATES');
});

test('deepseek：5xx 重试 1 次后成功，请求体符合契约（离线 fake fetch）', async () => {
  const previousKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'sk-test-unit';
  try {
    let calls = 0;
    let captured = null;
    const fakeFetch = async (url, init) => {
      calls += 1;
      captured = { url, init };
      if (calls === 1) {
        return { ok: false, status: 503, text: async () => 'busy' };
      }
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            model: 'deepseek-chat',
            choices: [{ message: { content: '{"stops":[]}' } }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          }),
      };
    };

    const result = await callDeepSeek([{ role: 'user', content: '成都半天' }], { fetchImpl: fakeFetch });
    assert.equal(calls, 2, '5xx 应重试 1 次');
    assert.equal(captured.url, 'https://api.deepseek.com/chat/completions');
    assert.equal(captured.init.method, 'POST');
    const body = JSON.parse(captured.init.body);
    assert.equal(body.temperature, 0.2);
    assert.equal(body.max_tokens, 1200);
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.equal(body.stream, false);
    assert.equal(result.content, '{"stops":[]}');
    assert.equal(result.model, 'deepseek-chat');
    assert.equal(result.usage.completion_tokens, 5);
    assert.ok(Number.isFinite(result.elapsed_ms) && result.elapsed_ms >= 0);
  } finally {
    if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousKey;
  }
});

test('deepseek：4xx 不重试，抛带 code 的错误且不含 Key', async () => {
  const previousKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'sk-secret-should-not-leak';
  try {
    let calls = 0;
    const fakeFetch = async () => {
      calls += 1;
      return { ok: false, status: 401, text: async () => '{"error":"invalid api key"}' };
    };
    await assert.rejects(
      () => callDeepSeek([{ role: 'user', content: 'hi' }], { fetchImpl: fakeFetch }),
      (error) => {
        assert.equal(error.code, 'AUTH_FAILED');
        assert.equal(error.retryable, false);
        assert.ok(!String(error.message).includes('sk-secret-should-not-leak'));
        return true;
      },
    );
    assert.equal(calls, 1, '4xx 不应重试');
  } finally {
    if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousKey;
  }
});

test('deepseek：未配置 Key 抛 NOT_CONFIGURED（不发请求）', async () => {
  const previousKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = '';
  try {
    let called = false;
    await assert.rejects(
      () =>
        callDeepSeek([{ role: 'user', content: 'hi' }], {
          fetchImpl: async () => {
            called = true;
            throw new Error('不应被调用');
          },
        }),
      (error) => {
        assert.equal(error.code, 'NOT_CONFIGURED');
        return true;
      },
    );
    assert.equal(called, false);
  } finally {
    if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousKey;
  }
});

test('最少站数：5个景点以上被解析，并在 240 分钟内保住 5 站', () => {
  const parsed = parseMasterIntent('成都4小时，多看历史人文景点，5个景点以上');
  assert.equal(parsed.intent.min_stops, 5);

  const catalog = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'data', 'cities', 'chengdu', 'route-catalog.json'), 'utf8'),
  ).candidates;
  const ids = ['cd-007', 'cd-005', 'cd-106', 'cd-107', 'cd-105'];
  const plan = {
    interests: ['历史'],
    constraints: [],
    pace: 'balanced',
    stops: ids.map((id) => ({ poi_id: id, why: '历史人文顺路', intro: '一句话介绍', stay_min: 60 })),
    route_reason: '由西向东顺路串联',
  };
  const result = composeAiScript({ text: '5个景点以上', intent: parsed.intent, plan, catalog });
  assert.equal(result.ok, true);
  assert.ok(result.script.route.length >= 5, `route=${result.script.route.length}`);
  assert.equal(result.cut_stops?.length || 0, 0, '不应把用户要求的 5 站截断');
  assert.equal(validateAgainstSchema(result.script, SCHEMA).valid, true);
});