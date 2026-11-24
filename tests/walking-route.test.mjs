import test from 'node:test';
import assert from 'node:assert/strict';
import { planWalkingLegs, queryWalkingLeg } from '../src/ui/walkingRoute.js';

test('步行查询使用返回的道路形状、距离和秒数', async () => {
  const walker = { search: (_a, _b, cb) => cb('complete', { routes: [{ distance: 960, time: 720, steps: [{ path: [[1, 2], [3, 4]] }] }] }) };
  const route = await queryWalkingLeg(walker, [1, 2], [3, 4]);
  assert.equal(route.distance, 960);
  assert.equal(route.seconds, 720);
  assert.deepEqual(route.path, [[1, 2], [3, 4]]);
});

test('无结果、缺少道路形状或超时不会冒充成功', async () => {
  await assert.rejects(queryWalkingLeg({ search: (_a, _b, cb) => cb('error', {}) }, [1, 2], [3, 4]));
  await assert.rejects(queryWalkingLeg({ search: (_a, _b, cb) => cb('complete', { routes: [{ distance: 5, time: 1, steps: [] }] }) }, [1, 2], [3, 4]));
  await assert.rejects(queryWalkingLeg({ search: () => {} }, [1, 2], [3, 4], 5));
});

test('多站点逐段查询，失败只降级相应路段且不跨越无坐标站点', async () => {
  const points = [
    { name: 'A', position: [1, 1] }, { name: 'B', position: [2, 2] },
    { name: 'C', position: [3, 3] }, { name: 'D', position: null }, { name: 'E', position: [5, 5] },
  ];
  const calls = [];
  const legs = await planWalkingLegs(points, async (from, to) => {
    calls.push([from, to]);
    if (from[0] === 2) throw new Error('unavailable');
    return { distance: 10, seconds: 5, path: [from, to] };
  });
  assert.deepEqual(legs.map((leg) => leg.status), ['network', 'fallback_straight', 'unavailable', 'unavailable']);
  assert.equal(calls.length, 2);
});
