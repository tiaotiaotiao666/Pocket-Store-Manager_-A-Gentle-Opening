/**
 * G1：真实 AI 生图的前端调用层。
 *
 * 边界：
 * - 只跟本地后端的 `/generation/posters*` 打交道；密钥永远留在服务端环境文件里，
 *   渲染进程既不持有也不需要 Key。
 * - 生图接口要求本地会话鉴权，这里用与导入链路相同的演示登录换取短期 Token；
 *   拿不到 Token 就不发请求（匿名请求不得消耗上游额度）。
 * - 网络/服务端不给「合法 PNG」时一律返回失败，调用方据此显示失败，不显示「AI 生成成功」。
 */

const ENV = (typeof import.meta !== 'undefined' && import.meta.env) || {};
const DEFAULT_BASE_URL = String(ENV.VITE_API_BASE_URL || 'http://127.0.0.1:3000/api/v1');
const AUTH_MODE = String(ENV.VITE_IMPORT_AUTH_MODE || 'demo');
const DEMO_OWNER_OPEN_ID = 'demo-owner-001';

export const POSTER_ERROR_TEXT = Object.freeze({
  DESKTOP_REQUIRED: '浏览器模式不会把图片写进项目，请在桌面应用里生成海报。',
  NOT_CONFIGURED: '服务端还没有接入真实生图服务。',
  AUTH_REQUIRED: '登录已失效，请重新生成一次。',
  AUTH_INVALID: '登录已失效，请重新生成一次。',
  DEMO_LOGIN_DISABLED: '当前环境已关闭演示登录，无法调用生图接口。',
  POSTER_PROMPT_INVALID: '提示词需要 1 到 1200 个字符。',
  POSTER_SIZE_INVALID: '不支持这个生图尺寸。',
  POSTER_IMAGE_NOT_CONFIGURED: '服务端还没有配置可用的第三方生图服务。',
  POSTER_IMAGE_AUTH_FAILED: '生图服务鉴权失败，请检查服务端配置。',
  POSTER_IMAGE_RATE_LIMITED: '生成太频繁了，请稍后再试。',
  POSTER_IMAGE_BUSY: '上一张还在生成，请等它结束。',
  POSTER_IMAGE_TIMEOUT: '生图服务响应超时，可以重试或先上传自己的图。',
  POSTER_IMAGE_REJECTED: '生图服务拒绝了这次请求，请调整提示词后重试。',
  POSTER_IMAGE_UNAVAILABLE: '生图服务暂时不可用，可以重试，或先上传自己的图。',
  POSTER_IMAGE_INVALID: '生图服务没有返回有效图片，可以重试或先上传自己的图。',
  NETWORK_ERROR: '连不上本地后端，请确认服务已启动。',
});

export function describePosterError(code, fallback) {
  if (code && POSTER_ERROR_TEXT[code]) return POSTER_ERROR_TEXT[code];
  return fallback || '生成海报失败，请重试。';
}

/** 从设置里的 apiBaseUrl 取出 host，用于「文字需求会发送到该服务」的告知文案。 */
export function posterHostOf(baseUrl) {
  const raw = String(baseUrl || DEFAULT_BASE_URL).trim();
  try {
    return new URL(raw).host;
  } catch (error) {
    return '本地服务';
  }
}

let sessionToken = null;
let tokenPromise = null;

export function resetPosterSession() {
  sessionToken = null;
  tokenPromise = null;
}

function baseOf(baseUrl) {
  return String(baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
}

async function request(baseUrl, path, options = {}) {
  const headers = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  let response;
  try {
    response = await fetch(baseOf(baseUrl) + path, {
      method: options.method || 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch (error) {
    return { ok: false, status: 0, code: 'NETWORK_ERROR' };
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch (error) {
    payload = null;
  }
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      code: (payload && payload.code) || `HTTP_${response.status}`,
      message: (payload && payload.message) || '',
    };
  }
  return { ok: true, status: response.status, data: payload };
}

/** 匿名调用不会消耗上游额度：拿不到本地会话 Token 就直接返回失败。 */
export async function ensurePosterSession(baseUrl) {
  if (sessionToken) return { ok: true, token: sessionToken };
  if (AUTH_MODE !== 'demo') {
    return { ok: false, code: 'DEMO_LOGIN_DISABLED' };
  }
  if (!tokenPromise) {
    tokenPromise = request(baseUrl, '/auth/wechat/login', {
      method: 'POST',
      body: { demoOpenId: DEMO_OWNER_OPEN_ID },
    }).then((result) => {
      if (!result.ok) return result;
      sessionToken = result.data && result.data.token;
      if (!sessionToken) return { ok: false, code: 'AUTH_INVALID' };
      return { ok: true, token: sessionToken };
    }).finally(() => {
      tokenPromise = null;
    });
  }
  return tokenPromise;
}

/** 生图服务可用性：只读状态，不触发任何上游调用。 */
export async function fetchPosterStatus(baseUrl) {
  const result = await request(baseUrl, '/generation/posters/status');
  if (!result.ok) return { ok: false, code: result.code, message: describePosterError(result.code, result.message) };
  const data = result.data || {};
  return {
    ok: true,
    configured: data.configured === true,
    provider: String(data.provider || ''),
    model: String(data.model || ''),
    supportedSizes: Array.isArray(data.supportedSizes) ? data.supportedSizes : [],
    disclosure: String(data.disclosure || ''),
  };
}

/** 用已确认的店名 / 品类 / 风格 / 菜名生成提示词（服务端是唯一实现，前端不重复拼）。 */
export async function fetchPosterPrompt(baseUrl, fields) {
  const session = await ensurePosterSession(baseUrl);
  if (!session.ok) return { ok: false, code: session.code, message: describePosterError(session.code) };
  const result = await request(baseUrl, '/generation/posters/prompt', { method: 'POST', token: session.token, body: fields });
  if (!result.ok) {
    if (result.status === 401) resetPosterSession();
    return { ok: false, code: result.code, message: describePosterError(result.code, result.message) };
  }
  return { ok: true, prompt: String((result.data && result.data.prompt) || '') };
}

/**
 * 真实生图。默认只要 1 张以控制费用（上游单张 32~36 秒、1.5~3.1 MB）。
 * 返回的 `dataUrl` 只有在服务端校验过 PNG 签名与尺寸后才会出现。
 */
export async function generatePoster(baseUrl, { prompt, size = '1024x1024', signal } = {}) {
  const session = await ensurePosterSession(baseUrl);
  if (!session.ok) return { ok: false, code: session.code, message: describePosterError(session.code) };
  const result = await request(baseUrl, '/generation/posters', {
    method: 'POST',
    token: session.token,
    body: { prompt, size },
    signal,
  });
  if (!result.ok) {
    if (result.status === 401) resetPosterSession();
    return { ok: false, code: result.code, message: describePosterError(result.code, result.message) };
  }
  const data = result.data || {};
  if (typeof data.dataUrl !== 'string' || !data.dataUrl.startsWith('data:image/png;base64,')) {
    return { ok: false, code: 'POSTER_IMAGE_INVALID', message: describePosterError('POSTER_IMAGE_INVALID') };
  }
  return {
    ok: true,
    dataUrl: data.dataUrl,
    mimeType: data.mimeType || 'image/png',
    width: data.width,
    height: data.height,
    bytes: data.bytes,
    sha256: data.sha256,
    provider: data.provider,
    model: data.model,
    latencyMs: data.latencyMs,
    requestedSize: data.requestedSize,
    usage: data.usage || null,
  };
}
