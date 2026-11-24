/** 与本地 AI 规划服务的唯一客户端。Key 永远不进浏览器。 */
import { getLang } from './i18n.js';

const PLAN_TIMEOUT_MS = 25000;

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`服务返回了非 JSON（HTTP ${response.status}）`);
  }
}

export async function getAgentHealth() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const response = await fetch('/api/agent/health', { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return { ok: false, configured: false, reason: `HTTP ${response.status}` };
    return await readJson(response);
  } catch (error) {
    return { ok: false, configured: false, reason: error?.message || 'AI 服务不可达' };
  }
}

export async function requestAiPlan(text) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PLAN_TIMEOUT_MS);
  try {
    const response = await fetch('/api/agent/plan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: String(text ?? '').slice(0, 300),
        city: 'chengdu',
        // 让服务端用同一种语言生成 why / intro / route_reason
        lang: getLang() === 'en' ? 'en' : 'zh',
      }),
      signal: controller.signal,
    });
    const data = await readJson(response);
    return data;
  } catch (error) {
    const timeout = error?.name === 'AbortError';
    return {
      ok: false,
      code: timeout ? 'TIMEOUT' : 'CLIENT',
      message: timeout ? 'AI 规划超时' : error?.message || 'AI 服务不可达',
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 地点详情 + 实时图片（服务端查 AMap，Key 不下发）。 */
export async function getPlaceInfo(poiId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(`/api/agent/place?id=${encodeURIComponent(poiId)}`, { signal: controller.signal });
    return await readJson(response);
  } catch (error) {
    return { ok: false, code: error?.name === 'AbortError' ? 'TIMEOUT' : 'CLIENT', message: '地点图片加载失败' };
  } finally {
    clearTimeout(timer);
  }
}
