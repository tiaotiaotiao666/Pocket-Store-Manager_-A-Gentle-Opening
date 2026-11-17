'use strict';

/**
 * P5：已采用候选前端的「项目私有 overlay」解析与快照白名单（Electron 主进程）。
 *
 * 两个职责都只碰应用私有工作区：
 * 1. `pickAdoption`：project.json 只允许存 id/version/摘要/相对路径/Plan 引用/验证状态；
 *    base64、本机绝对路径、原始 trace 与大错误文本一律丢弃（与 renderer 的
 *    `src/domain/projectSnapshot.mjs` 同形，测试做字节级对齐）。
 * 2. `inspectAdoption` / `resolveExportOverlay`：按 projectId+runId+attempt 推导目录，
 *    逐段 canonical 复核，校验 attempt.json / run.json / overlay 注册表摘要，
 *    确认「重开项目」和「正式导出」用的是同一个候选 overlay。
 *
 * 安全不变量：绝不接受调用方传入的目录；不写全局 templates/miniprogram/Registry；
 * 返回体不含本机绝对路径。
 */

const fs = require('node:fs');
const path = require('node:path');

const workspace = require('./workspace.cjs');
const { verifyOverlay, overlayAssetRoots } = require('./registry-overlay.cjs');

const SCHEMA_VERSION = 'frontend-candidate-adoption.v1';
const STATUSES = Object.freeze(['none', 'adopted', 'unavailable']);
const RUNTIME_STATUSES = Object.freeze(['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN']);

const LIMITS = Object.freeze({
  maxText: 120,
  maxId: 80,
  maxVersion: 24,
  maxPath: 240,
  maxIssueChars: 160,
  maxScreenshots: 24,
  maxPreviousDepth: 1,
  maxMetaBytes: 128 * 1024,
});

const CODES = Object.freeze({
  INVALID: 'FRONTEND_CANDIDATE_INVALID',
  MISSING: 'FRONTEND_CANDIDATE_MISSING',
  UNVERIFIED: 'FRONTEND_CANDIDATE_UNVERIFIED',
  DIGEST_MISMATCH: 'FRONTEND_DIGEST_MISMATCH',
  OVERLAY_MISSING: 'FRONTEND_OVERLAY_MISSING',
  OVERLAY_MISMATCH: 'FRONTEND_OVERLAY_MISMATCH',
  WORKSPACE_INVALID: 'FRONTEND_WORKSPACE_INVALID',
});

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const DRIVE_PATTERN = /^[A-Za-z]:/;
const RUN_ID_PATTERN = /^frun-[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/;
const CANDIDATE_OVERLAY_KEYS = Object.freeze([
  'projectId',
  'runId',
  'attempt',
  'candidateId',
  'candidateVersion',
  'integrity',
  'runtimeStatus',
  'repairs',
]);

function canonicalRelativePath(value) {
  if (typeof value !== 'string' || !value || value.length > LIMITS.maxPath) return null;
  if (value !== value.trim() || value.includes('\\') || value.includes('\0')) return null;
  if (value.startsWith('/') || DRIVE_PATTERN.test(value)) return null;
  const segments = value.split('/');
  if (!segments.every((segment) => segment && segment !== '.' && segment !== '..')) return null;
  return value;
}

function looksLikeBlob(value) {
  return typeof value === 'string' && value.length > 400 && /^[A-Za-z0-9+/=\s]+$/.test(value);
}

function candidateText(value, maxLength) {
  if (typeof value !== 'string' || looksLikeBlob(value)) return '';
  return value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function candidateDigest(value) {
  return typeof value === 'string' && SHA256_PATTERN.test(value) ? value : null;
}

function pickPlan(raw) {
  const plan = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const pack = plan.frontendPack && typeof plan.frontendPack === 'object' ? plan.frontendPack : {};
  const base = plan.baseTemplate && typeof plan.baseTemplate === 'object' ? plan.baseTemplate : {};
  return {
    planId: candidateText(plan.planId, 60) || null,
    planVersion: candidateText(plan.planVersion, 24) || null,
    frontendPack: {
      id: candidateText(pack.id, LIMITS.maxId) || null,
      version: candidateText(pack.version, LIMITS.maxVersion) || null,
    },
    baseTemplate: {
      id: candidateText(base.id, 40) || 'ordering-base',
      version: candidateText(base.version, LIMITS.maxVersion) || null,
    },
  };
}

function pickVerification(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    static: source.static === 'pass' ? 'pass' : (source.static === 'fail' ? 'fail' : 'unknown'),
    runtime: RUNTIME_STATUSES.includes(source.runtime) ? source.runtime : 'NOT_RUN',
    repairs: Number.isInteger(source.repairs) && source.repairs >= 0 && source.repairs <= 2 ? source.repairs : 0,
    screenshots: Number.isInteger(source.screenshots) && source.screenshots >= 0
      ? Math.min(source.screenshots, LIMITS.maxScreenshots)
      : 0,
    checkedAt: candidateText(source.checkedAt, 40) || null,
  };
}

function pickEvidence(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    dryRunRelative: canonicalRelativePath(source.dryRunRelative),
    runtimeRelative: canonicalRelativePath(source.runtimeRelative),
  };
}

function pickIssue(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const code = candidateText(raw.code, 60);
  const message = candidateText(raw.message, LIMITS.maxIssueChars);
  if (!code && !message) return null;
  return {
    code: code || CODES.INVALID,
    message: message || '已采用的候选前端当前不可用，已回退到 Base 页面。',
  };
}

function emptyAdoption() {
  return {
    schemaVersion: SCHEMA_VERSION,
    status: 'none',
    candidateId: null,
    candidateVersion: null,
    integrity: null,
    runId: null,
    projectId: null,
    attempt: null,
    overlayRelative: null,
    attemptRelative: null,
    registryDigest: null,
    plan: pickPlan(null),
    verification: pickVerification(null),
    evidence: pickEvidence(null),
    adoptedAt: null,
    previous: null,
    issue: null,
    verified: false,
  };
}

/** 与 projectSnapshot.pickFrontendCandidate 同形：白名单 + 越界/大文本剥离 + 失败关闭。 */
function pickAdoption(raw, options = {}) {
  const empty = emptyAdoption();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty;
  const depth = Number.isInteger(options.depth) && options.depth >= 0 ? options.depth : 0;
  const declared = STATUSES.includes(raw.status) ? raw.status : 'none';
  if (declared === 'none') return empty;

  const candidateId = candidateText(raw.candidateId, LIMITS.maxId);
  const candidateVersion = candidateText(raw.candidateVersion, LIMITS.maxVersion);
  const integrity = candidateDigest(raw.integrity);
  const overlayRelative = canonicalRelativePath(raw.overlayRelative);
  const attemptRelative = canonicalRelativePath(raw.attemptRelative);
  const registryDigest = candidateDigest(raw.registryDigest);
  const plan = pickPlan(raw.plan);
  const verification = pickVerification(raw.verification);
  const evidence = pickEvidence(raw.evidence);
  const identity = {
    candidateId: candidateId || null,
    candidateVersion: candidateVersion || null,
    integrity,
    runId: RUN_ID_PATTERN.test(candidateText(raw.runId, 80)) ? candidateText(raw.runId, 80) : null,
    projectId: candidateText(raw.projectId, LIMITS.maxId) || null,
    attempt: Number.isInteger(raw.attempt) && raw.attempt >= 1 && raw.attempt <= 9999 ? raw.attempt : null,
    plan,
    verification,
    evidence,
    adoptedAt: candidateText(raw.adoptedAt, 40) || null,
  };
  if (!candidateId || !candidateVersion) {
    return { ...empty, ...identity, status: 'unavailable', issue: { code: CODES.INVALID, message: '候选记录缺少 id/version，已回退到 Base 页面。' } };
  }
  if (declared === 'adopted' && !overlayRelative) {
    return { ...empty, ...identity, status: 'unavailable', issue: { code: CODES.OVERLAY_MISSING, message: '候选 overlay 引用缺失，已回退到 Base 页面。' } };
  }
  if (declared === 'adopted' && !integrity) {
    return { ...empty, ...identity, status: 'unavailable', issue: { code: CODES.DIGEST_MISMATCH, message: '候选摘要缺失，已回退到 Base 页面。' } };
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    status: declared,
    ...identity,
    overlayRelative,
    attemptRelative,
    registryDigest,
    previous: depth < LIMITS.maxPreviousDepth && raw.previous && typeof raw.previous === 'object'
      ? pickAdoption(raw.previous, { depth: depth + 1 })
      : null,
    issue: declared === 'unavailable'
      ? (pickIssue(raw.issue) || { code: CODES.INVALID, message: '已采用的候选前端当前不可用，已回退到 Base 页面。' })
      : null,
    verified: false,
  };
}

function readJsonBounded(file, limit) {
  let stats;
  try {
    stats = fs.statSync(file);
  } catch (error) {
    return { ok: false, code: 'ENOENT', message: '文件不存在' };
  }
  if (!stats.isFile() || stats.size > limit) {
    return { ok: false, code: 'TOO_LARGE', message: '文件体积超过上限或不是普通文件' };
  }
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (error) {
    return { ok: false, code: 'INVALID', message: 'JSON 无法解析' };
  }
}

function fail(code, message, details) {
  return { ok: false, code, message, details: details || null };
}

/**
 * 按 projectId+runId+attempt 解析 attempt 目录（不创建任何东西）。
 * 只接受 id：调用方给不了目录。
 */
function resolveAttempt(userDataDir, projectId, runId, attempt) {
  if (typeof userDataDir !== 'string' || !path.isAbsolute(userDataDir)) {
    return fail(CODES.WORKSPACE_INVALID, '应用私有目录不可用，无法确认候选 overlay');
  }
  if (typeof projectId !== 'string' || !workspace.PROJECT_ID_PATTERN.test(projectId)) {
    return fail(CODES.INVALID, '候选记录缺少合法的 projectId');
  }
  if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) {
    return fail(CODES.INVALID, '候选记录缺少合法的 runId');
  }
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 9999) {
    return fail(CODES.INVALID, '候选记录缺少合法的 attempt');
  }
  const paths = workspace.workspacePaths({ userDataDir, projectId, runId });
  if (!paths.ok) {
    return fail(CODES.WORKSPACE_INVALID, '候选工作区路径不可用');
  }
  const attemptDir = path.join(paths.attemptsDir, 'attempt-' + attempt);
  if (!workspace.isInsideOrEqual(paths.attemptsDir, attemptDir)) {
    return fail(CODES.WORKSPACE_INVALID, '候选目录越界');
  }
  if (!fs.existsSync(attemptDir)) {
    return fail(CODES.MISSING, '候选 attempt 已不存在（可能被清理），请重新生成');
  }
  const audit = workspace.auditPath(paths.userDataDir, paths.userDataReal, attemptDir);
  if (!audit.ok) {
    return fail(CODES.WORKSPACE_INVALID, '候选目录不规范（可能存在链接或越界）');
  }
  const canonical = workspace.assertCanonicalDir(attemptDir);
  if (!canonical.ok) {
    return fail(CODES.WORKSPACE_INVALID, '候选目录不是规范目录');
  }
  const metaRead = readJsonBounded(path.join(attemptDir, 'attempt.json'), LIMITS.maxMetaBytes);
  if (!metaRead.ok) {
    return fail(CODES.MISSING, '候选 attempt.json 不可用：' + metaRead.message);
  }
  const meta = metaRead.value;
  if (!meta || typeof meta !== 'object'
    || meta.schemaVersion !== 'frontend-attempt.v1'
    || meta.projectId !== projectId
    || meta.runId !== runId
    || meta.attempt !== attempt
    || meta.status !== 'committed'
    || !meta.candidate || typeof meta.candidate !== 'object') {
    return fail(CODES.INVALID, '候选 attempt.json 与请求的身份不一致');
  }
  const run = workspace.readRun(paths);
  const registered = Boolean(run
    && run.schemaVersion === 'frontend-run.v1'
    && run.projectId === projectId
    && run.runId === runId
    && Array.isArray(run.attempts)
    && run.attempts.some((entry) => entry && entry.attempt === attempt
      && entry.candidateId === meta.candidate.id
      && entry.integrity === meta.candidate.integrity));
  if (!registered) {
    return fail(CODES.INVALID, '候选 attempt 未在本应用的 run.json 里登记');
  }
  return {
    ok: true,
    attemptDir,
    meta,
    overlayDir: path.join(attemptDir, 'overlay'),
    attemptRelative: path.relative(paths.userDataDir, attemptDir).replace(/\\/g, '/'),
    overlayRelative: path.relative(paths.userDataDir, path.join(attemptDir, 'overlay')).replace(/\\/g, '/'),
  };
}

function verifyOverlayForCandidate(attemptInfo, candidateId, candidateVersion, integrity) {
  if (!fs.existsSync(attemptInfo.overlayDir)) {
    return fail(CODES.MISSING, '候选 overlay 目录已不存在');
  }
  let verified;
  try {
    verified = verifyOverlay({ overlayRoot: attemptInfo.overlayDir });
  } catch (error) {
    return fail(CODES.INVALID, '候选 overlay 校验异常');
  }
  if (!verified.ok) {
    return fail(CODES.DIGEST_MISMATCH, '候选 overlay 摘要不一致：' + (verified.message || verified.code || '校验失败'));
  }
  const key = candidateId + '@' + candidateVersion;
  const candidate = verified.loaded && verified.loaded.byKey ? verified.loaded.byKey.get(key) : null;
  if (!candidate || candidate.kind !== 'frontend-pack') {
    return fail(CODES.OVERLAY_MISMATCH, '候选 overlay 中没有 ' + key + ' 这个 FrontendPack');
  }
  if (integrity && candidate.integrity !== integrity) {
    return fail(CODES.DIGEST_MISMATCH, '候选 integrity 与 overlay 不一致');
  }
  return {
    ok: true,
    overlayRoot: attemptInfo.overlayDir,
    assetRoots: overlayAssetRoots(attemptInfo.overlayDir),
    integrity: candidate.integrity,
    registryDigest: verified.registryDigest
      || (verified.loaded && verified.loaded.registryDigest)
      || null,
  };
}

/**
 * 重开项目时的完整性校验：快照里的 adoption 必须能对上同一 attempt 的 overlay 与摘要。
 */
function inspectAdoption(options = {}) {
  const adoption = pickAdoption(options.adoption);
  if (adoption.status !== 'adopted') {
    return fail(adoption.issue ? adoption.issue.code : CODES.INVALID, adoption.issue ? adoption.issue.message : '没有已采用的候选前端');
  }
  const resolved = resolveAttempt(options.userDataDir, options.projectId, adoption.runId, adoption.attempt);
  if (!resolved.ok) return resolved;
  const meta = resolved.meta;
  if (meta.candidate.id !== adoption.candidateId || meta.candidate.version !== adoption.candidateVersion) {
    return fail(CODES.OVERLAY_MISMATCH, '快照候选与 attempt.json 不是同一个候选');
  }
  if (adoption.integrity && meta.candidate.integrity !== adoption.integrity) {
    return fail(CODES.DIGEST_MISMATCH, '快照候选摘要与 attempt.json 不一致');
  }
  if (adoption.overlayRelative && adoption.overlayRelative !== resolved.overlayRelative) {
    return fail(CODES.OVERLAY_MISMATCH, '快照 overlay 引用与当前工作区不一致');
  }
  const verified = verifyOverlayForCandidate(resolved, adoption.candidateId, adoption.candidateVersion, adoption.integrity);
  if (!verified.ok) return verified;
  if (adoption.registryDigest && verified.registryDigest && adoption.registryDigest !== verified.registryDigest) {
    return fail(CODES.DIGEST_MISMATCH, '候选 overlay 注册表摘要与快照不一致');
  }
  return {
    ok: true,
    adoption: { ...adoption, verified: true },
    overlayRoot: verified.overlayRoot,
    assetRoots: verified.assetRoots,
    candidate: {
      candidateId: adoption.candidateId,
      candidateVersion: adoption.candidateVersion,
      integrity: verified.integrity,
      runtimeStatus: adoption.verification.runtime,
      repairs: adoption.verification.repairs,
    },
    verification: adoption.verification,
    attemptRelative: resolved.attemptRelative,
    overlayRelative: resolved.overlayRelative,
  };
}

/**
 * 正式导出入口：渲染进程只传候选 id，主进程按 id 解析同一 overlay 并校验摘要。
 * 缺 overlay / 摘要漂移 / Plan 与候选不一致都返回结构化失败，调用方必须阻断导出。
 */
function resolveExportOverlay(options = {}) {
  const overlay = options.candidateOverlay;
  if (!overlay || typeof overlay !== 'object' || Array.isArray(overlay)) {
    return fail(CODES.OVERLAY_MISSING, 'Plan 引用了候选 FrontendPack，但请求里没有候选 overlay');
  }
  const unknown = Object.keys(overlay).filter((key) => !CANDIDATE_OVERLAY_KEYS.includes(key));
  if (unknown.length > 0) {
    return fail(CODES.INVALID, '候选 overlay 只接受受控 id，不接受路径或额外字段');
  }
  const candidateId = candidateText(overlay.candidateId, LIMITS.maxId);
  const candidateVersion = candidateText(overlay.candidateVersion, LIMITS.maxVersion);
  const integrity = candidateDigest(overlay.integrity);
  if (!candidateId) return fail(CODES.INVALID, '候选 overlay 缺少 candidateId');
  const resolved = resolveAttempt(options.userDataDir, overlay.projectId, overlay.runId, overlay.attempt);
  if (!resolved.ok) return resolved;
  const meta = resolved.meta;
  const version = candidateVersion || meta.candidate.version;
  if (meta.candidate.id !== candidateId) {
    return fail(CODES.OVERLAY_MISMATCH, '候选 overlay 与 attempt.json 不是同一个候选');
  }
  if (candidateVersion && meta.candidate.version !== candidateVersion) {
    return fail(CODES.OVERLAY_MISMATCH, '候选版本与 attempt.json 不一致');
  }
  if (integrity && meta.candidate.integrity !== integrity) {
    return fail(CODES.DIGEST_MISMATCH, '候选摘要与 attempt.json 不一致');
  }
  const frontendPack = options.frontendPack && typeof options.frontendPack === 'object' ? options.frontendPack : null;
  if (frontendPack && (frontendPack.id !== candidateId || (frontendPack.version && frontendPack.version !== version))) {
    return fail(CODES.OVERLAY_MISMATCH, 'Plan 的 frontendPack 与候选 overlay 不一致');
  }
  const verified = verifyOverlayForCandidate(resolved, candidateId, version, integrity || meta.candidate.integrity);
  if (!verified.ok) return verified;
  return {
    ok: true,
    overlayRoot: verified.overlayRoot,
    assetRoots: verified.assetRoots,
    candidate: {
      candidateId,
      candidateVersion: version,
      integrity: verified.integrity,
      attempt: overlay.attempt,
      runId: overlay.runId,
      projectId: overlay.projectId,
      runtimeStatus: RUNTIME_STATUSES.includes(overlay.runtimeStatus) ? overlay.runtimeStatus : 'NOT_RUN',
      repairs: Number.isInteger(overlay.repairs) && overlay.repairs >= 0 && overlay.repairs <= 2 ? overlay.repairs : 0,
      usedOverlay: true,
    },
    attemptRelative: resolved.attemptRelative,
    overlayRelative: resolved.overlayRelative,
  };
}

module.exports = {
  SCHEMA_VERSION,
  STATUSES,
  LIMITS,
  CODES,
  CANDIDATE_OVERLAY_KEYS,
  canonicalRelativePath,
  pickAdoption,
  emptyAdoption,
  resolveAttempt,
  inspectAdoption,
  resolveExportOverlay,
  verifyOverlayForCandidate,
};
