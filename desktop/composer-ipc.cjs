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
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { applyAppid } = require('./appid-postprocess.cjs');
const { sanitizeProjectName, suggestName } = require('../scripts/composer/atomic.cjs');

const APP_ROOT = path.join(__dirname, '..');
const COMPOSER_CLI = path.join(APP_ROOT, 'scripts', 'composer', 'cli.cjs');

/**
 * 用 node 子进程跑 Composer CLI（--json 输出）。
 *
 * 只在主进程提交目录失败时兜底：同一个 Composer、同一套门禁，只是换一个
 * 能拿到「目录改名」权限的进程。计划与版本信息落临时文件，跑完即删。
 */
function composeInNode(options, tempRoot) {
  return new Promise((resolve) => {
    let tmpDir;
    try {
      const baseTmp = tempRoot || os.tmpdir();
      fs.mkdirSync(baseTmp, { recursive: true });
      tmpDir = fs.mkdtempSync(path.join(baseTmp, 'smartstore-compose-'));
    } catch (error) {
      console.warn('[composer] 子进程临时目录创建失败 code=' + (error && error.code) + ' message=' + (error && error.message));
      resolve({ ok: false, code: 'COMPOSE_FAILED', message: '临时目录创建失败' });
      return;
    }
    const cleanup = () => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (error) { /* 清理失败不影响结论 */ }
    };
    let child;
    let outFd = null;
    const outFile = path.join(tmpDir, 'compose-output.txt');
    try {
      const planFile = path.join(tmpDir, 'plan.json');
      fs.writeFileSync(planFile, JSON.stringify(options.plan), 'utf8');
      const args = [COMPOSER_CLI, '--plan', planFile, '--out', options.parentDir, '--mode', options.mode || 'development', '--json'];
      if (options.projectName) args.push('--project-name', options.projectName);
      if (options.storeId) args.push('--store-id', options.storeId);
      if (options.role) args.push('--role', options.role);
      if (options.backendVersions) {
        const versionsFile = path.join(tmpDir, 'backend-versions.json');
        fs.writeFileSync(versionsFile, JSON.stringify(options.backendVersions), 'utf8');
        args.push('--backend-versions', versionsFile);
      }
      // 用文件而不是管道接子进程输出：受限环境下管道 stdio 会直接 EPERM。
      outFd = fs.openSync(outFile, 'w');
      child = spawn(process.execPath, args, {
        cwd: APP_ROOT,
        // 让 electron.exe 以纯 node 方式运行，避免再次继承主进程的限制。
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', outFd, outFd],
        windowsHide: true,
      });
    } catch (error) {
      if (outFd !== null) { try { fs.closeSync(outFd); } catch (closeError) { /* ignore */ } }
      console.warn('[composer] 子进程准备失败 code=' + (error && error.code) + ' message=' + (error && error.message));
      cleanup();
      resolve({ ok: false, code: 'COMPOSE_FAILED', message: error.message });
      return;
    }
    child.on('error', (error) => {
      if (outFd !== null) { try { fs.closeSync(outFd); outFd = null; } catch (closeError) { /* ignore */ } }
      console.warn('[composer] 子进程启动失败 code=' + (error && error.code) + ' message=' + (error && error.message));
      cleanup();
      resolve({ ok: false, code: 'COMPOSE_FAILED', message: error.message });
    });
    child.on('close', (code) => {
      if (outFd !== null) { try { fs.closeSync(outFd); outFd = null; } catch (closeError) { /* ignore */ } }
      let text = '';
      try { text = fs.readFileSync(outFile, 'utf8'); } catch (error) { /* 读不到就走兜底 */ }
      cleanup();
      const start = text.lastIndexOf('{');
      if (start >= 0) {
        try {
          const parsed = JSON.parse(text.slice(start));
          if (!parsed || parsed.ok !== true) {
            console.warn('[composer] 子进程返回失败 code=' + (parsed && parsed.code) + ' message=' + (parsed && parsed.message));
          }
          resolve(parsed);
          return;
        } catch (error) { /* 落到下面的兜底 */ }
      }
      const tail = text.trim().split('\n').filter(Boolean).slice(-6).join(' / ');
      console.warn('[composer] 子进程退出 code=' + code + ' output=' + tail);
      resolve({ ok: false, code: 'COMPOSE_FAILED', message: tail.split(' / ').slice(-1)[0] || '生成失败' });
    });
  });
}

const MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_PLAN_BYTES = 64 * 1024;
const TRUSTED_URL = /^(file:\/\/|http:\/\/127\.0\.0\.1:5173\/)/;

/**
 * UX0b：渲染进程不得把媒体内容本身（dataUrl / Buffer / 路径）塞进导出请求，
 * 只能传项目内的资产引用，真实字节由主进程读取。
 */
const FORBIDDEN_MEDIA_KEYS = Object.freeze([
  'media',
  'mediaBytes',
  'dataUrl',
  'imageDataUrl',
  'assetPath',
  'absolutePath',
  'filePath',
  'posterPath',
]);

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
  // UX0b：受控媒体解析器由 main 注入；渲染进程只能传项目 ID + 海报资产 ID。
  const resolveMedia = typeof opts.resolveMedia === 'function' ? opts.resolveMedia : null;
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

  // P5c：界面内可见、可确认的默认导出位置。
  // 由主进程自己决定并预先批准，渲染进程只能引用这个 token，
  // 仍然拿不到「任意路径直接写盘」的能力；原生「选择目录」对话框照旧保留。
  const DEFAULT_PARENT_TOKEN = '__default__';
  const defaultParentDir = typeof opts.defaultParentDir === 'string' && opts.defaultParentDir.trim()
    ? path.resolve(opts.defaultParentDir)
    : null;
  let defaultParentReady = false;
  if (defaultParentDir) {
    try {
      fs.mkdirSync(defaultParentDir, { recursive: true });
      defaultParentReady = true;
    } catch (error) {
      // 目录建不出来时不预先批准；界面会提示用户改用手动选择，而不是给一个坏按钮。
      console.warn('[composer] 默认导出位置创建失败 code=' + (error && error.code));
    }
    if (defaultParentReady) approvedParents.add(defaultParentDir);
  }

  // 目录改名被系统拒绝时的整段重试间隔（ms）；测试可注入更短的值。
  const commitRetryDelays = Array.isArray(opts.commitRetryDelays) && opts.commitRetryDelays.length > 0
    ? opts.commitRetryDelays.map((ms) => (Number.isFinite(ms) && ms >= 0 ? ms : 0))
    : [500, 1500];

  // 主进程目录改名被系统拒绝时，允许改用 node 子进程跑同一个 Composer CLI。
  const enableCommitFallback = opts.enableCommitFallback !== false;
  // 子进程临时目录：系统 %TEMP% 在这台机器上对 Electron 不可写，交给主进程指定。
  const composeTempRoot = typeof opts.composeTempRoot === 'string' && opts.composeTempRoot.trim()
    ? opts.composeTempRoot
    : '';
  const runComposeInNode = typeof opts.composeInNode === 'function'
    ? opts.composeInNode
    : (options) => composeInNode(options, composeTempRoot);

  function resolveParentToken(value) {    if (value === PREVIEW_PARENT_TOKEN) return previewParentDir;
    if (value === DEFAULT_PARENT_TOKEN) return defaultParentDir;
    return value;
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
    const requestedParent = resolveParentToken(payload && payload.parentDir);
    const forbiddenKeys = FORBIDDEN_MEDIA_KEYS
      .filter((key) => payload && Object.prototype.hasOwnProperty.call(payload, key));
    if (forbiddenKeys.length > 0) {
      return resultError('MEDIA_REQUEST_INVALID', '不接受渲染进程直接传入媒体内容，请传入项目内的海报资产引用');
    }
    if (typeof requestedParent !== 'string' || !requestedParent) {
      return resultError('TARGET_PARENT_MISSING', '未选择导出位置');
    }
    // 默认位置的目录如果没准备好，直接给出可操作提示，而不是含混的「未经确认」。
    if (payload && payload.parentDir === DEFAULT_PARENT_TOKEN && !defaultParentReady) {
      return resultError('TARGET_PARENT_MISSING', '这台电脑没能准备默认导出位置，请选择其他目录');
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
      // UX0b：海报素材只按受控引用在主进程解析；缺图、越权、篡改、格式不符一律阻断本次导出。
      const posterAssetId = (payload && (payload.posterAssetId || payload.imageAssetId)) || null;
      let resolvedMedia = null;
      if (posterAssetId && !resolveMedia) {
        return resultError('MEDIA_RESOLVER_MISSING', '主进程未配置媒体解析器，已阻断本次导出');
      }
      if (resolveMedia) {
        let resolved;
        try {
          resolved = await resolveMedia({
            projectId: (payload && payload.projectId) || '',
            posterAssetId,
          });
        } catch (error) {
          return resultError('MEDIA_ASSET_READ_FAILED', '海报素材读取失败');
        }
        if (!resolved || resolved.ok === false) {
          return resultError(
            (resolved && resolved.code) || 'MEDIA_INVALID',
            (resolved && resolved.message) || '海报素材校验失败',
          );
        }
        resolvedMedia = resolved;
      }
      const media = resolvedMedia && resolvedMedia.media ? resolvedMedia.media : undefined;
      const poster = resolvedMedia ? (resolvedMedia.poster || { included: Boolean(media) }) : null;

      const composeOnce = () => compose({
        plan: payload.plan,
        parentDir,
        projectName: payload.projectName,
        mode: payload.mode,
        storeId: payload.storeId,
        backendVersions: payload.backendVersions,
        ...(payload.role === undefined ? {} : { role: payload.role }),
        ...(media ? { media } : {}),
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

      // COMMIT_FAILED = staging 目录改名被系统拒绝（杀软/索引器短暂占用）。
      // 实测同一位置在同一台机器上会随机成功/失败，所以按递增间隔整段重试；
      // 这里不放松任何校验，只是把「偶发」和「真的不行」区分开。
      let result = await composeOnce();
      for (const delay of commitRetryDelays) {
        if (!result || result.ok === true || result.code !== 'COMMIT_FAILED' || signal.cancelled) break;
        console.warn('[composer] COMMIT_FAILED，' + delay + 'ms 后整段重试');
        await new Promise((resolve) => setTimeout(resolve, delay));
        if (signal.cancelled) break;
        result = await composeOnce();
      }
      if (result && result.ok !== true && result.code === 'COMMIT_FAILED') {
        // 主进程里 staging 目录改名被系统拒绝（本机 Electron 主进程对目录改名
        // 存在 EPERM 的已知环境问题，同目录下 node 进程正常）。此时交给 node
        // 子进程跑同一个 Composer CLI：校验、门禁、产物都与主进程路径一致，
        // 只是换了一个能拿到目录改名权限的进程。
        if (enableCommitFallback && !media) {
          console.warn('[composer] 主进程提交失败，改用 node 子进程重跑 Composer');
          const fallback = await runComposeInNode({
            plan: payload.plan,
            parentDir,
            projectName: payload.projectName,
            mode: payload.mode,
            storeId: payload.storeId,
            backendVersions: payload.backendVersions,
            role: payload.role,
          });
          if (fallback && fallback.ok) {
            console.warn('[composer] node 子进程导出成功 path=' + fallback.outputPath);
            result = fallback;
          } else {
            console.warn('[composer] node 子进程导出仍失败 code=' + (fallback && fallback.code));
            result = fallback || result;
          }
        } else {
          console.warn('[composer] 多次重试仍 COMMIT_FAILED，请换一个导出位置');
        }
      }
      if (result && result.ok) {
        exportedOutputs.add(result.outputPath);
        // 海报结论来自主进程实际解析结果，不由渲染进程声称。
        return poster === null ? result : { ...result, poster };
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
      parentDir = path.resolve(resolveParentToken(payload.parentDir) || '');
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

  /**
   * P5c：界面要能在导出前把目标位置显示给用户。
   * 只回路径（不含任何写盘动作），权限边界仍是「主进程已批准的父目录」。
   */
  async function defaultTarget() {
    if (!defaultParentDir || !defaultParentReady) {
      return resultError(
        'TARGET_PARENT_MISSING',
        '这台电脑没能准备默认导出位置，请点「选择其他目录」自己指定一个',
      );
    }
    return { ok: true, path: defaultParentDir, token: DEFAULT_PARENT_TOKEN };
  }

  return {
    approvedParents,
    exportedOutputs,
    getActive: () => active,
    handlers: {
      'composer:choose-directory': chooseDirectory,
      'composer:default-target': defaultTarget,
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
  FORBIDDEN_MEDIA_KEYS,
};