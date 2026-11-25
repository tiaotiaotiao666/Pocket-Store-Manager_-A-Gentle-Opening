'use strict';

/**
 * B2：不可变版本模型（纯主进程，不接 IPC/preload/renderer/Composer）。
 *
 * 冻结契约：`docs/handoff/Workspace-Agent-B阶段接口冻结.md` §2。
 *
 * 目录（§2.1）：
 *
 * ```
 * agent-workspace/
 *   project.json                 当前指针与历史索引（唯一真相）
 *   migration.json              旧 frontendCandidate 一次性迁移记录（append-only）
 *   versions/<versionId>/
 *     version.json
 *     source/**                 完整可构建源树快照（写定不可变）
 *     diff/summary.json         相对父版本的逐文件摘要
 *     evidence/**
 * ```
 *
 * 语义（§2.2）：采用=固化候选树为新版本并移动指针；undo/redo 只移指针；
 * 重开按 treeDigest fail-closed（AGENT_VERSION_CONFLICT，绝不回退 Base）；
 * 线性历史，分叉 redo 明确失败。导出身份（§2.4）只提供纯函数，不写盘。
 *
 * `versionId` 取 `v<正整数>`（v1 起）：与冻结 §2.1 示例、§3.2 `agent:versions` 以及
 * B1 `VERSION_ID_PATTERN`（`/^v[1-9][0-9]{0,5}$/`，B1 按版本目录取源时会校验）一致。
 * 任务文本里的 `v-<正整数>` 按 `v<n>` 实现；若 Captain 要求字面量 `v-1`，需 rev 并同步
 * 修改 B1 的 VERSION_ID_PATTERN（当前会拒绝 `v-1`）。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const paths = require('./paths.cjs');
const {
  CODES,
  LIMITS,
  SCHEMAS,
  LAYOUT,
  VERSION_ID_PATTERN,
  BASE_TEMPLATE_ID,
  BASE_TEMPLATE_VERSION,
  BASE_SOURCE_RELATIVE,
} = require('./constants.cjs');
const manifestMod = require('./manifest.cjs');
const workspaceMod = require('./workspace.cjs');

const { PROJECT_ID_PATTERN, CONTROL_CHAR_PATTERN } = paths;

const BASE_SOURCE_DIR = path.join(paths.REPO_ROOT, ...BASE_SOURCE_RELATIVE);
const VERSION_NUMBER_PATTERN = /^v([1-9][0-9]{0,5})$/;
const MAX_JSON_BYTES = 1024 * 1024;
const MIGRATION_ID_PATTERN = /^mig-[0-9a-f]{8}$/;

const { ok, fail, sanitizeFailure, removeTreeSafely, randomSuffix, writeJsonAtomic } = paths;

function nowIso() {
  return new Date().toISOString();
}

function boundedMessage(message) {
  const text = typeof message === 'string' && message ? message : '操作失败';
  return text.length > 240 ? text.slice(0, 237) + '...' : text;
}

function failure(code, target, message) {
  return { ok: false, code, path: target || '.', message: boundedMessage(message) };
}

function readJsonBounded(file) {
  let stats;
  try {
    stats = fs.lstatSync(file);
  } catch (error) {
    return { ok: false, reason: 'missing' };
  }
  if (stats.isSymbolicLink() || !stats.isFile() || stats.size > MAX_JSON_BYTES) {
    return { ok: false, reason: 'invalid' };
  }
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (error) {
    return { ok: false, reason: 'invalid' };
  }
}

/** 只读路径推导：不 mkdir、不写盘（导出身份/重开/列表必须保持纯读）。 */
function readOnlyPaths(options) {
  const opts = options || {};
  if (typeof opts.projectId !== 'string' || !PROJECT_ID_PATTERN.test(opts.projectId)) {
    return failure(CODES.PROJECT_ID_INVALID, 'projectId', 'projectId 非法');
  }
  if (typeof opts.userDataDir !== 'string' || opts.userDataDir.trim() === '' || !path.isAbsolute(opts.userDataDir)) {
    return failure(CODES.ROOT_INVALID, 'userDataDir', '必须提供绝对路径的应用私有数据目录');
  }
  if (CONTROL_CHAR_PATTERN.test(opts.userDataDir)) return failure(CODES.ROOT_INVALID, 'userDataDir', '路径含控制字符');
  const root = path.resolve(opts.userDataDir);
  if (root === path.parse(root).root) return failure(CODES.ROOT_INVALID, 'userDataDir', '不允许把盘符根目录当作私有工作区');
  if (paths.isProtectedRepoDir(root)) return failure(CODES.PATH_PROTECTED, 'userDataDir', '私有工作区不得位于仓库内');
  const projectDir = path.join(root, 'projects', opts.projectId);
  const workspaceDir = path.join(projectDir, LAYOUT.workspaceDir);
  if (!paths.isInsideOrEqual(root, workspaceDir)) return failure(CODES.PATH_ESCAPE, 'userDataDir', '工作区越界');
  // 只读接口不做 mkdir，但仍要拒绝已存在的链接/越界目录：否则“纯读”会顺着 junction 读库外文件。
  if (fs.existsSync(workspaceDir)) {
    let stats;
    try {
      stats = fs.lstatSync(workspaceDir);
    } catch (error) {
      return failure(CODES.IO_FAILED, 'workspaceDir', '工作区不可读');
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      return failure(CODES.PATH_LINK, 'workspaceDir', '工作区目录不得是链接');
    }
    let real;
    try {
      real = fs.realpathSync.native ? fs.realpathSync.native(workspaceDir) : fs.realpathSync(workspaceDir);
    } catch (error) {
      return failure(CODES.IO_FAILED, 'workspaceDir', '无法解析工作区真实路径');
    }
    if (!paths.samePath(real, workspaceDir)) return failure(CODES.PATH_LINK, 'workspaceDir', '工作区目录不得是 junction');
    if (!paths.isInsideOrEqual(root, real)) return failure(CODES.PATH_ESCAPE, 'workspaceDir', '工作区真实路径越界');
  }
  return ok({
    root,
    projectId: opts.projectId,
    projectDir,
    workspaceDir,
    projectFile: path.join(workspaceDir, LAYOUT.projectFile),
    versionsDir: path.join(workspaceDir, LAYOUT.versionsDir),
    migrationFile: path.join(workspaceDir, LAYOUT.migrationFile),
  });
}

function validateState(state, projectId) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return failure(CODES.WORKSPACE_INVALID, '.', 'project.json 形状非法');
  if (state.schemaVersion !== SCHEMAS.workspace) return failure(CODES.WORKSPACE_INVALID, '.', 'project.json schemaVersion 不匹配');
  if (state.projectId !== projectId) return failure(CODES.WORKSPACE_INVALID, '.', 'project.json 的 projectId 不一致');
  for (const key of ['currentVersionId', 'previousVersionId', 'redoVersionId']) {
    if (state[key] !== null && !VERSION_ID_PATTERN.test(state[key])) {
      return failure(CODES.WORKSPACE_INVALID, '.', 'project.json 的 ' + key + ' 非法');
    }
  }
  if (!Array.isArray(state.versions)) return failure(CODES.WORKSPACE_INVALID, '.', 'project.json 缺少 versions 索引');
  for (const entry of state.versions) {
    if (!entry || typeof entry !== 'object') return failure(CODES.WORKSPACE_INVALID, '.', 'versions 索引条目非法');
    if (!VERSION_ID_PATTERN.test(entry.versionId)) return failure(CODES.WORKSPACE_INVALID, '.', 'versions 索引 versionId 非法');
    if (entry.parentVersionId !== null && !VERSION_ID_PATTERN.test(entry.parentVersionId)) {
      return failure(CODES.WORKSPACE_INVALID, '.', 'versions 索引 parentVersionId 非法');
    }
    if (typeof entry.treeDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(entry.treeDigest)) {
      return failure(CODES.WORKSPACE_INVALID, '.', 'versions 索引 treeDigest 非法');
    }
  }
  return ok({ state });
}

function loadState(context) {
  const read = readJsonBounded(context.projectFile);
  if (!read.ok) {
    if (read.reason === 'missing') return failure(CODES.WORKSPACE_NOT_FOUND, '.', 'agent-workspace/project.json 不存在');
    return failure(CODES.WORKSPACE_INVALID, '.', 'agent-workspace/project.json 无法解析');
  }
  return validateState(read.value, context.projectId);
}

function versionDirOf(context, versionId) {
  return path.join(context.versionsDir, versionId);
}

function readVersionDocument(context, versionId) {
  if (typeof versionId !== 'string' || !VERSION_ID_PATTERN.test(versionId)) {
    return failure(CODES.VERSION_NOT_FOUND, 'versionId', '版本不存在');
  }
  const read = readJsonBounded(path.join(versionDirOf(context, versionId), LAYOUT.versionFile));
  if (!read.ok) {
    if (read.reason === 'missing') return failure(CODES.VERSION_NOT_FOUND, 'versionId', '版本不存在');
    return failure(CODES.VERSION_CONFLICT, 'versionId', '版本元数据无法解析');
  }
  const version = read.value;
  if (!version || version.schemaVersion !== SCHEMAS.version || version.versionId !== versionId) {
    return failure(CODES.VERSION_CONFLICT, 'versionId', '版本元数据与请求不一致');
  }
  if (version.parentVersionId !== null && !VERSION_ID_PATTERN.test(version.parentVersionId)) {
    return failure(CODES.VERSION_CONFLICT, 'versionId', '版本父指针非法');
  }
  if (typeof version.treeDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(version.treeDigest)) {
    return failure(CODES.VERSION_CONFLICT, 'versionId', '版本 treeDigest 非法');
  }
  return ok({ version, versionDir: versionDirOf(context, versionId) });
}

function sourceManifestOf(context, versionId) {
  const built = manifestMod.buildManifest(path.join(versionDirOf(context, versionId), LAYOUT.sourceDir), { limits: LIMITS });
  if (!built.ok) return failure(CODES.VERSION_CONFLICT, 'versionId', '版本 source 树不可用或摘要不一致');
  return ok({ manifest: built.manifest });
}

let baseInfoCache = null;
function baseInfoOf() {
  if (baseInfoCache) return ok({ base: baseInfoCache });
  const built = manifestMod.buildManifest(BASE_SOURCE_DIR, { limits: LIMITS });
  if (!built.ok) return failure(CODES.WORKSPACE_INVALID, '.', 'Base 真源不可用');
  baseInfoCache = { templateId: BASE_TEMPLATE_ID, version: BASE_TEMPLATE_VERSION, treeDigest: built.manifest.treeDigest };
  return ok({ base: baseInfoCache });
}

function emptyManifest() {
  return {
    schemaVersion: SCHEMAS.manifest,
    treeDigest: manifestMod.treeDigestOfFiles([]),
    files: [],
    fileCount: 0,
    totalBytes: 0,
  };
}

function defaultVerification() {
  return { static: 'unknown', runtime: 'NOT_RUN', repairs: 0, screenshots: 0, checkedAt: null };
}

function defaultEvidence() {
  return { checks: [], dryRunRelative: null, runtimeRelative: null };
}

function normalizeVerification(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    static: source.static === 'pass' ? 'pass' : (source.static === 'fail' ? 'fail' : 'unknown'),
    runtime: ['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN'].includes(source.runtime) ? source.runtime : 'NOT_RUN',
    repairs: Number.isInteger(source.repairs) && source.repairs >= 0 ? source.repairs : 0,
    screenshots: Number.isInteger(source.screenshots) && source.screenshots >= 0 ? source.screenshots : 0,
    checkedAt: typeof source.checkedAt === 'string' && source.checkedAt.length <= 40 ? source.checkedAt : null,
  };
}

function normalizeEvidence(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const relative = (value) => (typeof value === 'string' && value && value.length <= 240 && !path.isAbsolute(value) && !value.includes('\\'))
    ? value
    : null;
  return { checks: [], dryRunRelative: relative(source.dryRunRelative), runtimeRelative: relative(source.runtimeRelative) };
}

function indexEntryOf(version, isCurrent) {
  return {
    versionId: version.versionId,
    parentVersionId: version.parentVersionId,
    createdAt: version.createdAt,
    treeDigest: version.treeDigest,
    reason: version.reason,
    isCurrent: Boolean(isCurrent),
    fileCount: version.source.files.count,
    screenshotCount: version.verification.screenshots,
    verification: { static: version.verification.static, runtime: version.verification.runtime },
  };
}

function withCurrentFlags(state, currentVersionId) {
  return {
    ...state,
    versions: state.versions.map((entry) => ({ ...entry, isCurrent: entry.versionId === currentVersionId })),
  };
}

function writeState(context, state) {
  const next = { ...state, updatedAt: nowIso() };
  const written = writeJsonAtomic(context.projectFile, next, CODES);
  if (!written.ok) return sanitizeFailure(written, context.root);
  return ok({ state: next });
}

function nextVersionNumber(state) {
  let max = 0;
  for (const entry of state.versions) {
    const matched = VERSION_NUMBER_PATTERN.exec(entry.versionId);
    if (matched) max = Math.max(max, Number(matched[1]));
  }
  if (max >= 999999) return failure(CODES.VERSION_IMMUTABLE, '.', '版本号已到达上限');
  return ok({ versionId: 'v' + (max + 1) });
}

/** 建一个版本目录到 `.staging-<8hex>`（提交前不对外可见，失败即清理）。 */
function buildVersion(context, spec) {
  const versionId = spec.versionId;
  if (!VERSION_ID_PATTERN.test(versionId)) return failure(CODES.VERSION_IMMUTABLE, '.', 'versionId 非法');
  const stagingDir = path.join(context.versionsDir, '.staging-' + randomSuffix());
  const cleanup = () => {
    let stats;
    try {
      stats = fs.lstatSync(stagingDir);
    } catch (error) {
      return;
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) return;
    if (path.dirname(stagingDir) !== context.versionsDir) return;
    removeTreeSafely(stagingDir);
  };

  try {
    const ensured = paths.ensureDirectory(context.root, context.rootReal, stagingDir, CODES);
    if (!ensured.ok) throw sanitizeFailure(ensured, context.root);
    const canonical = paths.assertCanonicalDir(stagingDir, CODES);
    if (!canonical.ok) throw sanitizeFailure(canonical, context.root);

    const sourceTarget = path.join(stagingDir, LAYOUT.sourceDir);
    const sourceEnsured = paths.ensureDirectory(context.root, context.rootReal, sourceTarget, CODES);
    if (!sourceEnsured.ok) throw sanitizeFailure(sourceEnsured, context.root);

    workspaceMod.copySourceTree(spec.sourceDir, sourceTarget, LIMITS);

    const built = manifestMod.buildManifest(sourceTarget, { limits: LIMITS });
    if (!built.ok) throw sanitizeFailure(built, context.root);

    let parentManifest = emptyManifest();
    if (spec.parentVersionId) {
      const parentSource = sourceManifestOf(context, spec.parentVersionId);
      if (!parentSource.ok) throw parentSource;
      parentManifest = parentSource.manifest;
    }
    const diff = manifestMod.diffManifests(parentManifest, built.manifest);
    if (!diff.ok) throw sanitizeFailure(diff, context.root);

    const diffDir = path.join(stagingDir, LAYOUT.diffDir);
    const evidenceDir = path.join(stagingDir, LAYOUT.evidenceDir);
    for (const dir of [diffDir, evidenceDir]) {
      const dirEnsured = paths.ensureDirectory(context.root, context.rootReal, dir, CODES);
      if (!dirEnsured.ok) throw sanitizeFailure(dirEnsured, context.root);
    }
    const summary = {
      schemaVersion: SCHEMAS.diff,
      versionId,
      parentVersionId: spec.parentVersionId || null,
      treeDigest: built.manifest.treeDigest,
      files: diff.files,
      counts: diff.counts,
      truncated: false,
    };
    const summaryWritten = writeJsonAtomic(path.join(diffDir, LAYOUT.diffSummaryFile), summary, CODES);
    if (!summaryWritten.ok) throw sanitizeFailure(summaryWritten, context.root);

    const version = {
      schemaVersion: SCHEMAS.version,
      versionId,
      parentVersionId: spec.parentVersionId || null,
      createdAt: nowIso(),
      reason: spec.reason,
      base: spec.base,
      treeDigest: built.manifest.treeDigest,
      source: {
        kind: spec.sourceKind,
        ...(spec.attempt ? { attempt: spec.attempt } : {}),
        files: { count: built.manifest.fileCount, bytes: built.manifest.totalBytes },
      },
      diff: {
        parentVersionId: spec.parentVersionId || null,
        added: diff.counts.added,
        modified: diff.counts.modified,
        deleted: diff.counts.deleted,
        unchanged: diff.counts.unchanged,
        summaryRelative: LAYOUT.diffDir + '/' + LAYOUT.diffSummaryFile,
      },
      verification: normalizeVerification(spec.verification),
      evidence: normalizeEvidence(spec.evidence),
      ...(spec.adoption ? { adoption: spec.adoption } : {}),
      storeDraftRef: null,
      presentationPatchRef: null,
    };
    const versionWritten = writeJsonAtomic(path.join(stagingDir, LAYOUT.versionFile), version, CODES);
    if (!versionWritten.ok) throw sanitizeFailure(versionWritten, context.root);

    return ok({ stagingDir, versionId, version, manifest: built.manifest });
  } catch (failureValue) {
    cleanup();
    if (failureValue && failureValue.ok === false) return failureValue;
    return failure(CODES.VERSION_CONFLICT, '.', '版本构建失败');
  }
}

function commitBuiltVersion(context, built) {
  const finalDir = versionDirOf(context, built.versionId);
  if (fs.existsSync(finalDir)) {
    removeTreeSafely(built.stagingDir);
    return failure(CODES.VERSION_IMMUTABLE, 'versionId', '版本已存在，写定后不可修改');
  }
  try {
    fs.renameSync(built.stagingDir, finalDir);
    return ok({ versionDir: finalDir });
  } catch (error) {
    removeTreeSafely(built.stagingDir);
    return failure(CODES.ADOPTION_FAILED, '.', '版本提交失败');
  }
}

function cleanupWorkspaceStaging(stagingDir, projectDir) {
  if (typeof stagingDir !== 'string' || path.dirname(stagingDir) !== projectDir) return;
  if (!path.basename(stagingDir).startsWith('.agent-workspace.staging-')) return;
  let stats;
  try {
    stats = fs.lstatSync(stagingDir);
  } catch (error) {
    return;
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) return;
  removeTreeSafely(stagingDir);
}

function conflictFailure(state, reason, message) {
  return {
    ok: false,
    code: CODES.VERSION_CONFLICT,
    path: '.',
    message: boundedMessage(message),
    state: {
      unavailable: true,
      currentVersionId: state && state.currentVersionId ? state.currentVersionId : null,
      previousVersionId: state && state.previousVersionId ? state.previousVersionId : null,
      redoVersionId: state && state.redoVersionId ? state.redoVersionId : null,
      reason,
    },
  };
}

function pointerDrift(state, version) {
  if (version.parentVersionId !== state.previousVersionId) return 'previousVersionId 与当前版本父链不一致';
  if (state.redoVersionId) {
    const redo = state.versions.find((entry) => entry.versionId === state.redoVersionId);
    if (!redo) return 'redoVersionId 不在版本索引里';
    if (redo.parentVersionId !== state.currentVersionId) return 'redoVersionId 不是当前版本的子版本';
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 只读接口                                                            */
/* ------------------------------------------------------------------ */

function readProjectState(options) {
  const context = readOnlyPaths(options);
  if (!context.ok) return context;
  const loaded = loadState(context);
  if (!loaded.ok) return loaded;
  return ok({ state: loaded.state });
}

function listVersions(options) {
  const loaded = readProjectState(options);
  if (!loaded.ok) return loaded;
  const state = loaded.state;
  return ok({
    currentVersionId: state.currentVersionId,
    previousVersionId: state.previousVersionId,
    redoVersionId: state.redoVersionId,
    versions: state.versions,
  });
}

function readVersion(options) {
  const opts = options || {};
  const context = readOnlyPaths(opts);
  if (!context.ok) return context;
  const loaded = loadState(context);
  if (!loaded.ok) return loaded;
  const versionId = opts.versionId || loaded.state.currentVersionId;
  const doc = readVersionDocument(context, versionId);
  if (!doc.ok) return doc;
  return ok({ version: doc.version });
}

function resolveVersionSource(options) {
  const opts = options || {};
  const context = readOnlyPaths(opts);
  if (!context.ok) return context;
  const loaded = loadState(context);
  if (!loaded.ok) return loaded;
  const state = loaded.state;
  const versionId = opts.versionId || state.currentVersionId;
  if (!versionId) return failure(CODES.VERSION_NOT_FOUND, 'versionId', '项目还没有当前版本');
  const index = state.versions.find((entry) => entry.versionId === versionId);
  if (!index) return failure(CODES.VERSION_NOT_FOUND, 'versionId', '版本不在索引里');
  const doc = readVersionDocument(context, versionId);
  if (!doc.ok) return sanitizeFailure(doc, context.workspaceDir);
  const version = doc.version;
  if (version.parentVersionId !== index.parentVersionId) {
    return failure(CODES.EXPORT_IDENTITY_MISMATCH, 'versionId', '版本父指针与索引不一致');
  }
  const built = manifestMod.buildManifest(path.join(doc.versionDir, LAYOUT.sourceDir), { limits: LIMITS });
  if (!built.ok) return failure(CODES.EXPORT_IDENTITY_MISMATCH, 'versionId', '版本 source 树不可用');
  if (built.manifest.treeDigest !== version.treeDigest || index.treeDigest !== version.treeDigest) {
    return failure(CODES.EXPORT_IDENTITY_MISMATCH, 'versionId', '版本 source 摘要与登记值不一致');
  }
  return ok({
    versionId,
    sourceRoot: path.join(doc.versionDir, LAYOUT.sourceDir),
    treeDigest: built.manifest.treeDigest,
    fileCount: built.manifest.fileCount,
    totalBytes: built.manifest.totalBytes,
    version,
    state,
  });
}

function verifyExportIdentity(options) {
  const opts = options || {};
  const resolved = resolveVersionSource(opts);
  if (!resolved.ok) return resolved;
  const { state, version, versionId } = resolved;
  if (opts.versionId && opts.versionId !== state.currentVersionId) {
    return failure(CODES.EXPORT_IDENTITY_MISMATCH, 'versionId', '导出必须使用当前版本');
  }
  const drift = pointerDrift(state, version);
  if (drift) return failure(CODES.EXPORT_IDENTITY_MISMATCH, '.', drift);
  if (state.versions.filter((entry) => entry.versionId === versionId).length !== 1) {
    return failure(CODES.EXPORT_IDENTITY_MISMATCH, '.', '当前版本在索引里不唯一');
  }
  const adoption = version.adoption && typeof version.adoption === 'object' ? version.adoption : null;
  if (opts.overlayDigest !== undefined) {
    const recorded = adoption ? adoption.integrity : null;
    if (!recorded || recorded !== opts.overlayDigest) {
      return failure(CODES.EXPORT_IDENTITY_MISMATCH, '.', 'overlay 摘要与版本记录不一致');
    }
  }
  if (opts.registryDigest !== undefined) {
    const recorded = adoption ? adoption.registryDigest : null;
    if (!recorded || recorded !== opts.registryDigest) {
      return failure(CODES.EXPORT_IDENTITY_MISMATCH, '.', 'Registry 摘要与版本记录不一致');
    }
  }
  return ok({
    versionId,
    sourceRoot: resolved.sourceRoot,
    treeDigest: resolved.treeDigest,
    fileCount: resolved.fileCount,
    base: version.base,
    verification: version.verification,
    adoption,
    state,
  });
}

function reopenProject(options) {
  const context = readOnlyPaths(options);
  if (!context.ok) return context;
  const loaded = loadState(context);
  if (!loaded.ok) return loaded;
  const state = loaded.state;
  if (!state.currentVersionId) return conflictFailure(state, 'missing', '项目没有当前版本');
  const index = state.versions.find((entry) => entry.versionId === state.currentVersionId);
  if (!index) return conflictFailure(state, 'index', '当前版本不在版本索引里');
  const doc = readVersionDocument(context, state.currentVersionId);
  if (!doc.ok) return conflictFailure(state, 'missing', '当前版本目录或元数据缺失');
  const version = doc.version;
  if (version.parentVersionId !== index.parentVersionId || version.treeDigest !== index.treeDigest) {
    return conflictFailure(state, 'pointer', '版本元数据与索引不一致');
  }
  const built = manifestMod.buildManifest(path.join(doc.versionDir, LAYOUT.sourceDir), { limits: LIMITS });
  if (!built.ok) return conflictFailure(state, 'missing', '当前版本 source 树缺失或不可读');
  if (built.manifest.treeDigest !== version.treeDigest) {
    return conflictFailure(state, 'drift', '当前版本 source 摘要与登记值不一致');
  }
  const drift = pointerDrift(state, version);
  if (drift) return conflictFailure(state, 'pointer', drift);
  return ok({
    currentVersionId: state.currentVersionId,
    previousVersionId: state.previousVersionId,
    redoVersionId: state.redoVersionId,
    treeDigest: built.manifest.treeDigest,
    fileCount: built.manifest.fileCount,
    versions: state.versions,
    available: true,
    state,
  });
}

/* ------------------------------------------------------------------ */
/* 写接口                                                              */
/* ------------------------------------------------------------------ */

function writeProjectStateChecked(context, state) {
  const written = writeState(context, state);
  if (!written.ok) return written;
  return written;
}

function initProject(options) {
  const opts = options || {};
  const ws = workspaceMod.workspacePaths({ userDataDir: opts.userDataDir, projectId: opts.projectId });
  if (!ws.ok) return ws;

  let upgrade = false;
  if (fs.existsSync(ws.projectFile)) {
    const loaded = loadState(ws);
    if (loaded.ok) return ok({ state: loaded.state, created: false, migrated: false, upgraded: false });
    // 兼容 B1：openWorkspace 会先建一个只有 schemaVersion/projectId 的 project.json。
    const rawRead = readJsonBounded(ws.projectFile);
    const raw = rawRead.ok ? rawRead.value : null;
    const b1Minimal = raw && typeof raw === 'object'
      && raw.schemaVersion === SCHEMAS.workspace
      && raw.projectId === ws.projectId
      && raw.currentVersionId === undefined
      && raw.versions === undefined;
    if (!b1Minimal) return loaded;
    if (fs.existsSync(ws.versionsDir)) {
      return failure(CODES.WORKSPACE_INVALID, '.', 'project.json 未登记版本指针，但 versions/ 已存在');
    }
    upgrade = true;
  } else if (fs.existsSync(ws.workspaceDir)) {
    return failure(CODES.WORKSPACE_INVALID, '.', 'agent-workspace 已存在但缺少 project.json（半套工作区）');
  }

  // 旧项目快照：<userData>/projects/<projectId>/project.json（旧链 project-store 的同一位置）。
  let legacy = null;
  const legacyFile = path.join(ws.projectDir, LAYOUT.projectFile);
  if (fs.existsSync(legacyFile)) {
    const read = readJsonBounded(legacyFile);
    if (!read.ok) return failure(CODES.WORKSPACE_INVALID, '.', '旧项目 project.json 无法解析');
    legacy = read.value;
  }
  const candidate = legacy && legacy.frontendCandidate && legacy.frontendCandidate.status === 'adopted'
    ? legacy.frontendCandidate
    : null;

  let adopted = null;
  if (candidate) {
    const inspected = require('../frontend-reconstruct/adoption.cjs').inspectAdoption({
      userDataDir: opts.userDataDir,
      projectId: opts.projectId,
      adoption: candidate,
    });
    if (!inspected || !inspected.ok) {
      return failure(CODES.MIGRATION_FAILED, '.', '旧已采用候选无法校验：' + boundedMessage(inspected && inspected.message));
    }
    const attemptRelative = typeof inspected.attemptRelative === 'string' ? inspected.attemptRelative : '';
    const attemptDir = path.join(ws.root, ...attemptRelative.split('/'));
    if (!attemptRelative || !paths.isInsideOrEqual(ws.root, attemptDir)) {
      return failure(CODES.MIGRATION_FAILED, '.', '旧候选 attempt 目录越界');
    }
    const audited = paths.auditPath(ws.root, ws.rootReal, attemptDir, CODES);
    if (!audited.ok) return failure(CODES.MIGRATION_FAILED, '.', '旧候选 attempt 目录不规范');
    // 旧链候选把可构建源码放在 `candidate/src`（render.cjs 的 file map 键），
    // 与 B2 版本目录里的 `source/` 命名不同；这里只读复制，不做重命名。
    const adoptedSource = path.join(attemptDir, LAYOUT.candidateDir, 'src');
    const canonicalSource = paths.assertCanonicalDir(adoptedSource, CODES);
    if (!canonicalSource.ok) return failure(CODES.MIGRATION_FAILED, '.', '旧候选 source 目录缺失');
    let registryDigest = null;
    try {
      const overlayVerified = require('../frontend-reconstruct/registry-overlay.cjs').verifyOverlay({
        overlayRoot: path.join(attemptDir, 'overlay'),
      });
      if (!overlayVerified || !overlayVerified.ok) {
        return failure(CODES.MIGRATION_FAILED, '.', '旧候选 overlay 摘要校验失败');
      }
      registryDigest = overlayVerified.registryDigest
        || (overlayVerified.loaded && overlayVerified.loaded.registryDigest)
        || null;
    } catch (error) {
      return failure(CODES.MIGRATION_FAILED, '.', '旧候选 overlay 无法校验');
    }
    adopted = {
      attemptRelative,
      attemptDir,
      sourceDir: adoptedSource,
      inspection: inspected,
      registryDigest,
    };
  }

  const base = baseInfoOf();
  if (!base.ok) return base;

  const stagingDir = path.join(ws.projectDir, '.agent-workspace.staging-' + randomSuffix());
  let versionsMovedTo = null;
  try {
    const projectDirEnsured = paths.ensureDirectory(ws.root, ws.rootReal, ws.projectDir, CODES);
    if (!projectDirEnsured.ok) throw sanitizeFailure(projectDirEnsured, ws.root);
    const stagingEnsured = paths.ensureDirectory(ws.root, ws.rootReal, stagingDir, CODES);
    if (!stagingEnsured.ok) throw sanitizeFailure(stagingEnsured, ws.root);
    const stagingCanonical = paths.assertCanonicalDir(stagingDir, CODES);
    if (!stagingCanonical.ok) throw sanitizeFailure(stagingCanonical, ws.root);

    const versionsDir = path.join(stagingDir, LAYOUT.versionsDir);
    const versionsEnsured = paths.ensureDirectory(ws.root, ws.rootReal, versionsDir, CODES);
    if (!versionsEnsured.ok) throw sanitizeFailure(versionsEnsured, ws.root);

    const context = {
      root: ws.root,
      rootReal: ws.rootReal,
      projectId: ws.projectId,
      projectFile: path.join(stagingDir, LAYOUT.projectFile),
      workspaceDir: stagingDir,
      versionsDir,
    };
    const v1 = buildVersion(context, {
      versionId: 'v1',
      parentVersionId: null,
      sourceDir: BASE_SOURCE_DIR,
      reason: 'import-base',
      sourceKind: 'base-copy',
      base: base.base,
    });
    if (!v1.ok) throw v1;
    const v1Committed = commitBuiltVersion(context, v1);
    if (!v1Committed.ok) throw v1Committed;
    const versions = [v1.version];

    let migratedFrom = null;
    if (adopted) {
      const candidateInfo = adopted.inspection;
      const adoption = {
        projectId: ws.projectId,
        runId: candidate.runId,
        attempt: candidate.attempt,
        candidateId: candidateInfo.candidate.candidateId,
        candidateVersion: candidateInfo.candidate.candidateVersion,
        integrity: candidateInfo.candidate.integrity,
        registryDigest: adopted.registryDigest,
        // rev4 §2.6 裁定②：adoption 侧必须能区分两类来源（B3/导出按此分支）。
        sourceKind: 'legacy-migration',
      };
      const migrationId = 'mig-' + crypto.randomBytes(4).toString('hex');
      const v2 = buildVersion(context, {
        versionId: 'v2',
        parentVersionId: 'v1',
        sourceDir: adopted.sourceDir,
        reason: 'import-adopted',
        sourceKind: 'import-adopted',
        attempt: { runId: candidate.runId, turnId: null, attempt: candidate.attempt },
        adoption,
        verification: candidateInfo.verification,
        evidence: {
          checks: [],
          dryRunRelative: candidateInfo.adoption.evidence ? candidateInfo.adoption.evidence.dryRunRelative : null,
          runtimeRelative: candidateInfo.adoption.evidence ? candidateInfo.adoption.evidence.runtimeRelative : null,
        },
        base: base.base,
      });
      if (!v2.ok) throw v2;
      const v2Committed = commitBuiltVersion(context, v2);
      if (!v2Committed.ok) throw v2Committed;
      versions.push(v2.version);
      migratedFrom = { migrationId, candidateId: candidate.candidateId, at: nowIso() };

      const migrationWritten = writeJsonAtomic(path.join(stagingDir, LAYOUT.migrationFile), {
        schemaVersion: SCHEMAS.migration,
        migrations: [{
          migrationId,
          from: {
            frontendCandidate: {
              candidateId: candidate.candidateId,
              runId: candidate.runId,
              attempt: candidate.attempt,
              adoptedAt: candidate.adoptedAt || null,
            },
          },
          createdVersions: ['v1', 'v2'],
          at: nowIso(),
        }],
      }, CODES);
      if (!migrationWritten.ok) throw sanitizeFailure(migrationWritten, ws.root);
    }

    const currentVersionId = adopted ? 'v2' : 'v1';
    const previousVersionId = adopted ? 'v1' : null;
    const state = {
      schemaVersion: SCHEMAS.workspace,
      projectId: ws.projectId,
      createdAt: legacy && typeof legacy.createdAt === 'string' ? legacy.createdAt : nowIso(),
      updatedAt: nowIso(),
      currentVersionId,
      previousVersionId,
      redoVersionId: null,
      versions: versions.map((version) => indexEntryOf(version, version.versionId === currentVersionId)),
      migratedFrom,
    };

    if (upgrade) {
      // B1 已建过 project.json（只有 schemaVersion/projectId）：只补 versions/ 与指针。
      // 顺序：先原子移入 versions/，再原子写 project.json；写失败则删掉刚移入的 versions/。
      versionsMovedTo = ws.versionsDir;
      fs.renameSync(versionsDir, ws.versionsDir);
      const stateWritten = writeJsonAtomic(ws.projectFile, state, CODES);
      if (!stateWritten.ok) throw sanitizeFailure(stateWritten, ws.root);
    } else {
      const stateWritten = writeJsonAtomic(context.projectFile, state, CODES);
      if (!stateWritten.ok) throw sanitizeFailure(stateWritten, ws.root);
      fs.renameSync(stagingDir, ws.workspaceDir);
    }
    cleanupWorkspaceStaging(stagingDir, ws.projectDir);
    return ok({ state, created: !upgrade, migrated: Boolean(adopted), upgraded: upgrade });
  } catch (failureValue) {
    if (versionsMovedTo) removeTreeSafely(versionsMovedTo);
    cleanupWorkspaceStaging(stagingDir, ws.projectDir);
    if (failureValue && failureValue.ok === false) return failureValue;
    return failure(CODES.WORKSPACE_INVALID, '.', '初始化 agent-workspace 失败');
  }
}

function adoptAttempt(options) {
  const opts = options || {};
  const ws = workspaceMod.workspacePaths({ userDataDir: opts.userDataDir, projectId: opts.projectId });
  if (!ws.ok) return ws;
  const loaded = loadState(ws);
  if (!loaded.ok) return loaded;
  const state = loaded.state;
  if (!state.currentVersionId) return failure(CODES.VERSION_NOT_FOUND, '.', '项目还没有当前版本');

  const derived = workspaceMod.attemptPaths({
    userDataDir: opts.userDataDir,
    projectId: opts.projectId,
    runId: opts.runId,
    turnId: opts.turnId,
    attempt: opts.attempt,
  });
  if (!derived.ok) return derived;
  const handle = {
    schemaVersion: SCHEMAS.workspace,
    projectId: ws.projectId,
    userDataDir: derived.root,
    userDataReal: derived.rootReal,
    projectDir: derived.projectDir,
    workspaceDir: derived.workspaceDir,
    projectFile: derived.projectFile,
    versionsDir: derived.versionsDir,
    runsDir: derived.runsDir,
    project: state,
    limits: LIMITS,
  };
  const opened = workspaceMod.openAttempt(handle, { runId: opts.runId, turnId: opts.turnId, attempt: opts.attempt });
  if (!opened.ok) return opened;
  const attempt = opened.attempt;

  const base = baseInfoOf();
  if (!base.ok) return base;
  const next = nextVersionNumber(state);
  if (!next.ok) return next;
  const versionId = next.versionId;
  if (fs.existsSync(versionDirOf(ws, versionId))) {
    return failure(CODES.VERSION_IMMUTABLE, 'versionId', '版本已存在，写定后不可修改');
  }
  const versionsEnsured = paths.ensureDirectory(ws.root, ws.rootReal, ws.versionsDir, CODES);
  if (!versionsEnsured.ok) return sanitizeFailure(versionsEnsured, ws.root);

  const adoption = {
    projectId: ws.projectId,
    runId: opts.runId,
    attempt: attempt.attempt,
    candidateId: 'attempt-' + attempt.attempt,
    candidateVersion: String(Number.isInteger(attempt.revision) ? attempt.revision : 1),
    integrity: attempt.treeDigest,
    // rev4 §2.6 裁定②：adoption 侧必须能区分两类来源（B3/导出按此分支）。
    sourceKind: 'agent-edit',
  };
  const built = buildVersion(ws, {
    versionId,
    parentVersionId: state.currentVersionId,
    sourceDir: attempt.candidateDir,
    reason: 'agent-edit',
    sourceKind: 'agent-edit',
    attempt: { runId: opts.runId, turnId: opts.turnId, attempt: attempt.attempt },
    adoption,
    verification: opts.verification,
    evidence: opts.evidence,
    base: base.base,
  });
  if (!built.ok) return built;
  const committed = commitBuiltVersion(ws, built);
  if (!committed.ok) return committed;

  const nextState = withCurrentFlags({
    ...state,
    currentVersionId: versionId,
    previousVersionId: state.currentVersionId,
    redoVersionId: null,
  }, versionId);
  nextState.versions = [
    ...nextState.versions.filter((entry) => entry.versionId !== versionId),
    indexEntryOf(built.version, true),
  ];
  const written = writeProjectStateChecked(ws, nextState);
  if (!written.ok) {
    removeTreeSafely(versionDirOf(ws, versionId));
    return failure(CODES.ADOPTION_FAILED, '.', '版本指针写入失败，已回滚新版本');
  }
  return ok({
    versionId,
    previousVersionId: state.currentVersionId,
    currentVersionId: versionId,
    version: built.version,
    state: written.state,
    treeDigest: built.version.treeDigest,
  });
}

function undoVersion(options) {
  const opts = options || {};
  const ws = workspaceMod.workspacePaths({ userDataDir: opts.userDataDir, projectId: opts.projectId });
  if (!ws.ok) return ws;
  const loaded = loadState(ws);
  if (!loaded.ok) return loaded;
  const state = loaded.state;
  if (!state.currentVersionId) return failure(CODES.VERSION_NOT_FOUND, '.', '项目还没有当前版本');
  if (!state.previousVersionId) return failure(CODES.UNDO_UNAVAILABLE, '.', '没有可撤销的父版本');
  const current = readVersionDocument(ws, state.currentVersionId);
  if (!current.ok) return sanitizeFailure(current, ws.workspaceDir);
  const previous = readVersionDocument(ws, state.previousVersionId);
  if (!previous.ok) return sanitizeFailure(previous, ws.workspaceDir);
  if (current.version.parentVersionId !== previous.version.versionId) {
    return failure(CODES.VERSION_CONFLICT, '.', 'current/previous 指针与版本父链不一致');
  }
  const nextState = withCurrentFlags({
    ...state,
    currentVersionId: previous.version.versionId,
    previousVersionId: previous.version.parentVersionId,
    redoVersionId: state.currentVersionId,
  }, previous.version.versionId);
  const written = writeProjectStateChecked(ws, nextState);
  if (!written.ok) return written;
  return ok({
    currentVersionId: written.state.currentVersionId,
    previousVersionId: written.state.previousVersionId,
    redoVersionId: written.state.redoVersionId,
    state: written.state,
  });
}

function redoVersion(options) {
  const opts = options || {};
  const ws = workspaceMod.workspacePaths({ userDataDir: opts.userDataDir, projectId: opts.projectId });
  if (!ws.ok) return ws;
  const loaded = loadState(ws);
  if (!loaded.ok) return loaded;
  const state = loaded.state;
  if (!state.redoVersionId) return failure(CODES.REDO_UNAVAILABLE, '.', '没有可重做的版本');
  if (!state.currentVersionId) return failure(CODES.VERSION_NOT_FOUND, '.', '项目还没有当前版本');
  const target = readVersionDocument(ws, state.redoVersionId);
  if (!target.ok) return failure(CODES.VERSION_CONFLICT, '.', '重做目标版本不存在');
  if (target.version.parentVersionId !== state.currentVersionId) {
    return failure(CODES.VERSION_CONFLICT, '.', 'redo 目标不是当前版本的子版本');
  }
  const children = state.versions.filter((entry) => entry.versionId !== state.currentVersionId
    && entry.parentVersionId === state.currentVersionId);
  if (children.length > 1) {
    return failure(CODES.VERSION_CONFLICT, '.', '历史出现分叉：redo 目标不唯一');
  }
  const nextState = withCurrentFlags({
    ...state,
    currentVersionId: target.version.versionId,
    previousVersionId: state.currentVersionId,
    redoVersionId: null,
  }, target.version.versionId);
  const written = writeProjectStateChecked(ws, nextState);
  if (!written.ok) return written;
  return ok({
    currentVersionId: written.state.currentVersionId,
    previousVersionId: written.state.previousVersionId,
    redoVersionId: written.state.redoVersionId,
    state: written.state,
  });
}

module.exports = {
  CODES,
  SCHEMAS,
  BASE_SOURCE_DIR,
  // 只读
  readProjectState,
  listVersions,
  readVersion,
  resolveVersionSource,
  verifyExportIdentity,
  reopenProject,
  // 写
  initProject,
  adoptAttempt,
  undoVersion,
  redoVersion,
  // 形状常量（B3 接线用）
  MIGRATION_ID_PATTERN,
  VERSION_ID_PATTERN,
};
