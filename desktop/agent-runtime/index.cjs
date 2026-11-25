'use strict';

/**
 * `desktop/agent-runtime` 入口（E0-R1 / rev15 §14.7）。
 *
 * direct Workspace Runtime 的公开面：
 * - `createDirectWorkspaceRuntime({ coordinator, modelChat | credentials })` → `{ invoke, runTurn, describe }`
 *   与 `coordinator.invokeDirect({ context, request })` 对接（tool 执行唯一入口是 `coordinator.invokeTool`）；
 * - `createModelChat({ credentials })` → 归一的 `{ finishReason, truncated, content, toolCalls, usage }`；
 * - `createHttpBridge({ resolveChannel })` → 可选 HTTP transport，未连接即明确 unavailable；
 * - `buildToolDefinitions()` / `MODEL_TOOL_NAMES` / `PLATFORM_ONLY_TOOL_NAMES` → §14.3 工具面（单一来源）；
 * - `deriveStatusFromEvidence(evidence)` → X9：状态只来自本地证据，不读模型 reply。
 *
 * 本模块**不** require Electron、**不**碰文件系统、**不**写 attempt：
 * 所有落盘都发生在 Coordinator。
 */

const { createDirectWorkspaceRuntime, deriveStatusFromEvidence, DEFAULT_SYSTEM_PROMPT, ORDER_CONTRACT } = require('./workspace-runtime.cjs');
const { createModelChat, normalizeCompletion } = require('./model-chat.cjs');
const { createHttpBridge, UNAVAILABLE_REASON, UNAVAILABLE_MESSAGE } = require('./http-bridge.cjs');
const {
  resolveAssetImage,
  resolveAssetImages,
  createAssetImageResolver,
  validateImageStructure,
  sniffImageMime,
  RuntimeImageError,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_TURN,
} = require('./images.cjs');
const {
  buildMultimodalContent,
  assertChannelAccepts,
  resolveVisionSupport,
  IMAGE_ONLY_TEXT,
} = require('./multimodal.cjs');
const { buildToolDefinitions, classifyModelToolName, toolDescription, SCHEMAS } = require('./tools.cjs');
const {
  RUNTIME_CODES,
  MAX_TOKENS,
  DEFAULT_RUNTIME_LIMITS,
  STOP_REASONS,
  MODEL_TOOL_NAMES,
  PLATFORM_ONLY_TOOL_NAMES,
  EVIDENCE_STALE_ISSUE,
  NEXT_ACTION_RERUN_CHECKS,
  resolveRuntimeLimits,
} = require('./constants.cjs');

module.exports = {
  // 主入口
  createDirectWorkspaceRuntime,
  createModelChat,
  createHttpBridge,
  // 工具面（§14.3）
  buildToolDefinitions,
  classifyModelToolName,
  toolDescription,
  TOOL_SCHEMAS: SCHEMAS,
  MODEL_TOOL_NAMES,
  PLATFORM_ONLY_TOOL_NAMES,
  // 口径与常量
  RUNTIME_CODES,
  MAX_TOKENS,
  DEFAULT_RUNTIME_LIMITS,
  STOP_REASONS,
  DEFAULT_SYSTEM_PROMPT,
  ORDER_CONTRACT,
  EVIDENCE_STALE_ISSUE,
  NEXT_ACTION_RERUN_CHECKS,
  resolveRuntimeLimits,
  deriveStatusFromEvidence,
  normalizeCompletion,
  // X2（§14.8）：图片资产解析 + 多模态消息（图片只进调用内存）
  resolveAssetImage,
  resolveAssetImages,
  createAssetImageResolver,
  validateImageStructure,
  sniffImageMime,
  RuntimeImageError,
  buildMultimodalContent,
  assertChannelAccepts,
  resolveVisionSupport,
  IMAGE_ONLY_TEXT,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_TURN,
  HTTP_BRIDGE_UNAVAILABLE_REASON: UNAVAILABLE_REASON,
  HTTP_BRIDGE_UNAVAILABLE_MESSAGE: UNAVAILABLE_MESSAGE,
};
