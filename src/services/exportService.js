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
  // 目录改名被系统拒绝时只给可恢复提示；路径等技术细节留在主进程日志里。
  COMMIT_FAILED: '写入目标位置失败（文件可能被占用），请重试或换一个位置；技术细节已写进日志。',
  SECRET_DETECTED: '生成内容包含敏感信息，已阻止导出。',
  INTERNAL_ADDRESS: '生成内容包含内部地址，已阻止导出。',
  COMPOSE_FAILED: '生成过程出错，请重试。',
  // UX0b：海报素材相关（主进程按资产 ID 读取真实字节，任何一项不合规都阻断本次导出）。
  MEDIA_REQUEST_INVALID: '海报素材请求不合法，已拒绝导出。',
  MEDIA_PROJECT_MISSING: '找不到当前项目，无法读取海报素材。',
  MEDIA_PROJECT_NOT_FOUND: '项目不存在或已被删除，无法读取海报素材。',
  MEDIA_ASSET_ID_INVALID: '海报素材标识不合法，请重新选择图片。',
  MEDIA_ASSET_NOT_IN_PROJECT: '海报素材不存在或不属于当前项目，请重新选择或跳过海报。',
  MEDIA_ASSET_READ_FAILED: '海报素材读取失败，请重新选择图片或跳过。',
  MEDIA_TYPE_UNSUPPORTED: '海报素材目前只支持 PNG 图片。',
  MEDIA_TYPE_MISMATCH: '海报素材文件内容不是有效 PNG，请重新选择。',
  MEDIA_SIZE_INVALID: '海报素材不能超过 2 MB。',
  MEDIA_DIMENSION_INVALID: '无法识别海报素材尺寸，请重新选择图片。',
  MEDIA_DIMENSION_MISMATCH: '海报素材尺寸与登记信息不一致，请重新选择图片。',
  MEDIA_RESOLVER_MISSING: '当前版本不支持导出海报素材，已阻断本次导出。',
  MEDIA_INVALID: '海报素材校验失败，请重新选择图片或跳过。',
});

export const DESKTOP_REQUIRED_MESSAGE = EXPORT_ERROR_TEXT.DESKTOP_REQUIRED;

export function describeExportError(code) {
  return EXPORT_ERROR_TEXT[code] || '导出失败，请重试或查看日志。';
}

const DEFAULT_VALIDATE_TIMEOUT_MS = 10000;
const DEFAULT_PREFLIGHT_TIMEOUT_MS = 5000;

/**
 * P5c：默认导出位置的主进程 token。
 *
 * 渲染进程只传这个 token，真实路径由主进程决定并预先批准；
 * 于是「界面内的默认位置」和「原生对话框选的目录」共用同一条受控写盘通路。
 */
export const DEFAULT_TARGET_TOKEN = '__default__';

function bridge() {
  if (typeof window === 'undefined') return null;
  const api = window.smartStore;
  if (!api || !api.isDesktop) return null;
  return api;
}

/**
 * IPC 调用必须有超时兜底。主进程未注册 handler、进程忙或旧版本缺少通道时，
 * 渲染层不能把 Promise 永久挂起；超时后返回 fallback，由调用方转成可读失败。
 */
function withTimeout(promise, timeoutMs) {
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 0;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => finish({ timedOut: true }), timeout);
    if (timer && typeof timer.unref === 'function') timer.unref();
    Promise.resolve(promise).then(
      (value) => finish({ value }),
      () => finish({ rejected: true }),
    );
  });
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

/**
 * 读取主进程给的默认导出位置（只读，不写盘）。
 *
 * 用途：导出前把目标位置显示给用户，用户点「导出到默认位置」即可完成真实导出，
 * 不必依赖原生目录对话框。
 */
export async function fetchDefaultTarget(options = {}) {
  const api = bridge();
  if (!api || typeof api.defaultExportDirectory !== 'function') {
    return { status: 'desktop-required', message: DESKTOP_REQUIRED_MESSAGE };
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_PREFLIGHT_TIMEOUT_MS;
  let outcome;
  try {
    outcome = await withTimeout(api.defaultExportDirectory(), timeoutMs);
  } catch (error) {
    outcome = { rejected: true };
  }
  if (outcome.timedOut) {
    return {
      status: 'failed',
      code: 'TARGET_CHECK_TIMEOUT',
      message: '读取默认导出位置超时，可以点「选择其他目录」自己指定一个位置。',
    };
  }
  if (outcome.rejected) {
    return {
      status: 'failed',
      code: 'TARGET_CHECK_FAILED',
      message: describeExportError('TARGET_CHECK_FAILED'),
    };
  }
  const result = outcome.value;
  if (!result || result.ok === false) {
    const code = (result && result.code) || 'TARGET_PARENT_MISSING';
    return {
      status: 'failed',
      code,
      message: (result && result.message) || describeExportError(code),
    };
  }
  return {
    status: 'ok',
    path: result.path || '',
    token: result.token || DEFAULT_TARGET_TOKEN,
  };
}

export async function validatePlan(plan, options = {}) {  const api = bridge();
  if (!api || typeof api.composerValidate !== 'function') {
    return { status: 'desktop-required', message: DESKTOP_REQUIRED_MESSAGE };
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_VALIDATE_TIMEOUT_MS;
  const payload = { plan };
  if (options.role !== undefined) payload.role = options.role;
  let outcome;
  try {
    outcome = await withTimeout(api.composerValidate(payload), timeoutMs);
  } catch (error) {
    outcome = { rejected: true };
  }
  if (outcome.timedOut) {
    return {
      status: 'failed',
      code: 'COMPOSE_TIMEOUT',
      message: 'Composer 校验超时，已停止本次体检。请重试；体检不会写盘。',
      warnings: [],
    };
  }
  if (outcome.rejected) {
    return {
      status: 'failed',
      code: 'COMPOSE_FAILED',
      message: describeExportError('COMPOSE_FAILED'),
      warnings: [],
    };
  }
  const result = outcome.value;
  if (!result || result.ok === false) {
    const code = (result && result.code) || 'COMPOSE_FAILED';
    const mapped = EXPORT_ERROR_TEXT[code];
    return {
      status: 'failed',
      code,
      // 已知错误码用给用户看的说法；未知错误码才回落主进程消息。
      message: mapped || (result && result.message) || describeExportError(code),
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
export async function preflightTarget({ parentDir, projectName } = {}, options = {}) {
  const api = bridge();
  if (!api || typeof api.composerPreflightTarget !== 'function') {
    return { status: 'desktop-required', message: DESKTOP_REQUIRED_MESSAGE };
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_PREFLIGHT_TIMEOUT_MS;
  let outcome;
  try {
    outcome = await withTimeout(api.composerPreflightTarget({ parentDir, projectName }), timeoutMs);
  } catch (error) {
    outcome = { rejected: true };
  }
  if (outcome.timedOut) {
    return {
      status: 'failed',
      code: 'TARGET_CHECK_TIMEOUT',
      message: '检查导出位置超时，已停止本次体检。请重试。',
    };
  }
  if (outcome.rejected) {
    return {
      status: 'failed',
      code: 'TARGET_CHECK_FAILED',
      message: describeExportError('TARGET_CHECK_FAILED'),
    };
  }
  const result = outcome.value;
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

export async function exportProject({
  parentDir, plan, projectName, mode = 'development', storeId, backendVersions, role, projectId, posterAssetId,
}) {
  const api = bridge();
  if (!api || typeof api.composerExport !== 'function') {
    return { status: 'desktop-required', message: DESKTOP_REQUIRED_MESSAGE };
  }
  const payload = { parentDir, plan, projectName, mode, storeId, backendVersions };
  if (role !== undefined) payload.role = role;
  // UX0b：只传受控引用，媒体字节由主进程按资产 ID 读取。
  if (projectId) payload.projectId = projectId;
  if (posterAssetId) payload.posterAssetId = posterAssetId;
  const result = await api.composerExport(payload);
  if (!result || result.ok === false) {
    const code = (result && result.code) || 'COMPOSE_FAILED';
    const known = Object.prototype.hasOwnProperty.call(EXPORT_ERROR_TEXT, code);
    return {
      status: code === 'EXPORT_CANCELLED' ? 'cancelled' : (code === 'TARGET_EXISTS' ? 'conflict' : 'failed'),
      code,
      message: known ? EXPORT_ERROR_TEXT[code] : ((result && result.message) || describeExportError(code)),
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