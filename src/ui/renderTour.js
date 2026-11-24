/**
 * T3.12 最小可演示渲染（临时交付，可整体 revert）。
 *
 * 设计约束：
 * - 不引入第三方依赖，只用内联 SVG；
 * - 纯数据逻辑（parseTourScript / classifyDrop / legStyleOf）不触碰 DOM，
 *   可直接在 node 环境 import 并断言；
 * - DOM 逻辑（renderTour）单独成一个入口，需要宿主元素。
 *
 * 口径（与 docs/progress/frontend-handoff.md 一致）：
 * - network = 实线；fallback_straight = 虚线；unavailable = 灰色虚线；
 * - dropped 项 reason 含 coord_source=unmatched 一律显示「缺少坐标」，
 *   不得显示为「评分过低」。
 */

export const LEG_STYLE = {
  network: { stroke: '#2f9e63', dash: null, label: '真实步行路网' },
  fallback_straight: { stroke: '#d08b2c', dash: '8 6', label: '直线估算（未验证）' },
  unavailable: { stroke: '#8f8f8f', dash: '4 6', label: '路网不可用' },
  unknown: { stroke: '#8f8f8f', dash: '4 6', label: '状态未知' },
};

const DROP_BY_KIND = {
  score_below_threshold: { bucket: 'lowScore', label: '评分过低' },
  budget_exceeded: { bucket: 'overBudget', label: '超出预算' },
  closed: { bucket: 'closed', label: '已关闭' },
  not_selected: { bucket: 'notSelected', label: '未入选' },
  user_removed: { bucket: 'userRemoved', label: '用户移除' },
};

/** 站点间连线样式：按 routing_status 判定。 */
export function legStyleOf(status) {
  return LEG_STYLE[status] ?? LEG_STYLE.unknown;
}

/**
 * dropped 项归类。
 * 硬规则：reason 含 coord_source=unmatched 时，无论 kind 是什么都判「缺少坐标」。
 */
export function classifyDrop(item) {
  const reason = String(item?.reason ?? '');
  if (reason.includes('coord_source=unmatched')) {
    return { bucket: 'missingCoord', label: '缺少坐标' };
  }
  return DROP_BY_KIND[item?.kind] ?? { bucket: 'other', label: '其他原因' };
}

/** 纯数据：把一份 tour_script 转成渲染模型（不含任何 DOM 访问）。 */
export function parseTourScript(script) {
  if (!script || typeof script !== 'object') throw new Error('tour_script 为空或不是对象');
  const route = Array.isArray(script.route) ? script.route : [];
  const meta = script.meta ?? {};
  const warnings = Array.isArray(meta.validation?.warnings) ? [...meta.validation.warnings] : [];
  const rawDrops = Array.isArray(meta.dropped) ? meta.dropped : [];

  const stops = route.map((stop) => {
    const status = stop?.leg?.routing_status ?? null;
    return {
      order: stop?.order ?? null,
      id: stop?.id ?? null,
      name: stop?.name ?? '(未命名)',
      lat: Number(stop?.lat),
      lng: Number(stop?.lng),
      stayMin: stop?.stay_min ?? null,
      score: stop?.score ?? null,
      leg: status
        ? {
            status,
            style: legStyleOf(status),
            distanceM: stop.leg.distance_m ?? null,
            walkMin: stop.leg.walk_min ?? null,
          }
        : null,
    };
  });

  const drops = rawDrops.map((item) => {
    const cls = classifyDrop(item);
    return {
      id: item?.id ?? null,
      name: item?.name ?? '(未命名)',
      kind: item?.kind ?? null,
      reason: item?.reason ?? '',
      bucket: cls.bucket,
      label: cls.label,
    };
  });

  const dropSummary = drops.reduce((acc, item) => {
    acc[item.bucket] = (acc[item.bucket] ?? 0) + 1;
    return acc;
  }, {});

  return {
    schemaVersion: script.schema_version ?? null,
    cityId: meta.city?.id ?? null,
    budgetMin: meta.budget?.input_min ?? null,
    totalMin: meta.budget?.total_min ?? null,
    mode: meta.budget?.mode ?? null,
    schemaValid: meta.validation?.valid ?? null,
    warnings,
    stops,
    drops,
    dropSummary,
  };
}

function projectToInner(stops, innerW, innerH) {
  const finite = stops.filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng));
  if (!finite.length) return stops.map(() => ({ x: innerW / 2, y: innerH / 2 }));
  const lats = finite.map((s) => s.lat);
  const lngs = finite.map((s) => s.lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const spanLat = maxLat - minLat || 1e-6;
  const spanLng = maxLng - minLng || 1e-6;
  return stops.map((s) => {
    const ok = Number.isFinite(s.lat) && Number.isFinite(s.lng);
    if (!ok) return { x: innerW / 2, y: innerH / 2 };
    return {
      x: ((s.lng - minLng) / spanLng) * innerW,
      y: (1 - (s.lat - minLat) / spanLat) * innerH,
    };
  });
}

export const MIN_NODE_DIST = 30;
const MAX_ITER = 120;

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

/**
 * 节点最小间距，纯函数：就地推挤 + 钳制在内区 [0,width]×[0,height]。
 * 返回是否发生过位移。
 */
export function separatePoints(points, width, height, minDist = MIN_NODE_DIST) {
  let separated = false;
  for (let iter = 0; iter < MAX_ITER; iter += 1) {
    let moved = false;
    for (let i = 0; i < points.length; i += 1) {
      for (let j = i + 1; j < points.length; j += 1) {
        let dx = points[j].x - points[i].x;
        let dy = points[j].y - points[i].y;
        let dist = Math.hypot(dx, dy);
        if (dist >= minDist) continue;
        if (dist < 1e-6) { dx = 1; dy = 0; dist = 1; }
        const push = (minDist - dist) / 2;
        const ux = dx / dist;
        const uy = dy / dist;
        points[i].x -= ux * push;
        points[i].y -= uy * push;
        points[j].x += ux * push;
        points[j].y += uy * push;
        moved = true;
        separated = true;
      }
    }
    points.forEach((p) => {
      p.x = clamp(p.x, 0, width);
      p.y = clamp(p.y, 0, height);
    });
    if (!moved) break;
  }
  return separated;
}

const LABEL_CANDIDATES = [
  { dx: 0, dy: -17, anchor: 'middle' },
  { dx: 0, dy: 25, anchor: 'middle' },
  { dx: 14, dy: 5, anchor: 'start' },
  { dx: -14, dy: 5, anchor: 'end' },
  { dx: 13, dy: -10, anchor: 'start' },
  { dx: -13, dy: -10, anchor: 'end' },
  { dx: 13, dy: 18, anchor: 'start' },
  { dx: -13, dy: 18, anchor: 'end' },
];

/** 标签 8 向避让：按「出界 / 压节点 / 压已放标签」打分选位，无 DOM 依赖。 */
function placeLabels(points, stops, width, height) {
  const boxes = [];
  points.forEach((p, i) => {
    const name = String(stops[i]?.name ?? '');
    const w = Math.min(name.length * 12 + 6, 150);
    let best = null;
    let bestScore = Infinity;
    LABEL_CANDIDATES.forEach((c) => {
      const lx = p.x + c.dx;
      const ly = p.y + c.dy;
      const x0 = c.anchor === 'middle' ? lx - w / 2 : c.anchor === 'start' ? lx : lx - w;
      const box = { x0, x1: x0 + w, y0: ly - 12, y1: ly + 4 };
      let score = 0;
      if (box.x0 < 4 || box.x1 > width - 4) score += 120;
      if (box.y0 < 2 || box.y1 > height - 2) score += 120;
      points.forEach((q) => {
        const nx = clamp(q.x, box.x0, box.x1);
        const ny = clamp(q.y, box.y0, box.y1);
        const d = Math.hypot(q.x - nx, q.y - ny);
        if (d < 12) score += 40 + (12 - d) * 3;
      });
      boxes.forEach((b) => {
        const ix = Math.min(box.x1, b.x1) - Math.max(box.x0, b.x0);
        const iy = Math.min(box.y1, b.y1) - Math.max(box.y0, b.y0);
        if (ix > 0 && iy > 0) score += 200 + ix * iy * 0.1;
      });
      if (score < bestScore) { bestScore = score; best = { lx, ly, anchor: c.anchor, box }; }
    });
    boxes.push(best.box);
    p.label = best;
  });
}

/**
 * 纯布局入口（无 DOM、无浏览器）：route → 内区坐标 + 标签位置。
 * 坐标范围严格在 [0,canvasW]×[0,canvasH]。
 */
export function computeLayout(route, canvasW, canvasH, options = {}) {
  const minDist = options.minDist ?? MIN_NODE_DIST;
  const points = projectToInner(route, canvasW, canvasH).map((p) => ({ x: p.x, y: p.y }));
  const separated = separatePoints(points, canvasW, canvasH, minDist);
  placeLabels(points, route, canvasW, canvasH);
  return { points, separated, width: canvasW, height: canvasH };
}

function el(doc, tag, attrs = {}, text = null) {
  const node = doc.createElementNS('http://www.w3.org/2000/svg', tag);
  Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, String(v)));
  if (text !== null) node.textContent = text;
  return node;
}

/**
 * 渲染入口。host 必须是一个 HTMLElement。
 * 返回渲染模型，便于调用方断言（也便于测试只跑解析）。
 */
export function renderTour(model, host, options = {}) {
  if (!host) throw new Error('缺少渲染宿主元素');
  const doc = host.ownerDocument;
  const sample = options.sample ?? 'base';

  host.innerHTML = '';
  host.style.cssText = 'padding:16px 20px 24px;border-top:1px solid #2a2f36;background:#14181d;color:#dfe4ea;font:13px/1.6 system-ui,"Microsoft YaHei",sans-serif;';
  host.dataset.sample = sample;

  const title = doc.createElement('div');
  title.style.cssText = 'display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:10px;';
  title.innerHTML = `
    <b style="font-size:15px;">成都 · tour_script 渲染预览</b>
    <span style="opacity:.7;">样例：${sample}</span>
    <span style="opacity:.7;">预算 ${model.budgetMin ?? '—'} min / 选点估算 ${model.totalMin ?? '—'} min（按直线）</span>
    <span style="opacity:.7;">${model.stops.length} 站 · dropped ${model.drops.length}</span>
    <span style="padding:1px 8px;border:1px solid ${model.schemaValid ? '#2f9e63' : '#c04a4a'};border-radius:10px;font-size:11px;">
      ${model.schemaValid ? 'schema 通过' : 'schema 未通过'}
    </span>`;
  host.appendChild(title);

  const walkingInfo = doc.createElement('section');
  walkingInfo.id = 'walking-route-info';
  walkingInfo.setAttribute('aria-live', 'polite');
  walkingInfo.style.cssText = 'margin:0 0 12px;padding:10px 12px;border:1px solid #405767;border-radius:8px;font-size:12px;';
  host.appendChild(walkingInfo);

  if (model.warnings.length) {
    const box = doc.createElement('div');
    box.setAttribute('role', 'alert');
    box.dataset.role = 'warnings';
    box.style.cssText = 'margin:0 0 12px;padding:8px 12px;border-left:3px solid #d08b2c;background:rgba(208,139,44,.12);font-size:12px;';
    box.textContent = `⚠ 选点阶段：${model.warnings.join(' / ')}`;
    host.appendChild(box);
  }

  const width = 720;
  const diagramTitle = doc.createElement('p');
  diagramTitle.textContent = '以下为选点阶段的直线示意，实际步行查询结果见上方。';
  host.appendChild(diagramTitle);
  const height = 460;
  const pad = 56;
  const svg = el(doc, 'svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', role: 'img' });
  svg.style.cssText = 'display:block;width:100%;height:auto;background:#0f1216;border:1px solid #2a2f36;border-radius:8px;';
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  const layout = computeLayout(model.stops, innerW, innerH);
  const pos = layout.points.map((p) => ({
    x: p.x + pad,
    y: p.y + pad,
    label: { ...p.label, lx: p.label.lx + pad, ly: p.label.ly + pad },
  }));
  const separated = layout.separated;

  for (let i = 1; i < model.stops.length; i += 1) {
    const leg = model.stops[i].leg;
    const style = leg?.style ?? LEG_STYLE.unknown;
    svg.appendChild(
      el(doc, 'line', {
        x1: pos[i - 1].x.toFixed(1),
        y1: pos[i - 1].y.toFixed(1),
        x2: pos[i].x.toFixed(1),
        y2: pos[i].y.toFixed(1),
        stroke: style.stroke,
        'stroke-width': 3,
        'stroke-dasharray': style.dash ?? '',
        'data-status': leg?.status ?? 'unknown',
      }),
    );
  }

  model.stops.forEach((stop, i) => {
    const { x, y } = pos[i];
    svg.appendChild(el(doc, 'circle', { cx: x.toFixed(1), cy: y.toFixed(1), r: 9, fill: '#1b2028', stroke: '#7cc6ff', 'stroke-width': 2 }));
    svg.appendChild(el(doc, 'text', { x: x.toFixed(1), y: (y + 4).toFixed(1), fill: '#7cc6ff', 'font-size': 11, 'text-anchor': 'middle' }, String(stop.order ?? i + 1)));
    const lab = pos[i].label;
    svg.appendChild(el(doc, 'text', { x: lab.lx.toFixed(1), y: lab.ly.toFixed(1), fill: '#dfe4ea', 'font-size': 12, 'text-anchor': lab.anchor }, stop.name));
    if (stop.leg?.walkMin != null) {
      const mx = (x + pos[i - 1].x) / 2;
      const my = (y + pos[i - 1].y) / 2 - 6;
      svg.appendChild(el(doc, 'text', { x: mx.toFixed(1), y: my.toFixed(1), fill: stop.leg.style.stroke, 'font-size': 10, 'text-anchor': 'middle' }, `${stop.leg.walkMin} min`));
    }
  });
  host.appendChild(svg);

  const legend = doc.createElement('div');
  legend.style.cssText = 'display:flex;gap:16px;flex-wrap:wrap;margin:10px 0 14px;font-size:12px;opacity:.85;';
  legend.innerHTML = Object.entries(LEG_STYLE)
    .filter(([k]) => k !== 'unknown')
    .map(([k, v]) => `<span><svg width="34" height="8" style="vertical-align:middle;margin-right:6px;"><line x1="0" y1="4" x2="34" y2="4" stroke="${v.stroke}" stroke-width="3" ${v.dash ? `stroke-dasharray="${v.dash}"` : ''}/></svg>${k} · ${v.label}</span>`)
    .join('');
  host.appendChild(legend);

  const dropHead = doc.createElement('div');
  dropHead.dataset.role = 'drops';
  dropHead.style.cssText = 'font-size:12px;opacity:.9;margin-bottom:6px;';
  const summary = Object.entries(model.dropSummary)
    .map(([bucket, n]) => {
      const hit = model.drops.find((d) => d.bucket === bucket);
      return `${hit?.label ?? bucket} × ${n}`;
    })
    .join(' · ');
  dropHead.textContent = model.drops.length ? `未入选 ${model.drops.length} 项：${summary}` : '未入选 0 项';
  host.appendChild(dropHead);

  if (model.drops.length) {
    const ul = doc.createElement('ul');
    ul.style.cssText = 'margin:0;padding-left:18px;font-size:12px;opacity:.85;';
    model.drops.forEach((d) => {
      const li = doc.createElement('li');
      li.dataset.bucket = d.bucket;
      li.dataset.label = d.label;
      li.textContent = `${d.name} — ${d.label}`;
      ul.appendChild(li);
    });
    host.appendChild(ul);
  }

  const note = doc.createElement('div');
  note.style.cssText = 'margin-top:12px;font-size:11px;opacity:.55;';
  note.textContent = separated
    ? '路线图为示意，节点间距不按实际比例绘制。'
    : '路线图为示意，请结合地图和现场情况核实。';
  host.appendChild(note);

  return model;
}
