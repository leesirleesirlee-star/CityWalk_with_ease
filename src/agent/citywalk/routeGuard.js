/**
 * T4.3 STEP 1 · 空路线兜底（上层 guard，不改 planner 选点逻辑）
 *
 * 为什么需要这一层：
 *   tour_script 1.1.0 要求 route.minItems = 1，而 planner.planTour 在
 *   「没有任何候选能放进预算」时按设计返回 route: []。直接拿去用会产出
 *   违反契约的脚本，前端也只会显示空白。
 *
 * 本模块的边界：
 *   1. 不做选点、不改评分、不改预算公式，全部复用 planner.planTour；
 *   2. 只在结果为空时判定空因，并按「保底 1 站」重算一次；
 *   3. 若一个可用点都没有（全无坐标 / 全闭馆 / 全被移除），返回 script: null
 *      与结构化 guard，绝不用假数据凑出一个合法脚本。
 *
 * 降级信息写在哪里：只写在契约允许的字段里（route[0].reason 与
 * agent_trace[].warnings），guard 元信息放在返回值第二层，不污染 script。
 */

import { planTour } from './planner.js';
import { resolveStayMinutes, normalizeBudget } from './budget.js';

const round1 = (v) => Math.round(v * 10) / 10;

const idOf = (poi) => String(poi?.poi_id ?? poi?.id ?? '');

/** 与 planner.coordsOf 判定同源：只认 lat/lng 或 GeoJSON 坐标。 */
function hasCoords(poi) {
  if (Number.isFinite(poi?.lat) && Number.isFinite(poi?.lng)) return true;
  const c = poi?.geometry?.coordinates;
  return Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]);
}

function stayOf(poi) {
  const { stay_min: raw } = resolveStayMinutes(poi);
  return Math.max(1, Math.round(raw));
}

/** 只有「坐标可用 + 未闭馆 + 未被移除」的点才有资格做保底。 */
function eligible(poi, removed) {
  if (!poi) return false;
  if (removed.has(idOf(poi))) return false;
  if (poi?.opening_hours === 'closed') return false;
  if (poi?.coord_source === 'unmatched') return false;
  return hasCoords(poi);
}

/**
 * 空因判定（纯函数，可单测）。
 * 顺序有意义：先排除「结构性无候选」，再归因到预算/评分。
 */
export function diagnoseEmpty({ pois, removedIds = [] } = {}) {
  const list = Array.isArray(pois) ? pois : [];
  if (list.length === 0) {
    return { code: 'no_candidates', detail: '候选列表为空' };
  }

  const removed = new Set((Array.isArray(removedIds) ? removedIds : []).map(String));
  const kept = list.filter((poi) => !removed.has(idOf(poi)));
  if (kept.length === 0) {
    return { code: 'all_removed', detail: '全部点位已被用户移除' };
  }
  if (kept.every((poi) => poi?.opening_hours === 'closed')) {
    return { code: 'all_closed', detail: '全部点位当前不开放' };
  }

  const located = kept.filter((poi) => hasCoords(poi) && poi?.coord_source !== 'unmatched');
  if (located.length === 0) {
    return { code: 'all_unmatched', detail: '全部点位缺少可用坐标' };
  }
  return { code: 'budget_or_score', detail: '存在可用点位，但均超出预算或低于评分阈值' };
}

/** 保底点：耗时最短优先，同耗按 id 字典序，保证确定性。 */
export function pickFallbackStop({ pois, removedIds = [] } = {}) {
  const list = Array.isArray(pois) ? pois : [];
  const removed = new Set((Array.isArray(removedIds) ? removedIds : []).map(String));
  const pool = list.filter((poi) => eligible(poi, removed));
  if (pool.length === 0) return null;
  pool.sort((a, b) => stayOf(a) - stayOf(b) || idOf(a).localeCompare(idOf(b)));
  return pool[0];
}

/**
 * 带兜底的规划入口。其余参数与 planTour 完全一致（preferences 由 STEP 2 接入）。
 * 返回 { script | null, selected, dropped, summary, guard }。
 */
export function planWithGuard({
  city,
  pois,
  budgetMin,
  mode = 'strict',
  pace = 'balanced',
  now,
  removedIds = [],
  source = 'local',
  preferences,
} = {}) {
  const base = planTour({ city, pois, budgetMin, mode, pace, now, removedIds, source, preferences });

  if (base.script.route.length > 0) {
    return {
      ...base,
      guard: { status: 'ok', code: null, overrun_min: 0, note: '常规选点，未触发兜底' },
    };
  }

  const diag = diagnoseEmpty({ pois, removedIds });
  const chosen = diag.code === 'budget_or_score' ? pickFallbackStop({ pois, removedIds }) : null;

  if (!chosen) {
    return {
      script: null,
      selected: [],
      dropped: base.dropped,
      summary: { ...base.summary, feasible: false },
      guard: { status: 'no_route', code: diag.code, overrun_min: 0, note: diag.detail },
    };
  }

  const inputMin = normalizeBudget(budgetMin).budget_min;
  const stayMin = stayOf(chosen);

  // 只放这一个点，预算设为其自身耗时：planner 的计算路径不变，只是输入被收敛。
  const fallback = planTour({
    city,
    pois: [chosen],
    budgetMin: stayMin,
    mode: 'strict',
    pace,
    now,
    removedIds: [],
    source,
    preferences,
  });

  if (fallback.script.route.length === 0) {
    return {
      script: null,
      selected: [],
      dropped: fallback.dropped,
      summary: { ...fallback.summary, feasible: false },
      guard: {
        status: 'no_route',
        code: 'score_below_threshold',
        overrun_min: 0,
        note: `${diag.detail}；保底点位评分仍低于阈值`,
      },
    };
  }

  const totalMin = fallback.script.meta.budget.total_min;
  const overrun = round1(Math.max(0, totalMin - inputMin));
  const chosenId = idOf(chosen);

  // 候选守恒：保底点从 dropped 里移除（它已入选），其余空因记录必须保留，
  // 否则前端会丢失「为什么没去别的点」。
  const mergedDropped = base.dropped.filter((d) => d.id !== chosenId);
  fallback.script.meta.dropped = mergedDropped;
  fallback.dropped = mergedDropped;
  fallback.summary.candidate_count = Array.isArray(pois) ? pois.length : 0;
  fallback.summary.selected_count = 1;
  fallback.summary.dropped_count = mergedDropped.length;

  // 还原本来的输入预算：放宽只是兜底手段，不能伪装成用户预算。
  fallback.script.meta.budget.input_min = inputMin;
  fallback.summary.budget_min = inputMin;
  fallback.summary.relaxed_budget_min = stayMin;
  fallback.script.route[0].reason =
    `保底入选：原预算 ${inputMin} 分钟容纳不下任何候选，按耗时最短点位强制成行` +
    (overrun > 0 ? `，实际超出 ${overrun} 分钟` : '');

  const trace = fallback.script.meta.agent_trace;
  const last = trace[trace.length - 1];
  last.output_summary = `入选 1，丢弃 ${mergedDropped.length}`;
  last.hits = 1;
  last.warnings = [...(last.warnings || []), `空路线兜底：${diag.detail}`];

  fallback.summary.feasible = totalMin <= inputMin;

  return {
    ...fallback,
    guard: {
      status: 'fallback_1_stop',
      code: diag.code,
      overrun_min: overrun,
      note: `${diag.detail}；已保底 1 站（${chosen.name ?? idOf(chosen)}）`,
    },
  };
}
