/** 路线视图：左侧时间线 + 右侧站点详情 + AI 理解摘要。纯 DOM，不依赖框架。 */
import { parseTourScript } from './renderTour.js';
import { getPlaceInfo } from './agentClient.js';
import { L } from './i18n.js';

const placeCache = new Map();
let placeSeq = 0;

const MIN = () => L('分钟', 'min');
const STOPS = () => L('站', 'stops');

const paceLabel = (code) => ({
  relaxed: L('悠闲', 'Relaxed'),
  balanced: L('均衡', 'Balanced'),
  packed: L('紧凑', 'Packed'),
}[code] ?? code ?? L('均衡', 'Balanced'));

const constraintLabel = (code) => ({
  low_walk: L('少走路', 'Less walking'),
  evening: L('夜景', 'Evening'),
  family: L('亲子', 'Family'),
  quiet: L('安静', 'Quiet'),
  rain: L('雨天', 'Rainy'),
  no_hike: L('不爬山', 'No hiking'),
}[code] || code);

const state = { script: null, model: null, plan: null, active: 0 };

const $ = (selector, root = document) => root.querySelector(selector);

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = String(text);
  return element;
}

function clear(element) {
  if (element) element.replaceChildren();
}

function renderSummary(model, plan) {
  const host = $('#ai-summary');
  if (!host) return;
  clear(host);
  const intent = plan?.intent ?? null;
  const chips = [];
  if (intent) {
    chips.push([L('时长', 'Duration'), `${intent.budget_min ?? model.budgetMin ?? '—'} ${MIN()}`]);
    if (Array.isArray(intent.interests) && intent.interests.length) chips.push([L('兴趣', 'Interests'), intent.interests.join(' / ')]);
    chips.push([L('节奏', 'Pace'), paceLabel(intent.pace)]);
    const constraints = (intent.constraints || []).map((code) => constraintLabel(code));
    if (constraints.length) chips.push([L('约束', 'Constraints'), constraints.join(' / ')]);
  } else {
    chips.push([L('样例', 'Sample'), L('内置路线', 'Built-in route')]);
    chips.push([L('预算', 'Budget'), `${model.budgetMin ?? '—'} ${MIN()}`]);
  }
  chips.push([L('站点', 'Stops'), `${model.stops.length} ${STOPS()}`]);
  for (const [label, value] of chips) {
    const chip = node('span', 'ai-chip');
    chip.append(node('i', null, label), node('b', null, value));
    host.appendChild(chip);
  }
  host.hidden = false;

  const reason = $('#route-reason');
  if (reason) {
    reason.textContent = plan?.route_reason
      || (plan?.source === 'local'
        ? L('AI 暂不可用，这版由本地规则选出。', 'AI is unavailable here, so local rules picked this route.')
        : L('这是内置样例，点“AI 规划路线”生成你的版本。', 'Built-in sample. Press “AI plan route” to generate your own.'));
  }
}

function legText(stop) {
  const leg = stop?.leg;
  if (!leg) return L('首站', 'First stop');
  const walk = Number.isFinite(Number(leg.walkMin))
    ? L(`${Math.round(Number(leg.walkMin))} 分钟步行`, `${Math.round(Number(leg.walkMin))} min walk`)
    : '';
  const meters = Number(leg.distanceM);
  let distance = '';
  if (Number.isFinite(meters)) {
    distance = meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
  }
  return [walk, distance].filter(Boolean).join(' · ') || L('步行段', 'Walk');
}

function renderTimeline(model, plan) {
  const host = $('#route-timeline');
  if (!host) return;
  clear(host);
  if (!model.stops.length) {
    host.appendChild(node('li', 'timeline-empty', L('还没有路线。写一句偏好，让 AI 先排一版。', 'No route yet. Describe your preferences and let AI draft one.')));
    return;
  }
  model.stops.forEach((stop, index) => {
    const item = node('li', 'timeline-item');
    item.dataset.index = String(index);
    item.tabIndex = 0;
    if (index === state.active) item.classList.add('is-active');

    const no = node('b', 'timeline-no', String(index + 1).padStart(2, '0'));
    const body = node('div', 'timeline-body');
    body.append(node('strong', 'timeline-name', stop.name));
    const stay = Number.isFinite(Number(stop.stayMin))
      ? L(`停留 ${Math.round(Number(stop.stayMin))} 分钟`, `Stay ${Math.round(Number(stop.stayMin))} min`)
      : L('停留待定', 'Stay TBD');
    body.append(node('span', 'timeline-meta', `${stay} · ${legText(stop)}`));
    const why = plan?.stops?.find((entry) => entry.poi_id === stop.id)?.why;
    if (why) body.append(node('em', 'timeline-why', why));

    item.append(no, body);
    item.addEventListener('click', () => selectStop(index));
    item.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectStop(index);
      }
    });
    host.appendChild(item);
  });
}

function renderPlace(host, info, stop) {
  clear(host);
  if (!info?.ok) {
    host.appendChild(node('p', 'media-empty', info?.message || L('暂无图源，仍可查看文字介绍。', 'No photos available; text details still apply.')));
    return;
  }
  const photos = (Array.isArray(info.photos) ? info.photos : []).filter((photo) => photo?.url);
  if (photos.length) {
    const figure = node('figure', 'place-photo');
    const img = node('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.src = photos[0].url;
    img.alt = L(`${info.name || stop.name} 实景图`, `${info.name || stop.name} photo`);
    img.addEventListener('error', () => figure.classList.add('is-broken'));
    figure.appendChild(img);
    const caption = node('figcaption');
    caption.append(node('span', null, L('图片：AMap 实时抓取', 'Photo: live from AMap')));
    figure.appendChild(caption);
    host.appendChild(figure);

    if (photos.length > 1) {
      const strip = node('div', 'photo-strip');
      for (const photo of photos.slice(1, 4)) {
        const thumb = node('img');
        thumb.loading = 'lazy';
        thumb.src = photo.url;
        thumb.alt = L(`${info.name || stop.name} 图片`, `${info.name || stop.name} photo`);
        thumb.addEventListener('error', () => thumb.remove());
        strip.appendChild(thumb);
      }
      host.appendChild(strip);
    }
  }

  const facts = node('dl', 'place-facts');
  const rows = [
    [L('地址', 'Address'), info.address],
    [L('开放', 'Hours'), info.opening_hours],
    [L('评分', 'Rating'), info.rating ? String(info.rating) : null],
    [L('电话', 'Phone'), info.tel],
  ].filter(([, value]) => value);
  for (const [label, value] of rows) {
    facts.append(node('dt', null, label), node('dd', null, value));
  }
  if (rows.length) host.appendChild(facts);

  const intro = String(info.intro || '').trim();
  const commentary = String(stop.commentary || '').trim();
  if (intro && intro !== commentary) {
    const section = node('section', 'place-intro');
    section.appendChild(node('h3', null, L('地点介绍', 'About this place')));
    section.appendChild(node('p', null, intro));
    host.appendChild(section);
  }
}

async function loadPlace(stop, index, host) {
  const seq = ++placeSeq;
  let info = placeCache.get(stop.id);
  if (!info) {
    info = await getPlaceInfo(stop.id);
    if (info?.ok) placeCache.set(stop.id, info);
  }
  if (seq !== placeSeq || state.active !== index || !host.isConnected) return;
  renderPlace(host, info, stop);
}

function renderDetail() {
  const host = $('#stop-detail');
  if (!host) return;
  clear(host);
  const { script, plan } = state;
  const stop = script?.route?.[state.active];
  if (!stop) {
    placeSeq += 1;
    host.append(
      node('p', 'detail-empty-title', L('先选一站', 'Pick a stop')),
      node('p', 'detail-empty-text', L('路线生成后，点左侧站点查看解说、选点理由和来源。', 'Once a route is ready, select a stop to see narration, rationale and sources.')),
    );
    return;
  }

  const head = node('div', 'detail-head');
  head.append(node('span', 'detail-no', `STOP ${String(state.active + 1).padStart(2, '0')}`));
  head.append(node('span', 'detail-source', plan?.source === 'llm'
    ? L('AI 规划', 'AI planned')
    : plan?.source === 'local' ? L('本地兜底', 'Local fallback') : L('样例', 'Sample')));
  host.appendChild(head);

  host.appendChild(node('h2', 'detail-title', stop.name || L('未命名站点', 'Unnamed stop')));
  const meta = node('p', 'detail-meta');
  const stay = Number.isFinite(Number(stop.stay_min))
    ? L(`停留约 ${Math.round(Number(stop.stay_min))} 分钟`, `Stay ~${Math.round(Number(stop.stay_min))} min`)
    : L('停留待定', 'Stay TBD');
  meta.textContent = [stay, legText(script.route[state.active])].filter(Boolean).join(' · ');
  host.appendChild(meta);

  const media = node('section', 'detail-media');
  media.id = 'detail-media';
  media.appendChild(node('p', 'media-empty', L('正在实时获取地点图片…', 'Loading live photos…')));
  host.appendChild(media);
  loadPlace(stop, state.active, media);

  const why = plan?.stops?.find((entry) => entry.poi_id === stop.id)?.why || stop.reason;
  if (why) {
    const section = node('section', 'detail-section');
    section.appendChild(node('h3', null, L('为什么是它', 'Why this stop')));
    section.appendChild(node('p', 'detail-why', why));
    host.appendChild(section);
  }

  const aiIntro = String(plan?.stops?.find((entry) => entry.poi_id === stop.id)?.intro || '').trim();
  if (aiIntro) {
    const section = node('section', 'detail-section detail-ai-intro');
    section.appendChild(node('h3', null, L('AI 一句话介绍', 'AI in one line')));
    section.appendChild(node('p', 'detail-why', aiIntro));
    section.appendChild(node('p', 'detail-ai-note', L(
      'AI 依据该地点的资料摘要生成，未逐条核验；以现场与官方信息为准。',
      'Generated by AI from this place’s summary and not verified item by item; trust on-site and official info.',
    )));
    host.appendChild(section);
  }

  const commentary = String(stop.commentary || '').trim();
  if (commentary) {
    const section = node('section', 'detail-section');
    section.appendChild(node('h3', null, L('现场解说', 'On-site narration')));
    section.appendChild(node('p', 'detail-commentary', commentary));
    host.appendChild(section);
  }

  const source = node('section', 'detail-section detail-source-box');
  source.appendChild(node('h3', null, L('资料状态', 'Source status')));
  source.appendChild(node('p', null, plan?.source === 'llm'
    ? L(
      'AI 依据候选 POI 的名称、类别、标签与坐标选点；解说文本来自项目资料库，未核验处标“待核验”。',
      'AI selected stops from candidate POIs by name, category, tags and coordinates; narration text comes from the project knowledge base, and unverified parts are marked as pending.',
    )
    : L(
      '内置样例/本地规则生成，未调用 AI；解说文本来自项目资料库。',
      'Built-in sample / local rules, no AI call; narration text comes from the project knowledge base.',
    )));
  host.appendChild(source);
}

function selectStop(index) {
  state.active = Math.max(0, Math.min(Number(index) || 0, (state.model?.stops.length ?? 1) - 1));
  document.querySelectorAll('.timeline-item').forEach((item) => {
    item.classList.toggle('is-active', Number(item.dataset.index) === state.active);
  });
  renderDetail();
}

function renderBudget(script, model) {
  const budget = script?.meta?.budget;
  const input = Number(budget?.input_min ?? model.budgetMin ?? 0);
  const breakdown = budget?.breakdown ?? {};
  const walk = Number(breakdown.walk_min ?? 0);
  const stay = Number(breakdown.stay_min ?? 0);
  const total = Number(budget?.total_min ?? model.totalMin ?? walk + stay);
  const buffer = Math.max(0, input - total);
  const scale = Math.max(input, total, 1);

  const boxes = [
    ['#budget-walk', '#budget-walk-text', walk, L(`${Math.round(walk)} min 步行`, `${Math.round(walk)} min walking`)],
    ['#budget-stay', '#budget-stay-text', stay, L(`${Math.round(stay)} min 停留`, `${Math.round(stay)} min staying`)],
    ['#budget-buffer', '#budget-buffer-text', buffer, L(`${Math.round(buffer)} min 余量`, `${Math.round(buffer)} min buffer`)],
  ];
  for (const [barSelector, textSelector, value, text] of boxes) {
    const bar = document.querySelector(barSelector);
    if (bar) bar.style.width = `${Math.min(100, (value / scale) * 100).toFixed(1)}%`;
    const label = document.querySelector(textSelector);
    if (label) label.textContent = text;
  }
  const totalLabel = document.querySelector('#budget-total');
  if (totalLabel) {
    totalLabel.textContent = `${Math.round(total)} / ${input || '—'} min`;
    totalLabel.dataset.over = String(total > input && input > 0);
  }
}

export function renderTourView({ script, plan = null, sample = 'base' } = {}) {
  const model = parseTourScript(script);
  state.script = script;
  state.model = model;
  state.plan = plan;
  state.active = 0;
  renderSummary(model, plan);
  renderTimeline(model, plan);
  renderBudget(script, model);
  renderDetail();
  const host = document.querySelector('#route-view');
  if (host) host.dataset.sample = sample;
  return model;
}

export function focusStop(index) {
  selectStop(index);
}
