'use strict';

/**
 * 微信开发者工具探测（只读）。
 *
 * 只查注册表 InstallLocation 与几个默认目录，不执行工具、不拼接 shell 字符串、
 * 不尝试 `cli open --project`（当前环境 CLI 服务端口关闭，见实现方案 6.4）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const UNINSTALL_KEYS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\微信web开发者工具',
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\微信web开发者工具',
  'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\微信web开发者工具',
];

const EXECUTABLES = ['wechatdevtools.exe', 'cli.bat'];
const PROCESSS_NAMES = ['微信开发者工具', 'wechatdevtools'];

/**
 * 只读判断开发者工具是否已经启动（Windows 进程列表）。
 * 不执行工具、不发命令；tasklist 只用于读取进程名。
 */
function isDevtoolsRunning() {
  return new Promise((resolve) => {
    execFile('tasklist.exe', ['/FO', 'CSV', '/NH'], {
      timeout: 2500,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    }, (error, stdout) => {
      if (error) {
        resolve(false);
        return;
      }
      const text = String(stdout || '').toLowerCase();
      resolve(PROCESSS_NAMES.some((name) => text.includes(name.toLowerCase())));
    });
  });
}

/**
 * 只读读取开发者工具窗口标题。
 * 用窗口标题判断“是否已经打开了小程序工程/页面”，而不是只看进程是否存在。
 */
function getDevtoolsWindowTitle() {
  return new Promise((resolve) => {
    const script = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Process | Where-Object { $_.ProcessName -like '*微信*' -and $_.MainWindowTitle } | Select-Object -First 1 -ExpandProperty MainWindowTitle";
    execFile('powershell.exe', ['-NoProfile', '-Command', script], {
      timeout: 2500,
      windowsHide: true,
      maxBuffer: 64 * 1024,
      encoding: 'utf8',
    }, (error, stdout) => {
      if (error) {
        resolve('');
        return;
      }
      resolve(String(stdout || '').trim());
    });
  });
}

async function readDevtoolsWindowState() {
  const windowTitle = await getDevtoolsWindowTitle();
  const running = Boolean(windowTitle) || await isDevtoolsRunning();
  const projectOpen = Boolean(windowTitle)
    && (/-预览-/.test(windowTitle) || /miniprogram/i.test(windowTitle));
  return { running, projectOpen, windowTitle };
}

function runRegQuery(key) {
  return new Promise((resolve) => {
    execFile('reg.exe', ['query', key, '/v', 'InstallLocation'], {
      timeout: 2500,
      windowsHide: true,
      maxBuffer: 64 * 1024,
    }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      const match = /InstallLocation\s+REG_\w+\s+(.+)/i.exec(String(stdout || ''));
      resolve(match ? match[1].trim() : null);
    });
  });
}

function hasExecutable(dir) {
  try {
    const entries = fs.readdirSync(dir);
    return entries.some((name) => EXECUTABLES.includes(name.toLowerCase()));
  } catch (error) {
    return false;
  }
}

function defaultCandidates() {
  const localAppData = process.env.LOCALAPPDATA || '';
  const programFiles = process.env.ProgramFiles || '';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || '';
  return [
    localAppData && path.join(localAppData, '微信web开发者工具'),
    programFilesX86 && path.join(programFilesX86, 'Tencent', '微信web开发者工具'),
    programFiles && path.join(programFiles, 'Tencent', '微信web开发者工具'),
    localAppData && path.join(localAppData, 'Programs', '微信web开发者工具'),
  ].filter(Boolean);
}

async function probeDevtools() {
  if (process.platform !== 'win32') {
    return { found: false, path: null, version: null, via: 'none' };
  }

  for (const key of UNINSTALL_KEYS) {
    const installLocation = await runRegQuery(key);
    if (installLocation && hasExecutable(installLocation)) {
      const windowState = await readDevtoolsWindowState();
      return {
        found: true,
        path: installLocation,
        version: null,
        via: 'registry',
        ...windowState,
      };
    }
  }

  for (const candidate of defaultCandidates()) {
    if (hasExecutable(candidate)) {
      const windowState = await readDevtoolsWindowState();
      return {
        found: true,
        path: candidate,
        version: null,
        via: 'default-path',
        ...windowState,
      };
    }
  }

  return { found: false, path: null, version: null, via: 'none', running: false, projectOpen: false, windowTitle: '' };
}

module.exports = {
  probeDevtools,
  hasExecutable,
  defaultCandidates,
  isDevtoolsRunning,
  getDevtoolsWindowTitle,
  readDevtoolsWindowState,
};