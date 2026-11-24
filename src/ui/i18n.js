/**
 * 界面语言：中文 / English。
 *
 * - 静态文案：HTML 上标 data-i18n / data-i18n-aria / data-i18n-placeholder，
 *   由 applyStatic() 统一替换；
 * - 运行时文案：渲染函数里用 L('中文', 'English') 就地取词；
 * - 切换语言会派发 yunjing:lang，需要重绘的模块自己监听。
 */

const STORAGE_KEY = 'yunjing.lang';
const SUPPORTED = ['zh', 'en'];

const DICT = {
  'brand.aria': ['云径 CityWalk · 成都篇 首页', 'Yunjing CityWalk · Chengdu'],
  'brand.sub': ['成都篇', 'Chengdu'],
  'hero.title': ['把一句话，<br />走成一条路线。', 'One sentence,<br />one walking route.'],
  'hero.lead': ['AI 读偏好、选景点、排顺序；预算与步行距离由规则复核。', 'AI reads your preferences, picks stops and orders them; budget and walking distance are checked by rules.'],
  'route.title': ['路线', 'Route'],
  'route.sampleTag': ['内置样例', 'Built-in sample'],
  'budget.title': ['时间预算', 'Time budget'],
  'composer.placeholder': ['说说你想怎么逛成都，例如：半天，想喝茶、拍照、少走路', 'Describe your Chengdu walk, e.g. half a day, tea and photos, less walking'],
  'composer.reset': ['重置', 'Reset'],
  'composer.hint': ['Enter 生成 · Shift + Enter 换行', 'Enter to plan · Shift + Enter for a new line'],
  'composer.plan': ['AI 规划路线', 'AI plan route'],
  'composer.attachLabel': ['试一试', 'Try'],
  'case.standard': ['半天 · 茶与拍照', 'Half day · tea & photos'],
  'case.humanities': ['历史人文', 'History & culture'],
  'case.lesswalk': ['少走路', 'Less walking'],
  'follow.tea': ['换成喝茶', 'Tea theme'],
  'follow.humanities': ['多看人文', 'More culture'],
  'follow.photo': ['加拍照', 'Add photos'],
  'map.aria': ['成都路线示意地图', 'Chengdu route map'],
  'map.place': ['成都 · 主城区', 'Chengdu · downtown'],
  'map.source': ['选点示意 · 直线距离', 'Schematic · straight-line distance'],
  'map.hint': ['拖动平移 · 滚轮缩放', 'Drag to pan · scroll to zoom'],
  'legend.network': ['真实路网', 'Real network'],
  'legend.straight': ['直线估算', 'Straight estimate'],
  'legend.selected': ['选中站点', 'Selected stop'],
  'detail.emptyTitle': ['先选一站', 'Pick a stop'],
  'detail.emptyText': ['路线生成后，点左侧站点查看解说、选点理由和来源。', 'Once a route is ready, select a stop to see narration, rationale and sources.'],
  'theme.toggle': ['切换主题', 'Toggle theme'],
  'settings.open': ['API 设置', 'API settings'],
  'panel.collapseLeft': ['收起路线栏', 'Collapse route panel'],
  'panel.expandLeft': ['展开路线栏', 'Expand route panel'],
  'panel.collapseRight': ['收起详情栏', 'Collapse detail panel'],
  'panel.expandRight': ['展开详情栏', 'Expand detail panel'],
  'panel.tabLeft': ['路线', 'Route'],
  'panel.tabRight': ['详情', 'Details'],
  'composer.collapse': ['收起输入框', 'Collapse input'],
  'composer.expand': ['展开输入', 'Open input'],
  'settings.title': ['API 设置', 'API settings'],
  'settings.close': ['关闭设置', 'Close settings'],
  'settings.note': [
    '地图 Key 只存本机浏览器；AI 与地点服务 Key 写入 .env.local（仅本机可写，不会回传页面）。',
    'The map key stays in this browser; AI and place-service keys are written to .env.local (local only, never sent back to the page).',
  ],
  'settings.group.map': ['地图', 'Map'],
  'settings.group.ai': ['AI', 'AI'],
  'settings.group.lang': ['语言', 'Language'],
  'settings.mapKey': ['高德 JS API Key', 'AMap JS API key'],
  'settings.mapKeyPh': ['粘贴 Web 端（JS API）Key', 'Paste the web (JS API) key'],
  'settings.mapKeyHint': [
    '留空则使用 .env.local 里的 VITE_AMAP_KEY；保存后自动刷新',
    'Leave empty to use VITE_AMAP_KEY from .env.local; the page refreshes after saving',
  ],
  'settings.webKey': ['高德 Web 服务 Key（可选）', 'AMap Web service key (optional)'],
  'settings.webKeyPh': ['地点图片 / 详情用', 'For place photos / details'],
  'settings.webKeyHint': ['服务端专用，不会出现在浏览器请求里', 'Server-side only; never appears in browser requests'],
  'settings.aiKey': ['DeepSeek API Key', 'DeepSeek API key'],
  'settings.aiKeyPh': ['粘贴 sk- 开头的 Key', 'Paste the sk- key'],
  'settings.aiKeyHint': ['写入 .env.local 后立即生效，页面不会保存明文', 'Takes effect immediately after writing .env.local; the page keeps no plaintext'],
  'settings.save': ['保存', 'Save'],
  'settings.langZh': ['中文', '中文'],
  'settings.langEn': ['English', 'English'],
  'status.aiReady': ['AI 已配置', 'AI configured'],
  'status.aiMissing': ['AI 未配置（本地兜底）', 'AI not configured (local fallback)'],
  'status.amapReady': ['地点服务已配置', 'Place service configured'],
  'status.amapMissing': ['地点服务未配置', 'Place service not configured'],
  'status.saved': ['已保存', 'Saved'],
  'status.mapSaved': ['地图 Key 已保存，正在刷新…', 'Map key saved, refreshing…'],
  'status.saveFailed': ['保存失败', 'Save failed'],
  'status.serviceDown': ['本地服务不可达：AI 会走本地兜底', 'Local service unreachable: AI falls back to local rules'],
  'status.serviceDownShort': ['本地服务不可达', 'Local service unreachable'],
};

const listeners = new Set();

function read() {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return SUPPORTED.includes(value) ? value : 'zh';
  } catch {
    return 'zh';
  }
}

let current = read();

export function getLang() {
  return current;
}

/** 就地取词：L('中文', 'English')，渲染时调用，切换后重绘即生效。 */
export function L(zh, en) {
  return current === 'en' ? en : zh;
}

export function t(key) {
  const entry = DICT[key];
  if (!entry) return key;
  return current === 'en' ? entry[1] : entry[0];
}

/** 把带 data-i18n* 属性的静态节点刷成当前语言。 */
export function applyStatic(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  root.querySelectorAll('[data-i18n-html]').forEach((el) => {
    el.innerHTML = t(el.dataset.i18nHtml);
  });
  root.querySelectorAll('[data-i18n-aria]').forEach((el) => {
    el.setAttribute('aria-label', t(el.dataset.i18nAria));
  });
  root.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.setAttribute('title', t(el.dataset.i18nTitle));
  });
  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.setAttribute('placeholder', t(el.dataset.i18nPlaceholder));
  });
  const rootEl = typeof document !== 'undefined' ? document.documentElement : null;
  if (rootEl) rootEl.lang = current === 'en' ? 'en' : 'zh-CN';
}

export function setLang(next) {
  if (!SUPPORTED.includes(next) || next === current) return;
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* 隐私模式忽略 */
  }
  applyStatic();
  listeners.forEach((fn) => fn(next));
  window.dispatchEvent(new CustomEvent('yunjing:lang', { detail: { lang: next } }));
}

export function onLangChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function initI18n() {
  applyStatic();
  window.addEventListener('yunjing:lang', () => applyStatic());
}

// 模块脚本是 defer 的，执行时 DOM 已就绪；Node 测试环境没有 DOM，跳过
if (typeof document !== 'undefined' && typeof document.querySelectorAll === 'function') {
  initI18n();
}
