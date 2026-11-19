import {
  buildNextQuestion,
  toContractDraft,
  validateAgentDraft,
} from '../../domain/agentDraft.mjs';
import { mergeAgentRunDraft } from '../../domain/agentRunDraft.mjs';
import { summarizeDraftChanges } from '../../domain/agentRunProcess.mjs';
import { AGENT_RUN_CONTRACT_VERSION, getAgentRunConfig } from './agentServiceConfig.js';
import {
  createAgentTurnError,
  isAgentTurnError,
  normalizeAgentTurnError,
} from './agentTurnError.js';
import { createAgentRunTransport } from './agentRunTransport.js';
import { createDirectAgentRunTransport } from './directAgentRunTransport.js';

/**
 * 薄 `agent-run.v1` 服务（W2）。
 *
 * 只负责：路由判定 → 组请求体 → 调 transport → 合并草稿 → 本地校验。
 * 多轮工具循环：直连模式在渲染层（directAgentRunTransport），本机服务模式在服务端 Runtime。
 * 两条路径返回同一个契约外壳，因此下游不需要第二套逻辑。
 */

const MAX_UTTERANCE = 500;
const STORE_INFO_PHASE = 'store-info';

/** 路由标签：只有 `agent-run.v1` 会打到 POST /api/v1/agent/run。 */
export const AGENT_ROUTES = Object.freeze({
  RUN: 'agent-run.v1',
  DIRECT: 'agent-run.direct',
  TURN_V2: 'agent-turn.v2',
  TURN_V1: 'agent-turn.v1',
  OTHER: 'agent-turn',
});

/**
 * 纯函数路由判定，便于在无浏览器环境直接测试。
 *
 * - 非资料阶段（模板修订等）：不进本服务，返回 `agent-turn` 占位由调用方分流。
 * - 有图片：仍走 `agent-turn.v2`（`agent-run.v1` 不接受图片）。
 * - 无图片 + 直连 DeepSeek：走本地直连 transport。
 * - 无图片 + 本机模型服务：走 `agent-run.v1`。
 */
export function resolveAgentRequestRoute({ phase = STORE_INFO_PHASE, imageCount = 0, transportMode = 'direct' } = {}) {
  if (phase !== STORE_INFO_PHASE) return AGENT_ROUTES.OTHER;
  const count = Number(imageCount);
  if (Number.isFinite(count) && count > 0) return AGENT_ROUTES.TURN_V2;
  if (transportMode === 'direct') return AGENT_ROUTES.DIRECT;
  return transportMode === 'http' ? AGENT_ROUTES.RUN : AGENT_ROUTES.TURN_V1;
}

export function isAgentRunRoute(route) {
  return route === AGENT_ROUTES.RUN || route === AGENT_ROUTES.DIRECT;
}

/** 把服务端 trace 收敛成可展示的最小结构（不含任何参数/结果正文）。 */
export function summarizeRunTrace(trace) {
  if (!trace || typeof trace !== 'object' || Array.isArray(trace)) return null;
  const toolCalls = Array.isArray(trace.toolCalls) ? trace.toolCalls : [];
  return {
    modelCalls: Number.isInteger(trace.modelCalls) ? trace.modelCalls : 0,
    stopReason: typeof trace.stopReason === 'string' ? trace.stopReason : null,
    degraded: trace.degraded === true,
    toolCalls: toolCalls.map((call) => ({
      callId: typeof call?.callId === 'string' ? call.callId : null,
      name: typeof call?.name === 'string' ? call.name : 'unknown',
      ok: call?.ok === true,
      errorCode: typeof call?.errorCode === 'string' ? call.errorCode : null,
      latencyMs: Number.isInteger(call?.latencyMs) ? call.latencyMs : 0,
      attempts: Number.isInteger(call?.attempts) ? call.attempts : 0,
      truncated: call?.truncated === true,
    })),
  };
}

const STOP_REASON_HINTS = Object.freeze({
  final_answer: '本轮已完成整理。',
  empty_reply: '模型没有给出有效回复，草稿按已收集到的资料保留。',
  max_model_calls: '本轮达到模型调用上限，草稿可能还不完整。',
  max_tool_calls: '这一轮处理步骤太多，草稿可能还不完整。',
  loop_detected: '检测到重复调用已提前结束本轮，草稿可能还不完整。',
  time_limit: '本轮达到时间上限，草稿可能还不完整。',
  aborted: '本轮被取消，草稿按已收到的内容保留。',
});

/**
 * 降级（部分完成）描述：既给 UI 用的人话，也给 W3 过程面板用的结构化字段。
 * 降级 ≠ 失败：合法草稿仍然可用，但必须让用户看到「不是全部工具都成功」。
 */
export function describeRunDegradation({ degraded, stopReason, failedTools = [], toolCallCount = 0 } = {}) {
  const reasons = [];
  if (failedTools.length) {
    reasons.push(`有 ${failedTools.length} 个步骤没有完成`);
  }
  const stopHint = STOP_REASON_HINTS[stopReason] || '';
  if (stopReason && stopReason !== 'final_answer' && stopHint) reasons.push(stopHint);
  const isDegraded = degraded === true || reasons.length > 0;
  const cleanReasons = reasons.map((reason) => reason.replace(/[。；\s]+$/, ''));
  return {
    degraded: isDegraded,
    stopReason: stopReason ?? null,
    failedTools,
    toolCallCount,
    message: isDegraded
      ? `这一轮为部分完成：${cleanReasons.join('；')}。可以先检查草稿，继续补充或重试。`
      : '',
  };
}

function resolveFetchImpl() {
  if (typeof globalThis !== 'undefined' && typeof globalThis.fetch === 'function') {
    return globalThis.fetch.bind(globalThis);
  }
  return null;
}

function resolveTransport(transport) {
  if (transport) {
    if (typeof transport.send !== 'function') {
      throw createAgentTurnError('AGENT_TRANSPORT_UNKNOWN');
    }
    return transport;
  }
  const config = getAgentRunConfig();
  if (config.mode === 'direct') {
    return createDirectAgentRunTransport();
  }
  return createAgentRunTransport({
    fetchImpl: resolveFetchImpl(),
    endpoint: config.endpoint,
    timeoutMs: config.timeoutMs,
  });
}

export function createAgentRunService(options = {}) {
  const transport = resolveTransport(options.transport);

  return {
    transportName: 'agent-run',
    contractVersion: AGENT_RUN_CONTRACT_VERSION,

    async requestAgentRun({ utterance, draft, projectId = null, requestId = null, signal } = {}) {
      const text = String(utterance ?? '').trim();
      if (!text || Array.from(text).length > MAX_UTTERANCE) {
        throw createAgentTurnError('AGENT_REQUEST_INVALID');
      }

      const request = {
        contractVersion: AGENT_RUN_CONTRACT_VERSION,
        utterance: text,
        draft: toContractDraft(draft),
        client: { surface: 'desktop', phase: STORE_INFO_PHASE },
        projectId: typeof projectId === 'string' && projectId.trim() ? projectId.trim() : null,
      };

      let response;
      try {
        response = await transport.send(request, { requestId, signal });
      } catch (error) {
        if (isAgentTurnError(error)) throw error;
        throw normalizeAgentTurnError(error);
      }

      // 草稿：按 id → name 合并，未传字段/空字符串不覆盖，不删除。
      const merged = mergeAgentRunDraft(draft, response.draft);
      const validation = validateAgentDraft(merged);
      const trace = summarizeRunTrace(response.trace);
      const degradation = describeRunDegradation({
        degraded: response.degraded === true,
        stopReason: response.stopReason ?? trace?.stopReason ?? null,
        failedTools: Array.isArray(response.failedTools) ? response.failedTools : [],
        toolCallCount: trace ? trace.toolCalls.length : 0,
      });

      return {
        draft: merged,
        validation,
        nextQuestion: buildNextQuestion(validation),
        reply: typeof response.reply === 'string' ? response.reply : '',
        // 状态只由本地校验决定，不盲信服务端 status。
        status: validation.readyForReview ? 'reviewing' : 'collecting',
        meta: response.meta ?? null,
        runId: response.runId ?? null,
        trace,
        degraded: degradation.degraded,
        degradation,
        stopReason: degradation.stopReason,
        // W3：本轮到底改了什么（人话摘要），供过程卡展示；不涉及工具参数。
        changeSummary: summarizeDraftChanges(draft, merged),
        requestId: response.requestId ?? requestId ?? null,
        contractVersion: AGENT_RUN_CONTRACT_VERSION,
      };
    },
  };
}

let defaultService = null;

export function requestAgentRun(params) {
  if (!defaultService) defaultService = createAgentRunService();
  return defaultService.requestAgentRun(params);
}

export function resetAgentRunService() {
  defaultService = null;
}

export function resetAgentRunServiceForTests() {
  resetAgentRunService();
}
