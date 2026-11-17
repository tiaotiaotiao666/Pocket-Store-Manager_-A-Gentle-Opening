'use strict';

/**
 * 候选前端私有工作区（P2）。
 *
 * 目录布局固定（不接受调用方任意拼路径）：
 *
 * ```
 * <userDataDir>/projects/<projectId>/frontend-runs/<runId>/
 *   run.json                    运行级元数据（attempt 列表，不含 base64/绝对路径正文）
 *   attempts/attempt-<n>/       每次物化一个独立 attempt，永不覆盖上一个
 *     candidate/                候选 FrontendPack 资产（manifest.json/src/preview）
 *     overlay/                  私有 Registry overlay（registry.v1.json + lock + assets）
 *     attempt.json              attempt 元数据（候选摘要、文件清单、状态）
 * ```
 *
 * 安全规则（每条都 fail closed）：
 * - `userDataDir` 是**应用私有数据目录**（Electron `app.getPath('userData')`），必须是
 *   绝对路径，且不得位于仓库内（尤其 `templates/`、`miniprogram/`）；因此候选文件不可能
 *   出现在全局 Registry/模板/镜像里。
 * - `projectId`/`runId` 必须匹配固定字符集，禁止 `/`、`\`、`..`、盘符、控制字符。
 * - 任何已存在的路径段只要命中 symlink/junction（realpath 与词法路径不一致）即拒绝。
 * - 所有 attempt 子路径都必须是规范 POSIX 相对路径，拒绝绝对路径/`..`/反斜杠/盘符。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const PROJECTS_DIR = 'projects';
const RUNS_DIR = 'frontend-runs';
const ATTEMPTS_DIR = 'attempts';
const RUN_FILE = 'run.json';
const ATTEMPT_FILE = 'attempt.json';
const ATTEMPT_DIR_PATTERN = /^attempt-([1-9][0-9]{0,3})$/;
const STAGING_PATTERN = /^\.staging-[0-9a-f]{8}$/;
const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RUN_ID_PATTERN = /^frun-[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/;
const DRIVE_PATTERN = /^[A-Za-z]:/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;

const CODES = Object.freeze({
  ROOT_INVALID: 'WORKSPACE_ROOT_INVALID',
  PROJECT_ID_INVALID: 'WORKSPACE_PROJECT_ID_INVALID',
  RUN_ID_INVALID: 'WORKSPACE_RUN_ID_INVALID',
  PATH_REJECTED: 'WORKSPACE_PATH_REJECTED',
  ATTEMPT_FAILED: 'WORKSPACE_ATTEMPT_FAILED',
  IO_FAILED: 'WORKSPACE_IO_FAILED',
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
 * 规则（P2 repair-3 / T18-F2）：
 * - 绝对路径、非盘符根、词法路径不得位于仓库内；
 * - **mkdir 前**先 canonical 化最近已存在祖先（lstat/realpath 拒 symlink/junction、
 *   受保护路径检查），再用逐段非递归 mkdir 创建，因此祖先 junction + 缺失根不会
 *   在链接目标里留下新目录；
 * - 创建后 root 本身仍要 lstat/realpath 一致，真实根再复核受保护目录。
 *
 * @returns {{ok:true, root:string, rootReal:string}|{ok:false, code:string, path:string, message:string}}
 */
function resolvePrivateRoot(userDataDir) {
  if (typeof userDataDir !== 'string' || userDataDir.trim() === '') {
    return fail(CODES.ROOT_INVALID, 'userDataDir', '必须提供应用私有数据目录');
  }
  if (CONTROL_CHAR_PATTERN.test(userDataDir)) return fail(CODES.ROOT_INVALID, 'userDataDir', '路径含控制字符');
  if (!path.isAbsolute(userDataDir)) return fail(CODES.ROOT_INVALID, 'userDataDir', '必须是绝对路径');
  const root = path.resolve(userDataDir);
  if (root === path.parse(root).root) return fail(CODES.ROOT_INVALID, 'userDataDir', '不允许把盘符根目录当作私有工作区');
  if (isProtectedRepoDir(root)) {
    return fail(CODES.PATH_REJECTED, 'userDataDir', '私有工作区不得位于仓库内（会污染全局 templates/miniprogram/Registry）');
  }
  const canonical = ensureCanonicalDirectory(root);
  if (!canonical.ok) return canonical;
  const rootReal = canonical.realDir;
  if (isProtectedRepoDir(rootReal)) {
    return fail(CODES.PATH_REJECTED, 'userDataDir', '私有数据目录的真实路径位于仓库内');
  }
  return ok({ root, rootReal });
}

/**
 * 从私有根到 target 逐段检查：已存在段不得是 symlink/junction，且真实路径必须留在根内。
 * 不存在的段直接跳过（由创建方负责），因此本函数可安全用于“即将创建”的路径。
 */
function auditPath(privateRoot, rootReal, target) {
  if (!isInsideOrEqual(privateRoot, target)) {
    return fail(CODES.PATH_REJECTED, target, '路径越出私有工作区根目录');
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
      return fail(CODES.IO_FAILED, current, '无法读取路径：' + (error.code || error.message));
    }
    if (stats.isSymbolicLink()) {
      return fail(CODES.PATH_REJECTED, current, '工作区内不得存在符号链接或 junction');
    }
    let real;
    try {
      real = realpathOf(current);
    } catch (error) {
      return fail(CODES.IO_FAILED, current, '无法解析真实路径：' + (error.code || error.message));
    }
    // Windows junction 的 lstat 不是 symlink，但 realpath 会指向别处：这里一并拒绝。
    if (!samePath(real, current)) {
      return fail(CODES.PATH_REJECTED, current, '工作区内不得存在符号链接或 junction（真实路径不一致）');
    }
    if (!isInsideOrEqual(rootReal, real)) {
      return fail(CODES.PATH_REJECTED, current, '真实路径越出私有工作区根目录');
    }
  }
  return ok();
}

/**
 * 逐段（非递归）创建目录：每创建/命中一段都跑一次 `auditPath`，
 * 因此绝不会沿着已存在的 reparse point（symlink/junction）往工作区外写。
 *
 * `privateRoot`/`rootReal` 必须是 `resolvePrivateRoot` 校验过的私有根及其真实路径。
 */
function ensureDirectory(privateRoot, rootReal, target) {
  if (typeof target !== 'string' || !path.isAbsolute(target)) {
    return fail(CODES.IO_FAILED, target, '目录必须是绝对路径');
  }
  if (!isInsideOrEqual(privateRoot, target)) {
    return fail(CODES.PATH_REJECTED, target, '目录越出私有工作区根目录');
  }
  if (!fs.existsSync(privateRoot)) return fail(CODES.IO_FAILED, privateRoot, '私有工作区根目录不存在');
  const relative = path.relative(privateRoot, target);
  if (relative === '') return auditPath(privateRoot, rootReal, privateRoot);

  let current = privateRoot;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) {
      try {
        fs.mkdirSync(current, { recursive: false, mode: 0o700 });
      } catch (error) {
        if (error.code !== 'EEXIST') {
          return fail(CODES.IO_FAILED, current, '创建目录失败：' + (error.code || error.message));
        }
      }
    }
    const audit = auditPath(privateRoot, rootReal, current);
    if (!audit.ok) return audit;
  }
  return ok({ dir: current });
}

/**
 * 目录必须是“规范目录”：存在、lstat 不是符号链接、realpath 与词法路径一致。
 * 用于 staging 目录创建后的立即复核（防止创建与写入之间被替换成 junction）。
 */
function assertCanonicalDir(target) {
  let stats;
  try {
    stats = fs.lstatSync(target);
  } catch (error) {
    return fail(CODES.IO_FAILED, target, '目录不可读：' + (error.code || error.message));
  }
  if (stats.isSymbolicLink()) return fail(CODES.PATH_REJECTED, target, '目录不得是符号链接');
  if (!stats.isDirectory()) return fail(CODES.PATH_REJECTED, target, '必须是目录');
  let real;
  try {
    real = realpathOf(target);
  } catch (error) {
    return fail(CODES.IO_FAILED, target, '无法解析真实路径：' + (error.code || error.message));
  }
  if (!samePath(real, path.resolve(target))) {
    return fail(CODES.PATH_REJECTED, target, '目录不得是 junction 或路径别名（真实路径不一致）');
  }
  return ok({ dir: path.resolve(target), realDir: real });
}

/**
 * 创建/规范化一个目录（P2 repair-3 / T18-F2）。
 *
 * 关键顺序：**先 canonical 化最近已存在的祖先，再逐段非递归 mkdir**。
 * 祖先若是 symlink/junction（或真实路径落在仓库/受保护目录），在创建任何目录之前就拒绝，
 * 因此“祖先 junction + 缺失根”不会在链接目标里留下新目录。
 *
 * @returns {{ok:true, dir:string, realDir:string}|{ok:false, code:string, path:string, message:string}}
 */
function ensureCanonicalDirectory(target) {
  if (typeof target !== 'string' || !path.isAbsolute(target)) {
    return fail(CODES.IO_FAILED, target, '目录必须是绝对路径');
  }
  const resolved = path.resolve(target);
  if (CONTROL_CHAR_PATTERN.test(resolved)) return fail(CODES.PATH_REJECTED, resolved, '路径含控制字符');

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
    return fail(CODES.IO_FAILED, existing, '无法读取最近已存在祖先：' + (error.code || error.message));
  }
  if (stats.isSymbolicLink()) {
    return fail(CODES.PATH_REJECTED, existing, '最近已存在祖先不得是符号链接（mkdir 前拒绝）');
  }
  if (!stats.isDirectory()) {
    return fail(CODES.PATH_REJECTED, existing, '最近已存在祖先必须是目录');
  }
  let existingReal;
  try {
    existingReal = realpathOf(existing);
  } catch (error) {
    return fail(CODES.IO_FAILED, existing, '无法解析祖先真实路径：' + (error.code || error.message));
  }
  // Windows junction 的 lstat 不是 symlink：真实路径不一致即视为链接/别名，mkdir 前拒绝。
  if (!samePath(existingReal, existing)) {
    return fail(CODES.PATH_REJECTED, existing, '最近已存在祖先不得是 junction 或路径别名（mkdir 前拒绝）');
  }
  if (isProtectedRepoDir(existingReal)) {
    return fail(CODES.PATH_REJECTED, resolved, '目标路径经过仓库/受保护目录（mkdir 前拒绝）');
  }
  const ensured = ensureDirectory(existing, existingReal, resolved);
  if (!ensured.ok) return ensured;
  return assertCanonicalDir(resolved);
}

function assertId(value, pattern, code, name) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    return fail(code, name, name + ' 非法：只允许字母数字与 ._-（不得含分隔符或 ..）');
  }
  return ok();
}

/**
 * 计算（不创建）固定布局的工作区路径。
 */
function workspacePaths(options) {
  const opts = options || {};
  const rootResult = resolvePrivateRoot(opts.userDataDir);
  if (!rootResult.ok) return rootResult;
  const projectIdCheck = assertId(opts.projectId, PROJECT_ID_PATTERN, CODES.PROJECT_ID_INVALID, 'projectId');
  if (!projectIdCheck.ok) return projectIdCheck;
  const runIdCheck = assertId(opts.runId, RUN_ID_PATTERN, CODES.RUN_ID_INVALID, 'runId');
  if (!runIdCheck.ok) return runIdCheck;

  const projectDir = path.join(rootResult.root, PROJECTS_DIR, opts.projectId);
  const runDir = path.join(projectDir, RUNS_DIR, opts.runId);
  const audit = auditPath(rootResult.root, rootResult.rootReal, runDir);
  if (!audit.ok) return audit;

  return ok({
    userDataDir: rootResult.root,
    userDataReal: rootResult.rootReal,
    projectId: opts.projectId,
    runId: opts.runId,
    projectDir,
    runDir,
    attemptsDir: path.join(runDir, ATTEMPTS_DIR),
    runFile: path.join(runDir, RUN_FILE),
  });
}

/**
 * 创建/打开运行工作区。重复调用幂等，但不会覆盖已有 run.json 的 attempts。
 *
 * 目录用 `ensureDirectory` 逐段（非递归）创建：每一段创建后立即 audit，
 * 因此即使 `projects`/`frontend-runs`/`attempts` 中任意一段被预先换成
 * symlink/junction，也会在写入任何内容前失败。
 */
function createWorkspace(options) {
  const paths = workspacePaths(options);
  if (!paths.ok) return paths;
  for (const dir of [paths.projectDir, paths.runDir, paths.attemptsDir]) {
    const ensured = ensureDirectory(paths.userDataDir, paths.userDataReal, dir);
    if (!ensured.ok) return ensured;
  }
  const audit = auditPath(paths.userDataDir, paths.userDataReal, paths.attemptsDir);
  if (!audit.ok) return audit;

  let run = null;
  if (fs.existsSync(paths.runFile)) {
    try {
      run = JSON.parse(fs.readFileSync(paths.runFile, 'utf8'));
    } catch (error) {
      return fail(CODES.IO_FAILED, paths.runFile, 'run.json 无法解析');
    }
    if (!run || run.schemaVersion !== 'frontend-run.v1' || run.projectId !== paths.projectId || run.runId !== paths.runId) {
      return fail(CODES.PATH_REJECTED, paths.runFile, 'run.json 与请求的工作区身份不一致');
    }
  } else {
    run = {
      schemaVersion: 'frontend-run.v1',
      projectId: paths.projectId,
      runId: paths.runId,
      createdAt: new Date().toISOString(),
      attempts: [],
    };
    const write = writeJsonAtomic(paths.runFile, run);
    if (!write.ok) return write;
  }
  return ok({ ...paths, run });
}

function writeJsonAtomic(file, value) {
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
    return fail(CODES.IO_FAILED, file, '原子写入失败：' + (error.code || error.message));
  }
}

function listAttempts(workspace) {
  const dir = workspace.attemptsDir || workspace;
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const match = ATTEMPT_DIR_PATTERN.exec(entry.name);
    if (!match || !entry.isDirectory()) continue;
    out.push(Number(match[1]));
  }
  return out.sort((a, b) => a - b);
}

/**
 * 分配并独占创建下一个 attempt（以及其 staging 目录）。
 *
 * 关键点：
 * - `attempt-<n>` 用**非递归** mkdir 独占创建，不会复用/覆盖上一个 attempt；
 * - 创建后逐段 audit（`ensureDirectory`），并立即复核 attempt 与 staging 的
 *   lstat + realpath，防止创建与首次写入之间被替换成 junction；
 * - 失败时由调用方用 `removeAttempt` 清理本次目录（清理本身也不会跟随链接）。
 */
function beginAttempt(workspace) {
  const attemptsDir = workspace.attemptsDir;
  if (!attemptsDir) return fail(CODES.ATTEMPT_FAILED, 'attemptsDir', '工作区缺少 attempts 目录');
  if (!fs.existsSync(attemptsDir)) return fail(CODES.ATTEMPT_FAILED, attemptsDir, '工作区尚未创建');
  // 写任何东西之前先证明 attempts 目录本身没有被换成 symlink/junction。
  const attemptsAudit = auditPath(workspace.userDataDir, workspace.userDataReal, attemptsDir);
  if (!attemptsAudit.ok) return attemptsAudit;

  const existing = listAttempts(workspace);
  let attempt = existing.length === 0 ? 1 : existing[existing.length - 1] + 1;
  for (let tryIndex = 0; tryIndex < 8; tryIndex += 1) {
    const attemptDir = path.join(attemptsDir, 'attempt-' + attempt);
    try {
      fs.mkdirSync(attemptDir, { recursive: false, mode: 0o700 });
    } catch (error) {
      if (error.code === 'EEXIST') {
        attempt += 1;
        continue;
      }
      return fail(CODES.ATTEMPT_FAILED, attemptDir, '无法创建 attempt 目录：' + (error.code || error.message));
    }
    const attemptEnsured = ensureDirectory(workspace.userDataDir, workspace.userDataReal, attemptDir);
    const attemptCanonical = attemptEnsured.ok ? assertCanonicalDir(attemptDir) : attemptEnsured;
    if (!attemptCanonical.ok) {
      removeAttempt(attemptDir, attemptsDir);
      return attemptCanonical;
    }
    const stagingDir = path.join(attemptDir, '.staging-' + randomSuffix());
    try {
      fs.mkdirSync(stagingDir, { recursive: false, mode: 0o700 });
    } catch (error) {
      removeAttempt(attemptDir, attemptsDir);
      return fail(CODES.ATTEMPT_FAILED, stagingDir, '无法创建 staging 目录：' + (error.code || error.message));
    }
    const stagingEnsured = ensureDirectory(workspace.userDataDir, workspace.userDataReal, stagingDir);
    const stagingCanonical = stagingEnsured.ok ? assertCanonicalDir(stagingDir) : stagingEnsured;
    if (!stagingCanonical.ok) {
      removeAttempt(attemptDir, attemptsDir);
      return stagingCanonical;
    }
    return ok({ attempt, attemptDir, stagingDir, attemptsDir, stagingReal: stagingCanonical.realDir });
  }
  return fail(CODES.ATTEMPT_FAILED, attemptsDir, 'attempt 目录分配冲突过多');
}

/**
 * 清理本次未提交的 attempt。只接受 attempts/<attempt-n> 形状，父目录必须是本工作区的
 * attempts 目录；且目标不得是 symlink/junction。删除用 `removeTreeSafely`，
 * 遇到链接只删链接本身，绝不跟随到工作区之外。
 */
function removeAttempt(attemptDir, attemptsDir) {
  if (typeof attemptDir !== 'string' || typeof attemptsDir !== 'string') return false;
  if (!ATTEMPT_DIR_PATTERN.test(path.basename(attemptDir))) return false;
  if (!samePath(path.dirname(attemptDir), attemptsDir)) return false;
  let stats;
  try {
    stats = fs.lstatSync(attemptDir);
  } catch (error) {
    return false;
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) return false;
  try {
    const attemptsReal = realpathOf(attemptsDir);
    const attemptReal = realpathOf(attemptDir);
    if (!samePath(path.dirname(attemptReal), attemptsReal)) return false;
  } catch (error) {
    return false;
  }
  return removeTreeSafely(attemptDir);
}

/** 清理 attempt 内的 staging（只有本进程命名的 `.staging-<8hex>` 才允许删；不跟随链接）。 */
function removeStaging(stagingDir, attemptDir) {
  if (typeof stagingDir !== 'string' || typeof attemptDir !== 'string') return false;
  if (!STAGING_PATTERN.test(path.basename(stagingDir))) return false;
  if (!samePath(path.dirname(stagingDir), attemptDir)) return false;
  let stats;
  try {
    stats = fs.lstatSync(stagingDir);
  } catch (error) {
    return false;
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) return false;
  try {
    if (!samePath(path.dirname(realpathOf(stagingDir)), realpathOf(attemptDir))) return false;
  } catch (error) {
    return false;
  }
  return removeTreeSafely(stagingDir);
}

/**
 * 校验规范 POSIX 相对路径（写入 attempt 内的每个文件都必须先过这一关）。
 */
function assertSafeRelativePath(relative) {
  if (typeof relative !== 'string' || relative === '') {
    return fail(CODES.PATH_REJECTED, String(relative), '必须是非空相对路径');
  }
  if (relative !== relative.trim()) return fail(CODES.PATH_REJECTED, relative, '路径首尾不得有空白');
  if (relative.length > 200) return fail(CODES.PATH_REJECTED, relative, '路径过长');
  if (CONTROL_CHAR_PATTERN.test(relative)) return fail(CODES.PATH_REJECTED, relative, '路径含控制字符');
  if (relative.includes('\\')) return fail(CODES.PATH_REJECTED, relative, '只接受 POSIX 相对路径');
  if (relative.startsWith('/')) return fail(CODES.PATH_REJECTED, relative, '不得是绝对路径');
  if (DRIVE_PATTERN.test(relative)) return fail(CODES.PATH_REJECTED, relative, '不得包含盘符');
  for (const segment of relative.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      return fail(CODES.PATH_REJECTED, relative, '路径段非法（空段/./..）');
    }
  }
  return ok({ relative });
}

/** 把相对路径解析到指定根目录内，并再次确认未逃逸。 */
function resolveInside(root, relative) {
  const safe = assertSafeRelativePath(relative);
  if (!safe.ok) return safe;
  const target = path.resolve(root, relative);
  if (!isInside(root, target)) return fail(CODES.PATH_REJECTED, relative, '路径越出目标目录');
  return ok({ relative, target });
}

/** 读取 run.json（不存在或损坏时返回 null，调用方决定如何降级）。 */
function readRun(workspace) {
  if (!fs.existsSync(workspace.runFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(workspace.runFile, 'utf8'));
  } catch (error) {
    return null;
  }
}

/** 追加 attempt 记录（原子写 run.json）。 */
function recordAttempt(workspace, entry) {
  const run = readRun(workspace) || {
    schemaVersion: 'frontend-run.v1',
    projectId: workspace.projectId,
    runId: workspace.runId,
    createdAt: new Date().toISOString(),
    attempts: [],
  };
  if (!Array.isArray(run.attempts)) run.attempts = [];
  const attempts = run.attempts.filter((item) => item && item.attempt !== entry.attempt);
  attempts.push(entry);
  attempts.sort((a, b) => a.attempt - b.attempt);
  run.attempts = attempts;
  run.latestAttempt = entry.attempt;
  return writeJsonAtomic(workspace.runFile, run);
}

module.exports = {
  REPO_ROOT,
  PROJECTS_DIR,
  RUNS_DIR,
  ATTEMPTS_DIR,
  RUN_FILE,
  ATTEMPT_FILE,
  CODES,
  PROJECT_ID_PATTERN,
  RUN_ID_PATTERN,
  ATTEMPT_DIR_PATTERN,
  STAGING_PATTERN,
  isInside,
  isInsideOrEqual,
  isProtectedRepoDir,
  isLinkLike,
  samePath,
  realpathOf,
  resolvePrivateRoot,
  workspacePaths,
  createWorkspace,
  beginAttempt,
  removeAttempt,
  removeStaging,
  removeTreeSafely,
  auditPath,
  ensureDirectory,
  ensureCanonicalDirectory,
  assertCanonicalDir,
  assertSafeRelativePath,
  resolveInside,
  writeJsonAtomic,
  readRun,
  recordAttempt,
  listAttempts,
};
