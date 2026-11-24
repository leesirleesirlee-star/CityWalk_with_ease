import assert from 'node:assert/strict';
import test from 'node:test';

import {
  orderFixedSequence,
  minutesToClock,
  clockToMinutes,
  LAST_ARRIVAL_LIMIT_MIN,
} from '../src/agent/routeSequence.js';

const poi = (id, lat, lng, stay_min = 45) => ({ poi_id: id, id, name: id, lat, lng, stay_min });

test('routeSequence：严格保持输入顺序，不按距离重排', () => {
  // 故意给一个「东 → 西 → 中间」的绕路顺序，确认结果不被优化。
  const selected = [
    poi('east', 30.66, 104.09),
    poi('west', 30.65, 104.02),
    poi('middle', 30.655, 104.055),
  ];
  const result = orderFixedSequence({ selected, ctx: { startTime: '09:00' } });

  assert.equal(result.ordered.map((entry) => entry.poi.poi_id).join('->'), 'east->west->middle');
  assert.equal(result.travel.length, 2);
  assert.equal(result.travel[0].from_poi_id, 'east');
  assert.equal(result.travel[0].to_poi_id, 'west');
  assert.equal(result.travel[1].from_poi_id, 'west');
  assert.equal(result.travel[1].to_poi_id, 'middle');
  assert.equal(result.totals.poiCount, 3);
});

test('routeSequence：3 站到达时间严格递增，步行段按 budget.js 口径估算', () => {
  const selected = [
    poi('a', 30.6594, 104.0554, 45),
    poi('b', 30.6662, 104.0513, 45),
    poi('c', 30.6484, 104.0455, 40),
  ];
  const result = orderFixedSequence({ selected, ctx: { startTime: '09:00' } });

  const arrivals = result.ordered.map((entry) => entry.arrivalMinute);
  assert.equal(arrivals.length, 3);
  for (let i = 1; i < arrivals.length; i += 1) {
    assert.ok(arrivals[i] > arrivals[i - 1], `第 ${i + 1} 站到达时间必须晚于上一站`);
  }
  assert.equal(result.ordered[0].arrivalTime, '09:00');
  // 相邻两站之间的步行分钟数与旅行段一致；均大于 0（真实距离）。
  for (let i = 1; i < result.ordered.length; i += 1) {
    assert.ok(result.ordered[i].travelMin > 0);
    assert.equal(result.ordered[i].travelMin, result.travel[i - 1].minutes);
    assert.ok(result.travel[i - 1].distance_m > 0);
  }
  assert.equal(result.totals.visitMin, 45 + 45 + 40);
  assert.ok(result.totals.spanMin > result.totals.visitMin);
  // 所有到达时刻都能被解析成单调递增的分钟数（arrivalMinute 保留 1 位小数，展示取整）
  const clocks = result.ordered.map((entry) => clockToMinutes(entry.arrivalTime));
  assert.deepEqual(clocks, arrivals.map((minute) => Math.round(minute)));
});

test('routeSequence：末站到达超过 22:30 时从队尾截断', () => {
  const selected = [
    poi('a', 30.6594, 104.0554, 120),
    poi('b', 30.6595, 104.0555, 120),
    poi('c', 30.6596, 104.0556, 120),
  ];
  const result = orderFixedSequence({ selected, ctx: { startTime: '20:00' } });

  assert.ok(result.ordered.length < 3, '末站超过 22:30 必须截断');
  assert.ok(result.ordered.length >= 1, '至少保留 1 站');
  const last = result.ordered[result.ordered.length - 1];
  assert.ok(last.arrivalMinute <= LAST_ARRIVAL_LIMIT_MIN, '截断后末站到达必须 <= 22:30');
  assert.equal(result.travel.length, result.ordered.length - 1);
  assert.equal(result.totals.poiCount, result.ordered.length);
  assert.equal(
    result.totals.lastArrivalTime,
    minutesToClock(last.arrivalMinute),
  );
});

test('routeSequence：空输入返回空结构且不抛异常', () => {
  const result = orderFixedSequence({ selected: [], ctx: { startTime: '09:00' } });

  assert.deepEqual(result.ordered, []);
  assert.deepEqual(result.travel, []);
  assert.equal(result.totals.poiCount, 0);
  assert.equal(result.totals.visitMin, 0);
  assert.equal(result.totals.travelMin, 0);
  assert.equal(result.totals.spanMin, 0);
  assert.equal(result.totals.lastArrivalTime, null);
  assert.equal(result.totals.lastEndTime, null);

  // 兼容缺省参数
  const fallback = orderFixedSequence();
  assert.deepEqual(fallback.ordered, []);
});
