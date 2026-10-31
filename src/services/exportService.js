const EXPORT_ERROR_TEXT = Object.freeze({
  TARGET_EXISTS: '同名目录已存在，请换一个项目名或选择其他位置。',
  TARGET_PARENT_MISSING: '导出位置不存在，请重新选择目录。',
  TARGET_PATH_INVALID: '项目名或导出位置不合法，请重新选择目录。',
  TARGET_CHECK_FAILED: '无法检查导出位置，请重新选择目录或稍后重试。',
  TARGET_NOT_WRITABLE: '导出位置不可写，请换一个目录。',
  TARGET_NO_SPACE: '磁盘空间不足，请清理后重试。',
  PATH_TOO_LONG: '目标路径过长，请选择更短的目录名。',
  PAYLOAD_TOO_LARGE: '配置内容过大，无法导出。',
  EXPORT_BUSY: '已有导出任务在运行，请等待完成或取消。',
  EXPORT_CANCELLED: '导出已取消，没有生成任何文件。',
  DESKTOP_REQUIRED: '请在桌面应用中导出，浏览器预览不能写出工程。',
  REGISTRY_DRIFT: '模板资产与注册表不一致，请更新应用后再导出。',
  PLAN_FIELD_FORBIDDEN: '导出配置包含不允许的字段，已拒绝生成。',
  THEME_CONTRAST_LOW: '所选配色对比度不足，请换一套风格。',
  PREVIEW_ONLY_NOT_ACKNOWLEDGED: '存在仅预览能力，需要先确认后才能导出。',
  ASSET_NOT_REGISTERED: '模板资产未登记，无法导出。',
  ASSET_VERSION_NOT_FOUND: '模板版本不存在，请更新应用。',
  API_BASE_URL_NOT_HTTPS: '生产环境的接口地址必须使用 HTTPS。',
  STORE_CONFIG_SCHEMA_UNSUPPORTED: '门店配置版本过旧，请重新导出。',
  OUTPUT_STATIC_CHECK_FAILED: '生成工程未通过静态校验，已回滚。',
  SECRET_DETECTED: '生成内容包含敏感信息，已阻止导出。',
  INTERNAL_ADDRESS: '生成内容包含内部地址，已阻止导出。',
  COMPOSE_FAILED: '生成过程出错，请重试。',
});

export const DESKTOP_REQUIRED_MESSAGE = EXPORT_ERROR_TEXT.DESKTOP_REQUIRED;

export function describeExportError(code) {
  return EXPORT_ERROR_TEXT[code] || '导出失败，请重试或查看日志。';
}

function bridge() {
  if (typeof window === 'undefined') return null;
  const api = window.smartStore;
  if (!api || !api.isDesktop) return null;
  return api;
}

export function isDesktopExportAvailable() {
  const api = bridge();
  return Boolean(api && typeof api.composerExport === 'function');
}

export function subscribeProgress(listener) {
  const api = bridge();
  if (!api || typeof api.onComposerProgress !== 'function' || typeof listener !== 'function') {
    return () => {};
  }
  const unsubscribe = api.onComposerProgress(listener);
  return typeof unsubscribe === 'function' ? unsubscribe : () => {};
}

export async function chooseDirectory() {
  const api = bridge();
  if (!api || typeof api.chooseExportDirectory !== 'function') {
    return { status: 'desktop-required', message: DESKTOP_REQUIRED_MESSAGE };
  }
  const result = await api.chooseExportDirectory();
  if (!result || result.cancelled) return { status: 'cancelled' };
  return { status: 'ok', path: result.path };
}

export async function validatePlan(plan) {
  const api = bridge();
  if (!api || typeof api.composerValidate !== 'function') {
    return { status: 'desktop-required', message: DESKTOP_REQUIRED_MESSAGE };
  }
  const result = await api.composerValidate({ plan });
  if (!result || result.ok === false) {
    return {
      status: 'failed',
      code: result && result.code,
      message: result && result.message ? result.message : describeExportError(result && result.code),
      warnings: (result && result.warnings) || [],
    };
  }
  return { status: 'ok', result };
}

/**
 * 只读目标预检：判断导出位置里是否已有同名工程。
 *
 * 返回 status：
 * - ok：目标不存在，可以继续
 * - conflict：目标已存在，附带 suggestedName
 * - failed：检查失败，必须阻断导出，不能当作“不存在”
 * - desktop-required：浏览器模式没有主进程通道
 */
export async function preflightTarget({ parentDir, projectName } = {}) {
  const api = bridge();
  if (!api || typeof api.composerPreflightTarget !== 'function') {
    return { status: 'desktop-required', message: DESKTOP_REQUIRED_MESSAGE };
  }
  let result;
  try {
    result = await api.composerPreflightTarget({ parentDir, projectName });
  } catch (error) {
    return {
      status: 'failed',
      code: 'TARGET_CHECK_FAILED',
      message: describeExportError('TARGET_CHECK_FAILED'),
    };
  }
  if (!result || result.ok === false) {
    const code = (result && result.code) || 'TARGET_CHECK_FAILED';
    return {
      status: 'failed',
      code,
      message: (result && result.message) || describeExportError(code),
    };
  }
  return {
    status: result.exists ? 'conflict' : 'ok',
    exists: Boolean(result.exists),
    projectName: result.projectName || '',
    suggestedName: result.suggestedName || null,
  };
}

export async function exportProject({ parentDir, plan, projectName, mode = 'development' }) {
  const api = bridge();
  if (!api || typeof api.composerExport !== 'function') {
    return { status: 'desktop-required', message: DESKTOP_REQUIRED_MESSAGE };
  }
  const result = await api.composerExport({ parentDir, plan, projectName, mode });
  if (!result || result.ok === false) {
    const code = (result && result.code) || 'COMPOSE_FAILED';
    return {
      status: code === 'EXPORT_CANCELLED' ? 'cancelled' : (code === 'TARGET_EXISTS' ? 'conflict' : 'failed'),
      code,
      message: describeExportError(code),
      details: result && result.details,
      suggestedName: result && result.details && result.details.suggestedName,
    };
  }
  return { status: 'ok', result };
}

export async function cancelExport(taskId) {
  const api = bridge();
  if (!api || typeof api.composerCancel !== 'function') {
    return { status: 'desktop-required', message: DESKTOP_REQUIRED_MESSAGE };
  }
  const result = await api.composerCancel({ taskId });
  return result || { ok: true };
}

export async function openProjectDirectory(target) {
  const api = bridge();
  if (!api) return { ok: false, message: DESKTOP_REQUIRED_MESSAGE };
  const result = await api.openPath(target);
  if (result && result.error) return { ok: false, message: '目录不存在，可重新导出。' };
  return { ok: true };
}

export async function readReport(outputPath) {
  const api = bridge();
  if (!api || typeof api.composerReadReport !== 'function') {
    return { status: 'desktop-required', message: DESKTOP_REQUIRED_MESSAGE };
  }
  const result = await api.composerReadReport({ outputPath });
  return result || { status: 'failed', message: '报告读取失败。' };
}

export { EXPORT_ERROR_TEXT };