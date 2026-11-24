/**
 * 成都主城区地图舞台。
 *
 * 约束：
 * - 纯 SVG，无第三方底图库；
 * - 经纬度固定投影到 DEMO_BOUNDS，视口平移/缩放被钳制在成都主城区内；
 * - 只负责绘制与视口交互，不参与路线计算，也不改写 tour_script。
 *
 * 数据来自 tour_script.route；leg.routing_status 决定实线/虚线，
 * 与 renderTour.js 的 LEG_STYLE 口径一致。
 */
import './mapStage.css';

/** 演示范围（成都主城区），可视区域不得超出此矩形。 */
const DEMO_BOUNDS = Object.freeze({
  west: 103.995,
  east: 104.135,
  south: 30.6,
  north: 30.7,
});

/** 世界坐标尺寸，保持 4:3，便于 cover 适配各种容器比例。 */
const WORLD_W = 1200;
const WORLD_H = 900;

const ZOOM_MIN_FACTOR = 1;
const ZOOM_MAX_FACTOR = 3.2;

const STYLE_BY_STATUS = {
  network: { stroke: '#35b177', dash: null },
  fallback_straight: { stroke: '#e0a34a', dash: '10 7' },
  unavailable: { stroke: '#8a8f98', dash: '5 7' },
  unknown: { stroke: '#8a8f98', dash: '5 7' },
};

const svgNS = 'http://www.w3.org/2000/svg';

let root = null;
let layers = null;
let viewport = null;
let view = { x: 0, y: 0, w: WORLD_W, h: WORLD_H };
let limits = { wMin: WORLD_W / ZOOM_MAX_FACTOR, wMax: WORLD_W };
let size = { w: WORLD_W, h: WORLD_H };
let drag = null;
let hasInteracted = false;
/** 当前路线的世界坐标包围盒；未手动操作时视口自动贴合它。 */
let focusBounds = null;

function project(lng, lat) {
  const spanLng = DEMO_BOUNDS.east - DEMO_BOUNDS.west;
  const spanLat = DEMO_BOUNDS.north - DEMO_BOUNDS.south;
  return {
    x: ((lng - DEMO_BOUNDS.west) / spanLng) * WORLD_W,
    y: ((DEMO_BOUNDS.north - lat) / spanLat) * WORLD_H,
  };
}

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

function el(tag, attrs = {}, text = null) {
  const node = document.createElementNS(svgNS, tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (v === null || v === undefined || v === '') return;
    node.setAttribute(k, String(v));
  });
  if (text !== null) node.textContent = text;
  return node;
}

/* ── 视口 ───────────────────────────────────────────── */

function measure() {
  if (!root) return false;
  const box = root.getBoundingClientRect();
  if (box.width < 120 || box.height < 120) return false;
  size = { w: box.width, h: box.height };

  // 视口宽高比必须与容器一致，否则 SVG 会拉伸；同时不能超出世界矩形。
  const maxW = Math.min(WORLD_W, (WORLD_H * size.w) / size.h);
  limits = { wMax: maxW, wMin: maxW / ZOOM_MAX_FACTOR };
  return true;
}

function clampView() {
  view.w = clamp(view.w, limits.wMin, limits.wMax);
  view.h = (view.w * size.h) / size.w;
  view.x = clamp(view.x, 0, Math.max(0, WORLD_W - view.w));
  view.y = clamp(view.y, 0, Math.max(0, WORLD_H - view.h));
}

/**
 * 视口贴合路线包围盒：让路线占满画布，而不是缩在世界中心的一角。
 * 保留 padding，并把宽高比校正到容器比例，避免 SVG 拉伸。
 */
function applyFocus() {
  const focus = focusBounds;
  if (!focus) return;
  const padding = 84;
  const boxW = Math.max(160, focus.x1 - focus.x0) + padding * 2;
  const boxH = Math.max(120, focus.y1 - focus.y0) + padding * 2;
  const aspect = size.w / Math.max(1, size.h);
  let width = Math.max(boxW, boxH * aspect);
  width = clamp(width, limits.wMin, limits.wMax);
  view.w = width;
  view.h = (width * size.h) / size.w;
  view.x = (focus.x0 + focus.x1) / 2 - view.w / 2;
  view.y = (focus.y0 + focus.y1) / 2 - view.h / 2;
}

function boundsOf(stops) {
  const xs = stops.map((stop) => stop.x);
  const ys = stops.map((stop) => stop.y);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

/**
 * 密集站点横向分离（制图里的位移标注）。
 * 武侯祠与锦里直线相距 150 米，在这个比例下两个圆点会完全叠在一起、编号互相遮住。
 * 这里只把「屏幕上过近」的点沿垂直方向推开，属于示意表达；坐标真值仍在提示与详情里。
 */
function spreadDenseStops(stops) {
  const MIN_GAP = 34;
  for (let i = 0; i < stops.length; i += 1) {
    for (let j = i + 1; j < stops.length; j += 1) {
      const a = stops[i];
      const b = stops[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.hypot(dx, dy);
      if (distance >= MIN_GAP) continue;
      const nx = distance > 0.001 ? -dy / distance : 1;
      const ny = distance > 0.001 ? dx / distance : 0;
      const push = (MIN_GAP - distance) / 2 + 1;
      a.x += nx * push;
      a.y += ny * push;
      b.x -= nx * push;
      b.y -= ny * push;
    }
  }
}

/** 右侧详情面板占位（像素）：面板收起或窄屏抽屉时不再预留。 */
function reservedRight() {
  const panel = document.getElementById('tour-panel');
  if (!panel || panel.dataset.open === 'false') return 0;
  if (window.matchMedia('(max-width: 900px)').matches) return 0;
  return 320;
}

function syncViewBox() {
  if (!viewport) return;
  if (!hasInteracted) {
    if (focusBounds) {
      applyFocus();
    } else {
      view.w = limits.wMax * 0.92;
      view.h = (view.w * size.h) / size.w;
      const availW = Math.max(240, size.w - reservedRight());
      const centerPx = availW / 2 + 8;
      view.x = WORLD_W / 2 - (centerPx / size.w) * view.w;
      view.y = (WORLD_H - view.h) / 2;
    }
  }
  clampView();
  root.setAttribute('viewBox', `${view.x.toFixed(2)} ${view.y.toFixed(2)} ${view.w.toFixed(2)} ${view.h.toFixed(2)}`);
  updateScaleLabel();
}

function updateScaleLabel() {
  const label = document.getElementById('map-scale-label');
  if (!label) return;
  // 1 个世界单位 ≈ 13.4km / 1200；取当前宽度对应的公里数，取整到 0.5km。
  const kmPerWorld = 13.4 / WORLD_W;
  const km = view.w * kmPerWorld * 0.25;
  const rounded = Math.max(0.5, Math.round(km * 2) / 2);
  label.textContent = `${rounded} km`;
}

function zoomAt(pixelX, pixelY, factor) {
  const anchorX = view.x + (pixelX / size.w) * view.w;
  const anchorY = view.y + (pixelY / size.h) * view.h;
  const nextW = clamp(view.w * factor, limits.wMin, limits.wMax);
  view.w = nextW;
  view.h = (view.w * size.h) / size.w;
  view.x = anchorX - (pixelX / size.w) * view.w;
  view.y = anchorY - (pixelY / size.h) * view.h;
  hasInteracted = true;
  syncViewBox();
}

function bindViewport() {
  const localPoint = (event) => {
    const box = root.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };

  root.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const point = localPoint(event);
    drag = { startX: point.x, startY: point.y, viewX: view.x, viewY: view.y, moved: false, captured: false };
    // 注意：这里不能立刻 setPointerCapture。指针捕获会把后续 click 的目标改写成
    // SVG 根节点，站点圆点就永远收不到点击。改为真正开始拖动后再捕获。
    root.classList.add('is-dragging');
  });

  root.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const point = localPoint(event);
    const dx = ((point.x - drag.startX) / size.w) * view.w;
    const dy = ((point.y - drag.startY) / size.h) * view.h;
    if (Math.abs(dx) + Math.abs(dy) > 0.5) {
      drag.moved = true;
      hasInteracted = true;
      if (!drag.captured) {
        drag.captured = true;
        try { root.setPointerCapture?.(event.pointerId); } catch { /* 合成事件可能无有效 pointerId */ }
      }
    }
    view.x = drag.viewX - dx;
    view.y = drag.viewY - dy;
    syncViewBox();
  });

  const endDrag = (event) => {
    if (!drag) return;
    const { captured } = drag;
    drag = null;
    root.classList.remove('is-dragging');
    if (captured) {
      try { root.releasePointerCapture?.(event.pointerId); } catch { /* 同上 */ }
    }
  };
  root.addEventListener('pointerup', endDrag);
  root.addEventListener('pointercancel', endDrag);

  root.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      const point = localPoint(event);
      const factor = Math.exp(event.deltaY * 0.0016);
      zoomAt(point.x, point.y, factor);
    },
    { passive: false },
  );

  root.addEventListener('dblclick', (event) => {
    const point = localPoint(event);
    zoomAt(point.x, point.y, 1 / 1.45);
  });

  window.addEventListener('resize', () => {
    measure();
    syncViewBox();
  });

  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => {
      measure();
      syncViewBox();
    }).observe(root);
  }
}

/* ── 底图装饰 ───────────────────────────────────────── */

function buildBase() {
  const base = el('g', { class: 'map-base' });

  base.appendChild(el('rect', { x: 0, y: 0, width: WORLD_W, height: WORLD_H, class: 'map-ground' }));

  // 街区示意：几块轻微错位的圆角矩形，只做城市肌理，不代表真实地块。
  const blocks = [
    [60, 90, 250, 190, 18],
    [330, 60, 260, 170, 22],
    [620, 110, 230, 210, 20],
    [880, 80, 250, 180, 24],
    [90, 330, 230, 200, 20],
    [350, 300, 250, 220, 24],
    [640, 360, 240, 190, 18],
    [900, 320, 230, 220, 22],
    [120, 590, 260, 200, 22],
    [420, 580, 240, 210, 20],
    [700, 600, 250, 190, 24],
    [980, 590, 170, 200, 18],
  ];
  const blockLayer = el('g', { class: 'map-blocks' });
  blocks.forEach(([x, y, w, h, r]) => {
    blockLayer.appendChild(el('rect', { x, y, width: w, height: h, rx: r, class: 'map-block' }));
  });
  base.appendChild(blockLayer);

  // 锦江示意：一条自西北向东南的曲线，再加一段环状支流。
  base.appendChild(
    el('path', {
      class: 'map-river',
      d: 'M 120 40 C 260 180, 300 330, 470 420 S 760 520, 900 700 S 1040 810, 1160 860',
    }),
  );
  base.appendChild(
    el('path', {
      class: 'map-river map-river--thin',
      d: 'M 470 420 C 520 340, 610 300, 720 330 S 860 420, 930 470',
    }),
  );

  // 主干道示意
  const roads = [
    'M 0 250 L 1200 300',
    'M 0 560 L 1200 520',
    'M 380 0 L 430 900',
    'M 820 0 L 780 900',
    'M 0 760 L 1200 700',
  ];
  const roadLayer = el('g', { class: 'map-roads' });
  roads.forEach((d) => roadLayer.appendChild(el('path', { d, class: 'map-road' })));
  base.appendChild(roadLayer);

  // 边界矩形：可见提示「范围锁定」，不喧宾夺主。
  base.appendChild(el('rect', { x: 2, y: 2, width: WORLD_W - 4, height: WORLD_H - 4, class: 'map-fence' }));

  return base;
}

/* ── 路线与站点 ─────────────────────────────────────── */

function legStyle(status) {
  return STYLE_BY_STATUS[status] ?? STYLE_BY_STATUS.unknown;
}

const LABEL_SIZE = 15.5;

/** 估算文字宽度：中文按 1 个字宽，其余按 0.52 字宽。 */
function textWidth(text, size = LABEL_SIZE) {
  let width = 0;
  for (const ch of String(text)) {
    width += /[\u2E80-\u9FFF\u3000-\u303F\uFF00-\uFFEF]/.test(ch) ? size : size * 0.52;
  }
  return width;
}

function boxesOverlap(a, b) {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

/**
 * 站点名称避让。
 *
 * 旧实现按序数交替上下偏移，遇到距离很近的两站（武侯祠 / 锦里）必然压字。
 * 这里按站点顺序，在「右 / 左 / 上 / 下」四个候选位里挑第一个既不压已放标签、
 * 也不盖住其他站点圆点的位置；四个都冲突时退回右侧，保证标签始终可读。
 */
function layoutLabels(stops) {
  const placed = [];
  const dots = stops.map((stop) => ({ x0: stop.x - 21, x1: stop.x + 21, y0: stop.y - 21, y1: stop.y + 21 }));

  return stops.map((stop, index) => {
    const text = stop.name ?? '未命名';
    const width = textWidth(text);
    const height = LABEL_SIZE;
    const gap = 40;
    const rectOf = (x0, y0) => ({ x0, y0, x1: x0 + width, y1: y0 + height * 1.25 });

    const candidates = [
      { anchor: 'start', x: stop.x + gap, dy: height * 0.36, rect: rectOf(stop.x + gap, stop.y - height * 0.55) },
      { anchor: 'end', x: stop.x - gap, dy: height * 0.36, rect: rectOf(stop.x - gap - width, stop.y - height * 0.55) },
      { anchor: 'middle', x: stop.x, dy: -gap + 2, rect: rectOf(stop.x - width / 2, stop.y - gap - height) },
      { anchor: 'middle', x: stop.x, dy: gap + height, rect: rectOf(stop.x - width / 2, stop.y + gap) },
    ];
    const others = dots.filter((_, i) => i !== index);
    const inView = (rect) => rect.x0 >= view.x + 6 && rect.x1 <= view.x + view.w - 6
      && rect.y0 >= view.y + 6 && rect.y1 <= view.y + view.h - 6;
    const free = (rect) => !placed.some((p) => boxesOverlap(rect, p)) && !others.some((d) => boxesOverlap(rect, d));

    // 打分而不是取第一个空位：两站挨得很近时，"第一个不冲突的位置"会把名字放到
    // 邻居那边，看起来像标错了站。这里额外奖励远离其他圆点的候选位。
    const scoreOf = (candidate) => {
      let score = 0;
      if (!free(candidate.rect)) score -= 10000;
      if (!inView(candidate.rect)) score -= 5000;
      const cx = (candidate.rect.x0 + candidate.rect.x1) / 2;
      const cy = (candidate.rect.y0 + candidate.rect.y1) / 2;
      for (const dot of others) {
        const dx = cx - (dot.x0 + dot.x1) / 2;
        const dy = cy - (dot.y0 + dot.y1) / 2;
        score += Math.min(80, Math.hypot(dx, dy));
      }
      return score;
    };
    const chosen = candidates.reduce((best, candidate) => (scoreOf(candidate) > scoreOf(best) ? candidate : best), candidates[0]);
    placed.push(chosen.rect);

    return { text, anchor: chosen.anchor, x: chosen.x, y: stop.y + chosen.dy };
  });
}

function renderRoute(script) {
  if (!layers) return;
  layers.route.replaceChildren();
  layers.stops.replaceChildren();
  if (!script || !Array.isArray(script.route) || !script.route.length) {
    root?.removeAttribute('data-has-route');
    return;
  }

  const stops = script.route
    .map((stop) => {
      const lng = Number(stop?.lng);
      const lat = Number(stop?.lat);
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
      return { ...stop, lng, lat, ...project(lng, lat) };
    })
    .filter(Boolean);

  if (!stops.length) return;

  spreadDenseStops(stops);
  focusBounds = boundsOf(stops);
  // 先算出贴合路线的视口，标签避让才能把「可见范围」当作边界。
  hasInteracted = false;
  applyFocus();
  clampView();

  // 折线：逐段绘制，保证每段按自身 routing_status 决定虚实。
  for (let i = 1; i < stops.length; i += 1) {
    const prev = stops[i - 1];
    const curr = stops[i];
    const status = curr.leg?.routing_status ?? 'unknown';
    const style = legStyle(status);
    const line = el('line', {
      x1: prev.x.toFixed(2),
      y1: prev.y.toFixed(2),
      x2: curr.x.toFixed(2),
      y2: curr.y.toFixed(2),
      class: `map-leg map-leg--${status}`,
      stroke: style.stroke,
      'stroke-dasharray': style.dash,
      'data-status': status,
    });
    line.style.animationDelay = `${i * 90}ms`;
    layers.route.appendChild(line);

    if (Number.isFinite(curr.leg?.walk_min)) {
      // 沿线段法线偏移，避免压在站名和圆点上。
      const dx = curr.x - prev.x;
      const dy = curr.y - prev.y;
      const len = Math.hypot(dx, dy) || 1;
      // 段越短，法线偏移越大，避免「2 min」这种短段标签压在站点圆点上。
      const offset = clamp(900 / len, 18, 46);
      const mx = (prev.x + curr.x) / 2 + (-dy / len) * offset;
      const my = (prev.y + curr.y) / 2 + (dx / len) * offset;
      const walk = el('text', {
        x: mx.toFixed(1),
        y: my.toFixed(1),
        class: `map-leg-label map-leg-label--${status}`,
        'text-anchor': 'middle',
      }, `${Math.round(curr.leg.walk_min)} min`);
      walk.style.animationDelay = `${i * 90 + 60}ms`;
      layers.route.appendChild(walk);
    }
  }

  const labels = layoutLabels(stops);

  stops.forEach((stop, index) => {
    const group = el('g', {
      class: 'map-stop',
      'data-order': stop.order ?? index + 1,
      'data-coord-source': stop.coord_source ?? 'matched',
      tabindex: '0',
      role: 'button',
      'aria-label': `${stop.order ?? index + 1}. ${stop.name ?? '未命名站点'}`,
    });
    group.style.animationDelay = `${index * 110}ms`;

    group.appendChild(el('circle', { cx: stop.x.toFixed(2), cy: stop.y.toFixed(2), r: 26, class: 'map-stop-halo' }));
    group.appendChild(el('circle', { cx: stop.x.toFixed(2), cy: stop.y.toFixed(2), r: 13, class: 'map-stop-dot' }));
    group.appendChild(
      el('text', { x: stop.x.toFixed(2), y: (stop.y + 4).toFixed(2), class: 'map-stop-index', 'text-anchor': 'middle' }, String(stop.order ?? index + 1).padStart(2, '0')),
    );

    const label = labels[index];
    group.appendChild(el('text', { x: label.x.toFixed(2), y: label.y.toFixed(2), class: 'map-stop-name', 'text-anchor': label.anchor }, label.text));
    // 坐标不再直接画在地图上（密集站点会被压成一片噪点），保留为悬停提示与可访问名。
    if (Number.isFinite(stop.lng) && Number.isFinite(stop.lat)) {
      group.appendChild(el('title', {}, `${label.text} · ${stop.lng.toFixed(4)}, ${stop.lat.toFixed(4)}`));
    }

    group.addEventListener('pointerenter', () => group.classList.add('is-hot'));
    group.addEventListener('pointerleave', () => group.classList.remove('is-hot'));
    group.addEventListener('focus', () => group.classList.add('is-hot'));
    group.addEventListener('blur', () => group.classList.remove('is-hot'));

    // 地图与时间线联动：圆点是 role="button"，必须真的能选中，否则只是装饰。
    const select = () => root.dispatchEvent(new CustomEvent('stop:select', { bubbles: true, detail: { index } }));
    group.addEventListener('click', select);
    group.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        select();
      }
    });

    layers.stops.appendChild(group);
  });

  root.setAttribute('data-has-route', '1');
  syncViewBox();
}

export function renderRouteOnMap(script) {
  if (!root) initMapStage();
  renderRoute(script);
}

export function resetMapView() {
  hasInteracted = false;
  measure();
  syncViewBox();
}

export function initMapStage() {
  if (root) return root;
  root = document.getElementById('map-canvas');
  if (!root) return null;

  root.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  root.replaceChildren();

  viewport = el('g', { class: 'map-viewport' });
  layers = {
    base: buildBase(),
    route: el('g', { class: 'map-route' }),
    stops: el('g', { class: 'map-stops' }),
  };
  viewport.append(layers.base, layers.route, layers.stops);
  root.appendChild(viewport);

  measure();
  syncViewBox();
  bindViewport();

  // 首次绘制时样式与布局可能尚未落定，下一帧再校正一次视口。
  requestAnimationFrame(() => {
    if (measure()) syncViewBox();
  });
  return root;
}
