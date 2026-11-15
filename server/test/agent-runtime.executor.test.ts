import { describe, expect, it } from 'vitest';
import {
  AGENT_TOOL_ERROR_CODES,
  AgentToolError,
  NOOP_AGENT_LOGGER,
  ToolExecutor,
  ToolRegistry,
  defineTool,
  type AgentToolBatchContext,
  type AgentToolCallRequest,
  type JsonObject,
} from '../src/agent/runtime';

function createContext(overrides: Partial<AgentToolBatchContext> = {}): AgentToolBatchContext {
  return {
    runId: 'run_test',
    requestId: 'req_test',
    step: 1,
    signal: new AbortController().signal,
    logger: NOOP_AGENT_LOGGER,
    metadata: {},
    ...overrides,
  };
}

const echo = defineTool<JsonObject>({
  name: 'echo',
  description: '回显文本。',
  sideEffect: 'read',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
  execute: (args) => ({ text: args.text }),
});

function call(name: string, args: unknown, id = `call_${name}`): AgentToolCallRequest {
  return {
    id,
    name,
    argumentsText: typeof args === 'string' ? args : JSON.stringify(args),
  };
}

describe('ToolExecutor：参数与注册表', () => {
  it('执行成功时返回结构化结果并记录 trace', async () => {
    const registry = new ToolRegistry().register(echo);
    const executor = new ToolExecutor({ registry });
    const [outcome] = await executor.executeBatch([call('echo', { text: '你好' })], createContext());

    expect(outcome?.trace.ok).toBe(true);
    expect(outcome?.trace.name).toBe('echo');
    expect(outcome?.trace.attempts).toBe(1);
    expect(JSON.parse(outcome?.content ?? '{}')).toEqual({ ok: true, result: { text: '你好' } });
  });

  it('未知工具变成 TOOL_NOT_FOUND，而不是抛异常', async () => {
    const executor = new ToolExecutor({ registry: new ToolRegistry().register(echo) });
    const [outcome] = await executor.executeBatch([call('delete_store', {})], createContext());

    expect(outcome?.trace.ok).toBe(false);
    expect(outcome?.trace.errorCode).toBe(AGENT_TOOL_ERROR_CODES.notFound);
    expect(outcome?.content).toContain('未知工具');
  });

  it('空参数、非法 JSON、非对象参数分别给出明确错误', async () => {
    const executor = new ToolExecutor({ registry: new ToolRegistry().register(echo) });
    const outcomes = await executor.executeBatch(
      [
        call('echo', '', 'call_empty'),
        call('echo', '{not json', 'call_json'),
        call('echo', '[1,2]', 'call_array'),
      ],
      createContext(),
    );

    expect(outcomes.map((item) => item.trace.errorCode)).toEqual([
      AGENT_TOOL_ERROR_CODES.argumentsInvalid,
      AGENT_TOOL_ERROR_CODES.argumentsInvalid,
      AGENT_TOOL_ERROR_CODES.argumentsInvalid,
    ]);
  });

  it('schema 不符时把问题路径回传给模型', async () => {
    const executor = new ToolExecutor({ registry: new ToolRegistry().register(echo) });
    const [outcome] = await executor.executeBatch(
      [call('echo', { text: 42 })],
      createContext(),
    );

    expect(outcome?.trace.errorCode).toBe(AGENT_TOOL_ERROR_CODES.argumentsInvalid);
    const body = JSON.parse(outcome?.content ?? '{}') as {
      error?: { details?: { issues?: Array<{ path: string }> } };
    };
    expect(body.error?.details?.issues?.[0]?.path).toBe('$.text');
  });
});

describe('ToolExecutor：审批、超时与重试', () => {
  it('需要审批但无审批通道时拒绝执行', async () => {
    let executions = 0;
    const approvalTool = defineTool<JsonObject>({
      name: 'approval_tool',
      description: '需要审批的写操作。',
      sideEffect: 'write',
      requiresApproval: true,
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      execute: () => {
        executions += 1;
        return { done: true };
      },
    });

    const executor = new ToolExecutor({ registry: new ToolRegistry().register(approvalTool) });
    const [outcome] = await executor.executeBatch([call('approval_tool', {})], createContext());

    expect(outcome?.trace.errorCode).toBe(AGENT_TOOL_ERROR_CODES.approvalRequired);
    expect(executions).toBe(0);
  });

  it('审批钩子返回 false 时给出 TOOL_DENIED', async () => {
    const approvalTool = defineTool<JsonObject>({
      name: 'approval_tool',
      description: '需要审批的写操作。',
      sideEffect: 'write',
      requiresApproval: true,
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      execute: () => ({ done: true }),
    });

    const executor = new ToolExecutor({ registry: new ToolRegistry().register(approvalTool) });
    const [outcome] = await executor.executeBatch(
      [call('approval_tool', {})],
      createContext({ approval: () => false }),
    );

    expect(outcome?.trace.errorCode).toBe(AGENT_TOOL_ERROR_CODES.denied);
  });

  it('可重试的工具按策略重试并累计 attempts', async () => {
    let attempts = 0;
    const flaky = defineTool<JsonObject>({
      name: 'flaky_tool',
      description: '第一次失败、第二次成功。',
      sideEffect: 'read',
      retry: { maxAttempts: 2, backoffMs: 1 },
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      execute: () => {
        attempts += 1;
        if (attempts === 1) {
          throw new AgentToolError(
            AGENT_TOOL_ERROR_CODES.executionFailed,
            '下游临时失败。',
            { retryable: true },
          );
        }
        return { attempts };
      },
    });

    const executor = new ToolExecutor({
      registry: new ToolRegistry().register(flaky),
      sleep: async () => undefined,
    });
    const [outcome] = await executor.executeBatch([call('flaky_tool', {})], createContext());

    expect(attempts).toBe(2);
    expect(outcome?.trace.ok).toBe(true);
    expect(outcome?.trace.attempts).toBe(2);
    expect(JSON.parse(outcome?.content ?? '{}')).toEqual({ ok: true, result: { attempts: 2 } });
  });

  it('超时默认不重试；retryOnTimeout 后才重试', async () => {
    let started = 0;
    const slow = defineTool<JsonObject>({
      name: 'slow_tool',
      description: '永不返回。',
      sideEffect: 'read',
      timeoutMs: 100,
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      execute: () => {
        started += 1;
        return new Promise<never>(() => undefined);
      },
    });

    const executor = new ToolExecutor({
      registry: new ToolRegistry().register(slow),
      sleep: async () => undefined,
    });
    const [outcome] = await executor.executeBatch([call('slow_tool', {})], createContext());

    expect(started).toBe(1);
    expect(outcome?.trace.errorCode).toBe(AGENT_TOOL_ERROR_CODES.timedOut);
  });

  it('retryOnTimeout: true 时超时会重试', async () => {
    let started = 0;
    const slow = defineTool<JsonObject>({
      name: 'slow_retry_tool',
      description: '超时后重试。',
      sideEffect: 'read',
      timeoutMs: 100,
      retry: { maxAttempts: 2, retryOnTimeout: true, backoffMs: 1 },
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      execute: () => {
        started += 1;
        return new Promise<never>(() => undefined);
      },
    });

    const executor = new ToolExecutor({
      registry: new ToolRegistry().register(slow),
      sleep: async () => undefined,
    });
    const [outcome] = await executor.executeBatch([call('slow_retry_tool', {})], createContext());

    expect(started).toBe(2);
    expect(outcome?.trace.errorCode).toBe(AGENT_TOOL_ERROR_CODES.timedOut);
    expect(outcome?.trace.attempts).toBe(2);
  });
});

describe('ToolExecutor：结果边界与取消', () => {
  it('超过字节上限的结果被截断，避免撑爆上下文', async () => {
    const big = defineTool<JsonObject>({
      name: 'big_tool',
      description: '返回大结果。',
      sideEffect: 'read',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      execute: () => ({ text: 'x'.repeat(400) }),
    });

    const executor = new ToolExecutor({
      registry: new ToolRegistry().register(big),
      maxResultBytes: 256,
    });
    const [outcome] = await executor.executeBatch([call('big_tool', {})], createContext());
    const body = JSON.parse(outcome?.content ?? '{}') as { ok?: boolean; truncated?: boolean };

    expect(outcome?.trace.truncated).toBe(true);
    expect(body.ok).toBe(true);
    expect(body.truncated).toBe(true);
  });

  it('工具内部异常不会把原始 message 回显给模型', async () => {
    const secret = defineTool<JsonObject>({
      name: 'secret_tool',
      description: '内部异常。',
      sideEffect: 'read',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      execute: () => {
        throw new Error('secret-value-123');
      },
    });

    const executor = new ToolExecutor({ registry: new ToolRegistry().register(secret) });
    const [outcome] = await executor.executeBatch([call('secret_tool', {})], createContext());

    expect(outcome?.trace.errorCode).toBe(AGENT_TOOL_ERROR_CODES.executionFailed);
    expect(outcome?.content).not.toContain('secret-value-123');
  });

  it('父级取消后不执行工具，返回 AGENT_ABORTED', async () => {
    let executions = 0;
    const counted = defineTool<JsonObject>({
      name: 'counted_tool',
      description: '统计执行次数。',
      sideEffect: 'read',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      execute: () => {
        executions += 1;
        return { executions };
      },
    });

    const controller = new AbortController();
    controller.abort();
    const executor = new ToolExecutor({ registry: new ToolRegistry().register(counted) });
    const outcomes = await executor.executeBatch(
      [call('counted_tool', {}), call('counted_tool', {}, 'call_2')],
      createContext({ signal: controller.signal }),
    );

    expect(executions).toBe(0);
    expect(outcomes.map((item) => item.trace.errorCode)).toEqual(['AGENT_ABORTED', 'AGENT_ABORTED']);
  });
});
