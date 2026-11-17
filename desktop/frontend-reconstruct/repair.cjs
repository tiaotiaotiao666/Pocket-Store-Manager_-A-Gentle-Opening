'use strict';

/**
 * P3 受控修复编排（本地侧）。
 *
 * 边界（与 `docs/frontend-reconstruct-contract.md` §9.2 / §10 同源）：
 * - 最多 **2 轮**，第 3 轮一律 `REPAIR_LIMIT_EXCEEDED`；
 * - 只发送**结构化 issues**（`{path, code}`，1–8 条）+ 有界 `previousDraft`；
 * - issues 的 path 必须是 DSL 路径（`$.pages[0].nodes[1].events.tap`），code 必须在白名单里；
 * - 不发送日志、堆栈、输出目录、绝对路径、源码、图片或任意命令；
 * - previousDraft 先过 P2 schema 校验再发送，超过 32 KiB 直接拒绝；
 * - 修复失败**不采用**任何版本：`adoption:'none'` + 原样返回 `keptDraft`（= 进入本轮前的版本）。
 *   成功时 `adoption:'candidate'` 只表示“可以进入采用流程”，真正的采用由 P4/P5 的
 *   `adoptCandidate` 决定（本模块永远不写项目快照）。
 *
 * 传输层由调用方注入（P4 的 IPC/service 负责真正请求服务端），本模块不建网络连接，
 * 也不执行任何命令。服务端语义见 `server/src/agent/frontend-reconstruct/tools.ts`
 * 的 `repair_frontend_draft`：它只接受本次门禁产生的 issues + 路径补丁，返回修复后的完整 Draft。
 */

const { validateDraft } = require('./schema.cjs');
const { draftDigest } = require('./render.cjs');

/** 与服务端 `FRONTEND_REPAIR_ISSUE_CODES` / 契约文档同源的白名单（测试会读 service 源码对齐）。 */
const REPAIR_ISSUE_CODES = Object.freeze([
  'DRAFT_SCHEMA_INVALID',
  'DRAFT_UNKNOWN_COMPONENT',
  'DRAFT_UNKNOWN_EVENT',
  'DRAFT_UNKNOWN_DATA_PATH',
  'DRAFT_STYLE_INVALID',
  'DRAFT_PAGE_JSON_INVALID',
  'SLOT_ANCHOR_MISSING',
  'DRY_RUN_FAILED',
  'MINI_CHECK_FAILED',
  'CONSISTENCY_FAILED',
]);

const CONTRACT_VERSION = 'frontend-repair.v1';
const MAX_REPAIR_ROUNDS = 2;
const MAX_ISSUES = 8;
const MAX_PREVIOUS_DRAFT_BYTES = 32 * 1024;
const DSL_ISSUE_PATH_PATTERN = /^\$(?:\.[A-Za-z][A-Za-z0-9]*|\[\d{1,3}\]){1,12}$/;
const RUN_ID_PATTERN = /^frun-[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/;
const FORBIDDEN_PAYLOAD_PATTERNS = Object.freeze([
  { code: 'REPAIR_PAYLOAD_UNSAFE', pattern: /[A-Za-z]:[\\/]/ },
  { code: 'REPAIR_PAYLOAD_UNSAFE', pattern: /\\\\/ },
  { code: 'REPAIR_PAYLOAD_UNSAFE', pattern: /\bfile:\/\//i },
  { code: 'REPAIR_PAYLOAD_UNSAFE', pattern: /\bhttps?:\/\//i },
]);

const CODES = Object.freeze({
  OK: 'REPAIR_OK',
  NO_REPAIR_NEEDED: 'DRY_RUN_OK',
  NOT_APPLICABLE: 'REPAIR_NOT_APPLICABLE',
  ISSUES_INVALID: 'REPAIR_ISSUES_INVALID',
  DRAFT_INVALID: 'REPAIR_DRAFT_INVALID',
  PAYLOAD_UNSAFE: 'REPAIR_PAYLOAD_UNSAFE',
  LIMIT_INVALID: 'REPAIR_LIMIT_INVALID',
  LIMIT_EXCEEDED: 'REPAIR_LIMIT_EXCEEDED',
  TRANSPORT_FAILED: 'REPAIR_TRANSPORT_FAILED',
  RESPONSE_INVALID: 'REPAIR_RESPONSE_INVALID',
  DRY_RUN_FAILED: 'REPAIR_DRY_RUN_FAILED',
  CANCELLED: 'REPAIR_CANCELLED',
  REJECTED: 'REPAIR_REJECTED',
});

function truncate(value, limit) {
  const text = String(value === undefined || value === null ? '' : value);
  return text.length <= limit ? text : text.slice(0, limit) + '…';
}

function boundedDetail(error) {
  if (!error) return 'UNKNOWN';
  // 异常文本可能带本机绝对路径（传输层/文件系统）：截断前先脱敏，避免回传到服务端或日志。
  return truncate(
    String(error.code || error.message || error)
      .replace(/[A-Za-z]:[\\/][^\s，；,）)]*/g, '<local-path>')
      .replace(/\\\\[^\s，；,）)]+/g, '<local-path>'),
    160,
  );
}

function byteLength(text) {
  return Buffer.byteLength(String(text), 'utf8');
}

function isCancelled(signal) {
  if (!signal) return false;
  if (typeof signal.cancelled === 'boolean') return signal.cancelled;
  if (typeof signal.aborted === 'boolean') return signal.aborted;
  return false;
}

/**
 * 从 dry-run 结果里抽取**最小可修复** issues（只保留 path+code）。
 * 不可定位到 DSL path 的问题会被丢弃 —— 本地门禁损坏/基础资产问题不是模型能修的。
 */
function collectRepairIssues(result) {
  const raw = result && Array.isArray(result.issues) ? result.issues : [];
  const kept = [];
  const seen = new Set();
  let dropped = 0;
  for (const issue of raw) {
    if (!issue || typeof issue !== 'object') {
      dropped += 1;
      continue;
    }
    const code = issue.code;
    const issuePath = issue.path;
    if (typeof code !== 'string' || !REPAIR_ISSUE_CODES.includes(code)) {
      dropped += 1;
      continue;
    }
    if (typeof issuePath !== 'string' || !DSL_ISSUE_PATH_PATTERN.test(issuePath)) {
      dropped += 1;
      continue;
    }
    const key = code + '@' + issuePath;
    if (seen.has(key)) {
      dropped += 1;
      continue;
    }
    seen.add(key);
    kept.push({ path: issuePath, code });
  }
  kept.sort((a, b) => (a.code === b.code ? a.path.localeCompare(b.path) : a.code.localeCompare(b.code)));
  const bounded = kept.slice(0, MAX_ISSUES);
  dropped += kept.length - bounded.length;
  return {
    ok: bounded.length > 0,
    issues: bounded,
    dropped,
    code: bounded.length > 0 ? null : CODES.NOT_APPLICABLE,
  };
}

/** 校验并归一化 previousDraft（P2 schema + 体积上限），确保发出去的只有受限 DSL。 */
function boundedPreviousDraft(draft, facts, pageFacts) {
  if (draft === undefined || draft === null) {
    return { ok: false, code: CODES.DRAFT_INVALID, message: '缺少 previousDraft', details: null };
  }
  let validated;
  try {
    validated = validateDraft(draft, facts, pageFacts);
  } catch (error) {
    return { ok: false, code: CODES.DRAFT_INVALID, message: 'previousDraft 校验异常：' + boundedDetail(error), details: null };
  }
  if (!validated.ok) {
    return {
      ok: false,
      code: CODES.DRAFT_INVALID,
      message: 'previousDraft 不是合法 DSL：' + truncate(validated.message, 160),
      details: { draftCode: validated.code, path: validated.path },
    };
  }
  const normalized = validated.draft;
  const text = JSON.stringify(normalized);
  const bytes = byteLength(text);
  if (bytes > MAX_PREVIOUS_DRAFT_BYTES) {
    return {
      ok: false,
      code: CODES.DRAFT_INVALID,
      message: 'previousDraft 超过上限 ' + MAX_PREVIOUS_DRAFT_BYTES + ' 字节',
      details: { bytes },
    };
  }
  return { ok: true, draft: normalized, bytes, digest: draftDigest(normalized) };
}

/**
 * 组装 repair 请求（有界、可审计）。
 * 返回的 payload 就是唯一允许发往服务端的结构。
 */
function buildRepairRequest(options) {
  const opts = options || {};
  const issuesResult = collectRepairIssues({ issues: opts.issues });
  if (!issuesResult.ok) {
    return { ok: false, code: CODES.ISSUES_INVALID, message: '没有可发送的结构化 issues（1–8 条 path+code）' };
  }
  if (!Array.isArray(opts.issues) || opts.issues.length > MAX_ISSUES) {
    return { ok: false, code: CODES.ISSUES_INVALID, message: 'issues 超过上限 ' + MAX_ISSUES };
  }
  if (typeof opts.runId !== 'string' || !RUN_ID_PATTERN.test(opts.runId)) {
    return { ok: false, code: CODES.ISSUES_INVALID, message: 'runId 非法' };
  }
  if (!Number.isInteger(opts.revision) || opts.revision < 0) {
    return { ok: false, code: CODES.ISSUES_INVALID, message: 'revision 必须是非负整数' };
  }
  if (!Number.isInteger(opts.round) || opts.round < 1 || opts.round > MAX_REPAIR_ROUNDS) {
    return { ok: false, code: CODES.LIMIT_INVALID, message: 'round 必须在 1–' + MAX_REPAIR_ROUNDS };
  }
  const bounded = boundedPreviousDraft(opts.previousDraft, opts.facts, opts.pageFacts);
  if (!bounded.ok) return bounded;

  const payload = {
    contractVersion: CONTRACT_VERSION,
    runId: opts.runId,
    revision: opts.revision,
    round: opts.round,
    issues: issuesResult.issues.map((issue) => ({ path: issue.path, code: issue.code })),
    previousDraft: bounded.draft,
  };
  const text = JSON.stringify(payload);
  for (const rule of FORBIDDEN_PAYLOAD_PATTERNS) {
    if (rule.pattern.test(text)) {
      return { ok: false, code: CODES.PAYLOAD_UNSAFE, message: 'repair 请求命中禁止内容：' + rule.code };
    }
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) {
    return { ok: false, code: CODES.PAYLOAD_UNSAFE, message: 'repair 请求含控制字符' };
  }
  return { ok: true, payload, bytes: byteLength(text), issues: payload.issues, previousDraftBytes: bounded.bytes };
}

/**
 * 两轮受控修复循环。
 *
 * @param {object} options
 * @param {object} options.draft                  初始 Draft（不会被本函数修改）
 * @param {(draft:object, context:{round:number, signal?:object}) => Promise<object>} options.dryRun
 *        本地 dry-run（通常是 `dry-run.cjs` 的 `dryRun`）；返回统一结果结构
 * @param {(payload:object, context:{round:number, signal?:object}) => Promise<object>} options.repair
 *        受控 repair 传输（P4 注入）：成功时返回 `{ok:true, draft}`（修复后的完整 Draft）
 * @param {object} options.facts                  能力事实（校验 previousDraft 用）
 * @param {object} options.pageFacts              页面级事实（校验 previousDraft 用）
 * @param {string} options.runId                  服务端 runId（旧响应用它丢弃）
 * @param {number} [options.revision=0]           当前 revision
 * @param {number} [options.maxRounds=2]          最多 2 轮（不得放宽）
 * @param {object} [options.signal]               取消信号（`{cancelled:true}` 或 AbortSignal）
 * @param {(event:object)=>void} [options.onRound] 进度回调（事件不含日志正文）
 */
async function runRepairLoop(options) {
  const opts = options || {};
  const signal = opts.signal;
  const maxRounds = opts.maxRounds === undefined ? MAX_REPAIR_ROUNDS : opts.maxRounds;
  if (!Number.isInteger(maxRounds) || maxRounds < 0 || maxRounds > MAX_REPAIR_ROUNDS) {
    return {
      ok: false,
      code: CODES.LIMIT_INVALID,
      adoption: 'none',
      message: 'maxRounds 必须 ≤ ' + MAX_REPAIR_ROUNDS + '（契约上限，禁止放宽）',
      attempts: [],
      keptDraft: opts.draft,
    };
  }
  if (typeof opts.dryRun !== 'function') {
    return {
      ok: false,
      code: CODES.DRY_RUN_FAILED,
      adoption: 'none',
      message: '缺少本地 dry-run 实现',
      attempts: [],
      keptDraft: opts.draft,
    };
  }
  if (typeof opts.repair !== 'function') {
    return {
      ok: false,
      code: CODES.TRANSPORT_FAILED,
      adoption: 'none',
      message: '缺少受控 repair 传输实现',
      attempts: [],
      keptDraft: opts.draft,
    };
  }

  const original = opts.draft;
  const originalDigest = (() => {
    try {
      return draftDigest(original);
    } catch (error) {
      return null;
    }
  })();
  let current = original;
  const attempts = [];
  const emit = (event) => {
    if (typeof opts.onRound === 'function') opts.onRound(event);
  };

  for (let round = 0; round <= maxRounds; round += 1) {
    if (isCancelled(signal)) {
      return {
        ok: false,
        code: CODES.CANCELLED,
        adoption: 'none',
        message: '修复被取消',
        attempts,
        keptDraft: original,
        lastDraft: current,
      };
    }

    emit({ phase: 'dry-run', round });
    let result;
    try {
      result = await opts.dryRun(current, { round, signal });
    } catch (error) {
      return {
        ok: false,
        code: CODES.DRY_RUN_FAILED,
        adoption: 'none',
        message: '本地 dry-run 异常：' + boundedDetail(error),
        attempts,
        keptDraft: original,
        lastDraft: current,
      };
    }

    if (result && result.ok === true) {
      let digest = null;
      try {
        digest = draftDigest(current);
      } catch (error) {
        digest = null;
      }
      return {
        ok: true,
        code: attempts.length === 0 ? CODES.NO_REPAIR_NEEDED : CODES.OK,
        adoption: 'candidate',
        message: attempts.length === 0 ? '首次 dry-run 通过' : '第 ' + attempts.length + ' 轮修复后 dry-run 通过',
        repairs: attempts.length,
        rounds: attempts.length,
        draft: current,
        digest,
        changed: Boolean(originalDigest && digest && originalDigest !== digest),
        result,
        attempts,
        keptDraft: original,
      };
    }

    const collected = collectRepairIssues(result);
    if (!collected.ok) {
      return {
        ok: false,
        code: CODES.NOT_APPLICABLE,
        adoption: 'none',
        message: 'dry-run 失败的 issue 无法定位到 DSL path，禁止自动修复（候选不可采用）',
        details: {
          failedCode: result && result.code ? result.code : null,
          droppedIssues: collected.dropped,
          resultCode: result && result.code ? result.code : null,
        },
        attempts,
        keptDraft: original,
        lastDraft: current,
        result,
      };
    }

    if (round >= maxRounds) {
      return {
        ok: false,
        code: CODES.LIMIT_EXCEEDED,
        adoption: 'none',
        message: '已用满 ' + maxRounds + ' 轮修复仍未通过：保留当前版本，候选不可采用',
        details: { repairs: attempts.length, limit: maxRounds, resultCode: result && result.code ? result.code : null },
        attempts,
        keptDraft: original,
        lastDraft: current,
        result,
      };
    }

    const request = buildRepairRequest({
      runId: opts.runId,
      revision: Number.isInteger(opts.revision) ? opts.revision : 0,
      round: round + 1,
      issues: collected.issues,
      previousDraft: current,
      facts: opts.facts,
      pageFacts: opts.pageFacts,
    });
    if (!request.ok) {
      return {
        ok: false,
        code: request.code,
        adoption: 'none',
        message: '无法构造受控 repair 请求：' + truncate(request.message, 160),
        details: request.details || null,
        attempts,
        keptDraft: original,
        lastDraft: current,
        result,
      };
    }

    emit({ phase: 'repair', round: round + 1, issues: request.issues.length });
    let response;
    try {
      response = await opts.repair(request.payload, { round: round + 1, signal });
    } catch (error) {
      return {
        ok: false,
        code: CODES.TRANSPORT_FAILED,
        adoption: 'none',
        message: 'repair 传输失败：' + boundedDetail(error),
        attempts,
        keptDraft: original,
        lastDraft: current,
        result,
      };
    }
    if (isCancelled(signal)) {
      return {
        ok: false,
        code: CODES.CANCELLED,
        adoption: 'none',
        message: '修复被取消（响应丢弃）',
        attempts,
        keptDraft: original,
        lastDraft: current,
        result,
      };
    }
    if (!response || response.ok !== true) {
      return {
        ok: false,
        code: CODES.REJECTED,
        adoption: 'none',
        message: '服务端拒绝修复：' + truncate((response && (response.code || response.message)) || 'UNKNOWN', 160),
        attempts,
        keptDraft: original,
        lastDraft: current,
        result,
      };
    }
    if (response.draft === undefined || response.draft === null) {
      return {
        ok: false,
        code: CODES.RESPONSE_INVALID,
        adoption: 'none',
        message: 'repair 响应必须返回完整 Draft（不接受本地无法审计的补丁）',
        attempts,
        keptDraft: original,
        lastDraft: current,
        result,
      };
    }
    const next = boundedPreviousDraft(response.draft, opts.facts, opts.pageFacts);
    if (!next.ok) {
      return {
        ok: false,
        code: CODES.RESPONSE_INVALID,
        adoption: 'none',
        message: 'repair 返回的 Draft 不合法：' + truncate(next.message, 160),
        details: next.details || null,
        attempts,
        keptDraft: original,
        lastDraft: current,
        result,
      };
    }

    attempts.push({
      round: round + 1,
      request: {
        bytes: request.bytes,
        issues: request.issues,
        previousDraftBytes: request.previousDraftBytes,
      },
      draftDigest: next.digest,
    });
    current = next.draft;
  }

  // 理论不可达（循环内每轮都会 return）；保留兜底避免静默继续。
  return {
    ok: false,
    code: CODES.LIMIT_EXCEEDED,
    adoption: 'none',
    message: '修复循环结束仍未通过：保留当前版本，候选不可采用',
    attempts,
    keptDraft: original,
    lastDraft: current,
  };
}

module.exports = {
  REPAIR_ISSUE_CODES,
  CONTRACT_VERSION,
  MAX_REPAIR_ROUNDS,
  MAX_ISSUES,
  MAX_PREVIOUS_DRAFT_BYTES,
  DSL_ISSUE_PATH_PATTERN,
  CODES,
  collectRepairIssues,
  boundedPreviousDraft,
  buildRepairRequest,
  runRepairLoop,
};
