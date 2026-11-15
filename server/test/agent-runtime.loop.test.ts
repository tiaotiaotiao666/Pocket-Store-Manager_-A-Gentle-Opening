import { describe, expect, it } from 'vitest';
import {
  AgentAbortedError,
  AgentModelError,
  EMPTY_REPLY_NUDGE,
  ToolRegistry,
  defineTool,
  runAgent,
  type ChatCompletionRequest,
  type ChatCompletionResult,
  type ChatMessage,
  type ChatModel,
  type JsonObject,
} from '../src/agent/runtime';

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

interface ScriptedModel {
  model: ChatModel;
  requests: ChatCompletionRequest[];
}

function scriptedModel(results: ChatCompletionResult[]): ScriptedModel {
  const queue = [...results];
  const requests: ChatCompletionRequest[] = [];
  return {
    requests,
    model: {
      name: 'scripted',
      complete: async (request) => {
        requests.push(request);
        const next = queue.shift();
        if (next === undefined) throw new Error('模型脚本已用尽。');
        return next;
      },
    },
  };
}

function toolCallResult(
  calls: Array<{ id: string; name: string; argumentsText: string }>,
  content: string | null = null,
): ChatCompletionResult {
  return {
    message: { role: 'assistant', content, toolCalls: calls },
    finishReason: 'tool_calls',
    model: 'scripted-model',
    latencyMs: 2,
    usage: { promptTokens: 10, completionTokens: 3, totalTokens: 13 },
  };
}

function textResult(text: string): ChatCompletionResult {
  return {
    message: { role: 'assistant', content: text },
    finishReason: 'stop',
    model: 'scripted-model',
    latencyMs: 3,
    usage: { promptTokens: 8, completionTokens: 4, totalTokens: 12 },
  };
}

function run(model: ChatModel, limits = {}) {
  return runAgent({
    model,
    registry: new ToolRegistry().register(echo),
    systemPrompt: '你是测试助手。',
    userMessage: '你好。',
    limits,
  });
}

function toolMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.filter((message) => message.role === 'tool');
}

describe('runAgent：function calling 主循环', () => {
  it('执行工具后把 tool 结果写回模型，并返回最终回复', async () => {
    const { model, requests } = scriptedModel([
      toolCallResult([
        { id: 'call_1', name: 'echo', argumentsText: JSON.stringify({ text: '你好' }) },
      ]),
      textResult('已经记录好了。'),
    ]);

    const result = await run(model);

    expect(result.status).toBe('completed');
    expect(result.stopReason).toBe('final_answer');
    expect(result.reply).toBe('已经记录好了。');
    expect(result.modelCalls).toBe(2);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.ok).toBe(true);
    expect(result.usage.totalTokens).toBe(25);
    expect(result.degraded).toBe(false);

    const secondRequest = requests[1];
    const tools = secondRequest?.messages.filter((message) => message.role === 'tool') ?? [];
    expect(tools).toHaveLength(1);
    expect(tools[0]?.toolCallId).toBe('call_1');
    expect(tools[0]?.content).toContain('"ok":true');
  });

  it('工具失败也补 tool 消息，让模型有机会修正', async () => {
    const { model } = scriptedModel([
      toolCallResult([{ id: 'call_1', name: 'missing_tool', argumentsText: '{}' }]),
      textResult('我换一种方式。'),
    ]);

    const result = await run(model);

    expect(result.toolCalls[0]?.ok).toBe(false);
    expect(result.toolCalls[0]?.errorCode).toBe('TOOL_NOT_FOUND');
    expect(result.reply).toBe('我换一种方式。');
    expect(result.messages.some((message) => message.role === 'tool')).toBe(true);
  });

  it('空回复首次追加提醒，第二次才停止', async () => {
    const { model, requests } = scriptedModel([
      { message: { role: 'assistant', content: '  ' }, finishReason: 'stop', model: 'm', latencyMs: 1 },
      { message: { role: 'assistant', content: '' }, finishReason: 'stop', model: 'm', latencyMs: 1 },
    ]);

    const result = await run(model);

    expect(result.status).toBe('completed');
    expect(result.stopReason).toBe('empty_reply');
    expect(result.reply).toBe('');
    expect(result.degraded).toBe(true);
    expect(result.steps[0]?.note).toBe('empty_reply_nudge');
    expect(requests[1]?.messages.some((message) => message.content === EMPTY_REPLY_NUDGE)).toBe(true);
  });
});

describe('runAgent：循环与上限保护', () => {
  it('相同工具 + 相同参数第 3 次出现时终止，不再执行', async () => {
    const repeated = (id: string) =>
      toolCallResult([{ id, name: 'echo', argumentsText: JSON.stringify({ text: 'same' }) }]);
    const { model } = scriptedModel([repeated('call_1'), repeated('call_2'), repeated('call_3')]);

    const result = await run(model, { maxModelCalls: 6, maxToolCalls: 10 });

    expect(result.status).toBe('limit_reached');
    expect(result.stopReason).toBe('loop_detected');
    expect(result.modelCalls).toBe(3);
    expect(result.toolCalls).toHaveLength(2);

    const last = result.messages[result.messages.length - 1];
    expect(last?.role).toBe('tool');
    expect(last?.toolCallId).toBe('call_3');
    expect(last?.content).toContain('AGENT_LOOP_DETECTED');
  });

  it('一批调用会超过工具总上限时整批不执行', async () => {
    const { model } = scriptedModel([
      toolCallResult([
        { id: 'call_1', name: 'echo', argumentsText: JSON.stringify({ text: 'a' }) },
        { id: 'call_2', name: 'echo', argumentsText: JSON.stringify({ text: 'b' }) },
      ]),
    ]);

    const result = await run(model, { maxToolCalls: 1 });

    expect(result.status).toBe('limit_reached');
    expect(result.stopReason).toBe('max_tool_calls');
    expect(result.toolCalls).toHaveLength(0);
    expect(toolMessages(result.messages)).toHaveLength(2);
    expect(toolMessages(result.messages)[0]?.content).toContain('AGENT_TOOL_CALL_LIMIT');
  });

  it('模型调用次数用尽时标记 max_model_calls', async () => {
    const { model } = scriptedModel([
      toolCallResult([
        { id: 'call_1', name: 'echo', argumentsText: JSON.stringify({ text: 'a' }) },
      ]),
    ]);

    const result = await run(model, { maxModelCalls: 1 });

    expect(result.status).toBe('limit_reached');
    expect(result.stopReason).toBe('max_model_calls');
    expect(result.modelCalls).toBe(1);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.degraded).toBe(true);
  });

  it('最终回复按字符上限截断', async () => {
    const { model } = scriptedModel([textResult('啊'.repeat(150))]);

    const result = await run(model, { maxReplyCharacters: 100 });

    expect(Array.from(result.reply)).toHaveLength(100);
  });
});

describe('runAgent：模型错误与取消', () => {
  it('可重试的模型错误按策略重试', async () => {
    let attempts = 0;
    const model: ChatModel = {
      name: 'retry-model',
      complete: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new AgentModelError('DEEPSEEK_TIMEOUT', '上游超时。', { retryable: true });
        }
        return textResult('重试后成功。');
      },
    };

    const result = await run(model, { modelMaxAttempts: 2, modelRetryBackoffMs: 0 });

    expect(attempts).toBe(2);
    expect(result.status).toBe('completed');
    expect(result.reply).toBe('重试后成功。');
  });

  it('启动前已取消时直接抛出 AgentAbortedError', async () => {
    const controller = new AbortController();
    controller.abort();
    const { model } = scriptedModel([textResult('不会被调用。')]);

    await expect(
      runAgent({
        model,
        registry: new ToolRegistry().register(echo),
        systemPrompt: '你是测试助手。',
        userMessage: '你好。',
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(AgentAbortedError);
  });
});
