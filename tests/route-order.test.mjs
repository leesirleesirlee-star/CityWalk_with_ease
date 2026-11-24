import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { sortRouteByProximity } from '../src/agent/citywalk/routeOrder.js';
import { runMasterPipeline } from '../src/agent/citywalk/masterPipeline.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadSample(name) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'cities', 'chengdu', name), 'utf8'));
}

test('T4.14 三站绕路场景：排序后总步行距离缩短', () => {
  const route = [
    { id: 'A', name: 'A', lat: 30.6, lng: 104.07, stay_min: 40, order: 1, leg: null },
    { id: 'B', name: 'B', lat: 30.72, lng: 104.16, stay_min: 40, order: 2, leg: { distance_m: 16000 } },
    { id: 'C', name: 'C', lat: 30.605, lng: 104.075, stay_min: 40, order: 3, leg: { distance_m: 16000 } },
  ];
  const result = sortRouteByProximity(route, { pace: 'balanced' });
  assert.equal(result.changed, true);
  assert.equal(result.route.map((stop) => stop.id).join('->'), 'A->C->B');
  assert.ok(result.after_walk_m < result.before_walk_m);
  assert.ok(result.saved_m > 0);
  assert.equal(result.route[0].leg, null);
  assert.equal(result.route[1].leg.from_id, 'A');
  assert.equal(result.route[2].leg.from_id, 'C');
});

test('T4.14 站点集合不变：重排前后 id 集合完全一致', () => {
  const sample = loadSample('tour_script.chengdu-master-humanities.json');
  const before = sample.route.map((stop) => stop.id).sort();
  const result = sortRouteByProximity(sample.route, { pace: 'relaxed' });
  const after = result.route.map((stop) => stop.id).sort();

  assert.deepEqual(after, before);
  assert.equal(result.route.length, sample.route.length);
  // 只调整顺序，不改站点属性
  const byId = new Map(sample.route.map((stop) => [stop.id, stop]));
  for (const stop of result.route) {
    assert.equal(stop.stay_min, byId.get(stop.id).stay_min);
    assert.equal(stop.name, byId.get(stop.id).name);
    assert.equal(stop.score, byId.get(stop.id).score);
  }
});

test('T4.14 经典两站场景：排序结果与原顺序一致', () => {
  const result = runMasterPipeline('成都半天，想喝茶、拍照、少走路，预算3小时');
  assert.equal(result.ok, true);
  const route = result.script.route;
  assert.ok(route.length >= 2, `route=${route.length}`);
  assert.equal(route[0].leg, null);
  for (let index = 1; index < route.length; index += 1) {
    assert.equal(route[index].leg.from_id, route[index - 1].id);
    assert.equal(route[index].leg.to_id, route[index].id);
    assert.equal(route[index].leg.routing_status, 'fallback_straight');
  }
});
