'use strict';

/**
 * B2：桌面端凭证持有者（主进程独占）。
 *
 * 为什么需要它：图片识别/Agent 接口要 Bearer，但桌面本地生成器没有微信登录态。
 * 这里只做一件事——向本机后端申领一个短期会话 token（`POST /api/v1/desktop/session`），
 * 由主进程内存持有，再以 `Authorization: Bearer` 代发。
 *
 * 生命周期：
 * - 申领：首次需要时自动申领，不需要用户操作、也不需要手工填任何密钥；
 * - 复用：本地缓存 token，提前 60 秒视为临期并自动重领；
 * - 失效：服务端 TTL 到期、服务重启、被 401 拒绝 → `invalidate()` 清缓存，下次重领；
 * - 失败：拿不到凭证时如实返回失败码，界面提示「会话失效/需重新连接，可重试」，
 *   绝不静默匿名调用，也不把 401 说成「模型不可用」。
 *
 * 安全边界：token 只存在于主进程内存与 HTTP 头里；不落盘、不进日志、
 * 不进 IPC 返回体、不进证据文件。对外只暴露 `describe()` 的布尔与时间。
 */

const DESKTOP_SESSION_ENDPOINT = '/desktop/session';
const DESKTOP_SESSION_CONTRACT = 'desktop-session.v1';
const TOKEN_PATTERN = /^ds_[0-9a-f]{48}$/;
const REFRESH_SKEW_MS = 60 * 1000;
const DEFAULT_TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 64 * 1024;

const CODES = Object.freeze({
  UNSUPPORTED: 'DESKTOP_SESSION_UNSUPPORTED',
  UNAVAILABLE: 'DESKTOP_SESSION_UNAVAILABLE',
  LOOPBACK_ONLY: 'DESKTOP_SESSION_LOOPBACK_ONLY',
  RATE_LIMITED: 'DESKTOP_SESSION_RATE_LIMITED',
  INVALID_RESPONSE: 'DESKTOP_SESSION_INVALID_RESPONSE',
});

const MESSAGES = Object.freeze({
  UNSUPPORTED: '这个后端还不支持桌面会话（版本过旧），请升级到最新后端后再试。',
  UNAVAILABLE: '连不上本地服务，拿不到会话凭证；确认后端已启动后重试。',
  LOOPBACK_ONLY: '后端拒绝非本机来源的会话申领，请在本机运行桌面端。',
  RATE_LIMITED: '申领会话太频繁了，稍后再试。',
  INVALID_RESPONSE: '会话响应不符合约定，已拒绝使用。',
});

function normalizeBaseUrl(baseUrl) {
  if (typeof baseUrl !== 'string') return '';
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(trimmed) ? trimmed : '';
}

function failure(code, extra) {
  return {
    ok: false,
    code,
    message: MESSAGES[code] || MESSAGES.UNAVAILABLE,
    retryable: code !== CODES.UNSUPPORTED,
    ...(extra || {}),
  };
}

/**
 * @param {{fetchImpl?: Function, now?: () => number, timeoutMs?: number}} [options]
 */
function createDesktopCredentialProvider(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : null;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? Math.max(1000, opts.timeoutMs) : DEFAULT_TIMEOUT_MS;

  let token = null;
  let expiresAt = 0;
  let pending = null;
  let lastFailureCode = null;

  function invalidate() {
    token = null;
    expiresAt = 0;
  }

  /** 对外只暴露「有没有/什么时候过期」，永不返回 token 本身。 */
  function describe() {
    return {
      hasToken: Boolean(token),
      expiresAt: expiresAt > 0 ? new Date(expiresAt).toISOString() : null,
      lastFailureCode,
    };
  }

  async function requestToken(baseUrl) {
    if (!fetchImpl) return failure(CODES.UNAVAILABLE);
    const url = baseUrl + DESKTOP_SESSION_ENDPOINT;
    let response;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json; charset=utf-8' },
        body: '{}',
        ...(controller ? { signal: controller.signal } : {}),
      });
    } catch (error) {
      return failure(CODES.UNAVAILABLE);
    } finally {
      if (timer) clearTimeout(timer);
    }

    const status = Number(response && response.status) || 0;
    let text = '';
    try {
      if (response && typeof response.text === 'function') text = await response.text();
      else if (response && typeof response.json === 'function') text = JSON.stringify(await response.json());
    } catch (error) {
      text = '';
    }
    if (typeof text !== 'string' || text.length > MAX_RESPONSE_BYTES) return failure(CODES.INVALID_RESPONSE);

    if (status === 403) return failure(CODES.LOOPBACK_ONLY);
    if (status === 404 || status === 405) return failure(CODES.UNSUPPORTED);
    if (status === 429) return failure(CODES.RATE_LIMITED);
    if (status < 200 || status >= 300) return failure(CODES.UNAVAILABLE);

    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch (error) {
      parsed = null;
    }
    if (!parsed || typeof parsed !== 'object') return failure(CODES.INVALID_RESPONSE);
    if (parsed.contract !== DESKTOP_SESSION_CONTRACT) return failure(CODES.INVALID_RESPONSE);
    if (typeof parsed.token !== 'string' || !TOKEN_PATTERN.test(parsed.token)) {
      return failure(CODES.INVALID_RESPONSE);
    }
    const parsedExpiry = Date.parse(String(parsed.expiresAt || ''));
    if (!Number.isFinite(parsedExpiry) || parsedExpiry <= now()) {
      return failure(CODES.INVALID_RESPONSE);
    }

    token = parsed.token;
    expiresAt = parsedExpiry;
    lastFailureCode = null;
    return { ok: true, authorization: 'Bearer ' + token, expiresAt: new Date(expiresAt).toISOString() };
  }

  /**
   * 取一个可用的 Authorization 值。
   * @param {string} baseUrl 形如 http://127.0.0.1:3000/api/v1
   */
  async function getAuthorization(baseUrl) {
    const url = normalizeBaseUrl(baseUrl);
    if (!url) return failure(CODES.UNAVAILABLE);
    if (token && now() < expiresAt - REFRESH_SKEW_MS) {
      return { ok: true, authorization: 'Bearer ' + token, expiresAt: new Date(expiresAt).toISOString() };
    }
    if (pending) return pending;
    pending = requestToken(url)
      .then((result) => {
        if (!result.ok) {
          lastFailureCode = result.code;
          invalidate();
        }
        return result;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  }

  return { getAuthorization, invalidate, describe };
}

module.exports = {
  createDesktopCredentialProvider,
  CODES,
  MESSAGES,
  DESKTOP_SESSION_ENDPOINT,
  DESKTOP_SESSION_CONTRACT,
  REFRESH_SKEW_MS,
  TOKEN_PATTERN,
};
