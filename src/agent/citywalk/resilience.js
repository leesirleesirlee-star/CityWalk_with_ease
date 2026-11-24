/**
 * T4.4 STEP 1 · 异常场景兜底（pipeline 层，不改 planner / budget 计算）
 *
 * 六类场景与落点：
 *   1. 预算极低选不出站 → 复用 routeGuard.planWithGuard 保底 1 站，警告写 warnings
 *   2. 偏好关键词零命中 → 退回无偏好基线选点（preferences = null），警告明示
 *   3. 路网文件缺失/解析失败 → 腿一律 fallback_straight，警告明示「直线估算」
 *   4. 站点无资产 → 不写 route[].reason（会冗余），只在 warnings 汇总一条
 *   5. 输入乱码/超长 → 归一到默认参数（成都 / 180 分钟 / balanced），警告明示
 *   6. 单站字段缺失 → 预清洗剔除，记入 dropped 且 kind=closed，不拖垮整条路线
 *
 * 契约边界（knowledge/tour_script.schema.json）：
 *   - route.minItems = 1（L689）→ 场景 1 只能保底 1 站，不能返回 route: []
 *   - route[].additionalProperties = false（L692）→ 降级标记不能新增字段
 *   - meta.additionalProperties = false（L470）→ 只能写 meta.validation（L662-681）
 *   - dropped.kind 只有 5 枚举，无 data_invalid → 场景 6 借用 closed 并在 reason 说明
 *
 * 本模块不选点、不改评分、不改预算公式；所有选点仍由 planner.planTour 完成。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planWithGuard } from './routeGuard.js';
import { PACES } from './budget.js';
import { normalizePreferences } from './planner.js';
import { mapInterests } from './interestMap.js';
import { validateAgainstSchema } from '../../../tools/schema-check.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');

const ID_KEYS = ['id', 'poi_id'];
const MAX_TEXT_LENGTH = 2000;
const GARBLED_RATIO = 0.1;

/** 默认参数：城市成都、180 分钟、balanced（契约里没有 normal，语义最接近 balanced）。 */
export const DEFAULT_REQUEST = Object.freeze({
  city: Object.freeze({ id: 'chengdu', name: '成都', pack_version: '0.1.0' }),
  budget_min: 180,
  mode: 'strict',
  pace: 'balanced',
});

/** 六类场景的统一文案出口，测试直接断言这些常量，避免文案漂移。 */
export const WARNINGS = Object.freeze({
  BUDGET_TOO_LOW: '预算不足，无法覆盖单站最短停留',
  PREFERENCE_UNMATCHED: '未匹配到对应偏好，已按综合评分推荐',
  PREFERENCE_UNREACHABLE: '偏好类别暂无可达站点，已按综合评分推荐',
  PREFERENCE_PARTIAL_UNREACHABLE: '部分偏好类别暂无可达站点，已按可达类别推荐',
  PREFERENCE_NO_ROOM: '偏好无法在预算内生效，已保留原路线',
  RHYTHM_UNSUPPORTED: '节奏类偏好（少走路/轻松）暂只支持类别权重，本次未调整步速',
  NETWORK_MISSING: '路网数据缺失，路线为直线估算',
  ASSETS_MISSING: '本次演示站点均无三维/全景资产，为图文解说模式',
  ASSETS_PARTIAL: (missing, total) => `${total} 站中有 ${missing} 站无三维/全景资产，其余为图文解说`,
  INPUT_DEGRADED: '输入解析失败，已使用默认参数',
  FIELD_MISSING: (count) => `${count} 个站点字段缺失，已按数据异常跳过`,
});

const idOf = (poi) => {
  for (const key of ID_KEYS) {
    const value = poi?.[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return '';
};

function hasCoords(poi) {
  if (Number.isFinite(poi?.lat) && Number.isFinite(poi?.lng)) return true;
  const c = poi?.geometry?.coordinates;
  return Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]);
}

/* ── 场景 5：输入乱码 / 超长 ───────────────────────── */

/**
 * 乱码判定：替换字符（U+FFFD）或控制字符占比超过 10%。
 * 纯函数，不依赖任何 IO，便于单测。
 */
export function isGarbled(text) {
  if (typeof text !== 'string') return true;
  const chars = [...text.trim()];
  if (chars.length === 0) return true;
  const bad = chars.filter((ch) => {
    if (ch === '\uFFFD') return true;
    const code = ch.charCodeAt(0);
    return code < 32 && ch !== '\n' && ch !== '\r' && ch !== '\t';
  }).length;
  return bad / chars.length > GARBLED_RATIO;
}

/**
 * 输入归一化：乱码 / 超长 / 非字符串一律退回默认参数。
 * pace 兼容口语里的 normal（契约无此枚举，映射到 balanced）。
 * 返回 { request, warnings, degraded }。
 */
export function normalizeRequest(input = {}) {
  const warnings = [];
  const rawText = typeof input === 'string' ? input : input?.text;
  // 只有「用户确实给了文本但读不懂」才算解析失败；完全没给输入走默认参数，不报警。
  const hasText =
    typeof input === 'string' ||
    (input != null && typeof input === 'object' && 'text' in input && input.text !== undefined);
  const degraded =
    hasText && (isGarbled(rawText) || (typeof rawText === 'string' && rawText.length > MAX_TEXT_LENGTH));
  if (degraded) warnings.push(WARNINGS.INPUT_DEGRADED);

  const fallback = DEFAULT_REQUEST;
  const city =
    !degraded && input?.city && typeof input.city === 'object'
      ? {
          id: typeof input.city.id === 'string' && input.city.id ? input.city.id : fallback.city.id,
          name: typeof input.city.name === 'string' && input.city.name ? input.city.name : fallback.city.name,
          pack_version:
            typeof input.city.pack_version === 'string' && input.city.pack_version
              ? input.city.pack_version
              : fallback.city.pack_version,
        }
      : { ...fallback.city };

  const rawBudget = degraded ? null : input?.budgetMin ?? input?.budget_min;
  const budgetValid = typeof rawBudget === 'number' && Number.isFinite(rawBudget) && rawBudget > 0;
  const budget_min = budgetValid ? Math.round(rawBudget) : fallback.budget_min;

  const rawPace = degraded ? null : String(input?.pace ?? '').toLowerCase();
  const pace = rawPace === 'normal' ? 'balanced' : PACES.includes(rawPace) ? rawPace : fallback.pace;

  const rawMode = degraded ? null : input?.mode;
  const mode = rawMode === 'flexible' ? 'flexible' : 'strict';

  return {
    request: { city, budget_min, budget_max: budget_min, mode, pace, text: degraded ? '' : rawText },
    warnings,
    degraded,
  };
}

/* ── 场景 6：单站字段缺失 ─────────────────────────── */

/**
 * 预清洗：缺 id / name / 坐标的站点直接剔除，交给 dropped（kind=closed）。
 *
 * 注意：coord_source=unmatched 的点有 id 有 name，只是数据源没匹配到坐标，
 * 属于 planner 既有的 score_below_threshold 语义，这里放行，避免改变历史口径。
 * 返回 { clean, dropped }，dropped 可直接并入 script.meta.dropped。
 */
export function sanitizePois(pois) {
  const list = Array.isArray(pois) ? pois : [];
  const clean = [];
  const dropped = [];

  list.forEach((poi, index) => {
    const id = idOf(poi);
    const name = typeof poi?.name === 'string' ? poi.name.trim() : '';
    const unmatchedCoord = poi?.coord_source === 'unmatched';
    const missing = [];
    if (!id) missing.push('id');
    if (!name) missing.push('name');
    if (!hasCoords(poi) && !unmatchedCoord) missing.push('lat/lng');

    if (missing.length === 0) {
      clean.push(poi);
      return;
    }

    dropped.push({
      id: id || `missing-${index + 1}`,
      name: name || '未命名点位',
      kind: 'closed',
      reason: `字段缺失：缺 ${missing.join('、')}，按数据异常跳过（kind=closed 为契约枚举借用）`,
    });
  });

  return { clean, dropped };
}

/* ── 场景 2：偏好零命中 ───────────────────────────── */

/**
 * 偏好是否真的能命中候选类别。零命中时退回 null（等价于无偏好），
 * 让 planner 走纯综合评分，不伪造「按偏好推荐」。
 */
export function resolvePreferenceFit({ preferences, pois } = {}) {
  const pref = normalizePreferences(preferences);
  if (!pref) return { preferences: null, warning: null, matched: 0 };

  const list = Array.isArray(pois) ? pois : [];
  const matchedList = list.filter((poi) => pref.categories.has(String(poi?.category ?? '')));
  const reachable = matchedList.filter(hasCoords);
  if (reachable.length > 0) {
    // 部分类别没坐标时仍按可达类别推荐，但必须明示，不能让用户以为熊猫也被算进去了
    return {
      preferences: pref,
      warning: reachable.length < matchedList.length ? WARNINGS.PREFERENCE_PARTIAL_UNREACHABLE : null,
      matched: reachable.length,
    };
  }

  // 类别存在但全部没有坐标（如「看熊猫」→ 自然保护地，该点 coord_source=unmatched）：
  // 仍退回基线，但文案要和「根本没有这个类别」区分开，避免用户误以为映射没生效。
  if (matchedList.length > 0) {
    return { preferences: null, warning: WARNINGS.PREFERENCE_UNREACHABLE, matched: 0 };
  }

  return { preferences: null, warning: WARNINGS.PREFERENCE_UNMATCHED, matched: 0 };
}

/* ── 场景 3：路网缺失 / 解析失败 ───────────────────── */

/**
 * 只做状态探测，不读进选点逻辑。文件不存在或 JSON 不可解析都视为不可用。
 * 返回 { status, available, detail, edge_count }。
 */
export function detectNetwork({ networkPath, fsImpl = fs } = {}) {
  const file =
    networkPath || path.join(ROOT, 'data', 'cities', 'chengdu', 'walk_network.json');

  if (!fsImpl.existsSync(file)) {
    return { status: 'missing', available: false, detail: '路网文件不存在', edge_count: 0, path: file };
  }

  try {
    const raw = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
    const edgeCount = Array.isArray(raw?.edges)
      ? raw.edges.length
      : Array.isArray(raw?.features)
        ? raw.features.length
        : 0;
    if (edgeCount === 0) {
      return { status: 'empty', available: false, detail: '路网文件无可用边', edge_count: 0, path: file };
    }
    return { status: 'ok', available: true, detail: `路网可用，${edgeCount} 条边`, edge_count: edgeCount, path: file };
  } catch (error) {
    return {
      status: 'parse_error',
      available: false,
      detail: `路网文件解析失败：${error.message}`,
      edge_count: 0,
      path: file,
    };
  }
}

/**
 * 网络不可用时强制所有腿回到 fallback_straight。
 * planner 目前固定写 fallback_straight；这里是防线，防止将来接入 network 后
 * 在缺数据的情况下伪造路网。返回被改写的腿数量。
 */
export function forceStraightLegs(script) {
  if (!script || !Array.isArray(script.route)) return 0;
  let changed = 0;
  for (const stop of script.route) {
    if (!stop?.leg) continue; // 首站 leg 为 null，契约允许
    if (stop.leg.routing_status !== 'fallback_straight') {
      stop.leg.routing_status = 'fallback_straight';
      changed += 1;
    }
  }
  return changed;
}

/* ── 场景 4：资产缺失（只汇总一条） ────────────────── */

/**
 * 统计 route 里 assets 三项全为 null 的站点。
 * 用户决策：当前成都 10 点全无资产，逐站标注会淹没路线，只输出一条全局提示。
 */
export function summarizeAssetGap(script) {
  const route = Array.isArray(script?.route) ? script.route : [];
  const missing = route.filter((stop) => {
    const assets = stop?.assets;
    if (!assets) return true;
    return !assets.panorama && !assets.model3d && !assets.photo;
  }).length;

  let warning = null;
  if (route.length > 0 && missing > 0) {
    warning = missing === route.length ? WARNINGS.ASSETS_MISSING : WARNINGS.ASSETS_PARTIAL(missing, route.length);
  }
  return { missing_count: missing, total: route.length, all_missing: missing === route.length && route.length > 0, warning };
}

/* ── 组装：dropped 合并 + validation 挂载 ──────────── */

/** 把预清洗的 dropped 并入 script，并同步计数与末条轨迹，保证「route + dropped = 候选总数」。 */
export function mergeDropped(script, extraDropped = []) {
  if (!script || !Array.isArray(script.route)) return script;
  const extra = Array.isArray(extraDropped) ? extraDropped : [];
  const merged = [...(script.meta.dropped || []), ...extra];
  script.meta.dropped = merged;

  if (extra.length > 0) {
    const trace = script.meta.agent_trace;
    const last = trace[trace.length - 1];
    if (last) {
      last.output_summary = `入选 ${script.route.length}，丢弃 ${merged.length}`;
      last.hits = merged.length;
      last.warnings = [...(last.warnings || []), WARNINGS.FIELD_MISSING(extra.length)];
    }
  }
  return script;
}

/** 写入契约允许的 meta.validation；valid 由真实校验结果决定，不写死。 */
export function attachValidation(script, { issues = [], warnings = [] } = {}) {
  if (!script) return null;
  script.meta.validation = {
    valid: issues.length === 0,
    issues: [...issues],
    warnings: [...warnings],
  };
  return script.meta.validation;
}

/* ── 主入口 ───────────────────────────────────────── */

/**
 * 六类兜底串联。永不抛异常：任何一路降级都转成 warnings + 结构化结果。
 *
 * @param {object} options
 * @param {string|object} options.input     原始需求（文本或已解析对象）
 * @param {Array} options.pois              候选站点
 * @param {string} [options.networkPath]    路网文件路径（默认成都）
 * @param {Function} [options.validate]     (script) => string[] 契约校验器
 * @param {string} [options.now]            固定时间戳
 * @param {string} [options.source]         deepworks | local
 */
export function runResilient({
  input = {},
  pois = [],
  preferences = null,
  preferenceText = null,
  networkPath,
  validate,
  now = '1970-01-01T00:00:00.000Z',
  source = 'local',
  removedIds = [],
  fsImpl = fs,
} = {}) {
  const warnings = [];
  const push = (text) => {
    if (text && !warnings.includes(text)) warnings.push(text);
  };

  // 场景 5
  const normalized = normalizeRequest(input);
  normalized.warnings.forEach(push);

  // 场景 6
  const sanitized = sanitizePois(pois);
  if (sanitized.dropped.length > 0) push(WARNINGS.FIELD_MISSING(sanitized.dropped.length));

  // 场景 2
  const prefFit = resolvePreferenceFit({ preferences, pois: sanitized.clean });
  if (prefFit.warning) {
    push(prefFit.warning);
  } else if (!prefFit.preferences && String(preferenceText ?? '').trim()) {
    // 口语一个类别都没解析出来：preferences 本来就是 null，但产物仍要留下痕迹
    push(WARNINGS.PREFERENCE_UNMATCHED);
  }

  // 场景 1（routeGuard 负责保底 1 站，空因与超时如实返回）
  const plan = planWithGuard({
    city: normalized.request.city,
    pois: sanitized.clean,
    budgetMin: normalized.request.budget_min,
    mode: normalized.request.mode,
    pace: normalized.request.pace,
    now,
    removedIds,
    source,
    preferences: prefFit.preferences,
  });

  if (!plan.script) {
    return {
      script: null,
      warnings,
      guard: plan.guard,
      request: normalized.request,
      sanitized,
      network: detectNetwork({ networkPath, fsImpl }),
      assets: { missing_count: 0, total: 0, all_missing: false, warning: null },
      validation: { valid: false, issues: ['未产出可用的 tour_script'], warnings },
    };
  }

  const script = plan.script;

  // 场景 1 的文案补充：routeGuard 只改了 reason 与轨迹，这里补到统一出口
  if (plan.guard?.status === 'fallback_1_stop') push(WARNINGS.BUDGET_TOO_LOW);

  // 场景 3
  const network = detectNetwork({ networkPath, fsImpl });
  if (!network.available) {
    forceStraightLegs(script);
    push(WARNINGS.NETWORK_MISSING);
  }

  // 场景 4
  const assets = summarizeAssetGap(script);
  if (assets.warning) push(assets.warning);

  // 场景 6 的 dropped 合并（必须在 validation 之前）
  mergeDropped(script, sanitized.dropped);

  // 真实契约校验：issues 来自外部校验器，valid 不写死
  const issues = typeof validate === 'function' ? validate(script) || [] : [];
  const validation = attachValidation(script, { issues, warnings });

  return {
    script,
    warnings,
    guard: plan.guard,
    request: normalized.request,
    sanitized,
    network,
    assets,
    validation,
  };
}

/* ── 偏好追问：基于基础脚本重算 ───────────────────── */

const SCHEMA_FILE = path.join(ROOT, 'knowledge', 'tour_script.schema.json');
// 节奏类词不属于类别权重，命中时明确告知「未调整步速」，避免用户以为生效了
const RHYTHM_TERMS = ['少走', '别太累', '轻松', '悠闲', '不想走', '慢慢逛'];
let schemaCache = null;

function defaultValidate(script) {
  if (!schemaCache) schemaCache = JSON.parse(fs.readFileSync(SCHEMA_FILE, 'utf8'));
  return validateAgainstSchema(script, schemaCache).issues ?? [];
}

function loadCityPois(cityId) {
  const file = path.join(ROOT, 'data', 'cities', String(cityId || 'chengdu'), 'pois.geojson');
  const geo = JSON.parse(fs.readFileSync(file, 'utf8'));
  return (geo.features ?? []).map((feature) => {
    const p = feature.properties ?? {};
    const c = feature.geometry?.coordinates;
    return {
      id: p.poi_id ?? p.id,
      name: p.name ?? '',
      category: p.category ?? '',
      coord_source: p.coord_source,
      lat: Array.isArray(c) ? c[1] : null,
      lng: Array.isArray(c) ? c[0] : null,
    };
  });
}

function previousWeightMap(preferences) {
  const pref = normalizePreferences(preferences);
  return pref ? Object.fromEntries(pref.weights) : null;
}

function mergeWeightMaps(...maps) {
  const merged = Object.create(null);
  for (const map of maps) {
    if (!map) continue;
    for (const [category, weight] of Object.entries(map)) {
      merged[category] = Math.max(merged[category] ?? 0, weight);
    }
  }
  return Object.keys(merged).length > 0 ? { categories: { ...merged } } : null;
}

const cloneScript = (script) => JSON.parse(JSON.stringify(script));

/**
 * 基于一份已有的 1.1.0 脚本追加偏好并重算。
 *
 * 只做三件事：读回候选集、把口语并进权重、交给 runResilient 重算。
 * 不新增选点算法，不改预算公式；strict 下任何超预算结果都回退原路线。
 * 连续迭代时把上一轮返回的 preferences 作为 options.preferences 传入即可。
 *
 * @param {object} baseScript  基础 tour_script（从 meta 取城市/预算/模式/时间）
 * @param {string} text        追加偏好（如「想看更多人文景点」「换成喝茶主题」）
 * @param {object} [options]   { preferences, pace, pois, validate, now }
 */
export function adjustTour(baseScript, text, options = {}) {
  if (!baseScript || typeof baseScript !== 'object' || !baseScript.meta) {
    throw new TypeError('adjustTour 需要基础 tour_script 对象（含 meta）');
  }

  const meta = baseScript.meta;
  const city = meta.city ?? DEFAULT_REQUEST.city;
  const budgetMin = Number.isFinite(meta.budget?.input_min) ? meta.budget.input_min : DEFAULT_REQUEST.budget_min;
  const mode = meta.budget?.mode === 'flexible' ? 'flexible' : 'strict';
  const pace = options.pace ?? meta.pace ?? DEFAULT_REQUEST.pace;
  // 默认沿用基础脚本的生成时间，保证同一输入两次运行字节一致
  const now = options.now ?? meta.generated_at ?? '1970-01-01T00:00:00.000Z';

  const pois = Array.isArray(options.pois) ? options.pois : loadCityPois(city.id);
  const mapped = mapInterests(text);
  const merged = mergeWeightMaps(previousWeightMap(options.preferences), mapped.categories);

  const result = runResilient({
    input: { text, city, budgetMin, mode, pace },
    pois,
    preferences: merged,
    preferenceText: text,
    validate: options.validate ?? defaultValidate,
    now,
    source: meta.source ?? 'local',
    removedIds: (meta.dropped ?? []).filter((d) => d.kind === 'user_removed').map((d) => d.id),
  });

  const warnings = [...result.warnings];
  if (RHYTHM_TERMS.some((term) => String(text ?? '').includes(term))) {
    warnings.push(WARNINGS.RHYTHM_UNSUPPORTED);
  }

  const overBudget = Boolean(result.script) && result.script.meta.budget.total_min > budgetMin;
  if (mode === 'strict' && (!result.script || overBudget)) {
    const fallback = cloneScript(baseScript);
    const finalWarnings = [...new Set([...warnings, WARNINGS.PREFERENCE_NO_ROOM])];
    const issues = (options.validate ?? defaultValidate)(fallback);
    attachValidation(fallback, { issues, warnings: finalWarnings });
    return {
      script: fallback,
      preferences: merged,
      warnings: finalWarnings,
      guard: { ...(result.guard ?? {}), status: 'preference_rejected', note: WARNINGS.PREFERENCE_NO_ROOM },
      validation: fallback.meta.validation,
      rejected: true,
    };
  }

  return { ...result, preferences: merged, warnings, rejected: false };
}
