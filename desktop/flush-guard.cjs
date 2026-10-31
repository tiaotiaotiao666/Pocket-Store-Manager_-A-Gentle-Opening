'use strict';

/**
 * 关窗前 flush 握手 + 未完成写入自愈。
 *
 * - 渲染进程有未保存变更时，主进程在退出前发 project:flush-request，等待 renderer 调用
 *   project:flush-done，最长 3s，超时放行（实现方案 5.3.4）。
 * - 启动时扫描 projects/<id>/project.json.tmp：若 tmp 可解析且比主文件新，则替换主文件；
 *   否则删除 tmp。用于断电/杀进程后的自愈。
 */

const fsp = require('node:fs/promises');
const path = require('node:path');

const { writeFileAtomic } = require('./project-store.cjs');

async function fileTimestamp(file) {
  try {
    const stat = await fsp.stat(file);
    return stat.mtimeMs;
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
}

async function recoverPendingWrites(userDataDir) {
  const projectsDir = path.join(userDataDir, 'projects');
  let entries = [];
  try {
    entries = await fsp.readdir(projectsDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return { recovered: [], discarded: [] };
    throw error;
  }

  const recovered = [];
  const discarded = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(projectsDir, entry.name);
    const tmp = path.join(directory, 'project.json.tmp');
    const target = path.join(directory, 'project.json');
    const tmpAt = await fileTimestamp(tmp);
    if (!tmpAt) continue;

    try {
      const raw = await fsp.readFile(tmp, 'utf8');
      JSON.parse(raw);
      const targetAt = await fileTimestamp(target);
      if (tmpAt > targetAt) {
        await writeFileAtomic(target, raw);
        recovered.push({ projectId: entry.name, path: target });
      } else {
        await fsp.unlink(tmp);
        discarded.push({ projectId: entry.name, reason: 'tmp-older-than-target' });
      }
    } catch (error) {
      try {
        await fsp.unlink(tmp);
        discarded.push({ projectId: entry.name, reason: 'tmp-unparseable' });
      } catch (ignored) {
        /* 删除失败时保留 tmp，下一次启动再尝试 */
      }
    }
  }
  return { recovered, discarded };
}

function registerFlushGuard(options) {
  const opts = options || {};
  const app = opts.app;
  const ipcMain = opts.ipcMain;
  const getWindows = typeof opts.getWindows === 'function' ? opts.getWindows : () => [];
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 3000;

  let resolveAck = null;
  let quitting = false;

  ipcMain.handle('project:flush-done', async () => {
    if (resolveAck) {
      const resolve = resolveAck;
      resolveAck = null;
      resolve();
    }
    return { ok: true };
  });

  async function requestFlush() {
    const windows = getWindows().filter((window) => window && !window.isDestroyed());
    if (windows.length === 0) return;
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolveAck = null;
        resolve();
      };
      resolveAck = finish;
      const timer = setTimeout(finish, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      windows.forEach((window) => {
        try {
          window.webContents.send('project:flush-request');
        } catch (error) {
          /* 窗口正在销毁时忽略 */
        }
      });
    });
  }

  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    requestFlush().finally(() => app.quit());
  });

  return { requestFlush, getQuitting: () => quitting };
}

module.exports = {
  registerFlushGuard,
  recoverPendingWrites,
  fileTimestamp,
};