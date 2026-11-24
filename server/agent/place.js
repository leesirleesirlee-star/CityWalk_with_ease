/**
 * 地点详情 + 实时图片：服务端按 POI 名称查询高德 Web 服务，返回地址/营业时间/评分/图片。
 * Key 只在服务端；结果缓存 10 分钟，避免重复消耗配额。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig } from './config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map();

const BAD_NAME = /停车场|停车|入口|售票|厕所|公交|地铁|游客中心|服务中心|充电|餐饮|饭店|酒店|客栈/;

function toRad(value) {
  return (value * Math.PI) / 180;
}

function haversineKm(aLng, aLat, bLng, bLat) {
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function asText(value) {
  if (Array.isArray(value)) return value.filter(Boolean).join('、');
  return typeof value === 'string' ? value : '';
}

function readKnowledge(poi) {
  const file = poi?.knowledge_file;
  if (!file) return null;
  try {
    const full = path.join(ROOT, file);
    if (!fs.existsSync(full)) return null;
    return JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch {
    return null;
  }
}

function lookScore(candidate, poi) {
  const name = String(candidate?.name ?? '');
  if (!name) return -999;
  let score = 0;
  if (name === poi.name) score += 90;
  else if (name.includes(poi.name) || poi.name.includes(name)) score += 55;
  else {
    const set = new Set([...poi.name]);
    const overlap = [...name].filter((char) => set.has(char)).length;
    score += (overlap / Math.max(1, poi.name.length)) * 30;
  }
  if (BAD_NAME.test(name)) score -= 90;
  if (name.includes('-')) score -= 8;
  const rating = Number(candidate?.biz_ext?.rating);
  if (Number.isFinite(rating)) score += (rating - 3.5) * 12;
  if (/(博物馆|公园|寺|祠|街|巷|宫|观|楼|桥)$/.test(name)) score += 5;

  const location = String(asText(candidate?.location) || '').split(',').map(Number);
  if (location.length === 2 && Number.isFinite(location[0]) && Number.isFinite(location[1]) && Number.isFinite(poi.lat) && Number.isFinite(poi.lng)) {
    const km = haversineKm(poi.lng, poi.lat, location[0], location[1]);
    score -= Math.min(80, km * 10);
  }
  return score;
}

function normalizePhotos(candidate) {
  const photos = Array.isArray(candidate?.photos) ? candidate.photos : [];
  const urls = photos
    .map((item) => (typeof item === 'string' ? item : item?.url))
    .filter((url) => typeof url === 'string' && /^https?:\/\//i.test(url));
  return [...new Set(urls)].slice(0, 4);
}

export async function fetchPlaceInfo(poi, { fetchImpl = fetch } = {}) {
  if (!poi?.name) return { ok: false, code: 'NO_POI', message: '缺少地点名称' };
  const cacheKey = `${poi.id || poi.name}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  const { amapKey } = getConfig();
  if (!amapKey) {
    return { ok: false, code: 'NO_AMAP_KEY', message: '未配置 AMAP_WEB_KEY' };
  }

  const url = new URL('https://restapi.amap.com/v3/place/text');
  url.searchParams.set('key', amapKey);
  url.searchParams.set('keywords', poi.name);
  url.searchParams.set('city', '成都');
  url.searchParams.set('citylimit', 'true');
  url.searchParams.set('offset', '10');
  url.searchParams.set('page', '1');
  url.searchParams.set('extensions', 'all');

  let payload;
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(9000) });
    payload = await response.json();
  } catch (error) {
    return { ok: false, code: 'AMAP_TIMEOUT', message: `高德请求失败：${error?.message || error}` };
  }
  if (payload?.status !== '1') {
    return { ok: false, code: 'AMAP_ERROR', message: payload?.info || '高德返回错误' };
  }

  const candidates = Array.isArray(payload.pois) ? payload.pois : [];
  const ranked = candidates
    .map((candidate) => ({ candidate, score: lookScore(candidate, poi) }))
    .sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (!best || best.score < 15) {
    const value = { ok: false, code: 'NO_MATCH', message: '高德没有找到匹配地点', intro: poi.summary || '' };
    cache.set(cacheKey, { at: Date.now(), value });
    return value;
  }

  const hit = best.candidate;
  const knowledge = readKnowledge(poi);
  const intro = [knowledge?.summary, knowledge?.history, knowledge?.observation_guide]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join('\n\n') || poi.summary || '';
  const value = {
    ok: true,
    source: 'amap',
    poi_id: poi.id,
    name: asText(hit.name) || poi.name,
    address: asText(hit.address),
    tel: asText(hit.tel),
    opening_hours: asText(hit.biz_ext?.opentime2) || asText(hit.biz_ext?.open_time) || null,
    rating: Number.isFinite(Number(hit.biz_ext?.rating)) ? Number(hit.biz_ext.rating) : null,
    amap_id: asText(hit.id),
    location: asText(hit.location),
    intro,
    photos: normalizePhotos(hit).map((url) => ({ url, source: 'amap' })),
    fetched_at: new Date().toISOString(),
  };
  cache.set(cacheKey, { at: Date.now(), value });
  return value;
}

export function clearPlaceCache() {
  cache.clear();
}
