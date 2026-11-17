'use strict';

/**
 * 微信开发者工具 CLI 的单一解析与工程身份检查实现（P0：执行链跑通）。
 *
 * 背景：预览链路（`desktop/devtools-launch.cjs`）和候选验证链路（`scripts/wechat-devtools-run.cjs`，
 * 经 `desktop/frontend-reconstruct/verify-runtime.cjs` 包装）原本各写一份 cli.bat 候选清单，
 * 结果同一台机器上可能「预览能打开、验证说工具缺失」。这里只保留一份实现：
 *
 * - 搜索顺序：`WX_CLI_PATH` → 固定候选 → 固定父目录扫描；
 * - 工程身份：路径、Composer 产物、AppID 三类检查用同一组错误码和同一句人话；
 * - CLI 失败分类：APPID_ERROR / SERVICE_PORT_DISABLED / NOT_LOGGED_IN 由同一函数识别。
 *
 * 本模块**只读**：不启动进程、不解压、不改写任何文件。
 */

const path = require('node:path');
const fs = require('node:fs');

const DEVTOOLS_CLI_CANDIDATES = Object.freeze([
  'E:\\微信web开发者工具\\cli.bat',
  'D:\\微信web开发者工具\\cli.bat',
  'D:\\Program Files\\Tencent\\微信web开发者工具\\cli.bat',
  '%LOCALAPPDATA%\\Programs\\微信web开发者工具\\cli.bat',
  '%LOCALAPPDATA%\\微信web开发者工具\\cli.bat',
  '%ProgramFiles%\\Tencent\\微信web开发者工具\\cli.bat',
  '%ProgramFiles(x86)%\\Tencent\\微信web开发者工具\\cli.bat',
  // 2.x 起安装包把产品名从「微信web开发者工具」改为「微信开发者工具」，目录名随之变化；
  // 只保留旧名候选会导致新版永远命中不了。
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

const MAX_PATH_LENGTH = 1200;
const INVALID_APPIDS = new Set(['', 'touristappid']);
const APPID_RE = /^wx[0-9a-f]{16}$/;

const CODES = Object.freeze({
  OK: null,
  PATH_INVALID: 'PATH_INVALID',
  PATH_MISSING: 'PATH_MISSING',
  OUTPUT_NOT_COMPOSER: 'OUTPUT_NOT_COMPOSER',
  APPID_NOT_APPLIED: 'APPID_NOT_APPLIED',
  APPID_INVALID: 'APPID_INVALID',
  DEVTOOLS_NOT_FOUND: 'DEVTOOLS_NOT_FOUND',
});

/** 开发者工具 CLI 输出里可以明确归类的失败语义（两条链路共用）。 */
const CLI_FAILURES = Object.freeze([
  {
    code: 'APPID_ERROR',
    pattern: /APPID_ERROR|不存在此 AppID/,
    message: 'APPID_ERROR：导出工程使用 touristappid 占位，开发者工具拒绝打开；'
      + '请先在应用内完成 AppID 写入与校验。',
  },
  {
    code: 'SERVICE_PORT_DISABLED',
    pattern: /service port|服务端口/,
    message: 'SERVICE_PORT_DISABLED：开发者工具服务端口未开启，CLI 无法调用。',
  },
]);

function expandEnvPath(value, env) {
  return String(value).replace(/%([^%]+)%/g, (match, name) => env[name] || match);
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
    return { ok: false, code: CODES.PATH_INVALID, message: '工程路径必须是字符串' };
  }
  const trimmed = targetPath.trim();
  if (!trimmed) {
    return { ok: false, code: CODES.PATH_INVALID, message: '工程路径不能为空' };
  }
  if (trimmed.length > MAX_PATH_LENGTH) {
    return { ok: false, code: CODES.PATH_INVALID, message: `工程路径超过 ${MAX_PATH_LENGTH} 个字符` };
  }
  if (trimmed.includes('\0')) {
    return { ok: false, code: CODES.PATH_INVALID, message: '工程路径包含非法字符' };
  }
  if (!path.isAbsolute(trimmed)) {
    return { ok: false, code: CODES.PATH_INVALID, message: '工程路径必须是绝对路径' };
  }

  const resolved = path.resolve(trimmed);
  let stats;
  try {
    stats = fs.statSync(resolved);
  } catch (error) {
    return { ok: false, code: CODES.PATH_MISSING, message: `工程目录不存在：${resolved}` };
  }
  if (!stats.isDirectory()) {
    return { ok: false, code: CODES.PATH_INVALID, message: `工程路径不是目录：${resolved}` };
  }
  return { ok: true, path: resolved };
}

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

/** AppID 分类：real / tourist / empty / invalid（与 wechat-export-audit 同语义）。 */
function classifyAppid(appid) {
  const value = typeof appid === 'string' ? appid.trim() : '';
  if (value === '') return 'empty';
  if (value === 'touristappid') return 'tourist';
  return APPID_RE.test(value) ? 'real' : 'invalid';
}

/**
 * 工程目录是否为 Composer 产物。
 * 只有 Composer 产物才带 composition.lock.json + generation-report.json 这套摘要。
 * @param {string} projectPath
 * @returns {{ composer: boolean, missing: string[] }}
 */
function detectComposerOutput(projectPath) {
  const missing = [];
  if (!fs.existsSync(path.join(projectPath, 'composition.lock.json'))) missing.push('composition.lock.json');
  if (!fs.existsSync(path.join(projectPath, 'generation-report.json'))) missing.push('generation-report.json');
  return { composer: missing.length === 0, missing };
}

/**
 * 统一的工程身份检查：预览与候选验证用同一实现、同一错误码、同一句提示。
 *
 * @param {{ projectDir?: string, requireComposer?: boolean, requireAppId?: boolean,
 *   expectedAppid?: string }} input
 * @returns {{ ok: boolean, code: string|null, message: string, projectPath: string,
 *   composer: boolean, missing: string[], appid: string, appidKind: string, appidMasked: string }}
 */
function inspectDevtoolsTarget(input) {
  const opts = input || {};
  const directory = validateProjectDir(opts.projectDir);
  if (!directory.ok) {
    return {
      ok: false,
      code: directory.code,
      message: directory.message,
      projectPath: typeof opts.projectDir === 'string' ? opts.projectDir : '',
      composer: false,
      missing: [],
      appid: '',
      appidKind: 'empty',
      appidMasked: '',
    };
  }
  const identity = detectComposerOutput(directory.path);
  const appid = readAppidFrom(path.join(directory.path, 'project.config.json'));
  const appidKind = classifyAppid(appid);
  const base = {
    projectPath: directory.path,
    composer: identity.composer,
    missing: identity.missing,
    appid,
    appidKind,
    appidMasked: maskAppid(appid),
  };

  if (opts.requireComposer === true && !identity.composer) {
    return {
      ...base,
      ok: false,
      code: CODES.OUTPUT_NOT_COMPOSER,
      message: `该目录不是 Composer 产物（缺少 ${identity.missing.join(' / ')}），无法校验 AppID 与摘要。`
        + '请先在应用内完成导出与 AppID 写入校验，再打开开发者工具。',
    };
  }
  const expected = typeof opts.expectedAppid === 'string' ? opts.expectedAppid.trim() : '';
  if (expected && appid !== expected) {
    return {
      ...base,
      ok: false,
      code: CODES.APPID_INVALID,
      message: '工程 AppID 与期望值不一致，已拒绝沿用摘要校验结论。',
    };
  }
  if (opts.requireAppId === true) {
    if (appidKind === 'empty') {
      return {
        ...base,
        ok: false,
        code: CODES.APPID_NOT_APPLIED,
        message: '工程还没有 AppID（project.config.json 为空）。请先完成 AppID 写入与校验；本应用不会自动改写。',
      };
    }
    if (appidKind === 'tourist') {
      return {
        ...base,
        ok: false,
        code: CODES.APPID_NOT_APPLIED,
        message: '工程仍是测试号 touristappid，微信开发者工具不接受。请先完成 AppID 写入与校验。',
      };
    }
    if (appidKind !== 'real') {
      return {
        ...base,
        ok: false,
        code: CODES.APPID_INVALID,
        message: 'AppID 格式不合法（应为 wx + 16 位十六进制）。请重新写入并校验 AppID。',
      };
    }
  }
  return { ...base, ok: true, code: CODES.OK, message: '工程身份检查通过' };
}

/**
 * 把开发者工具 CLI 的输出归类成可读的阻塞原因（两条链路共用同一套语义）。
 * @param {{ stdout?: string, stderr?: string }} result
 * @returns {string} 空字符串表示没有识别出结构性阻塞
 */
function classifyCliFailure(result) {
  const output = String((result && result.stdout) || '') + '\n' + String((result && result.stderr) || '');
  for (const failure of CLI_FAILURES) {
    if (failure.pattern.test(output)) return failure.code + '：' + failure.message.replace(/^[A-Z_]+：/, '');
  }
  if (/login/i.test(output) && /false/i.test(output)) {
    return 'NOT_LOGGED_IN：开发者工具未登录。';
  }
  return '';
}

module.exports = {
  CODES,
  CLI_FAILURES,
  DEVTOOLS_CLI_CANDIDATES,
  DEVTOOLS_SCAN_ROOTS,
  APPID_RE,
  MAX_PATH_LENGTH,
  classifyAppid,
  classifyCliFailure,
  detectComposerOutput,
  expandEnvPath,
  inspectDevtoolsTarget,
  maskAppid,
  readAppidFrom,
  resolveDevtoolsCli,
  scanDevtoolsCli,
  validateProjectDir,
};
