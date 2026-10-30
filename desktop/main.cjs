const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const { writeProject } = require('../scripts/generate-mini-program.cjs');

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

ipcMain.handle('generator:export', async (_event, payload) => {
  const result = await dialog.showOpenDialog({
    title: '选择独立小程序项目的保存位置',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths[0]) return { cancelled: true };
  const project = await writeProject(result.filePaths[0], payload);
  return { cancelled: false, projectPath: project };
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

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
