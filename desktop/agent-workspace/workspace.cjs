'use strict';

/**
 * B1 Workspace Agent 私有工作区（纯主进程）。
 *
 * 固定布局（冻结文档 §1.3）：
 *
 * ```
 * <userData>/projects/<projectId>/agent-workspace/
 *   project.json                         元数据（B2 维护版本指针，B1 不写版本字段）
 *   versions/<versionId>/source/**       B2；B1 只读它作为“已采用版本”来源
 *   runs/<runId>/
 *     run.json
 *     turns/<turnId>/
 *       turn.json
 *       attempts/attempt-<n>/
 *         attempt.json
 *         candidate/**                   工作树（B1 读写对象）
 *         verification/**                B3/B4 证据
 * ```
 *
 * 安全边界：
 * - 所有写入必须落在调用方传入的 userData 私有根内；仓库内根一律拒绝；
 * - 目录逐段非递归创建并 lstat/realpath 复核（拒绝 symlink/junction）；
 * - 工作树来源只有两种：Base 真源或已采用版本 `versions/<versionId>/source`；
 * - 错误体不回传本机绝对路径（`sanitizeFailure`）。
 */

const fs = require('node:fs');
const path = require('node:path');

const {
  REPO_ROOT,
  ok,
  fail,
  sanitizeFailure,
  resolvePrivateRoot,
  auditPath,
  ensureDirectory,
  assertCanonicalDir,
  assertId,
  samePath,
  realpathOf,
  removeTreeSafely,
  isInsideOrEqual,
  assertSafeRelativePath,
  writeJsonAtomic,
  PROJECT_ID_PATTERN,
} = require('./paths.cjs');
const {
  CODES,
  LIMITS,
  resolveLimits,
  normalizeRelativePath,
  SCHEMAS,
  LAYOUT,
  RUN_ID_PATTERN,
  TURN_ID_PATTERN,
  ATTEMPT_ID_PATTERN,
  VERSION_ID_PATTERN,
  BASE_TEMPLATE_ID,
  BASE_TEMPLATE_VERSION,
  BASE_SOURCE_RELATIVE,
} = require('./constants.cjs');
const manifestMod = require('./manifest.cjs');
const transactions = require('./transactions.cjs');

const BASE_SOURCE_DIR = path.join(REPO_ROOT, ...BASE_SOURCE_RELATIVE);

function nowIso() {
  return new Date().toISOString();
}

function guardWorkspace(workspace) {
  if (!workspace || typeof workspace !== 'object') {
    return fail(CODES.ARGUMENT_INVALID, 'workspace', '缺少 workspace 句柄');
  }
  if (typeof workspace.userDataDir !== 'string' || typeof workspace.workspaceDir !== 'string'
    || typeof workspace.runsDir !== 'string' || typeof workspace.versionsDir !== 'string') {
    return fail(CODES.ARGUMENT_INVALID, 'workspace', 'workspace 句柄缺少私有根/布局字段');
  }
  return ok();
}

function guardAttemptHandle(attempt) {
  if (!attempt || typeof attempt !== 'object') {
    return fail(CODES.ARGUMENT_INVALID, 'attempt', '缺少 attempt 句柄');
  }
  if (typeof attempt.candidateDir !== 'string' || typeof attempt.attemptDir !== 'string'
    || typeof attempt.attemptFile !== 'string') {
    return fail(CODES.ARGUMENT_INVALID, 'attempt', 'attempt 句柄缺少工作树字段');
  }
  return ok();
}

/** attempt 允许 `3` 或 `attempt-3`（其余一律非法，防止拼路径）。 */
function parseAttemptNumber(value) {
  if (Number.isInteger(value)) {
    if (value < 1 || value > 9999) return null;
    return value;
  }
  if (typeof value === 'string') {
    const matched = ATTEMPT_ID_PATTERN.exec(value);
    if (!matched) return null;
    return Number(matched[1]);
  }
  return null;
}

function attemptIdOf(attemptNumber) {
  return 'attempt-' + attemptNumber;
}

/** 纯路径推导（不创建任何目录），所有登录点共用同一份布局逻辑。 */
function derivePaths(options, includeAttempt) {
  const opts = options || {};
  const projectIdCheck = assertId(opts.projectId, PROJECT_ID_PATTERN, CODES.PROJECT_ID_INVALID, 'projectId');
  if (!projectIdCheck.ok) return projectIdCheck;

  let attemptNumber = null;
  let runId = null;
  let turnId = null;
  if (includeAttempt || opts.runId !== undefined) {
    const runIdCheck = assertId(opts.runId, RUN_ID_PATTERN, CODES.ID_INVALID, 'runId');
    if (!runIdCheck.ok) return runIdCheck;
    runId = opts.runId;
  }
  if (includeAttempt || opts.turnId !== undefined) {
    const turnIdCheck = assertId(opts.turnId, TURN_ID_PATTERN, CODES.ID_INVALID, 'turnId');
    if (!turnIdCheck.ok) return turnIdCheck;
    turnId = opts.turnId;
  }
  if (includeAttempt) {
    attemptNumber = parseAttemptNumber(opts.attempt);
    if (attemptNumber === null) return fail(CODES.ID_INVALID, 'attempt', 'attempt 非法（必须是 attempt-<1..9999>）');
  }

  const rootResult = resolvePrivateRoot(opts.userDataDir, CODES);
  if (!rootResult.ok) return sanitizeFailure(rootResult, typeof opts.userDataDir === 'string' ? opts.userDataDir : undefined);

  const projectDir = path.join(rootResult.root, 'projects', opts.projectId);
  const workspaceDir = path.join(projectDir, LAYOUT.workspaceDir);
  const versionsDir = path.join(workspaceDir, LAYOUT.versionsDir);
  const runsDir = path.join(workspaceDir, LAYOUT.runsDir);
  const projectFile = path.join(workspaceDir, LAYOUT.projectFile);
  const runDir = runId ? path.join(runsDir, runId) : null;
  const runFile = runDir ? path.join(runDir, LAYOUT.runFile) : null;
  const turnDir = runDir && turnId ? path.join(runDir, LAYOUT.turnsDir, turnId) : null;
  const turnFile = turnDir ? path.join(turnDir, LAYOUT.turnFile) : null;
  const attemptsDir = turnDir ? path.join(turnDir, LAYOUT.attemptsDir) : null;

  let attemptDir = null;
  let candidateDir = null;
  let verificationDir = null;
  let attemptFile = null;
  if (includeAttempt) {
    attemptDir = path.join(attemptsDir, attemptIdOf(attemptNumber));
    candidateDir = path.join(attemptDir, LAYOUT.candidateDir);
    verificationDir = path.join(attemptDir, LAYOUT.verificationDir);
    attemptFile = path.join(attemptDir, LAYOUT.attemptFile);
  }

  const auditTarget = includeAttempt ? attemptDir : workspaceDir;
  const audited = auditPath(rootResult.root, rootResult.rootReal, auditTarget, CODES);
  if (!audited.ok) return sanitizeFailure(audited, rootResult.root);

  return ok({
    root: rootResult.root,
    rootReal: rootResult.rootReal,
    projectId: opts.projectId,
    runId,
    turnId,
    attempt: attemptNumber,
    attemptId: includeAttempt ? attemptIdOf(attemptNumber) : null,
    projectDir,
    workspaceDir,
    projectFile,
    versionsDir,
    runsDir,
    runDir,
    runFile,
    turnDir,
    turnFile,
    attemptsDir,
    attemptDir,
    candidateDir,
    verificationDir,
    attemptFile,
  });
}

function workspacePaths(options) {
  const opts = options || {};
  const derived = derivePaths({ userDataDir: opts.userDataDir, projectId: opts.projectId }, false);
  if (!derived.ok) return derived;
  return ok({
    root: derived.root,
    rootReal: derived.rootReal,
    projectId: derived.projectId,
    projectDir: derived.projectDir,
    workspaceDir: derived.workspaceDir,
    projectFile: derived.projectFile,
    versionsDir: derived.versionsDir,
    runsDir: derived.runsDir,
  });
}

function attemptPaths(options) {
  return derivePaths(options || {}, true);
}

function validateProjectDocument(project, projectId) {
  if (!project || typeof project !== 'object' || Array.isArray(project)) {
    return fail(CODES.WORKSPACE_INVALID, '.', 'project.json 形状非法');
  }
  if (project.schemaVersion !== SCHEMAS.workspace) {
    return fail(CODES.WORKSPACE_INVALID, '.', 'project.json schemaVersion 不匹配');
  }
  if (project.projectId !== projectId) {
    return fail(CODES.WORKSPACE_INVALID, '.', 'project.json 的 projectId 与请求不一致');
  }
  return ok({ project });
}

function loadProjectDocument(projectFile, projectId) {
  if (!fs.existsSync(projectFile)) return fail(CODES.WORKSPACE_NOT_FOUND, '.', 'project.json 不存在');
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
  } catch (error) {
    return fail(CODES.WORKSPACE_INVALID, '.', 'project.json 无法解析');
  }
  return validateProjectDocument(parsed, projectId);
}

function readProjectFile(workspace) {
  const guard = guardWorkspace(workspace);
  if (!guard.ok) return guard;
  const loaded = loadProjectDocument(workspace.projectFile, workspace.projectId);
  if (!loaded.ok) return loaded;
  return ok({ project: loaded.project });
}

function openWorkspace(options) {
  const opts = options || {};
  const derived = workspacePaths(opts);
  if (!derived.ok) return derived;
  const root = derived.root;
  const rootReal = derived.rootReal;

  for (const dir of [derived.projectDir, derived.workspaceDir]) {
    const ensured = ensureDirectory(root, rootReal, dir, CODES);
    if (!ensured.ok) return sanitizeFailure(ensured, root);
  }
  const canonical = assertCanonicalDir(derived.workspaceDir, CODES);
  if (!canonical.ok) return sanitizeFailure(canonical, root);

  let project;
  if (fs.existsSync(derived.projectFile)) {
    const read = loadProjectDocument(derived.projectFile, derived.projectId);
    if (!read.ok) return read;
    project = read.project;
  } else {
    project = {
      schemaVersion: SCHEMAS.workspace,
      projectId: derived.projectId,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    const written = writeJsonAtomic(derived.projectFile, project, CODES);
    if (!written.ok) return sanitizeFailure(written, root);
  }

  const workspace = {
    schemaVersion: SCHEMAS.workspace,
    projectId: derived.projectId,
    userDataDir: root,
    userDataReal: rootReal,
    projectDir: derived.projectDir,
    workspaceDir: derived.workspaceDir,
    projectFile: derived.projectFile,
    versionsDir: derived.versionsDir,
    runsDir: derived.runsDir,
    project,
    limits: LIMITS,
  };
  return ok({ workspace });
}

function listAttemptNumbers(attemptsDir) {
  const numbers = [];
  let entries;
  try {
    entries = fs.readdirSync(attemptsDir, { withFileTypes: true });
  } catch (error) {
    return numbers;
  }
  for (const entry of entries) {
    const matched = ATTEMPT_ID_PATTERN.exec(entry.name);
    if (!matched || !entry.isDirectory()) continue;
    numbers.push(Number(matched[1]));
  }
  return numbers.sort((a, b) => a - b);
}

function listAttempts(workspace, options) {
  const guard = guardWorkspace(workspace);
  if (!guard.ok) return guard;
  const opts = options || {};
  const derived = derivePaths({
    userDataDir: workspace.userDataDir,
    projectId: workspace.projectId,
    runId: opts.runId,
    turnId: opts.turnId,
  }, false);
  if (!derived.ok) return derived;
  if (!fs.existsSync(derived.attemptsDir)) return ok({ attempts: [] });
  return ok({ attempts: listAttemptNumbers(derived.attemptsDir) });
}

function resolveSource(workspace, source, attemptDir) {
  const spec = source === undefined ? { kind: 'base' } : source;
  if (!spec || typeof spec !== 'object') return fail(CODES.WORKSPACE_INVALID, 'source', '工作树来源非法');
  if (spec.kind === 'base') {
    const canonical = assertCanonicalDir(BASE_SOURCE_DIR, CODES);
    if (!canonical.ok) {
      return fail(CODES.WORKSPACE_INVALID, 'source', 'Base 真源不可用：templates/base/ordering-base/1.0.0/src');
    }
    return ok({
      dir: BASE_SOURCE_DIR,
      source: { kind: 'base', templateId: BASE_TEMPLATE_ID, version: BASE_TEMPLATE_VERSION },
    });
  }
  if (spec.kind === 'version') {
    if (typeof spec.versionId !== 'string' || !VERSION_ID_PATTERN.test(spec.versionId)) {
      return fail(CODES.WORKSPACE_INVALID, 'versionId', 'versionId 非法（必须形如 v1）');
    }
    const dir = spec.sourcePath
      ? path.resolve(spec.sourcePath)
      : path.join(workspace.versionsDir, spec.versionId, LAYOUT.sourceDir);
    const canonical = assertCanonicalDir(dir, CODES);
    if (!canonical.ok) return fail(CODES.WORKSPACE_NOT_FOUND, 'source', '已采用版本 source 目录不存在或不是规范目录');
    if (isInsideOrEqual(attemptDir, canonical.dir)) {
      return fail(CODES.PATH_ESCAPE, 'source', '来源目录不得位于目标工作树内');
    }
    return ok({
      dir: canonical.dir,
      source: {
        kind: 'version',
        versionId: spec.versionId,
        reason: typeof spec.reason === 'string' ? spec.reason.slice(0, 64) : 'import-adopted',
      },
    });
  }
  return fail(CODES.WORKSPACE_INVALID, 'source', '未知工作树来源类型');
}

/**
 * 复制来源工作树到 candidate：只复制真实文件，不跟随链接；跳过 `.git`/`node_modules`；
 * 按冻结上限检查路径长度、深度、文件数、单文件与总字节。
 */
function copySourceTree(sourceDir, targetDir, limits) {
  let fileCount = 0;
  let totalBytes = 0;
  let skippedLinks = 0;
  let skippedDirs = 0;

  const walk = (source, target, prefix) => {
    const entries = fs.readdirSync(source, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') {
        skippedDirs += 1;
        continue;
      }
      const relative = prefix ? prefix + '/' + entry.name : entry.name;
      const from = path.join(source, entry.name);
      const to = path.join(target, entry.name);
      if (entry.isSymbolicLink()) {
        skippedLinks += 1;
        continue;
      }
      if (relative.length > limits.maxPathLength) {
        throw fail(CODES.PATH_INVALID, relative, '路径长度超过上限 ' + limits.maxPathLength);
      }
      if (relative.split('/').length > limits.maxDepth) {
        throw fail(CODES.DEPTH_EXCEEDED, relative, '路径层级超过上限 ' + limits.maxDepth);
      }
      if (entry.isDirectory()) {
        fs.mkdirSync(to, { recursive: false, mode: 0o700 });
        walk(from, to, relative);
        continue;
      }
      if (!entry.isFile()) {
        throw fail(CODES.PATH_LINK, relative, '来源只接受普通文件');
      }
      fileCount += 1;
      if (fileCount > limits.maxFiles) {
        throw fail(CODES.FILE_COUNT_EXCEEDED, relative, '文件数超过上限 ' + limits.maxFiles);
      }
      const buffer = fs.readFileSync(from);
      if (buffer.length > limits.maxFileBytes) {
        throw fail(CODES.FILE_TOO_LARGE, relative, '单文件超过上限 ' + limits.maxFileBytes + ' 字节');
      }
      totalBytes += buffer.length;
      if (totalBytes > limits.maxTreeBytes) {
        throw fail(CODES.TREE_TOO_LARGE, relative, '工作树总字节超过上限 ' + limits.maxTreeBytes);
      }
      fs.writeFileSync(to, buffer, { flag: 'wx', mode: 0o600 });
    }
  };

  walk(sourceDir, targetDir, '');
  return { ok: true, fileCount, totalBytes, skippedLinks, skippedDirs };
}

function writeRunAndTurnMetadata(workspace, runDir, runId, turnDir, turnId, attemptId) {
  const runFile = path.join(runDir, LAYOUT.runFile);
  let run = null;
  if (fs.existsSync(runFile)) {
    try {
      run = JSON.parse(fs.readFileSync(runFile, 'utf8'));
    } catch (error) {
      return fail(CODES.WORKSPACE_INVALID, '.', 'run.json 无法解析');
    }
    if (!run || run.schemaVersion !== SCHEMAS.run || run.projectId !== workspace.projectId || run.runId !== runId) {
      return fail(CODES.WORKSPACE_INVALID, '.', 'run.json 与请求身份不一致');
    }
  } else {
    run = {
      schemaVersion: SCHEMAS.run,
      projectId: workspace.projectId,
      runId,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      turns: [],
    };
  }
  if (!Array.isArray(run.turns)) run.turns = [];
  if (!run.turns.includes(turnId)) run.turns.push(turnId);
  run.turns.sort();
  run.updatedAt = nowIso();
  const runWritten = writeJsonAtomic(runFile, run, CODES);
  if (!runWritten.ok) return sanitizeFailure(runWritten, workspace.userDataDir);

  const turnFile = path.join(turnDir, LAYOUT.turnFile);
  let turn = null;
  if (fs.existsSync(turnFile)) {
    try {
      turn = JSON.parse(fs.readFileSync(turnFile, 'utf8'));
    } catch (error) {
      return fail(CODES.WORKSPACE_INVALID, '.', 'turn.json 无法解析');
    }
    if (!turn || turn.schemaVersion !== SCHEMAS.turn || turn.projectId !== workspace.projectId
      || turn.runId !== runId || turn.turnId !== turnId) {
      return fail(CODES.WORKSPACE_INVALID, '.', 'turn.json 与请求身份不一致');
    }
  } else {
    turn = {
      schemaVersion: SCHEMAS.turn,
      projectId: workspace.projectId,
      runId,
      turnId,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      attempts: [],
    };
  }
  if (!Array.isArray(turn.attempts)) turn.attempts = [];
  if (!turn.attempts.includes(attemptId)) turn.attempts.push(attemptId);
  turn.attempts.sort((a, b) => {
    const left = parseAttemptNumber(a);
    const right = parseAttemptNumber(b);
    return (left || 0) - (right || 0);
  });
  turn.updatedAt = nowIso();
  const turnWritten = writeJsonAtomic(turnFile, turn, CODES);
  if (!turnWritten.ok) return sanitizeFailure(turnWritten, workspace.userDataDir);
  return ok({ run, turn });
}

function unregisterAttemptFromTurn(turnFile, attemptId) {
  try {
    const turn = JSON.parse(fs.readFileSync(turnFile, 'utf8'));
    if (turn && Array.isArray(turn.attempts)) {
      turn.attempts = turn.attempts.filter((item) => item !== attemptId);
      turn.updatedAt = nowIso();
      writeJsonAtomic(turnFile, turn, CODES);
    }
  } catch (error) {
    /* 清理失败不掩盖原始错误 */
  }
}

function removeAttemptDirSafely(attemptsDir, attemptDir) {
  if (!ATTEMPT_ID_PATTERN.test(path.basename(attemptDir))) return false;
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

function makeAttemptHandle(derived, workspace, limits, project, meta) {
  return {
    schemaVersion: SCHEMAS.workspace,
    projectId: derived.projectId,
    userDataDir: derived.root,
    userDataReal: derived.rootReal,
    projectDir: derived.projectDir,
    workspaceDir: derived.workspaceDir,
    projectFile: derived.projectFile,
    versionsDir: derived.versionsDir,
    runsDir: derived.runsDir,
    runId: derived.runId,
    runDir: derived.runDir,
    runFile: derived.runFile,
    turnId: derived.turnId,
    turnDir: derived.turnDir,
    turnFile: derived.turnFile,
    attempt: derived.attempt,
    attemptId: derived.attemptId,
    attemptDir: derived.attemptDir,
    attemptFile: derived.attemptFile,
    candidateDir: derived.candidateDir,
    verificationDir: derived.verificationDir,
    limits,
    project,
    meta,
    revision: meta.revision,
    treeDigest: meta.treeDigest,
    fileCount: meta.fileCount,
    totalBytes: meta.totalBytes,
  };
}

function createAttempt(workspace, options) {
  const guard = guardWorkspace(workspace);
  if (!guard.ok) return guard;
  const opts = options || {};
  const limitsResult = resolveLimits(opts.limits);
  if (!limitsResult.ok) return limitsResult;
  const limits = limitsResult.limits;

  const derived = derivePaths({
    userDataDir: workspace.userDataDir,
    projectId: workspace.projectId,
    runId: opts.runId,
    turnId: opts.turnId,
  }, false);
  if (!derived.ok) return derived;

  const explicitRaw = opts.attempt !== undefined ? opts.attempt : opts.attemptId;
  const explicit = explicitRaw !== undefined;
  let desired = null;
  if (explicit) {
    desired = parseAttemptNumber(explicitRaw);
    if (desired === null) return fail(CODES.ID_INVALID, 'attempt', 'attempt 非法（必须是 attempt-<1..9999>）');
  }

  const root = derived.root;
  const rootReal = derived.rootReal;
  for (const dir of [derived.runDir, derived.turnDir, derived.attemptsDir]) {
    const ensured = ensureDirectory(root, rootReal, dir, CODES);
    if (!ensured.ok) return sanitizeFailure(ensured, root);
  }

  let attemptNumber = desired;
  let attemptDir = null;
  try {
    if (explicit) {
      attemptDir = path.join(derived.attemptsDir, attemptIdOf(desired));
      if (fs.existsSync(attemptDir)) {
        return fail(CODES.WORKSPACE_INVALID, '.', 'attempt 已存在：' + attemptIdOf(desired));
      }
      fs.mkdirSync(attemptDir, { recursive: false, mode: 0o700 });
    } else {
      const existing = listAttemptNumbers(derived.attemptsDir);
      attemptNumber = existing.length === 0 ? 1 : existing[existing.length - 1] + 1;
      let allocated = false;
      for (let tries = 0; tries < 16 && !allocated; tries += 1) {
        if (attemptNumber > 9999) return fail(CODES.WORKSPACE_INVALID, '.', 'attempt 编号超过上限');
        attemptDir = path.join(derived.attemptsDir, attemptIdOf(attemptNumber));
        try {
          fs.mkdirSync(attemptDir, { recursive: false, mode: 0o700 });
          allocated = true;
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          attemptNumber += 1;
        }
      }
      if (!allocated) return fail(CODES.WORKSPACE_INVALID, '.', 'attempt 目录分配冲突过多');
    }
  } catch (error) {
    if (error && error.ok === false) return error;
    return fail(CODES.TXN_ABORTED, '.', '无法创建 attempt 目录：' + (error.code || error.message));
  }

  let turnFileForCleanup = null;
  try {
    for (const dir of [attemptDir, path.join(attemptDir, LAYOUT.candidateDir), path.join(attemptDir, LAYOUT.verificationDir)]) {
      const ensured = ensureDirectory(root, rootReal, dir, CODES);
      if (!ensured.ok) throw ensured;
      const canonical = assertCanonicalDir(dir, CODES);
      if (!canonical.ok) throw canonical;
    }

    const attemptId = attemptIdOf(attemptNumber);
    const sourceResult = resolveSource(workspace, opts.source, attemptDir);
    if (!sourceResult.ok) throw sourceResult;

    const copied = copySourceTree(sourceResult.dir, path.join(attemptDir, LAYOUT.candidateDir), limits);
    const built = manifestMod.buildManifest(path.join(attemptDir, LAYOUT.candidateDir), { limits });
    if (!built.ok) throw built;

    const createdAt = nowIso();
    const attemptMeta = {
      schemaVersion: SCHEMAS.attempt,
      projectId: workspace.projectId,
      runId: opts.runId,
      turnId: opts.turnId,
      attemptId,
      attempt: attemptNumber,
      createdAt,
      updatedAt: createdAt,
      status: 'open',
      revision: 1,
      source: sourceResult.source,
      copied: {
        fileCount: copied.fileCount,
        totalBytes: copied.totalBytes,
        skippedLinks: copied.skippedLinks,
        skippedDirs: copied.skippedDirs,
      },
      treeDigest: built.manifest.treeDigest,
      fileCount: built.manifest.fileCount,
      totalBytes: built.manifest.totalBytes,
    };
    const attemptFile = path.join(attemptDir, LAYOUT.attemptFile);
    const metaWritten = writeJsonAtomic(attemptFile, attemptMeta, CODES);
    if (!metaWritten.ok) throw metaWritten;

    turnFileForCleanup = path.join(derived.turnDir, LAYOUT.turnFile);
    const registered = writeRunAndTurnMetadata(
      workspace,
      derived.runDir,
      opts.runId,
      derived.turnDir,
      opts.turnId,
      attemptId,
    );
    if (!registered.ok) throw registered;

    const attemptDerived = {
      ...derived,
      attempt: attemptNumber,
      attemptId,
      attemptDir,
      candidateDir: path.join(attemptDir, LAYOUT.candidateDir),
      verificationDir: path.join(attemptDir, LAYOUT.verificationDir),
      attemptFile,
    };
    const handle = makeAttemptHandle(attemptDerived, workspace, limits, workspace.project, attemptMeta);
    return ok({ attempt: handle });
  } catch (failure) {
    removeAttemptDirSafely(derived.attemptsDir, attemptDir);
    if (turnFileForCleanup) unregisterAttemptFromTurn(turnFileForCleanup, attemptIdOf(attemptNumber));
    if (failure && failure.ok === false) return sanitizeFailure(failure, root);
    return fail(CODES.TXN_ABORTED, '.', '创建工作树失败：' + ((failure && failure.code) || 'AGENT_TXN_ABORTED'));
  }
}

function openAttempt(workspace, options) {
  const guard = guardWorkspace(workspace);
  if (!guard.ok) return guard;
  const opts = options || {};
  const limitsResult = resolveLimits(opts.limits);
  if (!limitsResult.ok) return limitsResult;
  const limits = limitsResult.limits;

  const attemptRaw = opts.attempt !== undefined ? opts.attempt : opts.attemptId;
  const derived = derivePaths({
    userDataDir: workspace.userDataDir,
    projectId: workspace.projectId,
    runId: opts.runId,
    turnId: opts.turnId,
    attempt: attemptRaw,
  }, true);
  if (!derived.ok) return derived;

  let stats;
  try {
    stats = fs.lstatSync(derived.attemptDir);
  } catch (error) {
    return fail(CODES.WORKSPACE_NOT_FOUND, '.', 'attempt 不存在');
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    return fail(CODES.WORKSPACE_NOT_FOUND, '.', 'attempt 目录非法');
  }
  const canonicalAttempt = assertCanonicalDir(derived.attemptDir, CODES);
  if (!canonicalAttempt.ok) return sanitizeFailure(canonicalAttempt, derived.root);

  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(derived.attemptFile, 'utf8'));
  } catch (error) {
    return fail(CODES.WORKSPACE_NOT_FOUND, '.', 'attempt.json 不存在或无法解析');
  }
  if (!meta || meta.schemaVersion !== SCHEMAS.attempt || meta.projectId !== derived.projectId
    || meta.runId !== derived.runId || meta.turnId !== derived.turnId || meta.attemptId !== derived.attemptId) {
    return fail(CODES.WORKSPACE_INVALID, '.', 'attempt.json 与请求身份不一致');
  }

  const handle = makeAttemptHandle(derived, workspace, limits, workspace.project, meta);

  // 重开时清理遗留暂存（只删本进程命名的 .staging-<8hex>）。
  const cleaned = transactions.cleanupStagedTransactions(handle);
  if (!cleaned.ok) return sanitizeFailure(cleaned, derived.root);

  const built = manifestMod.buildManifest(derived.candidateDir, { limits });
  if (!built.ok) return sanitizeFailure(built, derived.root);
  if (built.manifest.treeDigest !== meta.treeDigest) {
    return fail(CODES.WORKSPACE_INVALID, '.', '工作树摘要与 attempt.json 不一致（可能被外部修改）');
  }

  handle.treeDigest = built.manifest.treeDigest;
  handle.fileCount = built.manifest.fileCount;
  handle.totalBytes = built.manifest.totalBytes;
  handle.cleanedStaging = cleaned.removed;
  return ok({ attempt: handle });
}

function removeAttempt(workspace, options) {
  const guard = guardWorkspace(workspace);
  if (!guard.ok) return guard;
  const opts = options || {};
  const attemptRaw = opts.attempt !== undefined ? opts.attempt : opts.attemptId;
  const derived = derivePaths({
    userDataDir: workspace.userDataDir,
    projectId: workspace.projectId,
    runId: opts.runId,
    turnId: opts.turnId,
    attempt: attemptRaw,
  }, true);
  if (!derived.ok) return derived;
  if (!fs.existsSync(derived.attemptDir)) return ok({ removed: false });
  const removed = removeAttemptDirSafely(derived.attemptsDir, derived.attemptDir);
  if (!removed) return fail(CODES.WORKSPACE_INVALID, '.', 'attempt 目录非法，拒绝删除');
  unregisterAttemptFromTurn(path.join(derived.turnDir, LAYOUT.turnFile), derived.attemptId);
  return ok({ removed: true });
}

function assertOwnership(attempt, target) {
  const guard = guardAttemptHandle(attempt);
  if (!guard.ok) return guard;
  if (typeof target !== 'string' || !path.isAbsolute(target)) {
    return fail(CODES.PATH_INVALID, 'target', '目标必须是绝对路径（内部调用）');
  }
  const canonical = assertCanonicalDir(attempt.candidateDir, CODES);
  if (!canonical.ok) return sanitizeFailure(canonical, attempt.attemptDir);
  if (!isInsideOrEqual(attempt.candidateDir, target)) {
    return fail(CODES.PATH_ESCAPE, '.', '目标越出本次 attempt 工作树');
  }
  const audited = auditPath(attempt.candidateDir, canonical.realDir, target, CODES);
  if (!audited.ok) return sanitizeFailure(audited, attempt.attemptDir);
  return ok({ path: path.relative(attempt.candidateDir, target).split(path.sep).join('/') });
}

module.exports = {
  BASE_SOURCE_DIR,
  CODES,
  LIMITS,
  SCHEMAS,
  RUN_ID_PATTERN,
  TURN_ID_PATTERN,
  ATTEMPT_ID_PATTERN,
  VERSION_ID_PATTERN,
  workspacePaths,
  attemptPaths,
  openWorkspace,
  readProjectFile,
  createAttempt,
  openAttempt,
  removeAttempt,
  listAttempts,
  assertOwnership,
  normalizeRelativePath,
  // B2 复用：把来源工作树复制到目标目录（唯一一份“只复制真实文件、不跟随链接”实现）。
  copySourceTree,
  // 共享安全路径能力直接再导出（B1 报告签名用；唯一实现在 paths.cjs）。
  resolvePrivateRoot,
  auditPath,
  ensureDirectory,
  assertCanonicalDir,
  assertSafeRelativePath,
  removeTreeSafely,
  sanitizeFailure,
};
