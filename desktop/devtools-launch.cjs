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

const { inspectOutput } = require('./output-consistency.cjs');

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

const INVALID_APPIDS = new Set(['', 'touristappid']);
const APPID_RE = /^wx[0-9a-f]{16}$/;

function readAppidFrom(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed.appid === 'string' ? parsed.appid.trim() : '';
  } catch (error) {
    return '';
  }
}

/** 与 appid-postprocess 一致的脱敏（不打印明文 AppID）。 */
function maskAppid(appid) {
  if (typeof appid !== 'string' || appid.length < 10) return '';
  return `${appid.slice(0, 4)}****${appid.slice(-6)}`;
}

/**
 * 工程目录是否为 Composer 产物。
 * W1：只有 Composer 产物才有 composition.lock.json + generation-report.json 这套摘要，
 * 也只有它能被「只读一致性检查」验证。非 Composer 的普通预览目录无法可靠区分
 * AppID 状态，宁可拒绝启动，也不猜、不改写。
 */
function detectComposerOutput(projectPath) {
  const lockFile = path.join(projectPath, 'composition.lock.json');
  const reportFile = path.join(projectPath, 'generation-report.json');
  const missing = [];
  if (!fs.existsSync(lockFile)) missing.push('composition.lock.json');
  if (!fs.existsSync(reportFile)) missing.push('generation-report.json');
  return { composer: missing.length === 0, missing };
}

/**
 * 在微信开发者工具里打开工程目录。
 *
 * W1 约束（不可退让）：
 * 1. 不再隐式改写 project.config.json：预览产物里的 touristappid / 空 AppID
 *    一律视为未完成 AppID 写入，直接拒绝启动；
 * 2. 启动前必须通过统一只读一致性检查（config/lock/report/当前磁盘摘要一致 +
 *    verifyOutput 通过），任何一项失败都不调起 launcher；
 * 3. 所有预检（路径、身份、AppID、CLI 可用性）都在调起之前完成，本链路不写任何文件；
 * 4. 成功只代表"已请求打开"，不代表编译通过。
 *
 * @param {{ projectPath?: string }} payload
 * @param {{ defaultProjectPath?: string, launcher?: Function, env?: object,
 *   existsSync?: Function, inspectOutput?: Function, mode?: string }} [options]
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

  if (!isShellSafePath(validation.path)) {
    return {
      ok: false,
      cancelled: false,
      code: 'PATH_INVALID',
      message: `工程路径包含命令行特殊字符，请在微信开发者工具中手动导入：${validation.path}`,
    };
  }

  // ① 必须先能证明这是 Composer 产物（否则没有摘要可校验）
  const identity = detectComposerOutput(validation.path);
  if (!identity.composer) {
    return {
      ok: false,
      cancelled: false,
      code: 'OUTPUT_NOT_COMPOSER',
      message: `该目录不是 Composer 产物（缺少 ${identity.missing.join(' / ')}），无法校验 AppID 与摘要。`
        + '请先在应用内完成导出与 AppID 写入校验，再打开开发者工具。',
      details: { projectPath: validation.path, missing: identity.missing },
    };
  }

  // ② AppID 必须是正式 AppID：本链路不会替用户改写任何文件
  const configPath = path.join(validation.path, 'project.config.json');
  const appid = readAppidFrom(configPath);
  if (INVALID_APPIDS.has(appid)) {
    return {
      ok: false,
      cancelled: false,
      code: 'APPID_NOT_APPLIED',
      message: appid === ''
        ? '工程还没有 AppID（project.config.json 为空）。请先完成 AppID 写入与校验；本应用不会自动改写。'
        : '工程仍是测试号 touristappid，微信开发者工具不接受。请先完成 AppID 写入与校验。',
      details: { projectPath: validation.path },
    };
  }
  if (!APPID_RE.test(appid)) {
    return {
      ok: false,
      cancelled: false,
      code: 'APPID_INVALID',
      message: 'AppID 格式不合法（应为 wx + 16 位十六进制）。请重新写入并校验 AppID。',
      details: { projectPath: validation.path },
    };
  }

  // ③ 统一只读一致性检查（含 verifyOutput）：任一项失败都不调起
  const inspect = typeof opts.inspectOutput === 'function' ? opts.inspectOutput : inspectOutput;
  let inspected;
  try {
    inspected = inspect(validation.path, {
      expectAppid: appid,
      requireValidAppid: true,
      deep: true,
      mode: opts.mode,
    });
  } catch (error) {
    return {
      ok: false,
      cancelled: false,
      code: 'OUTPUT_VERIFY_FAILED',
      message: `产物一致性检查失败：${(error && error.message) || '未知错误'}`,
      details: { projectPath: validation.path },
    };
  }
  if (!inspected || inspected.ok !== true) {
    const problems = (inspected && inspected.problems) || [];
    return {
      ok: false,
      cancelled: false,
      code: (inspected && inspected.code) || 'OUTPUT_VERIFY_FAILED',
      message: `产物未通过一致性校验，已拒绝打开开发者工具：${(inspected && inspected.message) || '摘要不一致'}`,
      details: { projectPath: validation.path, problems: problems.slice(0, 10) },
    };
  }

  // ④ CLI 可用性预检（仍在任何写操作之前；本链路本来就不写文件）
  const cli = resolveDevtoolsCli({ env: opts.env, existsSync: opts.existsSync });
  if (!cli) {
    return {
      ok: false,
      cancelled: false,
      code: 'DEVTOOLS_NOT_FOUND',
      message: `未找到微信开发者工具 CLI（cli.bat）。请安装后重试，或设置 WX_CLI_PATH 指向 cli.bat。工程：${validation.path}`,
      details: { via: 'devtools-cli', projectPath: validation.path },
    };
  }

  const launcher = typeof opts.launcher === 'function' ? opts.launcher : spawn;
  try {
    // cli.bat 必须经 shell 执行；路径已通过 isShellSafePath 校验，这里只做引号包裹。
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
    message: `已请求打开微信开发者工具（仅表示已发起调起，不代表编译通过）：${validation.path}`,
    details: {
      via: 'devtools-cli',
      projectPath: validation.path,
      cli,
      appidMasked: maskAppid(appid),
      appidFixed: false,
      status: 'devtools-open-requested',
      compiled: false,
      consistency: {
        tree: inspected.tree,
        lockDigest: inspected.lockDigest,
        fileCount: inspected.fileCount,
      },
    },
  };
}

/**
 * 旧实现（隐式改写 AppID）已删除：W1 起任何 AppID 写入都必须走
 * `appid-postprocess.cjs` 的事务（备份 + 全量校验 + 可回滚），
 * 本模块只读不写。
 */

module.exports = {
  DEVTOOLS_CLI_CANDIDATES,
  APPID_RE,
  isShellSafePath,
  resolveDevtoolsCli,
  validateProjectDir,
  detectComposerOutput,
  openProjectInDevtools,
};