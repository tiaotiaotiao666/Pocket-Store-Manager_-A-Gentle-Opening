/**
 * 外链的桌面端受控打开（W4）。
 *
 * 三点约束：
 * 1. 只接受绝对 http/https；javascript: / data: / file: / vbscript: 等一律拒绝。
 * 2. 渲染进程永远拿不到窗口/新进程能力：这里只调 `shell.openExternal`，
 *    不加载 URL 到 Electron 窗口、不传任何 Electron 选项给页面。
 * 3. 从不自动打开：只有用户点了链接才会走到这里。
 */

const ALLOWED_LINK_PROTOCOLS = Object.freeze(['http:', 'https:']);
const MAX_LINK_CHARS = 2048;
// 协议伪装常用字符：控制字符、各类空白与零宽字符。
const PROTOCOL_NOISE = /[\u0000-\u0020\u007f\u200b-\u200f\u2028\u2029\ufeff]+/g;

function sanitizeExternalUrl(raw) {
  if (typeof raw !== 'string') return null;
  if (raw.length > MAX_LINK_CHARS) return null;
  const cleaned = raw.replace(PROTOCOL_NOISE, '');
  if (!cleaned) return null;
  let parsed;
  try {
    parsed = new URL(cleaned);
  } catch (error) {
    return null;
  }
  if (!ALLOWED_LINK_PROTOCOLS.includes(parsed.protocol)) return null;
  if (!parsed.hostname) return null;
  if (parsed.username || parsed.password) return null;
  if (parsed.href.length > MAX_LINK_CHARS) return null;
  return parsed.href;
}

/**
 * @param {unknown} rawUrl 渲染进程传来的原始链接
 * @param {{ shell?: { openExternal?: Function } }} [options]
 */
async function openExternalLink(rawUrl, options = {}) {
  const url = sanitizeExternalUrl(rawUrl);
  if (!url) {
    return {
      ok: false,
      code: 'URL_BLOCKED',
      message: '只允许打开 http/https 链接，其它协议不会被执行。',
    };
  }
  const shell = options.shell;
  if (!shell || typeof shell.openExternal !== 'function') {
    return {
      ok: false,
      code: 'SHELL_UNAVAILABLE',
      message: '当前环境无法调用系统浏览器。',
    };
  }
  try {
    await shell.openExternal(url);
    return { ok: true, code: 'OPENED', url };
  } catch (error) {
    return {
      ok: false,
      code: 'OPEN_FAILED',
      message: '系统未能打开这个链接，可以复制链接手动访问。',
    };
  }
}

/** 只允许窗口停留在应用自身页面（dev server 或打包后的 file://）。 */
function isAllowedAppUrl(rawUrl, allowedPrefixes) {
  if (typeof rawUrl !== 'string' || !rawUrl) return false;
  return (Array.isArray(allowedPrefixes) ? allowedPrefixes : []).some((prefix) => (
    typeof prefix === 'string' && prefix && rawUrl.startsWith(prefix)
  ));
}

module.exports = {
  ALLOWED_LINK_PROTOCOLS,
  MAX_LINK_CHARS,
  sanitizeExternalUrl,
  openExternalLink,
  isAllowedAppUrl,
};
