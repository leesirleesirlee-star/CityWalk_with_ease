/**
 * T3.3 · 预算归一化 / 步行时长估算 / 可行性判定。
 *
 * 纯函数：无 IO、不读环境变量、不调用 Date.now() / Math.random()，
 * 同一输入必定得到同一输出。
 *
 * 契约依据（knowledge/tour_script.schema.json）：
 *   - meta.budget.mode 枚举 ["strict", "flexible"]            L532-538
 *   - request.pace 枚举 ["relaxed", "balanced", "packed"]     L72-79
 *   - meta.budget.breakdown.walk_min / stay_min 为 number     L547-563
 * 本模块不新增契约字段，也不选择/丢弃 POI（那是 T3.4 的职责）。
 */

/** 预算模式：严格沿用契约枚举，禁止新增。 */
export const BUDGET_MODES = Object.freeze(['strict', 'flexible']);

/** 步速三档：严格沿用契约枚举，禁止新增。 */
export const PACES = Object.freeze(['relaxed', 'balanced', 'packed']);

/**
 * 步速表（km/h）。
 * 依据：普通成人步行 4–5 km/h；慢节奏含停顿取 3.0，赶路取 5.4。
 * 三档必须严格单调，测试会断言 relaxed < balanced < packed。
 */
export const PACE_SPEED_KMH = Object.freeze({
  relaxed: 3.0,
  balanced: 4.2,
  packed: 5.4,
});

/**
 * 各类 POI 默认停留时长（分钟）。
 * 键与 CityPack 的 pois.geojson `category` 对齐；未登记的类别走 DEFAULT_STAY_MIN。
 */
export const STAY_MIN_BY_CATEGORY = Object.freeze({
  寺院: 30,
  工业遗址艺术区: 60,
  民俗夜市: 45,
  河岸夜景: 30,
  历史街区: 45,
  自然保护地: 120,
  城市公园: 45,
  潮流街区: 40,
  古典园林: 40,
  历史祠庙: 40,
});

export const DEFAULT_STAY_MIN = 30;
export const FALLBACK_BUDGET_MIN = 240;

/**
 * flexible 模式允许的超限量。
 * 契约只给了枚举，没有给数值；这里取“预算的 20%，且不超过 30 分钟”的保守上限，
 * 目的是既体现“有限超出”，又不让小预算被放大太多。改口径只需改这两个常量。
 */
export const FLEXIBLE_OVERFLOW_RATIO = 0.2;
export const FLEXIBLE_OVERFLOW_CAP_MIN = 30;

const round1 = (value) => Math.round(value * 10) / 10;
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/**
 * 预算归一化：接受数字或对象，返回 { budget_min, source, degraded }。
 * 非法输入不抛异常，退回 FALLBACK_BUDGET_MIN 并标记 degraded。
 */
export function normalizeBudget(input, { fallbackMin = FALLBACK_BUDGET_MIN } = {}) {
  if (isFiniteNumber(input) && input > 0) {
    return { budget_min: Math.round(input), source: 'number', degraded: false };
  }
  if (input && typeof input === 'object') {
    for (const key of ['duration_budget_min', 'budget_min', 'input_min']) {
      if (isFiniteNumber(input[key]) && input[key] > 0) {
        return { budget_min: Math.round(input[key]), source: key, degraded: false };
      }
    }
  }
  return { budget_min: fallbackMin, source: 'fallback', degraded: true };
}

/** 模式归一化：只允许契约枚举，非法值退回 strict。 */
export function normalizeMode(mode) {
  return BUDGET_MODES.includes(mode)
    ? { mode, degraded: false }
    : { mode: 'strict', degraded: true };
}

/** 步速归一化：只允许契约枚举，非法值退回 balanced。 */
export function normalizePace(pace) {
  return PACES.includes(pace)
    ? { pace, degraded: false }
    : { pace: 'balanced', degraded: true };
}

/**
 * 步行时长（分钟）。非法距离返回 0，由调用方通过 degraded 体现，不抛异常。
 * 结果保留 1 位小数，保证确定性。
 */
export function estimateWalkMinutes(distanceM, pace = 'balanced') {
  const { pace: safePace } = normalizePace(pace);
  if (!isFiniteNumber(distanceM) || distanceM <= 0) return 0;
  const speed = PACE_SPEED_KMH[safePace];
  return round1((distanceM / 1000 / speed) * 60);
}

/** 单站停留时长：优先用候选自带值，其次类别表，最后默认值。 */
export function resolveStayMinutes(candidate) {
  if (candidate && isFiniteNumber(candidate.stay_min) && candidate.stay_min >= 0) {
    return { stay_min: candidate.stay_min, source: 'candidate' };
  }
  const category = candidate && typeof candidate.category === 'string' ? candidate.category : '';
  if (Object.prototype.hasOwnProperty.call(STAY_MIN_BY_CATEGORY, category)) {
    return { stay_min: STAY_MIN_BY_CATEGORY[category], source: 'category' };
  }
  return { stay_min: DEFAULT_STAY_MIN, source: 'default' };
}

function collectWalkMeters(candidates) {
  let total = 0;
  let found = false;
  for (const candidate of candidates) {
    const value = candidate?.walk_m ?? candidate?.leg?.walk_m;
    if (isFiniteNumber(value) && value >= 0) {
      total += value;
      found = true;
    }
  }
  return { walk_m: found ? round1(total) : null };
}

/**
 * 可行性判定。
 *
 * 返回结构（永不抛异常）：
 * {
 *   feasible, mode, pace, budget_min,
 *   total_min, total_rounded, overflow_min, allowance_min,
 *   breakdown: { walk_min, stay_min },
 *   items: [{ id, name, category, stay_min, stay_source }],
 *   degraded, reasons[]
 * }
 */
export function evaluateBudget({
  candidates,
  budgetMin = FALLBACK_BUDGET_MIN,
  mode = 'strict',
  pace = 'balanced',
  walkMeters,
} = {}) {
  const reasons = [];
  const budget = normalizeBudget(budgetMin);
  const modeResult = normalizeMode(mode);
  const paceResult = normalizePace(pace);

  if (budget.degraded) reasons.push('budgetMin 非法或缺失，已退回默认值');
  if (modeResult.degraded) reasons.push(`mode 不在契约枚举内：${String(mode)}`);
  if (paceResult.degraded) reasons.push(`pace 不在契约枚举内：${String(pace)}`);

  const list = Array.isArray(candidates) ? candidates : [];
  if (!Array.isArray(candidates)) reasons.push('candidates 不是数组，已按空候选处理');
  if (list.length === 0) reasons.push('候选为空，总时长为 0');

  const items = list.map((candidate, index) => {
    const stay = resolveStayMinutes(candidate);
    if (stay.source !== 'candidate') {
      reasons.push(`候选 ${candidate?.id ?? index} 缺 stay_min，用 ${stay.source} 值`);
    }
    return {
      id: candidate?.id ?? `candidate_${index}`,
      name: candidate?.name ?? '',
      category: candidate?.category ?? '',
      stay_min: stay.stay_min,
      stay_source: stay.source,
    };
  });

  const stayMin = round1(items.reduce((sum, item) => sum + item.stay_min, 0));

  let walkMin;
  if (isFiniteNumber(walkMeters) && walkMeters >= 0) {
    walkMin = estimateWalkMinutes(walkMeters, paceResult.pace);
  } else {
    const collected = collectWalkMeters(list);
    if (collected.walk_m === null) {
      walkMin = 0;
      if (list.length > 0) reasons.push('候选未提供 walk_m，步行时长按 0 计');
    } else {
      walkMin = estimateWalkMinutes(collected.walk_m, paceResult.pace);
    }
  }

  const totalMin = round1(walkMin + stayMin);
  const allowanceMin =
    modeResult.mode === 'flexible'
      ? round1(Math.min(budget.budget_min * FLEXIBLE_OVERFLOW_RATIO, FLEXIBLE_OVERFLOW_CAP_MIN))
      : 0;

  return {
    feasible: totalMin <= budget.budget_min + allowanceMin,
    mode: modeResult.mode,
    pace: paceResult.pace,
    budget_min: budget.budget_min,
    total_min: totalMin,
    total_rounded: Math.ceil(totalMin),
    overflow_min: round1(Math.max(0, totalMin - budget.budget_min)),
    allowance_min: allowanceMin,
    breakdown: { walk_min: walkMin, stay_min: stayMin },
    items,
    degraded: reasons.length > 0,
    reasons,
  };
}
