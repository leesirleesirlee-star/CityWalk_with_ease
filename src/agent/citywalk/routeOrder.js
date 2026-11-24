/**
 * 路线顺向排序（T4.14）。
 *
 * 只做后处理：保持首站（评分最高）不变，其余站点按「距当前站最近」贪心串联，
 * 然后重建 order 与 leg。不增删站点、不改站点属性、不动 dropped。
 */

import { buildLeg, straightDistanceM } from './planner.js';

function walkTotal(route) {
  let total = 0;
  for (const stop of route) {
    if (stop?.leg && Number.isFinite(stop.leg.distance_m)) total += stop.leg.distance_m;
  }
  return Math.round(total * 10) / 10;
}

/**
 * @param {Array<object>} route 已入选站点（含 lat/lng）
 * @param {{ pace?: string }} options
 * @returns {{ route: Array<object>, changed: boolean, before_walk_m: number, after_walk_m: number, saved_m: number }}
 */
export function sortRouteByProximity(route, { pace = 'balanced' } = {}) {
  const source = Array.isArray(route) ? route : [];
  const beforeWalk = walkTotal(source);

  if (source.length <= 2) {
    return {
      route: source,
      changed: false,
      before_walk_m: beforeWalk,
      after_walk_m: beforeWalk,
      saved_m: 0,
    };
  }

  const [start, ...rest] = source;
  const ordered = [start];
  const remaining = rest.slice();

  while (remaining.length > 0) {
    const current = ordered[ordered.length - 1];
    let bestIndex = 0;
    let bestDistance = Infinity;
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index];
      const distance = straightDistanceM(current, candidate);
      // 距离相同（含坐标缺失）时保留原相对顺序，保证结果确定。
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }
    ordered.push(remaining.splice(bestIndex, 1)[0]);
  }

  const rebuilt = ordered.map((stop, index) => ({
    ...stop,
    order: index + 1,
    leg: index === 0 ? null : buildLeg(ordered[index - 1], stop, pace),
  }));

  const afterWalk = walkTotal(rebuilt);

  // 最近邻是启发式，可能比 planner 的原始顺序更长；变长就不采纳。
  if (afterWalk > beforeWalk) {
    return {
      route: source,
      changed: false,
      before_walk_m: beforeWalk,
      after_walk_m: beforeWalk,
      saved_m: 0,
    };
  }

  const changed = rebuilt.some((stop, index) => stop.id !== source[index]?.id);

  return {
    route: rebuilt,
    changed,
    before_walk_m: beforeWalk,
    after_walk_m: afterWalk,
    saved_m: Math.round((beforeWalk - afterWalk) * 10) / 10,
  };
}
