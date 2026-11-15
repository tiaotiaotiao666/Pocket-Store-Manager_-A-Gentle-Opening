/**
 * 工具执行器：把模型返回的 tool_call 变成一段确定、可审计的执行结果。
 *
 * 每个调用依次经过：
 * 1. 参数大小/JSON 解析/对象形状检查；
 * 2. 工具存在性与参数 schema 校验；
 * 3. 可选审批；
 * 4. 超时 + 重试 + 取消信号；
 * 5. 结果 JSON 化与字节截断。
 *
 * 任何一步失败都会变成一条结构化 tool 消息，而不是让整个会话中断——
 * 模型因此有机会修正参数或换一种策略；只有取消信号会让调用以 AGENT_ABORTED 结束。
 */

import { isJsonObject, validateJsonValue, type JsonObject } from './json-schema';
import { byteLengthUtf8, truncateCharacters, truncateUtf8 } from './json-utils';
import {
  AGENT_TOOL_ERROR_CODES,
  AgentAbortedError,
  AgentError,
  AgentToolError,
  AgentToolTimeoutError,
} from './runtime.errors';
import type { AgentLogSink } from './runtime.types';
import type {
  AgentTool,
  AgentToolApprovalHook,
  AgentToolContext,
  ToolRegistry,
} from './tool-registry';

export const DEFAULT_TOOL_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_TOOL_RESULT_BYTES = 16 * 1024;
export const DEFAULT_MAX_PARALLEL_TOOL_CALLS = 4;
export const MAX_TOOL_ARGUMENT_BYTES = 64 * 1024;

const MIN_TOOL_RESULT_BYTES = 256;
const MAX_TOOL_RESULT_BYTES = 1024 * 1024;
const MAX_ERROR_MESSAGE_CHARS = 300;
const MAX_VALIDATION_ISSUES_IN_RESULT = 10;
const MAX_ECHOED_TOOL_NAME_CHARS = 48;

export interface AgentToolCallRequest {
  id: string;
  name: string;
  /** 模型返回的原始 arguments 字符串（通常是一段 JSON）。 */
  argumentsText: string;
}

export interface AgentToolCallTrace {
  callId: string;
  name: string;
  ok: boolean;
  errorCode?: string;
  latencyMs: number;
  attempts: number;
  inputBytes: number;
  outputBytes: number;
  truncated: boolean;
}

export interface AgentToolCallOutcome {
  trace: AgentToolCallTrace;
  /** 始终是合法 JSON 文本：成功为 {ok:true,result}，失败为 {ok:false,error}。 */
  content: string;
}

export interface AgentToolBatchContext {
  runId: string;
  requestId: string;
  step: number;
  signal: AbortSignal;
  logger: AgentLogSink;
  metadata?: Readonly<Record<string, string>>;
  approval?: AgentToolApprovalHook;
}

export interface ToolExecutorOptions {
  registry: ToolRegistry;
  maxResultBytes?: number;
  defaultTimeoutMs?: number;
  maxParallelCalls?: number;
  /** 测试注入，默认使用 setTimeout。 */
  sleep?: (ms: number) => Promise<void>;
}

export class ToolExecutor {
  private readonly registry: ToolRegistry;
  private readonly maxResultBytes: number;
  private readonly defaultTimeoutMs: number;
  private readonly maxParallelCalls: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: ToolExecutorOptions) {
    this.registry = options.registry;
    this.maxResultBytes = clampInteger(
      options.maxResultBytes,
      DEFAULT_MAX_TOOL_RESULT_BYTES,
      MIN_TOOL_RESULT_BYTES,
      MAX_TOOL_RESULT_BYTES,
    );
    this.defaultTimeoutMs = clampInteger(
      options.defaultTimeoutMs,
      DEFAULT_TOOL_TIMEOUT_MS,
      100,
      120_000,
    );
    this.maxParallelCalls = clampInteger(
      options.maxParallelCalls,
      DEFAULT_MAX_PARALLEL_TOOL_CALLS,
      1,
      8,
    );
    this.sleep =
      options.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  async executeBatch(
    calls: readonly AgentToolCallRequest[],
    context: AgentToolBatchContext,
  ): Promise<AgentToolCallOutcome[]> {
    if (calls.length === 0) return [];

    const concurrency = this.resolveConcurrency(calls);
    if (concurrency <= 1) {
      const outcomes: AgentToolCallOutcome[] = [];
      for (const call of calls) {
        if (context.signal.aborted) {
          outcomes.push(this.abortedOutcome(call));
        } else {
          outcomes.push(await this.executeOne(call, context));
        }
      }
      return outcomes;
    }

    return mapWithConcurrency(calls, concurrency, async (call) =>
      context.signal.aborted ? this.abortedOutcome(call) : this.executeOne(call, context),
    );
  }

  /**
   * 只要一批调用里出现未知工具或非并发安全工具，就整批串行。
   * 这比“读操作并发、写操作串行”的实现更简单，也避免同一批中读写交错产生意外顺序。
   */
  private resolveConcurrency(calls: readonly AgentToolCallRequest[]): number {
    if (this.maxParallelCalls <= 1) return 1;
    for (const call of calls) {
      const tool = this.registry.get(call.name);
      if (tool === undefined || !tool.concurrencySafe) return 1;
    }
    return Math.min(this.maxParallelCalls, calls.length);
  }

  private async executeOne(
    call: AgentToolCallRequest,
    context: AgentToolBatchContext,
  ): Promise<AgentToolCallOutcome> {
    const startedAt = Date.now();
    const inputBytes = byteLengthUtf8(call.argumentsText);
    let tool: AgentTool | undefined;
    let attempts = 0;

    try {
      if (call.argumentsText.trim().length === 0) {
        throw new AgentToolError(
          AGENT_TOOL_ERROR_CODES.argumentsInvalid,
          '工具参数不能为空，必须是 JSON 对象字符串。',
        );
      }
      if (inputBytes > MAX_TOOL_ARGUMENT_BYTES) {
        throw new AgentToolError(
          AGENT_TOOL_ERROR_CODES.argumentsTooLarge,
          `工具参数超过 ${MAX_TOOL_ARGUMENT_BYTES} 字节。`,
        );
      }

      tool = this.registry.get(call.name);
      if (tool === undefined) {
        throw new AgentToolError(
          AGENT_TOOL_ERROR_CODES.notFound,
          this.unknownToolMessage(call.name),
        );
      }

      const parsed = parseArguments(call.argumentsText);
      if (!isJsonObject(parsed)) {
        throw new AgentToolError(
          AGENT_TOOL_ERROR_CODES.argumentsInvalid,
          '工具参数必须是 JSON 对象（不能是数组、字符串或 null）。',
        );
      }
      const args: JsonObject = parsed;

      const issues = validateJsonValue(tool.parameters, args, { path: '$' });
      if (issues.length > 0) {
        throw new AgentToolError(
          AGENT_TOOL_ERROR_CODES.argumentsInvalid,
          '工具参数不符合契约，请按 issues 修正后重试。',
          { details: { issues: issues.slice(0, MAX_VALIDATION_ISSUES_IN_RESULT) } },
        );
      }

      if (tool.requiresApproval) {
        const approved = await this.requestApproval(tool, call, args, context);
        if (!approved) {
          throw new AgentToolError(
            AGENT_TOOL_ERROR_CODES.denied,
            `已拒绝执行工具 "${tool.name}"。`,
          );
        }
      }

      const execution = await this.runWithPolicy(
        tool,
        args,
        call,
        context,
        (currentAttempt) => {
          attempts = currentAttempt;
        },
      );
      attempts = execution.attempts;
      const serialized = this.serializeResult(execution.value);
      return this.finish(
        call,
        tool.name,
        true,
        serialized.content,
        serialized.truncated,
        startedAt,
        inputBytes,
        attempts,
        undefined,
        context,
      );
    } catch (error) {
      const normalized = normalizeToolError(error);
      const serialized = this.serializeError(normalized);
      return this.finish(
        call,
        tool?.name ?? displayToolName(call.name),
        false,
        serialized,
        false,
        startedAt,
        inputBytes,
        attempts,
        normalized.code,
        context,
      );
    }
  }

  private finish(
    call: AgentToolCallRequest,
    toolName: string,
    ok: boolean,
    content: string,
    truncated: boolean,
    startedAt: number,
    inputBytes: number,
    attempts: number,
    errorCode: string | undefined,
    context: AgentToolBatchContext,
  ): AgentToolCallOutcome {
    const trace: AgentToolCallTrace = {
      callId: call.id,
      name: toolName,
      ok,
      ...(errorCode === undefined ? {} : { errorCode }),
      latencyMs: Date.now() - startedAt,
      attempts,
      inputBytes,
      outputBytes: byteLengthUtf8(content),
      truncated,
    };
    context.logger.log({
      event: 'tool_call',
      level: ok ? 'debug' : 'warn',
      runId: context.runId,
      requestId: context.requestId,
      step: context.step,
      callId: call.id,
      tool: toolName,
      ok,
      errorCode,
      latencyMs: trace.latencyMs,
      attempts,
      inputBytes,
      outputBytes: trace.outputBytes,
      truncated,
    });
    return { trace, content };
  }

  private abortedOutcome(call: AgentToolCallRequest): AgentToolCallOutcome {
    const error = new AgentAbortedError();
    const content = this.serializeError(error);
    return {
      trace: {
        callId: call.id,
        name: displayToolName(call.name),
        ok: false,
        errorCode: error.code,
        latencyMs: 0,
        attempts: 0,
        inputBytes: byteLengthUtf8(call.argumentsText),
        outputBytes: byteLengthUtf8(content),
        truncated: false,
      },
      content,
    };
  }

  private unknownToolMessage(name: string): string {
    const available = this.registry
      .list()
      .map((tool) => tool.name)
      .slice(0, 12);
    const suffix = available.length > 0 ? available.join('、') : '（无）';
    return `未知工具 "${displayToolName(name)}"。可用工具：${suffix}。`;
  }

  private async requestApproval(
    tool: AgentTool,
    call: AgentToolCallRequest,
    args: JsonObject,
    context: AgentToolBatchContext,
  ): Promise<boolean> {
    if (context.approval === undefined) {
      throw new AgentToolError(
        AGENT_TOOL_ERROR_CODES.approvalRequired,
        `工具 "${tool.name}" 需要人工确认，但当前未配置审批通道，已跳过执行。`,
      );
    }
    if (context.signal.aborted) throw new AgentAbortedError();

    let rejectAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(new AgentAbortedError());
      context.signal.addEventListener('abort', rejectAbort, { once: true });
    });

    try {
      const decision = context.approval({
        tool: tool.name,
        callId: call.id,
        step: context.step,
        arguments: args,
        description: tool.description,
      });
      return await Promise.race([Promise.resolve(decision), aborted]);
    } catch (error) {
      if (error instanceof AgentAbortedError) throw error;
      context.logger.log({
        event: 'tool_approval_error',
        level: 'warn',
        runId: context.runId,
        requestId: context.requestId,
        step: context.step,
        tool: tool.name,
      });
      return false;
    } finally {
      if (rejectAbort !== undefined) {
        context.signal.removeEventListener('abort', rejectAbort);
      }
    }
  }

  private async runWithPolicy(
    tool: AgentTool,
    args: JsonObject,
    call: AgentToolCallRequest,
    context: AgentToolBatchContext,
    onAttempt: (attempt: number) => void,
  ): Promise<{ value: Awaited<ReturnType<AgentTool['execute']>>; attempts: number }> {
    const maxAttempts = tool.retry?.maxAttempts ?? 1;
    const timeoutMs = tool.timeoutMs ?? this.defaultTimeoutMs;
    let attempt = 0;
    let lastError: unknown;

    while (attempt < maxAttempts) {
      attempt += 1;
      onAttempt(attempt);
      try {
        const value = await this.executeOnce(tool, args, call, context, timeoutMs);
        return { value, attempts: attempt };
      } catch (error) {
        lastError = error;
        if (!this.shouldRetry(tool, error, attempt, context.signal)) break;
        const backoffMs = (tool.retry?.backoffMs ?? 200) * 2 ** (attempt - 1);
        context.logger.log({
          event: 'tool_retry',
          level: 'warn',
          runId: context.runId,
          requestId: context.requestId,
          step: context.step,
          callId: call.id,
          tool: tool.name,
          attempt,
          backoffMs,
          code: error instanceof AgentError ? error.code : 'UNKNOWN_ERROR',
        });
        await this.sleep(backoffMs);
      }
    }

    throw lastError;
  }

  private shouldRetry(
    tool: AgentTool,
    error: unknown,
    attempt: number,
    signal: AbortSignal,
  ): boolean {
    if (signal.aborted) return false;
    const maxAttempts = tool.retry?.maxAttempts ?? 1;
    if (attempt >= maxAttempts) return false;
    if (error instanceof AgentAbortedError) return false;
    if (error instanceof AgentToolTimeoutError) {
      return tool.retry?.retryOnTimeout === true;
    }
    if (error instanceof AgentToolError) return error.retryable;
    return false;
  }

  private async executeOnce(
    tool: AgentTool,
    args: JsonObject,
    call: AgentToolCallRequest,
    context: AgentToolBatchContext,
    timeoutMs: number,
  ): Promise<Awaited<ReturnType<AgentTool['execute']>>> {
    if (context.signal.aborted) throw new AgentAbortedError();

    const controller = new AbortController();
    const abortFromParent = () => controller.abort(context.signal.reason);
    context.signal.addEventListener('abort', abortFromParent, { once: true });

    const timeoutError = new AgentToolTimeoutError(tool.name, timeoutMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectAbort: (() => void) | undefined;
    let timedOut = false;

    try {
      const execution = Promise.resolve().then(() =>
        tool.execute(args, {
          runId: context.runId,
          requestId: context.requestId,
          step: context.step,
          signal: controller.signal,
          logger: context.logger,
          metadata: context.metadata ?? {},
        }),
      );

      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort(timeoutError);
          reject(timeoutError);
        }, timeoutMs);
      });

      const aborted = new Promise<never>((_, reject) => {
        rejectAbort = () => reject(new AgentAbortedError());
        if (context.signal.aborted) rejectAbort();
        else context.signal.addEventListener('abort', rejectAbort, { once: true });
      });

      try {
        return await Promise.race([execution, deadline, aborted]);
      } catch (error) {
        if (context.signal.aborted) throw new AgentAbortedError();
        if (timedOut) throw timeoutError;
        throw error;
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (rejectAbort !== undefined) {
        context.signal.removeEventListener('abort', rejectAbort);
      }
      context.signal.removeEventListener('abort', abortFromParent);
    }
  }

  private serializeResult(value: unknown): { content: string; truncated: boolean } {
    let serialized: string;
    try {
      const json = JSON.stringify({ ok: true, result: value === undefined ? null : value });
      serialized = typeof json === 'string' ? json : '{"ok":true,"result":null}';
    } catch {
      return {
        content: this.serializeError(
          new AgentToolError(
            AGENT_TOOL_ERROR_CODES.resultInvalid,
            '工具返回值无法序列化为 JSON。',
          ),
        ),
        truncated: false,
      };
    }

    if (byteLengthUtf8(serialized) <= this.maxResultBytes) {
      return { content: serialized, truncated: false };
    }

    const preview = truncateUtf8(serialized, Math.max(0, this.maxResultBytes - 240));
    const content = JSON.stringify({
      ok: true,
      truncated: true,
      preview,
      note: `工具结果超过 ${this.maxResultBytes} 字节，已截断。`,
    });
    return { content, truncated: true };
  }

  private serializeError(error: AgentError): string {
    const message = truncateCharacters(error.message, MAX_ERROR_MESSAGE_CHARS);
    const base = {
      ok: false,
      error: {
        code: error.code,
        message,
      },
    };
    let content = JSON.stringify(base);
    if (byteLengthUtf8(content) > this.maxResultBytes) {
      return JSON.stringify({
        ok: false,
        error: { code: error.code, message: truncateCharacters(message, 80) },
      });
    }
    if (error.details !== undefined) {
      const withDetails = JSON.stringify({
        ok: false,
        error: { code: error.code, message, details: error.details },
      });
      if (byteLengthUtf8(withDetails) <= this.maxResultBytes) content = withDetails;
    }
    return content;
  }
}

function parseArguments(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AgentToolError(
      AGENT_TOOL_ERROR_CODES.argumentsInvalid,
      '工具参数不是合法 JSON，请输出一个 JSON 对象作为 arguments。',
    );
  }
}

function normalizeToolError(error: unknown): AgentError {
  if (error instanceof AgentAbortedError) return error;
  if (error instanceof AgentToolTimeoutError) return error;
  if (error instanceof AgentToolError) return error;
  if (error instanceof AgentError) {
    return new AgentToolError(
      AGENT_TOOL_ERROR_CODES.executionFailed,
      '工具执行失败，请稍后重试或换一种方式。',
    );
  }
  return new AgentToolError(
    AGENT_TOOL_ERROR_CODES.executionFailed,
    '工具执行失败，请稍后重试或换一种方式。',
  );
}

function displayToolName(name: string): string {
  return truncateCharacters(name.trim(), MAX_ECHOED_TOOL_NAME_CHARS);
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

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index] as T, index);
    }
  });
  await Promise.all(runners);
  return results;
}

export type { AgentTool };
