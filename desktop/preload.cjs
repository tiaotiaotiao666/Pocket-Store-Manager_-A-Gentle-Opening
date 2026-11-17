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
  readAsset: (payload) => ipcRenderer.invoke('project:read-asset', payload),
  removeAsset: (payload) => ipcRenderer.invoke('project:remove-asset', payload),
  settingsLoad: () => ipcRenderer.invoke('settings:load'),
  settingsSave: (payload) => ipcRenderer.invoke('settings:save', payload),
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
}));