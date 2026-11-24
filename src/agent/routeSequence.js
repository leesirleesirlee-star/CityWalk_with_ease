/**
 * 固定顺序路线时刻表（AI 选点后置）。
 *
 * 与 routeOptimizer.orderRoute 的区别：
 *   - orderRoute 会按距离/时段重排候选；
 *   - 本模块**绝不重排**，只按输入顺序逐站计算到达时间、停留时长与相邻站直线步行段，
 *     供服务端 AI 规划把 LLM 给出的站序原样落成 tour_script.route。
 *
 * 纯函数：无 IO、不读环境变量、不修改入参、不调用 Date.now()。
 * 步行速度统一复用 citywalk/budget.js 的 PACE_SPEED_KMH / estimateWalkMinutes 口径。
 */

import { estimateWalkMinutes } from './citywalk/budget.js';

/** 末站到达上限：22:30。超过则从队尾截断，避免排到深夜。 */
export const LAST_ARRIVAL_LIMIT_MIN = 22 * 60 + 30;
export const DEFAULT_START_TIME = '09:00';
export const DEFAULT_STAY_MIN = 30;

const TIME_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const PACES = new Set(['relaxed', 'balanced', 'packed']);
const round1 = (value) => Math.round(value * 10) / 10;
const toRad = (deg) => (deg * Math.PI) / 180;

function hasCoords(poi) {
  return Boolean(poi) && Number.isFinite(poi.lat) && Number.isFinite(poi.lng);
}

/** 两个 { lat, lng } 之间的球面直线距离（米），与 planner.straightDistanceM 同口径。 */
export function haversineMeters(from, to) {
  if (!hasCoords(from) || !hasCoords(to)) return 0;
  const dLat = toRad(to.lat - from.lat);
  const dLng = toRad(to.lng - from.lng);
  const lat1 = toRad(from.lat);
  const lat2 = toRad(to.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h))));
}

/** "HH:MM" → 当日分钟数。 */
export function clockToMinutes(clock) {
  const [h, m] = String(clock).split(':').map(Number);
  return h * 60 + m;
}

/** 分钟数 → "HH:MM"（跨日按 24 小时取模，仅用于展示）。 */
export function minutesToClock(minutes) {
  const total = Math.round(minutes) % (24 * 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** 时刻 → 时段（morning / afternoon / evening）。 */
export function slotFromClock(clock) {
  const hour = Number(String(clock).slice(0, 2));
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  return 'evening';
}

function idOf(poi) {
  return String(poi?.poi_id ?? poi?.id ?? '');
}

/**
 * 按输入顺序排时刻表（不重排）。
 *
 * @param {object} [options]
 * @param {Array<object>} [options.selected] 已按目标顺序排好的景点（含 lat/lng/stay_min）
 * @param {{ startTime?: string, cityMeta?: object, pace?: string }} [options.ctx]
 * @param {number} [options.paceFactor=1] 停留时长系数（>0），不改变顺序
 * @returns {{ ordered: Array<object>, travel: Array<object>, totals: object }}
 *   ordered[i] = { poi, arrivalMinute, arrivalTime, duration, timeSlot, travelMin, legKm, distanceM }
 *   travel[i]  = { from_poi_id, to_poi_id, km, minutes, distance_m }（长度 = ordered.length - 1）
 *   totals     = { poiCount, visitMin, travelMin, spanMin, lastArrivalTime, lastArrivalMinute,
 *                  lastEndMinute, lastEndTime, lastArrivalOverBy }
 */
export function orderFixedSequence({
  selected = [],
  ctx = { startTime: DEFAULT_START_TIME, cityMeta: null },
  paceFactor = 1,
} = {}) {
  const list = Array.isArray(selected) ? selected : [];
  const startTime = TIME_RE.test(ctx?.startTime || '') ? ctx.startTime : DEFAULT_START_TIME;
  const pace = PACES.has(ctx?.pace) ? ctx.pace : 'balanced';
  const factor = Number.isFinite(paceFactor) && paceFactor > 0 ? paceFactor : 1;

  const ordered = [];
  const travel = [];
  let clock = clockToMinutes(startTime);
  let previous = null;

  for (const poi of list) {
    let distanceM = 0;
    let travelMin = 0;
    if (previous) {
      distanceM = hasCoords(previous) && hasCoords(poi) ? haversineMeters(previous, poi) : 0;
      travelMin = estimateWalkMinutes(distanceM, pace);
      clock += travelMin;
      travel.push({
        from_poi_id: idOf(previous),
        to_poi_id: idOf(poi),
        km: round1(distanceM / 1000),
        minutes: travelMin,
        distance_m: distanceM,
      });
    }
    const arrivalMinute = clock;
    const rawStay = Number(poi?.stay_min);
    const baseStay = Number.isFinite(rawStay) ? rawStay : DEFAULT_STAY_MIN;
    const duration = Math.max(1, Math.round(baseStay * factor));
    ordered.push({
      poi,
      arrivalMinute,
      arrivalTime: minutesToClock(arrivalMinute),
      duration,
      timeSlot: slotFromClock(minutesToClock(arrivalMinute)),
      travelMin,
      legKm: round1(distanceM / 1000),
      distanceM,
    });
    clock += duration;
    previous = poi;
  }

  // 安全阀：末站到达不得晚于 22:30，从队尾截断（保留输入顺序）。
  // routeSequence 只保证至少 1 站；是否够 2 站由 composer/上层判断。
  while (ordered.length > 1 && ordered[ordered.length - 1].arrivalMinute > LAST_ARRIVAL_LIMIT_MIN) {
    ordered.pop();
    travel.pop();
  }

  const last = ordered.length ? ordered[ordered.length - 1] : null;
  const visitMin = ordered.reduce((sum, entry) => sum + entry.duration, 0);
  const travelMin = ordered.reduce((sum, entry) => sum + entry.travelMin, 0);
  const spanMin = visitMin + travelMin;

  return {
    ordered,
    travel,
    totals: {
      poiCount: ordered.length,
      visitMin,
      travelMin,
      spanMin,
      lastArrivalTime: last ? last.arrivalTime : null,
      lastArrivalMinute: last ? last.arrivalMinute : null,
      lastEndMinute: last ? last.arrivalMinute + last.duration : null,
      lastEndTime: last ? minutesToClock(last.arrivalMinute + last.duration) : null,
      lastArrivalOverBy: last ? Math.max(0, last.arrivalMinute - LAST_ARRIVAL_LIMIT_MIN) : 0,
    },
  };
}

export default orderFixedSequence;
