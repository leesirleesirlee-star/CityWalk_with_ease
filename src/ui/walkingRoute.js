/** Convert AMap Walking's callback to a bounded, validated result. */
export function queryWalkingLeg(walking, origin, destination, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error('步行路线查询超时')), timeoutMs);
    try {
      walking.search(origin, destination, (status, result) => {
        const route = result?.routes?.[0];
        const distance = Number(route?.distance);
        const seconds = Number(route?.time);
        const path = (route?.steps || []).flatMap((step) => step.path || []);
        if (status !== 'complete' || !route || route.distance == null || route.time == null ||
            !Number.isFinite(distance) || distance < 0 || !Number.isFinite(seconds) || seconds < 0 || path.length < 2) {
          finish(reject, new Error('步行路线不可用'));
          return;
        }
        finish(resolve, { distance, seconds, path });
      });
    } catch (error) {
      finish(reject, error);
    }
  });
}

/** Query each adjacent pair without persisting the provider's response. */
export async function planWalkingLegs(points, search) {
  const legs = [];
  for (let i = 1; i < points.length; i += 1) {
    const from = points[i - 1];
    const to = points[i];
    if (!from.position || !to.position) {
      legs.push({ from, to, status: 'unavailable' });
      continue;
    }
    try {
      const result = await search(from.position, to.position);
      legs.push({ from, to, status: 'network', ...result });
    } catch {
      legs.push({ from, to, status: 'fallback_straight' });
    }
  }
  return legs;
}
