'use strict';

/**
 * B1 事务：begin → stage → commit / abort。
 *
 * 不变量（冻结文档 §1.5）：
 * - `write_file` 是完整文件覆盖（不接受残片拼接、不接受 unified diff）；空字符串不是删除；
 * - `expectedBaseSha256` 必须与当前文件摘要一致，否则整批失败且不落盘；
 * - 先把“完整下一棵树”复制/变更到 `attempts/attempt-<n>/.staging-<8hex>/candidate`，
 *   再原子 rename 交换；任一失败整批不提交，并清理暂存目录；
 * - 暂存目录只允许本进程命名的 `.staging-<8hex>`，删除走 `removeTreeSafely`，绝不跟随链接；
 * - 提交后更新 attempt.json 的 `treeDigest/fileCount/totalBytes/revision`。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  CODES,
  LIMITS,
  resolveLimits,
  normalizeRelativePath,
  TRANSACTION_ID_PATTERN,
  STAGING_PATTERN,
  ATTEMPT_ID_PATTERN,
  RUN_ID_PATTERN,
  TURN_ID_PATTERN,
  LAYOUT,
} = require('./constants.cjs');
const {
  ok,
  fail,
  sanitizeFailure,
  removeTreeSafely,
  writeJsonAtomic,
  samePath,
  assertCanonicalDir,
  PROJECT_ID_PATTERN,
} = require('./paths.cjs');
const manifestMod = require('./manifest.cjs');

const PATCH_FORMAT_PATTERN = /^(patch|diff|unified-diff|git-diff)$/i;

function isPatchLike(content) {
  if (content.startsWith('*** Begin Patch')) return true;
  if (/^--- [^\n]*\n\+\+\+ [^\n]*\n/.test(content)) return true;
  if (/^diff --git [^\n]*\n/.test(content)) return true;
  return false;
}

/**
 * 归属校验（F1，唯一实现；files.cjs 复用同一函数）。
 *
 * 合法布局只有一种：
 * `<root>/projects/<projectId>/agent-workspace/runs/<runId>/turns/<turnId>/attempts/attempt-<n>/candidate`，
 * `attemptDir` 必须是其父 attempt 目录；句柄里的 id 必须与路径逐段一致。
 * 因此伪造指向 `versions/<versionId>/source`、`project.json`、`migration.json`、仓库或链接的句柄
 * 一律拒绝（AGENT_PATH_ESCAPE / AGENT_WORKSPACE_INVALID / AGENT_PATH_PROTECTED），保证事务永远写不到
 * 不可变版本树，也写不到仓库。
 */
function assertAttemptHandle(attempt) {
  if (!attempt || typeof attempt !== 'object' || Array.isArray(attempt)) {
    return fail(CODES.ARGUMENT_INVALID, 'attempt', '缺少 attempt 句柄');
  }
  const { attemptDir, candidateDir, attemptFile } = attempt;
  if (typeof attemptDir !== 'string' || !path.isAbsolute(attemptDir)
    || typeof candidateDir !== 'string' || !path.isAbsolute(candidateDir)) {
    return fail(CODES.WORKSPACE_INVALID, 'attempt', 'attempt 句柄缺少绝对路径工作树目录');
  }
  const attemptMatched = ATTEMPT_ID_PATTERN.exec(path.basename(attemptDir));
  if (!attemptMatched) {
    return fail(CODES.WORKSPACE_INVALID, 'attemptDir', 'attemptDir 不符合 attempts/attempt-<n> 布局');
  }
  const attemptsDir = path.dirname(attemptDir);
  if (path.basename(attemptsDir) !== LAYOUT.attemptsDir) {
    return fail(CODES.WORKSPACE_INVALID, 'attemptDir', 'attemptDir 的父目录必须是 attempts/');
  }
  const turnDir = path.dirname(attemptsDir);
  const turnId = path.basename(turnDir);
  if (!TURN_ID_PATTERN.test(turnId)) {
    return fail(CODES.WORKSPACE_INVALID, 'attemptDir', 'attemptDir 布局缺少合法 turnId');
  }
  const turnsDir = path.dirname(turnDir);
  if (path.basename(turnsDir) !== LAYOUT.turnsDir) {
    return fail(CODES.WORKSPACE_INVALID, 'attemptDir', 'attemptDir 布局缺少 turns/');
  }
  const runDir = path.dirname(turnsDir);
  const runId = path.basename(runDir);
  if (!RUN_ID_PATTERN.test(runId)) {
    return fail(CODES.WORKSPACE_INVALID, 'attemptDir', 'attemptDir 布局缺少合法 runId');
  }
  const runsDir = path.dirname(runDir);
  if (path.basename(runsDir) !== LAYOUT.runsDir) {
    return fail(CODES.WORKSPACE_INVALID, 'attemptDir', 'attemptDir 布局缺少 runs/');
  }
  const workspaceDir = path.dirname(runsDir);
  if (path.basename(workspaceDir) !== LAYOUT.workspaceDir) {
    return fail(CODES.WORKSPACE_INVALID, 'attemptDir', 'attemptDir 布局缺少 agent-workspace/');
  }
  const projectDir = path.dirname(workspaceDir);
  const projectId = path.basename(projectDir);
  if (!PROJECT_ID_PATTERN.test(projectId) || path.basename(path.dirname(projectDir)) !== 'projects') {
    return fail(CODES.WORKSPACE_INVALID, 'attemptDir', 'attemptDir 布局缺少 projects/<projectId>');
  }
  const root = path.dirname(path.dirname(projectDir));
  if (!fs.existsSync(root)) {
    return fail(CODES.WORKSPACE_INVALID, 'attempt', 'attempt 句柄的私有根不存在');
  }
  if (!samePath(path.join(attemptDir, LAYOUT.candidateDir), candidateDir)) {
    return fail(CODES.PATH_ESCAPE, 'candidateDir', 'candidateDir 与 attemptDir 布局不一致');
  }

  // 复用 B1 的同一套派生/审计（root 保护、逐段 link、越界），避免第二份安全路径逻辑。
  const derived = require('./workspace.cjs').attemptPaths({
    userDataDir: root,
    projectId,
    runId,
    turnId,
    attempt: Number(attemptMatched[1]),
  });
  if (!derived.ok) return derived;
  if (!samePath(derived.attemptDir, attemptDir) || !samePath(derived.candidateDir, candidateDir)) {
    return fail(CODES.PATH_ESCAPE, 'attempt', 'attempt 句柄与派生的归属目录不一致');
  }
  const canonicalAttempt = assertCanonicalDir(attemptDir, CODES);
  if (!canonicalAttempt.ok) return sanitizeFailure(canonicalAttempt, root);
  const canonicalCandidate = assertCanonicalDir(candidateDir, CODES);
  if (!canonicalCandidate.ok) return sanitizeFailure(canonicalCandidate, root);
  if (attemptFile !== undefined) {
    const expectedAttemptFile = path.join(attemptDir, LAYOUT.attemptFile);
    if (typeof attemptFile !== 'string' || !samePath(attemptFile, expectedAttemptFile)) {
      return fail(CODES.PATH_ESCAPE, 'attemptFile', 'attemptFile 不属于该 attempt 目录');
    }
  }
  return ok({
    root,
    projectId,
    runId,
    turnId,
    attempt: Number(attemptMatched[1]),
    attemptDir,
    candidateDir,
    workspaceDir,
  });
}

/** files.cjs 与事务入口共用这一处归属校验；伪造句柄在这里直接失败。 */
function guardAttempt(attempt) {
  return assertAttemptHandle(attempt);
}

function limitsOf(attempt) {
  const result = resolveLimits(attempt.limits);
  return result.ok ? result.limits : LIMITS;
}

function stagingDirOf(attempt, transactionId) {
  if (typeof transactionId !== 'string' || !TRANSACTION_ID_PATTERN.test(transactionId)) return null;
  return path.join(attempt.attemptDir, '.staging-' + transactionId);
}

function prepareChanges(attempt, changes, limits) {
  if (!Array.isArray(changes)) return fail(CODES.ARGUMENT_INVALID, 'changes', 'changes 必须是数组');
  if (changes.length === 0) return fail(CODES.ARGUMENT_INVALID, 'changes', '空批量不构成事务');
  if (changes.length > limits.batchMaxFiles) {
    return fail(CODES.BATCH_TOO_LARGE, 'changes', '单批文件数超过上限 ' + limits.batchMaxFiles);
  }
  const seen = new Set();
  const prepared = [];
  let totalWriteBytes = 0;
  for (const change of changes) {
    if (!change || typeof change !== 'object' || Array.isArray(change)) {
      return fail(CODES.ARGUMENT_INVALID, 'changes', '每个变更必须是对象');
    }
    const op = change.op;
    if (op !== 'write' && op !== 'delete') {
      return fail(CODES.ARGUMENT_INVALID, 'op', '不支持的变更类型：' + String(op));
    }
    const safe = normalizeRelativePath(change.path, { limits });
    if (!safe.ok) return sanitizeFailure(safe, attempt.attemptDir);
    const relative = change.path;
    if (seen.has(relative)) return fail(CODES.PATH_INVALID, relative, '同一批变更里路径重复');
    seen.add(relative);

    let expected;
    if (Object.prototype.hasOwnProperty.call(change, 'expectedBaseSha256') && change.expectedBaseSha256 !== undefined) {
      if (change.expectedBaseSha256 === null) {
        expected = null;
      } else {
        expected = manifestMod.normalizeTreeDigest(change.expectedBaseSha256);
        if (!expected) return fail(CODES.ARGUMENT_INVALID, relative, 'expectedBaseSha256 格式非法');
      }
    }

    if (op === 'delete') {
      if (change.content !== undefined) return fail(CODES.ARGUMENT_INVALID, relative, 'delete 不接受 content');
      prepared.push({ op, path: relative, expected });
      continue;
    }

    if (typeof change.content !== 'string') {
      return fail(CODES.ARGUMENT_INVALID, relative, 'write 的 content 必须是完整字符串');
    }
    if (change.format !== undefined && PATCH_FORMAT_PATTERN.test(String(change.format))) {
      return fail(CODES.PATCH_REJECTED, relative, '只接受完整文件内容，不接受 unified diff/patch');
    }
    if (isPatchLike(change.content)) {
      return fail(CODES.PATCH_REJECTED, relative, '只接受完整文件内容，不接受 unified diff/patch');
    }
    const bytes = Buffer.byteLength(change.content, 'utf8');
    if (bytes > limits.maxFileBytes) {
      return fail(CODES.FILE_TOO_LARGE, relative, '单文件超过上限 ' + limits.maxFileBytes + ' 字节');
    }
    totalWriteBytes += bytes;
    if (totalWriteBytes > limits.batchMaxBytes) {
      return fail(CODES.BATCH_TOO_LARGE, relative, '单批总字节超过上限 ' + limits.batchMaxBytes);
    }
    prepared.push({ op, path: relative, content: change.content, bytes, expected });
  }
  return ok({ changes: prepared });
}

function currentDigestMap(manifest) {
  return new Map(manifest.files.map((item) => [item.path, item.sha256]));
}

function checkExpected(change, digests) {
  const current = digests.get(change.path);
  if (change.expected === null) {
    if (current !== undefined) {
      return fail(CODES.BASE_DIGEST_MISMATCH, change.path, '期望文件不存在，但当前已存在（冲突）');
    }
    return ok();
  }
  if (change.expected === undefined) return ok();
  if (current === undefined) {
    return fail(CODES.BASE_DIGEST_MISMATCH, change.path, '期望文件存在，但当前不存在（冲突）');
  }
  if (current !== change.expected) {
    return fail(CODES.BASE_DIGEST_MISMATCH, change.path, '文件摘要与 expectedBaseSha256 不一致（冲突）');
  }
  return ok();
}

function ensureRelativeParent(baseDir, relative) {
  const segments = relative.split('/');
  segments.pop();
  let current = baseDir;
  for (const segment of segments) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) fs.mkdirSync(current, { recursive: false, mode: 0o700 });
    const stats = fs.lstatSync(current);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      const error = new Error('暂存目录结构非法');
      error.code = 'AGENT_PATH_LINK';
      throw error;
    }
  }
}

function copyTree(sourceDir, targetDir) {
  fs.mkdirSync(targetDir, { recursive: false, mode: 0o700 });
  const walk = (source, target) => {
    const entries = fs.readdirSync(source, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const from = path.join(source, entry.name);
      const to = path.join(target, entry.name);
      if (entry.isSymbolicLink()) {
        const error = new Error('工作树内不得存在链接');
        error.code = 'AGENT_PATH_LINK';
        throw error;
      }
      if (entry.isDirectory()) {
        fs.mkdirSync(to, { recursive: false, mode: 0o700 });
        walk(from, to);
        continue;
      }
      if (!entry.isFile()) {
        const error = new Error('只接受普通文件');
        error.code = 'AGENT_PATH_LINK';
        throw error;
      }
      fs.copyFileSync(from, to);
    }
  };
  walk(sourceDir, targetDir);
}

function stagedFilesOf(baseDigests, changes) {
  return changes.map((change) => {
    if (change.op === 'delete') {
      return { path: change.path, op: 'delete', bytes: 0, sha256: baseDigests.get(change.path) || null };
    }
    return {
      path: change.path,
      op: 'write',
      bytes: change.bytes,
      sha256: manifestMod.digestOfContent(change.content),
    };
  });
}

/**
 * 开始事务：校验 + 冲突检测 + 复制完整下一棵树到暂存目录（此时工作树不动）。
 */
function beginChanges(attempt, changes) {
  const guard = guardAttempt(attempt);
  if (!guard.ok) return guard;
  const limits = limitsOf(attempt);

  const prepared = prepareChanges(attempt, changes, limits);
  if (!prepared.ok) return prepared;

  const baseManifest = manifestMod.buildManifest(attempt.candidateDir, { limits });
  if (!baseManifest.ok) return sanitizeFailure(baseManifest, attempt.attemptDir);
  const baseDigests = currentDigestMap(baseManifest.manifest);

  // 冲突检测与删除目标检查必须在任何落盘之前。
  for (const change of prepared.changes) {
    const checked = checkExpected(change, baseDigests);
    if (!checked.ok) return checked;
    if (change.op !== 'delete') continue;
    const target = path.join(attempt.candidateDir, ...change.path.split('/'));
    let stats;
    try {
      stats = fs.lstatSync(target);
    } catch (error) {
      return fail(CODES.FILE_NOT_FOUND, change.path, '要删除的文件不存在');
    }
    if (stats.isSymbolicLink()) return fail(CODES.PATH_LINK, change.path, '要删除的目标不得是链接');
    if (!stats.isFile()) return fail(CODES.ARGUMENT_INVALID, change.path, '目录不是文件，不能删除');
  }

  const transactionId = crypto.randomBytes(4).toString('hex');
  const stagingDir = path.join(attempt.attemptDir, '.staging-' + transactionId);
  try {
    fs.mkdirSync(stagingDir, { recursive: false, mode: 0o700 });
  } catch (error) {
    return fail(CODES.TXN_ABORTED, '.', '无法创建事务暂存目录：' + (error.code || error.message));
  }

  const cleanup = () => {
    const stats = (() => {
      try {
        return fs.lstatSync(stagingDir);
      } catch (error) {
        return null;
      }
    })();
    if (stats && !stats.isSymbolicLink() && stats.isDirectory() && STAGING_PATTERN.test(path.basename(stagingDir))) {
      removeTreeSafely(stagingDir);
    }
  };

  try {
    const stagedCandidate = path.join(stagingDir, 'candidate');
    copyTree(attempt.candidateDir, stagedCandidate);

    for (const change of prepared.changes) {
      const target = path.join(stagedCandidate, ...change.path.split('/'));
      if (change.op === 'delete') {
        fs.unlinkSync(target);
        continue;
      }
      ensureRelativeParent(stagedCandidate, change.path);
      fs.writeFileSync(target, change.content, { encoding: 'utf8', flag: 'w' });
    }

    const stagedManifest = manifestMod.buildManifest(stagedCandidate, { limits });
    if (!stagedManifest.ok) {
      cleanup();
      return sanitizeFailure(stagedManifest, attempt.attemptDir);
    }
    const diff = manifestMod.diffManifests(baseManifest.manifest, stagedManifest.manifest);
    if (!diff.ok) {
      cleanup();
      return sanitizeFailure(diff, attempt.attemptDir);
    }

    const transaction = {
      schemaVersion: 'agent-transaction.v1',
      transactionId,
      projectId: attempt.projectId,
      runId: attempt.runId,
      turnId: attempt.turnId,
      attemptId: attempt.attemptId,
      createdAt: new Date().toISOString(),
      baseTreeDigest: baseManifest.manifest.treeDigest,
      treeDigest: stagedManifest.manifest.treeDigest,
      fileCount: stagedManifest.manifest.fileCount,
      totalBytes: stagedManifest.manifest.totalBytes,
      revision: (Number.isInteger(attempt.revision) ? attempt.revision : 1) + 1,
      changes: stagedFilesOf(baseDigests, prepared.changes),
    };
    const written = writeJsonAtomic(path.join(stagingDir, 'transaction.json'), transaction, CODES);
    if (!written.ok) {
      cleanup();
      return sanitizeFailure(written, attempt.attemptDir);
    }

    return ok({
      transactionId,
      transactionDir: stagingDir,
      stagedFiles: transaction.changes,
      manifest: stagedManifest.manifest,
      treeDigest: stagedManifest.manifest.treeDigest,
      revision: transaction.revision,
      diff,
      baseTreeDigest: transaction.baseTreeDigest,
    });
  } catch (error) {
    cleanup();
    return fail(CODES.TXN_ABORTED, '.', '事务暂存失败：' + (error.code || 'AGENT_TXN_ABORTED'));
  }
}

function readTransactionMeta(stagingDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(stagingDir, 'transaction.json'), 'utf8'));
    if (!parsed || parsed.schemaVersion !== 'agent-transaction.v1' || typeof parsed.transactionId !== 'string') return null;
    return parsed;
  } catch (error) {
    return null;
  }
}

function updateAttemptMetadata(attempt, manifest) {
  let current;
  try {
    current = JSON.parse(fs.readFileSync(attempt.attemptFile, 'utf8'));
  } catch (error) {
    return fail(CODES.WORKSPACE_INVALID, '.', 'attempt.json 无法读取');
  }
  const next = {
    ...current,
    treeDigest: manifest.treeDigest,
    fileCount: manifest.fileCount,
    totalBytes: manifest.totalBytes,
    revision: (Number.isInteger(current.revision) ? current.revision : 1) + 1,
    updatedAt: new Date().toISOString(),
  };
  const written = writeJsonAtomic(attempt.attemptFile, next, CODES);
  if (!written.ok) return sanitizeFailure(written, attempt.attemptDir);
  return ok({ meta: next });
}

/**
 * 原子提交：暂存候选 rename 成正式候选，旧树先移到暂存目录，失败可回滚。
 */
function commitChanges(attempt, transactionId) {
  const guard = guardAttempt(attempt);
  if (!guard.ok) return guard;
  const limits = limitsOf(attempt);
  const stagingDir = stagingDirOf(attempt, transactionId);
  if (!stagingDir) return fail(CODES.TXN_ABORTED, '.', 'transactionId 非法');

  let stagingStats;
  try {
    stagingStats = fs.lstatSync(stagingDir);
  } catch (error) {
    return fail(CODES.TXN_ABORTED, '.', '事务暂存目录不存在');
  }
  if (stagingStats.isSymbolicLink() || !stagingStats.isDirectory()) {
    return fail(CODES.TXN_ABORTED, '.', '事务暂存目录非法');
  }
  const transaction = readTransactionMeta(stagingDir);
  if (!transaction || transaction.transactionId !== transactionId) {
    return fail(CODES.TXN_ABORTED, '.', '事务元数据缺失或与 transactionId 不一致');
  }

  const stagedCandidate = path.join(stagingDir, 'candidate');
  const previousDir = path.join(stagingDir, 'previous');
  const failedDir = path.join(stagingDir, 'failed-new');
  let candidateStats;
  try {
    candidateStats = fs.lstatSync(stagedCandidate);
  } catch (error) {
    return fail(CODES.TXN_ABORTED, '.', '暂存候选目录不存在（提交已中止）');
  }
  if (candidateStats.isSymbolicLink() || !candidateStats.isDirectory()) {
    return fail(CODES.TXN_ABORTED, '.', '暂存候选目录非法');
  }

  // 提交前复核暂存树摘要与 begin 时记录一致（防止暂存被替换）。
  const stagedManifest = manifestMod.buildManifest(stagedCandidate, { limits });
  if (!stagedManifest.ok) return sanitizeFailure(stagedManifest, attempt.attemptDir);
  if (stagedManifest.manifest.treeDigest !== transaction.treeDigest) {
    return fail(CODES.TXN_ABORTED, '.', '暂存树摘要与事务记录不一致（提交已中止）');
  }
  const currentManifest = manifestMod.buildManifest(attempt.candidateDir, { limits });
  if (!currentManifest.ok) return sanitizeFailure(currentManifest, attempt.attemptDir);

  try {
    fs.renameSync(attempt.candidateDir, previousDir);
  } catch (error) {
    return fail(CODES.TXN_ABORTED, '.', '无法移出旧工作树：' + (error.code || error.message));
  }

  try {
    fs.renameSync(stagedCandidate, attempt.candidateDir);
  } catch (error) {
    try {
      fs.renameSync(previousDir, attempt.candidateDir);
    } catch (rollbackError) {
      return fail(CODES.TXN_ABORTED, '.', '提交失败且回滚失败（需人工检查）');
    }
    return fail(CODES.TXN_ABORTED, '.', '无法换入新工作树：' + (error.code || error.message));
  }

  const metaWritten = updateAttemptMetadata(attempt, stagedManifest.manifest);
  if (!metaWritten.ok) {
    // 元数据失败：把新树挪开、旧树换回，保持“整批不提交”。
    try {
      fs.renameSync(attempt.candidateDir, failedDir);
      fs.renameSync(previousDir, attempt.candidateDir);
    } catch (rollbackError) {
      return fail(CODES.TXN_ABORTED, '.', '元数据写入失败且回滚失败（需人工检查）');
    }
    removeTreeSafely(stagingDir);
    return metaWritten;
  }

  removeTreeSafely(stagingDir);

  const newManifest = stagedManifest.manifest;
  attempt.revision = metaWritten.meta.revision;
  attempt.treeDigest = newManifest.treeDigest;
  attempt.fileCount = newManifest.fileCount;
  attempt.totalBytes = newManifest.totalBytes;
  attempt.meta = metaWritten.meta;

  const diff = manifestMod.diffManifests(currentManifest.manifest, newManifest);
  return ok({
    transactionId,
    revision: metaWritten.meta.revision,
    treeDigest: newManifest.treeDigest,
    fileCount: newManifest.fileCount,
    totalBytes: newManifest.totalBytes,
    manifest: newManifest,
    diff: diff.ok ? diff : { files: [], counts: { added: 0, modified: 0, deleted: 0, unchanged: 0 }, truncated: false },
  });
}

function discardChanges(attempt, transactionId) {
  const guard = guardAttempt(attempt);
  if (!guard.ok) return guard;
  const stagingDir = stagingDirOf(attempt, transactionId);
  if (!stagingDir) return fail(CODES.TXN_ABORTED, '.', 'transactionId 非法');
  let stats;
  try {
    stats = fs.lstatSync(stagingDir);
  } catch (error) {
    return ok({ removed: false });
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    return fail(CODES.TXN_ABORTED, '.', '事务暂存目录非法');
  }
  return ok({ removed: removeTreeSafely(stagingDir) });
}

function applyChanges(attempt, changes) {
  const begun = beginChanges(attempt, changes);
  if (!begun.ok) return begun;
  return commitChanges(attempt, begun.transactionId);
}

function listStagedTransactions(attempt) {
  const guard = guardAttempt(attempt);
  if (!guard.ok) return guard;
  let entries;
  try {
    entries = fs.readdirSync(attempt.attemptDir, { withFileTypes: true });
  } catch (error) {
    return fail(CODES.WORKSPACE_NOT_FOUND, '.', 'attempt 目录不存在');
  }
  const transactions = entries
    .filter((entry) => entry.isDirectory() && STAGING_PATTERN.test(entry.name))
    .map((entry) => entry.name.replace(/^\.staging-/, ''))
    .sort();
  return ok({ transactions });
}

/** 重开/失败后清理遗留暂存（只删本进程命名的 `.staging-<8hex>` 目录，不跟随链接）。 */
function cleanupStagedTransactions(attempt) {
  const guard = guardAttempt(attempt);
  if (!guard.ok) return guard;
  const listed = listStagedTransactions(attempt);
  if (!listed.ok) return listed;
  let removed = 0;
  for (const transactionId of listed.transactions) {
    const stagingDir = stagingDirOf(attempt, transactionId);
    if (!stagingDir) continue;
    let stats;
    try {
      stats = fs.lstatSync(stagingDir);
    } catch (error) {
      continue;
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) continue;
    if (removeTreeSafely(stagingDir)) removed += 1;
  }
  return ok({ removed });
}

module.exports = {
  CODES,
  LIMITS,
  beginChanges,
  commitChanges,
  discardChanges,
  applyChanges,
  listStagedTransactions,
  cleanupStagedTransactions,
  // F1 归属校验（files.cjs 复用同一实现）
  assertAttemptHandle,
  // 测试/诊断用（非安全边界）：单个变更的完整文件大小与补丁识别。
  isPatchLike,
};
