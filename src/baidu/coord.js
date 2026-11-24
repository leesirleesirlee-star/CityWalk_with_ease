// WGS84 -> GCJ-02 -> BD-09.
// 知识库里的 coords 是 WGS84；百度地图 BMapGL.Point 使用 BD-09。
const PI = Math.PI;
const A = 6378245.0;
const EE = 0.00669342162296594323;

function outOfChina(lng, lat) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x, y) {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(y * PI) + 40.0 * Math.sin((y / 3.0) * PI)) * 2.0) / 3.0;
  ret += ((160.0 * Math.sin((y / 12.0) * PI) + 320 * Math.sin((y * PI) / 30.0)) * 2.0) / 3.0;
  return ret;
}

function transformLng(x, y) {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(x * PI) + 40.0 * Math.sin((x / 3.0) * PI)) * 2.0) / 3.0;
  ret += ((150.0 * Math.sin((x / 12.0) * PI) + 300.0 * Math.sin((x / 30.0) * PI)) * 2.0) / 3.0;
  return ret;
}

export function wgs84ToGcj02(lng, lat) {
  if (outOfChina(lng, lat)) return [lng, lat];
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((A * (1 - EE)) / (magic * sqrtMagic)) * PI);
  dLng = (dLng * 180.0) / ((A / sqrtMagic) * Math.cos(radLat) * PI);
  return [lng + dLng, lat + dLat];
}

/**
 * GCJ-02 -> WGS84 迭代反算（高德/腾讯等平台返回 GCJ-02，落盘统一存 WGS84）。
 * 用 wgs84ToGcj02 的往返误差做收敛判据；中国境内一般 3~4 轮即可收敛到 1e-9 度以内。
 * 返回 [lng, lat]；境外坐标原样返回。
 */
export function gcj02ToWgs84(lng, lat) {
  const targetLng = Number(lng);
  const targetLat = Number(lat);
  if (!Number.isFinite(targetLng) || !Number.isFinite(targetLat)) return [targetLng, targetLat];
  if (outOfChina(targetLng, targetLat)) return [targetLng, targetLat];
  let wgsLng = targetLng;
  let wgsLat = targetLat;
  for (let i = 0; i < 10; i += 1) {
    const [gcjLng, gcjLat] = wgs84ToGcj02(wgsLng, wgsLat);
    const dLng = gcjLng - targetLng;
    const dLat = gcjLat - targetLat;
    wgsLng -= dLng;
    wgsLat -= dLat;
    if (Math.abs(dLng) < 1e-10 && Math.abs(dLat) < 1e-10) break;
  }
  return [wgsLng, wgsLat];
}

export function gcj02ToBd09(lng, lat) {
  const z = Math.sqrt(lng * lng + lat * lat) + 0.00002 * Math.sin((lat * PI * 3000.0) / 180.0);
  const theta = Math.atan2(lat, lng) + 0.000003 * Math.cos((lng * PI * 3000.0) / 180.0);
  return [z * Math.cos(theta) + 0.0065, z * Math.sin(theta) + 0.006];
}

export function wgs84ToBd09(coords) {
  if (!coords || coords.length < 2) return null;
  const [lng, lat] = coords;
  const [gLng, gLat] = wgs84ToGcj02(Number(lng), Number(lat));
  return gcj02ToBd09(gLng, gLat);
}
