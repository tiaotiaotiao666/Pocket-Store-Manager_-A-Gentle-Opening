/**
 * Runtime 共享类型：日志、模型消息、模型接口。
 * 这里只依赖标准库与 json-schema 类型，不依赖 Nest，方便单测与复用。
 */

import type { JsonSchema } from './json-schema';

export type AgentLogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * 结构化日志事件。约定：
 * - 只记录计数、耗时、错误码、工具名等元数据；
 * - 不记录用户原文、模型回复、工具参数与工具结果；
 * - 具体落盘/输出方式由宿主应用（Nest Logger）决定。
 */
export interface AgentLogEvent {
  event: string;
  level?: AgentLogLevel;
  runId?: string;
  requestId?: string;
  step?: number;
  durationMs?: number;
  [key: string]: unknown;
}

export interface AgentLogSink {
  log(event: AgentLogEvent): void;
}

export const NOOP_AGENT_LOGGER: AgentLogSink = {
  log: () => {
    /* 默认静默，由宿主注入真实 logger */
  },
};

export interface ChatToolCall {
  id: string;
  name: string;
  argumentsText: string;
}

/**
 * 与 OpenAI Chat Completions 对齐的最小消息模型。
 * assistant 消息可同时带 content 和 toolCalls；tool 消息必须带 toolCallId。
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  toolCalls?: readonly ChatToolCall[];
  toolCallId?: string;
  name?: string;
}

/** 暴露给模型的工具描述，不包含执行策略与审批信息。 */
export interface AgentToolDescriptor {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface AgentTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatCompletionRequest {
  messages: readonly ChatMessage[];
  tools?: readonly AgentToolDescriptor[];
  responseFormat?: 'text' | 'json_object';
}

export interface ChatCompletionResult {
  message: ChatMessage;
  finishReason: string;
  model: string;
  usage?: AgentTokenUsage;
  latencyMs: number;
}

export interface ChatModelCallOptions {
  signal?: AbortSignal;
  /** 覆盖适配器默认超时；runtime 通常不传，让适配器使用自身配置。 */
  timeoutMs?: number;
}

export interface ChatModel {
  readonly name: string;
  complete(
    request: ChatCompletionRequest,
    options?: ChatModelCallOptions,
  ): Promise<ChatCompletionResult>;
}

export function emptyTokenUsage(): AgentTokenUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

export function addTokenUsage(
  total: AgentTokenUsage,
  delta: AgentTokenUsage | undefined,
): AgentTokenUsage {
  if (delta === undefined) return total;
  return {
    promptTokens: total.promptTokens + delta.promptTokens,
    completionTokens: total.completionTokens + delta.completionTokens,
    totalTokens: total.totalTokens + delta.totalTokens,
  };
}
