'use strict';

/**
 * Workspace Agent / 前端候选链**共享**的路径安全实现（唯一一份）。
 *
 * 这里放的是安全关键逻辑：私有根校验、逐段 canonical 化、symlink/junction 识别、
 * 受保护（仓库内）路径拒绝、安全递归删除、原子 JSON 写、POSIX 相对路径校验。
 *
 * 为什么有两套错误码 profile：
 * - 历史候选链（`desktop/frontend-reconstruct/workspace.cjs`）已经对外承诺
 *   `WORKSPACE_*` 错误码，且多个旧测试断言了这些字符串，不能改；
 * - B1 Workspace Agent 使用冻结文档 §1.7 的 `AGENT_*` 命名空间，需要把
 *   “非法相对路径 / 解析逃逸 / 链接 / 受保护路径”区分成不同码。
 *
 * 因此实现只有一份，把错误码表作为参数传入：默认 `LEGACY_CODES`（保持旧行为），
 * Agent 侧传 `AGENT_CODES`。禁止在别处再写第二份 lstat/realpath/mkdir 安全逻辑。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/** ID/控制字符契约唯一事实源（不许再抄一份正则）。 */
const {
  PROJECT_ID_PATTERN,
  RUN_ID_PATTERN,
  CONTROL_CHAR_NARROW_PATTERN: CONTROL_CHAR_PATTERN,
} = require('../frontend-reconstruct/contract.generated.cjs');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const ATTEMPT_DIR_PATTERN = /^attempt-([1-9][0-9]{0,3})$/;
const STAGING_PATTERN = /^\.staging-[0-9a-f]{8}$/;
const DRIVE_PATTERN = /^[A-Za-z]:/;
const ABSOLUTE_POSIX_PATTERN = /^\//;
const ABSOLUTE_UNC_PATTERN = /^\\\\/;

/**
 * 历史候选链错误码（对外契约，字符串不得改变）。
 * PATH_* 在旧链里全部折叠成 `WORKSPACE_PATH_REJECTED`，保持既有测试与行为。
 */
const LEGACY_CODES = Object.freeze({
  ROOT_INVALID: 'WORKSPACE_ROOT_INVALID',
  PROJECT_ID_INVALID: 'WORKSPACE_PROJECT_ID_INVALID',
  RUN_ID_INVALID: 'WORKSPACE_RUN_ID_INVALID',
  ATTEMPT_FAILED: 'WORKSPACE_ATTEMPT_FAILED',
  IO_FAILED: 'WORKSPACE_IO_FAILED',
  PATH_REJECTED: 'WORKSPACE_PATH_REJECTED',
  PATH_INVALID: 'WORKSPACE_PATH_REJECTED',
  PATH_ESCAPE: 'WORKSPACE_PATH_REJECTED',
  PATH_LINK: 'WORKSPACE_PATH_REJECTED',
  PATH_PROTECTED: 'WORKSPACE_PATH_REJECTED',
});

/** B1 Workspace Agent 错误码（冻结文档 §1.7 子集，键名与共享实现对应）。 */
const AGENT_CODES = Object.freeze({
  ROOT_INVALID: 'AGENT_ROOT_INVALID',
  PROJECT_ID_INVALID: 'AGENT_PROJECT_INVALID',
  RUN_ID_INVALID: 'AGENT_ID_INVALID',
  ATTEMPT_FAILED: 'AGENT_TXN_ABORTED',
  IO_FAILED: 'AGENT_IO_FAILED',
  PATH_REJECTED: 'AGENT_PATH_INVALID',
  PATH_INVALID: 'AGENT_PATH_INVALID',
  PATH_ESCAPE: 'AGENT_PATH_ESCAPE',
  PATH_LINK: 'AGENT_PATH_LINK',
  PATH_PROTECTED: 'AGENT_PATH_PROTECTED',
  DEPTH_EXCEEDED: 'AGENT_DEPTH_EXCEEDED',
});

function ok(extra) {
  return Object.assign({ ok: true }, extra);
}

function fail(code, target, message) {
  return { ok: false, code, path: target || '.', message };
}

function samePath(first, second) {
  const a = path.resolve(first);
  const b = path.resolve(second);
  if (process.platform === 'win32') return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

function realpathOf(target) {
  return fs.realpathSync.native ? fs.realpathSync.native(target) : fs.realpathSync(target);
}

/** target 是否严格位于 root 之内（不含等于）。 */
function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function isInsideOrEqual(root, target) {
  return samePath(root, target) || isInside(root, target);
}

function isProtectedRepoDir(target) {
  return isInsideOrEqual(REPO_ROOT, target);
}

/**
 * 判断一个已存在路径是否“链接样”：POSIX symlink，或 Windows junction / 任何
 * realpath 与词法路径不一致的别名。junction 的 `lstat().isSymbolicLink()` 在 Node 上
 * 为 false，因此这里必须用 realpath 复核，不能只信 lstat。
 */
function isLinkLike(target) {
  let stats;
  try {
    stats = fs.lstatSync(target);
  } catch (error) {
    return false;
  }
  if (stats.isSymbolicLink()) return true;
  try {
    return !samePath(realpathOf(target), path.resolve(target));
  } catch (error) {
    return true;
  }
}

/**
 * 安全递归删除：遇到 symlink/junction **只删链接本身**，绝不跟随到目标目录，
 * 避免清理 staging/attempt 时误删工作区之外的文件。
 */
function removeTreeSafely(target) {
  let stats;
  try {
    stats = fs.lstatSync(target);
  } catch (error) {
    return false;
  }
  if (stats.isSymbolicLink()) {
    try {
      fs.unlinkSync(target);
      return true;
    } catch (error) {
      try {
        fs.rmdirSync(target);
        return true;
      } catch (inner) {
        return false;
      }
    }
  }
  if (!stats.isDirectory()) {
    try {
      fs.unlinkSync(target);
      return true;
    } catch (error) {
      return false;
    }
  }
  if (isLinkLike(target)) {
    // Windows junction：lstat 是目录，但绝不能递归进入。
    try {
      fs.rmdirSync(target);
      return true;
    } catch (error) {
      return false;
    }
  }
  let entries;
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch (error) {
    return false;
  }
  for (const entry of entries) {
    const full = path.join(target, entry.name);
    if (!removeTreeSafely(full)) return false;
  }
  try {
    fs.rmdirSync(target);
    return true;
  } catch (error) {
    return false;
  }
}

function randomSuffix() {
  return crypto.randomBytes(4).toString('hex');
}

/**
 * 校验应用私有根目录。
 *
 * - 绝对路径、非盘符根、词法路径不得位于仓库内；
 * - **mkdir 前**先 canonical 化最近已存在祖先（lstat/realpath 拒 symlink/junction、
 *   受保护路径检查），再用逐段非递归 mkdir 创建；
 * - 创建后 root 本身仍要 lstat/realpath 一致，真实根再复核受保护目录。
 */
function resolvePrivateRoot(userDataDir, codes) {
  const profile = codes || LEGACY_CODES;
  if (typeof userDataDir !== 'string' || userDataDir.trim() === '') {
    return fail(profile.ROOT_INVALID, 'userDataDir', '必须提供应用私有数据目录');
  }
  if (CONTROL_CHAR_PATTERN.test(userDataDir)) return fail(profile.ROOT_INVALID, 'userDataDir', '路径含控制字符');
  if (!path.isAbsolute(userDataDir)) return fail(profile.ROOT_INVALID, 'userDataDir', '必须是绝对路径');
  const root = path.resolve(userDataDir);
  if (root === path.parse(root).root) return fail(profile.ROOT_INVALID, 'userDataDir', '不允许把盘符根目录当作私有工作区');
  if (isProtectedRepoDir(root)) {
    return fail(profile.PATH_PROTECTED, 'userDataDir', '私有工作区不得位于仓库内（会污染全局 templates/miniprogram/Registry）');
  }
  const canonical = ensureCanonicalDirectory(root, profile);
  if (!canonical.ok) return canonical;
  const rootReal = canonical.realDir;
  if (isProtectedRepoDir(rootReal)) {
    return fail(profile.PATH_PROTECTED, 'userDataDir', '私有数据目录的真实路径位于仓库内');
  }
  return ok({ root, rootReal });
}

/**
 * 从私有根到 target 逐段检查：已存在段不得是 symlink/junction，且真实路径必须留在根内。
 * 不存在的段直接跳过（由创建方负责），因此本函数可安全用于“即将创建”的路径。
 */
function auditPath(privateRoot, rootReal, target, codes) {
  const profile = codes || LEGACY_CODES;
  if (!isInsideOrEqual(privateRoot, target)) {
    return fail(profile.PATH_ESCAPE, target, '路径越出私有工作区根目录');
  }
  const relative = path.relative(privateRoot, target);
  if (relative === '') return ok();
  let current = privateRoot;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) continue;
    let stats;
    try {
      stats = fs.lstatSync(current);
    } catch (error) {
      return fail(profile.IO_FAILED, current, '无法读取路径：' + (error.code || error.message));
    }
    if (stats.isSymbolicLink()) {
      return fail(profile.PATH_LINK, current, '工作区内不得存在符号链接或 junction');
    }
    let real;
    try {
      real = realpathOf(current);
    } catch (error) {
      return fail(profile.IO_FAILED, current, '无法解析真实路径：' + (error.code || error.message));
    }
    // Windows junction 的 lstat 不是 symlink，但 realpath 会指向别处：这里一并拒绝。
    if (!samePath(real, current)) {
      return fail(profile.PATH_LINK, current, '工作区内不得存在符号链接或 junction（真实路径不一致）');
    }
    if (!isInsideOrEqual(rootReal, real)) {
      return fail(profile.PATH_ESCAPE, current, '真实路径越出私有工作区根目录');
    }
  }
  return ok();
}

/**
 * 逐段（非递归）创建目录：每创建/命中一段都跑一次 `auditPath`，
 * 因此绝不会沿着已存在的 reparse point（symlink/junction）往工作区外写。
 */
function ensureDirectory(privateRoot, rootReal, target, codes) {
  const profile = codes || LEGACY_CODES;
  if (typeof target !== 'string' || !path.isAbsolute(target)) {
    return fail(profile.IO_FAILED, target, '目录必须是绝对路径');
  }
  if (!isInsideOrEqual(privateRoot, target)) {
    return fail(profile.PATH_ESCAPE, target, '目录越出私有工作区根目录');
  }
  if (!fs.existsSync(privateRoot)) return fail(profile.IO_FAILED, privateRoot, '私有工作区根目录不存在');
  const relative = path.relative(privateRoot, target);
  if (relative === '') return auditPath(privateRoot, rootReal, privateRoot, profile);

  let current = privateRoot;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) {
      try {
        fs.mkdirSync(current, { recursive: false, mode: 0o700 });
      } catch (error) {
        if (error.code !== 'EEXIST') {
          return fail(profile.IO_FAILED, current, '创建目录失败：' + (error.code || error.message));
        }
      }
    }
    const audit = auditPath(privateRoot, rootReal, current, profile);
    if (!audit.ok) return audit;
  }
  return ok({ dir: current });
}

/**
 * 目录必须是“规范目录”：存在、lstat 不是符号链接、realpath 与词法路径一致。
 */
function assertCanonicalDir(target, codes) {
  const profile = codes || LEGACY_CODES;
  let stats;
  try {
    stats = fs.lstatSync(target);
  } catch (error) {
    return fail(profile.IO_FAILED, target, '目录不可读：' + (error.code || error.message));
  }
  if (stats.isSymbolicLink()) return fail(profile.PATH_LINK, target, '目录不得是符号链接');
  if (!stats.isDirectory()) return fail(profile.PATH_INVALID, target, '必须是目录');
  let real;
  try {
    real = realpathOf(target);
  } catch (error) {
    return fail(profile.IO_FAILED, target, '无法解析真实路径：' + (error.code || error.message));
  }
  if (!samePath(real, path.resolve(target))) {
    return fail(profile.PATH_LINK, target, '目录不得是 junction 或路径别名（真实路径不一致）');
  }
  return ok({ dir: path.resolve(target), realDir: real });
}

/**
 * 创建/规范化一个目录：**先 canonical 化最近已存在的祖先，再逐段非递归 mkdir**。
 * 祖先若是 symlink/junction（或真实路径落在仓库/受保护目录），在创建任何目录之前就拒绝。
 */
function ensureCanonicalDirectory(target, codes) {
  const profile = codes || LEGACY_CODES;
  if (typeof target !== 'string' || !path.isAbsolute(target)) {
    return fail(profile.IO_FAILED, target, '目录必须是绝对路径');
  }
  const resolved = path.resolve(target);
  if (CONTROL_CHAR_PATTERN.test(resolved)) return fail(profile.PATH_INVALID, resolved, '路径含控制字符');

  let existing = resolved;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  let stats;
  try {
    stats = fs.lstatSync(existing);
  } catch (error) {
    return fail(profile.IO_FAILED, existing, '无法读取最近已存在祖先：' + (error.code || error.message));
  }
  if (stats.isSymbolicLink()) {
    return fail(profile.PATH_LINK, existing, '最近已存在祖先不得是符号链接（mkdir 前拒绝）');
  }
  if (!stats.isDirectory()) {
    return fail(profile.PATH_INVALID, existing, '最近已存在祖先必须是目录');
  }
  let existingReal;
  try {
    existingReal = realpathOf(existing);
  } catch (error) {
    return fail(profile.IO_FAILED, existing, '无法解析祖先真实路径：' + (error.code || error.message));
  }
  // Windows junction 的 lstat 不是 symlink：真实路径不一致即视为链接/别名，mkdir 前拒绝。
  if (!samePath(existingReal, existing)) {
    return fail(profile.PATH_LINK, existing, '最近已存在祖先不得是 junction 或路径别名（mkdir 前拒绝）');
  }
  if (isProtectedRepoDir(existingReal)) {
    return fail(profile.PATH_PROTECTED, resolved, '目标路径经过仓库/受保护目录（mkdir 前拒绝）');
  }
  const ensured = ensureDirectory(existing, existingReal, resolved, profile);
  if (!ensured.ok) return ensured;
  return assertCanonicalDir(resolved, profile);
}

function assertId(value, pattern, code, name) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    return fail(code, name, name + ' 非法：只允许字母数字与 ._-（不得含分隔符或 ..）');
  }
  return ok();
}

/**
 * 校验规范 POSIX 相对路径（写入/读取前的唯一闸门）。
 *
 * @param {string} relative
 * @param {object} [codes] 错误码 profile
 * @param {{maxLength?:number}} [options] 旧链默认 200；Agent 侧按冻结上限传 240
 */
function assertSafeRelativePath(relative, codes, options) {
  const profile = codes || LEGACY_CODES;
  const opts = options || {};
  const maxLength = Number.isInteger(opts.maxLength) ? opts.maxLength : 200;
  if (typeof relative !== 'string' || relative === '') {
    return fail(profile.PATH_INVALID, String(relative), '必须是非空相对路径');
  }
  if (relative !== relative.trim()) return fail(profile.PATH_INVALID, relative, '路径首尾不得有空白');
  if (relative.length > maxLength) return fail(profile.PATH_INVALID, relative, '路径过长');
  if (CONTROL_CHAR_PATTERN.test(relative)) return fail(profile.PATH_INVALID, relative, '路径含控制字符');
  if (relative.includes('\\')) return fail(profile.PATH_INVALID, relative, '只接受 POSIX 相对路径');
  if (ABSOLUTE_UNC_PATTERN.test(relative)) return fail(profile.PATH_INVALID, relative, '不得是绝对路径');
  if (ABSOLUTE_POSIX_PATTERN.test(relative)) return fail(profile.PATH_INVALID, relative, '不得是绝对路径');
  if (DRIVE_PATTERN.test(relative)) return fail(profile.PATH_INVALID, relative, '不得包含盘符');
  if (relative.endsWith('/')) return fail(profile.PATH_INVALID, relative, '路径不得以 / 结尾');
  for (const segment of relative.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      return fail(profile.PATH_INVALID, relative, '路径段非法（空段/./..）');
    }
  }
  return ok({ relative });
}

/**
 * 把相对路径解析到指定根目录内，并再次确认未逃逸。
 * 目标目录必须已存在且经过 canonical 校验（调用方负责），这里只做词法层面复核。
 */
function resolveInside(root, relative, codes, options) {
  const profile = codes || LEGACY_CODES;
  const safe = assertSafeRelativePath(relative, profile, options);
  if (!safe.ok) return safe;
  const target = path.resolve(root, relative);
  if (!isInside(root, target)) return fail(profile.PATH_ESCAPE, relative, '路径越出目标目录');
  return ok({ relative, target });
}

/**
 * Agent 侧路径规范化的唯一实现：POSIX 相对路径闸门 + 长度上限 + 深度上限。
 * 仅依赖调用方传入的冻结上限（`{maxPathLength,maxDepth}`），不读 constants，避免循环依赖。
 */
function normalizeAgentRelativePath(relative, limits) {
  if (!limits || !Number.isInteger(limits.maxPathLength) || !Number.isInteger(limits.maxDepth)) {
    return fail(AGENT_CODES.PATH_INVALID, 'limits', '缺少路径长度/深度上限');
  }
  const safe = assertSafeRelativePath(relative, AGENT_CODES, { maxLength: limits.maxPathLength });
  if (!safe.ok) return safe;
  if (relative.split('/').length > limits.maxDepth) {
    return fail(AGENT_CODES.DEPTH_EXCEEDED, relative, '路径层级超过上限 ' + limits.maxDepth);
  }
  return ok({ relative });
}

/**
 * 失败体脱敏：Agent 侧不得回传本机绝对路径。
 * 路径折成相对根的形式；message 里出现私有根时替换为 `.`；超长截断。
 */
function sanitizeFailure(failure, root) {
  if (!failure || failure.ok !== false) return failure;
  let relative = '.';
  if (typeof failure.path === 'string' && failure.path !== '') {
    if (path.isAbsolute(failure.path)) {
      if (root && isInsideOrEqual(root, failure.path)) {
        relative = path.relative(root, failure.path).split(path.sep).join('/') || '.';
      }
    } else {
      relative = failure.path;
    }
  }
  let message = typeof failure.message === 'string' && failure.message ? failure.message : '操作失败';
  if (root) {
    message = message.split(root).join('.').split(root.split(path.sep).join('/')).join('.');
  }
  if (message.length > 240) message = message.slice(0, 237) + '...';
  return { ok: false, code: failure.code, path: relative, message };
}

function writeJsonAtomic(file, value, codes) {
  const profile = codes || LEGACY_CODES;
  const dir = path.dirname(file);
  const temp = path.join(dir, '.' + path.basename(file) + '.' + randomSuffix() + '.tmp');
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temp, file);
    return ok();
  } catch (error) {
    try {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    } catch (ignored) {
      /* 清理失败不掩盖原始错误 */
    }
    return fail(profile.IO_FAILED, file, '原子写入失败：' + (error.code || error.message));
  }
}

module.exports = {
  REPO_ROOT,
  LEGACY_CODES,
  AGENT_CODES,
  CONTROL_CHAR_PATTERN,
  PROJECT_ID_PATTERN,
  RUN_ID_PATTERN,
  ATTEMPT_DIR_PATTERN,
  STAGING_PATTERN,
  ok,
  fail,
  samePath,
  realpathOf,
  isInside,
  isInsideOrEqual,
  isProtectedRepoDir,
  isLinkLike,
  removeTreeSafely,
  randomSuffix,
  resolvePrivateRoot,
  auditPath,
  ensureDirectory,
  assertCanonicalDir,
  ensureCanonicalDirectory,
  assertId,
  assertSafeRelativePath,
  resolveInside,
  normalizeAgentRelativePath,
  sanitizeFailure,
  writeJsonAtomic,
};
