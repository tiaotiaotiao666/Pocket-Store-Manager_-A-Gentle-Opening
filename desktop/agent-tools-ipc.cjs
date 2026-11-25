'use strict';

/**
 * B3：Workspace Agent 受控任务 RPC（Electron 主进程，纯 CJS）。
 *
 * 冻结契约：`docs/handoff/Workspace-Agent-B阶段接口冻结.md` §3（rev5）。
 *
 * 边界：
 * - 只注册 `agent:*` 19 个命令 + `agent:progress` 进度通道；渲染进程拿不到 fs/child_process/任意 channel。
 * - 参数只接受 projectId/runId/turnId/attempt/versionId/revision/相对路径/有界参数；未知键直接拒绝。
 * - 路径一律由主进程按 projectId + 版本/attempt 派生；渲染进程永远不传目录。
 * - 版本命令只调用 B2 `versions.cjs`；工作区读写只调用 B1 模块；不复制任何版本/路径安全逻辑。
 * - run-check / verify-wechat 走注入的 checks 接口；B4 落地前确定性返回 AGENT_RUNTIME_TOOL_MISSING，
 *   未知 checkId 返回 AGENT_CHECK_UNKNOWN，绝不伪造 PASS。
 * - 结果统一 `{ok,data,issues,meta}` / `{ok:false,code,message,data:null,issues,meta}`；
 *   失败码只用 §1.7 + §2.2 + §3.3 允许集合；message ≤240 且脱敏；结果不含绝对路径/源码全文/base64。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const paths = require('./agent-workspace/paths.cjs');
const constants = require('./agent-workspace/constants.cjs');
const workspaceMod = require('./agent-workspace/workspace.cjs');
const transactionsMod = require('./agent-workspace/transactions.cjs');
const manifestMod = require('./agent-workspace/manifest.cjs');
const versionsMod = require('./agent-workspace/versions.cjs');
const checksModule = require('./agent-workspace/checks.cjs');
const sourceBundle = require('./agent-workspace/source-bundle.cjs');

const PROGRESS_CHANNEL = 'agent:progress';
const COMMAND_PREFIX = 'agent:';

/** §1.7 + §2.2 + §3.3 允许的错误码；不得私增。 */
const CODES = Object.freeze({
  ...constants.CODES,
  UNTRUSTED_SENDER: 'AGENT_UNTRUSTED_SENDER',
  PAYLOAD_INVALID: 'AGENT_PAYLOAD_INVALID',
  PAYLOAD_TOO_LARGE: 'AGENT_PAYLOAD_TOO_LARGE',
  BUSY: 'AGENT_BUSY',
  CANCELLED: 'AGENT_CANCELLED',
  TIMEOUT: 'AGENT_TIMEOUT',
  CHECK_UNKNOWN: 'AGENT_CHECK_UNKNOWN',
  CHECK_FAILED: 'AGENT_CHECK_FAILED',
  RUNTIME_TOOL_MISSING: 'AGENT_RUNTIME_TOOL_MISSING',
  VERIFICATION_MISSING: 'AGENT_VERIFICATION_MISSING',
  ATTEMPT_NOT_FOUND: 'AGENT_ATTEMPT_NOT_FOUND',
  PROJECT_MISMATCH: 'AGENT_PROJECT_MISMATCH',
  RESULT_TOO_LARGE: 'AGENT_RESULT_TOO_LARGE',
  ARTIFACT_NOT_FOUND: 'AGENT_ARTIFACT_NOT_FOUND',
  TARGET_PAGE_UNSUPPORTED: 'AGENT_TARGET_PAGE_UNSUPPORTED',
  PARTIAL_CONFIRM_REQUIRED: 'AGENT_PARTIAL_CONFIRM_REQUIRED',
});

/** 冻结 §3.2：run-check 只能选注册 checkId（不接受命令/脚本）；rev15 §14.4 追加 `capabilities.check`。 */
const CHECK_IDS = Object.freeze([
  'source.check', 'composer.dry-run', 'mini.check', 'output.consistency', 'capabilities.check',
  'unit.targeted', 'unit.full', 'desktop.contract', 'catalog.check',
  'registry.check', 'wechat.verify',
]);

const LIMITS = Object.freeze({
  maxPayloadBytes: 2.5 * 1024 * 1024,
  maxDefaultPayloadBytes: 64 * 1024,
  maxResultBytes: 4 * 1024 * 1024,
  readBytes: 256 * 1024,
  searchResults: 50,
  diffFiles: 64,
  diffBytes: 512 * 1024,
  artifactBytes: 2 * 1024 * 1024,
  progressMessage: 120,
  progressEvents: 200,
  readConcurrency: 4,
  activeRuns: 100,
});

const CHECK_STATUSES = Object.freeze(['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN']);
const RUNTIME_STATUSES = CHECK_STATUSES;
/** 工具/环境不可用类错误：必须映射为 BLOCKED，不能显示成“检查失败”。 */
const TOOL_UNAVAILABLE_CODES = new Set([
  'EPERM', 'EACCES', 'ENOENT', 'ETIMEDOUT',
  'CHECK_TOOL_MISSING', 'AGENT_RUNTIME_TOOL_MISSING', 'AGENT_TIMEOUT',
]);

const DRIVE_PATTERN = /^[A-Za-z]:[\\/]/;
const UNC_PATTERN = /^\\\\/;
const BASE64_DATA_URI = /data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,/i;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function byteLength(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch (error) {
    return Number.MAX_SAFE_INTEGER;
  }
}

function boundedMessage(text, userDataDir) {
  let message = typeof text === 'string' && text ? text : '请求失败';
  if (typeof userDataDir === 'string' && userDataDir) {
    const variants = [userDataDir, userDataDir.replace(/\\/g, '/'), userDataDir.replace(/\//g, '\\')];
    for (const variant of variants) {
      if (variant) message = message.split(variant).join('.');
    }
  }
  for (const variant of [paths.REPO_ROOT, paths.REPO_ROOT.replace(/\\/g, '/')]) {
    if (variant) message = message.split(variant).join('.');
  }
  return message.length > 240 ? message.slice(0, 237) + '...' : message;
}

function fail(code, message, extra) {
  return { ok: false, code, path: '.', message: boundedMessage(message), ...(extra || {}) };
}

function ok(extra) {
  return Object.assign({ ok: true }, extra);
}

function clampInt(value, min, max, fallback) {
  if (!Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** 脱敏 + 结果体积上限：结果不含私有根/仓库绝对路径，超限返回 AGENT_RESULT_TOO_LARGE。 */
function scrubResult(value, context) {
  const needles = [];
  if (context && typeof context.userDataDir === 'string' && context.userDataDir) {
    needles.push(context.userDataDir, context.userDataDir.replace(/\\/g, '/'), context.userDataDir.replace(/\//g, '\\'));
  }
  needles.push(paths.REPO_ROOT, paths.REPO_ROOT.replace(/\\/g, '/'));

  const walk = (node) => {
    if (typeof node === 'string') {
      let text = node;
      for (const needle of needles) {
        if (needle) text = text.split(needle).join('.');
      }
      if (DRIVE_PATTERN.test(text) || UNC_PATTERN.test(text)) return '.';
      if (BASE64_DATA_URI.test(text)) return '[redacted-base64]';
      return text;
    }
    // 二进制证据用 Uint8Array 经 IPC 结构化克隆返回，不得被普通对象遍历破坏、也不得转 base64。
    if (node instanceof Uint8Array) return new Uint8Array(node);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const out = {};
      for (const [key, item] of Object.entries(node)) out[key] = walk(item);
      return out;
    }
    return node;
  };

  const scrubbed = walk(value);
  // 体积测量：二进制按真实字节数计，其余按 JSON 长度计；避免把 Uint8Array 展开成数字对象。
  let binaryBytes = 0;
  const serialized = JSON.stringify(scrubbed, (key, item) => {
    if (item instanceof Uint8Array) {
      binaryBytes += item.byteLength;
      return { __bytes: item.byteLength };
    }
    return item;
  });
  const size = Buffer.byteLength(serialized === undefined ? 'null' : serialized, 'utf8') + binaryBytes;
  if (size > LIMITS.maxResultBytes) {
    return fail(CODES.RESULT_TOO_LARGE, '结果体积超过上限');
  }
  return ok({ value: scrubbed, bytes: size });
}

/* ------------------------------------------------------------------ */
/* 参数校验                                                            */
/* ------------------------------------------------------------------ */

const PROJECT_ID_RE = paths.PROJECT_ID_PATTERN;
const RUN_ID_RE = constants.RUN_ID_PATTERN;
const TURN_ID_RE = constants.TURN_ID_PATTERN;
const ATTEMPT_ID_RE = constants.ATTEMPT_ID_PATTERN;
const VERSION_ID_RE = constants.VERSION_ID_PATTERN;

function assertProjectId(payload) {
  if (!PROJECT_ID_RE.test(payload.projectId || '')) return fail(CODES.PROJECT_INVALID, 'projectId 非法');
  return ok();
}

function assertRelativePath(value, label) {
  const safe = paths.assertSafeRelativePath(value, constants.CODES, { maxLength: 240 });
  if (!safe.ok) return fail(CODES.PATH_INVALID, (label || 'path') + ' 必须是规范相对路径');
  return ok({ relative: value });
}

function parseAttemptId(value) {
  if (Number.isInteger(value) && value >= 1 && value <= 9999) return { ok: true, attempt: value };
  if (typeof value === 'string') {
    const matched = ATTEMPT_ID_RE.exec(value);
    if (matched) return { ok: true, attempt: Number(matched[1]) };
  }
  return fail(CODES.PAYLOAD_INVALID, 'attemptId 非法');
}

function rejectUnknownKeys(payload, allowed, label) {
  const extra = Object.keys(payload).filter((key) => !allowed.includes(key));
  if (extra.length > 0) {
    return fail(CODES.PAYLOAD_INVALID, (label || '参数') + ' 含未知键：' + extra.slice(0, 5).join(','));
  }
  return ok();
}

function validateCommonPayload(payload, spec) {
  if (!isPlainObject(payload)) return fail(CODES.PAYLOAD_INVALID, '参数必须是对象');
  const unknown = rejectUnknownKeys(payload, spec.keys);
  if (!unknown.ok) return unknown;
  const projectCheck = assertProjectId(payload);
  if (!projectCheck.ok) return projectCheck;
  if (payload.runId !== undefined && !RUN_ID_RE.test(payload.runId)) return fail(CODES.ID_INVALID, 'runId 非法');
  if (payload.turnId !== undefined && !TURN_ID_RE.test(payload.turnId)) return fail(CODES.ID_INVALID, 'turnId 非法');
  if (payload.attemptId !== undefined) {
    const parsed = parseAttemptId(payload.attemptId);
    if (!parsed.ok) return parsed;
  }
  if (payload.attempt !== undefined) {
    const parsed = parseAttemptId(payload.attempt);
    if (!parsed.ok) return parsed;
  }
  if (payload.versionId !== undefined && !VERSION_ID_RE.test(payload.versionId)) {
    return fail(CODES.VERSION_NOT_FOUND, 'versionId 非法');
  }
  if (payload.revision !== undefined && (!Number.isInteger(payload.revision) || payload.revision < 0)) {
    return fail(CODES.PAYLOAD_INVALID, 'revision 必须是非负整数');
  }
  const maxBytes = spec.maxPayloadBytes || LIMITS.maxDefaultPayloadBytes;
  if (byteLength(payload) > maxBytes) return fail(CODES.PAYLOAD_TOO_LARGE, '参数超过体积上限');
  return ok();
}

function validateChanges(changes, options) {
  const opts = options || {};
  if (!Array.isArray(changes) || changes.length === 0) return fail(CODES.PAYLOAD_INVALID, 'changes 必须是非空数组');
  if (changes.length > 32) return fail(CODES.BATCH_TOO_LARGE, '单批文件数超过上限');
  const allowed = opts.deleteOnly ? ['path', 'expectedBaseSha256'] : ['path', 'content', 'expectedBaseSha256', 'format'];
  for (const change of changes) {
    if (!isPlainObject(change)) return fail(CODES.PAYLOAD_INVALID, 'change 必须是对象');
    const unknown = rejectUnknownKeys(change, allowed, 'change');
    if (!unknown.ok) return unknown;
    const relative = assertRelativePath(change.path);
    if (!relative.ok) return relative;
    if (!opts.deleteOnly && typeof change.content !== 'string') {
      return fail(CODES.PAYLOAD_INVALID, 'write 必须提供完整 content 字符串');
    }
  }
  return ok();
}

function validateParamsObject(params) {
  if (params === undefined) return ok();
  if (!isPlainObject(params)) return fail(CODES.PAYLOAD_INVALID, 'params 必须是对象');
  const keys = Object.keys(params);
  if (keys.length > 32) return fail(CODES.PAYLOAD_INVALID, 'params 字段过多');
  for (const key of keys) {
    const lowered = key.toLowerCase();
    if (['command', 'cmd', 'shell', 'env', 'cwd', 'exec', 'spawn'].includes(lowered)) {
      return fail(CODES.PAYLOAD_INVALID, 'params 不允许命令/脚本类字段');
    }
    const value = params[key];
    if (value !== null && typeof value === 'object') return fail(CODES.PAYLOAD_INVALID, 'params 只接受标量');
    if (typeof value === 'string') {
      if (value.length > 240) return fail(CODES.PAYLOAD_INVALID, 'params 字符串过长');
      if (DRIVE_PATTERN.test(value) || UNC_PATTERN.test(value)) return fail(CODES.PAYLOAD_INVALID, 'params 不允许绝对路径');
    }
  }
  return ok();
}

/* ------------------------------------------------------------------ */
/* 主进程派生：版本 source / attempt / 证据目录                          */
/* ------------------------------------------------------------------ */

function readProjectState(context) {
  return versionsMod.readProjectState({ userDataDir: context.userDataDir, projectId: context.projectId });
}

function resolveVersion(context, versionId) {
  return versionsMod.resolveVersionSource({
    userDataDir: context.userDataDir,
    projectId: context.projectId,
    ...(versionId ? { versionId } : {}),
  });
}

function projectWorkspaceHandle(context, state) {
  const wsPaths = workspaceMod.workspacePaths({
    userDataDir: context.userDataDir,
    projectId: context.projectId,
  });
  if (!wsPaths.ok) return wsPaths;
  return ok({
    handle: {
      schemaVersion: constants.SCHEMAS.workspace,
      projectId: context.projectId,
      userDataDir: wsPaths.root,
      userDataReal: wsPaths.rootReal,
      projectDir: wsPaths.projectDir,
      workspaceDir: wsPaths.workspaceDir,
      projectFile: wsPaths.projectFile,
      versionsDir: wsPaths.versionsDir,
      runsDir: wsPaths.runsDir,
      project: state || null,
      limits: constants.LIMITS,
    },
  });
}

function openAttemptHandle(context, runId, turnId, attemptNumber) {
  const stateResult = readProjectState(context);
  const handleResult = projectWorkspaceHandle(context, stateResult.ok ? stateResult.state : null);
  if (!handleResult.ok) return handleResult;
  const opened = workspaceMod.openAttempt(handleResult.handle, { runId, turnId, attempt: attemptNumber });
  if (!opened.ok) return opened;
  return ok({ attempt: opened.attempt });
}

function latestAttemptNumber(context, runId, turnId) {
  const stateResult = readProjectState(context);
  const handleResult = projectWorkspaceHandle(context, stateResult.ok ? stateResult.state : null);
  if (!handleResult.ok) return handleResult;
  const listed = workspaceMod.listAttempts(handleResult.handle, { runId, turnId });
  if (!listed.ok) return listed;
  if (!Array.isArray(listed.attempts) || listed.attempts.length === 0) {
    return fail(CODES.ATTEMPT_NOT_FOUND, '该 turn 还没有 attempt');
  }
  return ok({ attempt: listed.attempts[listed.attempts.length - 1] });
}

/** 版本 source 内的相对路径 -> 已 audit 的绝对路径（主进程派生，不接受调用方目录）。 */
function resolveInRoot(root, relative) {
  const safe = assertRelativePath(relative);
  if (!safe.ok) return safe;
  const canonical = paths.assertCanonicalDir(root, constants.CODES);
  if (!canonical.ok) return fail(CODES.WORKSPACE_INVALID, '版本 source 目录不可用');
  const target = path.resolve(root, relative);
  if (!paths.isInside(root, target)) return fail(CODES.PATH_ESCAPE, '路径越出工作树');
  const audited = paths.auditPath(root, canonical.realDir, target, constants.CODES);
  if (!audited.ok) return fail(audited.code, '路径审计失败');
  return ok({ target });
}

function listVersionFiles(context, versionId) {
  const resolved = resolveVersion(context, versionId);
  if (!resolved.ok) return resolved;
  const built = manifestMod.buildManifest(resolved.sourceRoot, { limits: constants.LIMITS });
  if (!built.ok) return fail(built.code, '版本 source 清单不可用');
  return ok({ resolved, manifest: built.manifest });
}

function isBinaryBuffer(buffer, relative) {
  if (buffer.includes(0)) return true;
  const extension = path.extname(relative).slice(1).toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'pdf', 'zip', 'woff', 'woff2', 'ttf', 'otf', 'mp3', 'mp4', 'wasm', 'bin'].includes(extension)) {
    return true;
  }
  const text = buffer.toString('utf8');
  return !Buffer.from(text, 'utf8').equals(buffer);
}

function readTextFile(target, relative, limits) {
  let buffer;
  try {
    buffer = fs.readFileSync(target);
  } catch (error) {
    return fail(CODES.FILE_NOT_FOUND, '文件不可读');
  }
  if (buffer.length > limits) return fail(CODES.FILE_TOO_LARGE, '文件超过读取上限');
  if (isBinaryBuffer(buffer, relative)) return fail(CODES.BINARY_FILE, '二进制文件不支持按文本读取');
  return ok({ text: buffer.toString('utf8'), bytes: buffer.length });
}

function listEvidenceFiles(dir) {
  const out = [];
  const sameReal = (target) => {
    try {
      const real = fs.realpathSync.native ? fs.realpathSync.native(target) : fs.realpathSync(target);
      return paths.samePath(real, target);
    } catch (error) {
      return false;
    }
  };
  const walk = (current, prefix) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const relative = prefix ? prefix + '/' + entry.name : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        // 证据目录不得经过 junction/别名；不一致直接跳过（不跟随到库外）。
        if (!sameReal(full)) continue;
        walk(full, relative);
        continue;
      }
      if (!entry.isFile()) continue;
      let stats;
      try {
        stats = fs.lstatSync(full);
      } catch (error) {
        continue;
      }
      out.push({ relative, bytes: stats.size });
      if (out.length >= 200) return;
    }
  };
  walk(dir, '');
  return out;
}

/* ------------------------------------------------------------------ */
/* 取消 / 进度 / 并发                                                   */
/* ------------------------------------------------------------------ */

function createIdLocks() {
  const busy = new Set();
  return {
    acquire(key) {
      if (busy.has(key)) return false;
      busy.add(key);
      return true;
    },
    release(key) {
      busy.delete(key);
    },
  };
}

function createReadLimiter(limit) {
  let active = 0;
  const max = Number.isInteger(limit) && limit > 0 ? limit : LIMITS.readConcurrency;
  return {
    acquire() {
      if (active >= max) return false;
      active += 1;
      return true;
    },
    release() {
      if (active > 0) active -= 1;
    },
  };
}

/* ------------------------------------------------------------------ */
/* 命令实现                                                            */
/* ------------------------------------------------------------------ */

function createAgentToolsIpc(options) {
  const opts = options || {};
  const userDataDir = typeof opts.userDataDir === 'string' ? opts.userDataDir : '';
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const timers = opts.timers || { setTimeout, clearTimeout };
  // B4：默认使用真实验证注册表（main 仍传 checks:null 也会解析到真实实现）；
  // `checks:false` 显式禁用（确定性 AGENT_RUNTIME_TOOL_MISSING），对象保持 B3 注入形状。
  const hasExplicitChecks = Object.prototype.hasOwnProperty.call(opts, 'checks');
  const explicitChecks = hasExplicitChecks ? opts.checks : undefined;
  let checks = explicitChecks && typeof explicitChecks === 'object' ? explicitChecks : null;
  let checksReady = explicitChecks === false || Boolean(checks);
  function resolveChecks() {
    if (!checksReady) {
      checks = checksModule.createCheckRegistry({ userDataDir });
      checksReady = true;
    }
    return checks;
  }
  const attachments = opts.attachments || null;
  const emitProgress = typeof opts.emitProgress === 'function' ? opts.emitProgress : null;
  // E0-W2：提交/采用必须经 Coordinator（唯一执行所有者）。main.cjs 注入单例；未注入就 fail-closed。
  const coordinator = opts.coordinator && typeof opts.coordinator === 'object' ? opts.coordinator : null;
  const locks = opts.locks || createIdLocks();
  const reads = opts.reads || createReadLimiter(opts.readConcurrency);

  const activeRuns = new Map();
  const finishedRuns = new Map();

  function contextOf(payload) {
    return {
      userDataDir,
      projectId: payload && payload.projectId ? payload.projectId : '',
    };
  }

  function metaOf(payload, startedAt, extra) {
    const meta = {
      projectId: payload && payload.projectId ? payload.projectId : null,
      durationMs: Math.max(0, now() - startedAt),
      truncated: Boolean(extra && extra.truncated),
    };
    if (payload && payload.versionId) meta.versionId = payload.versionId;
    if (payload && payload.runId) meta.runId = payload.runId;
    if (payload && payload.turnId) meta.turnId = payload.turnId;
    if (payload && payload.attemptId !== undefined) meta.attemptId = payload.attemptId;
    if (extra && extra.versionId) meta.versionId = extra.versionId;
    if (extra && extra.versionState) meta.versionState = extra.versionState;
    return meta;
  }

  function success(payload, startedAt, data, extra) {
    const scrubbed = scrubResult(data, { userDataDir });
    if (!scrubbed.ok) {
      return failureEnvelope(scrubbed.code, scrubbed.message, payload, startedAt, extra);
    }
    return {
      ok: true,
      data: scrubbed.value === undefined ? null : scrubbed.value,
      issues: [],
      meta: metaOf(payload, startedAt, extra),
    };
  }

  function failureEnvelope(code, message, payload, startedAt, extra) {
    return {
      ok: false,
      code,
      message: boundedMessage(message, userDataDir),
      data: null,
      issues: (extra && Array.isArray(extra.issues)) ? extra.issues : [],
      meta: metaOf(payload, startedAt, extra),
    };
  }

  function currentVersionState(context) {
    const reopened = versionsMod.reopenProject({ userDataDir: context.userDataDir, projectId: context.projectId });
    if (reopened.ok) {
      return {
        status: 'ok',
        available: true,
        currentVersionId: reopened.currentVersionId,
        previousVersionId: reopened.previousVersionId,
        redoVersionId: reopened.redoVersionId,
        treeDigest: reopened.treeDigest,
      };
    }
    if (reopened.code === CODES.WORKSPACE_NOT_FOUND) {
      return { status: 'none', available: false, code: reopened.code };
    }
    const state = reopened.state || {};
    return {
      status: 'unavailable',
      available: false,
      code: reopened.code,
      currentVersionId: state.currentVersionId || null,
      reason: state.reason || null,
    };
  }

  function beginRun(context, runId) {
    const key = context.projectId + ':' + runId;
    const token = {
      projectId: context.projectId,
      runId,
      cancelled: false,
      state: 'running',
      requestedAt: null,
      startedAt: now(),
    };
    activeRuns.set(key, token);
    return token;
  }

  function finishRun(context, runId, status, requestedAt) {
    const key = context.projectId + ':' + runId;
    activeRuns.delete(key);
    finishedRuns.set(key, {
      status,
      at: now(),
      cancelled: status === 'cancelled',
      requestedAt: requestedAt || null,
    });
    if (finishedRuns.size > LIMITS.activeRuns) {
      const oldest = finishedRuns.keys().next().value;
      finishedRuns.delete(oldest);
    }
  }

  async function withRun(payload, spec, task) {
    const runId = payload.runId;
    if (!runId) return task();
    const token = beginRun(contextOf(payload), runId);
    try {
      const outcome = await Promise.race([
        Promise.resolve().then(task),
        new Promise((resolvePromise) => {
          const timer = timers.setTimeout(() => resolvePromise({ timeout: true }), spec.timeoutMs || 600000);
          if (timer && typeof timer.unref === 'function') timer.unref();
        }),
      ]);
      // 取消请求优先于任务结果：任务即使刚结束，也按“请求后确认停止”返回 AGENT_CANCELLED。
      if (token.cancelled) {
        token.state = 'cancelled';
        finishRun(contextOf(payload), runId, 'cancelled', token.requestedAt);
        return fail(CODES.CANCELLED, '任务已取消');
      }
      if (outcome && outcome.timeout) {
        finishRun(contextOf(payload), runId, 'timeout');
        return fail(CODES.TIMEOUT, '任务超时');
      }
      finishRun(contextOf(payload), runId, 'done');
      return outcome;
    } catch (error) {
      finishRun(contextOf(payload), runId, 'failed');
      // 环境/工具类同步异常（例如沙箱 spawn EPERM）必须如实 BLOCKED，不能当“检查失败”。
      if (error && TOOL_UNAVAILABLE_CODES.has(String(error.code || ''))) {
        return fail('CHECK_TOOL_MISSING', '检查工具在当前环境不可用');
      }
      return fail(CODES.CHECK_FAILED, '任务执行失败');
    }
  }

  function validateCheckId(checkId) {
    // 合同别名 `capabilities.source-facts` 与 canonical `capabilities.check` 等价。
    const aliases = checksModule && checksModule.CHECK_ALIASES ? checksModule.CHECK_ALIASES : {};
    if (typeof checkId !== 'string' || (!CHECK_IDS.includes(checkId) && !Object.prototype.hasOwnProperty.call(aliases, checkId))) {
      return fail(CODES.CHECK_UNKNOWN, '未知 checkId');
    }
    return ok();
  }

  function issuesFrom(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 50).map((issue) => {
      if (!isPlainObject(issue)) return null;
      return {
        code: typeof issue.code === 'string' ? issue.code.slice(0, 64) : 'CHECK_ISSUE',
        severity: ['low', 'medium', 'high'].includes(issue.severity) ? issue.severity : 'medium',
        ...(typeof issue.file === 'string' ? { file: issue.file.slice(0, 240) } : {}),
        ...(Number.isInteger(issue.line) ? { line: issue.line } : {}),
        ...(Number.isInteger(issue.column) ? { column: issue.column } : {}),
        message: typeof issue.message === 'string' ? issue.message.slice(0, 240) : '检查问题',
        source: typeof issue.source === 'string' ? issue.source.slice(0, 40) : 'check',
      };
    }).filter(Boolean);
  }

  const commandSpecs = {
    'agent:get-context': {
      keys: ['projectId', 'runId', 'turnId'],
      async run(payload, startedAt) {
        const context = contextOf(payload);
        const versionState = currentVersionState(context);
        const stateResult = readProjectState(context);
        const state = stateResult.ok ? stateResult.state : null;
        return success(payload, startedAt, {
          projectId: context.projectId,
          versionState,
          currentVersionId: state ? state.currentVersionId : null,
          redoVersionId: state ? state.redoVersionId : null,
          versionCount: state && Array.isArray(state.versions) ? state.versions.length : 0,
          checks: [...CHECK_IDS],
          // X5：8 页枚举 + enabled/reasons 与 source.check 同一来源（SourceFacts），不再是 v1 的 home/menu。
          targetPages: sourceBundle.enumerateTargetPages({}),
          targetPageEnumSource: 'scripts/agent-source-facts.cjs#PAGE_IDS/PAGE_CONTRACTS',
          storeDraft: null,
          verification: { static: 'unknown', runtime: 'NOT_RUN' },
        }, { versionState });
      },
    },

    'agent:list-files': {
      keys: ['projectId', 'versionId', 'pathPrefix', 'maxDepth'],
      async run(payload, startedAt) {
        if (payload.pathPrefix !== undefined && payload.pathPrefix !== '') {
          const safe = assertRelativePath(payload.pathPrefix, 'pathPrefix');
          if (!safe.ok) return safe;
        }
        const maxDepth = clampInt(payload.maxDepth, 1, constants.LIMITS.maxDepth, constants.LIMITS.maxDepth);
        const listed = listVersionFiles(contextOf(payload), payload.versionId);
        if (!listed.ok) return listed;
        const prefix = payload.pathPrefix || '';
        const files = [];
        for (const file of listed.manifest.files) {
          if (prefix && !file.path.startsWith(prefix.endsWith('/') ? prefix : prefix + '/')) continue;
          if (file.path.split('/').length > maxDepth) continue;
          files.push({ path: file.path, bytes: file.bytes, sha256: file.sha256 });
          if (files.length >= constants.LIMITS.maxFiles) break;
        }
        return success(payload, startedAt, { files, truncated: files.length >= constants.LIMITS.maxFiles }, {
          versionId: listed.resolved.versionId,
          truncated: files.length >= constants.LIMITS.maxFiles,
        });
      },
    },

    'agent:read-file': {
      keys: ['projectId', 'versionId', 'path', 'offset', 'limitBytes'],
      async run(payload, startedAt) {
        const safe = assertRelativePath(payload.path);
        if (!safe.ok) return safe;
        const resolved = resolveVersion(contextOf(payload), payload.versionId);
        if (!resolved.ok) return resolved;
        const located = resolveInRoot(resolved.sourceRoot, payload.path);
        if (!located.ok) return located;
        let stats;
        try {
          stats = fs.lstatSync(located.target);
        } catch (error) {
          return fail(CODES.FILE_NOT_FOUND, '文件不存在');
        }
        if (!stats.isFile()) return fail(CODES.PAYLOAD_INVALID, 'path 不是文件');
        const limitBytes = clampInt(payload.limitBytes, 1, LIMITS.readBytes, 64 * 1024);
        const offset = clampInt(payload.offset, 0, Number.MAX_SAFE_INTEGER, 0);
        const buffer = fs.readFileSync(located.target);
        if (isBinaryBuffer(buffer, payload.path)) return fail(CODES.BINARY_FILE, '二进制文件不支持按文本读取');
        const start = Math.min(offset, buffer.length);
        const end = Math.min(buffer.length, start + limitBytes);
        const slice = buffer.subarray(start, end);
        return success(payload, startedAt, {
          path: payload.path,
          content: slice.toString('utf8'),
          bytes: slice.length,
          totalBytes: buffer.length,
          sha256: 'sha256:' + crypto.createHash('sha256').update(buffer).digest('hex'),
          offset: start,
          nextOffset: end,
          truncated: end < buffer.length,
        }, { versionId: resolved.versionId, truncated: end < buffer.length });
      },
    },

    'agent:search-files': {
      keys: ['projectId', 'versionId', 'query', 'mode', 'maxResults'],
      async run(payload, startedAt) {
        if (typeof payload.query !== 'string' || !payload.query) return fail(CODES.PAYLOAD_INVALID, 'query 必须是非空字符串');
        const mode = payload.mode === undefined ? 'content' : payload.mode;
        if (!['name', 'content', 'both'].includes(mode)) return fail(CODES.PAYLOAD_INVALID, 'mode 非法');
        const maxResults = clampInt(payload.maxResults, 1, LIMITS.searchResults, LIMITS.searchResults);
        const listed = listVersionFiles(contextOf(payload), payload.versionId);
        if (!listed.ok) return listed;
        const needle = payload.query.toLowerCase();
        const matches = [];
        let truncated = false;
        for (const file of listed.manifest.files) {
          if (mode === 'name' || mode === 'both') {
            if (file.path.toLowerCase().includes(needle)) {
              matches.push({ path: file.path });
              if (matches.length >= maxResults) { truncated = true; break; }
            }
          }
          if (mode === 'name') continue;
          if (file.bytes > LIMITS.readBytes) continue;
          const located = resolveInRoot(listed.resolved.sourceRoot, file.path);
          if (!located.ok) continue;
          const read = readTextFile(located.target, file.path, LIMITS.readBytes);
          if (!read.ok) continue;
          const lines = read.text.split('\n');
          for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index];
            if (!line.toLowerCase().includes(needle)) continue;
            matches.push({ path: file.path, line: index + 1, preview: line.trim().slice(0, 160) });
            if (matches.length >= maxResults) { truncated = true; break; }
          }
          if (truncated) break;
        }
        return success(payload, startedAt, { matches, truncated }, { versionId: listed.resolved.versionId, truncated });
      },
    },

    'agent:write-files': {
      keys: ['projectId', 'runId', 'turnId', 'baseVersionId', 'changes'],
      maxPayloadBytes: LIMITS.maxPayloadBytes,
      timeoutMs: 120000,
      write: true,
      async run(payload, startedAt) {
        if (!RUN_ID_RE.test(payload.runId || '')) return fail(CODES.ID_INVALID, 'runId 非法');
        if (!TURN_ID_RE.test(payload.turnId || '')) return fail(CODES.ID_INVALID, 'turnId 非法');
        const changes = validateChanges(payload.changes);
        if (!changes.ok) return changes;
        const context = contextOf(payload);
        if (payload.baseVersionId !== undefined) {
          const state = readProjectState(context);
          if (!state.ok) return state;
          if (state.state.currentVersionId !== payload.baseVersionId) {
            return fail(CODES.VERSION_CONFLICT, 'baseVersionId 不是当前版本');
          }
        }
        const latest = latestAttemptNumber(context, payload.runId, payload.turnId);
        if (!latest.ok) return latest;
        // OBS-4（t22 追加）：产品链只走 Coordinator —— 提交后必须 AGENT_ATTEMPT_IMMUTABLE，
        // 不得用 B1 事务绕过 submitted 只读不变量（无 Coordinator 的旧测试路径保留为 legacy）。
        if (coordinator && typeof coordinator.invokeTool === 'function') {
          const routed = await coordinator.invokeTool({
            projectId: payload.projectId,
            runId: payload.runId,
            turnId: payload.turnId,
            attemptId: 'attempt-' + latest.attempt,
            tool: 'write_files',
            args: {
              changes: payload.changes.map((change) => ({
                path: change.path,
                content: change.content,
                ...(change.expectedBaseSha256 === undefined ? {} : { expectedBaseSha256: change.expectedBaseSha256 }),
              })),
            },
          });
          if (!routed || routed.ok !== true) {
            return fail((routed && routed.code) || 'AGENT_TXN_ABORTED', (routed && routed.message) || '写入失败');
          }
          const routedData = routed.data || {};
          return success(payload, startedAt, {
            transactionId: routedData.transactionId,
            files: (Array.isArray(routedData.files) ? routedData.files : [])
              .map((file) => ({ path: file.path, status: file.status, sha256: file.sha256 })),
            revision: routedData.revision,
            treeDigest: routedData.treeDigest,
            attemptId: 'attempt-' + latest.attempt,
          });
        }
        const opened = openAttemptHandle(context, payload.runId, payload.turnId, latest.attempt);
        if (!opened.ok) return opened;
        const applied = transactionsMod.applyChanges(opened.attempt, payload.changes.map((change) => ({
          op: 'write',
          path: change.path,
          content: change.content,
          ...(change.expectedBaseSha256 === undefined ? {} : { expectedBaseSha256: change.expectedBaseSha256 }),
          ...(change.format === undefined ? {} : { format: change.format }),
        })));
        if (!applied.ok) return fail(applied.code, applied.message);
        const files = (applied.diff && Array.isArray(applied.diff.files) ? applied.diff.files : [])
          .map((file) => ({ path: file.path, status: file.status, sha256: file.sha256 }));
        return success(payload, startedAt, {
          transactionId: applied.transactionId,
          files,
          revision: applied.revision,
          treeDigest: applied.treeDigest,
          attemptId: 'attempt-' + latest.attempt,
        });
      },
    },

    'agent:delete-files': {
      keys: ['projectId', 'runId', 'turnId', 'baseVersionId', 'paths'],
      maxPayloadBytes: LIMITS.maxPayloadBytes,
      write: true,
      async run(payload, startedAt) {
        if (!RUN_ID_RE.test(payload.runId || '')) return fail(CODES.ID_INVALID, 'runId 非法');
        if (!TURN_ID_RE.test(payload.turnId || '')) return fail(CODES.ID_INVALID, 'turnId 非法');
        const changes = validateChanges(payload.paths, { deleteOnly: true });
        if (!changes.ok) return changes;
        const context = contextOf(payload);
        if (payload.baseVersionId !== undefined) {
          const state = readProjectState(context);
          if (!state.ok) return state;
          if (state.state.currentVersionId !== payload.baseVersionId) return fail(CODES.VERSION_CONFLICT, 'baseVersionId 不是当前版本');
        }
        const latest = latestAttemptNumber(context, payload.runId, payload.turnId);
        if (!latest.ok) return latest;
        // OBS-4：删除同样必须经 Coordinator（submitted 后 AGENT_ATTEMPT_IMMUTABLE，零落盘）。
        if (coordinator && typeof coordinator.invokeTool === 'function') {
          const routed = await coordinator.invokeTool({
            projectId: payload.projectId,
            runId: payload.runId,
            turnId: payload.turnId,
            attemptId: 'attempt-' + latest.attempt,
            tool: 'delete_files',
            args: {
              paths: payload.paths.map((entry) => ({
                path: entry.path,
                ...(entry.expectedBaseSha256 === undefined ? {} : { expectedBaseSha256: entry.expectedBaseSha256 }),
              })),
            },
          });
          if (!routed || routed.ok !== true) {
            return fail((routed && routed.code) || 'AGENT_TXN_ABORTED', (routed && routed.message) || '删除失败');
          }
          const routedData = routed.data || {};
          return success(payload, startedAt, {
            transactionId: routedData.transactionId,
            files: (Array.isArray(routedData.files) ? routedData.files : [])
              .map((file) => ({ path: file.path, status: file.status })),
            revision: routedData.revision,
            treeDigest: routedData.treeDigest,
            attemptId: 'attempt-' + latest.attempt,
          });
        }
        const opened = openAttemptHandle(context, payload.runId, payload.turnId, latest.attempt);
        if (!opened.ok) return opened;
        const applied = transactionsMod.applyChanges(opened.attempt, payload.paths.map((entry) => ({
          op: 'delete',
          path: entry.path,
          ...(entry.expectedBaseSha256 === undefined ? {} : { expectedBaseSha256: entry.expectedBaseSha256 }),
        })));
        if (!applied.ok) return fail(applied.code, applied.message);
        const files = (applied.diff && Array.isArray(applied.diff.files) ? applied.diff.files : [])
          .map((file) => ({ path: file.path, status: file.status }));
        return success(payload, startedAt, {
          transactionId: applied.transactionId,
          files,
          revision: applied.revision,
          treeDigest: applied.treeDigest,
          attemptId: 'attempt-' + latest.attempt,
        });
      },
    },

    'agent:add-image-asset': {
      keys: ['projectId', 'runId', 'turnId', 'attachmentRef'],
      write: true,
      async run(payload, startedAt) {
        if (!RUN_ID_RE.test(payload.runId || '')) return fail(CODES.ID_INVALID, 'runId 非法');
        if (!TURN_ID_RE.test(payload.turnId || '')) return fail(CODES.ID_INVALID, 'turnId 非法');
        if (typeof payload.attachmentRef !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(payload.attachmentRef)) {
          return fail(CODES.PAYLOAD_INVALID, 'attachmentRef 必须是受控资产引用');
        }
        if (!attachments || typeof attachments.add !== 'function') {
          return fail(CODES.RUNTIME_TOOL_MISSING, '资产附件能力尚未接入');
        }
        const added = await attachments.add({
          projectId: payload.projectId,
          runId: payload.runId,
          turnId: payload.turnId,
          attachmentRef: payload.attachmentRef,
        });
        if (!added || added.ok !== true) return fail((added && added.code) || CODES.RUNTIME_TOOL_MISSING, '资产附件失败');
        return success(payload, startedAt, {
          assetId: added.assetId,
          relative: added.relative,
          ...(added.caption ? { caption: String(added.caption).slice(0, 120) } : {}),
        });
      },
    },

    'agent:get-diff': {
      keys: ['projectId', 'comparedTo', 'basePath'],
      async run(payload, startedAt) {
        if (!isPlainObject(payload.comparedTo)) return fail(CODES.PAYLOAD_INVALID, 'comparedTo 必须是对象');
        const unknown = rejectUnknownKeys(payload.comparedTo, ['versionId', 'attemptId'], 'comparedTo');
        if (!unknown.ok) return unknown;
        const hasVersion = payload.comparedTo.versionId !== undefined;
        const hasAttempt = payload.comparedTo.attemptId !== undefined;
        if (hasVersion === hasAttempt) return fail(CODES.PAYLOAD_INVALID, 'comparedTo 必须且只能给 versionId 或 attemptId');
        const current = resolveVersion(contextOf(payload));
        if (!current.ok) return current;
        let compared;
        if (hasVersion) {
          compared = resolveVersion(contextOf(payload), payload.comparedTo.versionId);
          if (!compared.ok) return compared;
        } else {
          const parsed = resolveComparedAttemptId(payload.comparedTo.attemptId);
          if (!parsed.ok) return parsed;
          const opened = openAttemptHandle(contextOf(payload), parsed.runId, parsed.turnId, parsed.attempt);
          if (!opened.ok) return opened;
          compared = { ok: true, versionId: parsed.attemptId, sourceRoot: opened.attempt.candidateDir };
        }
        const currentManifest = manifestMod.buildManifest(current.sourceRoot, { limits: constants.LIMITS });
        if (!currentManifest.ok) return fail(currentManifest.code, '当前版本清单不可用');
        const comparedManifest = manifestMod.buildManifest(compared.sourceRoot, { limits: constants.LIMITS });
        if (!comparedManifest.ok) return fail(comparedManifest.code, '对比版本清单不可用');
        const diff = manifestMod.diffManifests(comparedManifest.manifest, currentManifest.manifest, {
          maxFiles: LIMITS.diffFiles,
          maxBytes: LIMITS.diffBytes,
        });
        if (!diff.ok) return fail(diff.code, 'diff 不可用');
        const files = diff.files.map((file) => {
          const stats = lineStats(compared.sourceRoot, current.sourceRoot, file);
          return {
            path: file.path,
            status: file.status,
            additions: stats.additions,
            deletions: stats.deletions,
            sha256: file.sha256,
          };
        });
        return success(payload, startedAt, { files, truncated: diff.truncated }, {
          versionId: current.versionId,
          truncated: diff.truncated,
        });
      },
    },

    'agent:run-check': {
      keys: ['projectId', 'runId', 'attemptId', 'checkId', 'params'],
      timeoutMs: 600000,
      async run(payload, startedAt) {
        if (!RUN_ID_RE.test(payload.runId || '')) return fail(CODES.ID_INVALID, 'runId 非法');
        const check = validateCheckId(payload.checkId);
        if (!check.ok) return check;
        const params = validateParamsObject(payload.params);
        if (!params.ok) return params;
        const checks = resolveChecks();
        if (!checks || typeof checks.runCheck !== 'function') {
          return fail(CODES.RUNTIME_TOOL_MISSING, '检查注册表不可用');
        }
        // rev15 §14.4：本命令没有 attempt 候选树 / 派生导出树主体，只允许跑仓库级检查。
        // attempt/export 级检查必须由 WorkspaceRunCoordinator 传平台派生的 root，绝不在这里回落版本源码。
        const definition = checks.definitions ? checks.definitions[payload.checkId] : null;
        const subject = definition && typeof definition.subject === 'string' ? definition.subject : null;
        if (subject === 'attempt' || subject === 'export') {
          return fail(CODES.CHECK_UNKNOWN, payload.checkId + ' 需要'
            + (subject === 'attempt' ? ' attempt 候选树' : '派生导出树')
            + '主体，只能由 WorkspaceRunCoordinator 触发');
        }
        const startedAtCheck = now();
        const outcome = await withRun(payload, commandSpecs['agent:run-check'], () => checks.runCheck({
          projectId: payload.projectId,
          runId: payload.runId,
          attemptId: payload.attemptId,
          checkId: payload.checkId,
          params: payload.params || {},
        }));
        if (!outcome || outcome.ok === false) {
          const rawCode = outcome && outcome.code ? String(outcome.code) : '';
          if (TOOL_UNAVAILABLE_CODES.has(rawCode)) {
            return success(payload, startedAt, {
              checkId: payload.checkId,
              status: 'BLOCKED',
              durationMs: 0,
              issues: [{
                file: null, line: null, column: null, code: 'CHECK_TOOL_MISSING', message: '检查工具在当前环境不可用', source: 'check',
              }],
            });
          }
          return outcome || fail(CODES.CHECK_FAILED, '检查失败');
        }
        if (!outcome.ok) return outcome;
        // 状态口径：未知/不可判定 → NOT_RUN（绝不归一成 FAIL，也不伪造成 PASS）。
        const status = CHECK_STATUSES.includes(outcome.status) ? outcome.status : 'NOT_RUN';
        return success(payload, startedAt, {
          checkId: payload.checkId,
          status,
          durationMs: Math.max(0, now() - startedAtCheck),
          issues: issuesFrom(outcome.issues),
          ...(typeof outcome.evidenceRelative === 'string' ? { evidenceRelative: outcome.evidenceRelative.slice(0, 240) } : {}),
        });
      },
    },

    'agent:verify-wechat': {
      keys: ['projectId', 'runId', 'attemptId', 'appId', 'timeoutMs'],
      timeoutMs: 600000,
      async run(payload, startedAt) {
        if (!RUN_ID_RE.test(payload.runId || '')) return fail(CODES.ID_INVALID, 'runId 非法');
        const attempt = parseAttemptId(payload.attemptId);
        if (!attempt.ok) return attempt;
        const timeoutMs = clampInt(payload.timeoutMs, 1000, 600000, 120000);
        const checks = resolveChecks();
        if (!checks || typeof checks.verifyWechat !== 'function') {
          return fail(CODES.RUNTIME_TOOL_MISSING, '微信验证工具不可用');
        }
        const outcome = await withRun(payload, { timeoutMs }, () => checks.verifyWechat({
          projectId: payload.projectId,
          runId: payload.runId,
          attemptId: payload.attemptId,
          appId: payload.appId,
          timeoutMs,
        }));
        if (!outcome || outcome.ok === false) {
          const rawCode = outcome && outcome.code ? String(outcome.code) : '';
          if (TOOL_UNAVAILABLE_CODES.has(rawCode)) {
            return success(payload, startedAt, {
              status: 'BLOCKED',
              pages: [],
              interactions: [],
              screenshots: [],
              issues: [{
                file: null, line: null, column: null, code: 'CHECK_TOOL_MISSING', message: '微信验证工具在当前环境不可用', source: 'wechat',
              }],
            });
          }
          return outcome || fail(CODES.RUNTIME_TOOL_MISSING, '微信验证工具不可用');
        }
        if (!outcome.ok) return outcome;
        const status = RUNTIME_STATUSES.includes(outcome.status) ? outcome.status : 'BLOCKED';
        return success(payload, startedAt, {
          status,
          pages: Array.isArray(outcome.pages) ? outcome.pages.slice(0, 50).map((item) => String(item).slice(0, 120)) : [],
          interactions: Array.isArray(outcome.interactions) ? outcome.interactions.slice(0, 50) : [],
          screenshots: Array.isArray(outcome.screenshots) ? outcome.screenshots.slice(0, 24).map((item) => ({
            label: String((item && item.label) || 'shot').slice(0, 80),
            relative: String((item && item.relative) || '').slice(0, 240),
          })) : [],
          ...(typeof outcome.evidenceRelative === 'string' ? { evidenceRelative: outcome.evidenceRelative.slice(0, 240) } : {}),
        });
      },
    },

    'agent:read-verification': {
      keys: ['projectId', 'runId', 'turnId', 'attemptId', 'versionId', 'source'],
      async run(payload, startedAt) {
        const source = payload.source === undefined ? 'attempt' : payload.source;
        if (!['attempt', 'version'].includes(source)) return fail(CODES.PAYLOAD_INVALID, 'source 只能是 attempt/version');
        let dir = null;
        let identity = {};
        if (source === 'version') {
          const resolved = resolveVersion(contextOf(payload), payload.versionId);
          if (!resolved.ok) return resolved;
          dir = path.join(path.dirname(resolved.sourceRoot), constants.LAYOUT.evidenceDir);
          identity = { versionId: resolved.versionId };
        } else {
          if (!RUN_ID_RE.test(payload.runId || '')) return fail(CODES.ID_INVALID, 'runId 非法');
          if (!TURN_ID_RE.test(payload.turnId || '')) return fail(CODES.ID_INVALID, 'turnId 非法');
          const attempt = parseAttemptId(payload.attemptId);
          if (!attempt.ok) return attempt;
          const opened = openAttemptHandle(contextOf(payload), payload.runId, payload.turnId, attempt.attempt);
          if (!opened.ok) return opened;
          dir = opened.attempt.verificationDir;
          identity = { attemptId: 'attempt-' + attempt.attempt };
        }
        if (!fs.existsSync(dir)) return fail(CODES.VERIFICATION_MISSING, '还没有验证证据');
        const evidenceStats = fs.lstatSync(dir);
        if (evidenceStats.isSymbolicLink() || !evidenceStats.isDirectory()) {
          return fail(CODES.VERIFICATION_MISSING, '验证证据目录不规范');
        }
        const files = listEvidenceFiles(dir);
        const screenshots = files.filter((file) => /\.(png|jpg|jpeg|webp)$/i.test(file.relative))
          .slice(0, 24)
          .map((file) => ({ label: file.relative.split('/').pop(), relative: file.relative, bytes: file.bytes }));
        const issues = files.filter((file) => /issues?\.json$/i.test(file.relative)).slice(0, 4)
          .map((file) => ({ code: 'VERIFICATION_ARTIFACT', severity: 'low', message: file.relative, source: 'verification' }));
        return success(payload, startedAt, {
          source,
          ...identity,
          issues,
          screenshots,
          evidenceRelative: files.length > 0 ? files[0].relative : null,
          files: files.slice(0, 50),
        });
      },
    },

    'agent:read-artifact': {
      keys: ['projectId', 'runId', 'turnId', 'attemptId', 'versionId', 'kind', 'ref'],
      async run(payload, startedAt) {
        if (!['screenshot', 'report', 'diff'].includes(payload.kind)) return fail(CODES.PAYLOAD_INVALID, 'kind 非法');
        const safe = assertRelativePath(payload.ref, 'ref');
        if (!safe.ok) return safe;
        let root = null;
        if (payload.kind === 'diff' || (payload.versionId && payload.source === 'version') || payload.versionId) {
          const resolved = resolveVersion(contextOf(payload), payload.versionId);
          if (!resolved.ok) return resolved;
          root = path.dirname(resolved.sourceRoot);
        } else {
          if (!RUN_ID_RE.test(payload.runId || '')) return fail(CODES.ID_INVALID, 'runId 非法');
          if (!TURN_ID_RE.test(payload.turnId || '')) return fail(CODES.ID_INVALID, 'turnId 非法');
          const attempt = parseAttemptId(payload.attemptId);
          if (!attempt.ok) return attempt;
          const opened = openAttemptHandle(contextOf(payload), payload.runId, payload.turnId, attempt.attempt);
          if (!opened.ok) return opened;
          root = opened.attempt.attemptDir;
        }
        const located = resolveInRoot(root, payload.ref);
        if (!located.ok) return located;
        let stats;
        try {
          stats = fs.lstatSync(located.target);
        } catch (error) {
          return fail(CODES.ARTIFACT_NOT_FOUND, '证据文件不存在');
        }
        if (!stats.isFile()) {
          return fail(CODES.ARTIFACT_NOT_FOUND, '证据文件不存在');
        }
        // rev7：单件证据 ≤2 MiB；超限用 AGENT_RESULT_TOO_LARGE（不是 “找不到”），且不返回字节。
        if (stats.size > LIMITS.artifactBytes) {
          return fail(CODES.RESULT_TOO_LARGE, '证据文件超过 2 MiB 上限');
        }
        const buffer = fs.readFileSync(located.target);
        const extension = path.extname(payload.ref).slice(1).toLowerCase();
        const textLike = ['json', 'txt', 'md', 'log'].includes(extension);
        const sha256 = 'sha256:' + crypto.createHash('sha256').update(buffer).digest('hex');
        const base = {
          kind: payload.kind,
          ref: payload.ref,
          bytes: buffer.length,
          sha256,
          mime: mimeOf(extension),
        };
        // rev7 ③：文本 ≤64 KiB 回 content；其余（二进制、或超过 64 KiB 的文本）回 contentBytes: Uint8Array，
        // 经 IPC 结构化克隆交付，绝不 base64。
        if (textLike && buffer.length <= 64 * 1024) {
          return success(payload, startedAt, { ...base, content: buffer.toString('utf8') });
        }
        return success(payload, startedAt, { ...base, contentBytes: new Uint8Array(buffer) });
      },
    },

    'agent:submit-candidate': {
      keys: ['projectId', 'runId', 'turnId', 'attemptId', 'targetPage', 'summary'],
      write: true,
      async run(payload, startedAt) {
        if (!RUN_ID_RE.test(payload.runId || '')) return fail(CODES.ID_INVALID, 'runId 非法');
        if (!TURN_ID_RE.test(payload.turnId || '')) return fail(CODES.ID_INVALID, 'turnId 非法');
        const attempt = parseAttemptId(payload.attemptId);
        if (!attempt.ok) return attempt;
        // X5：8 页枚举（SourceFacts 派生），不再使用 v1 的 home/menu 常量。
        if (typeof payload.targetPage !== 'string' || !sourceBundle.isKnownTargetPage(payload.targetPage)) {
          return fail(CODES.TARGET_PAGE_UNSUPPORTED, 'targetPage 不在 8 页枚举内（'
            + sourceBundle.PAGE_IDS.join('/') + '）');
        }
        if (payload.summary !== undefined && (typeof payload.summary !== 'string' || payload.summary.length > 240)) {
          return fail(CODES.PAYLOAD_INVALID, 'summary 必须是有界字符串');
        }
        // rev15 §14.5：提交必须走 Coordinator 的静态门禁（source.check + composer.dry-run + 导出树绑定），
        // IPC 层不再自己写 submitted 状态。没有 Coordinator 就明确失败，不静默降级。
        if (!coordinator || typeof coordinator.submitAttempt !== 'function') {
          return fail(CODES.RUNTIME_TOOL_MISSING, '提交需要 WorkspaceRunCoordinator（当前未接线）');
        }
        const submitted = coordinator.submitAttempt({
          projectId: payload.projectId,
          runId: payload.runId,
          turnId: payload.turnId,
          // F-T5-01：Coordinator 只接受字符串 `attempt-<n>`（attempt.attempt 是数字），
          // 这里显式适配，避免真实 Coordinator 下恒 AGENT_ATTEMPT_NOT_FOUND。
          attemptId: 'attempt-' + attempt.attempt,
          targetPage: payload.targetPage,
          ...(payload.summary === undefined ? {} : { summary: payload.summary }),
        });
        if (!submitted || submitted.ok !== true) {
          const envelope = failureEnvelope(
            (submitted && submitted.code) || CODES.CHECK_FAILED,
            (submitted && submitted.message) || '提交失败',
            payload,
            startedAt,
            { issues: submitted && submitted.issues },
          );
          if (submitted && typeof submitted.nextAction === 'string') envelope.nextAction = submitted.nextAction;
          return envelope;
        }
        // F1（rev15 §14.5 合同 rev2）：返回体固定含导出树相对引用与摘要，缺 exportTreeDigest 不可 adopt。
        return success(payload, startedAt, {
          candidateId: submitted.candidateId,
          revision: submitted.revision,
          treeDigest: submitted.treeDigest,
          exportRelative: submitted.exportRelative || null,
          exportTreeDigest: submitted.exportTreeDigest || null,
          targetPage: submitted.targetPage,
          status: submitted.status,
          partial: Boolean(submitted.partial),
        });
      },
    },

    'agent:adopt-attempt': {
      keys: ['projectId', 'runId', 'turnId', 'attemptId', 'targetPage', 'partialConfirmed'],
      write: true,
      async run(payload, startedAt) {
        if (!RUN_ID_RE.test(payload.runId || '')) return fail(CODES.ID_INVALID, 'runId 非法');
        if (!TURN_ID_RE.test(payload.turnId || '')) return fail(CODES.ID_INVALID, 'turnId 非法');
        const attempt = parseAttemptId(payload.attemptId);
        if (!attempt.ok) return attempt;
        if (payload.targetPage !== undefined
          && (typeof payload.targetPage !== 'string' || !sourceBundle.isKnownTargetPage(payload.targetPage))) {
          return fail(CODES.TARGET_PAGE_UNSUPPORTED, 'targetPage 不在 8 页枚举内');
        }
        if (payload.partialConfirmed !== undefined && typeof payload.partialConfirmed !== 'boolean') {
          return fail(CODES.PAYLOAD_INVALID, 'partialConfirmed 必须是布尔值');
        }
        if (!coordinator || typeof coordinator.adoptAttempt !== 'function') {
          return fail(CODES.RUNTIME_TOOL_MISSING, '采用需要 WorkspaceRunCoordinator（当前未接线）');
        }
        // B2 adoptAttempt：读磁盘上的 submitted 状态 + verification 证据（submission.json + checks/*.json），
        // 校验 treeDigest/exportTreeDigest 后才落地新版本；返回值形状冻结 §3.2。
        const adopted = coordinator.adoptAttempt({
          projectId: payload.projectId,
          runId: payload.runId,
          turnId: payload.turnId,
          // F-T5-01：与 submit 同口径，Coordinator 需要字符串 `attempt-<n>`。
          attemptId: 'attempt-' + attempt.attempt,
          ...(payload.targetPage === undefined ? {} : { targetPage: payload.targetPage }),
          ...(payload.partialConfirmed === undefined ? {} : { partialConfirmed: payload.partialConfirmed }),
        });
        if (!adopted || adopted.ok !== true) {
          const envelope = failureEnvelope(
            (adopted && adopted.code) || CODES.VERIFICATION_MISSING,
            (adopted && adopted.message) || '采用失败',
            payload,
            startedAt,
            { issues: adopted && adopted.issues },
          );
          if (adopted && typeof adopted.nextAction === 'string') envelope.nextAction = adopted.nextAction;
          return envelope;
        }
        return success(payload, startedAt, {
          currentVersionId: adopted.currentVersionId,
          previousVersionId: adopted.previousVersionId,
          adoptedVersionId: adopted.adoptedVersionId,
          treeDigest: adopted.treeDigest,
          adoption: adopted.adoption || null,
          targetPage: adopted.targetPage,
        });
      },
    },

    'agent:versions': {
      keys: ['projectId'],
      async run(payload, startedAt) {
        const listed = versionsMod.listVersions({ userDataDir, projectId: payload.projectId });
        if (!listed.ok) return listed;
        const versions = listed.versions.map((entry) => ({
          versionId: entry.versionId,
          parentVersionId: entry.parentVersionId,
          createdAt: entry.createdAt,
          reason: entry.reason,
          isCurrent: Boolean(entry.isCurrent),
          treeDigest: entry.treeDigest,
          verification: entry.verification,
          fileCount: entry.fileCount,
          screenshotCount: entry.screenshotCount,
        }));
        return success(payload, startedAt, {
          currentVersionId: listed.currentVersionId,
          previousVersionId: listed.previousVersionId,
          redoVersionId: listed.redoVersionId,
          versions,
        });
      },
    },

    'agent:adopt-version': {
      keys: ['projectId', 'versionId', 'partialConfirmed'],
      write: true,
      async run(payload, startedAt) {
        if (!VERSION_ID_RE.test(payload.versionId || '')) return fail(CODES.VERSION_NOT_FOUND, 'versionId 非法');
        const stateResult = readProjectState(contextOf(payload));
        if (!stateResult.ok) return stateResult;
        const state = stateResult.state;
        const target = payload.versionId;
        let next;
        if (target === state.currentVersionId) {
          next = { ok: true, currentVersionId: state.currentVersionId, previousVersionId: state.previousVersionId, redoVersionId: state.redoVersionId };
        } else if (target === state.previousVersionId) {
          next = versionsMod.undoVersion({ userDataDir, projectId: payload.projectId });
        } else if (target === state.redoVersionId) {
          next = versionsMod.redoVersion({ userDataDir, projectId: payload.projectId });
        } else {
          // B2 只冻结了线性指针（undo/redo + 新采用），没有“任意历史版本直接设为 current”的原语。
          // B3 不复制版本逻辑，也不伪造成功：明确拒绝并要求 B2 扩展。
          return fail(CODES.VERSION_CONFLICT, 'B2 只支持 current/previous/redo 指针切换，任意历史版本采用需 B2 扩展');
        }
        if (!next.ok) return next;
        return success(payload, startedAt, {
          currentVersionId: next.currentVersionId,
          adoption: { versionId: next.currentVersionId, sourceKind: 'pointer-move' },
        });
      },
    },

    'agent:undo': {
      keys: ['projectId'],
      write: true,
      async run(payload, startedAt) {
        const next = versionsMod.undoVersion({ userDataDir, projectId: payload.projectId });
        if (!next.ok) return next;
        return success(payload, startedAt, { currentVersionId: next.currentVersionId });
      },
    },

    'agent:redo': {
      keys: ['projectId'],
      write: true,
      async run(payload, startedAt) {
        const next = versionsMod.redoVersion({ userDataDir, projectId: payload.projectId });
        if (!next.ok) return next;
        return success(payload, startedAt, { currentVersionId: next.currentVersionId });
      },
    },

    'agent:reopen': {
      keys: ['projectId'],
      async run(payload, startedAt) {
        const reopened = versionsMod.reopenProject({ userDataDir, projectId: payload.projectId });
        if (reopened.ok) {
          return success(payload, startedAt, {
            available: true,
            currentVersionId: reopened.currentVersionId,
            previousVersionId: reopened.previousVersionId,
            redoVersionId: reopened.redoVersionId,
            treeDigest: reopened.treeDigest,
            fileCount: reopened.fileCount,
          });
        }
        const state = reopened.state || {};
        const versionState = {
          status: reopened.code === CODES.WORKSPACE_NOT_FOUND ? 'none' : 'unavailable',
          available: false,
          code: reopened.code,
          currentVersionId: state.currentVersionId || null,
          reason: state.reason || null,
        };
        return failureEnvelope(reopened.code, reopened.message, payload, startedAt, { versionState });
      },
    },

    'agent:cancel-run': {
      keys: ['projectId', 'runId'],
      async run(payload, startedAt) {
        if (!RUN_ID_RE.test(payload.runId || '')) return fail(CODES.ID_INVALID, 'runId 非法');
        // OBS-4（t22 追加）：产品链取消必须落盘 run.json（state=cancelled / cancelRequested），
        // 不能只看本进程内存表；提交/已采用 → too-late 且不改盘。无 Coordinator 的 legacy 路径保留给旧测试。
        if (coordinator && typeof coordinator.cancelRun === 'function') {
          const authoritative = coordinator.cancelRun({ projectId: payload.projectId, runId: payload.runId });
          if (!authoritative || authoritative.ok !== true) {
            if (authoritative && authoritative.code === 'AGENT_RUN_NOT_FOUND') {
              return success(payload, startedAt, {
                state: 'too-late', stage: 'unknown', cancelled: false, requestedAt: null,
              });
            }
            return fail((authoritative && authoritative.code) || 'AGENT_TXN_ABORTED',
              (authoritative && authoritative.message) || '取消失败');
          }
          const state = authoritative.state;
          return success(payload, startedAt, {
            state,
            stage: state === 'cancelled' ? 'cancelled' : (state === 'requested' ? 'running' : 'submitted'),
            cancelled: authoritative.cancelled === true,
            requestedAt: state === 'requested' ? new Date(now()).toISOString() : null,
          });
        }
        const key = payload.projectId + ':' + payload.runId;
        const active = activeRuns.get(key);
        if (active) {
          // 三态（rev7）：首次 cancel 只登记“请求取消”，由 withRun settle 后确认 cancelled；
          // 重复 cancel 保持 requested（幂等），不把 requested 当场写成 cancelled。
          if (active.state === 'cancelled') {
            return success(payload, startedAt, {
              state: 'cancelled', stage: 'running', cancelled: true, requestedAt: active.requestedAt,
            });
          }
          if (!active.requestedAt) {
            active.requestedAt = new Date(now()).toISOString();
            active.state = 'requested';
            active.cancelled = true;
          }
          return success(payload, startedAt, {
            state: 'requested', stage: 'running', cancelled: false, requestedAt: active.requestedAt,
          });
        }
        const finished = finishedRuns.get(key);
        if (finished && finished.cancelled) {
          // 任务已按取消请求停止：再查询仍是 cancelled，不降级成 too-late。
          return success(payload, startedAt, {
            state: 'cancelled', stage: 'cancelled', cancelled: true, requestedAt: finished.requestedAt || null,
          });
        }
        // 迟到/未知 run 不是失败：明确返回 too-late，让 UI 显示“任务已结束”。
        return success(payload, startedAt, {
          state: 'too-late',
          stage: finished ? finished.status : 'unknown',
          cancelled: false,
          requestedAt: null,
        });
      },
    },
  };

  function resolveComparedAttemptId(value) {
    if (typeof value !== 'string') return fail(CODES.PAYLOAD_INVALID, 'comparedTo.attemptId 非法');
    const segments = value.split('/');
    if (segments.length !== 3) {
      return fail(CODES.PAYLOAD_INVALID, 'comparedTo.attemptId 需要 runId/turnId/attempt-<n> 形式');
    }
    const [runId, turnId, attemptId] = segments;
    if (!RUN_ID_RE.test(runId) || !TURN_ID_RE.test(turnId)) return fail(CODES.PAYLOAD_INVALID, 'comparedTo.attemptId 非法');
    const attempt = parseAttemptId(attemptId);
    if (!attempt.ok) return attempt;
    return ok({ runId, turnId, attempt: attempt.attempt, attemptId });
  }

  function lineStats(comparedRoot, currentRoot, file) {
    if (file.status === 'added') {
      const read = fs.existsSync(path.join(currentRoot, ...file.path.split('/')))
        ? fs.readFileSync(path.join(currentRoot, ...file.path.split('/')))
        : Buffer.alloc(0);
      return { additions: countLines(read), deletions: 0 };
    }
    if (file.status === 'deleted') {
      const read = fs.existsSync(path.join(comparedRoot, ...file.path.split('/')))
        ? fs.readFileSync(path.join(comparedRoot, ...file.path.split('/')))
        : Buffer.alloc(0);
      return { additions: 0, deletions: countLines(read) };
    }
    if (file.status === 'unchanged') return { additions: 0, deletions: 0 };
    const before = fs.existsSync(path.join(comparedRoot, ...file.path.split('/')))
      ? fs.readFileSync(path.join(comparedRoot, ...file.path.split('/'))).toString('utf8').split('\n')
      : [];
    const after = fs.existsSync(path.join(currentRoot, ...file.path.split('/')))
      ? fs.readFileSync(path.join(currentRoot, ...file.path.split('/'))).toString('utf8').split('\n')
      : [];
    let prefix = 0;
    while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
    let suffix = 0;
    while (
      suffix < before.length - prefix
      && suffix < after.length - prefix
      && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
    ) suffix += 1;
    return {
      additions: Math.max(0, after.length - prefix - suffix),
      deletions: Math.max(0, before.length - prefix - suffix),
    };
  }

  function countLines(buffer) {
    if (!buffer || buffer.length === 0) return 0;
    return buffer.toString('utf8').split('\n').filter((line, index, all) => !(index === all.length - 1 && line === '')).length;
  }

  function mimeOf(extension) {
    const map = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
      json: 'application/json', txt: 'text/plain', md: 'text/markdown', log: 'text/plain',
      wxml: 'text/plain', wxss: 'text/plain', js: 'text/javascript',
    };
    return map[extension] || 'application/octet-stream';
  }

  async function invoke(channel, payload) {
    const startedAt = now();
    const spec = commandSpecs[channel];
    if (!spec) {
      return failureEnvelope(CODES.PAYLOAD_INVALID, '未知命令', payload && isPlainObject(payload) ? payload : {}, startedAt);
    }
    const validated = validateCommonPayload(payload, spec);
    if (!validated.ok) {
      if (validated.code === CODES.PATH_INVALID) {
        return failureEnvelope(CODES.PAYLOAD_INVALID, validated.message, payload, startedAt);
      }
      return failureEnvelope(validated.code, validated.message, payload, startedAt);
    }
    const isWrite = Boolean(spec.write);
    const key = payload.projectId + (isWrite ? ':write' : ':read');
    if (isWrite) {
      if (!locks.acquire(key)) return failureEnvelope(CODES.BUSY, '该项目已有写任务在运行', payload, startedAt);
    } else if (!reads.acquire()) {
      return failureEnvelope(CODES.BUSY, '读取并发已达上限', payload, startedAt);
    }
    try {
      const result = await spec.run(payload, startedAt);
      if (!result || result.ok === false) {
        // 已经是 handler 组装好的失败 envelope（带 meta/issues，例如 reopen 的 versionState）直接返回。
        if (result && result.meta && Object.prototype.hasOwnProperty.call(result, 'data')) return result;
        const code = (result && result.code) || CODES.PAYLOAD_INVALID;
        return failureEnvelope(code, (result && result.message) || '请求失败', payload, startedAt);
      }
      if (result.ok === true && Object.prototype.hasOwnProperty.call(result, 'data')) return result;
      // handler 直接返回数据对象（没有 envelope）时统一封装。
      return success(payload, startedAt, result);
    } catch (error) {
      return failureEnvelope(CODES.PAYLOAD_INVALID, '命令执行失败', payload, startedAt);
    } finally {
      if (isWrite) locks.release(key);
      else reads.release();
    }
  }

  function emitProgressEvent(payload) {
    if (!emitProgress) return { ok: false, code: CODES.RUNTIME_TOOL_MISSING, message: '未配置进度发送器' };
    if (!isPlainObject(payload)) return { ok: false, code: CODES.PAYLOAD_INVALID, message: '进度必须是对象' };
    const allowed = ['projectId', 'runId', 'turnId', 'attemptId', 'phase', 'stage', 'status', 'at', 'message'];
    const unknown = rejectUnknownKeys(payload, allowed, 'progress');
    if (!unknown.ok) return unknown;
    if (!PROJECT_ID_RE.test(payload.projectId || '')) return fail(CODES.PROJECT_INVALID, 'projectId 非法');
    const status = payload.status;
    if (!['running', 'succeeded', 'failed', 'cancelled'].includes(status)) {
      return fail(CODES.PAYLOAD_INVALID, 'progress.status 非法');
    }
    const event = {
      projectId: payload.projectId,
      runId: typeof payload.runId === 'string' ? payload.runId : null,
      turnId: typeof payload.turnId === 'string' ? payload.turnId : null,
      attemptId: typeof payload.attemptId === 'string' ? payload.attemptId : null,
      phase: typeof payload.phase === 'string' ? payload.phase.slice(0, 40) : null,
      stage: typeof payload.stage === 'string' ? payload.stage.slice(0, 40) : null,
      status,
      at: typeof payload.at === 'string' ? payload.at.slice(0, 40) : new Date(now()).toISOString(),
      message: typeof payload.message === 'string' ? boundedMessage(payload.message, userDataDir).slice(0, LIMITS.progressMessage) : null,
    };
    try {
      emitProgress(event);
    } catch (error) {
      return fail(CODES.PAYLOAD_INVALID, '进度发送失败');
    }
    return ok({ event });
  }

  return {
    CODES,
    CHECK_IDS,
    LIMITS,
    PROGRESS_CHANNEL,
    invoke,
    emitProgress: emitProgressEvent,
    commandNames: Object.keys(commandSpecs),
    // 测试/诊断用（不是渲染进程可调用面）：手动登记一个在途 run 以覆盖取消语义。
    beginRun: (projectId, runId) => beginRun({ projectId }, runId),
    finishRun: (projectId, runId) => finishRun({ projectId }, runId, 'done'),
    activeRuns,
  };
}

/**
 * 注册到 Electron ipcMain：每个 channel 先校验 sender，再交给受控实现。
 * `isTrustedSender` 默认复用 composer-ipc 的白名单实现（测试可注入）。
 */
function registerAgentToolsIpc(ipcMain, options) {
  const opts = options || {};
  const isTrusted = typeof opts.isTrustedSender === 'function'
    ? opts.isTrustedSender
    : require('./composer-ipc.cjs').isTrustedSender;
  const created = createAgentToolsIpc(opts);
  for (const channel of created.commandNames) {
    ipcMain.handle(channel, async (event, payload) => {
      if (!isTrusted(event)) {
        return {
          ok: false,
          code: CODES.UNTRUSTED_SENDER,
          message: '请求来源不受信任',
          data: null,
          issues: [],
          meta: { projectId: null, durationMs: 0, truncated: false },
        };
      }
      return created.invoke(channel, payload);
    });
  }
  return created;
}

module.exports = {
  CODES,
  CHECK_IDS,
  LIMITS,
  PROGRESS_CHANNEL,
  COMMAND_PREFIX,
  createAgentToolsIpc,
  registerAgentToolsIpc,
  // 供 project-ipc / composer-ipc 复用的守卫（B3 接线）
  inspectVersionState: (options) => {
    const opts = options || {};
    const reopened = versionsMod.reopenProject(opts);
    if (reopened.ok) {
      return {
        status: 'ok',
        available: true,
        currentVersionId: reopened.currentVersionId,
        previousVersionId: reopened.previousVersionId,
        redoVersionId: reopened.redoVersionId,
        treeDigest: reopened.treeDigest,
      };
    }
    if (reopened.code === CODES.WORKSPACE_NOT_FOUND) return { status: 'none', available: false, code: reopened.code };
    const state = reopened.state || {};
    return {
      status: 'unavailable',
      available: false,
      code: reopened.code,
      currentVersionId: state.currentVersionId || null,
      reason: state.reason || null,
    };
  },
  verifyExportIdentity: (options) => versionsMod.verifyExportIdentity(options),
  versions: versionsMod,
  workspace: workspaceMod,
};
