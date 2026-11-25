'use strict';

/**
 * E0-V1 独立验证器：环境与临时 userData。
 *
 * 铁律（对应 `docs/evidence/workspace-agent/e0-v1/plan.md` §0）：
 * 1. 只允许在**系统临时目录**下创建 userData；绝不使用项目真实 userData（`app-data`）、
 *    用户 AppData 下的真实 `智能开店app` 目录，也不写仓库内任何项目数据目录。
 * 2. 临时目录自建自清：`run.cjs` 在 finally 清理并断言已删除。
 * 3. 本目录只做“环境/守卫”能力，不含任何被测实现逻辑（不复制 B1/B2/B4/E0 实现）。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/** 仓库内被视为“项目真实数据”的目录：验证器运行前后必须逐字节等价（只比清单+大小，不读内容）。 */
const REPO_DATA_DIRS = ['app-data', 'generated-projects', 'generated-projects-test'];

function realpathOrNull(target) {
  try {
    return typeof fs.realpathSync.native === 'function'
      ? fs.realpathSync.native(target)
      : fs.realpathSync(target);
  } catch {
    return null;
  }
}

function normalizeForCompare(target) {
  const resolved = path.resolve(target);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isInside(parent, child) {
  const base = normalizeForCompare(parent);
  const target = normalizeForCompare(child);
  if (base === target) return true;
  const prefix = base.endsWith(path.sep) ? base : base + path.sep;
  return target.startsWith(prefix);
}

function repoRoot() {
  return REPO_ROOT;
}

/** 用户真实 userData 候选（只用于“禁止写入”断言，不用于任何读写）。 */
function forbiddenUserDataRoots() {
  const roots = [path.join(REPO_ROOT, 'app-data')];
  const appData = process.env.APPDATA;
  if (typeof appData === 'string' && appData) roots.push(path.join(appData, '智能开店app'));
  const localAppData = process.env.LOCALAPPDATA;
  if (typeof localAppData === 'string' && localAppData) roots.push(path.join(localAppData, '智能开店app'));
  return roots;
}

function assertTempRootIsSafe(tempReal) {
  if (typeof tempReal !== 'string' || !tempReal) throw new Error('临时 userData 路径缺失');
  const tmpReal = realpathOrNull(os.tmpdir());
  if (!tmpReal) throw new Error('无法解析系统临时目录');
  if (!isInside(tmpReal, tempReal)) {
    throw new Error('临时 userData 不在系统临时目录内：' + '<temp>');
  }
  if (isInside(REPO_ROOT, tempReal)) {
    throw new Error('临时 userData 落在仓库目录内（禁止）：' + '<repo>');
  }
  for (const forbidden of forbiddenUserDataRoots()) {
    if (isInside(forbidden, tempReal) || isInside(tempReal, forbidden)) {
      throw new Error('临时 userData 与项目真实 userData 重叠（禁止）');
    }
  }
  return true;
}

/**
 * 创建临时 userData 根。形状与 Electron `app.getPath('userData')` 一致：
 * `<temp>/projects/<projectId>/agent-workspace/...`。
 */
function createTempUserData(options) {
  const opts = options || {};
  const prefix = typeof opts.prefix === 'string' && opts.prefix ? opts.prefix : 'dsh-e0v1-';
  const tmpReal = realpathOrNull(os.tmpdir());
  if (!tmpReal) throw new Error('无法解析系统临时目录');
  const dir = fs.mkdtempSync(path.join(tmpReal, prefix));
  const real = realpathOrNull(dir) || dir;
  assertTempRootIsSafe(real);

  let disposed = false;
  return {
    prefix,
    dir,
    real,
    projectsDir: path.join(real, 'projects'),
    projectDirOf(projectId) {
      return path.join(real, 'projects', projectId);
    },
    exists() {
      return fs.existsSync(real);
    },
    dispose() {
      if (disposed) return true;
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      disposed = true;
      const gone = !fs.existsSync(real);
      if (!gone) throw new Error('临时 userData 未能清理干净：' + '<temp>');
      return gone;
    },
  };
}

/** 目录指纹：只记相对路径 + 字节数（不读内容、不入库），用于“仓库零写入”断言。 */
function fingerprintDir(dir) {
  const absolute = path.isAbsolute(dir) ? dir : path.join(REPO_ROOT, dir);
  if (!fs.existsSync(absolute)) return { exists: false, files: 0, digest: null };
  const rows = [];
  const walk = (current, rel) => {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const childRel = rel ? rel + '/' + entry.name : entry.name;
      const childAbs = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        rows.push(childRel + '\tsymlink');
        continue;
      }
      if (entry.isDirectory()) {
        walk(childAbs, childRel);
        continue;
      }
      if (entry.isFile()) {
        const stat = fs.statSync(childAbs);
        rows.push(childRel + '\t' + stat.size);
      }
    }
  };
  walk(absolute, '');
  const digest = 'sha256:' + crypto.createHash('sha256').update(rows.join('\n'), 'utf8').digest('hex');
  return { exists: true, files: rows.length, digest };
}

/** 仓库数据目录指纹快照（运行前/后比对）。 */
function snapshotRepoDataDirs() {
  const snapshot = {};
  for (const name of REPO_DATA_DIRS) snapshot[name] = fingerprintDir(path.join(REPO_ROOT, name));
  return snapshot;
}

function diffRepoDataDirs(before, after) {
  const changed = [];
  for (const name of Object.keys(before)) {
    const a = before[name];
    const b = after[name] || { exists: false, files: 0, digest: null };
    if (a.exists !== b.exists || a.digest !== b.digest) {
      changed.push({ dir: name, before: a.digest, after: b.digest });
    }
  }
  return changed;
}

/** 脱敏：证据里不出现仓库绝对路径与临时绝对路径。 */
function sanitize(text, tempReal) {
  let value = String(text === undefined || text === null ? '' : text);
  if (tempReal) value = value.split(tempReal).join('<temp>');
  value = value.split(REPO_ROOT).join('<repo>');
  value = value.replace(/[A-Za-z]:\\\\?[^\s"']+/g, '<abs>');
  value = value.replace(/[A-Za-z]:\/[^\s"']+/g, '<abs>');
  return value;
}

/** 深度脱敏：用于 observed 里的路径/字符串（对象与数组递归，只改字符串值）。 */
function sanitizeDeep(value, tempReal) {
  if (typeof value === 'string') return sanitize(value, tempReal);
  if (Array.isArray(value)) return value.map((item) => sanitizeDeep(item, tempReal));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = sanitizeDeep(item, tempReal);
    return out;
  }
  return value;
}

module.exports = {
  REPO_ROOT,
  REPO_DATA_DIRS,
  repoRoot,
  realpathOrNull,
  isInside,
  normalizeForCompare,
  forbiddenUserDataRoots,
  assertTempRootIsSafe,
  createTempUserData,
  fingerprintDir,
  snapshotRepoDataDirs,
  diffRepoDataDirs,
  sanitize,
  sanitizeDeep,
};
