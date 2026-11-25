const { contextBridge, ipcRenderer } = require('electron');

const composerProgressListeners = new Set();
ipcRenderer.on('composer:progress', (_event, payload) => {
  composerProgressListeners.forEach((listener) => {
    try {
      listener(payload);
    } catch (error) {
      /* 单个监听器失败不影响其他监听器 */
    }
  });
});

const flushRequestListeners = new Set();
ipcRenderer.on('project:flush-request', () => {
  flushRequestListeners.forEach((listener) => {
    try {
      listener();
    } catch (error) {
      /* 单个监听器失败不影响其他监听器 */
    }
  });
});

// P4：候选前端进度（主进程只推有界阶段信息，不含路径/源码/base64）。
const frontendProgressListeners = new Set();
ipcRenderer.on('frontend:progress', (_event, payload) => {
  frontendProgressListeners.forEach((listener) => {
    try {
      listener(payload);
    } catch (error) {
      /* 单个监听器失败不影响其他监听器 */
    }
  });
});

// B3：Workspace Agent 进度（payload 只含 projectId/runId/turnId/attemptId/phase/stage/status/at/message）。
const workspaceAgentProgressListeners = new Set();
ipcRenderer.on('agent:progress', (_event, payload) => {
  workspaceAgentProgressListeners.forEach((listener) => {
    try {
      listener(payload);
    } catch (error) {
      /* 单个监听器失败不影响其他监听器 */
    }
  });
});

/**
 * B3/E0：Workspace Agent 唯一受控命名空间。
 * 原 19 个语义命令 + `adoptAttempt` + 平台创建/查询 attempt 的 `runTurn/getAttempt` + onProgress；
 * 渲染进程拿不到 channel 字符串、目录或通用 fs。
 */
const workspaceAgent = Object.freeze({
  runTurn: (payload) => ipcRenderer.invoke('agent:run-turn', payload),
  getAttempt: (payload) => ipcRenderer.invoke('agent:get-attempt', payload),
  getContext: (payload) => ipcRenderer.invoke('agent:get-context', payload),
  listFiles: (payload) => ipcRenderer.invoke('agent:list-files', payload),
  readFile: (payload) => ipcRenderer.invoke('agent:read-file', payload),
  searchFiles: (payload) => ipcRenderer.invoke('agent:search-files', payload),
  writeFiles: (payload) => ipcRenderer.invoke('agent:write-files', payload),
  deleteFiles: (payload) => ipcRenderer.invoke('agent:delete-files', payload),
  addImageAsset: (payload) => ipcRenderer.invoke('agent:add-image-asset', payload),
  getDiff: (payload) => ipcRenderer.invoke('agent:get-diff', payload),
  runCheck: (payload) => ipcRenderer.invoke('agent:run-check', payload),
  verifyWechat: (payload) => ipcRenderer.invoke('agent:verify-wechat', payload),
  readVerification: (payload) => ipcRenderer.invoke('agent:read-verification', payload),
  readArtifact: (payload) => ipcRenderer.invoke('agent:read-artifact', payload),
  submitCandidate: (payload) => ipcRenderer.invoke('agent:submit-candidate', payload),
  // rev15 §3.2/§14.5：采用已提交候选（B2 adoptAttempt，经 Coordinator 校验证据）。
  adoptAttempt: (payload) => ipcRenderer.invoke('agent:adopt-attempt', payload),
  versions: (payload) => ipcRenderer.invoke('agent:versions', payload),
  adoptVersion: (payload) => ipcRenderer.invoke('agent:adopt-version', payload),
  undo: (payload) => ipcRenderer.invoke('agent:undo', payload),
  redo: (payload) => ipcRenderer.invoke('agent:redo', payload),
  reopen: (payload) => ipcRenderer.invoke('agent:reopen', payload),
  cancelRun: (payload) => ipcRenderer.invoke('agent:cancel-run', payload),
  onProgress: (listener) => {
    if (typeof listener !== 'function') return () => {};
    workspaceAgentProgressListeners.add(listener);
    return () => workspaceAgentProgressListeners.delete(listener);
  },
});

contextBridge.exposeInMainWorld('smartStore', Object.freeze({
  isDesktop: true,
  chooseExportDirectory: () => ipcRenderer.invoke('composer:choose-directory'),
  defaultExportDirectory: () => ipcRenderer.invoke('composer:default-target'),
  composerValidate: (payload) => ipcRenderer.invoke('composer:validate', payload),
  composerPreflightTarget: (payload) => ipcRenderer.invoke('composer:preflight-target', payload),
  composerExport: (payload) => ipcRenderer.invoke('composer:export', payload),
  composerCancel: (payload) => ipcRenderer.invoke('composer:cancel', payload),
  composerReadReport: (payload) => ipcRenderer.invoke('composer:read-report', payload),
  onComposerProgress: (listener) => {
    if (typeof listener !== 'function') return () => {};
    composerProgressListeners.add(listener);
    return () => composerProgressListeners.delete(listener);
  },
  // @deprecated 旧入口保留一个版本，转发到 composer:export（旧 payload 会得到可读参数错误，不会写文件）
  exportProject: (payload) => ipcRenderer.invoke('composer:export', payload),
  pickMaterials: () => ipcRenderer.invoke('generator:pick-materials'),
  openPath: (target) => ipcRenderer.invoke('generator:open-path', target),
  // W4：对话外链的唯一出口（仅 http/https，主进程再校验一次后用系统浏览器打开）。
  openExternalLink: (url) => ipcRenderer.invoke('shell:open-external', { url }),
  saveImage: (payload) => ipcRenderer.invoke('generator:save-image', payload),

  // 项目与设置（P0）
  projectList: () => ipcRenderer.invoke('project:list'),
  projectCreate: (payload) => ipcRenderer.invoke('project:create', payload),
  projectLoad: (payload) => ipcRenderer.invoke('project:load', payload),
  projectSave: (payload) => ipcRenderer.invoke('project:save', payload),
  projectDelete: (payload) => ipcRenderer.invoke('project:delete', payload),
  projectReveal: (payload) => ipcRenderer.invoke('project:reveal', payload),
  pickImages: (payload) => ipcRenderer.invoke('project:pick-images', payload),
  attachImages: (payload) => ipcRenderer.invoke('project:attach-images', payload),
  attachImageData: (payload) => ipcRenderer.invoke('project:attach-image-data', payload),
  saveGeneratedImage: (payload) => ipcRenderer.invoke('project:save-generated-image', payload),
  readAsset: (payload) => ipcRenderer.invoke('project:read-asset', payload),
  removeAsset: (payload) => ipcRenderer.invoke('project:remove-asset', payload),
  settingsLoad: () => ipcRenderer.invoke('settings:load'),
  settingsSave: (payload) => ipcRenderer.invoke('settings:save', payload),
  // 模型与 API：Key 只在主进程加密保存，这里只暴露状态/保存/清除与受控调用。
  modelKeyStatus: () => ipcRenderer.invoke('settings:model-key:status'),
  modelKeySave: (payload) => ipcRenderer.invoke('settings:model-key:save', payload),
  modelKeyClear: () => ipcRenderer.invoke('settings:model-key:clear'),
  modelTest: (payload) => ipcRenderer.invoke('settings:model:test', payload),
  modelChat: (payload) => ipcRenderer.invoke('settings:model:chat', payload),
  openDataDirectory: () => ipcRenderer.invoke('settings:reveal-data-dir'),
  diagnosticsRun: (payload) => ipcRenderer.invoke('diagnostics:run', payload),
  diagnosticsSaveSnapshot: (payload) => ipcRenderer.invoke('diagnostics:save-snapshot', payload),
  applyAppid: (payload) => ipcRenderer.invoke('composer:apply-appid', payload),
  probeDevtools: () => ipcRenderer.invoke('devtools:probe'),

  // 真实渲染截图回传（C-REAL-PREVIEW@1）
  // 只打开已导出工程目录 / 读取本地截图；不上传、不写入导出工程。
  openPreviewProject: (payload) => ipcRenderer.invoke('preview:open-project', payload),
  pickPreviewScreenshot: () => ipcRenderer.invoke('preview:pick-screenshot'),
  openPreviewDevtools: (payload) => ipcRenderer.invoke('preview:open-devtools', payload),
  onProjectFlushRequest: (listener) => {
    if (typeof listener !== 'function') return () => {};
    flushRequestListeners.add(listener);
    return () => flushRequestListeners.delete(listener);
  },
  reportFlushDone: () => ipcRenderer.invoke('project:flush-done'),

  // P4：图片驱动前端重构（受控候选前端）。
  // 只暴露 8 个语义 API，全部由主进程重新校验来源/上限/工作区归属；
  // 这里不提供任何通用 read/write/exec/spawn 通道。
  analyzeFrontend: (payload) => ipcRenderer.invoke('frontend:analyze', payload),
  buildCandidate: (payload) => ipcRenderer.invoke('frontend:build-candidate', payload),
  validateCandidate: (payload) => ipcRenderer.invoke('frontend:validate-candidate', payload),
  verifyCandidate: (payload) => ipcRenderer.invoke('frontend:verify-candidate', payload),
  adoptCandidate: (payload) => ipcRenderer.invoke('frontend:adopt-candidate', payload),
  discardCandidate: (payload) => ipcRenderer.invoke('frontend:discard-candidate', payload),
  cancelFrontendRun: (payload) => ipcRenderer.invoke('frontend:cancel-run', payload),
  onFrontendProgress: (listener) => {
    if (typeof listener !== 'function') return () => {};
    frontendProgressListeners.add(listener);
    return () => frontendProgressListeners.delete(listener);
  },

  // B3：Workspace Agent（版本/读改验/diff/检查/证据）唯一出口。
  workspaceAgent,
}));