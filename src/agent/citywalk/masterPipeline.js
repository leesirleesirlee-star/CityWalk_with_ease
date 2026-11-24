/**
 * 单入口总控流水线（T4.10）
 *
 * 把「意图解析 → 解说调度 → 合成校验」三段串成一个函数调用：
 *   runMasterPipeline('成都半天，想喝茶、拍照、少走路，预算3小时')
 *   → { ok, script, intent, narration, validation, checks, logs }
 *
 * 三段逻辑与 scripts/t4-agent-pipeline.mjs 同源（逐字迁移，保证输出一致）；
 * 选点、预算、兜底、契约校验全部调用既有模块，本文件不实现任何业务算法。
 * 若修改三段规则，两处需同步。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runResilient, isGarbled, WARNINGS, adjustTour } from './resilience.js';
import { mapInterests, buildPreferenceProfile, parseFuzzyTime } from './interestMap.js';
import { resolveStayMinutes, evaluateBudget } from './budget.js';
import { sortRouteByProximity } from './routeOrder.js';
import { validateAgainstSchema } from '../../../tools/schema-check.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
const CITY_ID = 'chengdu';
const SCHEMA_FILE = path.join(ROOT, 'knowledge', 'tour_script.schema.json');

/** 与 scripts/t4-agent-pipeline.mjs 保持一致，便于逐字段比对 */
export const FIXED_NOW = '2026-11-20T00:00:00.000Z';

const INTEREST_LEXICON = Object.freeze([
  { tag: '茶文化', words: ['茶', '喝茶', '盖碗', '茶馆', '茶铺', '老茶馆', '盖碗茶'] },
  { tag: '摄影', words: ['拍照', '摄影', '出片', '机位', '镜头', '合影', '打卡'] },
  { tag: '历史', words: ['历史', '古迹', '祠', '寺', '古建', '三国', '文化', '蜀汉', '红墙'] },
  { tag: '美食', words: ['吃', '美食', '小吃', '好吃', '火锅', '串串', '川菜', '夜宵'] },
  { tag: '市井', words: ['市井', '烟火', '老街', '巷子', '老成都'] },
  { tag: '自然', words: ['自然', '公园', '园林', '山水', '江边'] },
  { tag: '夜景', words: ['夜景', '晚上', '夜游', '灯光', '酒吧', '夜色'] },
  { tag: '建筑', words: ['建筑', '立面', '院子', '屋顶', '青砖'] },
]);

const CONSTRAINTS = Object.freeze([
  { code: 'low_walk', words: ['少走路', '少走', '不想走', '轻松', '慢', '腿脚不便', '走不动', '别走太多', '少走动'] },
  { code: 'evening', words: ['晚上', '夜景', '夜游', '傍晚', '天黑', '入夜', '夜晚', '夜色'] },
  { code: 'family', words: ['带孩子', '亲子', '老人', '带小孩', '带长辈', '一家老小', '遛娃'] },
  { code: 'quiet', words: ['安静', '清净', '人少', '清静', '不要吵'] },
  { code: 'rain', words: ['下雨', '雨天', '下雨天', '阴雨'] },
  { code: 'no_hike', words: ['不爬山', '不登山', '不想爬山', '爬不动'] },
]);

const CAMERA_BY_CATEGORY = Object.freeze({
  寺院: 'temple_gate',
  历史街区: 'heritage_gate',
  古迹: 'heritage_gate',
  民俗夜市: 'night_market',
  城市公园: 'bamboo_path',
  古典园林: 'bamboo_path',
  历史祠庙: 'heritage_gate',
  工业遗址艺术区: 'industrial_plaza',
  河岸夜景: 'riverside_night',
  自然保护地: 'panda_entry',
  商业街区: 'street_entry',
});

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/* ── 第一段：意图解析 ─────────────────────────────── */

/**
 * 解析成都需求文本。与 scripts/t4-agent-pipeline.mjs 的 parseIntent 同源。
 * 与脚本版唯一的差别：空输入不抛异常，返回默认参数并标记 degraded，
 * 以满足「总控入口任何输入都不崩溃」的约定。
 */
export function parseMasterIntent(text = '') {
  const raw = String(text ?? '').trim();
  const logs = [];
  const empty = raw.length === 0;
  const unparsed = [];

  if (empty) {
    unparsed.push('empty_input', 'budget_defaulted', 'interests_defaulted');
    logs.push('输入：空，使用默认参数（成都 / 180 分钟 / 综合偏好）');
  } else {
    if (!/成都|蓉城|锦官城/.test(raw)) unparsed.push('city_assumed');
    logs.push(`城市识别：成都${unparsed.includes('city_assumed') ? '（文本未命中，用默认城市）' : ''}`);
  }

  const arabic = empty ? null : /(\d+(?:\.\d+)?)\s*(小时|分钟|h|min)/.exec(raw);
  const fuzzy = empty || arabic ? null : parseFuzzyTime(raw);
  let budgetMin = null;
  let budgetSource = 'explicit';
  if (arabic) {
    const value = Number(arabic[1]);
    budgetMin = Math.round(/小时|h/.test(arabic[2]) ? value * 60 : value);
    logs.push(`预算：显式 ${arabic[1]}${arabic[2]} → ${budgetMin} 分钟`);
  } else if (fuzzy) {
    budgetMin = fuzzy.minutes;
    budgetSource = 'default';
    logs.push(`预算：命中「${fuzzy.key}」→ ${fuzzy.minutes} 分钟`);
  } else {
    budgetMin = 180;
    budgetSource = 'default';
    if (!unparsed.includes('budget_defaulted')) unparsed.push('budget_defaulted');
    if (!empty) logs.push('预算：未命中，默认 180 分钟');
  }
  if (/半天/.test(raw) && arabic) unparsed.push('budget_conflict');
  budgetMin = clamp(budgetMin, 30, 720);

  const profile = buildPreferenceProfile(raw);
  const lexiconPace = /少走路|少走|慢|轻松|休闲|不赶|安静/.test(raw)
    ? 'relaxed'
    : /快|紧凑|赶时间|高效/.test(raw)
      ? 'packed'
      : 'balanced';
  const pace = profile.pace ?? lexiconPace;
  if (!empty) {
    const label = profile.tempo_label ?? profile.crowd_label;
    logs.push(`节奏：${pace}${label ? `（${label}）` : ''}`);
  }

  const interests = [];
  for (const item of INTEREST_LEXICON) {
    if (item.words.some((word) => raw.includes(word))) interests.push(item.tag);
  }
  const defaultedInterests = interests.length === 0;
  if (defaultedInterests) {
    interests.push('市井', '美食', '历史');
    if (!unparsed.includes('interests_defaulted')) unparsed.push('interests_defaulted');
  }
  if (!empty) logs.push(`偏好：${interests.join(' / ')}${defaultedInterests ? '（默认组合）' : ''}`);

  const constraints = CONSTRAINTS.filter((item) => item.words.some((word) => raw.includes(word))).map(
    (item) => item.code,
  );
  if (!empty) logs.push(`约束：${constraints.length ? constraints.join(' / ') : '无'}`);

  // 「5个景点以上 / 至少5站 / 5站起」：用户明确要求的最少站数。
  const countToken = raw.match(/(?:至少\s*)?([0-9一二三四五六七八九十两]+)\s*个?\s*(?:景点|站|地方)\s*(?:以上|起)?/);
  const chineseDigits = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  let minStops = null;
  if (countToken && /以上|起|至少/.test(raw)) {
    const token = countToken[1];
    const value = /^\d+$/.test(token) ? Number(token) : chineseDigits[token];
    if (Number.isFinite(value)) minStops = clamp(Math.round(value), 2, 8);
  }
  if (!empty && minStops) logs.push(`站数：用户要求至少 ${minStops} 站`);

  const hits = interests.length + constraints.length + (arabic ? 1 : 0) + (minStops ? 1 : 0);
  const intent = {
    city_id: CITY_ID,
    city_name: '成都',
    budget_min: budgetMin,
    budget_source: budgetSource,
    mode: 'strict',
    pace,
    interests,
    constraints,
    start_time: /晚上|夜景/.test(raw) ? '18:30' : '09:00',
    confidence: clamp(0.35 + hits * 0.1, 0.35, 0.95),
    min_stops: minStops,
    unparsed,
    preferences: profile,
    stay_factor: profile.stay_factor,
  };
  if (!empty && profile.dining_label) logs.push(`餐饮：${profile.dining_label}`);
  if (!empty && profile.crowd_label) logs.push(`人群：${profile.crowd_label}`);
  if (!empty && profile.stay_factor !== 1) logs.push(`停留系数：×${profile.stay_factor}（供下游使用）`);
  if (!empty) logs.push(`置信度：${intent.confidence}`);

  return { intent, logs, raw_text: raw, degraded: empty };
}

/**
 * 缺省补全说明（T4.17 第二步）：只解释「哪些参数是自动补的」，不参与选点、排序或预算。
 * 空输入沿用既有 EMPTY_INPUT 兜底，这里不重复生成提示。
 */
const COMPLETION_NOTES = Object.freeze({
  city_assumed: '默认目的地为成都',
  budget_defaulted: '未指定游览时长，默认按3小时规划',
  interests_defaulted: '未指定游览主题，按经典均衡路线规划',
});

export function completionWarnings(intent) {
  const codes = Array.isArray(intent?.unparsed) ? intent.unparsed : [];
  if (codes.includes('empty_input')) return [];
  return codes.filter((code) => COMPLETION_NOTES[code]).map((code) => COMPLETION_NOTES[code]);
}

/* ── 第二段：解说调度 ─────────────────────────────── */

function loadCandidates() {
  const geo = readJson(path.join(ROOT, 'data', 'cities', CITY_ID, 'pois.geojson'));
  return geo.features.map((feature) => ({
    id: feature.properties?.poi_id,
    name: feature.properties?.name ?? '',
    category: feature.properties?.category ?? '',
    lat: feature.geometry?.coordinates?.[1],
    lng: feature.geometry?.coordinates?.[0],
    coord_source: feature.properties?.coord_source,
    opening_hours: feature.properties?.opening_hours ?? null,
    knowledge_file: feature.properties?.source_file ?? null,
    tags: Array.isArray(feature.properties?.tags) ? feature.properties.tags : [],
    stay_min: Number.isFinite(Number(feature.properties?.stay_min)) ? Number(feature.properties.stay_min) : undefined,
    rating: Number.isFinite(Number(feature.properties?.rating)) ? Number(feature.properties.rating) : null,
    address: feature.properties?.address ?? null,
    source_urls: Array.isArray(feature.properties?.source_urls) ? feature.properties.source_urls : [],
  }));
}

function loadAttraction(knowledgeFile) {
  if (!knowledgeFile) return null;
  const file = path.join(ROOT, knowledgeFile);
  if (!fs.existsSync(file)) return null;
  return readJson(file);
}

const SCENE_BY_CATEGORY = Object.freeze({
  寺院: '人文了解、安静慢走',
  工业遗址艺术区: '打卡拍照、朋友同行',
  民俗夜市: '边走边吃、夜间闲逛',
  河岸夜景: '傍晚散步、夜景拍照',
  历史街区: '人文了解、边逛边拍',
  自然保护地: '亲子出行、休闲散步',
  城市公园: '休闲散步、体验本地生活',
  潮流街区: '打卡拍照、朋友聚会',
  古典园林: '人文了解、慢走细看',
  历史祠庙: '人文了解、中轴慢走',
});

function buildCommentary(poi, attraction) {
  const verified = attraction?.verification_status === 'verified';
  const hasSources = Array.isArray(attraction?.sources) && attraction.sources.length > 0;
  const status = verified ? 'verified' : hasSources ? 'source_checked' : 'pending_verification';

  if (status === 'pending_verification') {
    // 三段式只用知识库原文重组：看点=architecture+summary，场景=类别归纳，贴士=observation_guide+停留建议。
    const architecture = String(attraction?.architecture || '').trim();
    const summary = String(attraction?.summary || `${poi.name}（${poi.category}）`).trim();
    const history = String(attraction?.history || '').trim();
    const trimTail = (value) => String(value || '').trim().replace(/[。；;，,]\s*$/, '');
    let core = [trimTail(architecture), trimTail(summary)].filter(Boolean).join('。');
    if (core.length < 45 && history) core = [core, trimTail(history)].filter(Boolean).join('。');
    if (core) core = `${core}。`;

    const scene = SCENE_BY_CATEGORY[poi.category] || '休闲散步、随走随看';
    const guide = trimTail(attraction?.observation_guide);
    const stay = resolveStayMinutes(poi).stay_min;
    const tips = `${guide ? `${guide}。` : ''}建议预留约 ${stay} 分钟，穿舒适的鞋。`;

    const text = `【核心看点】${core}【适合场景】${scene}。【游览小贴士】${tips}（待核验）`;
    return { poi_id: poi.id, text, source_status: status, source_urls: [], fact_ids: [] };
  }

  const text = String(attraction.summary || poi.name).slice(0, 120);
  return {
    poi_id: poi.id,
    text,
    source_status: status,
    source_urls: (attraction.sources || []).map((s) => s.url).filter(Boolean),
    fact_ids: [], // source_ids 是来源标识，不是已核验的事实标识。
  };
}

function buildSceneCommand(poi, intent) {
  const preset = CAMERA_BY_CATEGORY[poi.category] || 'street_entry';
  const evening = /夜景|晚上/.test(intent.constraints.join('')) || intent.start_time === '18:30';
  return {
    poi_id: poi.id,
    camera_preset: preset,
    hotspots: ['主入口'],
    time_of_day: evening ? 'evening' : 'afternoon',
    transition_ms: intent.pace === 'relaxed' ? 1200 : 900,
  };
}

export function runMasterNarration(candidates, intent) {
  const logs = [];
  const commentary = {};
  const sceneCommands = [];
  const statusCount = { verified: 0, source_checked: 0, pending_verification: 0 };

  for (const poi of candidates) {
    const attraction = loadAttraction(poi.knowledge_file);
    const item = buildCommentary(poi, attraction);
    commentary[poi.id] = item;
    sceneCommands.push(buildSceneCommand(poi, intent));
    statusCount[item.source_status] += 1;
  }

  logs.push(
    `来源分布：verified=${statusCount.verified} source_checked=${statusCount.source_checked} ` +
      `pending_verification=${statusCount.pending_verification}`,
  );

  return { commentary, scene_commands: sceneCommands, logs, status_count: statusCount };
}

/* ── 第三段：合成校验 ─────────────────────────────── */

export function runMasterCompose({ candidates, intent, narration, rawText, preferences = null, preferenceText = null }) {
  const schema = readJson(SCHEMA_FILE);
  const validateScript = (script) => validateAgainstSchema(script, schema).issues ?? [];

  // T4.13：停留系数在调用层落到候选身上，预算硬截断仍由 planner/budget 负责。
  const stayFactor = Number(intent?.stay_factor ?? 1);
  const effectivePois =
    Number.isFinite(stayFactor) && stayFactor > 0 && stayFactor !== 1
      ? candidates.map((poi) => {
          const base = resolveStayMinutes(poi).stay_min;
          return { ...poi, stay_min: Math.round(base * stayFactor) };
        })
      : candidates;

  const resilient = runResilient({
    input: {
      text: rawText,
      city: { id: CITY_ID, name: '成都', pack_version: '0.1.0' },
      budgetMin: intent.budget_min,
      mode: intent.mode,
      pace: intent.pace,
    },
    pois: effectivePois,
    preferences,
    preferenceText,
    validate: validateScript,
    source: 'deepworks',
    now: FIXED_NOW,
  });

  const script = resilient.script;
  const guard = resilient.guard || { status: 'no_route', code: 'unknown', overrun_min: 0, note: '' };

  if (!script) {
    return {
      script: null,
      result: resilient,
      validation: {
        valid: false,
        issues: ['未产出可用的 tour_script：候选无可用坐标或全部低于评分阈值'],
        warnings: resilient.warnings,
      },
      checks: [],
      logs: [`兜底：${guard.status}（${guard.note}）`, '契约校验失败：未产出可用脚本'],
      schema_result: null,
      guard,
    };
  }

  // T4.14：按地理位置就近串联，仅调整顺序并重算 leg / 预算，不增删站点。
  const ordered = sortRouteByProximity(script.route, { pace: intent.pace });
  if (ordered.changed) {
    script.route = ordered.route;
    const walkMeters = ordered.route.reduce((sum, stop) => sum + (stop.leg?.distance_m ?? 0), 0);
    const rebuiltBudget = evaluateBudget({
      candidates: ordered.route,
      budgetMin: intent.budget_min,
      mode: intent.mode,
      pace: intent.pace,
      walkMeters,
    });
    script.meta.budget = {
      mode: rebuiltBudget.mode,
      input_min: rebuiltBudget.budget_min,
      total_min: rebuiltBudget.total_rounded,
      breakdown: rebuiltBudget.breakdown,
    };
  }

  for (const stop of script.route) {
    const item = narration.commentary[stop.id];
    stop.commentary = item ? item.text : null;
  }

  const schemaResult = validateAgainstSchema(script, schema);
  const dropped = script.meta.dropped || [];
  const candidateCount = candidates.length;

  const checks = [
    ['schema_version === 1.1.0', script.schema_version === '1.1.0'],
    [
      'meta 七个必填字段齐全',
      ['schema_version', 'source', 'generated_at', 'city', 'budget', 'dropped', 'agent_trace'].every((key) =>
        Object.prototype.hasOwnProperty.call(script.meta, key),
      ),
    ],
    ['route + dropped === 候选总数', script.route.length + dropped.length === candidateCount],
    [
      'dropped.kind 全在 5 枚举内',
      dropped.every((d) =>
        ['budget_exceeded', 'closed', 'score_below_threshold', 'not_selected', 'user_removed'].includes(d.kind),
      ),
    ],
    ['dropped.reason 非空', dropped.every((d) => typeof d.reason === 'string' && d.reason.length > 0)],
    [
      'unmatched 点全部进 dropped 且 reason 含 coord_source',
      candidates
        .filter((p) => p.coord_source === 'unmatched')
        .every((p) => dropped.some((d) => d.id === p.id && String(d.reason).includes('coord_source'))),
    ],
    [
      '首站 leg=null 且其余 fallback_straight',
      script.route[0]?.leg === null &&
        script.route.slice(1).every((s) => s.leg?.routing_status === 'fallback_straight'),
    ],
    [
      'commentary key 集合覆盖 route id 集合',
      script.route.every((s) => Object.prototype.hasOwnProperty.call(narration.commentary, s.id)),
    ],
    [
      '总时长不超 strict 上限（保底兜底除外）',
      script.meta.budget.total_min <= intent.budget_min || guard.status === 'fallback_1_stop',
    ],
    ['validateAgainstSchema 通过', schemaResult.valid === true],
  ];

  const issues = checks.filter(([, ok]) => !ok).map(([label]) => label);
  const validation = {
    valid: issues.length === 0 && schemaResult.valid === true,
    issues: [...issues, ...(schemaResult.issues || [])],
    warnings: [...new Set([...(schemaResult.warnings || []), ...resilient.warnings])],
  };
  script.meta.validation = validation;

  const logs = [
    `选点：${script.route.map((s) => s.name).join(' → ') || '(none)'}`,
    `预算：input=${intent.budget_min} total=${script.meta.budget.total_min} ` +
      `(walk=${script.meta.budget.breakdown.walk_min} stay=${script.meta.budget.breakdown.stay_min})`,
    `兜底：${guard.status}${guard.overrun_min > 0 ? `（超时 ${guard.overrun_min} 分钟）` : ''}`,
    `警告：${validation.warnings.length} 条`,
    `舍弃：${dropped.length} 条`,
    ...checks.map(([label, ok]) => `${ok ? 'PASS' : 'FAIL'} ${label}`),
    validation.valid ? '契约校验通过' : `契约校验失败：${validation.issues.length} 项`,
  ];

  return { script, result: resilient, validation, checks, logs, schema_result: schemaResult, guard };
}

/* ── 单入口 ───────────────────────────────────────── */

/**
 * 输入一句话，输出完整 tour_script。
 * 永不抛异常：任一段失败都转为结构化错误，已完成的阶段结果保留在返回值里。
 *
 * @param {string} inputText
 * @param {object} [options] { preferences, preferenceText, now, source }
 * @returns {{ok:boolean, stage:string, error:object|null, script:object|null,
 *            intent:object, narration:object|null, validation:object|null,
 *            checks:Array, logs:Array, warnings:string[]}}
 */
export function runMasterPipeline(inputText, options = {}) {
  const logs = [];
  const warnings = [];
  const text = String(inputText ?? '');
  const trimmed = text.trim();

  // 段 1
  let parsed;
  try {
    parsed = parseMasterIntent(trimmed);
  } catch (error) {
    return {
      ok: false,
      stage: 'intent',
      error: { code: 'INTENT_FAILED', message: String(error?.message || error) },
      script: null,
      intent: null,
      narration: null,
      validation: null,
      checks: [],
      logs: [...logs, `意图解析失败：${error?.message || error}`],
      warnings,
    };
  }
  logs.push(...parsed.logs);

  if (parsed.degraded) warnings.push('EMPTY_INPUT：输入为空，已使用默认参数（成都 / 180 分钟 / 综合偏好）');
  if (trimmed && isGarbled(trimmed)) warnings.push(WARNINGS.INPUT_DEGRADED);

  // 补全说明：完整输入为空数组，因此既有输出不受影响。
  const completionNotes = completionWarnings(parsed.intent);
  for (const note of completionNotes) {
    if (!warnings.includes(note)) warnings.push(note);
  }

  // 段 2
  let candidates;
  let narration;
  try {
    candidates = loadCandidates();
    narration = runMasterNarration(candidates, parsed.intent);
  } catch (error) {
    return {
      ok: false,
      stage: 'narration',
      error: { code: 'NARRATION_FAILED', message: String(error?.message || error) },
      script: null,
      intent: parsed.intent,
      narration: null,
      validation: null,
      checks: [],
      logs: [...logs, `解说调度失败：${error?.message || error}`],
      warnings,
    };
  }
  logs.push(`候选：${candidates.length} 个`, ...narration.logs);

  // 段 3
  let composed;
  try {
    composed = runMasterCompose({
      candidates,
      intent: parsed.intent,
      narration,
      rawText: parsed.raw_text,
      preferences:
        options.preferences ??
        (parsed.intent.preferences?.dining ? parsed.intent.preferences : null),
      preferenceText: options.preferenceText ?? null,
    });
  } catch (error) {
    return {
      ok: false,
      stage: 'compose',
      error: { code: 'COMPOSE_FAILED', message: String(error?.message || error) },
      script: null,
      intent: parsed.intent,
      narration,
      validation: null,
      checks: [],
      logs: [...logs, `合成校验失败：${error?.message || error}`],
      warnings,
    };
  }
  logs.push(...composed.logs);
  warnings.push(...(composed.validation?.warnings || []));

  if (!composed.script) {
    return {
      ok: false,
      stage: 'compose',
      error: { code: 'NO_SCRIPT', message: composed.validation?.issues?.[0] || '未产出可用脚本' },
      script: null,
      intent: parsed.intent,
      narration,
      validation: composed.validation,
      checks: composed.checks,
      logs,
      warnings: [...new Set(warnings)],
    };
  }

  // 补全说明写入结果脚本的 warnings，前端「路线底部降级提示区」直接渲染。
  if (completionNotes.length && composed.script?.meta?.validation) {
    const existing = Array.isArray(composed.script.meta.validation.warnings)
      ? composed.script.meta.validation.warnings
      : [];
    composed.script.meta.validation.warnings = [...new Set([...existing, ...completionNotes])];
  }

  return {
    ok: composed.validation.valid === true,
    stage: 'done',
    error: null,
    script: composed.script,
    intent: parsed.intent,
    narration,
    validation: composed.validation,
    checks: composed.checks,
    logs,
    warnings: [...new Set(warnings)],
  };
}

export { mapInterests };

/* ── 多轮快捷追问（T4.14 第三步） ────────────────────
 * 上下文只保留「上一轮脚本 + 意图 + 已累积偏好」，不新增选点算法：
 * 偏好追加直接走 adjustTour；节奏/数量/重置走 runMasterCompose 重算。
 */

const FOLLOW_RESET = /重新来|重来|换一条|重新生成|重新规划|从零开始/;
const FOLLOW_MORE = /再加(一)?站|多去(一个|一站)|加(个|一个)(景点|站)|多逛(一个|一站)?/;
const FOLLOW_LESS = /少去(一个|一站)|去掉(一个|一站)|减(一)?站|砍掉(一个|一站)/;
const FOLLOW_SLOW = /放慢|慢一点|慢点|悠闲|不赶|慢慢逛/;
const FOLLOW_FAST = /走快|快一点|快点|赶时间|紧凑|加快/;
const FOLLOW_LESS_WALK = /少走|腿脚|不想走|别走太多/;

const BUDGET_FLOOR = 60;
const BUDGET_CEIL = 480;

function clampBudget(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return BUDGET_FLOOR;
  return Math.min(BUDGET_CEIL, Math.max(BUDGET_FLOOR, Math.round(n)));
}

function composeFromIntent(intent, preferences, rawText) {
  const candidates = loadCandidates();
  const narration = runMasterNarration(candidates, intent);
  return runMasterCompose({ candidates, intent, narration, rawText, preferences, preferenceText: rawText });
}

/** 把一次成功生成的结果包装成可继续追问的上下文。 */
export function createTourSession(result, prompt = '') {
  return {
    prompt: String(prompt ?? ''),
    script: result?.script ?? null,
    intent: result?.intent ?? null,
    baseIntent: result?.intent ?? null,
    preferences: null,
    history: [],
  };
}

function commitFollowUp(session, { kind, script, intent, preferences, message, warnings = [] }) {
  session.script = script;
  session.intent = intent ?? session.intent;
  session.preferences = preferences ?? session.preferences;
  session.history.push(message);
  return {
    ok: true,
    kind,
    script,
    intent: session.intent,
    preferences: session.preferences,
    message,
    warnings,
    session,
  };
}

function failFollowUp(session, kind, message) {
  return {
    ok: false,
    kind,
    script: session?.script ?? null,
    intent: session?.intent ?? null,
    preferences: session?.preferences ?? null,
    message,
    warnings: [],
    session,
  };
}

/**
 * 在当前路线上执行一次追问。
 * 返回 { ok, kind, script, intent, preferences, message, warnings, session }，
 * 失败时 ok=false 且保留原脚本，不抛异常。
 */
export function followUpTour(session, text) {
  const value = String(text ?? '').trim();
  if (!value) return failFollowUp(session, 'empty', '请输入追问内容。');
  if (!session?.script || !session?.intent) {
    return failFollowUp(session, 'no_context', '请先生成一条路线，再在它的基础上追问。');
  }

  const baseIntent = session.baseIntent ?? session.intent;
  const rawText = `${session.prompt} ${value}`.trim();

  // 1. 重置：清空偏好与节奏调整，回到本会话的初始参数
  if (FOLLOW_RESET.test(value)) {
    const intent = { ...baseIntent };
    const composed = composeFromIntent(intent, null, session.prompt);
    if (!composed.script) return failFollowUp(session, 'reset', '重置后没有产出可用路线，已保留当前路线。');
    session.preferences = null;
    return commitFollowUp(session, {
      kind: 'reset',
      script: composed.script,
      intent,
      preferences: null,
      message: '已清空追问上下文，按初始参数重新生成。',
      warnings: composed.validation?.warnings ?? [],
    });
  }

  // 2. 数量调整：只改预算松紧，站点增删仍由 planner 决定
  if (FOLLOW_MORE.test(value) || FOLLOW_LESS.test(value)) {
    const more = FOLLOW_MORE.test(value);
    const nextBudget = clampBudget(Number(session.intent.budget_min) * (more ? 1.2 : 0.8));
    const intent = { ...session.intent, budget_min: nextBudget };
    const composed = composeFromIntent(intent, session.preferences, rawText);
    if (!composed.script) return failFollowUp(session, 'count', '按新的预算没有排出可用路线，已保留当前路线。');
    return commitFollowUp(session, {
      kind: 'count',
      script: composed.script,
      intent,
      preferences: session.preferences,
      message: `已把总预算调整为 ${nextBudget} 分钟（${more ? '加站' : '减站'}），站点数随之变化。`,
      warnings: composed.validation?.warnings ?? [],
    });
  }

  // 3. 节奏调整：只动 pace 与停留系数
  if (FOLLOW_LESS_WALK.test(value) || FOLLOW_SLOW.test(value) || FOLLOW_FAST.test(value)) {
    let pace = 'relaxed';
    let stayFactor = 1;
    let message = '已切到少走路模式，优先缩短步行距离。';
    if (FOLLOW_FAST.test(value)) {
      pace = 'packed';
      stayFactor = 0.8;
      message = '已切到快走模式，停留时间下调。';
    } else if (FOLLOW_SLOW.test(value)) {
      pace = 'relaxed';
      stayFactor = 1.15;
      message = '已放慢节奏，停留时间略微放宽。';
    }
    const intent = { ...session.intent, pace, stay_factor: stayFactor };
    const composed = composeFromIntent(intent, session.preferences, rawText);
    if (!composed.script) return failFollowUp(session, 'pace', '按新的节奏没有排出可用路线，已保留当前路线。');
    return commitFollowUp(session, {
      kind: 'pace',
      script: composed.script,
      intent,
      preferences: session.preferences,
      message,
      warnings: composed.validation?.warnings ?? [],
    });
  }

  // 4. 偏好追加：完全复用 adjustTour 的权重合并与重算
  const mapped = mapInterests(value);
  if (!mapped.hits.length) {
    return failFollowUp(
      session,
      'unknown',
      `没识别出「${value}」对应的偏好。可以试试：再加人文 / 少走点路 / 再加一站 / 重新来。`,
    );
  }

  const adjusted = adjustTour(session.script, value, session.preferences ? { preferences: session.preferences } : {});
  if (!adjusted.script) return failFollowUp(session, 'preference', '这条偏好没能排出路线，已保留当前路线。');
  if (adjusted.rejected) return failFollowUp(session, 'preference', '当前预算装不下这条偏好，已保留原路线。');
  return commitFollowUp(session, {
    kind: 'preference',
    script: adjusted.script,
    intent: session.intent,
    preferences: adjusted.preferences ?? session.preferences,
    message: `已叠加偏好：${Object.keys(mapped.categories).join('、')}。`,
    warnings: adjusted.warnings ?? [],
  });
}
