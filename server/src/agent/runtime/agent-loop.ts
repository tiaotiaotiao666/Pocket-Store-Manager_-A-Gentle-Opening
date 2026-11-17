/**
 * Agent 循环：模型 → 工具 → 模型，直到得到最终回复或触达硬上限。
 *
 * 健壮性约束（均有测试覆盖）：
 * - 每次工具调用的结果都会写回一条 tool 消息，保证下一次请求的消息序列合法；
 * - 模型连续返回空回复时只追加一次提醒，避免死循环；
 * - 相同工具 + 相同参数的签名出现第 3 次即判定为循环；
 * - 模型调用 / 工具调用 / 墙钟时间三重上限，任一触达都返回 degraded 结果而不是抛错；
 * - 取消信号贯穿模型与工具调用，执行器会为每个被取消的调用补一条 tool 消息。
 */

import { randomUUID } from 'node:crypto';

import { canonicalJsonText, truncateCharacters } from './json-utils';
import {
  AGENT_RUNTIME_ERROR_CODES,
  AgentAbortedError,
  AgentConfigurationError,
  AgentLimitError,
  AgentModelError,
} from './runtime.errors';
import {
  addTokenUsage,
  emptyTokenUsage,
  NOOP_AGENT_LOGGER,
  type AgentLogSink,
  type AgentTokenUsage,
  type ChatCompletionRequest,
  type ChatCompletionResult,
  type ChatContentPart,
  type ChatMessage,
  type ChatMessageContent,
  type ChatModel,
  type ChatToolCall,
} from './runtime.types';
import {
  ToolExecutor,
  type AgentToolCallTrace,
  type AgentToolCallRequest,
} from './tool-executor';
import type { AgentToolApprovalHook, ToolRegistry } from './tool-registry';

export const EMPTY_REPLY_NUDGE =
  '请用一句简体中文告诉店主你刚做了什么、或还需要什么信息；不要只调用工具，也不要返回空内容。';

export interface AgentRunLimits {
  /** 单次 run 内最多调用模型次数（也即最多轮次）。 */
  maxModelCalls: number;
  /** 单次 run 内最多执行工具次数（按 tool_call 个数计）。 */
  maxToolCalls: number;
  /** 墙钟时间上限，毫秒。 */
  maxWallClockMs: number;
  maxParallelToolCalls: number;
  /** 最终回复字符上限，超出则截断。 */
  maxReplyCharacters: number;
  maxToolResultBytes: number;
  /** 模型调用最大尝试次数（含首次）。 */
  modelMaxAttempts: number;
  modelRetryBackoffMs: number;
  toolTimeoutMs: number;
}

export const DEFAULT_AGENT_RUN_LIMITS: Readonly<AgentRunLimits> = Object.freeze({
  maxModelCalls: 6,
  maxToolCalls: 12,
  maxWallClockMs: 60_000,
  maxParallelToolCalls: 4,
  maxReplyCharacters: 4_000,
  maxToolResultBytes: 16 * 1024,
  modelMaxAttempts: 2,
  modelRetryBackoffMs: 300,
  toolTimeoutMs: 15_000,
});

export type AgentRunStatus = 'completed' | 'limit_reached' | 'aborted';

export type AgentStopReason =
  | 'final_answer'
  | 'empty_reply'
  | 'max_model_calls'
  | 'max_tool_calls'
  | 'loop_detected'
  | 'time_limit'
  | 'aborted';

export interface AgentStepTrace {
  step: number;
  model: string;
  finishReason: string;
  latencyMs: number;
  hasToolCalls: boolean;
  toolCallCount: number;
  promptTokens: number;
  completionTokens: number;
  /** 上游输出被截断（finish_reason=length 或适配器字符上限）；不得解析为完整 JSON。 */
  truncated: boolean;
  note?: 'empty_reply_nudge';
}

export interface AgentRunResult {
  runId: string;
  status: AgentRunStatus;
  stopReason: AgentStopReason;
  reply: string;
  messages: readonly ChatMessage[];
  steps: readonly AgentStepTrace[];
  toolCalls: readonly AgentToolCallTrace[];
  usage: AgentTokenUsage;
  modelCalls: number;
  latencyMs: number;
  model: string;
  /** 任一步模型输出被截断；调用方必须按稳定错误码失败，不得解析残片。 */
  truncated: boolean;
  /** 非正常完成（触达上限/取消）或最终回复为空时为 true，调用方应提供兜底文案。 */
  degraded: boolean;
}

export interface AgentRunOptions {
  model: ChatModel;
  registry: ToolRegistry;
  systemPrompt: string;
  /**
   * 用户消息：纯文本（旧行为不变）或类型化 `text + image_url` 片段数组。
   * 片段数组只允许内联 data URL 图片，由 normalizeUserContent 二次校验。
   */
  userMessage: string | readonly ChatContentPart[];
  /** 允许本次运行使用的工具白名单；省略表示注册表中的全部工具。 */
  tools?: readonly string[];
  limits?: Partial<AgentRunLimits>;
  /** 单次模型调用输出 token 上限；省略时完全保持适配器默认行为。 */
  maxTokens?: number;
  runId?: string;
  requestId?: string;
  signal?: AbortSignal;
  approval?: AgentToolApprovalHook;
  logger?: AgentLogSink;
  metadata?: Readonly<Record<string, string>>;
  /** 测试注入，默认 setTimeout。 */
  sleep?: (ms: number) => Promise<void>;
}

export function resolveAgentRunLimits(overrides: Partial<AgentRunLimits> = {}): AgentRunLimits {
  return {
    maxModelCalls: clampInteger(overrides.maxModelCalls, DEFAULT_AGENT_RUN_LIMITS.maxModelCalls, 1, 12),
    maxToolCalls: clampInteger(overrides.maxToolCalls, DEFAULT_AGENT_RUN_LIMITS.maxToolCalls, 1, 50),
    maxWallClockMs: clampInteger(
      overrides.maxWallClockMs,
      DEFAULT_AGENT_RUN_LIMITS.maxWallClockMs,
      1_000,
      300_000,
    ),
    maxParallelToolCalls: clampInteger(
      overrides.maxParallelToolCalls,
      DEFAULT_AGENT_RUN_LIMITS.maxParallelToolCalls,
      1,
      8,
    ),
    maxReplyCharacters: clampInteger(
      overrides.maxReplyCharacters,
      DEFAULT_AGENT_RUN_LIMITS.maxReplyCharacters,
      100,
      20_000,
    ),
    maxToolResultBytes: clampInteger(
      overrides.maxToolResultBytes,
      DEFAULT_AGENT_RUN_LIMITS.maxToolResultBytes,
      512,
      256 * 1024,
    ),
    modelMaxAttempts: clampInteger(
      overrides.modelMaxAttempts,
      DEFAULT_AGENT_RUN_LIMITS.modelMaxAttempts,
      1,
      3,
    ),
    modelRetryBackoffMs: clampInteger(
      overrides.modelRetryBackoffMs,
      DEFAULT_AGENT_RUN_LIMITS.modelRetryBackoffMs,
      0,
      5_000,
    ),
    toolTimeoutMs: clampInteger(
      overrides.toolTimeoutMs,
      DEFAULT_AGENT_RUN_LIMITS.toolTimeoutMs,
      100,
      120_000,
    ),
  };
}

export async function runAgent(options: AgentRunOptions): Promise<AgentRunResult> {
  const startedAt = Date.now();
  const limits = resolveAgentRunLimits(options.limits);
  const logger = options.logger ?? NOOP_AGENT_LOGGER;
  const runId = options.runId?.trim() || `run_${randomUUID()}`;
  const requestId = options.requestId?.trim() ?? '';
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  if (typeof options.systemPrompt !== 'string' || options.systemPrompt.trim().length === 0) {
    throw new AgentConfigurationError('systemPrompt 不能为空。');
  }
  const userContent = normalizeUserContent(options.userMessage);
  const maxTokens = normalizeMaxTokens(options.maxTokens);

  const descriptors = options.registry.descriptors(options.tools);
  const executor = new ToolExecutor({
    registry: options.registry,
    maxResultBytes: limits.maxToolResultBytes,
    defaultTimeoutMs: limits.toolTimeoutMs,
    maxParallelCalls: limits.maxParallelToolCalls,
  });

  const messages: ChatMessage[] = [
    { role: 'system', content: options.systemPrompt },
    { role: 'user', content: userContent },
  ];
  const steps: AgentStepTrace[] = [];
  const toolCallTraces: AgentToolCallTrace[] = [];
  const signatureCounts = new Map<string, number>();

  let usage = emptyTokenUsage();
  let modelCalls = 0;
  let toolCallCount = 0;
  let nudged = false;
  let reply = '';
  let modelName = options.model.name;
  let status: AgentRunStatus | null = null;
  let stopReason: AgentStopReason | null = null;
  let timedOut = false;

  const parentSignal = options.signal;
  if (parentSignal?.aborted) throw new AgentAbortedError();

  const controller = new AbortController();
  const onParentAbort = () => controller.abort(new AgentAbortedError());
  parentSignal?.addEventListener('abort', onParentAbort, { once: true });
  const deadlineTimer = setTimeout(() => {
    timedOut = true;
    controller.abort(new AgentLimitError(AGENT_RUNTIME_ERROR_CODES.timeLimit, '运行超过时间上限。'));
  }, limits.maxWallClockMs);

  logger.log({
    event: 'run_start',
    runId,
    requestId,
    maxModelCalls: limits.maxModelCalls,
    maxToolCalls: limits.maxToolCalls,
    maxWallClockMs: limits.maxWallClockMs,
    toolCount: descriptors.length,
  });

  try {
    while (modelCalls < limits.maxModelCalls) {
      if (controller.signal.aborted) break;
      if (Date.now() - startedAt >= limits.maxWallClockMs) {
        timedOut = true;
        break;
      }

      modelCalls += 1;
      const step = modelCalls;
      const request: ChatCompletionRequest = {
        messages,
        tools: descriptors,
        ...(maxTokens === undefined ? {} : { maxTokens }),
      };

      let completion: ChatCompletionResult;
      try {
        completion = await callModelWithRetry({
          model: options.model,
          request,
          signal: controller.signal,
          limits,
          logger,
          runId,
          requestId,
          step,
          sleep,
        });
      } catch (error) {
        if (controller.signal.aborted) break;
        throw error;
      }

      modelName = sanitizeModelName(completion.model) || modelName;
      const stepUsage = sanitizeUsage(completion.usage);
      usage = addTokenUsage(usage, stepUsage);
      const assistant = normalizeAssistantMessage(completion.message, step);
      messages.push(assistant);

      const calls = assistant.toolCalls ?? [];
      const finishReason = typeof completion.finishReason === 'string' ? completion.finishReason : '';
      const stepLatencyMs =
        typeof completion.latencyMs === 'number' && Number.isFinite(completion.latencyMs)
          ? Math.max(0, Math.floor(completion.latencyMs))
          : 0;
      const stepTrace: AgentStepTrace = {
        step,
        model: modelName,
        finishReason,
        latencyMs: stepLatencyMs,
        hasToolCalls: calls.length > 0,
        toolCallCount: calls.length,
        promptTokens: stepUsage?.promptTokens ?? 0,
        completionTokens: stepUsage?.completionTokens ?? 0,
        // finish_reason=length 或适配器字符裁剪都视为截断；残片绝不解析为完整输出。
        truncated: completion.truncated === true || finishReason === 'length',
      };
      steps.push(stepTrace);

      logger.log({
        event: 'model_call',
        runId,
        requestId,
        step,
        model: modelName,
        finishReason,
        latencyMs: stepLatencyMs,
        hasToolCalls: calls.length > 0,
        toolCallCount: calls.length,
        promptTokens: stepTrace.promptTokens,
        completionTokens: stepTrace.completionTokens,
      });

      if (calls.length === 0) {
        const text = assistantText(assistant.content).trim();
        if (text.length === 0) {
          if (!nudged) {
            nudged = true;
            stepTrace.note = 'empty_reply_nudge';
            messages.push({ role: 'user', content: EMPTY_REPLY_NUDGE });
            continue;
          }
          status = 'completed';
          stopReason = 'empty_reply';
          break;
        }
        reply = truncateCharacters(text, limits.maxReplyCharacters);
        status = 'completed';
        stopReason = 'final_answer';
        break;
      }

      if (toolCallCount + calls.length > limits.maxToolCalls) {
        appendSyntheticToolErrors(
          messages,
          calls,
          AGENT_RUNTIME_ERROR_CODES.toolCallLimit,
          `本次运行工具调用次数将超过上限 ${limits.maxToolCalls}，已停止执行。`,
        );
        status = 'limit_reached';
        stopReason = 'max_tool_calls';
        break;
      }

      if (countRepeatedSignatures(calls, signatureCounts) > 0) {
        appendSyntheticToolErrors(
          messages,
          calls,
          AGENT_RUNTIME_ERROR_CODES.loopDetected,
          '检测到重复的工具调用（相同工具与参数），已终止以避免死循环。',
        );
        status = 'limit_reached';
        stopReason = 'loop_detected';
        break;
      }

      toolCallCount += calls.length;
      const outcomes = await executor.executeBatch(
        calls.map<AgentToolCallRequest>((call) => ({
          id: call.id,
          name: call.name,
          argumentsText: call.argumentsText,
        })),
        {
          runId,
          requestId,
          step,
          signal: controller.signal,
          logger,
          metadata: options.metadata ?? {},
          ...(options.approval === undefined ? {} : { approval: options.approval }),
        },
      );

      for (const outcome of outcomes) {
        messages.push({
          role: 'tool',
          toolCallId: outcome.trace.callId,
          name: outcome.trace.name,
          content: outcome.content,
        });
        toolCallTraces.push(outcome.trace);
      }

      if (controller.signal.aborted) break;
    }

    if (parentSignal?.aborted) {
      status = 'aborted';
      stopReason = 'aborted';
    } else if (status === null) {
      if (timedOut || controller.signal.aborted) {
        status = 'limit_reached';
        stopReason = 'time_limit';
      } else {
        status = 'limit_reached';
        stopReason = 'max_model_calls';
      }
    }
  } finally {
    clearTimeout(deadlineTimer);
    parentSignal?.removeEventListener('abort', onParentAbort);
  }

  const result: AgentRunResult = {
    runId,
    status: status ?? 'limit_reached',
    stopReason: stopReason ?? 'max_model_calls',
    reply,
    messages,
    steps,
    toolCalls: toolCallTraces,
    usage,
    modelCalls,
    latencyMs: Date.now() - startedAt,
    model: modelName,
    truncated: steps.some((trace) => trace.truncated),
    degraded: status !== 'completed' || reply.length === 0,
  };

  logger.log({
    event: 'run_end',
    level: result.status === 'completed' ? 'info' : 'warn',
    runId,
    requestId,
    status: result.status,
    stopReason: result.stopReason,
    modelCalls: result.modelCalls,
    toolCalls: result.toolCalls.length,
    latencyMs: result.latencyMs,
    promptTokens: result.usage.promptTokens,
    completionTokens: result.usage.completionTokens,
    replyCharacters: Array.from(result.reply).length,
  });

  return result;
}

interface CallModelInput {
  model: ChatModel;
  request: ChatCompletionRequest;
  signal: AbortSignal;
  limits: AgentRunLimits;
  logger: AgentLogSink;
  runId: string;
  requestId: string;
  step: number;
  sleep: (ms: number) => Promise<void>;
}

async function callModelWithRetry(input: CallModelInput): Promise<ChatCompletionResult> {
  let attempt = 0;
  let lastError: unknown;

  while (attempt < input.limits.modelMaxAttempts) {
    attempt += 1;
    if (input.signal.aborted) throw new AgentAbortedError();
    try {
      return await input.model.complete(input.request, { signal: input.signal });
    } catch (error) {
      lastError = error;
      if (input.signal.aborted) throw new AgentAbortedError();
      const retryable = error instanceof AgentModelError && error.retryable;
      if (!retryable || attempt >= input.limits.modelMaxAttempts) throw error;
      const backoffMs = input.limits.modelRetryBackoffMs * attempt;
      input.logger.log({
        event: 'model_retry',
        level: 'warn',
        runId: input.runId,
        requestId: input.requestId,
        step: input.step,
        attempt,
        backoffMs,
        code: error.code,
      });
      await input.sleep(backoffMs);
    }
  }

  throw lastError;
}

function normalizeAssistantMessage(message: ChatMessage, step: number): ChatMessage {
  if (message === null || typeof message !== 'object' || message.role !== 'assistant') {
    throw new AgentModelError(
      AGENT_RUNTIME_ERROR_CODES.modelResponseInvalid,
      '模型返回的 assistant 消息格式非法。',
    );
  }

  const textContent = assistantText(message.content);
  const content = textContent.length > 0 ? textContent : null;
  const rawCalls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
  const usedIds = new Set<string>();
  const calls: ChatToolCall[] = rawCalls.map((call, index) => {
    const name = typeof call.name === 'string' ? call.name.trim() : '';
    let id =
      typeof call.id === 'string' && call.id.trim().length > 0
        ? call.id.trim()
        : `call_${step}_${index + 1}`;
    while (usedIds.has(id)) id = `${id}_${index + 1}`;
    usedIds.add(id);
    const argumentsText = typeof call.argumentsText === 'string' ? call.argumentsText : '{}';
    return { id, name, argumentsText };
  });

  return {
    role: 'assistant',
    content,
    ...(calls.length === 0 ? {} : { toolCalls: calls }),
  };
}

function appendSyntheticToolErrors(
  messages: ChatMessage[],
  calls: readonly ChatToolCall[],
  code: string,
  message: string,
): void {
  const content = JSON.stringify({ ok: false, error: { code, message } });
  for (const call of calls) {
    messages.push({
      role: 'tool',
      toolCallId: call.id,
      name: call.name,
      content,
    });
  }
}

function countRepeatedSignatures(
  calls: readonly ChatToolCall[],
  counts: Map<string, number>,
): number {
  let repeated = 0;
  for (const call of calls) {
    const signature = `${call.name}\u0000${canonicalJsonText(call.argumentsText)}`;
    const next = (counts.get(signature) ?? 0) + 1;
    counts.set(signature, next);
    if (next >= 3) repeated += 1;
  }
  return repeated;
}

function sanitizeUsage(usage: AgentTokenUsage | undefined): AgentTokenUsage | undefined {
  if (usage === undefined) return undefined;
  const promptTokens = nonNegativeInteger(usage.promptTokens);
  const completionTokens = nonNegativeInteger(usage.completionTokens);
  const totalTokens = nonNegativeInteger(usage.totalTokens) || promptTokens + completionTokens;
  return { promptTokens, completionTokens, totalTokens };
}

function nonNegativeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

function sanitizeModelName(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 多模态 content parts 的硬边界（与 frontend-reconstruct.v1 单图上限同量级）。 */
const MAX_USER_CONTENT_PARTS = 4;
const MAX_USER_TEXT_CHARS = 8_000;
const MAX_IMAGE_DATA_URL_CHARS = 800_000;
const IMAGE_DATA_URL_PATTERN =
  /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/**
 * 规范化用户消息：
 * - 字符串：完全保持旧行为，只拒绝空白；
 * - 片段：只允许 text 与内联 data URL image_url，图片必须是纯 base64 的 PNG/JPEG/WebP。
 *   远程 URL、文件路径、其它 scheme 一律拒绝，防止服务端被当成任意图片代理。
 */
function normalizeUserContent(
  content: string | readonly ChatContentPart[],
): ChatMessageContent {
  if (typeof content === 'string') {
    if (content.trim().length === 0) {
      throw new AgentConfigurationError('userMessage 不能为空。');
    }
    return content;
  }
  if (!Array.isArray(content) || content.length === 0 || content.length > MAX_USER_CONTENT_PARTS) {
    throw new AgentConfigurationError(
      `userMessage 片段数量必须是 1–${MAX_USER_CONTENT_PARTS}。`,
    );
  }

  let textChars = 0;
  let hasText = false;
  const parts: ChatContentPart[] = [];
  for (const part of content) {
    if (part !== null && typeof part === 'object' && part.type === 'text') {
      const text = typeof part.text === 'string' ? part.text : '';
      if (text.trim().length === 0) {
        throw new AgentConfigurationError('文本片段不能为空。');
      }
      textChars += Array.from(text).length;
      if (textChars > MAX_USER_TEXT_CHARS) {
        throw new AgentConfigurationError('userMessage 文本片段超过长度上限。');
      }
      hasText = true;
      parts.push({ type: 'text', text });
      continue;
    }
    if (part !== null && typeof part === 'object' && part.type === 'image_url') {
      const url = part.imageUrl !== null && typeof part.imageUrl === 'object'
        ? part.imageUrl.url
        : undefined;
      if (typeof url !== 'string' || !IMAGE_DATA_URL_PATTERN.test(url)) {
        throw new AgentConfigurationError('图片必须是 PNG/JPEG/WebP 的内联 data URL。');
      }
      if (url.length > MAX_IMAGE_DATA_URL_CHARS) {
        throw new AgentConfigurationError('图片 data URL 超过长度上限。');
      }
      parts.push({ type: 'image_url', imageUrl: { url } });
      continue;
    }
    throw new AgentConfigurationError('userMessage 包含不支持的内容片段。');
  }

  if (!hasText) throw new AgentConfigurationError('userMessage 至少需要一个文本片段。');
  return parts;
}

/** 单次调用 maxTokens：只接受正有限数；其它值视为未配置（保持适配器默认）。 */
function normalizeMaxTokens(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.max(1, Math.floor(value));
}

/** 提取纯文本内容：字符串原样返回；片段数组拼接 text 片段（图片不参与文本）。 */
function assistantText(content: ChatMessageContent | null | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (part !== null && typeof part === 'object' && part.type === 'text' ? part.text : ''))
    .join('');
}

function clampInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
