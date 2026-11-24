import test from 'node:test';
import assert from 'node:assert/strict';
import { separatePoints, computeLayout, MIN_NODE_DIST } from '../src/ui/renderTour.js';

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// 内区尺寸与渲染层一致：720×460 画布减两侧 pad 56 → 608×348
const W = 608;
const H = 348;

test('ui-layout：最小间距 —— 原始 <30px 的两个节点，布局后 >=30px', () => {
  const pts = [{ x: 100, y: 100 }, { x: 110, y: 105 }];
  const before = dist(pts[0], pts[1]);
  assert.ok(before < MIN_NODE_DIST, `前置条件失败：原始距离 ${before.toFixed(2)} 不小于 ${MIN_NODE_DIST}`);

  const moved = separatePoints(pts, W, H);

  assert.equal(moved, true, '应报告发生过推开');
  const after = dist(pts[0], pts[1]);
  assert.ok(after >= MIN_NODE_DIST - 1e-9, `推开后距离 ${after.toFixed(2)} 仍小于 ${MIN_NODE_DIST}`);
  assert.ok(after <= MIN_NODE_DIST + 1, `推开幅度异常：${after.toFixed(2)}`);
});

test('ui-layout：边界钳制 —— 靠边重叠点不会被推出 [0,608]×[0,348]', () => {
  const pts = [
    { x: 0, y: 0 },
    { x: 2, y: 3 },
    { x: W, y: H },
    { x: W - 2, y: H - 3 },
  ];

  separatePoints(pts, W, H);

  for (const p of pts) {
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), `出现非有限值：${p.x},${p.y}`);
    assert.ok(p.x >= 0 && p.x <= W, `x 越界：${p.x}`);
    assert.ok(p.y >= 0 && p.y <= H, `y 越界：${p.y}`);
  }
});

test('ui-layout：120 轮上限 —— 10 节点挤在 50×50 内仍正常返回、无 NaN/Infinity', () => {
  const pts = Array.from({ length: 10 }, (_, i) => ({
    x: 20 + (i % 3) * 5,
    y: 20 + Math.floor(i / 3) * 5,
  }));
  const before = Math.min(...pts.flatMap((a, i) => pts.slice(i + 1).map((b) => dist(a, b))));
  assert.ok(before < MIN_NODE_DIST, `前置条件失败：最小原始间距 ${before}`);

  const moved = separatePoints(pts, W, H);

  assert.equal(moved, true);
  for (const p of pts) {
    assert.ok(Number.isFinite(p.x), `x 非有限：${p.x}`);
    assert.ok(Number.isFinite(p.y), `y 非有限：${p.y}`);
    assert.ok(p.x >= 0 && p.x <= W, `x 越界：${p.x}`);
    assert.ok(p.y >= 0 && p.y <= H, `y 越界：${p.y}`);
  }
});

test('ui-layout：computeLayout 输出坐标同样受边界约束', () => {
  const route = [
    { order: 1, name: 'A', lat: 30.6483863, lng: 104.0454567 },
    { order: 2, name: 'B', lat: 30.6488068, lng: 104.0469491 },
    { order: 3, name: 'C', lat: 30.6661912, lng: 104.051265 },
    { order: 4, name: 'D', lat: 30.6320131, lng: 104.0894282 },
  ];
  const layout = computeLayout(route, W, H);

  assert.equal(layout.points.length, 4);
  assert.equal(layout.width, W);
  assert.equal(layout.height, H);
  for (const p of layout.points) {
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
    assert.ok(p.x >= 0 && p.x <= W, `x 越界：${p.x}`);
    assert.ok(p.y >= 0 && p.y <= H, `y 越界：${p.y}`);
    assert.ok(p.label && Number.isFinite(p.label.lx) && Number.isFinite(p.label.ly));
  }
  // 武侯祠/锦里这一对必须被分开到 >=30
  assert.ok(dist(layout.points[0], layout.points[1]) >= MIN_NODE_DIST - 1e-9);
});
