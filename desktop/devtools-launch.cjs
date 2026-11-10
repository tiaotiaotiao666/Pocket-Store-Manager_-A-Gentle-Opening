'use strict';

/**
 * 微信开发者工具 CLI 调起模块。
 *
 * 职责：
 * 1. 解析本机 cli.bat（环境变量 `WX_CLI_PATH` 优先）；
 * 2. 校验工程目录为存在的绝对路径，并拒绝含 cmd 特殊字符的路径；
 * 3. 用官方 CLI `open --project <dir>` 打开工程。
 *
 * 边界：不执行任意命令、不做渲染，只是把已导出工程交给微信开发者工具。
 * 单独成模块，让 `preview-channel.cjs` 保持“不直接执行子进程”的既有约束。
 */

const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const DEVTOOLS_CLI_CANDIDATES = Object.freeze([
  'E:\\微信web开发者工具\\cli.bat',
  'D:\\微信web开发者工具\\cli.bat',
  'D:\\Program Files\\Tencent\\微信web开发者工具\\cli.bat',
  '%LOCALAPPDATA%\\Programs\\微信web开发者工具\\cli.bat',
  '%LOCALAPPDATA%\\微信web开发者工具\\cli.bat',
  '%ProgramFiles%\\Tencent\\微信web开发者工具\\cli.bat',
  '%ProgramFiles(x86)%\\Tencent\\微信web开发者工具\\cli.bat',
  // 2.x 起安装包把产品名从「微信web开发者工具」改为「微信开发者工具」，
  // 目录名随之变化；只保留旧名候选会导致新版永远命中不了。
  '%LOCALAPPDATA%\\Programs\\微信开发者工具\\cli.bat',
  '%LOCALAPPDATA%\\微信开发者工具\\cli.bat',
  '%ProgramFiles%\\Tencent\\微信开发者工具\\cli.bat',
  '%ProgramFiles(x86)%\\Tencent\\微信开发者工具\\cli.bat',
  'D:\\微信开发者工具\\cli.bat',
  'E:\\微信开发者工具\\cli.bat',
]);

/**
 * 目录扫描兜底：安装位置可以是任意目录（例如用户把便携版解压到
 * `D:\Downloads\微信web开发者工具`），靠固定候选无法穷举。
 * 这里只扫固定父目录的一层子目录名，不做递归，成本可控。
 */
const DEVTOOLS_SCAN_ROOTS = Object.freeze([
  'D:\\Downloads',
  'D:\\',
  'E:\\Downloads',
  'E:\\',
  'C:\\Downloads',
  '%LOCALAPPDATA%\\Programs',
  '%LOCALAPPDATA%',
  '%ProgramFiles%',
  '%ProgramFiles(x86)%',
]);

const DEVTOOLS_DIR_PATTERN = /(微信.*开发者工具|wechat.*devtools)$/i;

const UNSAFE_SHELL_CHARS = /["&|<>^%\r\n]/;
const MAX_PATH_LENGTH = 1200;

function expandEnvPath(value, env) {
  return String(value).replace(/%([^%]+)%/g, (match, name) => env[name] || match);
}

function isShellSafePath(value) {
  return typeof value === 'string'
    && value.length > 0
    && !value.includes('\0')
    && !UNSAFE_SHELL_CHARS.test(value);
}

/**
 * 解析微信开发者工具 CLI 路径。
 * @param {{ env?: object, existsSync?: (target: string) => boolean }} [options]
 * @returns {string|null}
 */
function resolveDevtoolsCli(options) {
  const opts = options || {};
  const env = opts.env || process.env;
  const existsSync = opts.existsSync || fs.existsSync;
  const candidates = [];
  if (typeof env.WX_CLI_PATH === 'string' && env.WX_CLI_PATH.trim()) {
    candidates.push(env.WX_CLI_PATH.trim());
  }
  candidates.push(...DEVTOOLS_CLI_CANDIDATES);

  for (const raw of candidates) {
    const candidate = expandEnvPath(raw, env);
    try {
      if (existsSync(candidate)) return candidate;
    } catch (error) {
      /* 候选路径不可读时继续下一个 */
    }
  }
  return scanDevtoolsCli(env, existsSync);
}

/**
 * 在固定父目录下按目录名匹配开发者工具安装目录，返回其中的 cli.bat。
 * 只读一层目录，任何 IO 失败都静默跳过，不影响既有候选逻辑。
 * @param {object} env
 * @param {(target: string) => boolean} existsSync
 * @returns {string|null}
 */
function scanDevtoolsCli(env, existsSync) {
  for (const raw of DEVTOOLS_SCAN_ROOTS) {
    const root = expandEnvPath(raw, env);
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (error) {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !DEVTOOLS_DIR_PATTERN.test(entry.name)) continue;
      const candidate = path.join(root, entry.name, 'cli.bat');
      try {
        if (existsSync(candidate)) return candidate;
      } catch (error) {
        /* 该候选不可读时继续 */
      }
    }
  }
  return null;
}

/**
 * 校验工程目录：存在、是目录、绝对路径。
 * @param {string} targetPath
 * @returns {{ ok: true, path: string } | { ok: false, code: string, message: string }}
 */
function validateProjectDir(targetPath) {
  if (typeof targetPath !== 'string') {
    return { ok: false, code: 'PATH_INVALID', message: '工程路径必须是字符串' };
  }
  const trimmed = targetPath.trim();
  if (!trimmed) {
    return { ok: false, code: 'PATH_INVALID', message: '工程路径不能为空' };
  }
  if (trimmed.length > MAX_PATH_LENGTH) {
    return { ok: false, code: 'PATH_INVALID', message: `工程路径超过 ${MAX_PATH_LENGTH} 个字符` };
  }
  if (trimmed.includes('\0')) {
    return { ok: false, code: 'PATH_INVALID', message: '工程路径包含非法字符' };
  }
  if (!path.isAbsolute(trimmed)) {
    return { ok: false, code: 'PATH_INVALID', message: '工程路径必须是绝对路径' };
  }

  const resolved = path.resolve(trimmed);
  let stats;
  try {
    stats = fs.statSync(resolved);
  } catch (error) {
    return { ok: false, code: 'PATH_MISSING', message: `工程目录不存在：${resolved}` };
  }
  if (!stats.isDirectory()) {
    return { ok: false, code: 'PATH_INVALID', message: `工程路径不是目录：${resolved}` };
  }
  return { ok: true, path: resolved };
}

const DEFAULT_APPID_SOURCE = path.join(__dirname, '..', 'miniprogram', 'project.config.json');
const INVALID_APPIDS = new Set(['', 'touristappid']);

function readAppidFrom(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed.appid === 'string' ? parsed.appid.trim() : '';
  } catch (error) {
    return '';
  }
}

/**
 * 预览工程导出时默认写 touristappid，微信开发者工具 CLI 不接受该 AppID。
 * 打开前若目标仍是游客/空 appid，替换成项目 `miniprogram` 里的有效 appid。
 */
function ensurePreviewAppid(projectPath, sourceFile) {
  const configPath = path.join(projectPath, 'project.config.json');
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    return { changed: false, appid: '' };
  }

  const current = typeof config.appid === 'string' ? config.appid.trim() : '';
  if (current && !INVALID_APPIDS.has(current)) {
    return { changed: false, appid: current };
  }

  const fallback = readAppidFrom(sourceFile || DEFAULT_APPID_SOURCE);
  if (!fallback || INVALID_APPIDS.has(fallback)) {
    return { changed: false, appid: current };
  }

  config.appid = fallback;
  try {
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    return { changed: true, appid: fallback };
  } catch (error) {
    return { changed: false, appid: current };
  }
}

/**
 * 在微信开发者工具里打开工程目录。
 *
 * @param {{ projectPath?: string }} payload
 * @param {{ defaultProjectPath?: string, launcher?: Function, env?: object,
 *   existsSync?: Function }} [options]
 */
async function openProjectInDevtools(payload, options) {
  const opts = options || {};
  const requested = payload && typeof payload === 'object' ? payload.projectPath : null;
  const target = (typeof requested === 'string' && requested.trim())
    ? requested
    : (opts.defaultProjectPath || '');

  const validation = validateProjectDir(target);
  if (!validation.ok) {
    return {
      ok: false,
      cancelled: false,
      code: validation.code,
      message: validation.message,
    };
  }

  const appidFix = ensurePreviewAppid(validation.path, opts.fallbackAppidFile);

  if (!isShellSafePath(validation.path)) {
    return {
      ok: false,
      cancelled: false,
      code: 'PATH_INVALID',
      message: `工程路径包含命令行特殊字符，请在微信开发者工具中手动导入：${validation.path}`,
    };
  }

  const cli = resolveDevtoolsCli({ env: opts.env, existsSync: opts.existsSync });
  if (!cli) {
    return {
      ok: false,
      cancelled: false,
      code: 'DEVTOOLS_NOT_FOUND',
      message: `未找到微信开发者工具 CLI：请安装开发者工具，或把环境变量 WX_CLI_PATH 指向 cli.bat。工程目录：${validation.path}`,
      details: { via: 'devtools-cli', projectPath: validation.path },
    };
  }

  const launcher = typeof opts.launcher === 'function' ? opts.launcher : spawn;
  try {
    const child = launcher(`"${cli}"`, ['open', '--project', `"${validation.path}"`], {
      shell: true,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    if (child && typeof child.unref === 'function') child.unref();
  } catch (error) {
    return {
      ok: false,
      cancelled: false,
      code: 'DEVTOOLS_NOT_FOUND',
      message: `调起微信开发者工具失败（${(error && error.message) || '未知错误'}）。请手动导入工程：${validation.path}`,
      details: { via: 'devtools-cli', projectPath: validation.path },
    };
  }

  return {
    ok: true,
    cancelled: false,
    code: null,
    message: `已请求微信开发者工具打开工程：${validation.path}`,
    details: {
      via: 'devtools-cli',
      projectPath: validation.path,
      cli,
      appid: appidFix.appid,
      appidFixed: appidFix.changed,
    },
  };
}

module.exports = {
  DEVTOOLS_CLI_CANDIDATES,
  isShellSafePath,
  resolveDevtoolsCli,
  validateProjectDir,
  openProjectInDevtools,
};