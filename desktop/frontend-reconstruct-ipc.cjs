'use strict';

/**
 * P4：候选前端的受信 IPC（Electron 主进程侧）。
 *
 * 只给渲染进程 7 个命令式语义入口 + 1 个进度订阅：
 *   frontend:analyze / build-candidate / validate-candidate / verify-candidate /
 *   adopt-candidate / discard-candidate / cancel-run，进度走 `frontend:progress` 事件。
 *
 * 安全边界（改动必须保持）：
 * 1. 只接受可信 sender（复用 composer-ipc 的 file:// 与本地开发地址白名单），
 *    不接受渲染进程传入的任意路径、命令、脚本或模块名。
 * 2. 每项目单任务串行：同一 projectId 同时只允许一个长任务，第二次返回 FRONTEND_BUSY；
 *    全局最多 2 个在途任务，避免 IPC 变成并发放大器。
 * 3. 取消按 runId 生效：只置本次任务的 signal，绝不误杀别的项目/别的 run。
 * 4. payload 有界：整体体积、图片字节、base64 长度、utterance、草稿体积、页数都设上限，
 *    未知键直接拒绝（避免把渲染进程的任意数据混进本地执行模块）。
 * 5. 写操作（build/adopt/discard/verify）只允许来自**本应用创建的私有 workspace**：
 *    路径由 projectId+runId+attempt 推导，逐段 canonical 复核，attempt.json 身份必须匹配，
 *    并且要么本会话创建过，要么已在 app 自己写的 run.json 里登记；渲染进程给不了目录。
 * 6. 返回体只含有界结论与相对路径，绝不回传绝对路径、base64、原始模型响应或完整日志。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { isTrustedSender } = require('./composer-ipc.cjs');
const { createDesktopCredentialProvider } = require('./desktop-session.cjs');
const { applyAppid: defaultApplyAppid } = require('./appid-postprocess.cjs');
const defaultReconstruct = require('./frontend-reconstruct/index.cjs');

/** 契约既有常量（版本/目标页/上限/ID 正则）只从生成模块取，不再本地复制。 */
const {
  CONTRACT_VERSION,
  TARGET_PAGES,
  LIMITS: CONTRACT_LIMITS,
  RUN_ID_PATTERN,
  PROJECT_ID_PATTERN,
  CONTROL_CHAR_NARROW_PATTERN: CONTROL_CHAR_PATTERN,
} = require('./frontend-reconstruct/contract.generated.cjs');

const IMAGE_MEDIA_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp']);

const MAX_PAYLOAD_BYTES = 1024 * 1024;
const MAX_IMAGE_BYTES = 400 * 1024;
const MAX_IMAGE_BASE64_CHARS = Math.ceil((MAX_IMAGE_BYTES / 3) * 4) + 8;
const MAX_UTTERANCE_CHARS = CONTRACT_LIMITS.maxUtteranceChars;
const MAX_TARGET_PAGES = CONTRACT_LIMITS.maxDraftPages;
const MAX_DRAFT_BYTES = 64 * 1024;
const MAX_PLAN_BYTES = 256 * 1024;
const STORE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const APPID_PATTERN = /^wx[0-9a-f]{16}$/;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_ATTEMPT_META_BYTES = 128 * 1024;
const MAX_EVIDENCE_BYTES = 512 * 1024;
const MAX_CHECKS = 12;
const MAX_ISSUES = 8;
const MAX_SCREENSHOTS = 24;
const MAX_MESSAGE_CHARS = 240;
const MAX_ACTIVE_RUNS = 2;
// 识别是「视觉模型 → 工具 → 再出结果」的多轮链路，单次视觉调用实测 3–23 秒，
// 不能再和对话共用 agentTimeoutMs（默认 30 秒，且可被用户调到 12 秒）。
// 上限对齐服务端 runAgent 的 maxWallClockMs（contracts/frontend-reconstruct.v1.json）。
const ANALYZE_MIN_TIMEOUT_MS = 15 * 1000;
const ANALYZE_MAX_TIMEOUT_MS = 120 * 1000;
const ANALYZE_DEFAULT_TIMEOUT_MS = ANALYZE_MAX_TIMEOUT_MS;
// 只有「识别链路自身失败」才落盘；参数/图片/会话问题不制造运行记录。
const ANALYZE_FAILURE_CODES = Object.freeze([
  'FRONTEND_ANALYZE_TIMEOUT',
  'FRONTEND_ANALYZE_FAILED',
  'FRONTEND_ANALYZE_UNAVAILABLE',
  'FRONTEND_ANALYZE_AUTH_REQUIRED',
  'FRONTEND_ANALYZE_RATE_LIMITED',
]);
// 候选产物的文件数/单文件/总体积上限（防御性边界，正常渲染远小于此）。
const MAX_CANDIDATE_FILES = 48;
const MAX_CANDIDATE_FILE_BYTES = 128 * 1024;
const MAX_CANDIDATE_TOTAL_BYTES = 512 * 1024;

const ATTEMPT_PATTERN = /^attempt-([1-9][0-9]{0,3})$/;
const ATTEMPT_SCHEMA_VERSION = 'frontend-attempt.v1';
const RUN_SCHEMA_VERSION = 'frontend-run.v1';
const ADOPTION_SCHEMA_VERSION = 'frontend-adoption.v1';
const DISCARD_SCHEMA_VERSION = 'frontend-discard.v1';
// B5：截图外发确认。确认只在「这张图 + 这个接收方 + 15 分钟内」有效，
// 主进程自己再校验一次，不信任渲染进程传来的状态。
const CONSENT_SCHEMA_VERSION = 'frontend-consent.v1';
const CONSENT_PURPOSE = 'frontend-reconstruct';
const CONSENT_MAX_AGE_MS = 15 * 60 * 1000;
const CONSENT_CLOCK_SKEW_MS = 60 * 1000;
const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const DRY_RUN_RESULT_FILE = 'frontend-dry-run.json';
const RUNTIME_WRAPPER_FILE = 'frontend-runtime.json';
const DRY_RUN_DIR_PATTERN = /^dry-run(?:-([1-9][0-9]?))?$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

const CODES = Object.freeze({
  UNTRUSTED_SENDER: 'UNTRUSTED_SENDER',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  PAYLOAD_INVALID: 'FRONTEND_PAYLOAD_INVALID',
  IMAGE_INVALID: 'FRONTEND_IMAGE_INVALID',
  IMAGE_TYPE: 'FRONTEND_IMAGE_TYPE',
  IMAGE_TOO_LARGE: 'FRONTEND_IMAGE_TOO_LARGE',
  UTTERANCE_TOO_LONG: 'FRONTEND_UTTERANCE_TOO_LONG',
  TARGET_PAGES_INVALID: 'FRONTEND_TARGET_PAGES_INVALID',
  BUSY: 'FRONTEND_BUSY',
  NO_ACTIVE_RUN: 'FRONTEND_NO_ACTIVE_RUN',
  PROJECT_ID_INVALID: 'FRONTEND_PROJECT_ID_INVALID',
  RUN_ID_INVALID: 'FRONTEND_RUN_ID_INVALID',
  ATTEMPT_INVALID: 'FRONTEND_ATTEMPT_INVALID',
  WORKSPACE_NOT_OWNED: 'FRONTEND_WORKSPACE_NOT_OWNED',
  WORKSPACE_INVALID: 'FRONTEND_WORKSPACE_INVALID',
  ATTEMPT_MISSING: 'FRONTEND_ATTEMPT_MISSING',
  CANDIDATE_TOO_LARGE: 'FRONTEND_CANDIDATE_TOO_LARGE',
  VERIFICATION_MISSING: 'FRONTEND_VERIFICATION_MISSING',
  STATIC_GATES_FAILED: 'FRONTEND_STATIC_GATES_FAILED',
  PARTIAL_CONFIRM_REQUIRED: 'FRONTEND_PARTIAL_CONFIRM_REQUIRED',
  // B1：运行时证据与 FAIL 的采用门禁
  RUNTIME_FAILED: 'FRONTEND_RUNTIME_FAILED',
  RUNTIME_EVIDENCE_STALE: 'FRONTEND_RUNTIME_EVIDENCE_STALE',
  ANALYZE_FAILED: 'FRONTEND_ANALYZE_FAILED',
  ANALYZE_TIMEOUT: 'FRONTEND_ANALYZE_TIMEOUT',
  ANALYZE_UNAVAILABLE: 'FRONTEND_ANALYZE_UNAVAILABLE',
  // B2：会话问题与模型不可用必须分开说，401 不能伪装成「模型挂了」。
  ANALYZE_AUTH_REQUIRED: 'FRONTEND_ANALYZE_AUTH_REQUIRED',
  ANALYZE_RATE_LIMITED: 'FRONTEND_ANALYZE_RATE_LIMITED',
  CONTRACT_MISMATCH: 'FRONTEND_CONTRACT_MISMATCH',
  CANCELLED: 'FRONTEND_CANCELLED',
  BUILD_FAILED: 'FRONTEND_BUILD_FAILED',
  VERIFY_FAILED: 'FRONTEND_VERIFY_FAILED',
  APPID_WRITE_FAILED: 'FRONTEND_APPID_WRITE_FAILED',
  ADOPT_FAILED: 'FRONTEND_ADOPT_FAILED',
  DISCARD_FAILED: 'FRONTEND_DISCARD_FAILED',
  // B5：截图外发确认
  CONSENT_REQUIRED: 'FRONTEND_CONSENT_REQUIRED',
  CONSENT_EXPIRED: 'FRONTEND_CONSENT_EXPIRED',
  CONSENT_SCOPE_MISMATCH: 'FRONTEND_CONSENT_SCOPE_MISMATCH',
  CONSENT_UNRECORDED: 'FRONTEND_CONSENT_UNRECORDED',
});

const STAGE_LABELS = Object.freeze({
  analyze: '识别截图与能力覆盖',
  materialize: '准备私有候选工作区',
  validate: '校验草稿与能力事实',
  render: '生成候选页面',
  workspace: '准备私有工作区',
  write: '写入候选与 overlay',
  verify: '校验 overlay 注册表',
  commit: '提交候选 attempt',
  compose: 'Composer P0–P6 校验',
  'mini-check': '小程序静态校验',
  consistency: '产物一致性检查',
  observable: '可观察项对照',
  done: '完成',
});

const RUNTIME_PASS = 'PASS';
const RUNTIME_STATUSES = Object.freeze(['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN']);

const ALLOWED_KEYS = Object.freeze({
  'frontend:analyze': Object.freeze([
    'runId', 'projectId', 'requestId', 'utterance', 'image', 'targetPages', 'current', 'client', 'contractVersion',
    'consent',
  ]),
  'frontend:build-candidate': Object.freeze(['projectId', 'runId', 'draft', 'plan', 'storeId', 'backendVersions']),
  'frontend:validate-candidate': Object.freeze(['projectId', 'runId', 'attempt']),
  'frontend:verify-candidate': Object.freeze(['projectId', 'runId', 'attempt', 'appId', 'timeoutMs']),
  'frontend:adopt-candidate': Object.freeze(['projectId', 'runId', 'attempt', 'partialConfirmed']),
  'frontend:discard-candidate': Object.freeze(['projectId', 'runId', 'attempt']),
  'frontend:cancel-run': Object.freeze(['projectId', 'runId']),
});

function ok(extra) {
  return { ok: true, ...(extra || {}) };
}

function fail(code, message, details) {
  return { ok: false, code, message: bounded(message || code, MAX_MESSAGE_CHARS), details: details || null };
}

function bounded(value, limit) {
  const text = typeof value === 'string' ? value : '';
  const compact = text.replace(CONTROL_CHAR_PATTERN, ' ').replace(/\s+/g, ' ').trim();
  return compact.length > limit ? compact.slice(0, limit) : compact;
}

function boundedDetail(error) {
  if (!error) return 'UNKNOWN';
  const code = error.code && /^[A-Z0-9_]+$/.test(String(error.code)) ? String(error.code) : 'ERROR';
  return bounded(code + ':' + (error.message || ''), 120);
}

function payloadBytes(payload) {
  try {
    return Buffer.byteLength(JSON.stringify(payload), 'utf8');
  } catch (error) {
    return Number.MAX_SAFE_INTEGER;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readJsonBounded(file, limit) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    return { ok: false, code: 'ENOENT', message: '文件不存在' };
  }
  if (!stat.isFile() || stat.size > limit) {
    return { ok: false, code: 'TOO_LARGE', message: '文件体积超过上限或不是普通文件' };
  }
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (error) {
    return { ok: false, code: 'INVALID', message: 'JSON 无法解析' };
  }
}

function checkUnknownKeys(payload, allowed) {
  const keys = Object.keys(payload || {});
  const unknown = keys.filter((key) => !allowed.includes(key));
  return unknown;
}

function acquireSlot(state, event, projectId, runId) {
  if (typeof projectId !== 'string' || !PROJECT_ID_PATTERN.test(projectId)) {
    return { error: fail(CODES.PROJECT_ID_INVALID, 'projectId 非法：只允许字母数字与 ._-') };
  }
  if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) {
    return { error: fail(CODES.RUN_ID_INVALID, 'runId 非法：必须是 frun- 开头的受控 id') };
  }
  if (state.activeByProject.has(projectId)) {
    return { error: fail(CODES.BUSY, '这个项目已有候选前端任务在运行，请等它结束或先取消') };
  }
  if (state.activeByRun.has(runId)) {
    return { error: fail(CODES.BUSY, '这个 runId 已有任务在运行') };
  }
  if (state.activeByRun.size >= MAX_ACTIVE_RUNS) {
    return { error: fail(CODES.BUSY, '同时运行的候选前端任务已达上限（2 个）') };
  }
  const session = {
    projectId,
    runId,
    signal: { cancelled: false, aborted: false },
    controller: new AbortController(),
    startedAt: state.now(),
    stage: null,
    lastEmitAt: 0,
    event,
  };
  state.activeByProject.set(projectId, session);
  state.activeByRun.set(runId, session);
  return { session };
}

function releaseSlot(state, session) {
  if (!session) return;
  if (state.activeByProject.get(session.projectId) === session) state.activeByProject.delete(session.projectId);
  if (state.activeByRun.get(session.runId) === session) state.activeByRun.delete(session.runId);
}

function emitProgress(state, session, stage, attempt) {
  if (!session) return;
  const label = STAGE_LABELS[stage] || bounded(stage, 60);
  const now = state.now();
  if (session.stage === stage && now - session.lastEmitAt < 250) return;
  session.stage = stage;
  session.lastEmitAt = now;
  const payload = {
    runId: session.runId,
    projectId: session.projectId,
    stage: STAGE_LABELS[stage] ? stage : 'done',
    label,
    attempt: Number.isInteger(attempt) ? attempt : null,
    at: now,
  };
  try {
    if (session.event && session.event.sender && typeof session.event.sender.send === 'function') {
      session.event.sender.send('frontend:progress', payload);
    }
  } catch (error) {
    /* 窗口已关闭：进度丢一条不影响任务本身 */
  }
}

function cancelSession(state, session) {
  session.signal.cancelled = true;
  session.signal.aborted = true;
  try {
    if (session.controller && typeof session.controller.abort === 'function') session.controller.abort();
  } catch (error) {
    /* 取消失败仍会由 signal 轮询兜住 */
  }
  state.lastCancelAt = state.now();
}

// ---------------------------------------------------------------------------
// 私有 workspace 解析（渲染进程只能给 id，给不了目录）
// ---------------------------------------------------------------------------

function resolveAttempt(state, payload) {
  const projectId = payload && payload.projectId;
  const runId = payload && payload.runId;
  const attempt = payload && payload.attempt;
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 9999) {
    return { error: fail(CODES.ATTEMPT_INVALID, 'attempt 必须是 1–9999 的整数') };
  }
  const paths = state.workspace.workspacePaths({ userDataDir: state.userDataDir, projectId, runId });
  if (!paths.ok) {
    return { error: fail(CODES.WORKSPACE_INVALID, '候选工作区路径不可用：' + bounded(paths.message || paths.code, 120)) };
  }
  const attemptDir = path.join(paths.attemptsDir, `attempt-${attempt}`);
  if (!state.workspace.isInsideOrEqual(paths.attemptsDir, attemptDir)) {
    return { error: fail(CODES.WORKSPACE_INVALID, '候选目录越界') };
  }
  // 先确认存在，再谈路径是否规范：不存在的 attempt 应给「请重新构建」而不是含混的路径错误。
  if (!fs.existsSync(attemptDir)) {
    return { error: fail(CODES.ATTEMPT_MISSING, '候选 attempt 不存在，请重新构建候选') };
  }
  const audit = state.workspace.auditPath(paths.userDataDir, paths.userDataReal, attemptDir);
  if (!audit.ok) {
    return { error: fail(CODES.WORKSPACE_INVALID, '候选目录不规范（可能存在链接/越界）') };
  }
  const canonical = state.workspace.assertCanonicalDir(attemptDir);
  if (!canonical.ok) {
    return { error: fail(CODES.WORKSPACE_INVALID, '候选目录不是规范目录') };
  }
  const metaRead = readJsonBounded(path.join(attemptDir, 'attempt.json'), MAX_ATTEMPT_META_BYTES);
  if (!metaRead.ok) {
    return { error: fail(CODES.WORKSPACE_INVALID, 'attempt.json 不可用：' + metaRead.message) };
  }
  const meta = metaRead.value;
  if (!isPlainObject(meta)
    || meta.schemaVersion !== ATTEMPT_SCHEMA_VERSION
    || meta.projectId !== projectId
    || meta.runId !== runId
    || meta.attempt !== attempt
    || meta.status !== 'committed') {
    return { error: fail(CODES.WORKSPACE_INVALID, 'attempt.json 与请求的工作区身份不一致') };
  }

  // 写操作只认本应用创建的工作区：本会话创建过，或 app 自己写的 run.json 已登记。
  const key = projectId + '\u0000' + runId;
  const owned = state.ownedAttempts.get(key);
  const run = state.workspace.readRun(paths);
  const registered = Boolean(run && Array.isArray(run.attempts)
    && run.schemaVersion === RUN_SCHEMA_VERSION
    && run.projectId === projectId
    && run.runId === runId
    && run.attempts.some((entry) => entry && entry.attempt === attempt && entry.candidateId === meta.candidate.id));
  if (!(owned && owned.has(attempt)) && !registered) {
    return { error: fail(CODES.WORKSPACE_NOT_OWNED, '只能操作本应用创建的候选工作区') };
  }
  return { paths, attemptDir, attempt, meta };
}

function rememberAttempt(state, projectId, runId, attempt) {
  const key = projectId + '\u0000' + runId;
  const set = state.ownedAttempts.get(key) || new Set();
  set.add(attempt);
  state.ownedAttempts.set(key, set);
}

function attemptRelative(state, attemptDir) {
  return path.relative(state.userDataDir, attemptDir).replace(/\\/g, '/');
}

/**
 * 候选产物的文件数/单文件/总体积上限。
 *
 * 写盘的是 renderer，但边界必须由 IPC 自己守：一旦渲染层或上游 renderer
 * 退化（比如把整张 base64 写进 WXML），这里要在采用前拦住，而不是让
 * 「候选工作区」变成任意大小的写盘通道。
 */
function checkCandidateBounds(state, attemptDir, meta) {
  const files = Array.isArray(meta && meta.files) ? meta.files : [];
  if (files.length > MAX_CANDIDATE_FILES) {
    return fail(CODES.CANDIDATE_TOO_LARGE, '候选文件数超过上限（' + MAX_CANDIDATE_FILES + '），已拒绝');
  }
  const candidateRoot = path.join(attemptDir, 'candidate');
  let total = 0;
  for (const relative of files) {
    if (typeof relative !== 'string' || !relative) {
      return fail(CODES.WORKSPACE_INVALID, '候选文件清单含非法条目');
    }
    const inside = relativeInside(candidateRoot, path.resolve(candidateRoot, relative));
    if (!inside) return fail(CODES.WORKSPACE_INVALID, '候选文件清单越界');
    let stat;
    try {
      stat = fs.statSync(path.join(candidateRoot, relative));
    } catch (error) {
      return fail(CODES.WORKSPACE_INVALID, '候选文件缺失：' + bounded(relative, 120));
    }
    if (!stat.isFile()) return fail(CODES.WORKSPACE_INVALID, '候选文件不是普通文件：' + bounded(relative, 120));
    if (stat.size > MAX_CANDIDATE_FILE_BYTES) {
      return fail(CODES.CANDIDATE_TOO_LARGE, '候选单文件超过 ' + Math.round(MAX_CANDIDATE_FILE_BYTES / 1024) + ' KB，已拒绝');
    }
    total += stat.size;
  }
  if (total > MAX_CANDIDATE_TOTAL_BYTES) {
    return fail(CODES.CANDIDATE_TOO_LARGE, '候选总体积超过 ' + Math.round(MAX_CANDIDATE_TOTAL_BYTES / 1024) + ' KB，已拒绝');
  }
  return { ok: true, totalBytes: total, fileCount: files.length };
}

function relativeInside(root, target) {
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.replace(/\\/g, '/');
}

// ---------------------------------------------------------------------------
// 产物摘要与证据
// ---------------------------------------------------------------------------

function describeAttempt(meta) {
  const candidate = isPlainObject(meta.candidate) ? meta.candidate : {};
  return {
    candidateId: bounded(candidate.id, 80),
    candidateVersion: bounded(candidate.version, 24),
    attempt: Number.isInteger(meta.attempt) ? meta.attempt : null,
    status: bounded(meta.status, 24),
    pages: (Array.isArray(candidate.pages) ? candidate.pages : []).slice(0, MAX_TARGET_PAGES).map((page) => bounded(page, 24)),
    files: Array.isArray(meta.files) ? meta.files.length : null,
    digest: bounded(candidate.integrity, 80),
    degradations: (Array.isArray(meta.degradations) ? meta.degradations : []).slice(0, MAX_ISSUES).map((item) => ({
      label: bounded(item && (item.label ?? item.capability), 80),
      reason: bounded(item && item.reason, MAX_MESSAGE_CHARS),
    })),
  };
}

function normalizeChecks(checks) {
  return (Array.isArray(checks) ? checks : []).slice(0, MAX_CHECKS).map((item) => ({
    id: bounded(item && item.id, 60),
    status: ['pass', 'fail', 'not_run', 'not_checked', 'not_applicable'].includes(item && item.status) ? item.status : 'not_run',
    message: bounded(item && item.message, MAX_MESSAGE_CHARS),
  }));
}

function normalizeIssues(issues) {
  return (Array.isArray(issues) ? issues : []).slice(0, MAX_ISSUES).map((item) => ({
    code: bounded(item && item.code, 60) || CODES.BUILD_FAILED,
    path: typeof (item && item.path) === 'string' ? item.path.slice(0, 200) : null,
    field: bounded(item && item.field, 60),
    message: bounded(item && item.message, MAX_MESSAGE_CHARS),
  }));
}

/** 找到 attempt 下最新一次 dry-run 证据目录（dry-run / dry-run-2 / …）。 */
function latestDryRun(attemptDir) {
  const verificationDir = path.join(attemptDir, 'verification');
  let entries;
  try {
    entries = fs.readdirSync(verificationDir, { withFileTypes: true });
  } catch (error) {
    return { ok: false, code: CODES.VERIFICATION_MISSING, message: '还没有 dry-run 证据，请先构建候选' };
  }
  const ranked = entries
    .filter((entry) => entry.isDirectory() && DRY_RUN_DIR_PATTERN.test(entry.name))
    .map((entry) => {
      const match = DRY_RUN_DIR_PATTERN.exec(entry.name);
      return { name: entry.name, rank: match && match[1] ? Number(match[1]) : 1 };
    })
    .sort((a, b) => b.rank - a.rank);
  if (ranked.length === 0) {
    return { ok: false, code: CODES.VERIFICATION_MISSING, message: '还没有 dry-run 证据，请先构建候选' };
  }
  const dir = path.join(verificationDir, ranked[0].name);
  const read = readJsonBounded(path.join(dir, DRY_RUN_RESULT_FILE), MAX_EVIDENCE_BYTES);
  if (!read.ok) {
    return { ok: false, code: CODES.VERIFICATION_MISSING, message: 'dry-run 证据不可用：' + read.message };
  }
  return { ok: true, dir, evidence: read.value };
}

function latestRuntimeEvidence(attemptDir) {
  const dir = path.join(attemptDir, 'verification');
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    return null;
  }
  const ranked = entries
    .filter((entry) => entry.isDirectory() && /^runtime(?:-([1-9][0-9]?))?$/.test(entry.name))
    .map((entry) => ({ name: entry.name, rank: Number((/^runtime-([1-9][0-9]?)$/.exec(entry.name) || [])[1] || 1) }))
    .sort((a, b) => b.rank - a.rank);
  if (ranked.length === 0) return null;
  const dirName = ranked[0].name;
  const read = readJsonBounded(path.join(dir, dirName, RUNTIME_WRAPPER_FILE), MAX_EVIDENCE_BYTES);
  if (!read.ok || !isPlainObject(read.value)) return null;
  return { dirName, evidence: read.value };
}

function staticGateOf(evidence) {
  const checks = normalizeChecks(evidence && evidence.checks);
  const issues = normalizeIssues(evidence && evidence.issues);
  const ok = Boolean(evidence && evidence.ok === true);
  return {
    ok,
    code: bounded(evidence && evidence.code, 60) || (ok ? null : CODES.BUILD_FAILED),
    summary: bounded(evidence && evidence.summary, MAX_MESSAGE_CHARS),
    checks,
    issues,
  };
}

function repairFieldsOf(evidence) {
  const repair = isPlainObject(evidence && evidence.repair) ? evidence.repair : {};
  const repairs = Number.isInteger(repair.repairs) ? Math.min(repair.repairs, 2) : 0;
  const status = ['applied', 'not_needed', 'exhausted', 'not_available', 'failed'].includes(repair.status)
    ? repair.status
    : 'not_available';
  return { repairs, repairStatus: status };
}

// ---------------------------------------------------------------------------
// 服务端分析（HTTP，由主进程代发；渲染进程拿不到任意 URL 能力）
// ---------------------------------------------------------------------------

function normalizeImage(image) {
  if (!isPlainObject(image)) return { ok: false, code: CODES.IMAGE_INVALID, message: '截图为空' };
  const mediaType = image.mediaType;
  if (!IMAGE_MEDIA_TYPES.includes(mediaType)) {
    return { ok: false, code: CODES.IMAGE_TYPE, message: '只支持 JPG / PNG / WebP 截图' };
  }
  const data = image.dataBase64;
  if (typeof data !== 'string' || data.length === 0) {
    return { ok: false, code: CODES.IMAGE_INVALID, message: '截图为空' };
  }
  if (data.length > MAX_IMAGE_BASE64_CHARS) {
    return { ok: false, code: CODES.IMAGE_TOO_LARGE, message: '截图太大了，请压到 400KB 以内' };
  }
  if (!BASE64_PATTERN.test(data)) {
    return { ok: false, code: CODES.IMAGE_INVALID, message: '截图数据无法解析' };
  }
  const bytes = Math.floor((data.length * 3) / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
  if (bytes > MAX_IMAGE_BYTES) {
    return { ok: false, code: CODES.IMAGE_TOO_LARGE, message: '截图太大了，请压到 400KB 以内' };
  }
  return { ok: true, value: { mediaType, dataBase64: data, bytes } };
}

function normalizeTargetPages(value) {
  const pages = Array.isArray(value) ? value : [];
  const out = [];
  for (const page of pages) {
    if (TARGET_PAGES.includes(page) && !out.includes(page)) out.push(page);
  }
  if (out.length === 0) return { ok: false, code: CODES.TARGET_PAGES_INVALID, message: 'targetPages 必须包含 home 或 menu' };
  return { ok: true, value: out.slice(0, MAX_TARGET_PAGES) };
}

/** 图片摘要：对 base64 文本做 SHA-256（与渲染进程同一口径，只用于确认绑定）。 */
function imageDigestOfBase64(dataBase64) {
  const text = typeof dataBase64 === 'string' ? dataBase64 : '';
  if (!text) return '';
  return 'sha256:' + crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function endpointHostOfBaseUrl(baseUrl) {
  try {
    const parsed = new URL(baseUrl);
    return parsed.host || '';
  } catch (error) {
    return '';
  }
}

/**
 * B5：校验本次发送确认。必须存在、在时间窗内，且图片摘要与接收方都匹配；
 * 任何一项不符就拒绝，且不发起任何网络请求。
 */
function validateAnalyzeConsent(consent, image, host, nowMs) {
  if (!isPlainObject(consent)) {
    return { error: fail(CODES.CONSENT_REQUIRED, '这次发送还没有得到你的确认，截图没有发出去。') };
  }
  const confirmedAt = typeof consent.confirmedAt === 'string' ? Date.parse(consent.confirmedAt) : Number.NaN;
  if (!Number.isFinite(confirmedAt)) {
    return { error: fail(CODES.CONSENT_REQUIRED, '这次发送还没有得到你的确认，截图没有发出去。') };
  }
  if (consent.purpose !== CONSENT_PURPOSE) {
    return { error: fail(CODES.CONSENT_SCOPE_MISMATCH, '这次确认不是给截图识别的，请重新确认后再发送。') };
  }
  const expectedDigest = imageDigestOfBase64(image && image.dataBase64);
  const givenDigest = typeof consent.imageDigest === 'string' && IMAGE_DIGEST_PATTERN.test(consent.imageDigest)
    ? consent.imageDigest
    : '';
  if (!expectedDigest || !givenDigest || givenDigest !== expectedDigest) {
    return { error: fail(CODES.CONSENT_SCOPE_MISMATCH, '图片已经换过了，请重新确认后再发送。') };
  }
  if (typeof consent.host !== 'string' || !host || consent.host !== host) {
    return { error: fail(CODES.CONSENT_SCOPE_MISMATCH, '接收接口变了，请重新确认后再发送。') };
  }
  const age = nowMs - confirmedAt;
  if (age > CONSENT_MAX_AGE_MS || age < -CONSENT_CLOCK_SKEW_MS) {
    return { error: fail(CODES.CONSENT_EXPIRED, '确认已经过期，请重新确认后再发送。') };
  }
  return { ok: true, confirmedAt: new Date(confirmedAt).toISOString(), imageDigest: givenDigest, host };
}

/** 把确认写进 run 目录（只有时间/摘要/接收方，不含图片内容与凭证）。 */
function recordAnalyzeConsent(state, projectId, runId, record) {
  try {
    const created = state.workspace.createWorkspace({ userDataDir: state.userDataDir, projectId, runId });
    if (!created || created.ok !== true) {
      return { ok: false, message: bounded(created && (created.message || created.code), 80) || '工作区不可用' };
    }
    const file = path.join(created.runDir, 'consent.json');
    const written = state.workspace.writeJsonAtomic(file, record);
    if (!written || written.ok !== true) {
      return { ok: false, message: bounded(written && (written.message || written.code), 80) || '写入失败' };
    }
    return { ok: true, relative: relativeInside(state.userDataDir, file) };
  } catch (error) {
    return { ok: false, message: boundedDetail(error) };
  }
}

/**
 * 识别超时：优先读独立的 analyzeTimeoutMs，缺省时至少给到 ANALYZE_DEFAULT_TIMEOUT_MS。
 *
 * 不再直接复用 agentTimeoutMs 的原因是它同时服务于对话/模板修改，
 * 用户把它调到 12 秒后会把「需要 30–60 秒」的视觉链路提前掐断。
 */
function resolveAnalyzeTimeoutMs(config) {
  const explicit = Number(config && config.analyzeTimeoutMs);
  if (Number.isInteger(explicit) && explicit > 0) {
    return Math.min(ANALYZE_MAX_TIMEOUT_MS, Math.max(ANALYZE_MIN_TIMEOUT_MS, explicit));
  }
  const chat = Number(config && config.agentTimeoutMs);
  const chatTimeout = Number.isInteger(chat) && chat > 0 ? chat : 0;
  return Math.min(ANALYZE_MAX_TIMEOUT_MS, Math.max(chatTimeout, ANALYZE_DEFAULT_TIMEOUT_MS));
}

/**
 * 识别失败后把结论写进 run.json（不含图片、base64、绝对路径与上游正文）。
 *
 * 只 append `lastAnalyze`，不登记 attempt，因此不会放宽任何写操作鉴权；
 * 目的是让「为什么这次没有候选」在本地可复盘，而不是只能翻后端日志。
 */
function recordAnalyzeFailure(state, payload, result) {
  if (!result || result.ok === true) return;
  if (!ANALYZE_FAILURE_CODES.includes(result.code)) return;
  const projectId = payload && typeof payload.projectId === 'string' && PROJECT_ID_PATTERN.test(payload.projectId)
    ? payload.projectId
    : null;
  const runId = payload && typeof payload.runId === 'string' && RUN_ID_PATTERN.test(payload.runId)
    ? payload.runId
    : null;
  if (!projectId || !runId) return;
  try {
    const created = state.workspace.createWorkspace({ userDataDir: state.userDataDir, projectId, runId });
    if (!created || created.ok !== true) return;
    const run = state.workspace.readRun(created) || {
      schemaVersion: RUN_SCHEMA_VERSION,
      projectId,
      runId,
      createdAt: new Date(Number(state.now())).toISOString(),
      attempts: [],
    };
    if (!Array.isArray(run.attempts)) run.attempts = [];
    run.lastAnalyze = {
      ok: false,
      code: bounded(result.code, 60),
      message: bounded(result.message, MAX_MESSAGE_CHARS),
      at: new Date(Number(state.now())).toISOString(),
    };
    state.workspace.writeJsonAtomic(created.runFile, run);
  } catch (error) {
    /* 复盘记录写失败不影响本次返回 */
  }
}

function buildAnalyzeBody(payload) {
  const utterance = typeof payload.utterance === 'string' ? payload.utterance : '';
  if (utterance.length > MAX_UTTERANCE_CHARS) {
    return { error: fail(CODES.UTTERANCE_TOO_LONG, '要求文字超过 500 字') };
  }
  const image = normalizeImage(payload.image);
  if (!image.ok) return { error: fail(image.code, image.message) };
  const pages = normalizeTargetPages(payload.targetPages);
  if (!pages.ok) return { error: fail(pages.code, pages.message) };
  const current = isPlainObject(payload.current) ? payload.current : {};
  const baseTemplate = isPlainObject(current.baseTemplate) ? current.baseTemplate : {};
  const requestId = typeof payload.requestId === 'string' && payload.requestId.length <= 120 && !CONTROL_CHAR_PATTERN.test(payload.requestId)
    ? payload.requestId
    : `fr-${payload.runId}`;
  return {
    body: {
      contractVersion: CONTRACT_VERSION,
      requestId,
      utterance,
      images: [{ kind: 'reference', mediaType: image.value.mediaType, dataBase64: image.value.dataBase64 }],
      targetPages: pages.value,
      current: {
        baseTemplate: {
          id: 'ordering-base',
          version: typeof baseTemplate.version === 'string' && baseTemplate.version.length <= 24 && /^[0-9A-Za-z._-]+$/.test(baseTemplate.version)
            ? baseTemplate.version
            : '1.0.0',
        },
        frontendPack: null,
        presentationPatch: isPlainObject(current.presentationPatch) ? current.presentationPatch : {},
      },
      client: { surface: 'desktop', phase: 'frontend-reconstruct' },
      projectId: typeof payload.projectId === 'string' && PROJECT_ID_PATTERN.test(payload.projectId) ? payload.projectId : null,
    },
  };
}

function pickAnalyzeResponse(response) {
  const picked = {};
  for (const key of ['contractVersion', 'runId', 'status', 'requirement', 'coverage', 'draft', 'questions', 'trace', 'meta']) {
    if (response[key] !== undefined) picked[key] = response[key];
  }
  return picked;
}

async function defaultResolveConfig(state) {
  if (typeof state.loadSettings !== 'function') return {};
  try {
    const loaded = await state.loadSettings();
    return isPlainObject(loaded && loaded.config) ? loaded.config : {};
  } catch (error) {
    return {};
  }
}

// ---------------------------------------------------------------------------
// 工厂
// ---------------------------------------------------------------------------

function createFrontendReconstructIpc(options) {
  const opts = isPlainObject(options) ? options : {};
  if (typeof opts.userDataDir !== 'string' || !path.isAbsolute(opts.userDataDir)) {
    throw new Error('createFrontendReconstructIpc 需要绝对 userDataDir');
  }
  const reconstruct = opts.reconstruct || defaultReconstruct;
  if (!reconstruct || !reconstruct.materializeCandidate || !reconstruct.dryRunCandidate || !reconstruct.verifyRuntimeCandidate) {
    throw new Error('createFrontendReconstructIpc 需要本地候选执行模块');
  }
  const state = {
    userDataDir: path.resolve(opts.userDataDir),
    workspace: opts.workspace || reconstruct.workspace,
    now: typeof opts.now === 'function' ? opts.now : () => Date.now(),
    activeByProject: new Map(),
    activeByRun: new Map(),
    ownedAttempts: new Map(),
    lastCancelAt: null,
    loadSettings: typeof opts.loadSettings === 'function' ? opts.loadSettings : null,
    fetchImpl: typeof opts.fetchImpl === 'function' ? opts.fetchImpl : (typeof fetch === 'function' ? fetch : null),
    // B2：桌面会话凭证由主进程持有；渲染进程既看不到也传不进来。
    credentials:
      opts.credentials
      || createDesktopCredentialProvider({
        fetchImpl: typeof opts.fetchImpl === 'function' ? opts.fetchImpl : (typeof fetch === 'function' ? fetch : null),
        now: typeof opts.now === 'function' ? opts.now : undefined,
      }),
    resolveConfig: typeof opts.resolveConfig === 'function' ? opts.resolveConfig : defaultResolveConfig,
    repairTransport: typeof opts.repairTransport === 'function' ? opts.repairTransport : null,
    spawnImpl: typeof opts.spawnImpl === 'function' ? opts.spawnImpl : undefined,
    applyAppid: typeof opts.applyAppid === 'function' ? opts.applyAppid : defaultApplyAppid,
    planFile: typeof opts.planFile === 'string' ? opts.planFile : undefined,
    getActive: () => ({ projects: [...state.activeByProject.keys()], runs: [...state.activeByRun.keys()] }),
  };

  async function analyzeInner(event, payload) {
    const unknown = checkUnknownKeys(payload, ALLOWED_KEYS['frontend:analyze']);
    if (unknown.length) return fail(CODES.PAYLOAD_INVALID, '不认识的参数：' + unknown.join(','));
    const runId = payload && payload.runId;
    const projectId = typeof (payload && payload.projectId) === 'string' && PROJECT_ID_PATTERN.test(payload.projectId)
      ? payload.projectId
      : 'unscoped-project';
    if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) {
      return fail(CODES.RUN_ID_INVALID, 'runId 非法');
    }
    const built = buildAnalyzeBody({ ...payload, runId });
    if (built.error) return built.error;

    const slot = acquireSlot(state, event, projectId, runId);
    if (slot.error) return slot.error;
    const session = slot.session;
    emitProgress(state, session, 'analyze');
    try {
      let config = {};
      try {
        config = await state.resolveConfig(state);
      } catch (error) {
        config = {};
      }
      if (config.agentTransport === 'mock') {
        return fail(CODES.ANALYZE_UNAVAILABLE, '当前是本地模拟模式，没有真实图片识别能力；请先在设置里接入后端');
      }
      if (typeof state.fetchImpl !== 'function') {
        return fail(CODES.ANALYZE_UNAVAILABLE, '主进程没有可用的 HTTP 客户端');
      }
      const baseUrl = typeof config.apiBaseUrl === 'string' && /^https?:\/\//.test(config.apiBaseUrl)
        ? config.apiBaseUrl.replace(/\/+$/, '')
        : 'http://127.0.0.1:3000/api/v1';
      const url = baseUrl + '/agent/frontend-reconstruct';
      const timeoutMs = resolveAnalyzeTimeoutMs(config);

      // B5：先校验本次发送确认（图 + 接收方 + 时间窗），不合格就直接返回，不碰网络。
      const nowMs = Number(state.now());
      const consentCheck = validateAnalyzeConsent(
        payload.consent,
        built.body.images[0],
        endpointHostOfBaseUrl(baseUrl),
        nowMs,
      );
      if (consentCheck.error) return consentCheck.error;
      const consentRecord = {
        schemaVersion: CONSENT_SCHEMA_VERSION,
        projectId,
        runId,
        purpose: CONSENT_PURPOSE,
        consentAt: consentCheck.confirmedAt,
        host: consentCheck.host,
        imageDigest: consentCheck.imageDigest,
        imageMediaType: bounded(built.body.images[0] && built.body.images[0].mediaType, 40) || null,
        scope: {
          kind: 'one-image-one-recipient',
          imageDigest: consentCheck.imageDigest,
          host: consentCheck.host,
          contractVersion: CONTRACT_VERSION,
        },
        recordedAt: new Date(nowMs).toISOString(),
      };
      const consentRecorded = recordAnalyzeConsent(state, projectId, runId, consentRecord);
      if (!consentRecorded.ok) {
        return fail(CODES.CONSENT_UNRECORDED, '没能记录这次发送确认，为安全起见没有调用模型（' + consentRecorded.message + '）');
      }
      const consentEcho = {
        consentAt: consentCheck.confirmedAt,
        host: consentCheck.host,
        imageDigestShort: consentCheck.imageDigest.replace(/^sha256:/, '').slice(0, 12),
        recordRelative: consentRecorded.relative || null,
      };

      // B2：先取桌面会话凭证（主进程内存持有、短期、可失效）。
      // 拿不到就明确告诉用户「会话失效/需重新连接」，不做匿名回退。
      let authorization = null;
      if (state.credentials && typeof state.credentials.getAuthorization === 'function') {
        const credential = await state.credentials.getAuthorization(baseUrl);
        if (!credential || credential.ok !== true) {
          return fail(
            CODES.ANALYZE_AUTH_REQUIRED,
            '本地会话不可用（可能已过期或后端未启动），请重新连接后重试；这次没有调用模型。',
            { retryable: true, reason: credential && credential.code ? credential.code : null },
          );
        }
        authorization = credential.authorization;
      }
      if (typeof authorization !== 'string' || !authorization) {
        return fail(CODES.ANALYZE_AUTH_REQUIRED, '缺少本地会话凭证，请重新连接本地服务后重试。', {
          retryable: true,
          reason: null,
        });
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const watcher = setInterval(() => {
        if (session.signal.cancelled) {
          try { controller.abort(); } catch (error) { /* ignore */ }
        }
      }, 100);
      let responseText = '';
      let responseStatus = 0;
      try {
        const response = await state.fetchImpl(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            Accept: 'application/json',
            'X-Agent-Contract': CONTRACT_VERSION,
            Authorization: authorization,
          },
          body: JSON.stringify(built.body),
          signal: controller.signal,
        });
        responseStatus = Number(response && response.status) || 0;
        if (response && typeof response.text === 'function') {
          responseText = await response.text();
        } else if (response && typeof response.json === 'function') {
          responseText = JSON.stringify(await response.json());
        }
      } catch (error) {
        if (session.signal.cancelled) return fail(CODES.CANCELLED, '识别已取消');
        if (error && (error.name === 'AbortError' || error.code === 'ABORT_ERR')) {
          return fail(CODES.ANALYZE_TIMEOUT, '识别超时（已等待 ' + Math.round(timeoutMs / 1000) + ' 秒），视觉识别通常需要 30–60 秒，可以稍后重试');
        }
        return fail(CODES.ANALYZE_FAILED, '没能连上识别服务，检查后端是否已启动后重试');
      } finally {
        clearTimeout(timer);
        clearInterval(watcher);
      }
      if (session.signal.cancelled) return fail(CODES.CANCELLED, '识别已取消');
      if (typeof responseText !== 'string' || responseText.length > MAX_RESPONSE_BYTES) {
        return fail(CODES.ANALYZE_FAILED, '识别服务返回过大或空响应，已拒绝解析');
      }
      let parsed = null;
      if (responseText) {
        try { parsed = JSON.parse(responseText); } catch (error) { parsed = null; }
      }
      if (responseStatus === 401) {
        // B2：会话失效就清缓存、要求重连；不把它当成模型不可用。
        if (state.credentials && typeof state.credentials.invalidate === 'function') state.credentials.invalidate();
        return fail(
          CODES.ANALYZE_AUTH_REQUIRED,
          '本地会话已失效，请重新连接后重试（这次没有调用模型）。',
          { retryable: true, reason: 'AUTH_REJECTED' },
        );
      }
      if (responseStatus === 429) {
        return fail(
          CODES.ANALYZE_RATE_LIMITED,
          '识别请求太频繁了，稍等一会儿再试；这次没有重复调用模型。',
          { retryable: true, status: 429, upstream: isPlainObject(parsed) && typeof parsed.code === 'string' ? parsed.code : null },
        );
      }
      if (responseStatus === 413) {
        return fail(CODES.IMAGE_TOO_LARGE, '截图太大了，请压到 400KB 以内再上传');
      }
      if (responseStatus < 200 || responseStatus >= 300) {
        const upstream = isPlainObject(parsed) && typeof parsed.code === 'string' && /^[A-Z0-9_]{3,60}$/.test(parsed.code)
          ? parsed.code
          : null;
        if (upstream === 'DEEPSEEK_VISION_UNAVAILABLE') {
          return fail(CODES.ANALYZE_UNAVAILABLE, '图片识别服务当前不可用，这次没有识别结果');
        }
        return fail(CODES.ANALYZE_FAILED, '识别服务返回异常（HTTP ' + responseStatus + '），可以稍后重试', { status: responseStatus, upstream });
      }
      if (!isPlainObject(parsed)) {
        return fail(CODES.ANALYZE_FAILED, '识别结果无法解析，没有改动你的项目');
      }
      if (parsed.contractVersion !== CONTRACT_VERSION) {
        return fail(CODES.CONTRACT_MISMATCH, '服务端返回的契约版本不一致，请升级后再试');
      }
      return ok({ runId, response: pickAnalyzeResponse(parsed), consent: consentEcho });
    } finally {
      releaseSlot(state, session);
    }
  }

  /**
   * 识别入口：失败时补一条可复盘的 `run.json.lastAnalyze`，但不改变返回体。
   * 失败结论只写 code/message/时间，不含图片、base64、绝对路径与上游正文。
   */
  async function analyze(event, payload) {
    const result = await analyzeInner(event, payload);
    recordAnalyzeFailure(state, payload, result);
    return result;
  }

  function validateAttemptPayload(payload, allowedChannel) {
    const unknown = checkUnknownKeys(payload, ALLOWED_KEYS[allowedChannel]);
    if (unknown.length) return { error: fail(CODES.PAYLOAD_INVALID, '不认识的参数：' + unknown.join(',')) };
    const projectId = payload && payload.projectId;
    const runId = payload && payload.runId;
    if (typeof projectId !== 'string' || !PROJECT_ID_PATTERN.test(projectId)) {
      return { error: fail(CODES.PROJECT_ID_INVALID, 'projectId 非法') };
    }
    if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) {
      return { error: fail(CODES.RUN_ID_INVALID, 'runId 非法') };
    }
    return { projectId, runId };
  }

  async function buildCandidate(event, payload) {
    const checked = validateAttemptPayload(payload, 'frontend:build-candidate');
    if (checked.error) return checked.error;
    const { projectId, runId } = checked;
    if (!isPlainObject(payload.draft)) return fail(CODES.PAYLOAD_INVALID, 'draft 必须是对象');
    if (payloadBytes(payload.draft) > MAX_DRAFT_BYTES) {
      return fail(CODES.PAYLOAD_TOO_LARGE, '草稿超过 64 KB，已拒绝');
    }
    const hasPlan = Object.prototype.hasOwnProperty.call(payload, 'plan');
    if (hasPlan) {
      if (!isPlainObject(payload.plan)) return fail(CODES.PAYLOAD_INVALID, 'plan 必须是对象');
      if (payloadBytes(payload.plan) > MAX_PLAN_BYTES) {
        return fail(CODES.PAYLOAD_INVALID, 'plan 无法序列化或超过 256 KiB，已拒绝');
      }
    }
    const hasStoreId = Object.prototype.hasOwnProperty.call(payload, 'storeId');
    if (hasStoreId && (typeof payload.storeId !== 'string' || !STORE_ID_PATTERN.test(payload.storeId))) {
      return fail(CODES.PAYLOAD_INVALID, 'storeId 格式不正确');
    }
    const hasBackendVersions = Object.prototype.hasOwnProperty.call(payload, 'backendVersions');
    if (hasBackendVersions) {
      const versions = payload.backendVersions;
      const keys = isPlainObject(versions) ? Object.keys(versions) : [];
      const validKeys = keys.length === 2 && keys.every((key) => ['storeConfigVersion', 'catalogVersion'].includes(key));
      const validValues = validKeys
        && ['storeConfigVersion', 'catalogVersion'].every((key) => versions[key] === null
          || (Number.isInteger(versions[key]) && versions[key] >= 0));
      if (!validValues) {
        return fail(CODES.PAYLOAD_INVALID, 'backendVersions 必须只含非负整数或 null 的 storeConfigVersion/catalogVersion');
      }
    }
    const slot = acquireSlot(state, event, projectId, runId);
    if (slot.error) return slot.error;
    const session = slot.session;
    emitProgress(state, session, 'materialize');
    try {
      let materialized;
      try {
        materialized = reconstruct.materializeCandidate({
          userDataDir: state.userDataDir,
          projectId,
          runId,
          draft: payload.draft,
          onStage: (stage) => emitProgress(state, session, stage),
        });
      } catch (error) {
        return fail(CODES.BUILD_FAILED, '候选物化异常：' + boundedDetail(error));
      }
      if (!materialized || materialized.ok !== true) {
        const precise = (materialized && materialized.details && bounded(materialized.details.draftCode, 60)) || null;
        return fail(
          precise || bounded(materialized && materialized.code, 60) || CODES.BUILD_FAILED,
          '候选物化失败：' + bounded((materialized && (materialized.message || materialized.code)) || 'UNKNOWN', 120),
          materialized && materialized.path ? { path: materialized.path } : null,
        );
      }
      rememberAttempt(state, projectId, runId, materialized.attempt);

      const runDry = async (draft, attemptHint) => {
        try {
          return await reconstruct.dryRunCandidate({
            materialized: attemptHint === materialized.attempt ? materialized : undefined,
            userDataDir: state.userDataDir,
            projectId,
            runId,
            draft,
            revision: attemptHint,
            signal: session.signal,
            ...(hasPlan ? { plan: payload.plan } : {}),
            ...(hasStoreId ? { storeId: payload.storeId } : {}),
            ...(hasBackendVersions ? { backendVersions: payload.backendVersions } : {}),
            ...(!hasPlan && state.planFile ? { planFile: state.planFile } : {}),
            onStage: (stage) => emitProgress(state, session, stage, attemptHint),
          });
        } catch (error) {
          return { ok: false, code: CODES.BUILD_FAILED, summary: 'dry-run 异常：' + boundedDetail(error), issues: [], checks: [] };
        }
      };

      let dry = await runDry(payload.draft, materialized.attempt);
      let repairs = 0;
      let repairStatus = 'not_available';
      let finalAttempt = materialized.attempt;
      if (dry && dry.ok !== true) {
        const issues = Array.isArray(dry.issues) ? dry.issues : [];
        const repairable = issues.length > 0 && issues.every((issue) => typeof issue.path === 'string' && issue.path.startsWith('$'));
        if (repairable && state.repairTransport && typeof reconstruct.runRepairLoop === 'function') {
          const loop = await reconstruct.runRepairLoop({
            draft: payload.draft,
            runId,
            revision: materialized.attempt,
            signal: session.signal,
            maxRounds: 2,
            dryRun: async (nextDraft) => {
              const next = await runDry(nextDraft, null);
              const nextAttempt = next && next.details && next.details.materialize
                ? next.details.materialize.attempt
                : null;
              if (Number.isInteger(nextAttempt)) {
                rememberAttempt(state, projectId, runId, nextAttempt);
                finalAttempt = nextAttempt;
              }
              return next;
            },
            repair: (repairPayload, ctx) => state.repairTransport(repairPayload, ctx),
            onRound: (roundEvent) => {
              if (roundEvent && roundEvent.phase === 'dry-run') {
                emitProgress(state, session, 'compose', finalAttempt);
              }
            },
          });
          repairs = Number.isInteger(loop && loop.repairs) ? loop.repairs : (Array.isArray(loop && loop.attempts) ? loop.attempts.length : 0);
          if (loop && loop.ok === true) {
            repairStatus = 'applied';
            dry = loop.result || dry;
            if (loop.result && loop.result.details && loop.result.details.materialize) {
              finalAttempt = loop.result.details.materialize.attempt || finalAttempt;
            }
          } else {
            repairStatus = loop && loop.code === 'REPAIR_LIMIT_EXCEEDED'
              ? 'exhausted'
              : loop && loop.code === 'REPAIR_CANCELLED'
                ? 'failed'
                : 'failed';
            if (loop && loop.code === 'CANCELLED') {
              return fail(CODES.CANCELLED, '候选构建已取消');
            }
          }
        } else if (issues.length > 0) {
          repairStatus = 'not_available';
        }
      } else if (dry && dry.ok === true) {
        repairStatus = 'not_needed';
      }

      if (session.signal.cancelled) {
        return fail(CODES.CANCELLED, '候选构建已取消');
      }

      const finalDir = (dry && dry.artifacts && typeof dry.artifacts.attemptDir === 'string')
        ? dry.artifacts.attemptDir
        : materialized.attemptDir;
      const finalMetaRead = readJsonBounded(path.join(finalDir, 'attempt.json'), MAX_ATTEMPT_META_BYTES);
      if (!finalMetaRead.ok) {
        return fail(CODES.BUILD_FAILED, '候选 attempt.json 不可用：' + finalMetaRead.message);
      }
      const finalMeta = finalMetaRead.value;
      if (!isPlainObject(finalMeta) || finalMeta.projectId !== projectId || finalMeta.runId !== runId) {
        return fail(CODES.WORKSPACE_INVALID, '候选 attempt 身份不一致');
      }
      rememberAttempt(state, projectId, runId, finalMeta.attempt);
      const bounds = checkCandidateBounds(state, finalDir, finalMeta);
      if (!bounds.ok) return bounds;
      const staticGates = staticGateOf(dry);
      const relativeAttempt = attemptRelative(state, finalDir);
      if (!relativeAttempt || relativeAttempt.startsWith('..')) {
        return fail(CODES.WORKSPACE_INVALID, '候选目录不在应用私有工作区内');
      }
      emitProgress(state, session, 'done', finalMeta.attempt);
      // 注意：即使静态门禁未通过也返回 ok:true —— 候选确实生成了，界面要能展示
      // issues 并允许放弃；是否能采用由 `staticPass` 与采用入口双重把关。
      return ok({
        staticPass: staticGates.ok,
        code: staticGates.ok ? 'FRONTEND_CANDIDATE_READY' : (dry && dry.code) || CODES.BUILD_FAILED,
        message: staticGates.ok
          ? '候选已生成并通过静态门禁'
          : '静态门禁未通过：' + bounded((dry && dry.summary) || '未知原因', 120),
        candidate: describeAttempt(finalMeta),
        verification: {
          static: staticGates,
          repairs,
          repairStatus,
        },
        artifacts: {
          attemptRelative: relativeAttempt,
          outputRelative: bounded(dry && dry.artifacts && dry.artifacts.outputRelativePath, 200) || null,
        },
      });
    } finally {
      releaseSlot(state, session);
    }
  }

  async function validateCandidate(event, payload) {
    const checked = validateAttemptPayload(payload, 'frontend:validate-candidate');
    if (checked.error) return checked.error;
    const resolved = resolveAttempt(state, payload);
    if (resolved.error) return resolved.error;
    const verified = reconstruct.verifyOverlay ? reconstruct.verifyOverlay({ overlayRoot: path.join(resolved.attemptDir, 'overlay') }) : null;
    if (verified && verified.ok !== true) {
      return fail(CODES.WORKSPACE_INVALID, '候选 overlay 注册表校验失败：' + bounded(verified.message || verified.code, 120));
    }
    const dry = latestDryRun(resolved.attemptDir);
    if (!dry.ok) return fail(dry.code, dry.message);
    const evidence = dry.evidence;
    if (!isPlainObject(evidence) || evidence.candidateId !== resolved.meta.candidate.id) {
      return fail(CODES.VERIFICATION_MISSING, 'dry-run 证据与候选身份不一致');
    }
    const bounds = checkCandidateBounds(state, resolved.attemptDir, resolved.meta);
    if (!bounds.ok) return bounds;
    const staticGates = staticGateOf(evidence);
    const repair = repairFieldsOf(evidence);
    return ok({
      code: staticGates.ok ? 'FRONTEND_CANDIDATE_READY' : staticGates.code || CODES.BUILD_FAILED,
      message: staticGates.ok ? '候选静态门禁复核通过' : '候选静态门禁未通过',
      candidate: describeAttempt(resolved.meta),
      verification: { static: staticGates, repairs: repair.repairs, repairStatus: repair.repairStatus },
      artifacts: { attemptRelative: attemptRelative(state, resolved.attemptDir) },
    });
  }

  async function verifyCandidate(event, payload) {
    const checked = validateAttemptPayload(payload, 'frontend:verify-candidate');
    if (checked.error) return checked.error;
    if (payload.timeoutMs !== undefined && (!Number.isInteger(payload.timeoutMs) || payload.timeoutMs < 1000 || payload.timeoutMs > 1800000)) {
      return fail(CODES.PAYLOAD_INVALID, 'timeoutMs 必须是 1000–1800000 的整数');
    }
    const hasAppId = Object.prototype.hasOwnProperty.call(payload, 'appId');
    const appId = hasAppId && typeof payload.appId === 'string' ? payload.appId.trim().toLowerCase() : '';
    if (hasAppId && !APPID_PATTERN.test(appId)) {
      return fail(CODES.PAYLOAD_INVALID, 'appId 必须是 wx 加 16 位小写十六进制');
    }
    const resolved = resolveAttempt(state, payload);
    if (resolved.error) return resolved.error;
    const dry = latestDryRun(resolved.attemptDir);
    if (!dry.ok) return fail(dry.code, dry.message);
    const outputRelative = dry.evidence && typeof dry.evidence.outputRelativePath === 'string'
      ? dry.evidence.outputRelativePath
      : null;
    if (!outputRelative) return fail(CODES.VERIFICATION_MISSING, 'dry-run 证据里没有产物目录');
    const projectDir = path.resolve(resolved.attemptDir, outputRelative);
    const inside = relativeInside(resolved.attemptDir, projectDir);
    if (!inside || !fs.existsSync(path.join(projectDir, 'app.json'))) {
      return fail(CODES.VERIFICATION_MISSING, '候选产物目录不可用或不是小程序工程');
    }

    const slot = acquireSlot(state, event, checked.projectId, checked.runId);
    if (slot.error) return slot.error;
    const session = slot.session;
    emitProgress(state, session, 'verify', resolved.attempt);
    try {
      if (session.signal.cancelled) return fail(CODES.CANCELLED, '微信验证已取消');
      if (hasAppId) {
        try {
          state.applyAppid({ outputPath: projectDir, appid: appId });
        } catch (error) {
          return fail(CODES.APPID_WRITE_FAILED, '候选 AppID 写入或自检失败：' + boundedDetail(error));
        }
        if (session.signal.cancelled) return fail(CODES.CANCELLED, '微信验证已取消');
      }
      let result;
      try {
        result = await reconstruct.verifyRuntimeCandidate({
          projectDir,
          privateRoot: resolved.attemptDir,
          evidenceDir: path.join(resolved.attemptDir, 'verification', 'runtime'),
          // B1：证据必须能证明「这是哪个候选的验证结果」。
          candidate: {
            id: resolved.meta.candidate.id,
            version: resolved.meta.candidate.version,
            integrity: resolved.meta.candidate.integrity,
          },
          ...(payload.timeoutMs ? { timeoutMs: payload.timeoutMs } : {}),
          signal: session.signal,
          ...(state.spawnImpl ? { spawnImpl: state.spawnImpl } : {}),
        });
      } catch (error) {
        return fail(CODES.VERIFY_FAILED, '微信验证包装异常：' + boundedDetail(error));
      }
      if (!result || typeof result !== 'object') {
        return fail(CODES.VERIFY_FAILED, '微信验证没有返回结构化结论');
      }
      const status = RUNTIME_STATUSES.includes(result.status) ? result.status : 'BLOCKED';
      if (status === 'NOT_RUN' && session.signal.cancelled) {
        return fail(CODES.CANCELLED, '微信验证已取消');
      }
      const artifacts = isPlainObject(result.artifacts) ? result.artifacts : {};
      const screenshots = (Array.isArray(artifacts.screenshots) ? artifacts.screenshots : [])
        .slice(0, MAX_SCREENSHOTS)
        .map((shot) => ({
          name: bounded(shot && shot.name, 120),
          bytes: Number.isFinite(shot && shot.bytes) ? shot.bytes : 0,
        }))
        .filter((shot) => shot.name);
      emitProgress(state, session, 'done', resolved.attempt);
      return ok({
        status,
        code: bounded(result.code, 60) || null,
        message: status === RUNTIME_PASS
          ? '微信真实编译与关键页面/关键交互验证通过'
          : '微信验证没有拿到 PASS',
        summary: bounded(result.summary, MAX_MESSAGE_CHARS),
        screenshots,
        pages: (Array.isArray(result.pages) ? result.pages : []).slice(0, 24).map((page) => ({
          route: bounded(page && page.route, 80),
          label: bounded(page && page.label, 40),
          status: bounded(page && page.status, 12),
        })),
        interactions: (Array.isArray(result.interactions) ? result.interactions : []).slice(0, 32).map((item) => ({
          label: bounded(item && item.label, 60),
          status: bounded(item && item.status, 12),
          critical: !(item && item.critical === false),
          detail: bounded(item && item.detail, MAX_MESSAGE_CHARS),
        })),
      });
    } finally {
      releaseSlot(state, session);
    }
  }

  async function adoptCandidate(event, payload) {
    const checked = validateAttemptPayload(payload, 'frontend:adopt-candidate');
    if (checked.error) return checked.error;
    const resolved = resolveAttempt(state, payload);
    if (resolved.error) return resolved.error;
    if (state.activeByProject.has(checked.projectId)) {
      return fail(CODES.BUSY, '这个项目有任务在运行，等它结束再采用');
    }
    const dry = latestDryRun(resolved.attemptDir);
    if (!dry.ok) return fail(dry.code, dry.message);
    const staticGates = staticGateOf(dry.evidence);
    if (!staticGates.ok) {
      return fail(CODES.STATIC_GATES_FAILED, '静态门禁未通过，不能采用这个候选', { code: staticGates.code });
    }
    const runtime = latestRuntimeEvidence(resolved.attemptDir);
    const recordedRuntime = runtime && isPlainObject(runtime.evidence) ? runtime.evidence : null;
    const runtimeStatus = recordedRuntime && RUNTIME_STATUSES.includes(recordedRuntime.status)
      ? recordedRuntime.status
      : 'NOT_RUN';
    // B1：证据必须属于当前候选（否则就是重建后用旧证据冒充）。
    if (recordedRuntime) {
      const evidenceCandidate = isPlainObject(recordedRuntime.candidate) ? recordedRuntime.candidate : null;
      const expected = resolved.meta.candidate;
      if (!evidenceCandidate
        || evidenceCandidate.id !== expected.id
        || evidenceCandidate.version !== expected.version
        || evidenceCandidate.integrity !== expected.integrity) {
        return fail(
          CODES.RUNTIME_EVIDENCE_STALE,
          '微信运行时证据不属于当前候选（候选可能已重建）；请重新验证后再采用',
          { runtimeStatus: 'NOT_RUN' },
        );
      }
    }
    const partialConfirmed = payload.partialConfirmed === true;
    // B1：FAIL 一律拒绝，partial 确认不覆盖真实失败。
    if (runtimeStatus === 'FAIL') {
      return fail(
        CODES.RUNTIME_FAILED,
        '微信验证结果是 FAIL（真实编译或关键交互未通过）；该候选不能采用，确认 partial 也不能覆盖',
        { runtimeStatus },
      );
    }
    if (runtimeStatus !== RUNTIME_PASS && !partialConfirmed) {
      return fail(
        CODES.PARTIAL_CONFIRM_REQUIRED,
        '微信验证未完成；采用前需要单独确认 partial',
        { runtimeStatus },
      );
    }
    const adoption = {
      schemaVersion: ADOPTION_SCHEMA_VERSION,
      status: 'adopted',
      projectId: checked.projectId,
      runId: checked.runId,
      attempt: resolved.attempt,
      candidateId: resolved.meta.candidate.id,
      candidateVersion: resolved.meta.candidate.version,
      integrity: resolved.meta.candidate.integrity,
      staticGates: 'pass',
      runtimeStatus,
      // PASS 时不存在「部分采用」；非 PASS 必须在记录里留下显式确认。
      partialConfirmed: runtimeStatus === RUNTIME_PASS ? false : partialConfirmed,
      evidence: recordedRuntime
        ? {
          dirName: runtime.dirName,
          generatedAt: bounded(recordedRuntime.generatedAt, 40) || null,
        }
        : null,
      adoptedAt: new Date(state.now()).toISOString(),
    };
    try {
      const written = state.workspace.writeJsonAtomic(path.join(resolved.attemptDir, 'adopted.json'), adoption);
      if (!written.ok) return fail(CODES.ADOPT_FAILED, '采用记录写入失败：' + bounded(written.message || written.code, 120));
    } catch (error) {
      return fail(CODES.ADOPT_FAILED, '采用记录写入异常：' + boundedDetail(error));
    }
    return ok({
      adoption: {
        candidateId: adoption.candidateId,
        candidateVersion: adoption.candidateVersion,
        attempt: adoption.attempt,
        runtimeStatus,
        partialConfirmed: adoption.partialConfirmed,
        adoptedAt: adoption.adoptedAt,
        recordRelative: relativeInside(state.userDataDir, path.join(resolved.attemptDir, 'adopted.json')),
      },
      // B1：非 PASS 的采用只是「部分采用」，不得在任何呈现层被叫作验收通过。
      message: runtimeStatus === RUNTIME_PASS
        ? '候选已采用（微信运行时验证 PASS）'
        : '已记录为部分采用（微信验证 ' + runtimeStatus + '），不构成验收通过',
    });
  }

  async function discardCandidate(event, payload) {
    const checked = validateAttemptPayload(payload, 'frontend:discard-candidate');
    if (checked.error) return checked.error;
    const resolved = resolveAttempt(state, payload);
    if (resolved.error) return resolved.error;
    if (state.activeByProject.has(checked.projectId)) {
      return fail(CODES.BUSY, '这个项目有任务在运行，等它结束再放弃候选');
    }
    const record = {
      schemaVersion: DISCARD_SCHEMA_VERSION,
      projectId: checked.projectId,
      runId: checked.runId,
      attempt: resolved.attempt,
      candidateId: resolved.meta.candidate.id,
      discardedAt: new Date(state.now()).toISOString(),
    };
    try {
      const written = state.workspace.writeJsonAtomic(path.join(resolved.attemptDir, 'discarded.json'), record);
      if (!written.ok) return fail(CODES.DISCARD_FAILED, '放弃记录写入失败：' + bounded(written.message || written.code, 120));
    } catch (error) {
      return fail(CODES.DISCARD_FAILED, '放弃记录写入异常：' + boundedDetail(error));
    }
    return ok({
      discarded: true,
      candidateId: record.candidateId,
      attempt: record.attempt,
      discardedAt: record.discardedAt,
    });
  }

  async function cancelRun(event, payload) {
    const unknown = checkUnknownKeys(payload, ALLOWED_KEYS['frontend:cancel-run']);
    if (unknown.length) return fail(CODES.PAYLOAD_INVALID, '不认识的参数：' + unknown.join(','));
    const projectId = payload && typeof payload.projectId === 'string' ? payload.projectId : '';
    const runId = payload && typeof payload.runId === 'string' ? payload.runId : '';
    let session = null;
    if (runId) session = state.activeByRun.get(runId) || null;
    if (!session && projectId) session = state.activeByProject.get(projectId) || null;
    if (!session) return fail(CODES.NO_ACTIVE_RUN, '没有可取消的任务（可能已经结束）');
    cancelSession(state, session);
    return ok({ cancelled: true, runId: session.runId, projectId: session.projectId, stage: session.stage });
  }

  const handlers = {
    'frontend:analyze': analyze,
    'frontend:build-candidate': buildCandidate,
    'frontend:validate-candidate': validateCandidate,
    'frontend:verify-candidate': verifyCandidate,
    'frontend:adopt-candidate': adoptCandidate,
    'frontend:discard-candidate': discardCandidate,
    'frontend:cancel-run': cancelRun,
  };

  /** 视图层只通过这里拿状态（测试用；主进程本身不需要暴露）。 */
  return { handlers, state, getActive: state.getActive };
}

function registerFrontendReconstructIpc(ipcMain, options) {
  const created = createFrontendReconstructIpc(options);
  Object.entries(created.handlers).forEach(([channel, handler]) => {
    ipcMain.handle(channel, async (event, payload) => {
      if (!isTrustedSender(event)) {
        return { ok: false, code: CODES.UNTRUSTED_SENDER, message: '请求来源不受信任', details: null };
      }
      if (payload !== undefined && payloadBytes(payload) > MAX_PAYLOAD_BYTES) {
        return { ok: false, code: CODES.PAYLOAD_TOO_LARGE, message: '请求内容超过 1 MB', details: null };
      }
      return handler(event, payload);
    });
  });
  return created;
}

module.exports = {
  createFrontendReconstructIpc,
  registerFrontendReconstructIpc,
  resolveAnalyzeTimeoutMs,
  ANALYZE_MIN_TIMEOUT_MS,
  ANALYZE_MAX_TIMEOUT_MS,
  CODES,
  RUN_ID_PATTERN,
  PROJECT_ID_PATTERN,
  MAX_PAYLOAD_BYTES,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_BASE64_CHARS,
  MAX_UTTERANCE_CHARS,
  MAX_DRAFT_BYTES,
  MAX_TARGET_PAGES,
  MAX_ACTIVE_RUNS,
  TARGET_PAGES,
  ALLOWED_KEYS,
  STAGE_LABELS,
};
