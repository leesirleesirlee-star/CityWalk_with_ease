/** 页面外观控制：主题。与路线业务无关，避免再把旧版 App 带进来。 */
const root = document.documentElement;
const themeToggle = document.querySelector('#theme-toggle');

function read(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function persist(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 隐私模式忽略 */
  }
}

const forced = new URLSearchParams(location.search).get('theme');
if (forced === 'light' || forced === 'dark') root.dataset.theme = forced;
const saved = read('citywalk:theme');
if (saved === 'light' || saved === 'dark') root.dataset.theme = saved;

function sync() {
  if (!themeToggle) return;
  const dark = (root.dataset.theme || 'dark') !== 'light';
  themeToggle.setAttribute('aria-label', dark ? '切换到浅色主题' : '切换到深色主题');
  themeToggle.dataset.theme = dark ? 'dark' : 'light';
}

const reduceMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * 切换主题。
 * 支持 View Transition 的浏览器：新主题从「左下角 + 右上角」两团同时擦入；
 * 不支持时直接切，不阻塞交互。
 */
function setTheme(next) {
  const apply = () => {
    root.dataset.theme = next;
    persist('citywalk:theme', next);
    sync();
  };

  if (typeof document.startViewTransition !== 'function' || reduceMotion()) {
    apply();
    return;
  }
  try {
    document.startViewTransition(apply);
  } catch {
    apply();
  }
}

themeToggle?.addEventListener('click', () => {
  const next = (root.dataset.theme || 'dark') === 'light' ? 'dark' : 'light';
  setTheme(next);
});

sync();
