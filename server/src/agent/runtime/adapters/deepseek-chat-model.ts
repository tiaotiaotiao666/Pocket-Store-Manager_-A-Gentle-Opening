/**
 * DeepSeek OpenAI 兼容适配器（支持 function calling）。
 *
 * 与现有单轮抽取 Provider 的区别：
 * - 请求体带 tools / tool_choice，assistant 消息可携带 tool_calls；
 * - 返回完整的 ChatCompletionResult，由 runtime 驱动多轮工具调用；
 * - 错误统一映射为 AgentModelError，错误码沿用 DEEPSEEK_*，便于复用现有 HTTP 错误表。
 *
 * 安全边界：Key 只从配置读取；错误 message 与日志不包含上游响应体、Prompt、工具参数或用户原文。
 */

import {
  AgentAbortedError,
  AgentModelError,
} from '../runtime.errors';
import type {
  AgentLogSink,
  AgentTokenUsage,
  AgentToolDescriptor,
  ChatCompletionRequest,
  ChatCompletionResult,
  ChatMessage,
  ChatModel,
  ChatToolCall,
} from '../runtime.types';

export type RuntimeFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type ConfigReader = (key: string) => unknown;

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-chat';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TOKENS = 1_200;
const MIN_MAX_TOKENS = 100;
const MAX_MAX_TOKENS = 4_000;
const MAX_ASSISTANT_CONTENT_CHARS = 20_000;

export interface DeepseekChatSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxTokens: number;
  temperature: number;
  reasoningEffort: string;
}

export interface DeepseekChatModelOptions {
  fetch: RuntimeFetch;
  /** 每次调用时读取，便于配置热更新/测试注入。 */
  settings: DeepseekChatSettings | (() => DeepseekChatSettings);
  logger?: AgentLogSink;
}

export function readDeepseekChatSettings(read: ConfigReader): DeepseekChatSettings {
  const rawBaseUrl = String(read('DEEPSEEK_API_BASE_URL') ?? DEFAULT_BASE_URL).trim();
  const baseUrl = (rawBaseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const rawModel = String(read('DEEPSEEK_MODEL') ?? DEFAULT_MODEL).trim();
  const rawTimeout = Number(read('DEEPSEEK_TIMEOUT_MS') ?? DEFAULT_TIMEOUT_MS);
  const rawMaxTokens = Number(read('DEEPSEEK_MAX_TOKENS') ?? DEFAULT_MAX_TOKENS);

  return {
    baseUrl,
    apiKey: String(read('DEEPSEEK_API_KEY') ?? '').trim(),
    model: rawModel || DEFAULT_MODEL,
    timeoutMs:
      Number.isFinite(rawTimeout) && rawTimeout > 0
        ? Math.min(MAX_TIMEOUT_MS, Math.max(1, Math.floor(rawTimeout)))
        : DEFAULT_TIMEOUT_MS,
    maxTokens:
      Number.isFinite(rawMaxTokens) && rawMaxTokens > 0
        ? Math.min(MAX_MAX_TOKENS, Math.max(MIN_MAX_TOKENS, Math.floor(rawMaxTokens)))
        : DEFAULT_MAX_TOKENS,
    temperature: 0.2,
    reasoningEffort: String(read('DEEPSEEK_REASONING_EFFORT') ?? '').trim(),
  };
}

export class DeepseekChatModel implements ChatModel {
  readonly name = 'deepseek';

  private readonly fetchImpl: RuntimeFetch;
  private readonly resolveSettings: () => DeepseekChatSettings;
  private readonly logger: AgentLogSink | undefined;

  constructor(options: DeepseekChatModelOptions) {
    this.fetchImpl = options.fetch;
    this.resolveSettings =
      typeof options.settings === 'function' ? options.settings : () => options.settings as DeepseekChatSettings;
    this.logger = options.logger;
  }

  async complete(
    request: ChatCompletionRequest,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<ChatCompletionResult> {
    const settings = this.resolveSettings();
    if (!settings.apiKey) {
      throw new AgentModelError('DEEPSEEK_NOT_CONFIGURED', 'DeepSeek 未配置', {
        retryable: false,
      });
    }

    const startedAt = Date.now();
    const controller = new AbortController();
    const parentSignal = options.signal;
    if (parentSignal?.aborted) throw new AgentAbortedError();

    let timedOut = false;
    const timeoutMs =
      typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
        ? Math.max(1, Math.min(settings.timeoutMs, Math.floor(options.timeoutMs)))
        : settings.timeoutMs;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onParentAbort = () => controller.abort();
    parentSignal?.addEventListener('abort', onParentAbort, { once: true });

    const body: Record<string, unknown> = {
      model: settings.model,
      messages: toWireMessages(request.messages),
      temperature: settings.temperature,
      max_tokens: settings.maxTokens,
      stream: false,
      ...(settings.reasoningEffort ? { reasoning_effort: settings.reasoningEffort } : {}),
    };
    if (request.tools !== undefined && request.tools.length > 0) {
      body.tools = toWireTools(request.tools);
      body.tool_choice = 'auto';
    }
    if (request.responseFormat === 'json_object') {
      body.response_format = { type: 'json_object' };
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${settings.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${settings.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (parentSignal?.aborted) throw new AgentAbortedError();
      const aborted = timedOut || (error instanceof Error && error.name === 'AbortError');
      this.logger?.log({
        event: 'deepseek_request_failed',
        level: 'warn',
        model: settings.model,
        latencyMs: Date.now() - startedAt,
        cause: aborted ? 'timeout' : 'network',
      });
      if (aborted) {
        throw new AgentModelError('DEEPSEEK_TIMEOUT', 'DeepSeek 响应超时，请稍后重试。', {
          retryable: true,
          cause: error,
        });
      }
      throw new AgentModelError('DEEPSEEK_UNAVAILABLE', 'DeepSeek 暂时不可访问，请稍后重试。', {
        retryable: true,
        cause: error,
      });
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', onParentAbort);
    }

    let bodyText = '';
    try {
      bodyText = typeof response.text === 'function' ? await response.text() : '';
    } catch {
      bodyText = '';
    }

    const status = Number(response.status ?? 0);
    if (response.ok !== true) {
      this.logger?.log({
        event: 'deepseek_upstream_error',
        level: 'warn',
        model: settings.model,
        status,
        latencyMs: Date.now() - startedAt,
      });
      throw mapUpstreamError(status);
    }

    let payload: unknown = null;
    try {
      payload = bodyText ? (JSON.parse(bodyText) as unknown) : null;
    } catch {
      payload = null;
    }

    const choice = firstChoice(payload);
    const message = choice !== null && isPlainObject(choice.message) ? choice.message : null;
    if (message === null) {
      this.logger?.log({
        event: 'deepseek_response_invalid',
        level: 'warn',
        model: settings.model,
        latencyMs: Date.now() - startedAt,
      });
      throw invalidResponseError();
    }

    const content = truncateCharacters(extractTextContent(message.content), MAX_ASSISTANT_CONTENT_CHARS);
    const toolCalls = extractToolCalls(message.tool_calls);
    if (content.trim().length === 0 && toolCalls.length === 0) {
      throw invalidResponseError();
    }

    const latencyMs = Math.max(0, Date.now() - startedAt);
    const result: ChatCompletionResult = {
      message: {
        role: 'assistant',
        content: content.length > 0 ? content : null,
        ...(toolCalls.length === 0 ? {} : { toolCalls }),
      },
      finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : '',
      model: isPlainObject(payload) && typeof payload.model === 'string' ? payload.model : settings.model,
      usage: extractUsage(payload),
      latencyMs,
    };

    this.logger?.log({
      event: 'deepseek_chat_ok',
      model: result.model,
      latencyMs,
      finishReason: result.finishReason,
      hasToolCalls: toolCalls.length > 0,
      toolCallCount: toolCalls.length,
      promptTokens: result.usage?.promptTokens ?? 0,
      completionTokens: result.usage?.completionTokens ?? 0,
    });

    return result;
  }
}

function toWireMessages(messages: readonly ChatMessage[]): Record<string, unknown>[] {
  return messages.map((message) => {
    if (message.role === 'assistant') {
      return {
        role: 'assistant',
        content: message.content ?? null,
        ...(message.toolCalls === undefined || message.toolCalls.length === 0
          ? {}
          : {
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: call.argumentsText },
            })),
          }),
      };
    }
    if (message.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: message.toolCallId ?? '',
        content: message.content ?? '',
      };
    }
    if (message.role === 'system') {
      return { role: 'system', content: message.content ?? '' };
    }
    return { role: 'user', content: message.content ?? '' };
  });
}

function toWireTools(tools: readonly AgentToolDescriptor[]): Record<string, unknown>[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

function firstChoice(payload: unknown): Record<string, unknown> | null {
  if (!isPlainObject(payload)) return null;
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  return isPlainObject(first) ? first : null;
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((item) => (isPlainObject(item) && typeof item.text === 'string' ? item.text : ''))
      .join('')
      .trim();
  }
  return '';
}

function extractToolCalls(value: unknown): ChatToolCall[] {
  if (!Array.isArray(value)) return [];
  const calls: ChatToolCall[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!isPlainObject(item)) continue;
    const fn = isPlainObject(item.function) ? item.function : {};
    const name = typeof fn.name === 'string' ? fn.name.trim() : '';
    let argumentsText = '{}';
    if (typeof fn.arguments === 'string') {
      argumentsText = fn.arguments;
    } else if (isPlainObject(fn.arguments) || Array.isArray(fn.arguments)) {
      try {
        argumentsText = JSON.stringify(fn.arguments);
      } catch {
        argumentsText = '{}';
      }
    }
    const id =
      typeof item.id === 'string' && item.id.trim().length > 0
        ? item.id.trim()
        : `call_remote_${index + 1}`;
    calls.push({ id, name, argumentsText });
  }
  return calls;
}

function extractUsage(payload: unknown): AgentTokenUsage | undefined {
  if (!isPlainObject(payload)) return undefined;
  const usage = payload.usage;
  if (!isPlainObject(usage)) return undefined;
  const promptTokens = nonNegativeInteger(usage.prompt_tokens);
  const completionTokens = nonNegativeInteger(usage.completion_tokens);
  const totalTokens = nonNegativeInteger(usage.total_tokens) || promptTokens + completionTokens;
  return { promptTokens, completionTokens, totalTokens };
}

function nonNegativeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function truncateCharacters(text: string, maxCharacters: number): string {
  const characters = Array.from(text);
  if (characters.length <= maxCharacters) return text;
  return characters.slice(0, maxCharacters).join('');
}

function mapUpstreamError(status: number): AgentModelError {
  if (status === 401 || status === 403) {
    return new AgentModelError('DEEPSEEK_AUTH_FAILED', 'DeepSeek 鉴权失败，请检查服务端模型配置。', {
      retryable: false,
      status,
    });
  }
  if (status === 429) {
    return new AgentModelError('DEEPSEEK_RATE_LIMITED', 'DeepSeek 请求过于频繁，请稍后重试。', {
      retryable: true,
      status,
    });
  }
  if (status >= 500) {
    return new AgentModelError('DEEPSEEK_UPSTREAM_ERROR', 'DeepSeek 服务暂时不可用，请稍后重试。', {
      retryable: true,
      status,
    });
  }
  return new AgentModelError('DEEPSEEK_REQUEST_REJECTED', 'DeepSeek 未接受这次请求，请稍后重试。', {
    retryable: false,
    status,
  });
}

function invalidResponseError(): AgentModelError {
  return new AgentModelError(
    'DEEPSEEK_RESPONSE_INVALID',
    'DeepSeek 返回内容无法识别，请稍后重试。',
    { retryable: true },
  );
}
