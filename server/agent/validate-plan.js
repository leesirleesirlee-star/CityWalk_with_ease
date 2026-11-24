/**
 * AI 返回计划的校验与归一化（纯函数，无 IO）。
 *
 * 输入是 DeepSeek 的 JSON（字符串或已解析对象），输出：
 *   { ok, plan: { interests, constraints, pace, stops, route_reason, dropped } | null,
 *     warnings: string[], errors: Array<{ code, message }> }
 *
 * 规则：
 *   - 剥离 ```json 围栏；
 *   - stops 2–8（超出截断并告警）；
 *   - poi_id 必须在 catalog 中存在且有坐标，未知/无坐标丢弃并记录；
 *   - 重复 id 去重；
 *   - stay_min clamp 到 15–120；
 *   - pace 仅 relaxed/balanced/packed；
 *   - constraints 仅 low_walk/evening/family/quiet/rain/no_hike，未知忽略；
 *   - 有效站 < 2 → errors 含 NO_CANDIDATES。
 */

export const MIN_STOPS = 2;
export const MAX_STOPS = 8;
export const STAY_MIN_LIMIT = 15;
export const STAY_MAX_LIMIT = 120;

export const ALLOWED_CONSTRAINTS = Object.freeze(['low_walk', 'evening', 'family', 'quiet', 'rain', 'no_hike']);
export const PACES = Object.freeze(['relaxed', 'balanced', 'packed']);

/** 去掉 ```json ... ``` / ``` ... ``` 围栏。 */
export function stripCodeFence(text) {
  const raw = String(text ?? '').trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(raw);
  return fenced ? fenced[1].trim() : raw;
}

/** 尝试把 AI 返回解析成对象。 */
export function parseAiJson(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  const text = stripCodeFence(raw);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function hasCoords(poi) {
  return Boolean(poi) && Number.isFinite(poi.lat) && Number.isFinite(poi.lng);
}

function normalizeStringList(value, maxItems) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const list = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const text = item.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    list.push(text);
    if (list.length >= maxItems) break;
  }
  return list;
}

/**
 * @param {unknown} raw DeepSeek 返回的 JSON 字符串或对象
 * @param {{ catalog?: Array<object>, budgetMin?: number }} [context]
 * @returns {{ ok: boolean, plan: object|null, warnings: string[], errors: Array<{code:string,message:string}> }}
 */
export function validateAiPlan(raw, { catalog = [], budgetMin = 180 } = {}) {
  const warnings = [];
  const errors = [];
  const parsed = parseAiJson(raw);
  if (!parsed) {
    return {
      ok: false,
      plan: null,
      warnings,
      errors: [{ code: 'INVALID_JSON', message: 'AI 返回内容无法解析为 JSON 对象' }],
    };
  }

  const byId = new Map();
  for (const poi of Array.isArray(catalog) ? catalog : []) {
    const id = String(poi?.id ?? poi?.poi_id ?? '').trim();
    if (id && !byId.has(id)) byId.set(id, poi);
  }

  let rawStops = Array.isArray(parsed.stops) ? parsed.stops : [];
  if (!rawStops.length) {
    return {
      ok: false,
      plan: null,
      warnings,
      errors: [{ code: 'NO_CANDIDATES', message: 'AI 未返回任何 stops' }],
    };
  }
  if (rawStops.length > MAX_STOPS) {
    warnings.push(`AI 返回 ${rawStops.length} 站，超过上限 ${MAX_STOPS}，已截断队尾`);
    rawStops = rawStops.slice(0, MAX_STOPS);
  }

  const seen = new Set();
  const stops = [];
  const dropped = [];

  for (const [index, rawStop] of rawStops.entries()) {
    const id = String(rawStop?.poi_id ?? rawStop?.id ?? '').trim();
    if (!id) {
      warnings.push(`stops[${index}] 缺少 poi_id，已丢弃`);
      continue;
    }
    const poi = byId.get(id);
    if (!poi) {
      warnings.push(`未知 POI id「${id}」不在候选表，已丢弃`);
      dropped.push({ id, reason: 'unknown_id' });
      continue;
    }
    if (!hasCoords(poi)) {
      warnings.push(`POI「${id}」缺少坐标，已丢弃`);
      dropped.push({ id, reason: 'no_coords' });
      continue;
    }
    if (seen.has(id)) {
      warnings.push(`重复 POI「${id}」，已去重`);
      dropped.push({ id, reason: 'duplicate' });
      continue;
    }
    seen.add(id);

    const rawStay = Number(rawStop?.stay_min ?? poi.stay_min);
    let stayMin = Number.isFinite(rawStay) && rawStay > 0 ? Math.round(rawStay) : 30;
    if (stayMin < STAY_MIN_LIMIT) {
      warnings.push(`POI「${id}」stay_min=${stayMin} 低于下限，按 ${STAY_MIN_LIMIT} 处理`);
      stayMin = STAY_MIN_LIMIT;
    } else if (stayMin > STAY_MAX_LIMIT) {
      warnings.push(`POI「${id}」stay_min=${stayMin} 高于上限，按 ${STAY_MAX_LIMIT} 处理`);
      stayMin = STAY_MAX_LIMIT;
    }

    let why = typeof rawStop?.why === 'string' ? rawStop.why.trim() : '';
    if (!why) {
      warnings.push(`POI「${id}」缺少 why，已用兜底理由`);
      why = `${poi.name || id}符合本次偏好且路线顺路`;
    }
    if (why.length > 120) why = `${why.slice(0, 120)}…`;

    let intro = typeof rawStop?.intro === 'string' ? rawStop.intro.replace(/<[^>]*>/g, '').trim() : '';
    if (intro.length > 160) intro = `${intro.slice(0, 160)}…`;

    stops.push({ poi_id: id, why, intro, stay_min: stayMin });
  }

  if (stops.length < MIN_STOPS) {
    return {
      ok: false,
      plan: null,
      warnings,
      errors: [
        {
          code: 'NO_CANDIDATES',
          message: `有效站点仅 ${stops.length} 个，少于 ${MIN_STOPS} 个`,
        },
      ],
    };
  }

  const interests = normalizeStringList(parsed.interests, 12);
  if (!interests.length) warnings.push('AI 未给出 interests，已交由上层使用系统偏好');

  const rawConstraints = Array.isArray(parsed.constraints) ? parsed.constraints : [];
  const constraints = [];
  for (const item of rawConstraints) {
    const code = typeof item === 'string' ? item.trim() : '';
    if (!code) continue;
    if (!ALLOWED_CONSTRAINTS.includes(code)) {
      // 模型偶尔把“至少5站 / 240分钟 / 09:00开始”当约束返回；这是系统参数，不提示用户。
      if (/(至少|最少|预算|分钟|开始|\d+\s*站|^\d)/.test(code)) continue;
      warnings.push(`未知约束「${code}」已忽略`);
      continue;
    }
    if (!constraints.includes(code)) constraints.push(code);
  }

  const pace = PACES.includes(parsed.pace) ? parsed.pace : 'balanced';
  if (pace !== parsed.pace) warnings.push(`pace「${String(parsed.pace)}」非法，已回退 balanced`);

  const names = stops.map((stop) => byId.get(stop.poi_id)?.name || stop.poi_id);
  let routeReason = typeof parsed.route_reason === 'string' ? parsed.route_reason.trim() : '';
  if (!routeReason) {
    warnings.push('AI 未给出 route_reason，已用站序兜底');
    routeReason = `${names.join(' → ')} 按偏好与顺路程度串联。`;
  }
  if (routeReason.length > 300) routeReason = `${routeReason.slice(0, 300)}…`;

  const staySum = stops.reduce((sum, stop) => sum + stop.stay_min, 0);
  if (Number.isFinite(Number(budgetMin)) && staySum > Number(budgetMin)) {
    warnings.push(`仅停留合计 ${staySum} 分钟已超预算 ${Number(budgetMin)} 分钟，组装时会从队尾截断`);
  }

  return {
    ok: true,
    plan: {
      interests,
      constraints,
      pace,
      stops,
      route_reason: routeReason,
      dropped,
    },
    warnings,
    errors,
  };
}

export default validateAiPlan;
