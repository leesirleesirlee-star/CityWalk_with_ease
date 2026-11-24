/**
 * AI 规划服务配置（仅服务端）。
 *
 * 读取 DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL / DEEPSEEK_MODEL；
 * 未显式设置时默认 https://api.deepseek.com + deepseek-chat。
 *
 * 为了让 `vite dev` 与 `node` 脚本共用同一份配置，这里额外做一次极简 .env 读取
 * （不引入 dotenv 依赖）：只补全 process.env 中尚不存在的键，不覆盖真实环境变量。
 * 对外只暴露 getConfig() / isConfigured()，API Key 永远不进浏览器。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const DEFAULT_BASE_URL = 'https://api.deepseek.com';
export const DEFAULT_MODEL = 'deepseek-chat';
export const DEFAULT_TIMEOUT_MS = 20000;
export const DEFAULT_MAX_TOKENS = 1200;
export const DEFAULT_TEMPERATURE = 0.2;

let dotEnvLoaded = false;

function loadDotEnvOnce() {
  if (dotEnvLoaded) return;
  dotEnvLoaded = true;
  try {
    // .env.local 优先（Vite 约定），.env 只补缺；真实环境变量永远优先。
    for (const name of ['.env.local', '.env']) {
      const file = path.join(ROOT, name);
      if (!fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, 'utf8');
      for (const line of text.split(/\r?\n/)) {
        const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
        if (!match) continue;
        const [, key, rawValue] = match;
        if (process.env[key] !== undefined) continue;
        let value = rawValue.trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        process.env[key] = value;
      }
    }
  } catch {
    // .env 只是本地便利，读取失败不影响环境变量配置。
  }
}

/**
 * 读取当前配置。
 * @returns {{ apiKey: string, baseUrl: string, model: string,
 *             timeoutMs: number, maxTokens: number, temperature: number }}
 */
export function getConfig() {
  loadDotEnvOnce();
  const apiKey = String(process.env.DEEPSEEK_API_KEY || '').trim();
  const amapKey = String(process.env.AMAP_WEB_KEY || '').trim();
  const baseUrl = (String(process.env.DEEPSEEK_BASE_URL || '').trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const model = String(process.env.DEEPSEEK_MODEL || '').trim() || DEFAULT_MODEL;
  return {
    apiKey,
    amapKey,
    baseUrl,
    model,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxTokens: DEFAULT_MAX_TOKENS,
    temperature: DEFAULT_TEMPERATURE,
  };
}

/** 是否已配置 API Key（不校验 Key 是否有效）。 */
export function isConfigured() {
  return Boolean(getConfig().apiKey);
}

/** 仅用于日志/错误提示，绝不返回 Key 本身。 */
export function describeConfig() {
  const { baseUrl, model } = getConfig();
  return { baseUrl, model, configured: isConfigured() };
}
