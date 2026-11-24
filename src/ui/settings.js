/**
 * API 设置入口：在界面里填「高德地图 Key」和「DeepSeek Key」。
 *
 * 分工（重要）：
 * - 地图 JS Key 只影响浏览器，存 localStorage，保存后刷新生效；
 * - AI / 地点服务 Key 属于服务端，POST /api/agent/config 写入 .env.local，
 *   该接口只接受本机回环地址的请求，Key 永不回传浏览器。
 */

const MAP_KEY_STORAGE = 'yunjing.amapKey';

import { t, getLang, setLang, applyStatic } from './i18n.js';

const $ = (selector, root = document) => root.querySelector(selector);

let dialog = null;
let scrim = null;
let lastFocused = null;

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = String(text);
  return element;
}

function readMapKey() {
  try {
    return localStorage.getItem(MAP_KEY_STORAGE) || '';
  } catch {
    return '';
  }
}

function writeMapKey(value) {
  try {
    localStorage.setItem(MAP_KEY_STORAGE, value);
  } catch {
    /* 隐私模式下忽略，环境变量仍然兜底 */
  }
}

function setStatus(text, kind = 'info') {
  const box = $('#settings-status');
  if (!box) return;
  box.textContent = text;
  box.dataset.kind = kind;
}

async function refreshHealth() {
  try {
    const response = await fetch('/api/agent/health');
    const data = await response.json();
    const ai = data.configured
      ? `${t('status.aiReady')} · ${data.model || 'deepseek'}`
      : t('status.aiMissing');
    const map = data.amap_configured ? t('status.amapReady') : t('status.amapMissing');
    setStatus(`${ai} · ${map}`, data.configured ? 'ok' : 'info');
  } catch {
    setStatus(t('status.serviceDown'), 'warn');
  }
}

const reduceMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

const centerOf = (rect) => ({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });

/** 从触发按钮的位置/尺寸展开到居中面板（FLIP），背景同时渐进虚化。 */
function animateIn(originRect) {
  if (!originRect || reduceMotion()) return;
  const to = dialog.getBoundingClientRect();
  if (!to.width || !to.height) return;
  // transform-origin 默认在中心，所以位移要按「中心到中心」算，
  // 否则缩放绕中心、位移按左上角补，面板会整体偏到右下方。
  const from = centerOf(originRect);
  const target = centerOf(to);
  const sx = originRect.width / to.width;
  const sy = originRect.height / to.height;
  const dx = from.x - target.x;
  const dy = from.y - target.y;

  dialog.animate(
    [
      { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, opacity: 0.35, borderRadius: '20px' },
      { transform: 'translate(0, 0) scale(1, 1)', opacity: 1, borderRadius: '18px' },
    ],
    { duration: 520, easing: 'cubic-bezier(0.35, 0.05, 0.25, 1)' },
  );
}

/** 收回按钮：反向播放，结束后再隐藏，避免直接闪掉。 */
function animateOut(done) {
  const trigger = $('#settings-open');
  if (!trigger || reduceMotion()) {
    done();
    return;
  }
  const from = dialog.getBoundingClientRect();
  const to = trigger.getBoundingClientRect();
  if (!from.width || !to.width) {
    done();
    return;
  }
  const origin = centerOf(from);
  const target = centerOf(to);
  const sx = to.width / from.width;
  const sy = to.height / from.height;
  const dx = target.x - origin.x;
  const dy = target.y - origin.y;

  const box = dialog.animate(
    [
      { transform: 'translate(0, 0) scale(1, 1)', opacity: 1 },
      { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, opacity: 0, borderRadius: '20px' },
    ],
    { duration: 300, easing: 'cubic-bezier(0.4, 0, 0.7, 1)', fill: 'forwards' },
  );
  box.finished.then(() => {
    box.cancel();
    done();
  }).catch(done);
}

function open() {
  if (!dialog) return;
  lastFocused = document.activeElement;
  const trigger = $('#settings-open');
  const originRect = trigger ? trigger.getBoundingClientRect() : null;

  const stored = readMapKey();
  $('#set-map-js').value = stored;
  $('#set-ai').value = '';
  $('#set-map-web').value = '';

  scrim.hidden = false;
  dialog.hidden = false;
  trigger?.setAttribute('aria-expanded', 'true');
  // 强制一次布局，FLIP 才能量到最终尺寸；遮罩同时进入虚化态
  void dialog.offsetWidth;
  scrim.classList.add('is-open');
  animateIn(originRect);
  $('#set-map-js')?.focus({ preventScroll: true });
  refreshHealth();
}

function close() {
  if (!dialog || dialog.hidden) return;
  scrim.classList.remove('is-open');
  animateOut(() => {
    dialog.hidden = true;
    scrim.hidden = true;
    $('#settings-open')?.setAttribute('aria-expanded', 'false');
    if (lastFocused instanceof HTMLElement) lastFocused.focus({ preventScroll: true });
  });
}

async function save() {
  const mapKey = $('#set-map-js').value.trim();
  const mapWebKey = $('#set-map-web').value.trim();
  const aiKey = $('#set-ai').value.trim();
  const mapChanged = mapKey !== readMapKey();

  if (mapChanged) writeMapKey(mapKey);

  const serverPayload = {};
  if (aiKey) serverPayload.DEEPSEEK_API_KEY = aiKey;
  if (mapWebKey) serverPayload.AMAP_WEB_KEY = mapWebKey;

  let serverOk = true;
  let serverMessage = '';
  if (Object.keys(serverPayload).length) {
    try {
      const response = await fetch('/api/agent/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(serverPayload),
      });
      const data = await response.json();
      serverOk = Boolean(data?.ok);
      serverMessage = data?.message || '';
    } catch {
      serverOk = false;
      serverMessage = t('status.serviceDownShort');
    }
  }

  if (mapChanged) {
    setStatus(t('status.mapSaved'), 'info');
    setTimeout(() => location.reload(), 700);
    return;
  }
  if (!serverOk) {
    setStatus(`${t('status.saveFailed')}: ${serverMessage || t('status.serviceDownShort')}`, 'warn');
    return;
  }
  setStatus(t('status.saved'), 'ok');
  refreshHealth();
}

function field(labelKey, inputId, placeholderKey, hintKey) {
  const wrap = node('label', 'settings-field');
  const label = node('span', 'settings-label');
  label.dataset.i18n = labelKey;
  const input = node('input', 'settings-input');
  input.id = inputId;
  input.type = 'password';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.dataset.i18nPlaceholder = placeholderKey;
  wrap.append(label, input);
  if (hintKey) {
    const hint = node('span', 'settings-hint');
    hint.dataset.i18n = hintKey;
    wrap.append(hint);
  }
  return wrap;
}

function build() {
  scrim = node('div', 'settings-scrim');
  scrim.hidden = true;
  scrim.addEventListener('click', close);

  dialog = node('section', 'settings-pop');
  dialog.hidden = true;
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'settings-title');

  const head = node('header', 'settings-head');
  const title = node('h2', 'settings-title');
  title.id = 'settings-title';
  title.dataset.i18n = 'settings.title';
  const closeBtn = node('button', 'icon-btn settings-close');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'close');
  closeBtn.dataset.i18nAria = 'settings.close';
  closeBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>';
  closeBtn.addEventListener('click', close);
  head.append(title, closeBtn);

  const note = node('p', 'settings-note');
  note.dataset.i18n = 'settings.note';

  // 语言切换
  const langGroup = node('div', 'settings-group');
  const langTitle = node('h3', 'settings-group-title');
  langTitle.dataset.i18n = 'settings.group.lang';
  const langRow = node('div', 'settings-lang');
  const langButtons = ['zh', 'en'].map((code) => {
    const btn = node('button', 'settings-lang-btn');
    btn.type = 'button';
    btn.dataset.lang = code;
    btn.textContent = code === 'zh' ? '中文' : 'English';
    btn.addEventListener('click', () => {
      setLang(code);
      syncLangButtons(langButtons);
      applyStatic(dialog);
    });
    return btn;
  });
  langRow.append(...langButtons);
  syncLangButtons(langButtons);
  langGroup.append(langTitle, langRow);

  const mapGroup = node('div', 'settings-group');
  const mapTitle = node('h3', 'settings-group-title');
  mapTitle.dataset.i18n = 'settings.group.map';
  mapGroup.append(mapTitle);
  mapGroup.append(field('settings.mapKey', 'set-map-js', 'settings.mapKeyPh', 'settings.mapKeyHint'));
  mapGroup.append(field('settings.webKey', 'set-map-web', 'settings.webKeyPh', 'settings.webKeyHint'));

  const aiGroup = node('div', 'settings-group');
  const aiTitle = node('h3', 'settings-group-title');
  aiTitle.dataset.i18n = 'settings.group.ai';
  aiGroup.append(aiTitle);
  aiGroup.append(field('settings.aiKey', 'set-ai', 'settings.aiKeyPh', 'settings.aiKeyHint'));

  const actions = node('div', 'settings-actions');
  const status = node('span', 'settings-status');
  status.id = 'settings-status';
  const saveBtn = node('button', 'settings-save', '');
  saveBtn.type = 'button';
  saveBtn.dataset.i18n = 'settings.save';
  saveBtn.addEventListener('click', save);
  actions.append(status, saveBtn);

  dialog.append(head, note, langGroup, mapGroup, aiGroup, actions);
  document.body.append(scrim, dialog);
  applyStatic(dialog);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !dialog.hidden) close();
  });
}

function syncLangButtons(buttons) {
  buttons.forEach((btn) => btn.classList.toggle('is-active', btn.dataset.lang === getLang()));
}

export function initSettings() {
  if (dialog) return;
  build();
  const trigger = $('#settings-open');
  trigger?.addEventListener('click', () => (dialog.hidden ? open() : close()));
}

// 模块脚本是 defer 的，执行时 DOM 已就绪
initSettings();
