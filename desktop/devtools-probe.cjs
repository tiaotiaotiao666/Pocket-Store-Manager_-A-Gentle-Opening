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
      return { found: true, path: installLocation, version: null, via: 'registry' };
    }
  }

  for (const candidate of defaultCandidates()) {
    if (hasExecutable(candidate)) {
      return { found: true, path: candidate, version: null, via: 'default-path' };
    }
  }

  return { found: false, path: null, version: null, via: 'none' };
}

module.exports = { probeDevtools, hasExecutable, defaultCandidates };