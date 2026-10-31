const { app, BrowserWindow, dialog, ipcMain, shell, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');

const composer = require('../scripts/composer/index.cjs');
const { registerComposerIpc } = require('./composer-ipc.cjs');
const { createProjectStore } = require('./project-store.cjs');
const { createAssetStore } = require('./asset-store.cjs');
const { createSettingsStore } = require('./settings-store.cjs');
const { registerProjectIpc } = require('./project-ipc.cjs');
const { registerFlushGuard, recoverPendingWrites } = require('./flush-guard.cjs');
const { createDiagnostics } = require('./diagnostics.cjs');
const { probeDevtools } = require('./devtools-probe.cjs');

const userDataDir = app.getPath('userData');

const imageAdapter = {
  resize(buffer, maxWidth) {
    try {
      const image = nativeImage.createFromBuffer(buffer);
      if (image.isEmpty()) return null;
      const size = image.getSize();
      if (!size.width || size.width <= maxWidth) return { buffer };
      const resized = image.resize({ width: maxWidth, quality: 'good' });
      const output = resized.toJPEG(82);
      return output.length > 0 ? { buffer: output, mime: 'image/jpeg' } : null;
    } catch (error) {
      return null;
    }
  },
};

const projectStore = createProjectStore({ userDataDir });
const assetStore = createAssetStore({ userDataDir, imageAdapter });
const settingsStore = createSettingsStore({ userDataDir });
const diagnostics = createDiagnostics({
  userDataDir,
  runtime: {
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
  },
});

function createWindow() {
  const window = new BrowserWindow({
    width: 1480,
    height: 960,
    minWidth: 1120,
    minHeight: 740,
    title: '智能开店 · 独立小程序生成器',
    backgroundColor: '#f6f5f1',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (app.isPackaged) window.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  else window.loadURL('http://127.0.0.1:5173');
}

registerComposerIpc(ipcMain, {
  dialog,
  shell,
  compose: composer.compose,
  validateComposition: composer.validateComposition,
});

registerProjectIpc(ipcMain, {
  store: projectStore,
  assets: assetStore,
  settings: settingsStore,
  diagnostics,
  probeDevtools,
  dialog,
  shell,
});

registerFlushGuard({
  app,
  ipcMain,
  getWindows: () => BrowserWindow.getAllWindows(),
  timeoutMs: 3000,
});

ipcMain.handle('generator:pick-materials', async () => {
  const result = await dialog.showOpenDialog({
    title: '选择门店图片作为 AI 风格参考',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
  });
  if (result.canceled) return [];
  const allowedExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp']);
  const files = await Promise.all(result.filePaths.slice(0, 6).map(async (filePath) => {
    const extension = path.extname(filePath).toLowerCase();
    if (!allowedExtensions.has(extension)) return null;
    const stat = await fs.stat(filePath);
    if (stat.size > 10 * 1024 * 1024) return null;
    const mime = extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : `image/${extension.slice(1)}`;
    return { name: path.basename(filePath), previewUrl: pathToFileURL(filePath).href, dataUrl: `data:${mime};base64,${(await fs.readFile(filePath)).toString('base64')}` };
  }));
  return files.filter(Boolean);
});

ipcMain.handle('generator:open-path', async (_event, target) => {
  if (typeof target !== 'string' || target.length > 1200) return { error: '路径无效' };
  return shell.openPath(path.resolve(target));
});

ipcMain.handle('generator:save-image', async (_event, payload) => {
  const result = await dialog.showSaveDialog({
    title: '保存生成的页面图标',
    defaultPath: `${String(payload.name || 'page-icon').replace(/[\\/:*?"<>|]/g, '-')}.png`,
    filters: [{ name: 'PNG 图片', extensions: ['png'] }],
  });
  if (result.canceled || !result.filePath) return { cancelled: true };
  if (typeof payload.dataUrl !== 'string' || !/^data:image\/(png|webp|jpeg);base64,/i.test(payload.dataUrl)) return { error: '图片数据格式无效' };
  const buffer = Buffer.from(payload.dataUrl.replace(/^data:image\/[^;]+;base64,/i, ''), 'base64');
  if (buffer.length > 10 * 1024 * 1024) return { error: '图片大于 10 MB' };
  await fs.writeFile(result.filePath, buffer, { flag: 'wx' });
  return { cancelled: false, path: result.filePath };
});

app.whenReady().then(async () => {
  try {
    await recoverPendingWrites(userDataDir);
  } catch (error) {
    /* 自愈失败不阻断启动；下次保存会覆盖残留 tmp */
  }
  createWindow();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });