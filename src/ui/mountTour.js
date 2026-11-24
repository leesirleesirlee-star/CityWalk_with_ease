/**
 * 路线工作台入口：输入 → AI 规划 → 渲染路线；AI 不可用时走本地确定性兜底。
 * 页面只有一个 App，不再挂载 archive/legacy 那一套。
 */
import { initMapStage, renderRouteOnMap } from './mapStage.js';
import { initAmap, renderAmapRoute } from './amapStage.js';
import { renderTourView, focusStop } from './tourView.js';
import { runMasterPipeline, createTourSession, followUpTour } from '../agent/citywalk/masterPipeline.js';
import { requestAiPlan, getAgentHealth } from './agentClient.js';
import { L, getLang, onLangChange } from './i18n.js';
import base from '../../data/cities/chengdu/tour_script.chengdu.json';
import long from '../../data/cities/chengdu/tour_script.chengdu-long.json';
import degraded from '../../data/cities/chengdu/tour_script.chengdu-degraded.json';

const SAMPLES = { base, long, degraded };
const sampleKey = new URLSearchParams(location.search).get('demo') || 'long';

const promptInput = document.getElementById('tour-prompt');
const generateBtn = document.getElementById('tour-generate');
const quickButtons = [...document.querySelectorAll('[data-tour-case]')];
const followReset = document.getElementById('tour-follow-reset');
const followButtons = [...document.querySelectorAll('[data-tour-follow]')];
const statusBox = document.getElementById('tour-status');
const aiStatus = document.getElementById('ai-status');
const aiStatusText = document.getElementById('ai-status-text');
const statusLine = document.getElementById('status-line');

/** 三个快捷场景：文案是用户口吻，不写“推荐”。 */
const QUICK_CASES = {
  standard: {
    zh: '成都半天，想喝茶、拍照、少走路，预算3小时',
    en: 'Half a day in Chengdu: tea, photos, and less walking, about 3 hours',
  },
  humanities: {
    zh: '成都4小时，多看历史人文景点',
    en: '4 hours in Chengdu, focus on history and culture',
  },
  lesswalk: {
    zh: '成都3小时，尽量少走路，休闲为主',
    en: '3 hours in Chengdu, minimal walking, relaxed pace',
  },
};

const caseText = (key) => {
  const entry = QUICK_CASES[key];
  if (!entry) return '';
  return getLang() === 'en' ? entry.en : entry.zh;
};

/** 带显式时长的句子按“新需求”处理，否则会被当成追问。 */
const NEW_PLAN_PATTERN =
  /(\d+(\.\d+)?\s*(小时|分钟))|([一二三四五六七八九十两]\s*个?\s*(小时|分钟))|半\s*个?\s*小时|半天|半日|一上午|一下午|一整天|一天|全天|一日游|大半天/;

/** 以“成都…”开头且带出行意图的句子，即使没有时长也按新需求处理。 */
const NEW_REQUEST_PATTERN = /^\s*成都.*(想|要|看|逛|吃|去|玩|安排)/;

let busy = false;
let session = null;
let hasAi = false;
let lastPaint = null;

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

function setStatus(kind, message) {
  if (!statusBox) return;
  if (!message) {
    statusBox.hidden = true;
    statusBox.textContent = '';
    statusBox.removeAttribute('data-kind');
    return;
  }
  statusBox.hidden = false;
  statusBox.dataset.kind = kind || 'notice';
  statusBox.textContent = message;
}

function setAiStatus(state, text) {
  if (aiStatus) aiStatus.dataset.state = state;
  if (aiStatusText) aiStatusText.textContent = text;
}

function showError(message) {
  setStatus('error', message);
  setAiStatus('error', 'AI 调用失败');
  if (statusLine) statusLine.textContent = L('生成失败', 'Planning failed');
}

function showWarnings(warnings) {
  const list = (warnings || []).filter(Boolean);
  if (!list.length) return;
  setStatus('warn', L(`提示：${list.slice(0, 3).join('；')}`, `Notice: ${list.slice(0, 3).join('; ')}`));
}

function samplePlan(sample) {
  return { source: 'sample', sample, intent: null, stops: [], route_reason: L('内置样例', 'Built-in sample') };
}

function paint(script, sample, plan = null) {
  lastPaint = { script, sample, plan };
  renderTourView({ script, plan, sample });
  renderRouteOnMap(script);
  renderAmapRoute(script);
  if (statusLine) {
    const count = Array.isArray(script?.route) ? script.route.length : 0;
    statusLine.textContent = `${plan?.source === 'llm' ? 'AI 规划' : plan?.source === 'local' ? '本地兜底' : '示例'} · ${count} 站`;
  }
}

/** 按“是否已有会话”切换按钮文案与禁用状态。 */
function syncActionState() {
  const hasSession = Boolean(session);
  const generateLabel = document.getElementById('tour-generate-label');
  if (generateBtn) {
    const label = busy
      ? (hasSession ? L('调整中…', 'Adjusting…') : L('AI 规划中…', 'Planning…'))
      : hasSession ? L('调整路线', 'Adjust route') : L('AI 规划路线', 'AI plan route');
    generateBtn.disabled = busy;
    generateBtn.setAttribute('aria-busy', String(busy));
    generateBtn.setAttribute('aria-label', label);
    if (generateLabel) generateLabel.textContent = label;
  }
  if (promptInput) {
    promptInput.placeholder = hasSession
      ? L('在当前路线上调整，如「放慢一点」「再加一个历史点」', 'Adjust the current route, e.g. “slow it down”, “add one more historic stop”')
      : L('例如：成都半天，想喝茶、拍照、少走路', 'e.g. half a day in Chengdu, tea, photos, less walking');
  }
  if (followReset) followReset.disabled = busy || !hasSession;
  quickButtons.forEach((button) => { button.disabled = busy; });
  followButtons.forEach((button) => { button.disabled = busy || !hasSession; });
}

function setBusy(value) {
  busy = value;
  syncActionState();
}

/** 全新生成：先请 AI；失败再走本地规则。 */
async function runGenerate(text, note) {
  setStatus('loading', L('AI 正在读偏好、挑景点、排顺序…', 'AI is reading preferences, picking stops and ordering them…'));
  setAiStatus('loading', 'AI 正在规划');

  const ai = await requestAiPlan(text);
  if (ai?.ok && ai.script) {
    session = createTourSession({ ok: true, script: ai.script, intent: ai.intent }, text);
    paint(ai.script, 'ai', {
      source: 'llm',
      intent: ai.intent,
      stops: ai.stops,
      route_reason: ai.route_reason,
      model: ai.model,
      elapsed_ms: ai.elapsed_ms,
    });
    setStatus(null);
    setAiStatus('ready', `AI · ${ai.model || 'deepseek'} · ${((ai.elapsed_ms || 0) / 1000).toFixed(1)}s`);
    showWarnings([...(ai.warnings || [])]);
    return true;
  }

  const reason = ai?.message || ai?.code || 'AI 未返回结果';
  setAiStatus('local', hasAi ? 'AI 失败 · 本地兜底' : '未配置 Key · 本地规划');
  const result = runMasterPipeline(text);
  if (!result.ok || !result.script) {
    const message = result.error?.message || result.validation?.issues?.[0] || '未产出可用路线';
    showError(`生成失败：${message}`);
    return false;
  }
  session = createTourSession(result, text);
  paint(result.script, 'local', {
    source: 'local',
    intent: result.intent,
    stops: [],
    route_reason: `本地规则选点（${reason}）`,
  });
  showWarnings([note, ...(result.warnings || [])]);
  setStatus('notice', L(
    `AI 暂不可用：${reason}。这版由本地规则生成，路线仍可用。`,
    `AI unavailable: ${reason}. This version comes from local rules and is still usable.`,
  ));
  return true;
}

function resetToSample() {
  if (busy) return;
  session = null;
  if (promptInput) promptInput.value = '';
  paint(SAMPLES[sampleKey] ?? SAMPLES.long, sampleKey, samplePlan(sampleKey));
  resetMapView();
  setStatus(null);
  setAiStatus(hasAi ? 'ready' : 'local', hasAi ? 'AI 待命' : '未配置 AI Key · 本地规划');
  syncActionState();
}

/** 单输入框：无会话/显式时长 → 新规划；已有会话 → 本地追问。 */
async function submit(text, options = {}) {
  if (busy) return;
  const value = String(text ?? '').trim();
  if (!value) {
    setStatus('warn', L('先写一句你的成都偏好，例如「半天，喝茶拍照，少走路」。', 'Describe your Chengdu preferences first, e.g. “half a day, tea and photos, less walking”.'));
    return;
  }
  setBusy(true);
  try {
    await nextFrame();
    if (!session || options.fresh || NEW_PLAN_PATTERN.test(value) || NEW_REQUEST_PATTERN.test(value)) {
      await runGenerate(value);
      return;
    }
    const result = followUpTour(session, value);
    if (result.ok && result.script) {
      paint(result.script, 'followup', {
        source: 'local',
        intent: result.intent,
        stops: [],
        route_reason: L('本地规则按你的调整重排', 'Local rules re-ordered the route for your request'),
      });
      setAiStatus('local', L('本地调整', 'Local adjust'));
      showWarnings([result.message, ...(result.warnings || [])]);
      return;
    }
    if (result.kind === 'unknown') {
      setStatus('notice', L('没识别出调整指令，当前路线保持不变。想重新规划，先点「重置」。', 'No adjustment recognised; the route is unchanged. Press “Reset” to plan again.'));
      return;
    }
    showError(result.message || L('这条追问没有生效，请换一种说法。', 'That follow-up had no effect; try rephrasing.'));
  } catch (error) {
    showError(L(`处理失败：${error?.message || error}`, `Failed: ${error?.message || error}`));
  } finally {
    setBusy(false);
  }
}

initMapStage();
initAmap();

if (promptInput) promptInput.value = '';

paint(SAMPLES[sampleKey] ?? SAMPLES.long, sampleKey, samplePlan(sampleKey));
syncActionState();

getAgentHealth().then((health) => {
  hasAi = Boolean(health?.configured);
  if (hasAi) setAiStatus('ready', `AI 待命 · ${health.model || 'deepseek'}`);
  else setAiStatus('local', '未配置 AI Key · 本地规划');
});

// 切语言后重绘运行时文案（静态文案由 i18n 自己刷新）
onLangChange(() => {
  if (lastPaint) paint(lastPaint.script, lastPaint.sample, lastPaint.plan);
  syncActionState();
});

generateBtn?.addEventListener('click', () => submit(promptInput?.value));
promptInput?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.isComposing && !event.shiftKey) {
    event.preventDefault();
    submit(promptInput.value);
  }
});

quickButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const text = caseText(button.dataset.tourCase);
    if (!text) return;
    if (promptInput) promptInput.value = text;
    submit(text, { fresh: true });
  });
});

followReset?.addEventListener('click', resetToSample);

followButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const text = getLang() === 'en'
      ? (button.dataset.tourFollowEn || button.dataset.tourFollow)
      : button.dataset.tourFollow;
    if (!text) return;
    if (promptInput) promptInput.value = text;
    submit(text);
  });
});

// 左右面板收起 / 展开（弹簧动画在 CSS 里，这里只管状态与可访问性）
const panelToggles = [
  { toggle: document.getElementById('toggle-left'), tab: document.getElementById('tab-left'), bodyClass: 'panel-left-hidden', expandedLabel: '收起路线栏', collapsedLabel: '展开路线栏' },
  { toggle: document.getElementById('toggle-right'), tab: document.getElementById('tab-right'), bodyClass: 'panel-right-hidden', expandedLabel: '收起详情栏', collapsedLabel: '展开详情栏' },
];

panelToggles.forEach(({ toggle, tab, bodyClass, expandedLabel, collapsedLabel }) => {
  const setHidden = (hidden) => {
    document.body.classList.toggle(bodyClass, hidden);
    if (toggle) {
      toggle.setAttribute('aria-expanded', String(!hidden));
      toggle.setAttribute('aria-label', hidden ? collapsedLabel : expandedLabel);
    }
  };
  toggle?.addEventListener('click', () => {
    setHidden(true);
    tab?.focus();
  });
  tab?.addEventListener('click', () => {
    setHidden(false);
    toggle?.focus();
  });
});
const composerCollapse = document.getElementById('composer-collapse');
const composerOpen = document.getElementById('composer-open');
composerCollapse?.addEventListener('click', () => {
  document.body.classList.add('composer-hidden');
  composerOpen?.focus();
});
composerOpen?.addEventListener('click', () => {
  document.body.classList.remove('composer-hidden');
  document.getElementById('tour-prompt')?.focus();
});

// AMap 标记点击 → 右侧详情
window.addEventListener('citywalk:select-stop', (event) => {
  focusStop(Number(event.detail?.index) || 0);
});

// 点地图站点 → 选中该站（时间线与右侧详情同步）
document.getElementById('map-canvas')?.addEventListener('stop:select', (event) => {
  const index = Number(event.detail?.index);
  if (Number.isFinite(index)) focusStop(index);
});
