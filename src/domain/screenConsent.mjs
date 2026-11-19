/**
 * B5：参考截图外发前的告知与确认（渲染进程侧规则）。
 *
 * 边界：
 * - 这里只负责「说清楚要发什么、发给谁」以及把确认整理成主进程能校验的形状；
 *   是否真的允许发出去由主进程 `desktop/frontend-reconstruct-ipc.cjs` 校验并留痕。
 * - 不读文件、不联网、不拼 URL：host 只从设置里的 apiBaseUrl 解析出来用于告知与绑定。
 * - 确认绑定到「这张图的摘要 + 接收方 host + 时间窗」，换图或换接收方必须重新确认，
 *   绝不做成一次确认永久生效。
 */

export const SCREEN_CONSENT_PURPOSE = 'frontend-reconstruct';

/** 主进程同口径：确认 15 分钟内有效（desktop/frontend-reconstruct-ipc.cjs）。 */
export const SCREEN_CONSENT_MAX_AGE_MS = 15 * 60 * 1000;

const DEFAULT_BASE_URL = 'http://127.0.0.1:3000/api/v1';

export const SCREEN_CONSENT_ERROR_TEXT = Object.freeze({
  FRONTEND_CONSENT_REQUIRED: '这次发送还没有得到你的确认，截图没有发出去。',
  FRONTEND_CONSENT_EXPIRED: '确认已经过期，请重新确认后再发送。',
  FRONTEND_CONSENT_SCOPE_MISMATCH: '图片或接收方变了，这次发送需要重新确认。',
  FRONTEND_CONSENT_UNRECORDED: '没能记录这次发送确认，为安全起见没有调用模型。',
});

export function describeScreenConsentError(code) {
  return SCREEN_CONSENT_ERROR_TEXT[code] || '';
}

/** 从设置里的 apiBaseUrl 取出 host（失败时退回默认本地地址，绝不返回空串）。 */
export function endpointHostOf(baseUrl) {
  const raw = typeof baseUrl === 'string' && baseUrl.trim() ? baseUrl.trim() : DEFAULT_BASE_URL;
  try {
    const parsed = new URL(raw);
    return parsed.host || '';
  } catch (error) {
    try {
      return new URL(DEFAULT_BASE_URL).host;
    } catch (nested) {
      return '127.0.0.1:3000';
    }
  }
}

/**
 * 接受两种写法：完整 base URL（`http://127.0.0.1:3000/api/v1`）或已经算好的 host
 * （`127.0.0.1:3000`）。后者不能再丢给 `new URL()`，否则 `localhost:3001` 会被当成协议解析。
 */
export function normalizeHost(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return endpointHostOf('');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return endpointHostOf(raw);
  return raw;
}

function bytesLabel(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '大小未知';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 图片摘要：与主进程一致，对 base64 文本本身做 SHA-256。
 * 只用于确认绑定，不作为证据外发；返回值会截短给界面看。
 */
export async function imageDigestOf(dataBase64) {
  const text = typeof dataBase64 === 'string' ? dataBase64 : '';
  if (!text) return '';
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle || typeof subtle.digest !== 'function') return '';
  const bytes = new TextEncoder().encode(text);
  const hash = await subtle.digest('SHA-256', bytes);
  return 'sha256:' + [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** 告知内容：哪张图、做什么用、发给谁。全部是给人看的一句话。 */
export function describeScreenSendNotice(input = {}) {
  const image = input.image && typeof input.image === 'object' ? input.image : {};
  const host = normalizeHost(input.host || input.baseUrl);
  const name = typeof image.name === 'string' && image.name.trim() ? image.name.trim() : '参考截图';
  return {
    title: '要把这张截图发给模型识别吗？',
    imageName: name,
    imageSize: bytesLabel(image.bytes),
    purpose: '读懂截图里的页面结构，生成可预览的候选页面（FrontendPack 草稿）',
    host,
    hostLine: `接收接口：${host}`,
    lines: [
      `图片：${name}（${bytesLabel(image.bytes)}）`,
      '用途：读懂截图里的页面结构，生成可预览的候选页面（FrontendPack 草稿），不会写进正式模板',
      `接收接口：${host}（本机后端会把它转给模型）`,
      '不点确认就不会有任何请求；取消不影响当前项目和普通模板流程',
    ],
    confirmLabel: '确认发送',
    cancelLabel: '取消，不发',
  };
}

/** 把用户这一次的确认整理成主进程可校验的凭据（不含图片内容）。 */
export function createScreenConsent(input = {}) {
  const digest = typeof input.imageDigest === 'string' ? input.imageDigest : '';
  const host = normalizeHost(input.host || input.baseUrl);
  const nowMs = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  if (!digest) return null;
  return {
    confirmedAt: new Date(nowMs).toISOString(),
    imageDigest: digest,
    host,
    purpose: SCREEN_CONSENT_PURPOSE,
  };
}

/** 判断已有确认还能不能复用（换图 / 换接收方 / 超时都要重新确认）。 */
export function isScreenConsentUsable(consent, input = {}) {
  if (!consent || typeof consent !== 'object') {
    return { ok: false, reason: 'missing', code: 'FRONTEND_CONSENT_REQUIRED' };
  }
  const digest = typeof input.imageDigest === 'string' ? input.imageDigest : '';
  const host = normalizeHost(input.host || input.baseUrl);
  const nowMs = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  const confirmedAt = Date.parse(consent.confirmedAt);
  if (!Number.isFinite(confirmedAt)) {
    return { ok: false, reason: 'missing', code: 'FRONTEND_CONSENT_REQUIRED' };
  }
  if (consent.imageDigest !== digest) {
    return { ok: false, reason: 'image', code: 'FRONTEND_CONSENT_SCOPE_MISMATCH' };
  }
  if (consent.host !== host) {
    return { ok: false, reason: 'host', code: 'FRONTEND_CONSENT_SCOPE_MISMATCH' };
  }
  if (nowMs - confirmedAt > SCREEN_CONSENT_MAX_AGE_MS || nowMs - confirmedAt < -60 * 1000) {
    return { ok: false, reason: 'expired', code: 'FRONTEND_CONSENT_EXPIRED' };
  }
  return { ok: true, reason: null, code: null };
}
