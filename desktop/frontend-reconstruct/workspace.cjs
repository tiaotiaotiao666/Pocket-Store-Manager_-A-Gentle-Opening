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
 *
 * 路径安全实现与 `desktop/agent-workspace/paths.cjs` **同源**（B1 抽取，唯一一份）：
 * 这里只保留候选链自己的领域逻辑（固定布局、attempt 独占分配、run.json），
 * 共享函数直接再导出，禁止在这里复制第二份 lstat/realpath/mkdir 逻辑。
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * 契约常量必须**直接**从生成契约取（`test/frontend-contract.test.cjs` 的单一源断言
 * 要求本文件直接 `require('./contract.generated.cjs')`）。
 * 安全路径函数继续复用 `desktop/agent-workspace/paths.cjs` 的同一实现，不复制第二份。
 */
const { PROJECT_ID_PATTERN, RUN_ID_PATTERN } = require('./contract.generated.cjs');

const {
  LEGACY_CODES,
  ATTEMPT_DIR_PATTERN,
  STAGING_PATTERN,
  REPO_ROOT,
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
  writeJsonAtomic,
} = require('../agent-workspace/paths.cjs');

const CODES = LEGACY_CODES;

const PROJECTS_DIR = 'projects';
const RUNS_DIR = 'frontend-runs';
const ATTEMPTS_DIR = 'attempts';
const RUN_FILE = 'run.json';
const ATTEMPT_FILE = 'attempt.json';

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
  // 共享安全路径实现（与 desktop/agent-workspace/paths.cjs 是同一份引用）。
  isInside,
  isInsideOrEqual,
  isProtectedRepoDir,
  isLinkLike,
  samePath,
  realpathOf,
  randomSuffix,
  assertId,
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
