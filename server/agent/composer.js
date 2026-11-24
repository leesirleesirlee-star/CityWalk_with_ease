/**
 * AI 计划 → tour_script 1.1.0 组装器（服务端）。
 *
 * 输入：用户原话、系统意图 intent、validate-plan 归一化后的 plan、候选 catalog、生成时间 now。
 * 输出：{ ok, script?, cut_stops?, warnings?, errors? }
 *
 * 关键约定：
 *   - 站序完全按 AI 给出顺序（orderFixedSequence 不重排）；
 *   - 总时长超预算时从队尾删站并重算，至少保留 2 站；
 *   - commentary 只取 catalog.summary，不编造；
 *   - 最终用 knowledge/tour_script.schema.json + validateAgainstSchema 校验。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { orderFixedSequence } from '../../src/agent/routeSequence.js';
import { validateAgainstSchema } from '../../tools/schema-check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCHEMA_FILE = path.join(ROOT, 'knowledge', 'tour_script.schema.json');

const MIN_STOPS = 2;
const DEFAULT_BUDGET_MIN = 180;
const PACES = new Set(['relaxed', 'balanced', 'packed']);

let schemaCache = null;
function loadSchema() {
  if (!schemaCache) schemaCache = JSON.parse(fs.readFileSync(SCHEMA_FILE, 'utf8'));
  return schemaCache;
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round1 = (value) => Math.round(value * 10) / 10;
const round2 = (value) => Math.round(value * 100) / 100;
const round3 = (value) => Math.round(value * 1000) / 1000;

/** 兴趣 → 关键词（只用于统计覆盖度与评分，不参与选点）。 */
const INTEREST_WORDS = Object.freeze({
  茶文化: ['茶'],
  摄影: ['拍照', '机位', '出片', '打卡', '景'],
  历史: ['历史', '祠', '寺', '古', '三国', '文化'],
  美食: ['美食', '小吃', '吃', '夜宵', '夜市'],
  市井: ['市井', '老街', '巷', '烟火', '生活'],
  自然: ['公园', '园林', '自然', '江', '绿化'],
  夜景: ['夜景', '夜', '灯', '河岸'],
  建筑: ['建筑', '街区', '楼', '立面', '院'],
});

function haystackOf(poi) {
  const tags = Array.isArray(poi?.tags) ? poi.tags.join(' ') : '';
  return `${poi?.name || ''} ${poi?.category || ''} ${tags} ${poi?.summary || ''}`;
}

function interestMatches(interest, poi) {
  const words = INTEREST_WORDS[interest] || [String(interest)];
  const hay = haystackOf(poi);
  return words.some((word) => word && hay.includes(word));
}

function uniqueStrings(list) {
  const seen = new Set();
  const out = [];
  for (const value of list) {
    const text = String(value ?? '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function walkIntensity(walkMin) {
  if (walkMin <= 30) return 'low';
  if (walkMin <= 75) return 'medium';
  return 'high';
}

function commentaryOf(poi) {
  const summary = typeof poi?.summary === 'string' ? poi.summary.trim() : '';
  if (summary) return summary;
  return `${poi?.name || poi?.id || '该点位'}（${poi?.category || '城市漫游'}）`;
}

function ensureReason(why, poi, interests) {
  let reason = typeof why === 'string' ? why.trim() : '';
  if (reason.length < 6) {
    const interestText = interests.length ? interests.join('、') : '本次偏好';
    reason = `${reason}${reason ? '，' : ''}${poi?.name || poi?.id || '该点位'}契合${interestText}且顺路`;
  }
  return reason.slice(0, 120);
}

/**
 * @param {object} input
 * @param {string} [input.text] 用户原话
 * @param {object} [input.intent] parseMasterIntent 输出的基础意图（预算/节奏/开始时间由系统给定）
 * @param {object} input.plan validateAiPlan 归一化后的 plan（可附带 model/elapsed_ms/timings）
 * @param {Array<object>} [input.catalog] 有坐标的候选 POI
 * @param {string} [input.now] ISO 时间字符串（不传则取当前时间）
 * @returns {{ ok: boolean, script?: object, cut_stops?: Array<object>, warnings?: string[],
 *             errors?: Array<{code:string,message:string}>, totals?: object }}
 */
export function composeAiScript({ text = '', intent = {}, plan, catalog = [], now } = {}) {
  const warnings = [];

  if (!plan || !Array.isArray(plan.stops) || plan.stops.length < MIN_STOPS) {
    return {
      ok: false,
      warnings,
      errors: [{ code: 'NO_CANDIDATES', message: `AI 计划有效站点不足 ${MIN_STOPS} 个` }],
    };
  }

  const generatedAt = typeof now === 'string' && now.length >= 10 ? now : new Date().toISOString();
  const rawBudget = Number(intent?.budget_min);
  const budgetMin = Number.isFinite(rawBudget) && rawBudget > 0 ? Math.round(rawBudget) : DEFAULT_BUDGET_MIN;
  const pace = PACES.has(plan.pace) ? plan.pace : PACES.has(intent?.pace) ? intent.pace : 'balanced';
  const startTime = typeof intent?.start_time === 'string' && intent.start_time ? intent.start_time : '09:00';
  const planInterests = Array.isArray(plan.interests) ? plan.interests.filter(Boolean) : [];
  const interests = uniqueStrings(planInterests.length ? planInterests : Array.isArray(intent?.interests) ? intent.interests : []);
  const planConstraints = Array.isArray(plan.constraints) ? plan.constraints : [];
  const constraints = uniqueStrings(
    planConstraints.length
      ? planConstraints
      : Array.isArray(intent?.constraints)
        ? intent.constraints
        : [],
  );

  const byId = new Map();
  for (const poi of Array.isArray(catalog) ? catalog : []) {
    const id = String(poi?.id ?? poi?.poi_id ?? '').trim();
    if (id && !byId.has(id)) byId.set(id, poi);
  }

  const planStopById = new Map();
  for (const stop of plan.stops) planStopById.set(String(stop.poi_id), stop);

  let selected = [];
  for (const stop of plan.stops) {
    const id = String(stop?.poi_id ?? '').trim();
    const poi = byId.get(id);
    if (!poi) {
      warnings.push(`POI「${id}」不在 catalog，组装时忽略`);
      continue;
    }
    selected.push({
      ...poi,
      poi_id: id,
      stay_min: stop.stay_min,
      why: stop.why,
    });
  }
  if (selected.length < MIN_STOPS) {
    return {
      ok: false,
      warnings,
      errors: [{ code: 'NO_CANDIDATES', message: `可组装的有效站点仅 ${selected.length} 个（至少 ${MIN_STOPS} 个）` }],
    };
  }

  const sequenceCtx = { startTime, pace };
  const userMinStops = Number.isFinite(Number(intent?.min_stops))
    ? Math.max(MIN_STOPS, Math.min(8, Math.round(Number(intent.min_stops))))
    : MIN_STOPS;
  const requestedMin = Math.min(userMinStops, selected.length);
  if (userMinStops > selected.length) {
    warnings.push(`AI 只排了 ${selected.length} 站，少于用户要求的 ${userMinStops} 站`);
  }
  let sequence = orderFixedSequence({ selected, ctx: sequenceCtx });

  // 先压缩单站停留，尽量在预算内保住用户要求的站数；再考虑删站。
  const totalStay = () => selected.reduce((sum, poi) => sum + (Number(poi.stay_min) || 0), 0);
  let compressed = false;
  if (sequence.totals.spanMin > budgetMin && selected.length >= requestedMin) {
    const travel = sequence.totals.spanMin - totalStay();
    const allowedStay = budgetMin - travel;
    const currentStay = totalStay();
    if (allowedStay > 0 && currentStay > allowedStay) {
      const factor = Math.max(0.35, allowedStay / currentStay);
      selected = selected.map((poi) => ({
        ...poi,
        stay_min: Math.max(20, Math.round(((Number(poi.stay_min) || 30) * factor) / 5) * 5),
      }));
      sequence = orderFixedSequence({ selected, ctx: sequenceCtx });
      compressed = true;
    }
  }

  // 逐分钟微调停留，避免“242 / 240”这种 2 分钟溢出。
  let guard = 0;
  while (sequence.totals.spanMin > budgetMin && selected.some((poi) => Number(poi.stay_min) > 20) && guard < 40) {
    selected = selected.map((poi) => ({
      ...poi,
      stay_min: Math.max(20, (Number(poi.stay_min) || 20) - 1),
    }));
    sequence = orderFixedSequence({ selected, ctx: sequenceCtx });
    compressed = true;
    guard += 1;
  }
  if (compressed) {
    warnings.push(`为在预算内保留 ${selected.length} 站（要求至少 ${requestedMin} 站），已把单站停留压缩到约 ${Math.round(totalStay() / selected.length)} 分钟`);
  }

  // 末站到达晚于 22:30：orderFixedSequence 已从队尾截断，同步 selected 并记录。
  const timeCut = selected.length - sequence.ordered.length;
  if (timeCut > 0) {
    const removedNames = selected
      .slice(sequence.ordered.length)
      .map((poi) => poi.name || poi.poi_id)
      .join('、');
    warnings.push(`末站到达将晚于 22:30，已从队尾截断 ${timeCut} 站：${removedNames}`);
    selected = sequence.ordered.map((entry) => entry.poi);
  }

  // 预算硬截断：只删到用户要求的最少站数，不把“5 站”删成 3 站。
  const cutStops = [];
  while (sequence.totals.spanMin > budgetMin && selected.length > requestedMin) {
    const removed = selected[selected.length - 1];
    const overBy = round1(sequence.totals.spanMin - budgetMin);
    cutStops.push({
      id: String(removed.poi_id ?? removed.id ?? ''),
      name: String(removed.name ?? ''),
      reason: `加入后总时长 ${Math.ceil(sequence.totals.spanMin)} 分钟超过预算 ${budgetMin} 分钟（超出 ${overBy} 分钟）`,
    });
    selected = selected.slice(0, -1);
    sequence = orderFixedSequence({ selected, ctx: sequenceCtx });
  }
  if (cutStops.length) {
    warnings.push(`预算截断 ${cutStops.length} 站：${cutStops.map((item) => item.name || item.id).join('、')}`);
  }
  const overBudget = sequence.totals.spanMin > budgetMin;
  if (overBudget) {
    warnings.push(
      `已保留 ${requestedMin} 站，总时长 ${Math.ceil(sequence.totals.spanMin)} 分钟仍超预算 ${budgetMin} 分钟`,
    );
  }

  if (sequence.ordered.length < MIN_STOPS) {
    return {
      ok: false,
      warnings,
      errors: [{ code: 'NO_CANDIDATES', message: `截断后可用站点仅 ${sequence.ordered.length} 个` }],
    };
  }

  const route = sequence.ordered.map((entry, index) => {
    const poi = entry.poi;
    const id = String(poi.poi_id ?? poi.id ?? '');
    const matched = interests.filter((interest) => interestMatches(interest, poi)).length;
    const rating = Number(poi.rating);
    const ratingBoost = Number.isFinite(rating) ? (clamp(rating, 0, 5) / 5 - 0.7) * 0.2 : 0;
    const score = round3(clamp(0.55 + matched * 0.08 + ratingBoost - index * 0.04, 0.02, 0.98));
    const planStop = planStopById.get(id);
    const leg =
      index === 0
        ? null
        : {
            from_id: String(sequence.ordered[index - 1].poi.poi_id ?? sequence.ordered[index - 1].poi.id ?? ''),
            to_id: id,
            distance_m: Math.max(0, Math.round(Number(entry.distanceM) || 0)),
            walk_min: Math.max(0, Number(entry.travelMin) || 0),
            routing_status: 'fallback_straight',
          };
    return {
      order: index + 1,
      id,
      name: String(poi.name ?? id),
      lat: Number(poi.lat),
      lng: Number(poi.lng),
      stay_min: Math.max(1, Math.round(entry.duration)),
      score,
      reason: ensureReason(planStop?.why ?? poi.why, poi, interests),
      commentary: commentaryOf(poi),
      assets: { panorama: null, model3d: null, photo: null },
      leg,
    };
  });

  const stayMin = route.reduce((sum, stop) => sum + stop.stay_min, 0);
  const walkMin = round1(sequence.totals.travelMin);
  const totalMin = Math.ceil(round1(walkMin + stayMin));
  const poiCount = route.length;
  const coveredInterests = interests.filter((interest) =>
    route.some((stop) => interestMatches(interest, byId.get(stop.id) || stop)),
  );
  const interestCoverage = interests.length ? round2(coveredInterests.length / interests.length) : 1;

  const model = String(plan.model || plan.meta?.model || 'deepseek-chat');
  const llmElapsed = Math.max(1, Math.round(Number(plan.elapsed_ms) || 1));
  const timings = plan.timings && typeof plan.timings === 'object' ? plan.timings : {};
  const durationOf = (key, fallback) => {
    const value = Number(timings[key]);
    return Math.max(1, Math.round(Number.isFinite(value) ? value : fallback));
  };

  const traceWarnings = cutStops.map((item) => `预算截断：${item.name || item.id}（${item.reason}）`);
  if (timeCut > 0) traceWarnings.push(`末站 22:30 截断 ${timeCut} 站`);
  for (const warning of warnings) {
    if (warning.includes('超预算') && !traceWarnings.includes(warning)) traceWarnings.push(warning);
  }

  const agentTrace = [
    {
      step: 1,
      label: '解析需求',
      input_summary: `用户原话 ${String(text ?? '').length} 字`,
      output_summary: `预算 ${budgetMin} 分钟，节奏 ${pace}，兴趣 ${interests.join('/') || '无'}`,
      hits: interests.length + constraints.length,
      duration_ms: durationOf('parse_ms', 1),
      evidence_refs: ['src/agent/citywalk/masterPipeline.js#parseMasterIntent'],
      warnings: [],
    },
    {
      step: 2,
      label: '加载城市包',
      input_summary: `city=chengdu，候选 ${byId.size} 个`,
      output_summary: `有坐标候选 ${byId.size} 个，开始时间 ${startTime}`,
      hits: byId.size,
      duration_ms: durationOf('catalog_ms', 1),
      evidence_refs: ['data/cities/chengdu/pois.geojson'],
      warnings: [],
    },
    {
      step: 3,
      label: 'AI 选点',
      input_summary: `候选 ${byId.size} 个，约束 ${constraints.join('/') || '无'}`,
      output_summary: `模型 ${model}，耗时 ${llmElapsed}ms，AI 返回 ${plan.stops.length} 站`,
      hits: plan.stops.length,
      duration_ms: llmElapsed,
      evidence_refs: [`deepseek:${model}`],
      warnings: [],
    },
    {
      step: 4,
      label: '预算校验',
      input_summary: `预计总时长 ${Math.ceil(sequence.totals.spanMin)} 分钟 / 预算 ${budgetMin} 分钟`,
      output_summary: overBudget
        ? `预算内保留 ${poiCount} 站，仍超预算 ${Math.ceil(sequence.totals.spanMin) - budgetMin} 分钟`
        : `预算校验通过，${poiCount} 站共 ${totalMin} 分钟`,
      hits: poiCount,
      duration_ms: durationOf('budget_ms', 1),
      evidence_refs: ['src/agent/citywalk/budget.js'],
      warnings: traceWarnings,
    },
    {
      step: 5,
      label: '组装脚本',
      input_summary: `入选 ${poiCount} 站，截断 ${cutStops.length + timeCut} 站`,
      output_summary: `组装 tour_script 1.1.0，模型 ${model}，AI 耗时 ${llmElapsed}ms`,
      hits: cutStops.length,
      duration_ms: durationOf('compose_ms', 1),
      evidence_refs: ['knowledge/tour_script.schema.json'],
      warnings: [],
    },
  ];

  const validation = { valid: true, issues: [], warnings: [...warnings] };
  const script = {
    schema_version: '1.1.0',
    meta: {
      schema_version: '1.1.0',
      source: 'llm',
      generated_at: generatedAt,
      pipeline_version: '1.1.0',
      city: { id: 'chengdu', name: '成都', pack_version: '0.1.0' },
      budget: {
        mode: 'strict',
        input_min: budgetMin,
        total_min: totalMin,
        breakdown: { walk_min: walkMin, stay_min: stayMin },
      },
      dropped: [],
      agent_trace: agentTrace,
      validation,
      stats: {
        poi_count: poiCount,
        total_duration_min: totalMin,
        interest_coverage: interestCoverage,
        walk_intensity: walkIntensity(walkMin),
      },
    },
    route,
  };

  const schemaResult = validateAgainstSchema(script, loadSchema());
  const schemaIssues = Array.isArray(schemaResult.issues) ? schemaResult.issues : [];
  validation.valid = schemaIssues.length === 0;
  validation.issues = schemaIssues;
  script.meta.validation = validation;

  if (!validation.valid) {
    return {
      ok: false,
      warnings,
      errors: schemaIssues.map((message) => ({ code: 'SCHEMA_INVALID', message })),
      script,
    };
  }

  return {
    ok: true,
    script,
    cut_stops: cutStops,
    warnings,
    totals: {
      ...sequence.totals,
      total_min: totalMin,
      walk_min: walkMin,
      stay_min: stayMin,
      over_budget: overBudget,
    },
  };
}

export default composeAiScript;
