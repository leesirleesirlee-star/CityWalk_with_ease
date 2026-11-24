import test from 'node:test';
import assert from 'node:assert/strict';
import { wgs84ToBd09, wgs84ToGcj02 } from '../src/baidu/coord.js';

test('成都宽窄巷子 WGS84 转 BD09 落在成都市中心合理范围', () => {
  const [lng, lat] = wgs84ToBd09([104.0578, 30.6696]);
  assert.ok(lng > 104.06 && lng < 104.08, `lng=${lng}`);
  assert.ok(lat > 30.66 && lat < 30.69, `lat=${lat}`);
});

test('杭州西湖 WGS84 转 BD09 落在西湖东侧合理范围', () => {
  const [lng, lat] = wgs84ToBd09([120.15, 30.245]);
  assert.ok(lng > 120.15 && lng < 120.17, `lng=${lng}`);
  assert.ok(lat > 30.24 && lat < 30.27, `lat=${lat}`);
});

test('GCJ02 偏移量在城区为数百米级', () => {
  const [lng, lat] = wgs84ToGcj02(104.0578, 30.6696);
  const dx = (lng - 104.0578) * 111000 * Math.cos((30.6696 * Math.PI) / 180);
  const dy = (lat - 30.6696) * 111000;
  assert.ok(Math.abs(dx) > 50 && Math.abs(dx) < 900, `dx=${dx}`);
  assert.ok(Math.abs(dy) > 50 && Math.abs(dy) < 900, `dy=${dy}`);
});
