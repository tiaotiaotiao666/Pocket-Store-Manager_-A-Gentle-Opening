/**
 * AppID 后置写入服务。唯一允许调用 composer:apply-appid 的地方。
 */

const APPID_RE = /^wx[0-9a-f]{16}$/;

const APPID_ERROR_TEXT = Object.freeze({
  APPID_INVALID: 'AppID 格式不正确（wx + 16 位十六进制）',
  APPID_TARGET_MISSING: '产物不完整，请重新导出',
  APPID_WRITE_FAILED: 'AppID 写入失败，工程保持原始状态',
  APPID_VERIFY_FAILED: '产物摘要自检未通过，已回滚',
  TARGET_NOT_WRITABLE: '只能写入本次会话导出的工程',
  DESKTOP_REQUIRED: '请在桌面应用中写入 AppID',
  UNTRUSTED_SENDER: '请求来源不受信任',
});

function bridge() {
  if (typeof window === 'undefined') return null;
  const api = window.smartStore;
  return api && api.isDesktop ? api : null;
}

export function describeAppidError(code) {
  return APPID_ERROR_TEXT[code] || 'AppID 写入失败，请稍后重试';
}

export function validateAppid(value) {
  const appid = String(value || '').trim().toLowerCase();
  if (!appid) return { ok: true, appid: '', empty: true };
  if (!APPID_RE.test(appid)) {
    return { ok: false, appid, message: 'AppID 格式不正确（wx + 16 位十六进制）' };
  }
  return { ok: true, appid, empty: false };
}

export function createAppidService() {
  const mode = bridge() ? 'desktop' : 'browser';

  async function apply(outputPath, appid) {
    const api = bridge();
    if (mode !== 'desktop' || !api || typeof api.applyAppid !== 'function') {
      return { status: 'desktop-required', code: 'DESKTOP_REQUIRED', message: describeAppidError('DESKTOP_REQUIRED') };
    }
    const checked = validateAppid(appid);
    if (!checked.ok || checked.empty) {
      return { status: 'invalid', code: 'APPID_INVALID', message: checked.message || describeAppidError('APPID_INVALID') };
    }
    const result = await api.applyAppid({ outputPath, appid: checked.appid });
    if (!result || result.ok !== true) {
      return {
        status: 'failed',
        code: result?.code || 'APPID_WRITE_FAILED',
        message: result?.message || describeAppidError(result?.code),
        details: result?.details || null,
      };
    }
    return { status: 'ok', ...result };
  }

  return { mode, apply, validate: validateAppid };
}

export const appidService = createAppidService();
export { APPID_ERROR_TEXT };