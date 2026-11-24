/**
 * 本地 AI 规划服务（Vite 中间件 / 也可单独挂到任意 Node http 服务）。
 *
 * 路由（挂载点为 /api/agent，Vite 会剥离前缀，因此 req.url 是 /health、/plan）：
 *   GET  /health → { ok, configured, model, catalog_size }
 *   POST /plan   → 读 JSON body → parseMasterIntent → DeepSeek → validateAiPlan → composeAiScript
 *                  成功 { ok:true, source:'llm', model, elapsed_ms, intent, stops, route_reason, script, warnings }
 *                  失败 HTTP 200 { ok:false, code, message, elapsed_ms }
 *
 * 安全：API Key 只从服务端环境变量读取，绝不返回给客户端；错误不抛栈。
 * 限流：内存 20 次/分钟（单进程）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getConfig } from './config.js';
import { callDeepSeek } from './deepseek.js';
import { buildMessages } from './prompt.js';
import { validateAiPlan } from './validate-plan.js';
import { composeAiScript } from './composer.js';
import { fetchPlaceInfo } from './place.js';
import { parseMasterIntent } from '../../src/agent/citywalk/masterPipeline.js';
import { resolveStayMinutes } from '../../src/agent/citywalk/budget.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CITY_ID = 'chengdu';
const MAX_BODY_BYTES = 64 * 1024;
const RATE_LIMIT_COUNT = 20;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

const INTEREST_KEYWORDS = Object.freeze({
  茶文化: ['茶'],
  摄影: ['拍', '机位', '出片', '打卡'],
  历史: ['历史', '祠', '寺', '古', '三国', '文化'],
  美食: ['美食', '小吃', '吃', '夜宵', '夜市'],
  市井: ['市井', '老街', '巷', '烟火'],
  自然: ['公园', '园林', '自然', '江'],
  夜景: ['夜景', '夜', '灯', '河岸'],
  建筑: ['建筑', '街区', '楼', '院'],
});

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sendJson(res, statusCode, payload) {
  if (!res || typeof res.end !== 'function' || res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.statusCode = statusCode;
  if (typeof res.setHeader === 'function') {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
  }
  res.end(body);
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 错误信息脱敏：去掉可能出现的 API Key，并限制长度。 */
function sanitizeMessage(message, apiKey) {
  let text = String(message ?? '').replace(/\s+/g, ' ').trim();
  if (apiKey) text = text.replace(new RegExp(escapeRegExp(apiKey), 'g'), '***');
  return text.length > 300 ? `${text.slice(0, 300)}…` : text || '未知错误';
}

/* ── 城市包目录加载 ───────────────────────────────── */

const knowledgeSummaryCache = new Map();

function loadKnowledgeSummary(sourceFile) {
  if (!sourceFile) return '';
  if (knowledgeSummaryCache.has(sourceFile)) return knowledgeSummaryCache.get(sourceFile);
  let summary = '';
  try {
    const file = path.join(ROOT, sourceFile);
    if (fs.existsSync(file)) {
      const doc = readJsonFile(file);
      summary = typeof doc?.summary === 'string' ? doc.summary.trim() : '';
    }
  } catch {
    summary = '';
  }
  knowledgeSummaryCache.set(sourceFile, summary);
  return summary;
}

function deriveTags(name, category, summary) {
  const hay = `${name || ''} ${category || ''} ${summary || ''}`;
  const tags = [];
  if (category) tags.push(category);
  for (const [interest, words] of Object.entries(INTEREST_KEYWORDS)) {
    if (words.some((word) => hay.includes(word))) tags.push(interest);
  }
  return [...new Set(tags)];
}

function normalizeCatalogPoi(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id ?? raw.poi_id ?? '').trim();
  if (!id) return null;
  const name = String(raw.name ?? id);
  const category = String(raw.category ?? '');
  const lat = Number(raw.lat ?? raw.latitude);
  const lng = Number(raw.lng ?? raw.lon ?? raw.longitude);
  const stayRaw = Number(raw.stay_min ?? raw.stay);
  const stayMin =
    Number.isFinite(stayRaw) && stayRaw > 0 ? Math.round(stayRaw) : resolveStayMinutes({ category }).stay_min;
  const summary =
    typeof raw.summary === 'string' && raw.summary.trim()
      ? raw.summary.trim()
      : loadKnowledgeSummary(raw.knowledge_file ?? raw.source_file);
  return {
    id,
    name,
    category,
    tags:
      Array.isArray(raw.tags) && raw.tags.length
        ? raw.tags.map(String)
        : deriveTags(name, category, summary),
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    stay_min: stayMin,
    rating: Number.isFinite(Number(raw.rating)) ? Number(raw.rating) : null,
    open: raw.open ?? raw.opening_hours ?? null,
    summary,
    coord_source: raw.coord_source ?? null,
    address: raw.address ?? null,
    source_urls: Array.isArray(raw.source_urls) ? raw.source_urls : [],
    knowledge_file: raw.knowledge_file ?? raw.source_file ?? null,
  };
}

function buildCatalogFromGeo() {
  const geoFile = path.join(ROOT, 'data', 'cities', CITY_ID, 'pois.geojson');
  const geo = readJsonFile(geoFile);
  const features = Array.isArray(geo?.features) ? geo.features : [];
  const catalog = [];
  for (const feature of features) {
    const props = feature?.properties || {};
    const coords = feature?.geometry?.coordinates;
    const lng = Array.isArray(coords) ? Number(coords[0]) : NaN;
    const lat = Array.isArray(coords) ? Number(coords[1]) : NaN;
    // 只把有坐标的 POI 交给 AI（无坐标无法估算步行腿）。
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const name = String(props.name ?? props.poi_id ?? '');
    const category = String(props.category ?? '');
    const summary = loadKnowledgeSummary(props.source_file);
    const stay = resolveStayMinutes({ category });
    catalog.push({
      id: String(props.poi_id ?? ''),
      name,
      category,
      tags: deriveTags(name, category, summary),
      lat,
      lng,
      stay_min: stay.stay_min,
      rating: null,
      open: props.opening_hours ?? null,
      summary,
      coord_source: props.coord_source ?? null,
    });
  }
  return catalog.filter((poi) => poi.id);
}

let catalogCache = null;

function loadCatalog() {
  if (catalogCache) return catalogCache;
  const catalogFile = path.join(ROOT, 'data', 'cities', CITY_ID, 'route-catalog.json');
  if (fs.existsSync(catalogFile)) {
    const data = readJsonFile(catalogFile);
    const list = Array.isArray(data) ? data : Array.isArray(data?.pois) ? data.pois : Array.isArray(data?.catalog) ? data.catalog : Array.isArray(data?.candidates) ? data.candidates : [];
    catalogCache = list.map(normalizeCatalogPoi).filter(Boolean);
  } else {
    catalogCache = buildCatalogFromGeo();
  }
  return catalogCache;
}

function coordsOnly(catalog) {
  return catalog.filter((poi) => Number.isFinite(poi.lat) && Number.isFinite(poi.lng));
}

/* ── 请求体读取 ───────────────────────────────────── */

class BodyError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function readBody(req, limitBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers?.['content-length']);
    if (Number.isFinite(declared) && declared > limitBytes) {
      reject(new BodyError('BODY_TOO_LARGE', `请求体超过 ${limitBytes} 字节`));
      return;
    }
    const chunks = [];
    let size = 0;
    let settled = false;
    const failOnce = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limitBytes) {
        failOnce(new BodyError('BODY_TOO_LARGE', `请求体超过 ${limitBytes} 字节`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (error) => failOnce(new BodyError('BAD_BODY', error?.message || '读取请求体失败')));
  });
}

/* ── 中间件 ───────────────────────────────────────── */

/**
 * @param {{ fetchImpl?: Function }} [options] 注入 fetch 便于测试
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, next?: Function) => void}
 */
export function createAgentApi({ fetchImpl } = {}) {
  const rateHits = [];

  function allowRequest() {
    const now = Date.now();
    while (rateHits.length && now - rateHits[0] >= RATE_LIMIT_WINDOW_MS) rateHits.shift();
    if (rateHits.length >= RATE_LIMIT_COUNT) return false;
    rateHits.push(now);
    return true;
  }

  function handleHealth(res) {
    try {
      const config = getConfig();
      const catalog = loadCatalog();
      sendJson(res, 200, {
        ok: true,
        configured: Boolean(config.apiKey),
        amap_configured: Boolean(config.amapKey),
        model: config.model,
        catalog_size: catalog.length,
        coords_size: coordsOnly(catalog).length,
      });
    } catch (error) {
      sendJson(res, 200, { ok: false, configured: false, code: 'HEALTH_FAILED', message: sanitizeMessage(error?.message) });
    }
  }

  /**
   * 设置面板保存服务端 Key：只允许本机回环请求，写入 .env.local，Key 不回传。
   * 只接受 DEEPSEEK_API_KEY / AMAP_WEB_KEY 两个变量。
   */
  async function handleConfig(req, res) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: '只支持 POST' });
      return;
    }
    const remote = String(req.socket?.remoteAddress || '');
    const local = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1' || remote === '';
    if (!local) {
      sendJson(res, 403, { ok: false, code: 'LOCAL_ONLY', message: '只允许本机设置' });
      return;
    }

    let payload;
    try {
      const bodyText = await readBody(req, 8 * 1024);
      payload = JSON.parse(bodyText || '{}');
    } catch {
      sendJson(res, 400, { ok: false, code: 'INVALID_JSON', message: '请求体不是合法 JSON' });
      return;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      sendJson(res, 400, { ok: false, code: 'INVALID_BODY', message: '请求体必须是对象' });
      return;
    }

    const allowed = ['DEEPSEEK_API_KEY', 'AMAP_WEB_KEY'];
    const updates = {};
    for (const key of allowed) {
      const value = typeof payload[key] === 'string' ? payload[key].replace(/[\r\n]/g, '').trim() : '';
      if (value) updates[key] = value.slice(0, 256);
    }
    if (!Object.keys(updates).length) {
      sendJson(res, 400, { ok: false, code: 'NO_FIELDS', message: '没有需要保存的 Key' });
      return;
    }

    try {
      const envFile = path.join(ROOT, '.env.local');
      let text = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
      for (const [key, value] of Object.entries(updates)) {
        const pattern = new RegExp(`^\\s*${key}\\s*=.*$`, 'm');
        if (pattern.test(text)) text = text.replace(pattern, `${key}=${value}`);
        else text = `${text.replace(/\s*$/, '')}\n${key}=${value}\n`;
      }
      fs.mkdirSync(path.dirname(envFile), { recursive: true });
      fs.writeFileSync(envFile, text, 'utf8');
      Object.assign(process.env, updates);
      sendJson(res, 200, {
        ok: true,
        updated: Object.keys(updates),
        message: '已写入 .env.local，立即生效；请不要把 .env.local 提交到仓库',
      });
    } catch (error) {
      sendJson(res, 500, { ok: false, code: 'WRITE_FAILED', message: `写入失败：${sanitizeMessage(error?.message)}` });
    }
  }

  async function handlePlace(req, res) {    let id = '';
    try {
      id = new URL(String(req.url || '/'), 'http://127.0.0.1').searchParams.get('id') || '';
    } catch {
      id = '';
    }
    if (!id) {
      sendJson(res, 400, { ok: false, code: 'MISSING_ID', message: '请提供 poi id' });
      return;
    }
    const catalog = loadCatalog();
    const poi = catalog.find((item) => item.id === id);
    if (!poi) {
      sendJson(res, 404, { ok: false, code: 'POI_NOT_FOUND', message: `未知地点：${id}` });
      return;
    }
    const info = await fetchPlaceInfo(poi, { fetchImpl: fetchImpl || fetch });
    sendJson(res, 200, info);
  }

  async function handlePlan(req, res) {
    const startedAt = Date.now();
    const elapsed = () => Date.now() - startedAt;
    const fail = (code, message, extra = {}) =>
      sendJson(res, 200, { ok: false, code, message: sanitizeMessage(message), elapsed_ms: elapsed(), ...extra });

    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: '请使用 POST /api/agent/plan', elapsed_ms: elapsed() });
      return;
    }
    if (!allowRequest()) {
      fail('RATE_LIMITED', `请求过于频繁（上限 ${RATE_LIMIT_COUNT} 次/分钟），请稍后再试`);
      return;
    }

    let bodyText;
    try {
      bodyText = await readBody(req);
    } catch (error) {
      fail(error?.code || 'BAD_BODY', error?.message || '读取请求体失败');
      return;
    }

    let payload;
    try {
      payload = JSON.parse(bodyText || '{}');
    } catch {
      fail('INVALID_JSON', '请求体不是合法 JSON');
      return;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      fail('INVALID_JSON', '请求体必须是 JSON 对象');
      return;
    }
    const text = String(payload.text ?? payload.prompt ?? payload.query ?? '').trim();
    const lang = payload.lang === 'en' ? 'en' : 'zh';
    if (!text) {
      fail('EMPTY_TEXT', '请提供规划需求文本');
      return;
    }
    if (text.length > 1000) {
      fail('TEXT_TOO_LONG', '需求文本过长（上限 1000 字）');
      return;
    }
    const city = payload.city ? String(payload.city) : CITY_ID;
    if (city !== CITY_ID) {
      fail('CITY_UNSUPPORTED', `当前只支持成都（${CITY_ID}）`);
      return;
    }

    const config = getConfig();
    if (!config.apiKey) {
      fail('NOT_CONFIGURED', '服务端未配置 DEEPSEEK_API_KEY，请在 .env 中填写后重启 dev server');
      return;
    }

    let catalog;
    try {
      catalog = loadCatalog();
    } catch (error) {
      fail('CATALOG_FAILED', `城市包候选加载失败：${error?.message || error}`);
      return;
    }
    const candidates = coordsOnly(catalog);
    if (candidates.length < 2) {
      fail('NO_CATALOG', '有坐标候选不足 2 个，无法规划');
      return;
    }

    let intent;
    try {
      intent = parseMasterIntent(text).intent;
    } catch (error) {
      fail('INTENT_FAILED', `需求解析失败：${error?.message || error}`);
      return;
    }

    let aiResult;
    try {
      const messages = buildMessages({ text, intent, catalog: candidates, lang });
      aiResult = await callDeepSeek(messages, { fetchImpl });
    } catch (error) {
      fail(error?.code || 'UPSTREAM_ERROR', error?.message || 'DeepSeek 调用失败');
      return;
    }

    const validated = validateAiPlan(aiResult.content, { catalog: candidates, budgetMin: intent.budget_min });
    if (!validated.ok) {
      const firstError = validated.errors?.[0] || { code: 'INVALID_PLAN', message: 'AI 返回计划不可用' };
      fail(firstError.code, firstError.message, { warnings: validated.warnings || [] });
      return;
    }

    const composed = composeAiScript({
      text,
      intent,
      plan: {
        ...validated.plan,
        model: aiResult.model,
        elapsed_ms: aiResult.elapsed_ms,
        timings: { llm_ms: aiResult.elapsed_ms },
      },
      catalog: candidates,
      now: new Date().toISOString(),
    });
    if (!composed.ok) {
      const firstError = composed.errors?.[0] || { code: 'COMPOSE_FAILED', message: '脚本组装失败' };
      fail(firstError.code, firstError.message, { warnings: composed.warnings || [] });
      return;
    }

    const warnings = [
      ...new Set([
        ...(validated.warnings || []),
        ...(composed.warnings || []),
        ...((composed.script?.meta?.validation?.warnings) || []),
      ]),
    ];
    const introById = new Map((validated.plan.stops || []).map((stop) => [stop.poi_id, stop.intro || '']));
    const stops = composed.script.route.map((stop) => ({
      poi_id: stop.id,
      order: stop.order,
      name: stop.name,
      lat: stop.lat,
      lng: stop.lng,
      stay_min: stop.stay_min,
      score: stop.score,
      why: stop.reason,
      intro: introById.get(stop.id) || '',
      commentary: stop.commentary,
    }));

    sendJson(res, 200, {
      ok: true,
      source: 'llm',
      model: aiResult.model,
      elapsed_ms: elapsed(),
      ai_elapsed_ms: aiResult.elapsed_ms,
      intent,
      stops,
      route_reason: validated.plan.route_reason,
      cut_stops: composed.cut_stops || [],
      script: composed.script,
      warnings,
    });
  }

/** 只允许本机回环地址改写 Key：这是演示机的本地配置入口，不是公网接口。 */
function isLoopbackRequest(req) {
  const remote = String(req.socket?.remoteAddress || '');
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
}

/** 允许通过界面写入的键；其余环境变量不开放。 */
const EDITABLE_ENV_KEYS = Object.freeze([
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_BASE_URL',
  'DEEPSEEK_MODEL',
  'AMAP_WEB_KEY',
]);

const ENV_FILE_LINE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/** 就地更新 .env.local 里指定的键，保留注释与其它行。 */
function writeEnvFile(updates) {
  const file = path.join(ROOT, '.env.local');
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    text = '';
  }
  const pending = new Map(Object.entries(updates));
  const lines = (text ? text.split(/\r?\n/) : []).map((line) => {
    const match = ENV_FILE_LINE.exec(line);
    if (!match || !pending.has(match[1])) return line;
    const value = pending.get(match[1]);
    pending.delete(match[1]);
    return `${match[1]}=${value}`;
  });
  for (const [key, value] of pending) lines.push(`${key}=${value}`);
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  return file;
}

async function handleConfig(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: '请使用 POST /api/agent/config' });
    return;
  }
  if (!isLoopbackRequest(req)) {
    sendJson(res, 403, { ok: false, code: 'FORBIDDEN', message: '仅允许在本机配置 API Key' });
    return;
  }

  let payload;
  try {
    const bodyText = await readBody(req, 8 * 1024);
    payload = JSON.parse(bodyText || '{}');
  } catch {
    sendJson(res, 400, { ok: false, code: 'INVALID_JSON', message: '请求体不是合法 JSON' });
    return;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    sendJson(res, 400, { ok: false, code: 'INVALID_JSON', message: '请求体必须是 JSON 对象' });
    return;
  }

  const updates = {};
  for (const key of EDITABLE_ENV_KEYS) {
    if (!(key in payload)) continue;
    const value = String(payload[key] ?? '').trim();
    if (value.length > 200 || /[\r\n]/.test(value)) {
      sendJson(res, 400, { ok: false, code: 'BAD_VALUE', message: `${key} 格式不合法` });
      return;
    }
    updates[key] = value;
    // getConfig() 每次读 process.env，写回即可立即生效
    process.env[key] = value;
  }

  if (!Object.keys(updates).length) {
    sendJson(res, 400, { ok: false, code: 'NO_KEYS', message: '没有可写入的键' });
    return;
  }

  try {
    writeEnvFile(updates);
  } catch {
    sendJson(res, 500, { ok: false, code: 'WRITE_FAILED', message: '写入 .env.local 失败' });
    return;
  }

  const config = getConfig();
  sendJson(res, 200, {
    ok: true,
    written: Object.keys(updates),
    configured: Boolean(config.apiKey),
    amap_configured: Boolean(config.amapKey),
    model: config.model,
    base_url: config.baseUrl,
  });
}

  return function agentMiddleware(req, res, next) {
    let pathname = '/';
    const rawUrl = String(req.url || '/');
    try {
      pathname = new URL(rawUrl, 'http://127.0.0.1').pathname;
    } catch {
      pathname = rawUrl.split('?')[0];
    }
    let route = pathname.replace(/\/+$/, '') || '/';
    route = route.replace(/^\/api\/agent/, '') || '/';

    if (route === '/health' || route === '/') {
      handleHealth(res);
      return;
    }
    if (route === '/config') {
      handleConfig(req, res).catch(() => {
        sendJson(res, 500, { ok: false, code: 'CONFIG_ERROR', message: '配置写入失败' });
      });
      return;
    }
    if (route === '/config') {
      handleConfig(req, res).catch((error) => {
        sendJson(res, 500, { ok: false, code: 'CONFIG_ERROR', message: sanitizeMessage(error?.message || '设置失败') });
      });
      return;
    }
    if (route === '/place') {
      handlePlace(req, res, { fetchImpl }).catch((error) => {
        sendJson(res, 200, { ok: false, code: 'PLACE_ERROR', message: sanitizeMessage(error?.message || '地点详情失败') });
      });
      return;
    }
    if (route === '/plan') {
      handlePlan(req, res).catch((error) => {
        sendJson(res, 200, {
          ok: false,
          code: 'INTERNAL',
          message: sanitizeMessage(error?.message || '服务内部错误'),
          elapsed_ms: 0,
        });
      });
      return;
    }
    if (typeof next === 'function') {
      next();
      return;
    }
    sendJson(res, 404, { ok: false, code: 'NOT_FOUND', message: '未知 AI 服务路径' });
  };
}

export default createAgentApi;
