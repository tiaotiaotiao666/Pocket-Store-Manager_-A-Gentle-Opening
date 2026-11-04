'use strict';

/**
 * C-REAL-PREVIEW@1 / `real-preview-channel.v1`（Electron 主进程侧实现）。
 *
 * 职责边界：
 * 1. 纯校验：工程目录、截图文件（类型/大小/真实 MIME），可被 node --test 直接测试。
 * 2. 受控打开：只调用 `shell.openPath(dir)` 打开已导出工程目录，
 *    **绝不拼接、绝不执行任意 shell 命令**，也不通过 CLI 注入项目。
 * 3. IPC 注册：`preview:open-project` / `preview:pick-screenshot`。
 *
 * 诚实性约定：本模块只能“打开目录 / 回传截图”，不声称完成了真实渲染。
 * 真实渲染发生在微信开发者工具里，属于人工步骤（见 RealPreviewPanel 文案）。
 */

const nodePath = require('node:path');
const fsPromises = require('node:fs/promises');

const { isTrustedSender } = require('./composer-ipc.cjs');

const PREVIEW_CONTRACT = 'real-preview-channel.v1';

/** IPC 通道名（唯一事实，preload 与测试都引用它）。 */
const PREVIEW_CHANNELS = Object.freeze({
  openProject: 'preview:open-project',
  pickScreenshot: 'preview:pick-screenshot',
});

/** preload 暴露到 window.smartStore 的方法名。 */
const PREVIEW_BRIDGE_METHODS = Object.freeze(['openPreviewProject', 'pickPreviewScreenshot']);

const PREVIEW_MAX_PATH_LENGTH = 1200;
const PREVIEW_MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;
const PREVIEW_SCREENSHOT_MIME_TYPES = Object.freeze(['image/png', 'image/jpeg']);
const PREVIEW_SCREENSHOT_EXTENSIONS = Object.freeze(['.png', '.jpg', '.jpeg']);

/** 系统文件对话框的过滤器（只允许 PNG/JPEG）。 */
const PREVIEW_SCREENSHOT_FILTERS = Object.freeze([
  { name: 'PNG / JPEG 截图', extensions: ['png', 'jpg', 'jpeg'] },
]);

/** 校验失败的错误码（模块前缀大写下划线，便于 UI 与日志稳定匹配）。 */
const PREVIEW_ERROR_CODES = Object.freeze({
  pathInvalid: 'PREVIEW_PATH_INVALID',
  pathNotFound: 'PREVIEW_PATH_NOT_FOUND',
  screenshotCancelled: 'PREVIEW_SCREENSHOT_CANCELLED',
  screenshotInvalid: 'PREVIEW_SCREENSHOT_INVALID',
  screenshotUnsupportedType: 'PREVIEW_SCREENSHOT_UNSUPPORTED_TYPE',
  screenshotTooLarge: 'PREVIEW_SCREENSHOT_TOO_LARGE',
  devtoolsNotFound: 'PREVIEW_DEVTOOLS_NOT_FOUND',
});

/**
 * 契约（2.2.11）规定的 IPC `code` 取值来自集合
 * `PATH_INVALID | PATH_MISSING | DEVTOOLS_NOT_FOUND`。
 * 内部错误码更细，这里做一次显式映射，避免 UI 依赖内部分支。
 */
const PREVIEW_CONTRACT_CODES = Object.freeze({
  PREVIEW_PATH_INVALID: 'PATH_INVALID',
  PREVIEW_PATH_NOT_FOUND: 'PATH_MISSING',
  PREVIEW_SCREENSHOT_CANCELLED: 'PATH_INVALID',
  PREVIEW_SCREENSHOT_INVALID: 'PATH_INVALID',
  PREVIEW_SCREENSHOT_UNSUPPORTED_TYPE: 'PATH_INVALID',
  PREVIEW_SCREENSHOT_TOO_LARGE: 'PATH_INVALID',
  PREVIEW_DEVTOOLS_NOT_FOUND: 'DEVTOOLS_NOT_FOUND',
});

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function toContractCode(code) {
  return PREVIEW_CONTRACT_CODES[code] || code;
}

/**
 * 用文件头（magic bytes）判定真实图片类型，不信任扩展名。
 * @param {Buffer} buffer
 * @returns {'image/png'|'image/jpeg'|null}
 */
function detectImageMime(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  return null;
}

function invalidPath(message) {
  return { ok: false, cancelled: false, code: PREVIEW_ERROR_CODES.pathInvalid, message };
}

/**
 * 校验工程目录：必须是存在且为目录的绝对路径。
 *
 * @param {string} targetPath 待校验路径（来自渲染进程，不一定可信）
 * @param {{ path?: typeof nodePath, fs?: typeof fsPromises }} [options] 便于测试注入
 * @returns {Promise<{ ok: true, path: string, hasProjectConfig: boolean, code: null, message: string }
 *   | { ok: false, cancelled: false, code: string, message: string }>}
 */
async function validateProjectPath(targetPath, options) {
  const opts = options || {};
  const pathApi = opts.path || nodePath;
  const fsApi = opts.fs || fsPromises;

  if (typeof targetPath !== 'string') return invalidPath('工程路径必须是字符串');
  const trimmed = targetPath.trim();
  if (!trimmed) return invalidPath('工程路径不能为空');
  if (trimmed.length > PREVIEW_MAX_PATH_LENGTH) {
    return invalidPath(`工程路径超过 ${PREVIEW_MAX_PATH_LENGTH} 个字符`);
  }
  if (trimmed.includes('\0')) return invalidPath('工程路径包含非法字符');
  if (!pathApi.isAbsolute(trimmed)) return invalidPath('工程路径必须是绝对路径');

  const resolved = pathApi.resolve(trimmed);
  let stats;
  try {
    stats = await fsApi.stat(resolved);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return {
        ok: false,
        cancelled: false,
        code: PREVIEW_ERROR_CODES.pathNotFound,
        message: `工程目录不存在：${resolved}`,
      };
    }
    return invalidPath(`无法读取工程目录（${(error && error.message) || '未知错误'}）：${resolved}`);
  }

  if (!stats || typeof stats.isDirectory !== 'function' || !stats.isDirectory()) {
    return invalidPath(`工程路径不是目录：${resolved}`);
  }

  // 小程序的工程根一般有 project.config.json；缺失不阻断打开，只作为提示信息回传。
  let hasProjectConfig = false;
  try {
    await fsApi.access(pathApi.join(resolved, 'project.config.json'));
    hasProjectConfig = true;
  } catch (error) {
    hasProjectConfig = false;
  }

  return { ok: true, cancelled: false, path: resolved, hasProjectConfig, code: null, message: '' };
}

/**
 * 校验截图文件：只接受 PNG/JPEG 且 ≤ 8 MiB。
 * 返回体直接对齐 IPC 契约（`{ cancelled, path, name, dataUrl, bytes }` 的超集）。
 *
 * @param {string|null|undefined} filePath 为空表示用户取消
 * @param {{ path?: typeof nodePath, fs?: typeof fsPromises }} [options]
 * @returns {Promise<
 *   { ok: false, cancelled: true, code: string, message: string }
 *   | { ok: false, cancelled: false, code: string, message: string }
 *   | { ok: true, cancelled: false, path: string, name: string, bytes: number, mime: string, dataUrl: string }>}
 */
async function validateScreenshotFile(filePath, options) {
  const opts = options || {};
  const pathApi = opts.path || nodePath;
  const fsApi = opts.fs || fsPromises;

  if (filePath === null || filePath === undefined || filePath === '') {
    return {
      ok: false,
      cancelled: true,
      code: PREVIEW_ERROR_CODES.screenshotCancelled,
      message: '已取消选择截图',
    };
  }
  if (typeof filePath !== 'string') {
    return {
      ok: false,
      cancelled: false,
      code: PREVIEW_ERROR_CODES.screenshotInvalid,
      message: '截图路径必须是字符串',
    };
  }

  const trimmed = filePath.trim();
  if (!trimmed || trimmed.length > PREVIEW_MAX_PATH_LENGTH || trimmed.includes('\0')) {
    return {
      ok: false,
      cancelled: false,
      code: PREVIEW_ERROR_CODES.screenshotInvalid,
      message: '截图路径无效',
    };
  }
  if (!pathApi.isAbsolute(trimmed)) {
    return {
      ok: false,
      cancelled: false,
      code: PREVIEW_ERROR_CODES.screenshotInvalid,
      message: '截图路径必须是绝对路径',
    };
  }

  const resolved = pathApi.resolve(trimmed);
  let stats;
  try {
    stats = await fsApi.stat(resolved);
  } catch (error) {
    return {
      ok: false,
      cancelled: false,
      code: PREVIEW_ERROR_CODES.screenshotInvalid,
      message: `截图文件不可读（${(error && error.message) || '未知错误'}）：${resolved}`,
    };
  }
  if (!stats || typeof stats.isFile !== 'function' || !stats.isFile()) {
    return {
      ok: false,
      cancelled: false,
      code: PREVIEW_ERROR_CODES.screenshotInvalid,
      message: `截图路径不是文件：${resolved}`,
    };
  }
  if (!stats.size) {
    return {
      ok: false,
      cancelled: false,
      code: PREVIEW_ERROR_CODES.screenshotInvalid,
      message: '截图文件为空',
    };
  }

  const extension = pathApi.extname(resolved).toLowerCase();
  if (!PREVIEW_SCREENSHOT_EXTENSIONS.includes(extension)) {
    return {
      ok: false,
      cancelled: false,
      code: PREVIEW_ERROR_CODES.screenshotUnsupportedType,
      message: '只接受 PNG / JPEG 截图（.png、.jpg、.jpeg）',
    };
  }
  if (stats.size > PREVIEW_MAX_SCREENSHOT_BYTES) {
    return {
      ok: false,
      cancelled: false,
      code: PREVIEW_ERROR_CODES.screenshotTooLarge,
      message: `截图超过 ${Math.round(PREVIEW_MAX_SCREENSHOT_BYTES / 1024 / 1024)} MiB 上限（当前 ${Math.ceil(stats.size / 1024 / 1024)} MiB）`,
    };
  }

  let buffer;
  try {
    buffer = await fsApi.readFile(resolved);
  } catch (error) {
    return {
      ok: false,
      cancelled: false,
      code: PREVIEW_ERROR_CODES.screenshotInvalid,
      message: `读取截图失败（${(error && error.message) || '未知错误'}）`,
    };
  }

  // stat 与 readFile 之间文件可能变大，读回后再按真实字节数卡一次。
  if (buffer.length > PREVIEW_MAX_SCREENSHOT_BYTES) {
    return {
      ok: false,
      cancelled: false,
      code: PREVIEW_ERROR_CODES.screenshotTooLarge,
      message: `截图超过 ${Math.round(PREVIEW_MAX_SCREENSHOT_BYTES / 1024 / 1024)} MiB 上限`,
    };
  }

  const mime = detectImageMime(buffer);
  if (!mime || !PREVIEW_SCREENSHOT_MIME_TYPES.includes(mime)) {
    return {
      ok: false,
      cancelled: false,
      code: PREVIEW_ERROR_CODES.screenshotUnsupportedType,
      message: '文件内容不是有效的 PNG / JPEG 图片',
    };
  }

  return {
    ok: true,
    cancelled: false,
    path: resolved,
    name: pathApi.basename(resolved),
    bytes: buffer.length,
    mime,
    dataUrl: `data:${mime};base64,${buffer.toString('base64')}`,
  };
}

/**
 * 打开已导出工程目录。
 *
 * 只使用 `shell.openPath`（Windows 资源管理器 / 系统默认文件管理器），
 * 不执行任何 shell 命令、不启动开发者工具 CLI。
 * 返回 `ok:true` 只表示“目录已打开”，**不表示渲染完成**。
 *
 * @param {{ projectPath?: string }|string} payload
 * @param {{ shell?: { openPath?: (dir: string) => Promise<string> }, path?: typeof nodePath, fs?: typeof fsPromises }} [deps]
 */
async function openPreviewProject(payload, deps) {
  const options = deps || {};
  const projectPath = payload && typeof payload === 'object' ? payload.projectPath : payload;
  const validation = await validateProjectPath(projectPath, options);

  if (!validation.ok) {
    return {
      ok: false,
      code: toContractCode(validation.code),
      message: validation.message,
      details: { code: validation.code },
    };
  }

  const target = validation.path;
  const shell = options.shell;
  const hint = '真实渲染需要在微信开发者工具中完成：请在该工具用「导入项目」打开此目录，编译后截图再回填。';

  if (!shell || typeof shell.openPath !== 'function') {
    return {
      ok: false,
      code: 'DEVTOOLS_NOT_FOUND',
      message: `当前环境无法打开目录（缺少 shell.openPath），且未执行任何命令行调用。${hint}`,
      details: { code: PREVIEW_ERROR_CODES.devtoolsNotFound, projectPath: target },
    };
  }

  let openError = '';
  try {
    openError = await shell.openPath(target);
  } catch (error) {
    openError = (error && error.message) || '未知错误';
  }

  if (openError) {
    return {
      ok: false,
      code: 'DEVTOOLS_NOT_FOUND',
      message: `未能打开工程目录（${openError}）。请手动在微信开发者工具中导入：${target}`,
      details: { code: PREVIEW_ERROR_CODES.devtoolsNotFound, projectPath: target },
    };
  }

  const configNotice = validation.hasProjectConfig
    ? ''
    : '（该目录内未检测到 project.config.json，导入前请确认是导出产物根目录。）';

  return {
    ok: true,
    message: `已在文件管理器中打开已导出工程目录。${configNotice}这是目录打开操作，不代表已完成渲染；${hint}`,
    details: { via: 'file-manager', projectPath: target, hasProjectConfig: validation.hasProjectConfig },
  };
}

/**
 * 注册 `preview:open-project` 与 `preview:pick-screenshot` 两个 IPC 通道。
 *
 * @param {import('electron').IpcMain} ipcMain
 * @param {{ dialog?: object, shell?: object, fs?: typeof fsPromises, path?: typeof nodePath }} options
 */
function registerPreviewIpc(ipcMain, options) {
  const opts = options || {};
  const dialog = opts.dialog;
  const shell = opts.shell;
  const fsOverride = opts.fs;
  const pathOverride = opts.path;

  const withSenderCheck = (handler) => async (event, payload) => {
    if (!isTrustedSender(event)) {
      return { ok: false, code: 'UNTRUSTED_SENDER', message: '请求来源不受信任' };
    }
    return handler(payload, event);
  };

  const openProjectHandler = withSenderCheck(async (payload) => {
    try {
      const result = await openPreviewProject(payload, {
        shell,
        fs: fsOverride,
        path: pathOverride,
      });
      return result;
    } catch (error) {
      return {
        ok: false,
        code: 'PATH_INVALID',
        message: `打开工程目录失败：${(error && error.message) || '未知错误'}`,
        details: { code: PREVIEW_ERROR_CODES.pathInvalid },
      };
    }
  });

  const pickScreenshotHandler = withSenderCheck(async () => {
    if (!dialog || typeof dialog.showOpenDialog !== 'function') {
      return {
        cancelled: true,
        ok: false,
        code: PREVIEW_ERROR_CODES.screenshotCancelled,
        message: '当前环境不支持选择截图',
      };
    }

    let selection;
    try {
      selection = await dialog.showOpenDialog({
        title: '选择微信开发者工具的真实渲染截图',
        buttonLabel: '选择截图',
        properties: ['openFile'],
        filters: PREVIEW_SCREENSHOT_FILTERS.map((filter) => ({
          name: filter.name,
          extensions: filter.extensions.slice(),
        })),
      });
    } catch (error) {
      return {
        cancelled: false,
        ok: false,
        code: PREVIEW_ERROR_CODES.screenshotInvalid,
        message: `打开选择框失败：${(error && error.message) || '未知错误'}`,
      };
    }

    const filePath = selection && !selection.canceled && Array.isArray(selection.filePaths)
      ? selection.filePaths[0]
      : null;
    if (!filePath) {
      return {
        cancelled: true,
        ok: false,
        code: PREVIEW_ERROR_CODES.screenshotCancelled,
        message: '已取消选择截图',
      };
    }

    const validated = await validateScreenshotFile(filePath, {
      fs: fsOverride,
      path: pathOverride,
    });
    if (!validated.ok) {
      return {
        cancelled: false,
        ok: false,
        code: validated.code,
        message: validated.message,
      };
    }

    const { ok, cancelled, ...rest } = validated;
    return {
      cancelled: false,
      ok: true,
      path: rest.path,
      name: rest.name,
      dataUrl: rest.dataUrl,
      bytes: rest.bytes,
      mime: rest.mime,
    };
  });

  ipcMain.handle(PREVIEW_CHANNELS.openProject, openProjectHandler);
  ipcMain.handle(PREVIEW_CHANNELS.pickScreenshot, pickScreenshotHandler);

  return {
    handlers: {
      [PREVIEW_CHANNELS.openProject]: openProjectHandler,
      [PREVIEW_CHANNELS.pickScreenshot]: pickScreenshotHandler,
    },
  };
}

module.exports = {
  PREVIEW_CONTRACT,
  PREVIEW_CHANNELS,
  PREVIEW_BRIDGE_METHODS,
  PREVIEW_ERROR_CODES,
  PREVIEW_CONTRACT_CODES,
  PREVIEW_MAX_PATH_LENGTH,
  PREVIEW_MAX_SCREENSHOT_BYTES,
  PREVIEW_SCREENSHOT_MIME_TYPES,
  PREVIEW_SCREENSHOT_EXTENSIONS,
  PREVIEW_SCREENSHOT_FILTERS,
  toContractCode,
  detectImageMime,
  validateProjectPath,
  validateScreenshotFile,
  openPreviewProject,
  registerPreviewIpc,
};