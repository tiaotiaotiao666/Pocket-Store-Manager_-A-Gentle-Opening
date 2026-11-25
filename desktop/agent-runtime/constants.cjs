'use strict';

/**
 * direct Workspace Runtime 的常量 / 错误码 / 预算（E0-R1，rev15 §14.7）。
 *
 * 单一来源约定（避免“第二套状态链”和常量漂移）：
 * - 模型可见工具名只认 `../agent-workspace/run-coordinator.cjs` 导出的 `MODEL_TOOL_NAMES`
 *   （rev15 §14.3 的 11 个）与 `PLATFORM_ONLY_TOOL_NAMES`；本模块**不复制**第二份名单。
 * - 错误码只用 rev15 §14.9 冻结的 `AGENT_*`：这里追加的 `AGENT_OUTPUT_TRUNCATED` /
 *   `AGENT_VISION_UNAVAILABLE` / `AGENT_IMAGE_INVALID` 都在 §14.9 名单内，未私增新码。
 * - `maxTokens` 的默认值/硬上限只来自 `../model-credentials.cjs`（唯一出口），这里只做转出口。
 */

const {
  CODES: WORKSPACE_CODES,
  MODEL_TOOL_NAMES,
  PLATFORM_ONLY_TOOL_NAMES,
} = require('../agent-workspace/run-coordinator.cjs');
const { DIRECT_EDIT_MAX_TOKENS } = require('../model-credentials.cjs');

/** §14.9 冻结码 + 坐标文件已冻结码；direct runtime 只从这里取。 */
const RUNTIME_CODES = Object.freeze({
  ...WORKSPACE_CODES,
  OUTPUT_TRUNCATED: 'AGENT_OUTPUT_TRUNCATED',
  VISION_UNAVAILABLE: 'AGENT_VISION_UNAVAILABLE',
  IMAGE_INVALID: 'AGENT_IMAGE_INVALID',
});

/** §14.7：direct 源码编辑的 token 预算（默认 6000 / 硬上限 8000，**禁止**回退 1200）。 */
const MAX_TOKENS = Object.freeze({
  directEditDefault: DIRECT_EDIT_MAX_TOKENS.default,
  directEditMax: DIRECT_EDIT_MAX_TOKENS.max,
});

/**
 * 预算与 loop detection 默认值（与 D0/服务端 `agent-loop.ts` 同语义，桌面按源码编辑放宽墙钟）。
 * `stopReason` 白名单与 `src/domain/agentRunProcess.mjs` 一致，UI 已认识这些词。
 */
const DEFAULT_RUNTIME_LIMITS = Object.freeze({
  maxModelCalls: 6,
  maxToolCalls: 12,
  maxWallClockMs: 120_000,
  maxToolResultBytes: 16 * 1024,
  maxReplyCharacters: 4000,
  /** 同一工具 + 同一参数的调用达到该次数即判定死循环。 */
  loopSignatureLimit: 3,
});

const LIMIT_RANGES = Object.freeze({
  maxModelCalls: [1, 12],
  maxToolCalls: [1, 50],
  maxWallClockMs: [5_000, 600_000],
  maxToolResultBytes: [512, 256 * 1024],
  maxReplyCharacters: [100, 20_000],
  loopSignatureLimit: [2, 10],
});

/** 与 `src/domain/agentRunProcess.mjs` 的 trace.stopReason 文案表同源口径。 */
const STOP_REASONS = Object.freeze([
  'final_answer',
  'empty_reply',
  'max_model_calls',
  'max_tool_calls',
  'loop_detected',
  'time_limit',
  'aborted',
  'output_truncated',
]);

const MODEL_TOOL_SET = new Set(MODEL_TOOL_NAMES);
const PLATFORM_ONLY_TOOL_SET = new Set(PLATFORM_ONLY_TOOL_NAMES);

/** 空回复一次性的提示（与服务端 `EMPTY_REPLY_NUDGE` 同文案，避免两边口径分叉）。 */
const EMPTY_REPLY_NUDGE = '请用一句简体中文告诉店主你刚做了什么、或还需要什么信息；不要只调用工具，也不要返回空内容。';

function clampInteger(value, fallback, min, max) {
  const raw = Number(value);
  if (!Number.isInteger(raw)) return fallback;
  return Math.min(max, Math.max(min, raw));
}

/** 预算归一：非法值一律回落默认（不静默放大，也不允许 0/负数）。 */
function resolveRuntimeLimits(overrides) {
  const source = overrides && typeof overrides === 'object' ? overrides : {};
  const out = {};
  for (const key of Object.keys(DEFAULT_RUNTIME_LIMITS)) {
    const [min, max] = LIMIT_RANGES[key];
    out[key] = clampInteger(source[key], DEFAULT_RUNTIME_LIMITS[key], min, max);
  }
  return Object.freeze(out);
}

/**
 * rev15 §14.13-3（F3）顺序契约相关的**证据问题码**（issue.code，不是 envelope code）。
 * 与 `../agent-workspace/run-coordinator.cjs` 内部常量同值（那边未导出，这里只做读取用的字符串镜像）；
 * envelope code 本身仍取自 coordinator 的 CODES（`RUNTIME_CODES.EVIDENCE_STALE`），不新增 AGENT_* 码。
 */
const EVIDENCE_STALE_ISSUE = 'EVIDENCE_STALE_RERUN_CHECKS';
const NEXT_ACTION_RERUN_CHECKS = 'rerun-checks';
/** 写入类工具：执行成功后既有检查证据一律失效（§14.13-3）。 */
const WRITE_TOOL_NAMES = Object.freeze(['write_files', 'delete_files']);
/** 重跑检查类工具：执行成功后陈旧证据被刷新，禁止重复 submit 的闸门解除。 */
const RECHECK_TOOL_NAMES = Object.freeze(['run_check']);

module.exports = {
  RUNTIME_CODES,
  MAX_TOKENS,
  DEFAULT_RUNTIME_LIMITS,
  LIMIT_RANGES,
  STOP_REASONS,
  MODEL_TOOL_NAMES,
  PLATFORM_ONLY_TOOL_NAMES,
  MODEL_TOOL_SET,
  PLATFORM_ONLY_TOOL_SET,
  EMPTY_REPLY_NUDGE,
  EVIDENCE_STALE_ISSUE,
  NEXT_ACTION_RERUN_CHECKS,
  WRITE_TOOL_NAMES,
  RECHECK_TOOL_NAMES,
  resolveRuntimeLimits,
  clampInteger,
};
