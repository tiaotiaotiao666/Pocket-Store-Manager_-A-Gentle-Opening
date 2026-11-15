/**
 * 工具定义与注册表。
 *
 * 设计要点：
 * - 工具是普通对象 + 纯函数 execute，不依赖 Nest 容器；
 * - 参数契约在注册时做静态检查（根对象、关键字白名单、required 声明），
 *   避免把错误的 schema 发给模型后才发现工具永远无法被正确调用；
 * - 执行策略（超时、重试、并发、审批）是工具元数据，不暴露给模型。
 */

import {
  collectToolParametersSchemaProblems,
  type JsonObject,
  type JsonSchema,
  type JsonValue,
} from './json-schema';
import { AgentConfigurationError } from './runtime.errors';
import type { AgentLogSink, AgentToolDescriptor } from './runtime.types';

export const TOOL_NAME_MAX_LENGTH = 48;
export const TOOL_TITLE_MAX_LENGTH = 80;
export const TOOL_DESCRIPTION_MIN_LENGTH = 4;
export const TOOL_DESCRIPTION_MAX_LENGTH = 2_000;
export const MAX_REGISTERED_TOOLS = 32;
export const MAX_TOOL_PARAMETERS_BYTES = 16 * 1024;
export const MIN_TOOL_TIMEOUT_MS = 100;
export const MAX_TOOL_TIMEOUT_MS = 120_000;
export const MAX_TOOL_ATTEMPTS = 4;
export const MIN_TOOL_BACKOFF_MS = 0;
export const MAX_TOOL_BACKOFF_MS = 10_000;

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{1,47}$/;

export interface AgentToolContext {
  runId: string;
  requestId: string;
  /** 当前模型调用轮次，从 1 开始。 */
  step: number;
  signal: AbortSignal;
  logger: AgentLogSink;
  /** 只读元数据，可用于多租户/追踪，不允许写回。 */
  metadata: Readonly<Record<string, string>>;
}

export interface AgentToolApprovalRequest {
  tool: string;
  callId: string;
  step: number;
  arguments: JsonObject;
  description: string;
}

/** 返回 true 才执行；抛错视为拒绝。未提供钩子时，需审批的工具一律拒绝。 */
export type AgentToolApprovalHook = (
  request: AgentToolApprovalRequest,
) => Promise<boolean> | boolean;

export interface AgentToolRetryPolicy {
  /** 总尝试次数，含首次执行。1 表示不重试。 */
  maxAttempts: number;
  /** 指数退避基数，默认 200ms。 */
  backoffMs?: number;
  /** 超时是否重试，默认 false（超时通常意味着下游已经拥塞）。 */
  retryOnTimeout?: boolean;
}

export interface AgentToolDefinition<Args extends JsonObject = JsonObject> {
  name: string;
  title?: string;
  description: string;
  parameters: JsonSchema;
  /** 单次执行超时，默认由执行器决定（15s）。 */
  timeoutMs?: number;
  retry?: AgentToolRetryPolicy;
  /** read 可并发；write 默认串行执行，避免同一状态上的竞态。 */
  sideEffect: 'read' | 'write';
  concurrencySafe?: boolean;
  requiresApproval?: boolean;
  execute(
    args: Args,
    context: AgentToolContext,
  ): Promise<JsonValue | void> | JsonValue | void;
}

export interface AgentTool {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly parameters: JsonSchema;
  readonly timeoutMs?: number;
  readonly retry?: Readonly<AgentToolRetryPolicy>;
  readonly sideEffect: 'read' | 'write';
  readonly concurrencySafe: boolean;
  readonly requiresApproval: boolean;
  execute(args: JsonObject, context: AgentToolContext): Promise<JsonValue | void>;
}

/**
 * 创建工具。execute 收到的 args 已通过 schema 校验；这里的类型断言是唯一的
 * “schema 声明”到“TS 类型”的桥接点，避免每个工具重复做一次手工校验。
 */
export function defineTool<Args extends JsonObject>(
  definition: AgentToolDefinition<Args>,
): AgentTool {
  return Object.freeze({
    ...definition,
    concurrencySafe: definition.concurrencySafe ?? definition.sideEffect === 'read',
    requiresApproval: definition.requiresApproval ?? false,
    execute: async (args: JsonObject, context: AgentToolContext) =>
      definition.execute(args as Args, context),
  });
}

export function isValidToolName(name: unknown): name is string {
  return typeof name === 'string' && TOOL_NAME_PATTERN.test(name);
}

export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool>();

  register(tool: AgentTool): this {
    validateTool(tool);
    if (this.tools.has(tool.name)) {
      throw new AgentConfigurationError(`工具 "${tool.name}" 重复注册。`);
    }
    if (this.tools.size >= MAX_REGISTERED_TOOLS) {
      throw new AgentConfigurationError(`工具数量超过上限 ${MAX_REGISTERED_TOOLS}。`);
    }
    this.tools.set(tool.name, tool);
    return this;
  }

  registerAll(tools: readonly AgentTool[]): this {
    for (const tool of tools) this.register(tool);
    return this;
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get size(): number {
    return this.tools.size;
  }

  /**
   * 按注册顺序或显式白名单返回工具。白名单中出现未注册工具属于配置错误，
   * 在运行前直接失败，避免模型收到残缺的工具集。
   */
  list(allowNames?: readonly string[]): AgentTool[] {
    if (allowNames === undefined) return [...this.tools.values()];
    const names = [...new Set(allowNames)];
    const unknown = names.filter((name) => !this.tools.has(name));
    if (unknown.length > 0) {
      throw new AgentConfigurationError(
        `工具白名单包含未注册的工具：${unknown.join(', ')}。`,
      );
    }
    return names.map((name) => this.tools.get(name) as AgentTool);
  }

  descriptors(allowNames?: readonly string[]): AgentToolDescriptor[] {
    return this.list(allowNames).map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }
}

function validateTool(tool: AgentTool): void {
  if (!isValidToolName(tool.name)) {
    throw new AgentConfigurationError(
      `工具名 "${String(tool.name)}" 非法：必须匹配 ${TOOL_NAME_PATTERN.source}，且不超过 ${TOOL_NAME_MAX_LENGTH} 字符。`,
    );
  }
  if (tool.title !== undefined) {
    if (typeof tool.title !== 'string' || tool.title.trim().length === 0) {
      throw new AgentConfigurationError(`工具 "${tool.name}" 的 title 必须是非空字符串。`);
    }
    if (tool.title.length > TOOL_TITLE_MAX_LENGTH) {
      throw new AgentConfigurationError(
        `工具 "${tool.name}" 的 title 超过 ${TOOL_TITLE_MAX_LENGTH} 字符。`,
      );
    }
  }
  if (typeof tool.description !== 'string') {
    throw new AgentConfigurationError(`工具 "${tool.name}" 缺少 description。`);
  }
  const descriptionLength = tool.description.trim().length;
  if (descriptionLength < TOOL_DESCRIPTION_MIN_LENGTH) {
    throw new AgentConfigurationError(
      `工具 "${tool.name}" 的 description 过短（至少 ${TOOL_DESCRIPTION_MIN_LENGTH} 字符），模型无法判断何时调用。`,
    );
  }
  if (descriptionLength > TOOL_DESCRIPTION_MAX_LENGTH) {
    throw new AgentConfigurationError(
      `工具 "${tool.name}" 的 description 超过 ${TOOL_DESCRIPTION_MAX_LENGTH} 字符。`,
    );
  }
  if (typeof tool.execute !== 'function') {
    throw new AgentConfigurationError(`工具 "${tool.name}" 缺少 execute 函数。`);
  }
  if (tool.sideEffect !== 'read' && tool.sideEffect !== 'write') {
    throw new AgentConfigurationError(`工具 "${tool.name}" 的 sideEffect 必须是 read 或 write。`);
  }

  const schemaProblems = collectToolParametersSchemaProblems(tool.parameters);
  if (schemaProblems.length > 0) {
    throw new AgentConfigurationError(
      `工具 "${tool.name}" 参数契约非法：${schemaProblems.slice(0, 5).join(' ')}`,
    );
  }

  let parametersBytes: number;
  try {
    const serialized = JSON.stringify(tool.parameters);
    parametersBytes = Buffer.byteLength(serialized ?? '', 'utf8');
  } catch {
    throw new AgentConfigurationError(`工具 "${tool.name}" 参数契约无法序列化。`);
  }
  if (parametersBytes > MAX_TOOL_PARAMETERS_BYTES) {
    throw new AgentConfigurationError(
      `工具 "${tool.name}" 参数契约超过 ${MAX_TOOL_PARAMETERS_BYTES} 字节。`,
    );
  }

  if (tool.timeoutMs !== undefined) {
    if (
      !Number.isInteger(tool.timeoutMs) ||
      tool.timeoutMs < MIN_TOOL_TIMEOUT_MS ||
      tool.timeoutMs > MAX_TOOL_TIMEOUT_MS
    ) {
      throw new AgentConfigurationError(
        `工具 "${tool.name}" 的 timeoutMs 必须是 ${MIN_TOOL_TIMEOUT_MS}–${MAX_TOOL_TIMEOUT_MS} 的整数。`,
      );
    }
  }

  if (tool.retry !== undefined) {
    const { maxAttempts, backoffMs, retryOnTimeout } = tool.retry;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_TOOL_ATTEMPTS) {
      throw new AgentConfigurationError(
        `工具 "${tool.name}" 的 retry.maxAttempts 必须是 1–${MAX_TOOL_ATTEMPTS} 的整数。`,
      );
    }
    if (
      backoffMs !== undefined &&
      (!Number.isInteger(backoffMs) ||
        backoffMs < MIN_TOOL_BACKOFF_MS ||
        backoffMs > MAX_TOOL_BACKOFF_MS)
    ) {
      throw new AgentConfigurationError(
        `工具 "${tool.name}" 的 retry.backoffMs 必须是 ${MIN_TOOL_BACKOFF_MS}–${MAX_TOOL_BACKOFF_MS} 的整数。`,
      );
    }
    if (retryOnTimeout !== undefined && typeof retryOnTimeout !== 'boolean') {
      throw new AgentConfigurationError(
        `工具 "${tool.name}" 的 retry.retryOnTimeout 必须是布尔值。`,
      );
    }
  }
}
