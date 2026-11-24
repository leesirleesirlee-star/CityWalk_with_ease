import { wgs84ToGcj02 } from '../baidu/coord.js';
import { planWalkingLegs, queryWalkingLeg } from './walkingRoute.js';

let map;
let amap;
let mapMode = import.meta.env.VITE_AMAP_3D === 'true' ? '3d' : '2d';
let overlays = [];
let latestScript;
let revision = 0;
let notify = () => {};
let unavailable = false;

function syncModeButton() {
  const button = document.getElementById('map-view-toggle');
  if (!button) return;
  button.hidden = !map;
  button.textContent = mapMode === '3d' ? '3D' : '2D';
  button.title = mapMode === '3d' ? '切换到 2D 平面视图' : '切换到 3D 立体视图';
  button.setAttribute('aria-label', button.title);
}

/** 2D / 3D 切换：2D 回到路线全览，3D 拉近到街区并开启俯仰/旋转。 */
export function setAmapMode(next) {
  if (!map) return;
  mapMode = next === '2d' ? '2d' : '3d';
  try {
    if (mapMode === '3d') {
      map.setStatus({ pitchEnable: true, rotateEnable: true });
      map.setPitch(55);
      map.setRotation(-20);
      if (map.getZoom() < 15.2) {
        map.setZoomAndCenter(16, map.getCenter(), false, 600);
        setTimeout(() => {
          try {
            map.setPitch(55);
            map.setRotation(-20);
          } catch {
            /* ignore */
          }
        }, 700);
      }
    } else {
      map.setPitch(0);
      map.setRotation(0);
      map.setStatus({ pitchEnable: false, rotateEnable: false });
      if (overlays.length) {
        const right = window.matchMedia('(max-width: 900px)').matches ? 40 : 340;
        const top = window.matchMedia('(max-width: 900px)').matches ? 150 : 230;
        map.setFitView(overlays, false, [top, right, 140, 80], 15);
      }
    }
  } catch {
    /* 老版本 SDK 没有 setPitch 时保持当前视图 */
  }
  syncModeButton();
}

function bindModeToggle() {
  const button = document.getElementById('map-view-toggle');
  if (!button) return;
  button.addEventListener('click', () => setAmapMode(mapMode === '3d' ? '2d' : '3d'));
  syncModeButton();
}

export function setWalkingRouteListener(listener) {
  notify = listener;
}

function makePoints(script) {
  return (script?.route || []).map((stop) => {
    const valid = stop.lng != null && stop.lat != null && Number.isFinite(Number(stop.lng)) && Number.isFinite(Number(stop.lat));
    return { name: stop.name || '站点', stop, position: valid ? wgs84ToGcj02(Number(stop.lng), Number(stop.lat)) : null };
  });
}

function paintMap(points, legs) {
  if (!map || !amap) return;
  map.remove(overlays);
  overlays = [];
  points.forEach((point, index) => {
    if (!point.position) return;
    const marker = new amap.Marker({ position: point.position, title: `${index + 1}. ${point.name}`, label: { content: String(index + 1), direction: 'top' } });
    marker.on('click', () => {
      window.dispatchEvent(new CustomEvent('citywalk:select-stop', { detail: { index } }));
    });
    overlays.push(marker);
  });
  legs.forEach((leg) => {
    if (!leg.from.position || !leg.to.position) return;
    const network = leg.status === 'network';
    overlays.push(new amap.Polyline({
      path: network ? leg.path : [leg.from.position, leg.to.position],
      strokeColor: network ? '#218c58' : '#df9d38', strokeWeight: 5,
      strokeStyle: network ? 'solid' : 'dashed', strokeDasharray: [8, 8],
    }));
  });
  if (overlays.length) {
    map.add(overlays);
    const right = window.matchMedia('(max-width: 900px)').matches ? 40 : 340;
    const top = window.matchMedia('(max-width: 900px)').matches ? 150 : 230;
    map.setFitView(overlays, false, [top, right, 140, 80], 15);
    // setFitView 会重置相机；3D 模式下把俯仰/旋转补回来。
    if (mapMode === '3d') {
      setTimeout(() => setAmapMode('3d'), 120);
    }
  }
}

function straightLegs(points) {
  return points.slice(1).map((to, index) => ({ from: points[index], to, status: to.position && points[index].position ? 'fallback_straight' : 'unavailable' }));
}

function publish(script, legs, status) {
  const label = document.getElementById('map-source-label');
  if (label) label.textContent = status === 'loading' ? 'AMap 底图 · 正在查询步行路线' :
    legs.some((leg) => leg.status !== 'network') ? 'AMap 底图 · 虚线为直线估算' :
    legs.length ? 'AMap 底图 · 步行路线' : 'AMap 底图 · 点击标记查看详情';
  notify({ script, legs, status });
}

export async function renderAmapRoute(script) {
  latestScript = script;
  const current = ++revision;
  const points = makePoints(script);
  const fallback = straightLegs(points);
  if (!map || !amap) {
    notify({ script, legs: fallback, status: unavailable ? 'fallback' : 'loading' });
    return;
  }
  paintMap(points, fallback);
  if (!fallback.length) {
    publish(script, fallback, 'complete');
    return;
  }
  publish(script, fallback, 'loading');
  let walking;
  try { walking = new amap.Walking(); } catch {
    if (current === revision) publish(script, fallback, 'fallback');
    return;
  }
  const legs = await planWalkingLegs(points, (origin, destination) => queryWalkingLeg(walking, origin, destination));
  if (current !== revision) return;
  paintMap(points, legs);
  publish(script, legs, legs.every((leg) => leg.status === 'network') ? 'complete' : 'fallback');
}

export function initAmap() {
  // 界面上填的地图 Key 优先（存在本机浏览器），其次是构建期的环境变量
  let storedKey = '';
  try {
    storedKey = localStorage.getItem('yunjing.amapKey') || '';
  } catch {
    storedKey = '';
  }
  const key = storedKey.trim() || import.meta.env.VITE_AMAP_KEY;
  const host = document.getElementById('amap-canvas');
  const fail = () => {
    unavailable = true;
    if (host) host.hidden = true;
    const button = document.getElementById('map-view-toggle');
    if (button) button.hidden = true;
    if (latestScript) notify({ script: latestScript, legs: straightLegs(makePoints(latestScript)), status: 'fallback' });
  };
  if (!key || !host) { fail(); return; }
  window._AMapSecurityConfig = { serviceHost: `${location.origin}/_AMapService` };
  const loader = document.createElement('script');
  loader.src = 'https://webapi.amap.com/loader.js';
  loader.async = true;
  const loaderTimeout = setTimeout(fail, 15000);
  loader.onload = async () => {
    try {
      amap = await window.AMapLoader.load({ key, version: '2.0', plugins: ['AMap.Walking'] });
      if (unavailable) return;
      clearTimeout(loaderTimeout);
      host.hidden = false;
      map = new amap.Map(host, {
        zoom: 13,
        center: [104.0665, 30.5728],
        viewMode: '3D',
        pitch: mapMode === '3d' ? 50 : 0,
        rotation: mapMode === '3d' ? -20 : 0,
        pitchEnable: true,
        rotateEnable: true,
        buildingAnimation: true,
        showBuildingBlock: true,
        building: true,
        zooms: [10, 20],
      });
      window.__AMAP_MAP__ = map;
      bindModeToggle();
      setAmapMode(mapMode);
    } catch {
      clearTimeout(loaderTimeout);
      fail();
      return;
    }
    // 路线绘制失败不能把底图一起关掉：底图优先，路线回退由 renderAmapRoute 自己处理。
    if (latestScript) {
      try {
        renderAmapRoute(latestScript);
      } catch {
        /* 保留底图 */
      }
    }
  };
  loader.onerror = () => { clearTimeout(loaderTimeout); fail(); };
  document.head.append(loader);
}
