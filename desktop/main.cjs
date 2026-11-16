const { app, BrowserWindow, dialog, ipcMain, shell, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const { pathToFileURL } = require('node:url');

const composer = require('../scripts/composer/index.cjs');
const { registerComposerIpc } = require('./composer-ipc.cjs');
const { createProjectStore } = require('./project-store.cjs');
const { createAssetStore } = require('./asset-store.cjs');
const { createPosterMediaResolver } = require('./poster-media.cjs');
const { createSettingsStore } = require('./settings-store.cjs');
const { registerProjectIpc } = require('./project-ipc.cjs');
const { registerFlushGuard, recoverPendingWrites } = require('./flush-guard.cjs');
const { createDiagnostics } = require('./diagnostics.cjs');
const { probeDevtools } = require('./devtools-probe.cjs');
const { registerPreviewIpc } = require('./preview-channel.cjs');
const { openExternalLink, isAllowedAppUrl } = require('./external-link.cjs');

/**
 * 选择一个真正可写的用户数据目录。
 *
 * 默认仍用系统 userData，正常机器行为不变。但实测存在这样的 Windows 环境：
 * Electron 主进程对 %APPDATA% 写入一律 EPERM（同一目录下 node 进程写入正常），
 * 表现为「本地数据目录不可写」并导致项目无法保存。此时按顺序回退到其它
 * 用户可写位置，保证「产出能保存在电脑上」这条底线不被环境击穿。
 */
function resolveUserDataDir(defaultDir) {
  const candidates = [];
  const push = (dir) => {
    if (typeof dir === 'string' && dir && !candidates.includes(dir)) candidates.push(dir);
  };

  push(defaultDir);
  try { push(path.join(app.getPath('appData'), 'smart-store-generator')); } catch (error) { /* ignore */ }
  try { push(path.join(process.env.LOCALAPPDATA || '', 'smart-store-generator')); } catch (error) { /* ignore */ }
  try { push(path.join(app.getPath('documents'), 'smart-store-generator')); } catch (error) { /* ignore */ }
  try { push(path.join(app.getPath('desktop'), 'smart-store-generator')); } catch (error) { /* ignore */ }
  try { push(path.join(require('node:os').homedir(), 'smart-store-generator')); } catch (error) { /* ignore */ }
  // 某些受限环境只允许写应用自身所在目录，最后再试这两处
  try { push(path.join(process.cwd(), 'app-data')); } catch (error) { /* ignore */ }
  try { push(path.join(path.dirname(app.getPath('exe')), 'app-data')); } catch (error) { /* ignore */ }

  const syncFs = require('node:fs');
  for (const dir of candidates) {
    try {
      syncFs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, `write-probe-${process.pid}.tmp`);
      syncFs.writeFileSync(probe, 'ok', 'utf8');
      syncFs.unlinkSync(probe);
      return dir;
    } catch (error) {
      // 该位置不可写，继续尝试下一个候选
    }
  }
  return null;
}

function migrateUserData(legacyDir, targetDir) {
  if (!legacyDir || !targetDir) return;
  if (path.resolve(legacyDir) === path.resolve(targetDir)) return;
  const syncFs = require('node:fs');
  for (const name of ['projects', 'config.json']) {
    try {
      const src = path.join(legacyDir, name);
      const dst = path.join(targetDir, name);
      if (syncFs.existsSync(src) && !syncFs.existsSync(dst)) {
        syncFs.cpSync(src, dst, { recursive: true });
      }
    } catch (error) {
      // 迁移尽力而为，失败不影响启动
    }
  }
}

let legacyUserDataDir = null;
try { legacyUserDataDir = app.getPath('userData'); } catch (error) { /* ignore */ }

const resolvedUserDataDir = resolveUserDataDir(legacyUserDataDir);
if (resolvedUserDataDir) {
  try { app.setPath('userData', resolvedUserDataDir); } catch (error) { /* ignore */ }
  migrateUserData(legacyUserDataDir, resolvedUserDataDir);
}
const userDataDir = resolvedUserDataDir || legacyUserDataDir || app.getPath('userData');

/**
 * 把「最终选定的数据目录」写成一个固定位置的指针文件（W0 / P0-1）。
 *
 * 一键启动脚本需要显示实际数据目录，但它不该重新实现一遍上面的可写性探测：
 * 两处各算一次必然会在「%APPDATA% 对 Electron 不可写、对 node 可写」这类环境里
 * 给出不同答案。这里由主进程写入唯一事实，启动脚本只读。
 * app-data/ 已在 .gitignore 内；写失败不影响启动。
 */
try {
  const markerDir = path.join(__dirname, '..', 'app-data');
  fsSync.mkdirSync(markerDir, { recursive: true });
  fsSync.writeFileSync(path.join(markerDir, 'userdata-path.txt'), `${userDataDir}\r\n`, 'utf8');
} catch (error) {
  // 指针文件只是给人看的，失败不影响客户端启动与保存。
}

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

  // W4：页面既不能自己开新窗口，也不能把主窗口导航到站外。
  // 外链统一走 shell:open-external（见 external-link.cjs），由用户点击触发。
  const appUrlPrefixes = app.isPackaged
    ? [pathToFileURL(path.join(__dirname, '..', 'dist', 'index.html')).href.replace(/[^/]*$/, '')]
    : ['http://127.0.0.1:5173'];
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, targetUrl) => {
    if (isAllowedAppUrl(targetUrl, appUrlPrefixes)) return;
    event.preventDefault();
  });
}

registerComposerIpc(ipcMain, {
  dialog,
  shell,
  compose: composer.compose,
  validateComposition: composer.validateComposition,
  // UX0b：海报素材由主进程按资产 ID 读取真实字节，渲染进程只传受控引用。
  resolveMedia: createPosterMediaResolver({ assets: assetStore }),
  previewParentDir: path.join(app.getPath('userData'), 'preview-projects'),
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

// 真实渲染截图回传（C-REAL-PREVIEW@1）：只打开已导出工程目录 + 读取本地截图，
// 不上传网络、不写入导出工程、不执行 shell 命令，也不声称完成渲染。
// 「预览新模块」按钮复用同一模块，通过微信开发者工具 CLI 打开工程。
const defaultPreviewProject = [
  path.join(app.getAppPath(), 'miniprogram'),
  path.join(process.cwd(), 'miniprogram'),
].find((candidate) => {
  try {
    return require('node:fs').existsSync(candidate);
  } catch (error) {
    return false;
  }
}) || '';

registerPreviewIpc(ipcMain, {
  dialog,
  shell,
  defaultProjectPath: defaultPreviewProject,
});

registerFlushGuard({
  app,
  ipcMain,
  getWindows: () => BrowserWindow.getAllWindows(),
  timeoutMs: 3000,
});

// W4：对话里的外链只通过这条受控通道打开 —— 主进程再校验一次协议，
// 只调 shell.openExternal，不把 URL 载入任何 Electron 窗口。
ipcMain.handle('shell:open-external', async (_event, payload) => {
  const url = payload && typeof payload === 'object' ? payload.url : payload;
  return openExternalLink(url, { shell });
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