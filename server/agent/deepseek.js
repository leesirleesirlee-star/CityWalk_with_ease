/**
 * DeepSeek（OpenAI 兼容）调用封装。
 *
 * - 全局 fetch + AbortController 超时（默认 20s）；
 * - POST {baseUrl}/chat/completions；
 * - temperature=0.2 / max_tokens=1200 / response_format={type:'json_object'}；
 * - 5xx 与网络错误重试 1 次（4xx 不重试）；
 * - 成功返回 { content, model, usage, elapsed_ms }；
 * - 失败抛带 code 的 Error（其中 message 不含 API Key）。
 */

import { getConfig } from './config.js';

export class DeepSeekError extends Error {
  /**
   * @param {string} code 机器可读错误码
   * @param {string} message 人类可读错误信息（不得包含 API Key）
   * @param {{ status?: number, retryable?: boolean, cause?: unknown }} [meta]
   */
  constructor(code, message, meta = {}) {
    super(message);
    this.name = 'DeepSeekError';
    this.code = code;
    if (meta.status !== undefined) this.status = meta.status;
    this.retryable = Boolean(meta.retryable);
    if (meta.cause !== undefined) this.cause = meta.cause;
  }
}

function trimSnippet(text, max = 200) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function endpointOf(baseUrl) {
  // 兼容 https://api.deepseek.com 与 https://api.deepseek.com/v1 两种写法。
  return `${baseUrl}/chat/completions`;
}

function toDeepSeekError(error, timeoutMs) {
  if (error instanceof DeepSeekError) return error;
  if (error?.name === 'AbortError') {
    // 超时不重试：单次 20s 已接近前端 25s 超时，重试会拖垮客户端体验。
    return new DeepSeekError('TIMEOUT', `DeepSeek 请求超时（${timeoutMs}ms）`, { retryable: false, cause: error });
  }
  return new DeepSeekError('NETWORK_ERROR', `DeepSeek 网络请求失败：${error?.message || error}`, {
    retryable: true,
    cause: error,
  });
}

async function requestOnce({ endpoint, payload, apiKey, timeoutMs, fetchImpl, fallbackModel }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const rawText = await response.text();

    if (!response.ok) {
      const retryable = response.status >= 500 || response.status === 429 || response.status === 408;
      const code =
        response.status === 401 || response.status === 403
          ? 'AUTH_FAILED'
          : retryable
            ? 'UPSTREAM_5XX'
            : 'UPSTREAM_4XX';
      throw new DeepSeekError(code, `DeepSeek 接口返回 HTTP ${response.status}：${trimSnippet(rawText)}`, {
        status: response.status,
        retryable,
      });
    }

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (error) {
      throw new DeepSeekError('BAD_RESPONSE', 'DeepSeek 返回内容不是合法 JSON', { cause: error });
    }

    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new DeepSeekError('BAD_RESPONSE', 'DeepSeek 响应缺少 choices[0].message.content');
    }

    return {
      content,
      model: typeof data.model === 'string' && data.model ? data.model : fallbackModel,
      usage: data.usage && typeof data.usage === 'object' ? data.usage : null,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 调用 DeepSeek Chat Completions。
 *
 * @param {Array<{role:string, content:string}>} messages
 * @param {{ fetchImpl?: Function, timeoutMs?: number, json?: boolean,
 *           temperature?: number, maxTokens?: number }} [options]
 * @returns {Promise<{ content: string, model: string, usage: object|null, elapsed_ms: number }>}
 */
export async function callDeepSeek(messages, options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    timeoutMs = getConfig().timeoutMs,
    json = true,
    temperature = getConfig().temperature,
    maxTokens = getConfig().maxTokens,
  } = options;

  if (typeof fetchImpl !== 'function') {
    throw new DeepSeekError('NO_FETCH', '当前 Node 运行时没有可用的 fetch（需要 Node 18+）');
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new DeepSeekError('BAD_REQUEST', 'messages 必须是非空数组');
  }

  const config = getConfig();
  if (!config.apiKey) {
    throw new DeepSeekError('NOT_CONFIGURED', '未配置 DEEPSEEK_API_KEY，无法调用 AI 规划');
  }

  const payload = {
    model: config.model,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: false,
  };
  if (json) payload.response_format = { type: 'json_object' };

  const startedAt = Date.now();
  let lastError = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await requestOnce({
        endpoint: endpointOf(config.baseUrl),
        payload,
        apiKey: config.apiKey,
        timeoutMs,
        fetchImpl,
        fallbackModel: config.model,
      });
      return { ...result, elapsed_ms: Date.now() - startedAt };
    } catch (error) {
      lastError = toDeepSeekError(error, timeoutMs);
      const canRetry = attempt === 0 && lastError.retryable;
      if (!canRetry) throw lastError;
    }
  }

  throw lastError || new DeepSeekError('UNKNOWN', 'DeepSeek 调用未知失败');
}

export default callDeepSeek;
