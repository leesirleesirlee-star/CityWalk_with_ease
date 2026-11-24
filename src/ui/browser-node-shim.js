/**
 * Node API 浏览器替身（T4.11）
 *
 * 总控流水线（masterPipeline.js）与兜底模块（resilience.js）用 node:fs / node:path /
 * node:url 读契约与数据文件。浏览器没有这些模块，构建时会被 externalize 成空对象，
 * 模块顶层的 path.dirname() 会直接抛错。
 *
 * 本文件只做三件事，不参与任何业务计算：
 *   1. 提供 path / url 的最小实现（只为顶层常量计算能跑通）；
 *   2. 把 fs.readFileSync 映射到打包期已经载入的 JSON（schema、pois、attractions）；
 *   3. 找不到文件时明确抛错，不返回空对象伪装成功。
 *
 * 数据来源与 Node 端完全同一份文件，因此浏览器生成结果与命令行一致。
 */

import poisRaw from '../../data/cities/chengdu/pois.geojson?raw';
import schema from '../../knowledge/tour_script.schema.json';

const attractionModules = import.meta.glob('../../knowledge/attractions/**/*.json', {
  eager: true,
  import: 'default',
});
const routePoiModules = import.meta.glob('../../knowledge/route-pois/**/*.json', {
  eager: true,
  import: 'default',
});

const FILES = new Map();
FILES.set('pois.geojson', poisRaw);
FILES.set('tour_script.schema.json', JSON.stringify(schema));

for (const [modulePath, value] of Object.entries(attractionModules)) {
  const rel = modulePath.replace(/^.*?(knowledge\/)/, '$1');
  FILES.set(rel, JSON.stringify(value));
  FILES.set(rel.split('/').pop(), JSON.stringify(value));
}

const normalize = (value) => String(value ?? '').replace(/\\/g, '/');

function lookup(file) {
  const key = normalize(file);
  const rel = key.match(/knowledge\/.*$/)?.[0];
  if (rel && FILES.has(rel)) return FILES.get(rel);
  const base = key.split('/').pop();
  if (base && FILES.has(base)) return FILES.get(base);
  return null;
}

export function readFileSync(file) {
  const content = lookup(file);
  if (content === null) {
    throw new Error(`[browser-node-shim] 浏览器端没有该文件：${file}`);
  }
  return content;
}

export function existsSync(file) {
  return lookup(file) !== null;
}

export function dirname(input) {
  const value = normalize(input).replace(/\/+$/, '');
  const index = value.lastIndexOf('/');
  return index <= 0 ? '.' : value.slice(0, index);
}

export function join(...parts) {
  return parts
    .filter((part) => part !== null && part !== undefined && part !== '')
    .map((part) => normalize(part))
    .join('/')
    .replace(/\/{2,}/g, '/');
}

export function resolve(...parts) {
  const joined = join(...parts);
  const absolute = joined.startsWith('/');
  const stack = [];
  for (const segment of joined.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return `${absolute ? '/' : ''}${stack.join('/')}`;
}

export function fileURLToPath(url) {
  return normalize(String(url ?? '').replace(/^file:\/\/\/?/, ''));
}

export const sep = '/';

export default { readFileSync, existsSync, dirname, join, resolve, fileURLToPath, sep };
