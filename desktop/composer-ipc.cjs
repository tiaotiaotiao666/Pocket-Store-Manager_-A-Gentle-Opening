'use strict';

/**
 * Composer IPC（Electron 主进程）。
 *
 * 安全边界：
 * - 只接受 file:// 或 http://127.0.0.1:5173 来源。
 * - 只允许导出到用户经系统对话框确认过的父目录。
 * - 主进程重新执行 P0–P2 校验，不信任渲染进程。
 * - 单任务串行，第二次返回 EXPORT_BUSY。
 */

const fs = require('node:fs');
const path = require('node:path');

const { applyAppid } = require('./appid-postprocess.cjs');
const { sanitizeProjectName, suggestName } = require('../scripts/composer/atomic.cjs');

const MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_PLAN_BYTES = 64 * 1024;
const TRUSTED_URL = /^(file:\/\/|http:\/\/127\.0\.0\.1:5173\/)/;

function isTrustedSender(event) {
  const frame = event && event.senderFrame;
  const url = frame && frame.url;
  return typeof url === 'string' && TRUSTED_URL.test(url);
}

function payloadSize(payload) {
  try {
    return Buffer.byteLength(JSON.stringify(payload), 'utf8');
  } catch (error) {
    return Number.MAX_SAFE_INTEGER;
  }
}

function createComposerIpc(options) {
  const opts = options || {};
  const dialog = opts.dialog;
  const shell = opts.shell;
  const compose = opts.compose;
  const validateComposition = opts.validateComposition;
  const approvedParents = new Set();
  const exportedOutputs = new Set();
  let active = null;

  // 应用内「预览新模块」专用目录：不需要每次弹系统对话框选位置。
  const PREVIEW_PARENT_TOKEN = '__preview__';
  const previewParentDir = typeof opts.previewParentDir === 'string' && opts.previewParentDir.trim()
    ? path.resolve(opts.previewParentDir)
    : null;
  if (previewParentDir) {
    try {
      fs.mkdirSync(previewParentDir, { recursive: true });
    } catch (error) {
      /* 目录创建失败时仍让后续流程给出明确错误 */
    }
    approvedParents.add(previewParentDir);
  }

  function resultError(code, message, details) {
    return { ok: false, code, message, details: details || null };
  }

  async function chooseDirectory() {
    const picked = await dialog.showOpenDialog({
      title: '选择小程序工程的保存位置',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: '选择此目录',
    });
    if (picked.canceled || !picked.filePaths[0]) return { cancelled: true };
    const resolved = path.resolve(picked.filePaths[0]);
    approvedParents.add(resolved);
    return { cancelled: false, path: resolved };
  }

  async function validate(event, payload) {
    if (payloadSize(payload) > MAX_PAYLOAD_BYTES) return resultError('PAYLOAD_TOO_LARGE', '配置内容超过 256 KB');
    if (payloadSize(payload && payload.plan) > MAX_PLAN_BYTES) return resultError('PAYLOAD_TOO_LARGE', 'Plan 超过 64 KB');
    const role = payload && payload.role;
    const result = role === undefined
      ? validateComposition(payload && payload.plan)
      : validateComposition(payload && payload.plan, { role });
    return result;
  }

  async function exportProject(event, payload) {
    if (active) return resultError('EXPORT_BUSY', '已有导出任务正在运行');
    if (payloadSize(payload) > MAX_PAYLOAD_BYTES) return resultError('PAYLOAD_TOO_LARGE', '配置内容超过 256 KB');
    if (payloadSize(payload && payload.plan) > MAX_PLAN_BYTES) return resultError('PAYLOAD_TOO_LARGE', 'Plan 超过 64 KB');
    const requestedParent = payload && payload.parentDir === PREVIEW_PARENT_TOKEN
      ? previewParentDir
      : (payload && payload.parentDir);
    if (typeof requestedParent !== 'string' || !requestedParent) {
      return resultError('TARGET_PARENT_MISSING', '未选择导出位置');
    }
    const parentDir = path.resolve(requestedParent);
    if (!approvedParents.has(parentDir)) {
      return resultError('TARGET_NOT_WRITABLE', '导出位置未经系统对话框确认');
    }

    const taskId = (payload.taskId && String(payload.taskId)) || 'task-' + Date.now();
    const signal = { cancelled: false };
    active = { taskId, signal, startedAt: Date.now() };
    let lastProgressAt = 0;

    try {
      const result = await compose({
        plan: payload.plan,
        parentDir,
        projectName: payload.projectName,
        mode: payload.mode,
        storeId: payload.storeId,
        backendVersions: payload.backendVersions,
        ...(payload.role === undefined ? {} : { role: payload.role }),
        signal,
        onProgress: (progress) => {
          const now = Date.now();
          if (now - lastProgressAt < 200 && progress.fileIndex !== progress.fileTotal) return;
          lastProgressAt = now;
          try {
            event.sender.send('composer:progress', { taskId, ...progress });
          } catch (error) {
            /* 窗口已关闭时忽略进度发送失败 */
          }
        },
      });
      if (result && result.ok) {
        exportedOutputs.add(result.outputPath);
        return result;
      }
      return result;
    } finally {
      active = null;
    }
  }

  async function cancel() {
    if (!active) return { ok: false, code: 'NO_ACTIVE_TASK', message: '当前没有可取消的导出任务' };
    active.signal.cancelled = true;
    return { ok: true, taskId: active.taskId };
  }

  /**
   * 只读目标预检：判断 parentDir + projectName 是否已存在同名工程。
   *
   * 约束：
   * - 不创建父目录、目标目录、staging、probe 或报告，不调用 compose。
   * - 名称清洗与 Composer 使用同一实现，避免两处规则不一致。
   * - 冲突用 exists 表达，不混同于 IPC 传输失败。
   */
  async function preflightTarget(event, payload) {
    if (payloadSize(payload) > MAX_PAYLOAD_BYTES) {
      return resultError('PAYLOAD_TOO_LARGE', '配置内容超过 256 KB');
    }
    if (!payload || typeof payload.parentDir !== 'string' || !payload.parentDir.trim()) {
      return resultError('TARGET_PARENT_MISSING', '未选择导出位置');
    }
    let parentDir;
    try {
      parentDir = path.resolve(payload.parentDir);
    } catch (error) {
      return resultError('TARGET_PATH_INVALID', '导出位置路径不合法');
    }

    let stat;
    try {
      stat = fs.statSync(parentDir);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return resultError('TARGET_PARENT_MISSING', '导出位置不存在，请重新选择目录');
      }
      return resultError('TARGET_CHECK_FAILED', '无法检查导出位置：' + (error.code || error.message));
    }
    if (!stat.isDirectory()) {
      return resultError('TARGET_PARENT_MISSING', '导出位置不是目录，请重新选择');
    }

    const projectName = sanitizeProjectName(payload.projectName);
    const finalPath = path.join(parentDir, projectName);
    const relative = path.relative(parentDir, finalPath);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
      return resultError('TARGET_PATH_INVALID', '项目名非法，不能跳出导出位置');
    }

    let exists;
    try {
      exists = fs.existsSync(finalPath);
    } catch (error) {
      return resultError('TARGET_CHECK_FAILED', '无法检查目标目录：' + (error.code || error.message));
    }

    return {
      ok: true,
      exists: Boolean(exists),
      projectName,
      suggestedName: exists ? suggestName(parentDir, projectName) : null,
    };
  }

  async function readReport(event, payload) {
    const outputPath = payload && payload.outputPath ? path.resolve(payload.outputPath) : '';
    if (!outputPath || !exportedOutputs.has(outputPath)) {
      return resultError('TARGET_NOT_WRITABLE', '只能读取本次已导出的工程');
    }
    const reportFile = path.join(outputPath, 'generation-report.json');
    const lockFile = path.join(outputPath, 'composition.lock.json');
    if (!fs.existsSync(reportFile)) return resultError('REPORT_MISSING', '未找到生成报告');
    try {
      return {
        ok: true,
        report: JSON.parse(fs.readFileSync(reportFile, 'utf8')),
        lock: fs.existsSync(lockFile) ? JSON.parse(fs.readFileSync(lockFile, 'utf8')) : null,
      };
    } catch (error) {
      return resultError('REPORT_INVALID', '生成报告无法解析：' + error.message);
    }
  }

  /**
   * AppID 后置写入：只允许本次会话导出的工程，改写后按清单口径回填 lock/report。
   * 真正的回滚与 A1–A8 自检在 appid-postprocess.cjs 内完成。
   */
  async function applyAppidHandler(event, payload) {
    const outputPath = payload && payload.outputPath ? path.resolve(payload.outputPath) : '';
    if (!outputPath || !exportedOutputs.has(outputPath)) {
      return resultError('TARGET_NOT_WRITABLE', '只能写入本次已导出的工程');
    }
    const appid = payload && typeof payload.appid === 'string' ? payload.appid.trim().toLowerCase() : '';
    if (!/^wx[0-9a-f]{16}$/.test(appid)) {
      return resultError('APPID_INVALID', 'AppID 格式不正确（wx + 16 位十六进制）');
    }
    try {
      const result = applyAppid({ outputPath, appid });
      return { ok: true, ...result };
    } catch (error) {
      return resultError(error.code || 'APPID_WRITE_FAILED', error.message || 'AppID 写入失败', error.details);
    }
  }

  return {
    approvedParents,
    exportedOutputs,
    getActive: () => active,
    handlers: {
      'composer:choose-directory': chooseDirectory,
      'composer:validate': validate,
      'composer:preflight-target': preflightTarget,
      'composer:export': exportProject,
      'composer:cancel': cancel,
      'composer:read-report': readReport,
      'composer:apply-appid': applyAppidHandler,
    },
  };
}

function registerComposerIpc(ipcMain, options) {
  const created = createComposerIpc(options);
  Object.entries(created.handlers).forEach(([channel, handler]) => {
    ipcMain.handle(channel, async (event, payload) => {
      if (!isTrustedSender(event)) {
        return { ok: false, code: 'UNTRUSTED_SENDER', message: '请求来源不受信任' };
      }
      return handler(event, payload);
    });
  });
  return created;
}

module.exports = {
  createComposerIpc,
  registerComposerIpc,
  isTrustedSender,
  MAX_PAYLOAD_BYTES,
  MAX_PLAN_BYTES,
};