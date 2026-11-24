/**
 * T3.4 · 性价比贪心选点 + 预算硬截断 + dropped[]。
 *
 * 纯函数：无 IO、无网络、不读环境变量、不调用 Date.now() / Math.random()。
 * 不调用 src/routing/**；腿时长一律「直线距离 × 步速」，routing_status 固定
 * fallback_straight，禁止伪造 network。
 *
 * 契约依据（knowledge/tour_script.schema.json，1.1.0）：
 *   meta.dropped.items required = id/name/reason/kind，kind 5 个枚举
 *   route[].leg = null | { from_id,to_id,distance_m,walk_min,routing_status }
 *   route[].score 为 0..1，stay_min 为 ≥1 的整数
 */

import {
  estimateWalkMinutes,
  resolveStayMinutes,
  normalizeBudget,
  normalizeMode,
  normalizePace,
  FLEXIBLE_OVERFLOW_RATIO,
  FLEXIBLE_OVERFLOW_CAP_MIN,
} from './budget.js';

/** 逐字照抄 schema，禁止改名或新增。 */
export const DROP_KINDS = Object.freeze([
  'budget_exceeded',
  'closed',
  'score_below_threshold',
  'not_selected',
  'user_removed',
]);

export const TRACE_LABELS = Object.freeze([
  '解析需求',
  '加载城市包',
  '贪心选点',
  '预算校验',
  '组装脚本',
]);

/** 类别价值（0..1），键与 pois.geojson 的 category 对齐。 */
export const CATEGORY_VALUE = Object.freeze({
  寺院: 0.8,
  工业遗址艺术区: 0.95,
  民俗夜市: 0.85,
  河岸夜景: 0.7,
  历史街区: 1.0,
  自然保护地: 1.0,
  城市公园: 0.75,
  潮流街区: 0.8,
  古典园林: 0.9,
  历史祠庙: 0.9,
});

export const DEFAULT_VALUE = 0.6;
// value/cost 的量纲是「价值 / 分钟」，常见值 0.015–0.03，阈值必须低于该区间。
export const SCORE_THRESHOLD = 0.005;
// T4.3：偏好命中时的价值加成。默认 1（零影响），上限 2 防止单条偏好压倒全部候选。
export const PREFERENCE_BOOST = 1.3;
export const TRACE_DURATION_BASE = Object.freeze([12, 27, 19, 34, 8]);

/** 权重夹在 1..2：低于 1 等于惩罚，高于 2 会单条偏好压倒全部候选。 */
export const PREFERENCE_WEIGHT_MIN = 1;
export const PREFERENCE_WEIGHT_MAX = 2;

const clampWeight = (raw, fallback = PREFERENCE_BOOST) =>
  Number.isFinite(raw) ? Math.max(PREFERENCE_WEIGHT_MIN, Math.min(PREFERENCE_WEIGHT_MAX, raw)) : fallback;

/**
 * 偏好入参归一化。以下写法都只落在权重层，不改变选点顺序与预算公式：
 *   ['历史街区']
 *   new Set(['历史街区'])
 *   { categories: ['历史街区'] }                    // 统一权重 1.3
 *   { categories: ['历史街区'], weight: 1.5 }        // 统一权重
 *   { categories: { 历史街区: 1.5, 民俗夜市: 1.2 } }  // 按类别
 *   { weights: { 历史街区: 1.5 } }                   // 按类别（等价写法）
 * 无法识别时返回 null（等价于不启用）。
 */
export function normalizePreferences(preferences) {
  if (!preferences) return null;
  // 已归一的对象直接复用，否则二次归一会把按类权重退回默认值
  if (preferences.categories instanceof Set && typeof preferences.weightOf === 'function') {
    return preferences;
  }

  const defaultWeight = clampWeight(preferences?.weight);
  const weightMap = Object.create(null);
  let list = null;

  if (Array.isArray(preferences) || preferences instanceof Set) {
    list = Array.isArray(preferences) ? preferences : [...preferences];
  } else if (typeof preferences === 'object') {
    const raw = preferences.categories;
    if (raw instanceof Set) {
      list = [...raw];
    } else if (Array.isArray(raw)) {
      list = raw;
    } else if (typeof raw === 'string') {
      list = [raw];
    } else if (raw && typeof raw === 'object') {
      for (const [category, value] of Object.entries(raw)) {
        weightMap[category] = clampWeight(value, defaultWeight);
      }
      list = Object.keys(raw);
    }

    const explicit = preferences.weights;
    if (explicit && typeof explicit === 'object' && !Array.isArray(explicit)) {
      for (const [category, value] of Object.entries(explicit)) {
        weightMap[category] = clampWeight(value, defaultWeight);
      }
      if (!list) list = Object.keys(explicit);
    }
  }

  const categories = (Array.isArray(list) ? list : []).filter(
    (item) => typeof item === 'string' && item.length > 0,
  );
  if (categories.length === 0) return null;

  const set = new Set(categories);
  const weights = new Map();
  for (const category of set) weights.set(category, weightMap[category] ?? defaultWeight);

  return {
    categories: set,
    weight: defaultWeight,
    weights,
    weightOf: (category) => weights.get(category) ?? defaultWeight,
  };
}

const round1 = (v) => Math.round(v * 10) / 10;
const round4 = (v) => Math.round(v * 10000) / 10000;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

const EARTH_R = 6371000;
const toRad = (deg) => (deg * Math.PI) / 180;

/** 直线距离（米），haversine。 */
export function straightDistanceM(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h))));
}

function coordsOf(poi) {
  if (isNum(poi?.lat) && isNum(poi?.lng)) return { lat: poi.lat, lng: poi.lng };
  const c = poi?.geometry?.coordinates;
  if (Array.isArray(c) && isNum(c[0]) && isNum(c[1])) return { lat: c[1], lng: c[0] };
  return null;
}

function idOf(poi) {
  return String(poi?.poi_id ?? poi?.id ?? '');
}

function normalizedStay(poi) {
  const { stay_min: raw } = resolveStayMinutes(poi);
  return Math.max(1, Math.round(raw));
}

/**
 * 单点评分（可被单测直接调用）。
 * 性价比 = 价值 / 耗时；score 输出压到 0..1（恒小于 1）。
 */
export function scorePoi(poi, { pace = 'balanced', from = null, preferences = null } = {}) {
  const coords = coordsOf(poi);
  const stay = normalizedStay(poi);
  const walk = from && coords ? estimateWalkMinutes(straightDistanceM(from, coords), pace) : 0;
  const cost = round1(stay + walk);
  const pref = normalizePreferences(preferences);
  const category = String(poi?.category ?? '');
  const preferenceMatched = Boolean(pref && pref.categories.has(category));
  const baseValue = CATEGORY_VALUE[poi?.category] ?? DEFAULT_VALUE;
  const value = preferenceMatched ? round4(baseValue * pref.weightOf(category)) : baseValue;
  const raw = cost > 0 ? value / cost : 0;
  return {
    value,
    base_value: baseValue,
    preference_matched: preferenceMatched,
    stay_min: stay,
    walk_min: walk,
    cost_min: cost,
    raw_score: round4(raw),
    score: round4(raw / (1 + raw)),
    usable: Boolean(coords),
    coords,
  };
}

/** 单条腿：第一站返回 null（schema 允许 null | leg）。 */
export function buildLeg(fromPoi, toPoi, pace = 'balanced') {
  const a = coordsOf(fromPoi);
  const b = coordsOf(toPoi);
  const distance = a && b ? straightDistanceM(a, b) : 0;
  return {
    from_id: idOf(fromPoi),
    to_id: idOf(toPoi),
    distance_m: distance,
    walk_min: estimateWalkMinutes(distance, pace),
    routing_status: 'fallback_straight',
  };
}

/** 五步轨迹：duration_ms 由 step 与输入规模确定性推导，必然互不相同且 > 0。 */
export function buildAgentTrace({ candidateCount = 0, selectedCount = 0, droppedCount = 0, degraded = false } = {}) {
  return TRACE_LABELS.map((label, i) => ({
    step: i + 1,
    label,
    input_summary: `候选 ${candidateCount} 个`,
    output_summary:
      i === 4
        ? `入选 ${selectedCount}，丢弃 ${droppedCount}`
        : `${label}完成`,
    hits: i === 2 ? selectedCount : candidateCount,
    duration_ms: TRACE_DURATION_BASE[i] + candidateCount * 3 + (i + 1) * (i + 1),
    evidence_refs: [],
    warnings: degraded && i === 4 ? ['路网不可用，腿时长按直线估算'] : [],
  }));
}

/**
 * 主入口：选点 + 硬截断 + 不变式。永不抛异常。
 */
export function planTour({
  city,
  pois,
  budgetMin,
  mode = 'strict',
  pace = 'balanced',
  now = '1970-01-01T00:00:00.000Z',
  removedIds = [],
  source = 'local',
  preferences = null,
} = {}) {
  const reasons = [];
  const pref = normalizePreferences(preferences);
  const budget = normalizeBudget(budgetMin);
  const modeResult = normalizeMode(mode);
  const paceResult = normalizePace(pace);

  if (budget.degraded) reasons.push('budgetMin 非法或缺失，已退回默认值');
  if (modeResult.degraded) reasons.push(`mode 不在契约枚举内：${String(mode)}`);
  if (paceResult.degraded) reasons.push(`pace 不在契约枚举内：${String(pace)}`);

  const input = Array.isArray(pois) ? pois.slice() : [];
  if (!Array.isArray(pois)) reasons.push('pois 不是数组，已按空候选处理');
  if (input.length === 0) reasons.push('候选为空，未选出任何站点');

  const dropped = [];
  const removed = new Set((Array.isArray(removedIds) ? removedIds : []).map(String));
  const drop = (poi, kind, reason) => {
    dropped.push({ id: idOf(poi) || 'unknown', name: String(poi?.name ?? ''), kind, reason });
  };

  const usable = [];
  for (const poi of input) {
    if (removed.has(idOf(poi))) {
      drop(poi, 'user_removed', '用户手动移除该站，重算时不参与选点');
      continue;
    }
    if (poi?.opening_hours === 'closed') {
      drop(poi, 'closed', 'open_hours 标记为 closed，当前时段不开放');
      continue;
    }
    if (!coordsOf(poi) || poi?.coord_source === 'unmatched') {
      const why = poi?.coord_source === 'unmatched' ? 'coord_source=unmatched' : '缺少经纬度';
      drop(poi, 'score_below_threshold', `${why}，无法计算步行耗时，不参与选点`);
      continue;
    }
    if (scorePoi(poi, { pace: paceResult.pace, preferences: pref }).raw_score < SCORE_THRESHOLD) {
      drop(poi, 'score_below_threshold', `性价比低于阈值 ${SCORE_THRESHOLD}，不入选`);
      continue;
    }
    usable.push(poi);
  }

  const allowance =
    modeResult.mode === 'flexible'
      ? round1(Math.min(budget.budget_min * FLEXIBLE_OVERFLOW_RATIO, FLEXIBLE_OVERFLOW_CAP_MIN))
      : 0;
  const limit = budget.budget_min + allowance;

  const selected = [];
  let total = 0;
  let current = null;
  const pool = usable.slice();

  while (pool.length > 0) {
    const scored = pool
      .map((poi) => ({ poi, ...scorePoi(poi, { pace: paceResult.pace, from: current, preferences: pref }) }))
      .sort(
        (a, b) =>
          b.raw_score - a.raw_score || String(idOf(a.poi)).localeCompare(String(idOf(b.poi))),
      );
    const pick = scored.find((s) => total + s.cost_min <= limit);
    if (!pick) break;
    selected.push(pick);
    total = round1(total + pick.cost_min);
    current = pick.coords;
    pool.splice(pool.indexOf(pick.poi), 1);
  }

  for (const poi of pool) {
    const s = scorePoi(poi, { pace: paceResult.pace, from: current, preferences: pref });
    if (s.raw_score < SCORE_THRESHOLD) {
      drop(poi, 'score_below_threshold', `性价比 ${s.raw_score} 低于阈值，不入选`);
    } else if (round1(total + s.cost_min) > limit) {
      drop(
        poi,
        'budget_exceeded',
        `加入后总时长 ${round1(total + s.cost_min)} 分钟超过上限 ${round1(limit)} 分钟`,
      );
    } else {
      drop(poi, 'not_selected', '预算仍有余，但贪心已无更高性价比候选，本轮未入选');
    }
  }

  const route = selected.map((s, index) => {
    const prev = index > 0 ? selected[index - 1].poi : null;
    return {
      order: index + 1,
      id: idOf(s.poi),
      name: String(s.poi?.name ?? ''),
      lat: s.coords.lat,
      lng: s.coords.lng,
      stay_min: s.stay_min,
      score: s.score,
      reason:
        `性价比 ${s.raw_score}（价值 ${s.value}，耗时 ${s.cost_min} 分钟），贪心入选` +
        (s.preference_matched
          ? `（偏好命中 ${String(s.poi?.category ?? '')}，价值 ×${pref.weightOf(String(s.poi?.category ?? ''))}）`
          : ''),
      commentary: null,
      assets: { panorama: null, model3d: null, photo: null },
      leg: prev ? buildLeg(prev, s.poi, paceResult.pace) : null,
    };
  });

  const walkTotal = round1(route.slice(1).reduce((sum, r) => sum + r.leg.walk_min, 0));
  const stayTotal = route.reduce((sum, r) => sum + r.stay_min, 0);
  const totalMin = Math.ceil(round1(walkTotal + stayTotal));
  const degraded = reasons.length > 0 || dropKinds(dropped).includes('score_below_threshold');

  const script = {
    schema_version: '1.1.0',
    meta: {
      schema_version: '1.1.0',
      source,
      generated_at: now,
      pipeline_version: 'v4-chengdu-1.1.0',
      city: {
        id: String(city?.id ?? 'chengdu'),
        name: String(city?.name ?? ''),
        pack_version: String(city?.pack_version ?? '0.1.0'),
      },
      budget: {
        mode: modeResult.mode,
        input_min: budget.budget_min,
        total_min: totalMin,
        breakdown: { walk_min: walkTotal, stay_min: stayTotal },
      },
      dropped,
      agent_trace: buildAgentTrace({
        candidateCount: input.length,
        selectedCount: route.length,
        droppedCount: dropped.length,
        degraded,
      }),
    },
    route,
  };

  return {
    script,
    selected: route.map((r) => r.id),
    dropped,
    summary: {
      candidate_count: input.length,
      selected_count: route.length,
      dropped_count: dropped.length,
      total_min: totalMin,
      budget_min: budget.budget_min,
      allowance_min: allowance,
      limit_min: round1(limit),
      mode: modeResult.mode,
      pace: paceResult.pace,
      preference_hits: selected.filter((s) => s.preference_matched).length,
      feasible: totalMin <= limit,
      reasons,
    },
  };
}

function dropKinds(dropped) {
  return dropped.map((d) => d.kind);
}
