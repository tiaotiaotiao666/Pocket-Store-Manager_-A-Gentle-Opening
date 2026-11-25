'use strict';

/**
 * E0-W1：WorkspaceRunCoordinator（唯一执行所有者；纯 CJS，不依赖 Electron）。
 *
 * 契约来源：`docs/handoff/Workspace-Agent-B阶段接口冻结.md` rev15 §14.2/§14.3
 * （另有 §1.3/§1.5/§1.6/§1.7、§3.3、§14.9 的相关不变式）。
 *
 * 形状（照抄冻结签名，不改）：
 *
 * ```js
 * createRunCoordinator({ userDataDir, checks?, directRuntime?, emitProgress?, limits?, now? })
 *   .startRun({ projectId, baseVersionId?, targetPage, operation, utterance, imageAssetIds? })
 *   .getRun({ projectId, runId })
 *   .invokeTool({ projectId, runId, turnId, attemptId, tool, args })
 *   .getAttemptState({ projectId, runId, turnId, attemptId })
 *   .cancelRun({ projectId, runId })
 *   .submitAttempt({ projectId, runId, turnId, attemptId, targetPage, summary? })
 *   .adoptAttempt({ projectId, runId, turnId, attemptId, targetPage, partialConfirmed? })
 * ```
 *
 * 边界（冻结）：
 * - 本模块**不复写**路径安全：一律复用 `paths.cjs`（唯一实现）与 B1
 *   `workspace/files/transactions/manifest`、B2 `versions`、B4 `checks`；
 * - 不新增 shell/child_process 入口；不向 renderer/模型暴露目录或绝对路径；
 * - 模型工具面固定 11 个（§14.3），平台专用工具名出现即 `AGENT_TOOL_NOT_ALLOWED`；
 * - 工具上下文由平台注入 `{projectId,runId,turnId,attemptId,subject:{kind:'attempt',attemptId}}`，
 *   模型不可传；写入永不接受 version subject，只有 `read_file` 允许 `subjectOverride` 只读 base 版本；
 * - 每次写事务后 revision 递增并重算 treeDigest（由 `transactions.applyChanges` 完成，本模块只读回）；
 * - submitted 之后该 attempt 只读（`AGENT_ATTEMPT_IMMUTABLE`），repair 走新 attempt。
 *
 * E0-W1 与 E0-W2 的分界（本文件故意保留的“未完成面”，见报告“与计划的偏差”）：
 * - 检查目标绑定（source.check/composer.dry-run 直接查 **attempt 树**、mini/output 只查派生导出树）
 *   属 E0-W2（X4）。W1 只把 B4 注册表的执行结果**如实**落证据；注册表未声明
 *   `subjectKind:"attempt"` 时证据记为 `subjectKind:"version"`，于是 submit 静态门禁
 *   必然拒绝（`AGENT_STATIC_GATE_FAILED`），不会把“查了当前版本源码”冒充成“查了 attempt”。
 * - `source-bundle.json` 平台派生（X6）与 adopt 的 exportTreeDigest/运行时证据绑定（X7）
 *   属 E0-W2；W1 的 `adoptAttempt` 只做 handle/只读/证据陈旧/partial 确认 + 委托 B2 `adoptAttempt`。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const paths = require('./paths.cjs');
const constants = require('./constants.cjs');
const workspaceMod = require('./workspace.cjs');
const filesMod = require('./files.cjs');
const transactionsMod = require('./transactions.cjs');
const manifestMod = require('./manifest.cjs');
const versionsMod = require('./versions.cjs');
const sourceBundle = require('./source-bundle.cjs');

const { PROJECT_ID_PATTERN } = require('../frontend-reconstruct/contract.generated.cjs');

const { LAYOUT, SCHEMAS, LIMITS, resolveLimits } = constants;
const { RUN_ID_PATTERN, TURN_ID_PATTERN, ATTEMPT_ID_PATTERN, VERSION_ID_PATTERN } = constants;

/** §1.7 + §2.2 + §3.3 + §14.9 允许的错误码（本模块只用这些，不私增）。 */
const CODES = Object.freeze({
  ...constants.CODES,
  RUN_NOT_FOUND: 'AGENT_RUN_NOT_FOUND',
  RUN_ALREADY_SUBMITTED: 'AGENT_RUN_ALREADY_SUBMITTED',
  ATTEMPT_IMMUTABLE: 'AGENT_ATTEMPT_IMMUTABLE',
  ATTEMPT_NOT_FOUND: 'AGENT_ATTEMPT_NOT_FOUND',
  PROJECT_MISMATCH: 'AGENT_PROJECT_MISMATCH',
  TOOL_NOT_ALLOWED: 'AGENT_TOOL_NOT_ALLOWED',
  STATIC_GATE_FAILED: 'AGENT_STATIC_GATE_FAILED',
  EVIDENCE_STALE: 'AGENT_EVIDENCE_STALE',
  PARTIAL_CONFIRM_REQUIRED: 'AGENT_PARTIAL_CONFIRM_REQUIRED',
  VERIFICATION_MISSING: 'AGENT_VERIFICATION_MISSING',
  CANCELLED: 'AGENT_CANCELLED',
  CHECK_UNKNOWN: 'AGENT_CHECK_UNKNOWN',
  PAYLOAD_INVALID: 'AGENT_PAYLOAD_INVALID',
  TARGET_PAGE_UNSUPPORTED: 'AGENT_TARGET_PAGE_UNSUPPORTED',
  RUNTIME_TOOL_MISSING: 'AGENT_RUNTIME_TOOL_MISSING',
});

/** §14.9 冻结码之外的**证据问题码**（issue.code，不是 envelope code）与唯一合法后续动作。 */
const EVIDENCE_STALE_ISSUE = 'EVIDENCE_STALE_RERUN_CHECKS';
const NEXT_ACTIONS = Object.freeze({
  RERUN_CHECKS: 'rerun-checks',
  RUN_CHECKS: 'run-checks',
  CONFIRM_PARTIAL: 'confirm-partial',
});

/** §14.3 模型可见工具（11 个，命名固定）。 */
const MODEL_TOOL_NAMES = Object.freeze([
  'get_context',
  'list_files',
  'read_file',
  'search_files',
  'write_files',
  'delete_files',
  'get_diff',
  'run_check',
  'verify_wechat',
  'read_verification',
  'submit_candidate',
]);
const MODEL_TOOL_SET = new Set(MODEL_TOOL_NAMES);

/** §14.3 平台专用工具：**不得**出现在模型工具列表；模型调用即 AGENT_TOOL_NOT_ALLOWED。 */
const PLATFORM_ONLY_TOOL_NAMES = Object.freeze(['derive_source_bundle', 'adopt_attempt', 'attach_image_asset']);
const PLATFORM_ONLY_TOOL_SET = new Set(PLATFORM_ONLY_TOOL_NAMES);

const RUN_STATES = Object.freeze({
  RUNNING: 'running',
  CANCELLED: 'cancelled',
  SUBMITTED: 'submitted',
  ADOPTED: 'adopted',
  FAILED: 'failed',
});

const ATTEMPT_STATUSES = Object.freeze({
  OPEN: 'open',
  SUBMITTED: 'submitted',
  ADOPTED: 'adopted',
});

/** §9.1 + rev15 §14.9 追加：`agent:progress` 只允许这些 stage。 */
const PROGRESS_STAGES = Object.freeze(new Set([
  'analyze', 'read-context', 'plan', 'edit', 'write', 'materialize', 'validate', 'render',
  'workspace', 'verify', 'compose', 'mini-check', 'consistency', 'observable', 'wechat',
  'repair', 'adopt', 'done',
  'queue', 'image', 'bundle', 'submit',
]));
const PROGRESS_STATUSES = Object.freeze(new Set(['running', 'succeeded', 'failed', 'cancelled']));

/** 模型给 `run_check.params` 时一律拒绝的键（`root`/`attempt`/`versionId` 由平台填）。 */
const FORBIDDEN_CHECK_PARAM_KEYS = Object.freeze([
  'root', 'attempt', 'attemptId', 'versionId', 'runId', 'turnId', 'path', 'paths',
  'cwd', 'command', 'args', 'shell', 'env', 'script', 'module', 'timeout',
  // rev15 §14.4：导出根/导出父目录同样只能是平台派生值，模型给了就是 AGENT_PAYLOAD_INVALID。
  'exportRoot', 'exportParentDir', 'exportRelative', 'subject', 'subjectKind',
]);

/** 各工具允许的 args 键（模型不可传目录/句柄）。 */
const TOOL_ARG_KEYS = Object.freeze({
  get_context: [],
  list_files: ['dir'],
  read_file: ['path', 'offset', 'limitBytes', 'subjectOverride'],
  search_files: ['query', 'mode', 'caseSensitive', 'maxResults'],
  write_files: ['changes'],
  delete_files: ['paths'],
  get_diff: [],
  run_check: ['checkId', 'params'],
  verify_wechat: ['appId', 'timeoutMs'],
  read_verification: ['source'],
  submit_candidate: ['targetPage', 'summary'],
});

/** 写工具：命中 submitted/adopted 一律 AGENT_ATTEMPT_IMMUTABLE。 */
const WRITE_TOOLS = new Set(['write_files', 'delete_files']);
/** 异步工具：占用一次 activeCall，取消时先返回 requested，完成后丢弃结果。 */
const ASYNC_TOOLS = new Set(['run_check', 'verify_wechat']);

const LIMITS_EXTRA = Object.freeze({
  maxIssues: 20,
  maxUtteranceChars: 8000,
  maxSummaryChars: 200,
  maxOperationChars: 64,
  maxTargetPageChars: 64,
  maxImageAssets: 4,
  maxAssetIdChars: 64,
  maxEvidenceFiles: 50,
  maxEvidenceBytes: 256 * 1024,
  maxProgressMessage: 120,
  maxToolListFiles: 4000,
});

const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;
const DATA_URI_PATTERN = /data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,/i;
const TARGET_PAGE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const OPERATION_PATTERN = /^[a-zA-Z][a-zA-Z0-9-]{0,63}$/;
const ASSET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseAttemptNumber(value) {
  if (Number.isInteger(value)) return ATTEMPT_ID_PATTERN.test('attempt-' + value) ? value : null;
  if (typeof value !== 'string') return null;
  const matched = ATTEMPT_ID_PATTERN.exec(value);
  if (!matched) return null;
  return Number(matched[1]);
}

/** 文件摘要唯一实现复用 manifest.digestOfContent（`sha256:<hex>`）。 */
function sha256OfBuffer(buffer) {
  return manifestMod.digestOfContent(buffer);
}

/* ------------------------------------------------------------------ */
/* createRunCoordinator                                                */
/* ------------------------------------------------------------------ */

/**
 * @param {object} options
 * @param {string} options.userDataDir 必需；项目私有根由 B1 workspacePaths 推导
 * @param {object} [options.checks] 注入 B4 checks 注册表；缺省懒加载真实实现
 * @param {object|null} [options.directRuntime] 注入 E0-R1 direct 通道；缺省 null
 * @param {(event:object)=>void} [options.emitProgress]
 * @param {object} [options.limits]
 * @param {()=>number} [options.now]
 */
function createRunCoordinator(options) {
  const opts = options || {};
  if (typeof opts.userDataDir !== 'string' || opts.userDataDir.trim() === '') {
    throw new TypeError('createRunCoordinator：userDataDir 必需（应用私有数据目录）');
  }
  const limitsResult = resolveLimits(opts.limits);
  if (!limitsResult.ok) throw new TypeError('createRunCoordinator：limits 非法（' + limitsResult.message + '）');
  const limits = limitsResult.limits;
  const userDataDir = path.resolve(opts.userDataDir);
  const clock = typeof opts.now === 'function' ? opts.now : Date.now;
  const emitProgress = typeof opts.emitProgress === 'function' ? opts.emitProgress : () => {};
  const directRuntime = isPlainObject(opts.directRuntime) ? opts.directRuntime : null;

  let checksRegistry = isPlainObject(opts.checks) ? opts.checks : null;
  /** 缺省懒加载真实 B4 注册表（模块不依赖 Electron；Node 测试可直接 require 本文件）。 */
  function registry() {
    if (checksRegistry) return checksRegistry;
    try {
      checksRegistry = require('./checks.cjs').createCheckRegistry({ userDataDir });
    } catch (error) {
      checksRegistry = null;
    }
    return checksRegistry;
  }

  /** 进程内 run 运行时状态（取消/在途调用）；持久事实仍然只看 run.json。 */
  const runtimeMap = new Map();

  function nowIso() {
    return new Date(clock()).toISOString();
  }

  function sanitizeMessage(text) {
    let out = typeof text === 'string' && text.trim() !== '' ? text : '操作失败';
    if (userDataDir) out = out.split(userDataDir).join('<private>');
    out = out.replace(/[A-Za-z]:[\\/][^\s"'`]*/g, '<path>');
    out = out.replace(/(^|[\s("'`=:])\/(?:[^\s"'`]+)/g, '$1<path>');
    out = out.replace(CONTROL_CHAR_PATTERN, ' ');
    if (out.length > 240) out = out.slice(0, 237) + '...';
    return out;
  }

  function failure(code, message, issues) {
    return {
      ok: false,
      code: typeof code === 'string' && code ? code : CODES.TXN_ABORTED,
      message: sanitizeMessage(message),
      issues: Array.isArray(issues) ? issues.slice(0, LIMITS_EXTRA.maxIssues) : [],
    };
  }

  /** B1/B2/B4 的 {ok:false,code,path,message} 归一成本模块 failure（保留原码）。 */
  function fromModuleFailure(result, fallbackCode) {
    if (!result || result.ok !== false) {
      return failure(fallbackCode || CODES.TXN_ABORTED, '内部调用失败');
    }
    return failure(result.code || fallbackCode || CODES.TXN_ABORTED, result.message);
  }

  function success(data, extra) {
    const meta = extra || {};
    return {
      ok: true,
      data: data === undefined ? null : data,
      issues: Array.isArray(meta.issues) ? meta.issues.slice(0, LIMITS_EXTRA.maxIssues) : [],
      truncated: Boolean(meta.truncated),
    };
  }

  function envelope(result, meta) {
    const base = {
      projectId: meta.projectId,
      runId: meta.runId,
      turnId: meta.turnId,
      attemptId: meta.attemptId,
      durationMs: Math.max(0, clock() - meta.startedAt),
    };
    if (result && result.ok === true) {
      return {
        ok: true,
        data: result.data === undefined ? null : result.data,
        issues: result.issues || [],
        meta: { ...base, truncated: Boolean(result.truncated) },
      };
    }
    return {
      ok: false,
      code: (result && result.code) || CODES.TXN_ABORTED,
      message: sanitizeMessage(result && result.message),
      data: null,
      issues: (result && result.issues) || [],
      ...(result && typeof result.nextAction === 'string' ? { nextAction: result.nextAction } : {}),
      meta: base,
    };
  }

  function subjectOf(attemptId) {
    return { kind: 'attempt', attemptId };
  }

  /* ---------------------------------------------------------------- */
  /* E0-W2（X5/X6）：8 页枚举 / 导出根 / Bundle 派生                     */
  /* ---------------------------------------------------------------- */

  /** 每个 checkId 只保留最新一条证据（按 at 字符串排序，ISO 时间可直接比较）。 */
  function evidenceIndex(attempt) {
    const byId = new Map();
    for (const entry of readCheckEvidence(attempt).entries) {
      const previous = byId.get(entry.checkId);
      if (!previous || String(entry.at || '') >= String(previous.at || '')) byId.set(entry.checkId, entry);
    }
    return byId;
  }

  /**
   * 8 页目标枚举（X5）：单一事实源是 SourceFacts，`enabled` 由“候选树里页面四件套 + 页面契约”派生。
   * 模型只读结果，永远拿不到“8 个硬编码 true”。
   */
  function targetPageEnumeration(attempt) {
    const read = sourceBundle.readTree(attempt.candidateDir);
    return sourceBundle.enumerateTargetPages({ files: read.ok ? read.files : null });
  }

  function relativeToAttempt(attempt, absolute) {
    const relative = path.relative(attempt.attemptDir, absolute).split(path.sep).join('/');
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
    return relative;
  }

  function absoluteInAttempt(attempt, relative) {
    if (typeof relative !== 'string' || relative === '') return null;
    const target = path.resolve(attempt.attemptDir, ...relative.split('/'));
    return paths.isInsideOrEqual(attempt.attemptDir, target) ? target : null;
  }

  /**
   * 平台派生的导出根（X4）：**只**来自本 attempt 的 `composer.dry-run` 证据。
   * 没有证据/证据没绑当前树 → `AGENT_CHECK_UNKNOWN`（绝不回落仓库 `miniprogram/`）。
   */
  function exportedRootOf(attempt) {
    const entry = evidenceIndex(attempt).get('composer.dry-run');
    if (!entry) {
      return failure(CODES.CHECK_UNKNOWN, 'mini.check/output.consistency/wechat.verify 需要先跑 composer.dry-run 产出导出树');
    }
    if (entry.subjectKind !== 'attempt' || entry.treeDigest !== attempt.treeDigest) {
      return failure(CODES.CHECK_UNKNOWN, 'composer.dry-run 证据与当前候选不一致，请重跑 dry-run');
    }
    if (entry.status !== 'PASS') {
      return failure(CODES.CHECK_UNKNOWN, 'composer.dry-run 未通过（' + String(entry.status) + '），没有可用的导出树');
    }
    const absolute = absoluteInAttempt(attempt, entry.exportRelative);
    if (!absolute || !fs.existsSync(absolute)) {
      return failure(CODES.CHECK_UNKNOWN, '导出树不存在或越界，请重跑 composer.dry-run');
    }
    return { ok: true, root: absolute, relative: entry.exportRelative, exportTreeDigest: entry.exportTreeDigest || null };
  }

  /**
   * Bundle 平台派生（X6）：候选树相对 Base 的改动 → `frontend-source-bundle.v1` → 写回候选树。
   * 写盘走 B1 事务（revision/treeDigest 由同一 ABI 维护），模型无法调用本函数、也无法自己写清单。
   */
  function deriveAttemptBundle(attempt, runMeta) {
    const context = sourceBundle.loadComposerContext();
    if (!context.ok) return failure(CODES.CHECK_UNKNOWN, context.message || 'Composer 上下文不可用');
    const candidate = sourceBundle.readTree(attempt.candidateDir);
    if (!candidate.ok) return failure(CODES.CHECK_UNKNOWN, candidate.message || '候选树不可读');
    const base = sourceBundle.readTree(context.baseSrc);
    if (!base.ok) return failure(CODES.CHECK_UNKNOWN, 'Base 源树不可读');

    const targetPage = attempt.meta.targetPage || runMeta.targetPage || null;
    const targetPages = sourceBundle.isKnownTargetPage(targetPage) ? [targetPage] : [];

    if (!sourceBundle.bundleIsStale(candidate.files, base.files)) {
      const existing = candidate.files.get(sourceBundle.BUNDLE_FILE);
      let digest = null;
      try {
        const parsed = JSON.parse(existing.toString('utf8'));
        digest = crypto.createHash('sha256')
          .update((parsed.files || []).map((file) => file.path + ':' + file.sha256).sort().join('\n'))
          .digest('hex');
        digest = 'sha256:' + digest;
      } catch (error) {
        digest = null;
      }
      return {
        ok: true,
        changed: false,
        bundleDigest: digest,
        revision: attempt.revision,
        treeDigest: attempt.treeDigest,
        fileCount: Array.isArray(JSON.parse(existing.toString('utf8')).files)
          ? JSON.parse(existing.toString('utf8')).files.length
          : 0,
      };
    }

    const derived = sourceBundle.deriveBundle({
      candidateFiles: candidate.files,
      targetPages,
      baseSrc: context.baseSrc,
    });
    if (!derived.ok) return failure(derived.code || CODES.STATIC_GATE_FAILED, derived.message, derived.issues);

    const applied = transactionsMod.applyChanges(attempt, [{
      op: 'write',
      path: sourceBundle.BUNDLE_FILE,
      content: sourceBundle.renderBundle(derived.manifest),
    }]);
    if (!applied || applied.ok !== true) return fromModuleFailure(applied, CODES.TXN_ABORTED);
    return {
      ok: true,
      changed: true,
      bundleDigest: derived.digest,
      revision: applied.revision,
      treeDigest: applied.treeDigest,
      fileCount: derived.fileCount,
      deletedCount: derived.deletedCount,
      componentCount: derived.componentCount,
      transactionId: applied.transactionId,
    };
  }

  /** 派生后刷新 attempt 句柄（revision/treeDigest 以磁盘为准，原地更新同一个句柄对象）。 */
  function refreshAttempt(attempt) {
    const refreshed = resolveAttempt({
      projectId: attempt.projectId,
      runId: attempt.runId,
      turnId: attempt.turnId,
      attemptId: attempt.attemptId,
    });
    if (!refreshed.ok) return refreshed;
    Object.assign(attempt, refreshed.attempt);
    return attempt;
  }

  function emit(event) {
    const payload = {
      projectId: event.projectId,
      runId: event.runId,
      turnId: event.turnId,
      attemptId: event.attemptId,
      phase: event.phase,
      stage: PROGRESS_STAGES.has(event.stage) ? event.stage : 'workspace',
      status: PROGRESS_STATUSES.has(event.status) ? event.status : 'running',
      at: nowIso(),
      message: typeof event.message === 'string' && event.message
        ? sanitizeMessage(event.message).slice(0, LIMITS_EXTRA.maxProgressMessage)
        : '',
    };
    try {
      emitProgress(payload);
    } catch (error) {
      /* 进度发送失败不得影响主流程 */
    }
  }

  /* ---------------------------------------------------------------- */
  /* run / attempt 读取（全部零落盘）                                   */
  /* ---------------------------------------------------------------- */

  function workspaceHandle(projectId, state) {
    const wsPaths = workspaceMod.workspacePaths({ userDataDir, projectId });
    if (!wsPaths.ok) return wsPaths;
    return {
      ok: true,
      ws: {
        schemaVersion: SCHEMAS.workspace,
        projectId,
        userDataDir: wsPaths.root,
        userDataReal: wsPaths.rootReal,
        projectDir: wsPaths.projectDir,
        workspaceDir: wsPaths.workspaceDir,
        projectFile: wsPaths.projectFile,
        versionsDir: wsPaths.versionsDir,
        runsDir: wsPaths.runsDir,
        project: state || null,
        limits,
      },
    };
  }

  function runtimeOf(projectId, runId) {
    const key = projectId + '/' + runId;
    let entry = runtimeMap.get(key);
    if (!entry) {
      entry = { key, activeCalls: 0 };
      runtimeMap.set(key, entry);
    }
    return entry;
  }

  /**
   * 读 run.json（纯读）。runId 形状非法 → AGENT_RUN_NOT_FOUND；
   * run.json 记录了别的 projectId（跨项目/被搬移）→ AGENT_PROJECT_MISMATCH。
   */
  function readRun(projectId, runId) {
    if (typeof projectId !== 'string' || !PROJECT_ID_PATTERN.test(projectId)) {
      return failure(CODES.PROJECT_ID_INVALID, 'projectId 非法');
    }
    if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) {
      return failure(CODES.RUN_NOT_FOUND, 'runId 非法或不存在');
    }
    const handle = workspaceHandle(projectId, null);
    if (!handle.ok) return fromModuleFailure(handle, CODES.RUN_NOT_FOUND);
    const read = manifestMod.readRunMeta(handle.ws, runId);
    if (!read.ok) return failure(CODES.RUN_NOT_FOUND, 'run 不存在', []);
    const runMeta = read.meta;
    if (!isPlainObject(runMeta) || runMeta.schemaVersion !== SCHEMAS.run) {
      return failure(CODES.RUN_NOT_FOUND, 'run.json 形状非法');
    }
    if (runMeta.projectId !== projectId) {
      return failure(CODES.PROJECT_MISMATCH, 'run 不属于该 projectId');
    }
    return { ok: true, ws: handle.ws, runMeta, runId, projectId };
  }

  function writeRun(ws, runId, patch) {
    const written = manifestMod.writeRunMeta(ws, runId, patch);
    if (!written.ok) return fromModuleFailure(written, CODES.RUN_NOT_FOUND);
    return { ok: true, runMeta: written.meta };
  }

  /**
   * 句柄解析（零落盘）：跨项目 / 跨 run / 跨 turn / 伪造 attemptId 全部拒绝。
   * 只放行 `runs/<runId>/turns/<turnId>/attempts/attempt-<n>/` 布局（由 B1 推导 + canonical 复核）。
   */
  function resolveAttempt(input) {
    const payload = isPlainObject(input) ? input : {};
    const run = readRun(payload.projectId, payload.runId);
    if (!run.ok) return run;

    if (typeof payload.turnId !== 'string' || !TURN_ID_PATTERN.test(payload.turnId)) {
      return failure(CODES.ATTEMPT_NOT_FOUND, 'turnId 非法或不存在');
    }
    if (typeof payload.attemptId !== 'string' || !ATTEMPT_ID_PATTERN.test(payload.attemptId)) {
      return failure(CODES.ATTEMPT_NOT_FOUND, 'attemptId 非法或不存在');
    }
    const attemptNumber = parseAttemptNumber(payload.attemptId);
    if (attemptNumber === null) return failure(CODES.ATTEMPT_NOT_FOUND, 'attemptId 非法或不存在');

    const derived = workspaceMod.attemptPaths({
      userDataDir,
      projectId: payload.projectId,
      runId: payload.runId,
      turnId: payload.turnId,
      attempt: attemptNumber,
    });
    if (!derived.ok) return failure(CODES.ATTEMPT_NOT_FOUND, 'attempt 句柄非法');
    if (!fs.existsSync(derived.attemptDir)) return failure(CODES.ATTEMPT_NOT_FOUND, 'attempt 不存在');

    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(derived.attemptFile, 'utf8'));
    } catch (error) {
      return failure(CODES.ATTEMPT_NOT_FOUND, 'attempt.json 不存在或无法解析');
    }
    if (!isPlainObject(meta) || meta.schemaVersion !== SCHEMAS.attempt) {
      return failure(CODES.ATTEMPT_NOT_FOUND, 'attempt.json 形状非法');
    }
    if (meta.projectId !== payload.projectId) {
      return failure(CODES.PROJECT_MISMATCH, 'attempt 不属于该 projectId');
    }
    if (meta.runId !== payload.runId || meta.turnId !== payload.turnId || meta.attemptId !== payload.attemptId) {
      return failure(CODES.ATTEMPT_NOT_FOUND, 'attempt 句柄与磁盘记录不一致');
    }

    const stateResult = versionsMod.readProjectState({ userDataDir, projectId: payload.projectId });
    const handle = workspaceHandle(payload.projectId, stateResult.ok ? stateResult.state : null);
    if (!handle.ok) return fromModuleFailure(handle, CODES.ATTEMPT_NOT_FOUND);
    const opened = workspaceMod.openAttempt(handle.ws, {
      runId: payload.runId,
      turnId: payload.turnId,
      attempt: attemptNumber,
    });
    if (!opened.ok) return fromModuleFailure(opened, CODES.ATTEMPT_NOT_FOUND);

    return {
      ok: true,
      ws: handle.ws,
      runMeta: run.runMeta,
      attempt: opened.attempt,
      subject: subjectOf(payload.attemptId),
    };
  }

  function attemptStatusOf(attempt) {
    const status = attempt && attempt.meta && attempt.meta.status;
    return typeof status === 'string' ? status : ATTEMPT_STATUSES.OPEN;
  }

  function runIsCancelled(runMeta) {
    return Boolean(runMeta) && runMeta.state === RUN_STATES.CANCELLED;
  }

  /** 已取消或已请求取消（在途调用先记账 requested，随后一律不落盘）。 */
  function runCancelPending(runMeta) {
    if (!runMeta) return false;
    return runMeta.cancelRequested === true || runIsCancelled(runMeta);
  }

  /** 异步工具 await 回来后重新确认 run 状态：取消（含 requested）后一律不落证据。 */
  function runCancelledNow(attempt) {
    const fresh = readRun(attempt.projectId, attempt.runId);
    return fresh.ok && runCancelPending(fresh.runMeta);
  }

  /* ---------------------------------------------------------------- */
  /* 证据（attempt/verification/**，只相对引用）                        */
  /* ---------------------------------------------------------------- */

  function evidenceFileName(checkId) {
    return String(checkId).replace(/[^A-Za-z0-9._-]/g, '_') + '.json';
  }

  function checksEvidenceDirOf(attempt) {
    return path.join(attempt.verificationDir, 'checks');
  }

  function ensureEvidenceDir(attempt, dir) {
    const ensured = paths.ensureDirectory(attempt.userDataDir, attempt.userDataReal, dir, constants.CODES);
    if (!ensured.ok) return fromModuleFailure(ensured, CODES.WORKSPACE_INVALID);
    const canonical = paths.assertCanonicalDir(dir, constants.CODES);
    if (!canonical.ok) return fromModuleFailure(canonical, CODES.WORKSPACE_INVALID);
    return { ok: true };
  }

  /** 证据写入只走共享原子写；目标必须在 attempt/verification 内（canonical + audit）。 */
  function writeEvidenceFile(attempt, relativeFile, value) {
    const rootCanonical = paths.assertCanonicalDir(attempt.verificationDir, constants.CODES);
    if (!rootCanonical.ok) return fromModuleFailure(rootCanonical, CODES.WORKSPACE_INVALID);
    const target = path.join(attempt.verificationDir, ...relativeFile.split('/'));
    if (!paths.isInsideOrEqual(attempt.verificationDir, target)) {
      return failure(CODES.PATH_ESCAPE, '证据路径越界');
    }
    const ensured = ensureEvidenceDir(attempt, path.dirname(target));
    if (!ensured.ok) return ensured;
    const audited = paths.auditPath(attempt.verificationDir, rootCanonical.realDir, target, constants.CODES);
    if (!audited.ok) return fromModuleFailure(audited, CODES.WORKSPACE_INVALID);
    const written = paths.writeJsonAtomic(target, value, constants.CODES);
    if (!written.ok) return fromModuleFailure(written, CODES.IO_FAILED);
    return { ok: true, relative: path.relative(attempt.attemptDir, target).split(path.sep).join('/') };
  }

  function readJsonBoundedFile(file) {
    let stats;
    try {
      stats = fs.lstatSync(file);
    } catch (error) {
      return null;
    }
    if (stats.isSymbolicLink() || !stats.isFile() || stats.size > LIMITS_EXTRA.maxEvidenceBytes) return null;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      return null;
    }
  }

  /** 读 attempt/verification/checks/*.json（bounded，返回相对引用 + 证据条目）。 */
  function readCheckEvidence(attempt) {
    const dir = checksEvidenceDirOf(attempt);
    const entries = [];
    let files = [];
    try {
      files = fs.readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith('.json'))
        .map((entry) => entry.name)
        .sort()
        .slice(0, LIMITS_EXTRA.maxEvidenceFiles);
    } catch (error) {
      return { ok: true, entries: [], files: [] };
    }
    for (const name of files) {
      const value = readJsonBoundedFile(path.join(dir, name));
      if (!isPlainObject(value) || typeof value.checkId !== 'string') continue;
      entries.push({
        checkId: value.checkId,
        status: value.status,
        durationMs: Number.isInteger(value.durationMs) ? value.durationMs : 0,
        treeDigest: typeof value.treeDigest === 'string' ? value.treeDigest : null,
        subjectKind: value.subjectKind,
        attemptId: value.attemptId,
        at: value.at,
        evidenceRelative: typeof value.evidenceRelative === 'string' ? value.evidenceRelative : null,
        // rev15 §14.4：导出树级检查的证据必须带“导出根相对引用 + 导出树摘要”，供 submit/adopt 绑定。
        exportRelative: typeof value.exportRelative === 'string' ? value.exportRelative : null,
        exportTreeDigest: typeof value.exportTreeDigest === 'string' ? value.exportTreeDigest : null,
        issues: Array.isArray(value.issues) ? value.issues.slice(0, LIMITS_EXTRA.maxIssues) : [],
      });
    }
    return { ok: true, entries, files: files.map((name) => 'verification/checks/' + name) };
  }

  function readSubmissionEvidence(attempt) {
    const value = readJsonBoundedFile(path.join(attempt.verificationDir, 'submission.json'));
    return isPlainObject(value) ? value : null;
  }

  /**
   * §14.5 submit 静态门禁（W1 版本：只看落盘证据与当前 treeDigest 的一致性）。
   * 证据的 `subjectKind` 必须是 `attempt` 且 `treeDigest` 等于当前 attempt 树，
   * 否则一律拒绝 —— 绝不把“查了当前版本源码”当成“查了这次候选”。
   */
  function staleEvidenceFailure(details) {
    // rev15 §14.5 + F3：证据与当前 revision/treeDigest 不一致时，唯一合法动作是重跑检查，
    // 平台绝不自动补派生（派生会改 treeDigest，把已通过的检查作废）。
    const result = failure(CODES.EVIDENCE_STALE, '证据与当前候选不一致，请按顺序重跑检查：' + details.join('；'), [{
      code: EVIDENCE_STALE_ISSUE,
      severity: 'high',
      message: '证据树摘要/导出摘要已过期，必须重新执行检查链',
      source: 'coordinator',
    }]);
    result.nextAction = NEXT_ACTIONS.RERUN_CHECKS;
    return result;
  }

  function evaluateStaticGate(attempt) {
    const evidence = readCheckEvidence(attempt);
    const current = attempt.treeDigest;
    const byId = new Map();
    for (const entry of evidence.entries) {
      const previous = byId.get(entry.checkId);
      if (!previous || String(entry.at || '') >= String(previous.at || '')) byId.set(entry.checkId, entry);
    }
    const missing = [];
    const stale = [];
    const failed = [];
    const requirePass = (checkId) => {
      const entry = byId.get(checkId);
      if (!entry) {
        missing.push(checkId + '（未执行）');
        return;
      }
      if (entry.status !== 'PASS') {
        failed.push(checkId + '=' + String(entry.status));
        return;
      }
      const expectedSubject = checkId === 'mini.check' || checkId === 'output.consistency' ? 'export' : 'attempt';
      if (entry.subjectKind !== expectedSubject) {
        failed.push(checkId + ' 的证据主体不是 ' + expectedSubject);
        return;
      }
      if (entry.treeDigest !== current) {
        stale.push(checkId + ' 的证据 treeDigest 与当前候选（revision ' + String(attempt.revision) + '）不一致');
      }
    };
    requirePass('source.check');
    requirePass('composer.dry-run');
    requirePass('mini.check');
    requirePass('output.consistency');

    // 导出树绑定（X4/X7）：composer.dry-run 必须留下导出根引用；mini/output/wechat 若跑过，
    // 其 exportTreeDigest 必须与当前 dry-run 的导出一致，否则视为陈旧证据。
    const dryRun = byId.get('composer.dry-run');
    const dryRunExportDigest = dryRun && typeof dryRun.exportTreeDigest === 'string' ? dryRun.exportTreeDigest : null;
    if (dryRun && dryRun.status === 'PASS' && (!dryRun.exportRelative || !dryRunExportDigest)) {
      failed.push('composer.dry-run 没有登记导出树引用/摘要');
    }
    for (const checkId of ['mini.check', 'output.consistency', 'wechat.verify']) {
      const entry = byId.get(checkId);
      if (!entry) continue;
      if (entry.status === 'FAIL') {
        failed.push(checkId + '=FAIL');
        continue;
      }
      // F-T5-07（rev15 §14.13-1 同口径，fail-closed）：PASS 证据缺 exportTreeDigest 时不能静默视为一致，
      // 只要有 dry-run 导出摘要可比，就按陈旧处理（旧格式/被篡改的证据不得放行 submit）。
      if (entry.status === 'PASS' && !entry.exportTreeDigest && dryRunExportDigest) {
        stale.push(checkId + ' 的 PASS 证据缺少 exportTreeDigest（fail-closed 视为陈旧）');
        continue;
      }
      if (entry.status === 'PASS' && entry.exportTreeDigest && dryRunExportDigest
        && entry.exportTreeDigest !== dryRunExportDigest) {
        stale.push(checkId + ' 的证据绑定的是另一次导出树（exportTreeDigest 不一致）');
      }
    }

    let partial = false;
    for (const checkId of ['mini.check', 'output.consistency', 'wechat.verify']) {
      const entry = byId.get(checkId);
      if (!entry || entry.status === 'BLOCKED' || entry.status === 'NOT_RUN') partial = true;
    }

    // 陈旧优先于“缺/失败”：这是“写→检查→再写→提交”的唯一诚实结论。
    if (stale.length > 0) return staleEvidenceFailure(stale);
    if (missing.length > 0 || failed.length > 0) {
      const parts = [];
      if (missing.length > 0) parts.push('缺少 ' + missing.join('、'));
      if (failed.length > 0) parts.push('不满足 ' + failed.join('、'));
      return failure(CODES.STATIC_GATE_FAILED, '静态门禁未通过：' + parts.join('；'));
    }
    return {
      ok: true,
      partial,
      exportTreeDigest: dryRunExportDigest,
      exportRelative: dryRun ? dryRun.exportRelative : null,
      checks: Array.from(byId.values()).map((entry) => ({
        checkId: entry.checkId,
        status: entry.status,
        at: entry.at,
        treeDigest: entry.treeDigest,
        exportTreeDigest: entry.exportTreeDigest || null,
      })),
    };
  }

  /* ---------------------------------------------------------------- */
  /* startRun / getRun / getAttemptState                               */
  /* ---------------------------------------------------------------- */

  function nextRunId(ws) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const suffix = clock().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
      const candidate = 'frun-' + suffix;
      if (!RUN_ID_PATTERN.test(candidate)) continue;
      if (!fs.existsSync(path.join(ws.runsDir, candidate))) return candidate;
    }
    return null;
  }

  function startRun(input) {
    const payload = isPlainObject(input) ? input : {};
    if (typeof payload.projectId !== 'string' || !PROJECT_ID_PATTERN.test(payload.projectId)) {
      return failure(CODES.PROJECT_ID_INVALID, 'projectId 非法');
    }
    if (typeof payload.targetPage !== 'string' || !sourceBundle.isKnownTargetPage(payload.targetPage)) {
      // X5：8 页枚举的唯一事实源是 SourceFacts（`scripts/agent-source-facts.cjs`），不是 v1 的 home/menu。
      return failure(CODES.TARGET_PAGE_UNSUPPORTED, 'targetPage 不在 8 页枚举内（'
        + sourceBundle.PAGE_IDS.join('/') + '）');
    }
    if (typeof payload.operation !== 'string' || !OPERATION_PATTERN.test(payload.operation)) {
      return failure(CODES.PAYLOAD_INVALID, 'operation 非法（字母开头，≤64，仅字母数字与 -）');
    }
    if (typeof payload.utterance !== 'string' || payload.utterance.trim() === ''
      || payload.utterance.length > LIMITS_EXTRA.maxUtteranceChars) {
      return failure(CODES.PAYLOAD_INVALID, 'utterance 必须是非空字符串且不超过 ' + LIMITS_EXTRA.maxUtteranceChars + ' 字');
    }
    let imageAssetIds = [];
    if (payload.imageAssetIds !== undefined) {
      if (!Array.isArray(payload.imageAssetIds) || payload.imageAssetIds.length > LIMITS_EXTRA.maxImageAssets) {
        return failure(CODES.PAYLOAD_INVALID, 'imageAssetIds 必须是不超过 ' + LIMITS_EXTRA.maxImageAssets + ' 项的数组');
      }
      for (const assetId of payload.imageAssetIds) {
        if (typeof assetId !== 'string' || !ASSET_ID_PATTERN.test(assetId)) {
          return failure(CODES.PAYLOAD_INVALID, 'imageAssetIds 只接受既有 assetId（不是路径/base64）');
        }
      }
      imageAssetIds = payload.imageAssetIds.slice();
    }

    // 1) 版本指针：没有 currentVersionId / 版本不存在 → AGENT_VERSION_NOT_FOUND，且**不建任何目录**。
    const stateResult = versionsMod.readProjectState({ userDataDir, projectId: payload.projectId });
    if (!stateResult.ok) {
      return failure(CODES.VERSION_NOT_FOUND, '项目还没有可用的当前版本');
    }
    const baseVersionId = payload.baseVersionId === undefined
      ? stateResult.state.currentVersionId
      : payload.baseVersionId;
    if (typeof baseVersionId !== 'string' || !VERSION_ID_PATTERN.test(baseVersionId)) {
      return failure(CODES.VERSION_NOT_FOUND, 'baseVersionId 非法或项目还没有当前版本');
    }
    const versionRead = versionsMod.readVersion({ userDataDir, projectId: payload.projectId, versionId: baseVersionId });
    if (!versionRead.ok) return failure(CODES.VERSION_NOT_FOUND, 'baseVersionId 对应的版本不存在');

    // 2) 私有无根 → 建 workspace/run/turn，并从该版本 source/ 复制 attempt 工作树。
    const opened = workspaceMod.openWorkspace({ userDataDir, projectId: payload.projectId });
    if (!opened.ok) return fromModuleFailure(opened, CODES.WORKSPACE_NOT_FOUND);
    const workspace = opened.workspace;

    const runId = nextRunId(workspace);
    if (!runId) return failure(CODES.TXN_ABORTED, '无法分配 runId');
    const turnId = 'turn-1';

    const created = workspaceMod.createAttempt(workspace, {
      runId,
      turnId,
      attempt: 1,
      source: { kind: 'version', versionId: baseVersionId, reason: 'run-base' },
      limits,
    });
    if (!created.ok) return fromModuleFailure(created, CODES.TXN_ABORTED);
    const attempt = created.attempt;
    const baseTreeDigest = attempt.treeDigest;

    const runWritten = writeRun(workspace, runId, {
      state: RUN_STATES.RUNNING,
      baseVersionId,
      baseTreeDigest,
      targetPage: payload.targetPage,
      operation: payload.operation,
      utteranceChars: payload.utterance.length,
      imageAssetIds,
    });
    if (!runWritten.ok) {
      // 回滚：run/turn/attempt 目录全部删掉，避免留下“半套” run。
      workspaceMod.removeAttempt(workspace, { runId, turnId, attempt: 1 });
      return runWritten;
    }

    const attemptWritten = manifestMod.writeAttemptMeta(attempt, {
      targetPage: payload.targetPage,
      baseVersionId,
      baseTreeDigest,
      operation: payload.operation,
    });
    if (!attemptWritten.ok) return fromModuleFailure(attemptWritten, CODES.TXN_ABORTED);
    attempt.meta = attemptWritten.meta;

    runtimeOf(payload.projectId, runId);

    emit({
      projectId: payload.projectId,
      runId,
      turnId,
      attemptId: attempt.attemptId,
      phase: 'start',
      stage: 'workspace',
      status: 'succeeded',
      message: 'run 已创建（base ' + baseVersionId + '）',
    });

    return {
      ok: true,
      runId,
      turnId,
      attemptId: attempt.attemptId,
      baseVersionId,
      baseTreeDigest,
      revision: Number.isInteger(attempt.revision) ? attempt.revision : 1,
      targetPage: payload.targetPage,
      operation: payload.operation,
      subject: subjectOf(attempt.attemptId),
    };
  }

  function getRun(input) {
    const payload = isPlainObject(input) ? input : {};
    const run = readRun(payload.projectId, payload.runId);
    if (!run.ok) return run;
    const runMeta = run.runMeta;
    const turns = Array.isArray(runMeta.turns) ? runMeta.turns.slice() : [];
    const attempts = [];
    for (const turnId of turns) {
      const turnFile = path.join(run.ws.runsDir, run.runId, LAYOUT.turnsDir, turnId, LAYOUT.turnFile);
      const turnMeta = readJsonBoundedFile(turnFile);
      const listed = isPlainObject(turnMeta) && Array.isArray(turnMeta.attempts) ? turnMeta.attempts : [];
      for (const attemptId of listed) {
        const attemptNumber = parseAttemptNumber(attemptId);
        if (attemptNumber === null) continue;
        const derived = workspaceMod.attemptPaths({
          userDataDir,
          projectId: payload.projectId,
          runId: run.runId,
          turnId,
          attempt: attemptNumber,
        });
        if (!derived.ok) continue;
        const meta = readJsonBoundedFile(derived.attemptFile);
        if (!isPlainObject(meta)) continue;
        attempts.push({
          turnId,
          attemptId,
          status: attemptStatusOf({ meta }),
          revision: Number.isInteger(meta.revision) ? meta.revision : 1,
          treeDigest: typeof meta.treeDigest === 'string' ? meta.treeDigest : null,
          baseVersionId: typeof meta.baseVersionId === 'string' ? meta.baseVersionId : null,
          targetPage: typeof meta.targetPage === 'string' ? meta.targetPage : null,
          createdAt: meta.createdAt || null,
          updatedAt: meta.updatedAt || null,
        });
      }
    }
    return {
      ok: true,
      runId: run.runId,
      projectId: payload.projectId,
      state: typeof runMeta.state === 'string' ? runMeta.state : RUN_STATES.RUNNING,
      baseVersionId: runMeta.baseVersionId || null,
      baseTreeDigest: runMeta.baseTreeDigest || null,
      targetPage: runMeta.targetPage || null,
      operation: runMeta.operation || null,
      cancelRequested: Boolean(runMeta.cancelRequested),
      createdAt: runMeta.createdAt || null,
      updatedAt: runMeta.updatedAt || null,
      turns: turns.map((turnId) => ({ turnId })),
      attempts,
    };
  }

  function getAttemptState(input) {
    const resolved = resolveAttempt(input);
    if (!resolved.ok) return resolved;
    const attempt = resolved.attempt;
    const evidence = readCheckEvidence(attempt);
    const submission = readSubmissionEvidence(attempt);
    return {
      ok: true,
      projectId: attempt.projectId,
      runId: attempt.runId,
      turnId: attempt.turnId,
      attemptId: attempt.attemptId,
      runState: typeof resolved.runMeta.state === 'string' ? resolved.runMeta.state : RUN_STATES.RUNNING,
      cancelRequested: Boolean(resolved.runMeta.cancelRequested),
      status: attemptStatusOf(attempt),
      subject: subjectOf(attempt.attemptId),
      revision: Number.isInteger(attempt.revision) ? attempt.revision : 1,
      treeDigest: attempt.treeDigest,
      baseVersionId: attempt.meta.baseVersionId || resolved.runMeta.baseVersionId || null,
      baseTreeDigest: attempt.meta.baseTreeDigest || resolved.runMeta.baseTreeDigest || null,
      targetPage: attempt.meta.targetPage || resolved.runMeta.targetPage || null,
      operation: attempt.meta.operation || resolved.runMeta.operation || null,
      fileCount: Number.isInteger(attempt.fileCount) ? attempt.fileCount : 0,
      totalBytes: Number.isInteger(attempt.totalBytes) ? attempt.totalBytes : 0,
      createdAt: attempt.meta.createdAt || null,
      updatedAt: attempt.meta.updatedAt || null,
      submittedAt: attempt.meta.submittedAt || null,
      candidateId: attempt.meta.candidateId || null,
      adoptedVersionId: attempt.meta.adoptedVersionId || null,
      verification: {
        checks: evidence.entries.map((entry) => ({
          checkId: entry.checkId,
          status: entry.status,
          subjectKind: entry.subjectKind,
          at: entry.at,
        })),
        submission: submission
          ? {
            candidateId: submission.candidateId || null,
            revision: submission.revision || null,
            treeDigest: submission.treeDigest || null,
            partial: Boolean(submission.partial),
            at: submission.at || null,
          }
          : null,
      },
    };
  }

  /* ---------------------------------------------------------------- */
  /* cancelRun                                                         */
  /* ---------------------------------------------------------------- */

  function cancelRun(input) {
    const payload = isPlainObject(input) ? input : {};
    const run = readRun(payload.projectId, payload.runId);
    if (!run.ok) return run;
    const state = typeof run.runMeta.state === 'string' ? run.runMeta.state : RUN_STATES.RUNNING;

    // 已提交/已采用：取消太晚（不得显示成失败，也不得回滚任何事实）。
    if (state === RUN_STATES.SUBMITTED || state === RUN_STATES.ADOPTED) {
      return { ok: true, state: 'too-late', cancelled: false, runId: payload.runId };
    }
    if (state === RUN_STATES.CANCELLED) {
      return { ok: true, state: 'cancelled', cancelled: true, runId: payload.runId };
    }

    const runtime = runtimeOf(payload.projectId, payload.runId);
    if (runtime.activeCalls > 0) {
      // 有在途调用：先记账，等本次调用结束后再落 cancelled（迟到结果一律丢弃）。
      const written = writeRun(run.ws, payload.runId, { cancelRequested: true });
      if (!written.ok) return written;
      emit({
        projectId: payload.projectId,
        runId: payload.runId,
        turnId: null,
        attemptId: null,
        phase: 'cancel',
        stage: 'workspace',
        status: 'running',
        message: '已请求取消，等待在途调用结束',
      });
      return { ok: true, state: 'requested', cancelled: false, runId: payload.runId };
    }

    const written = writeRun(run.ws, payload.runId, {
      state: RUN_STATES.CANCELLED,
      cancelRequested: true,
      cancelledAt: nowIso(),
    });
    if (!written.ok) return written;
    emit({
      projectId: payload.projectId,
      runId: payload.runId,
      turnId: null,
      attemptId: null,
      phase: 'cancel',
      stage: 'workspace',
      status: 'cancelled',
      message: '已取消',
    });
    return { ok: true, state: 'cancelled', cancelled: true, runId: payload.runId };
  }

  /** 在途调用结束后：若期间请求过取消，把 run 落成 cancelled（不再写任何证据）。 */
  function settleCancellation(projectId, runId) {
    const run = readRun(projectId, runId);
    if (!run.ok) return;
    const state = run.runMeta.state;
    if (state !== RUN_STATES.RUNNING || !run.runMeta.cancelRequested) return;
    writeRun(run.ws, runId, { state: RUN_STATES.CANCELLED, cancelledAt: nowIso() });
  }

  /**
   * direct 通道的取消门控（E0-R1 用；不属于 §14.2 冻结 8 签名，见报告“偏差”）。
   * 取消后返回 AGENT_CANCELLED：调用方**不得**再向上游发起请求。
   */
  function assertRunActive(input) {
    const payload = isPlainObject(input) ? input : {};
    const run = readRun(payload.projectId, payload.runId);
    if (!run.ok) return run;
    if (runCancelPending(run.runMeta)) return failure(CODES.CANCELLED, 'run 已取消');
    if (run.runMeta.state === RUN_STATES.SUBMITTED || run.runMeta.state === RUN_STATES.ADOPTED) {
      return failure(CODES.CANCELLED, 'run 已完成');
    }
    return { ok: true };
  }

  /**
   * direct 模型调用唯一入口（E0-R1 接线用；内部方法，不属于 §14.2 冻结 8 签名）。
   * 取消后不发起调用；在途期间取消 → 结果丢弃并返回 AGENT_CANCELLED。
   */
  async function invokeDirect(input) {
    const payload = isPlainObject(input) ? input : {};
    const resolved = resolveAttempt(payload);
    if (!resolved.ok) return resolved;
    if (!directRuntime || typeof directRuntime.invoke !== 'function') {
      return failure(CODES.RUNTIME_TOOL_MISSING, 'direct 通道不可用');
    }
    if (runCancelPending(resolved.runMeta)) return failure(CODES.CANCELLED, 'run 已取消');

    const runtime = runtimeOf(resolved.attempt.projectId, resolved.attempt.runId);
    runtime.activeCalls += 1;
    try {
      const result = await directRuntime.invoke({
        context: {
          projectId: resolved.attempt.projectId,
          runId: resolved.attempt.runId,
          turnId: resolved.attempt.turnId,
          attemptId: resolved.attempt.attemptId,
          subject: subjectOf(resolved.attempt.attemptId),
        },
        request: payload.request,
      });
      return result && typeof result === 'object' ? result : success(null);
    } catch (error) {
      return failure(CODES.TXN_ABORTED, (error && error.message) || 'direct 调用失败');
    } finally {
      runtime.activeCalls -= 1;
      settleCancellation(resolved.attempt.projectId, resolved.attempt.runId);
    }
  }

  /* ---------------------------------------------------------------- */
  /* 版本只读（read_file 的 subjectOverride）                           */
  /* ---------------------------------------------------------------- */

  function readVersionFile(payload, args) {
    const versionId = payload.versionId;
    if (typeof versionId !== 'string' || !VERSION_ID_PATTERN.test(versionId)) {
      return failure(CODES.VERSION_NOT_FOUND, 'versionId 非法或不存在');
    }
    const resolved = versionsMod.resolveVersionSource({ userDataDir, projectId: payload.projectId, versionId });
    if (!resolved.ok) return failure(CODES.VERSION_NOT_FOUND, '版本 source 不可用');
    const canonical = paths.assertCanonicalDir(resolved.sourceRoot, constants.CODES);
    if (!canonical.ok) return fromModuleFailure(canonical, CODES.VERSION_NOT_FOUND);
    const inside = paths.resolveInside(resolved.sourceRoot, args.path, constants.CODES, {
      maxLength: limits.maxPathLength,
    });
    if (!inside.ok) return fromModuleFailure(inside, CODES.PATH_INVALID);
    let stats;
    try {
      stats = fs.lstatSync(inside.target);
    } catch (error) {
      return failure(CODES.FILE_NOT_FOUND, '文件不存在');
    }
    if (stats.isSymbolicLink()) return failure(CODES.PATH_LINK, '文件不得是符号链接');
    if (!stats.isFile()) return failure(CODES.ARGUMENT_INVALID, '不是普通文件');
    const audited = paths.auditPath(resolved.sourceRoot, canonical.realDir, inside.target, constants.CODES);
    if (!audited.ok) return fromModuleFailure(audited, CODES.PATH_INVALID);

    let buffer;
    try {
      buffer = fs.readFileSync(inside.target);
    } catch (error) {
      return failure(CODES.IO_FAILED, '读取失败');
    }
    if (filesMod.isBinaryBuffer(buffer, args.path)) return failure(CODES.BINARY_FILE, '二进制文件不支持按文本读取');

    const offset = args.offset === undefined ? 0 : args.offset;
    if (!Number.isInteger(offset) || offset < 0) return failure(CODES.ARGUMENT_INVALID, 'offset 必须是非负整数');
    let limitBytes = args.limitBytes === undefined ? limits.readDefaultBytes : args.limitBytes;
    if (!Number.isInteger(limitBytes) || limitBytes <= 0) {
      return failure(CODES.ARGUMENT_INVALID, 'limitBytes 必须是正整数');
    }
    limitBytes = Math.min(limitBytes, limits.readMaxBytes);
    const start = Math.min(offset, buffer.length);
    let end = Math.min(buffer.length, start + limitBytes);
    while (end > start && end < buffer.length && (buffer[end] & 0xc0) === 0x80) end -= 1;
    const slice = buffer.subarray(start, end);
    return success({
      path: args.path,
      content: slice.toString('utf8'),
      encoding: 'utf8',
      bytes: slice.length,
      totalBytes: buffer.length,
      sha256: sha256OfBuffer(buffer),
      offset: start,
      nextOffset: start + slice.length,
      truncated: start + slice.length < buffer.length,
      subject: { kind: 'version', versionId },
    });
  }

  /* ---------------------------------------------------------------- */
  /* 工具执行器（direct/HTTP 共用的唯一实现）                           */
  /* ---------------------------------------------------------------- */

  function rejectUnknownKeys(value, allowed, label) {
    if (value === undefined || value === null) return null;
    if (!isPlainObject(value)) return failure(CODES.PAYLOAD_INVALID, label + ' 必须是对象');
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) {
        return failure(CODES.PAYLOAD_INVALID, label + ' 不接受字段：' + key);
      }
    }
    return null;
  }

  function toolGetContext(resolved) {
    const attempt = resolved.attempt;
    const checks = registry();
    let availableCheckIds = [];
    if (checks && typeof checks.listChecks === 'function') {
      try {
        availableCheckIds = checks.listChecks().map((item) => item.checkId).slice(0, 40);
      } catch (error) {
        availableCheckIds = [];
      }
    }
    const evidence = readCheckEvidence(attempt);
    return success({
      projectId: attempt.projectId,
      runId: attempt.runId,
      turnId: attempt.turnId,
      attemptId: attempt.attemptId,
      subject: subjectOf(attempt.attemptId),
      runState: resolved.runMeta.state || RUN_STATES.RUNNING,
      status: attemptStatusOf(attempt),
      targetPage: attempt.meta.targetPage || resolved.runMeta.targetPage || null,
      operation: attempt.meta.operation || resolved.runMeta.operation || null,
      base: {
        versionId: attempt.meta.baseVersionId || resolved.runMeta.baseVersionId || null,
        treeDigest: attempt.meta.baseTreeDigest || resolved.runMeta.baseTreeDigest || null,
      },
      attempt: {
        revision: Number.isInteger(attempt.revision) ? attempt.revision : 1,
        treeDigest: attempt.treeDigest,
        fileCount: Number.isInteger(attempt.fileCount) ? attempt.fileCount : 0,
        totalBytes: Number.isInteger(attempt.totalBytes) ? attempt.totalBytes : 0,
        immutable: attemptStatusOf(attempt) !== ATTEMPT_STATUSES.OPEN,
      },
      tools: MODEL_TOOL_NAMES.slice(),
      availableCheckIds,
      // X5：8 页枚举 + 每页 enabled/reasons 由 SourceFacts 与候选树派生（模型只看结果）。
      targetPages: targetPageEnumeration(attempt),
      targetPageEnumSource: 'scripts/agent-source-facts.cjs#PAGE_IDS/PAGE_CONTRACTS',
      verification: {
        checks: evidence.entries.map((entry) => ({
          checkId: entry.checkId,
          status: entry.status,
          subjectKind: entry.subjectKind,
          at: entry.at,
        })),
      },
    });
  }

  function toolListFiles(resolved, args) {
    const listed = filesMod.listFiles(resolved.attempt, { dir: args.dir === undefined ? '' : args.dir });
    if (!listed.ok) return fromModuleFailure(listed, CODES.IO_FAILED);
    const files = listed.files.slice(0, LIMITS_EXTRA.maxToolListFiles);
    return success({
      dir: listed.dir || '',
      files,
      fileCount: listed.fileCount,
      totalBytes: listed.totalBytes,
      truncated: Boolean(listed.truncated) || files.length < listed.files.length,
      subject: subjectOf(resolved.attempt.attemptId),
    }, { truncated: Boolean(listed.truncated) || files.length < listed.files.length });
  }

  function toolReadFile(resolved, args) {
    if (args.subjectOverride !== undefined) {
      const override = args.subjectOverride;
      if (!isPlainObject(override) || override.kind !== 'version') {
        return failure(CODES.PAYLOAD_INVALID, 'read_file 的 subjectOverride 只支持 {kind:"version",versionId}');
      }
      const extra = rejectUnknownKeys(override, ['kind', 'versionId'], 'subjectOverride');
      if (extra) return extra;
      return readVersionFile({ projectId: resolved.attempt.projectId, versionId: override.versionId }, args);
    }
    const read = filesMod.readFile(resolved.attempt, {
      path: args.path,
      ...(args.offset === undefined ? {} : { offset: args.offset }),
      ...(args.limitBytes === undefined ? {} : { limitBytes: args.limitBytes }),
    });
    if (!read.ok) return fromModuleFailure(read, CODES.FILE_NOT_FOUND);
    return success({
      path: read.path,
      content: read.content,
      encoding: read.encoding,
      bytes: read.bytes,
      totalBytes: read.totalBytes,
      sha256: read.sha256,
      offset: read.offset,
      nextOffset: read.nextOffset,
      lines: read.lines,
      truncated: read.truncated,
      subject: subjectOf(resolved.attempt.attemptId),
    }, { truncated: read.truncated });
  }

  function toolSearchFiles(resolved, args) {
    const searched = filesMod.searchFiles(resolved.attempt, {
      query: args.query,
      ...(args.mode === undefined ? {} : { mode: args.mode }),
      ...(args.caseSensitive === undefined ? {} : { caseSensitive: args.caseSensitive }),
      ...(args.maxResults === undefined ? {} : { maxResults: args.maxResults }),
    });
    if (!searched.ok) return fromModuleFailure(searched, CODES.PAYLOAD_INVALID);
    return success({
      query: searched.query,
      mode: searched.mode,
      matches: searched.matches,
      scannedFiles: searched.scannedFiles,
      truncated: searched.truncated,
      subject: subjectOf(resolved.attempt.attemptId),
    }, { truncated: searched.truncated });
  }

  /** 写入强制 subject = 当前 attempt：任何 version/root/attempt 覆盖都是 AGENT_PAYLOAD_INVALID。 */
  function writeChangesOf(args, op) {
    const changes = [];
    if (op === 'write') {
      if (!Array.isArray(args.changes) || args.changes.length === 0) {
        return failure(CODES.PAYLOAD_INVALID, 'write_files 需要非空 changes 数组');
      }
      for (const change of args.changes) {
        const extra = rejectUnknownKeys(change, ['path', 'content', 'expectedBaseSha256'], 'changes[]');
        if (extra) return extra;
        if (typeof change.path !== 'string' || typeof change.content !== 'string') {
          return failure(CODES.PAYLOAD_INVALID, 'changes[] 需要 path 与完整 content');
        }
        if (change.path === sourceBundle.BUNDLE_FILE) {
          return failure(CODES.PAYLOAD_INVALID, 'source-bundle.json 只能由平台派生，模型不得写入');
        }
        changes.push({
          op: 'write',
          path: change.path,
          content: change.content,
          ...(change.expectedBaseSha256 === undefined ? {} : { expectedBaseSha256: change.expectedBaseSha256 }),
        });
      }
      return { ok: true, changes };
    }
    if (!Array.isArray(args.paths) || args.paths.length === 0) {
      return failure(CODES.PAYLOAD_INVALID, 'delete_files 需要非空 paths 数组');
    }
    for (const entry of args.paths) {
      const extra = rejectUnknownKeys(entry, ['path', 'expectedBaseSha256'], 'paths[]');
      if (extra) return extra;
      if (typeof entry.path !== 'string') return failure(CODES.PAYLOAD_INVALID, 'paths[] 需要 path');
      if (entry.path === sourceBundle.BUNDLE_FILE) {
        return failure(CODES.PAYLOAD_INVALID, 'source-bundle.json 只能由平台派生，模型不得删除');
      }
      changes.push({
        op: 'delete',
        path: entry.path,
        ...(entry.expectedBaseSha256 === undefined ? {} : { expectedBaseSha256: entry.expectedBaseSha256 }),
      });
    }
    return { ok: true, changes };
  }

  function applyWriteTool(resolved, args, op) {
    const prepared = writeChangesOf(args, op);
    if (!prepared.ok) return prepared;
    const applied = transactionsMod.applyChanges(resolved.attempt, prepared.changes);
    if (!applied.ok) return fromModuleFailure(applied, CODES.TXN_ABORTED);
    return success({
      transactionId: applied.transactionId,
      revision: applied.revision,
      treeDigest: applied.treeDigest,
      fileCount: applied.fileCount,
      totalBytes: applied.totalBytes,
      files: (applied.diff && Array.isArray(applied.diff.files) ? applied.diff.files : []).map((item) => ({
        path: item.path,
        status: item.status,
        sha256: item.sha256,
      })),
      counts: applied.diff && applied.diff.counts ? applied.diff.counts : null,
      subject: subjectOf(resolved.attempt.attemptId),
    });
  }

  function toolGetDiff(resolved) {
    const attempt = resolved.attempt;
    const baseVersionId = attempt.meta.baseVersionId || resolved.runMeta.baseVersionId || null;
    if (!baseVersionId) return failure(CODES.VERSION_NOT_FOUND, '该 attempt 没有 base 版本');
    const baseSource = versionsMod.resolveVersionSource({
      userDataDir,
      projectId: attempt.projectId,
      versionId: baseVersionId,
    });
    if (!baseSource.ok) return failure(CODES.VERSION_NOT_FOUND, 'base 版本 source 不可用');
    const baseManifest = manifestMod.buildManifest(baseSource.sourceRoot, { limits });
    if (!baseManifest.ok) return fromModuleFailure(baseManifest, CODES.WORKSPACE_INVALID);
    const currentManifest = manifestMod.buildManifest(attempt.candidateDir, { limits });
    if (!currentManifest.ok) return fromModuleFailure(currentManifest, CODES.WORKSPACE_INVALID);
    const diff = manifestMod.diffManifests(baseManifest.manifest, currentManifest.manifest, {
      maxFiles: limits.diffMaxFiles,
      maxBytes: limits.diffMaxBytes,
    });
    if (!diff.ok) return fromModuleFailure(diff, CODES.WORKSPACE_INVALID);
    return success({
      baseVersionId,
      baseTreeDigest: baseManifest.manifest.treeDigest,
      treeDigest: currentManifest.manifest.treeDigest,
      files: diff.files.map((item) => ({ path: item.path, status: item.status, sha256: item.sha256, bytes: item.bytes })),
      counts: diff.counts,
      subject: subjectOf(attempt.attemptId),
    }, { truncated: diff.truncated });
  }

  async function toolRunCheck(resolved, args) {
    const checks = registry();
    if (!checks || typeof checks.runCheck !== 'function') {
      return failure(CODES.RUNTIME_TOOL_MISSING, '检查注册表不可用');
    }
    if (typeof args.checkId !== 'string' || args.checkId === '') {
      return failure(CODES.PAYLOAD_INVALID, 'run_check 需要 checkId');
    }
    const params = args.params === undefined ? undefined : args.params;
    if (params !== undefined) {
      if (!isPlainObject(params)) return failure(CODES.PAYLOAD_INVALID, 'params 必须是对象');
      for (const key of Object.keys(params)) {
        if (FORBIDDEN_CHECK_PARAM_KEYS.includes(key)) {
          return failure(CODES.PAYLOAD_INVALID, 'params 不接受平台字段：' + key);
        }
      }
    }
    // rev15 §14.4：checkId → subject 由平台表决定，root/导出根只由平台填。
    // F2：注册表缺 definitions / 缺该 checkId 的绑定 → **先拒后跑**（runner 调用次数必须为 0）。
    const checksView = registry();
    const definitions = checksView && isPlainObject(checksView.definitions) ? checksView.definitions : null;
    if (!definitions) {
      return failure(CODES.CHECK_UNKNOWN, '检查注册表缺少 definitions（无法确认检查主体），拒绝执行');
    }
    const definition = definitions[args.checkId];
    if (!definition || typeof definition.subject !== 'string') {
      return failure(CODES.CHECK_UNKNOWN, '未知 checkId 或注册表没有该检查的主体绑定：' + args.checkId);
    }
    if (!['attempt', 'export', 'repo'].includes(definition.subject)) {
      return failure(CODES.CHECK_UNKNOWN, '检查主体声明非法：' + String(definition.subject));
    }
    const subject = definition.subject;

    let attempt = resolved.attempt;
    let exportRoot = null;
    let exportedInfo = null;
    // rev15 §14.5 顺序：write → **deriveSourceBundle** → source.check → composer.dry-run → ...
    // 派生只由平台做，且对所有 attempt 主体检查都是幂等前置（bundle 已是最新时零改动）。
    if (subject === 'attempt' || subject === 'export') {
      const derived = deriveAttemptBundle(attempt, resolved.runMeta);
      if (!derived.ok) return derived;
      if (derived.changed) {
        const refreshed = refreshAttempt(attempt);
        if (refreshed && refreshed.ok === false) return refreshed;
        emit({
          projectId: attempt.projectId,
          runId: attempt.runId,
          turnId: attempt.turnId,
          attemptId: attempt.attemptId,
          phase: 'check',
          stage: 'bundle',
          status: 'succeeded',
          message: 'source-bundle 已派生（files=' + derived.fileCount + '，deleted=' + (derived.deletedCount || 0) + '）',
        });
      }
    }
    // 导出树级检查：root 只能来自本 attempt 的 dry-run 证据。
    if (subject === 'export') {
      const exported = exportedRootOf(attempt);
      if (!exported.ok) return exported;
      exportedInfo = exported;
      exportRoot = exported.root;
    }

    const result = await checks.runCheck({
      checkId: args.checkId,
      params,
      projectId: attempt.projectId,
      attemptId: attempt.attemptId,
      // 平台填 subject/root；模型给 root/exportRoot 会在上面被 FORBIDDEN_CHECK_PARAM_KEYS 拒掉。
      subject: subjectOf(attempt.attemptId),
      ...(subject === 'repo' ? {} : { subjectKind: subject }),
      ...(subject === 'attempt' ? { root: attempt.candidateDir } : {}),
      ...(subject === 'attempt' && args.checkId === 'composer.dry-run' ? { exportParentDir: attempt.verificationDir } : {}),
      ...(subject === 'export' ? { exportRoot } : {}),
    });
    if (!result || result.ok !== true) {
      return failure((result && result.code) || CODES.CHECK_UNKNOWN, (result && result.message) || '检查执行失败');
    }
    // 取消后到达的结果：不落证据、不发进度，直接丢弃。
    if (runCancelledNow(attempt)) {
      return failure(CODES.CANCELLED, 'run 已取消，检查结果已丢弃');
    }
    const subjectKind = ['attempt', 'export', 'repo'].includes(result.subjectKind) ? result.subjectKind : 'version';
    const exportRelative = typeof result.exportedRoot === 'string'
      ? relativeToAttempt(attempt, result.exportedRoot)
      : (exportedInfo ? exportedInfo.relative : null);
    const exportTreeDigest = typeof result.exportTreeDigest === 'string'
      ? result.exportTreeDigest
      : (exportedInfo && typeof exportedInfo.exportTreeDigest === 'string' ? exportedInfo.exportTreeDigest : null);
    const record = {
      checkId: result.checkId,
      status: result.status,
      durationMs: Number.isInteger(result.durationMs) ? result.durationMs : 0,
      treeDigest: attempt.treeDigest,
      subjectKind,
      attemptId: attempt.attemptId,
      at: nowIso(),
      issues: Array.isArray(result.issues) ? result.issues.slice(0, LIMITS_EXTRA.maxIssues) : [],
      ...(exportTreeDigest ? { exportTreeDigest } : {}),
      ...(exportRelative ? { exportRelative } : {}),
      ...(typeof result.evidenceRelative === 'string' ? { evidenceRelative: result.evidenceRelative } : {}),
    };
    const written = writeEvidenceFile(attempt, 'checks/' + evidenceFileName(result.checkId), record);
    if (!written.ok) return written;
    emit({
      projectId: attempt.projectId,
      runId: attempt.runId,
      turnId: attempt.turnId,
      attemptId: attempt.attemptId,
      phase: 'check',
      stage: args.checkId === 'mini.check' ? 'mini-check'
        : (args.checkId === 'output.consistency' ? 'consistency' : 'validate'),
      status: result.status === 'FAIL' ? 'failed' : 'succeeded',
      message: result.checkId + ' ' + result.status,
    });
    return success({
      checkId: result.checkId,
      status: result.status,
      durationMs: record.durationMs,
      subjectKind,
      treeDigest: attempt.treeDigest,
      attemptId: attempt.attemptId,
      at: record.at,
      ...(record.exportTreeDigest ? { exportTreeDigest: record.exportTreeDigest } : {}),
      ...(exportRelative ? { exportRelative } : {}),
      issues: record.issues,
      evidenceRelative: written.relative,
      ...(record.evidenceRelative ? { artifactRelative: record.evidenceRelative } : {}),
    });
  }

  async function toolVerifyWechat(resolved, args) {
    const checks = registry();
    if (!checks || typeof checks.verifyWechat !== 'function') {
      return failure(CODES.RUNTIME_TOOL_MISSING, '微信验证器不可用');
    }
    // rev15 §14.4：wechat.verify 的 subject 是**派生导出树**，不是仓库镜像、也不是 attempt 源码。
    const exported = exportedRootOf(resolved.attempt);
    if (!exported.ok) return exported;
    const result = await checks.verifyWechat({
      projectId: resolved.attempt.projectId,
      attemptId: resolved.attempt.attemptId,
      exportRoot: exported.root,
      ...(args.appId === undefined ? {} : { appId: args.appId }),
      ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
    });
    if (!result || result.ok !== true) {
      return failure((result && result.code) || CODES.RUNTIME_TOOL_MISSING, (result && result.message) || '微信验证不可用');
    }
    if (runCancelledNow(resolved.attempt)) {
      return failure(CODES.CANCELLED, 'run 已取消，微信验证结果已丢弃');
    }
    const subjectKind = ['attempt', 'export', 'repo'].includes(result.subjectKind) ? result.subjectKind : 'version';
    const record = {
      checkId: 'wechat.verify',
      status: result.status,
      durationMs: Number.isInteger(result.durationMs) ? result.durationMs : 0,
      treeDigest: resolved.attempt.treeDigest,
      subjectKind,
      attemptId: resolved.attempt.attemptId,
      at: nowIso(),
      issues: Array.isArray(result.issues) ? result.issues.slice(0, LIMITS_EXTRA.maxIssues) : [],
      pages: Array.isArray(result.pages) ? result.pages.length : 0,
      interactions: Array.isArray(result.interactions) ? result.interactions.length : 0,
      screenshots: Array.isArray(result.screenshots) ? result.screenshots.length : 0,
      exportRelative: exported.relative,
      ...(exported.exportTreeDigest ? { exportTreeDigest: exported.exportTreeDigest } : {}),
      ...(typeof result.evidenceRelative === 'string' ? { evidenceRelative: result.evidenceRelative } : {}),
    };
    const written = writeEvidenceFile(resolved.attempt, 'checks/' + evidenceFileName('wechat.verify'), record);
    if (!written.ok) return written;
    emit({
      projectId: resolved.attempt.projectId,
      runId: resolved.attempt.runId,
      turnId: resolved.attempt.turnId,
      attemptId: resolved.attempt.attemptId,
      phase: 'check',
      stage: 'wechat',
      status: result.status === 'FAIL' ? 'failed' : 'succeeded',
      message: 'wechat.verify ' + result.status,
    });
    return success({
      status: result.status,
      durationMs: record.durationMs,
      subjectKind,
      pages: record.pages,
      interactions: record.interactions,
      screenshots: record.screenshots,
      issues: record.issues,
      evidenceRelative: written.relative,
    });
  }

  function toolReadVerification(resolved, args) {
    const source = args.source === undefined ? 'attempt' : args.source;
    if (source !== 'attempt' && source !== 'version') {
      return failure(CODES.PAYLOAD_INVALID, 'source 只支持 "attempt" 或 "version"');
    }
    if (source === 'version') {
      const versionId = resolved.attempt.meta.baseVersionId || resolved.runMeta.baseVersionId || null;
      if (!versionId) return failure(CODES.VERSION_NOT_FOUND, '没有可读的版本证据');
      const evidenceDir = path.join(resolved.ws.versionsDir, versionId, LAYOUT.evidenceDir);
      const files = listRelativeEvidence(evidenceDir);
      const prefix = 'versions/' + versionId + '/' + LAYOUT.evidenceDir;
      return success({
        source: 'version',
        versionId,
        files: files.map((entry) => ({ ref: prefix + '/' + entry.relative, bytes: entry.bytes })),
        checks: [],
      }, { truncated: files.length >= LIMITS_EXTRA.maxEvidenceFiles });
    }
    const evidence = readCheckEvidence(resolved.attempt);
    const submission = readSubmissionEvidence(resolved.attempt);
    const all = listRelativeEvidence(resolved.attempt.verificationDir);
    return success({
      source: 'attempt',
      files: all.map((entry) => ({ ref: entry.relative, bytes: entry.bytes })),
      checks: evidence.entries.map((entry) => ({
        checkId: entry.checkId,
        status: entry.status,
        subjectKind: entry.subjectKind,
        treeDigest: entry.treeDigest,
        at: entry.at,
        issues: entry.issues,
      })),
      submission: submission
        ? {
          candidateId: submission.candidateId || null,
          revision: submission.revision || null,
          treeDigest: submission.treeDigest || null,
          partial: Boolean(submission.partial),
          at: submission.at || null,
          summary: typeof submission.summary === 'string' ? submission.summary : null,
        }
        : null,
    }, { truncated: all.length >= LIMITS_EXTRA.maxEvidenceFiles });
  }

  /** 列证据目录（只相对引用 + 字节数，不读内容、不返回绝对路径）。 */
  function listRelativeEvidence(dir) {
    const out = [];
    const walk = (current, prefix) => {
      if (out.length >= LIMITS_EXTRA.maxEvidenceFiles) return;
      let entries;
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch (error) {
        return;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        if (out.length >= LIMITS_EXTRA.maxEvidenceFiles) return;
        if (entry.isSymbolicLink()) continue;
        const relative = prefix ? prefix + '/' + entry.name : entry.name;
        if (entry.isDirectory()) {
          walk(path.join(current, entry.name), relative);
          continue;
        }
        if (!entry.isFile()) continue;
        let bytes = 0;
        try {
          bytes = fs.lstatSync(path.join(current, entry.name)).size;
        } catch (error) {
          continue;
        }
        out.push({ relative, bytes });
      }
    };
    walk(dir, '');
    return out;
  }

  async function invokeTool(input) {
    const startedAt = clock();
    const payload = isPlainObject(input) ? input : {};
    const meta = {
      projectId: payload.projectId,
      runId: payload.runId,
      turnId: payload.turnId,
      attemptId: payload.attemptId,
      startedAt,
    };
    const tool = payload.tool;

    // 0) 工具面：平台专用名 + 未知名一律 AGENT_TOOL_NOT_ALLOWED（先于任何读写）。
    if (typeof tool !== 'string' || !MODEL_TOOL_SET.has(tool)) {
      const known = typeof tool === 'string' && PLATFORM_ONLY_TOOL_SET.has(tool);
      return envelope(
        failure(CODES.TOOL_NOT_ALLOWED, known ? '平台专用工具不得由模型调用：' + tool : '未知工具：' + String(tool)),
        meta,
      );
    }

    const extraArgs = rejectUnknownKeys(payload.args === undefined ? {} : payload.args, TOOL_ARG_KEYS[tool], 'args');
    const resolved = resolveAttempt(payload);
    if (!resolved.ok) return envelope(resolved, meta);
    if (extraArgs) return envelope(extraArgs, meta);

    const attempt = resolved.attempt;
    const args = isPlainObject(payload.args) ? payload.args : {};

    // 1) 取消后一律拒绝（零落盘、不调 direct/注册表）。
    if (runCancelPending(resolved.runMeta)) {
      return envelope(failure(CODES.CANCELLED, 'run 已取消，拒绝迟到工具调用'), meta);
    }
    if (attemptStatusOf(attempt) !== ATTEMPT_STATUSES.OPEN && WRITE_TOOLS.has(tool)) {
      return envelope(failure(CODES.ATTEMPT_IMMUTABLE, '该 attempt 已提交/已采用，只读'), meta);
    }
    const declared = payload.subject || payload.subjectOverride;
    if (declared !== undefined && WRITE_TOOLS.has(tool)) {
      return envelope(failure(CODES.PAYLOAD_INVALID, '写入不接受 subject 覆盖（只能写当前 attempt）'), meta);
    }

    const runtime = runtimeOf(attempt.projectId, attempt.runId);
    const isAsync = ASYNC_TOOLS.has(tool);
    if (isAsync) runtime.activeCalls += 1;

    let result;
    try {
      switch (tool) {
        case 'get_context':
          result = toolGetContext(resolved);
          break;
        case 'list_files':
          result = toolListFiles(resolved, args);
          break;
        case 'read_file':
          result = toolReadFile(resolved, args);
          break;
        case 'search_files':
          result = toolSearchFiles(resolved, args);
          break;
        case 'write_files':
          result = applyWriteTool(resolved, args, 'write');
          break;
        case 'delete_files':
          result = applyWriteTool(resolved, args, 'delete');
          break;
        case 'get_diff':
          result = toolGetDiff(resolved);
          break;
        case 'run_check':
          result = await toolRunCheck(resolved, args);
          break;
        case 'verify_wechat':
          result = await toolVerifyWechat(resolved, args);
          break;
        case 'read_verification':
          result = toolReadVerification(resolved, args);
          break;
        case 'submit_candidate':
          result = submitAttempt({
            projectId: attempt.projectId,
            runId: attempt.runId,
            turnId: attempt.turnId,
            attemptId: attempt.attemptId,
            targetPage: args.targetPage,
            summary: args.summary,
          });
          break;
        default:
          result = failure(CODES.TOOL_NOT_ALLOWED, '未知工具：' + String(tool));
      }
    } catch (error) {
      result = failure(CODES.TXN_ABORTED, (error && error.message) || '工具执行异常');
    } finally {
      if (isAsync) {
        runtime.activeCalls -= 1;
        settleCancellation(attempt.projectId, attempt.runId);
      }
    }

    // 2) 迟到结果（期间被取消）：不落任何东西，直接 AGENT_CANCELLED。
    if (result && result.ok === true && runtime.activeCalls === 0) {
      const fresh = readRun(attempt.projectId, attempt.runId);
      if (fresh.ok && runCancelPending(fresh.runMeta)) {
        return envelope(failure(CODES.CANCELLED, 'run 已取消，结果已丢弃'), meta);
      }
    }

    if (WRITE_TOOLS.has(tool) && result && result.ok === true) {
      emit({
        projectId: attempt.projectId,
        runId: attempt.runId,
        turnId: attempt.turnId,
        attemptId: attempt.attemptId,
        phase: 'tool',
        stage: 'write',
        status: 'succeeded',
        message: tool + ' revision ' + result.data.revision,
      });
    }

    return envelope(result, meta);
  }

  /* ---------------------------------------------------------------- */
  /* submitAttempt / adoptAttempt                                      */
  /* ---------------------------------------------------------------- */

  function submitAttempt(input) {
    const payload = isPlainObject(input) ? input : {};
    const resolved = resolveAttempt(payload);
    if (!resolved.ok) return resolved;
    const attempt = resolved.attempt;
    if (runCancelPending(resolved.runMeta)) return failure(CODES.CANCELLED, 'run 已取消，不能提交');

    const status = attemptStatusOf(attempt);
    if (status === ATTEMPT_STATUSES.SUBMITTED) return failure(CODES.RUN_ALREADY_SUBMITTED, '该 attempt 已提交');
    if (status === ATTEMPT_STATUSES.ADOPTED) return failure(CODES.ATTEMPT_IMMUTABLE, '该 attempt 已采用，不可再提交');

    const runTargetPage = resolved.runMeta.targetPage || null;
    const attemptTargetPage = attempt.meta.targetPage || null;
    const targetPage = payload.targetPage === undefined ? (attemptTargetPage || runTargetPage) : payload.targetPage;
    // X5：targetPage 只认 8 页枚举（SourceFacts 派生），不再复用 v1 的 home/menu 常量，也不接受自由字符串。
    if (!sourceBundle.isKnownTargetPage(targetPage)) {
      return failure(CODES.TARGET_PAGE_UNSUPPORTED, 'targetPage 不在 8 页枚举内（'
        + sourceBundle.PAGE_IDS.join('/') + '）');
    }
    if (runTargetPage && targetPage !== runTargetPage) {
      return failure(CODES.TARGET_PAGE_UNSUPPORTED, 'targetPage 与本次 run 的目标页不一致');
    }
    const enumeration = targetPageEnumeration(attempt);
    const pageEntry = enumeration.find((entry) => entry.id === targetPage) || null;
    if (!pageEntry || pageEntry.enabled !== true) {
      return failure(CODES.TARGET_PAGE_UNSUPPORTED, 'targetPage 在当前候选中不可用：'
        + (pageEntry && pageEntry.reasons.length > 0 ? pageEntry.reasons.join('；') : '页面不在枚举内'));
    }
    let summary = null;
    if (payload.summary !== undefined) {
      if (typeof payload.summary !== 'string' || payload.summary.length > LIMITS_EXTRA.maxSummaryChars) {
        return failure(CODES.PAYLOAD_INVALID, 'summary 必须是不超过 ' + LIMITS_EXTRA.maxSummaryChars + ' 字的字符串');
      }
      summary = payload.summary;
    }

    // F3（rev15 §14.5，合同 revision 2）：submit **不再派生** source-bundle。
    // 派生会改 treeDigest，进而把刚刚通过的检查证据作废；唯一合法顺序是
    // 写(可多次) → 派生 → source.check → composer.dry-run → mini/output → submit → adopt，
    // 派生只发生在检查阶段（run_check 的 attempt/export 主体前）。
    const gate = evaluateStaticGate(attempt);
    if (!gate.ok) return gate;

    const candidateId = attempt.attemptId;
    const submittedAt = nowIso();
    const patch = manifestMod.writeAttemptMeta(attempt, {
      status: ATTEMPT_STATUSES.SUBMITTED,
      submittedAt,
      candidateId,
      targetPage,
    });
    if (!patch.ok) return fromModuleFailure(patch, CODES.TXN_ABORTED);
    attempt.meta = patch.meta;

    const evidence = {
      candidateId,
      revision: attempt.revision,
      treeDigest: attempt.treeDigest,
      targetPage,
      partial: gate.partial,
      checks: gate.checks,
      exportRelative: gate.exportRelative || null,
      exportTreeDigest: gate.exportTreeDigest || null,
      at: submittedAt,
      ...(summary ? { summary } : {}),
    };
    const written = writeEvidenceFile(attempt, 'submission.json', evidence);
    if (!written.ok) return written;

    writeRun(resolved.ws, attempt.runId, { state: RUN_STATES.SUBMITTED });
    emit({
      projectId: attempt.projectId,
      runId: attempt.runId,
      turnId: attempt.turnId,
      attemptId: attempt.attemptId,
      phase: 'submit',
      stage: 'submit',
      status: 'succeeded',
      message: 'candidate 已提交' + (gate.partial ? '（partial）' : ''),
    });

    // F1：成功返回体固定含 candidateId/revision/treeDigest/exportRelative/exportTreeDigest/targetPage/status。
    return {
      ok: true,
      candidateId,
      revision: attempt.revision,
      treeDigest: attempt.treeDigest,
      exportRelative: evidence.exportRelative,
      exportTreeDigest: evidence.exportTreeDigest,
      targetPage,
      status: 'submitted',
      partial: gate.partial,
      subject: subjectOf(attempt.attemptId),
    };
  }

  function adoptAttempt(input) {
    const payload = isPlainObject(input) ? input : {};
    const resolved = resolveAttempt(payload);
    if (!resolved.ok) return resolved;
    const attempt = resolved.attempt;
    const status = attemptStatusOf(attempt);
    // rev15 §14.12-Q1：attempt.state ≠ submitted（从未提交 / 已取消 / 已被取代 / 已采用）
    // 一律 AGENT_ADOPTION_FAILED + issue code NOT_SUBMITTED，不与 EVIDENCE_STALE / PARTIAL_CONFIRM_REQUIRED 顶替。
    if (status !== ATTEMPT_STATUSES.SUBMITTED) {
      return failure(CODES.ADOPTION_FAILED, '只有已提交（submitted）的候选才能采用（当前 ' + status + '）', [
        {
          code: 'NOT_SUBMITTED',
          severity: 'high',
          message: 'attempt 当前状态为 ' + status + '，不是 submitted',
          source: 'coordinator',
        },
      ]);
    }
    const submission = readSubmissionEvidence(attempt);
    if (!submission) return failure(CODES.VERIFICATION_MISSING, '缺少提交证据（verification/submission.json）');
    // F4：先判新鲜度，再判 partial —— 陈旧证据必须报 AGENT_EVIDENCE_STALE（rerun-checks），
    // 不能被“先要 partialConfirmed”盖过去，也不能自动补派生。
    if (submission.treeDigest !== attempt.treeDigest) {
      return staleEvidenceFailure(['提交证据的 treeDigest 与当前候选不一致']);
    }
    // X7：导出树证据绑定 —— 提交时的 exportTreeDigest 必须仍等于当前 dry-run 证据，
    // 否则说明提交后候选/导出被改过，绝不允许“拿旧导出树的验证结果采用新候选”。
    // F-T5-02（rev15 §14.13-1）：缺失/非字符串的 exportTreeDigest 一律按陈旧处理，不得跳过校验。
    const submittedExportTreeDigest = typeof submission.exportTreeDigest === 'string'
      ? submission.exportTreeDigest
      : null;
    if (!submittedExportTreeDigest) {
      return staleEvidenceFailure(['提交证据缺少 exportTreeDigest（旧格式/伪造证据），请重跑 composer.dry-run 并重新提交']);
    }
    const exportEntry = evidenceIndex(attempt).get('composer.dry-run');
    if (!exportEntry || exportEntry.exportTreeDigest !== submittedExportTreeDigest) {
      return staleEvidenceFailure(['导出树证据已变化（exportTreeDigest 与提交时不一致），请重跑 composer.dry-run 并重新提交']);
    }
    if (exportEntry.treeDigest !== attempt.treeDigest) {
      return staleEvidenceFailure(['导出树证据绑定的候选已变化，请重跑 check 并重新提交']);
    }
    // partial/runtime 只能由当前静态与运行时证据派生，不能信任 submission.json 中可被改写的布尔值。
    const gate = evaluateStaticGate(attempt);
    if (!gate.ok) return gate;
    const runtimeEntry = evidenceIndex(attempt).get('wechat.verify');
    const runtimeStatus = runtimeEntry && ['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN'].includes(runtimeEntry.status)
      ? runtimeEntry.status
      : 'NOT_RUN';
    if (runtimeStatus === 'FAIL') {
      return failure(CODES.ADOPTION_FAILED, '微信运行时验证失败，不能采用该候选');
    }
    const partial = gate.partial || runtimeStatus !== 'PASS';
    if (partial && payload.partialConfirmed !== true) {
      const partialFailure = failure(CODES.PARTIAL_CONFIRM_REQUIRED, '运行时证据为 BLOCKED/NOT_RUN，需要显式 partialConfirmed:true');
      partialFailure.nextAction = NEXT_ACTIONS.CONFIRM_PARTIAL;
      return partialFailure;
    }

    const runTargetPage = resolved.runMeta.targetPage || null;
    const targetPage = payload.targetPage === undefined
      ? (attempt.meta.targetPage || runTargetPage)
      : payload.targetPage;
    if (typeof targetPage !== 'string' || targetPage === '') {
      return failure(CODES.TARGET_PAGE_UNSUPPORTED, 'adopt 需要 targetPage');
    }

    const adopted = versionsMod.adoptAttempt({
      userDataDir,
      projectId: attempt.projectId,
      runId: attempt.runId,
      turnId: attempt.turnId,
      attempt: attempt.attempt,
      verification: {
        static: 'pass',
        runtime: runtimeStatus,
        checkedAt: typeof submission.at === 'string' ? submission.at : null,
      },
      evidence: {
        checks: Array.isArray(submission.checks) ? submission.checks : [],
        dryRunRelative: typeof submission.exportRelative === 'string' ? submission.exportRelative : null,
        runtimeRelative: (() => {
          const runtime = evidenceIndex(attempt).get('wechat.verify');
          return runtime && typeof runtime.evidenceRelative === 'string' ? runtime.evidenceRelative : null;
        })(),
        exportTreeDigest: typeof submission.exportTreeDigest === 'string' ? submission.exportTreeDigest : null,
      },
    });
    if (!adopted.ok) return fromModuleFailure(adopted, CODES.ADOPTION_FAILED);

    const patch = manifestMod.writeAttemptMeta(attempt, {
      status: ATTEMPT_STATUSES.ADOPTED,
      adoptedVersionId: adopted.versionId,
      adoptedAt: nowIso(),
    });
    if (!patch.ok) return fromModuleFailure(patch, CODES.ADOPTION_FAILED);
    attempt.meta = patch.meta;
    writeRun(resolved.ws, attempt.runId, { state: RUN_STATES.ADOPTED });

    emit({
      projectId: attempt.projectId,
      runId: attempt.runId,
      turnId: attempt.turnId,
      attemptId: attempt.attemptId,
      phase: 'adopt',
      stage: 'adopt',
      status: 'succeeded',
      message: '已采用为 ' + adopted.versionId,
    });

    return {
      ok: true,
      currentVersionId: adopted.currentVersionId,
      previousVersionId: adopted.previousVersionId,
      adoptedVersionId: adopted.versionId,
      treeDigest: adopted.treeDigest,
      adoption: adopted.version && adopted.version.adoption ? adopted.version.adoption : null,
      targetPage,
    };
  }

  return {
    // §14.2 冻结签名（形状不改）
    startRun,
    getRun,
    invokeTool,
    getAttemptState,
    cancelRun,
    submitAttempt,
    adoptAttempt,
    // E0-R1 内部接线辅助（不属于冻结 8 签名；见报告“偏差”）
    assertRunActive,
    invokeDirect,
    // 只读诊断（不含目录/绝对路径）
    toolCatalog: () => ({
      modelTools: MODEL_TOOL_NAMES.slice(),
      platformOnlyTools: PLATFORM_ONLY_TOOL_NAMES.slice(),
    }),
    limits: { ...limits },
  };
}

module.exports = {
  CODES,
  MODEL_TOOL_NAMES,
  PLATFORM_ONLY_TOOL_NAMES,
  RUN_STATES,
  ATTEMPT_STATUSES,
  PROGRESS_STAGES,
  LIMITS,
  createRunCoordinator,
};
