import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AgentConfigurationError,
  DeepseekChatModel,
  ToolRegistry,
  readDeepseekChatSettings,
  runAgent,
} from '../src/agent/runtime';
import type {
  ChatCompletionResult,
  ChatModel,
  RuntimeFetch,
} from '../src/agent/runtime';
import type { DeepseekChatSettings } from '../src/agent/runtime/adapters/deepseek-chat-model';

/**
 * Runtime 多模态与截断语义的定向测试（P1）。
 *
 * 目标：
 * - 无图请求的 wire shape 与旧行为逐字段一致；
 * - 有图请求使用 DEEPSEEK_VISION_MODEL，并发送类型化 text + image_url；
 * - finish_reason=length / 适配器字符裁剪都被显式标记为 truncated，调用方不会解析残片；
 * - 旧 runAgent 字符串 userMessage 路径完全不变。
 */

// 复用 P0 提交的 70B PNG fixture，测试源码不内联任何图片 base64 正文。
const PNG_BASE64 = readFileSync(
  fileURLToPath(new URL('../../test/fixtures/frontend-reconstruct/reference-tiny.png', import.meta.url)),
).toString('base64');
const IMAGE_URL = 'data:image/png;base64,' + PNG_BASE64;

const SETTINGS: DeepseekChatSettings = {
  baseUrl: 'https://api.deepseek.test',
  apiKey: 'test-placeholder-key',
  model: 'deepseek-chat',
  visionModel: 'deepseek-vision-test',
  timeoutMs: 5_000,
  maxTokens: 1_200,
  temperature: 0.2,
  reasoningEffort: '',
};

interface CapturedRequest {
  url: string;
  body: Record<string, unknown>;
}

function jsonFetch(
  payload: unknown,
  capture: CapturedRequest,
): RuntimeFetch {
  return async (input, init) => {
    capture.url = input;
    capture.body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

function completion(
  overrides: {
    content?: string;
    finishReason?: string;
    truncated?: boolean;
    toolCalls?: ChatCompletionResult['message']['toolCalls'];
  } = {},
): ChatCompletionResult {
  return {
    message: {
      role: 'assistant',
      content: overrides.content ?? '好的。',
      ...(overrides.toolCalls === undefined ? {} : { toolCalls: overrides.toolCalls }),
    },
    finishReason: overrides.finishReason ?? 'stop',
    model: 'deepseek-chat',
    latencyMs: 2,
    ...(overrides.truncated === undefined ? {} : { truncated: overrides.truncated }),
  };
}

function scriptedModel(results: ChatCompletionResult[], seen: unknown[] = []): ChatModel {
  const queue = [...results];
  return {
    name: 'scripted',
    complete: async (request) => {
      seen.push(request);
      const next = queue.shift();
      if (next === undefined) throw new Error('模型脚本已用尽。');
      return next;
    },
  };
}

describe('Runtime 多模态消息与视觉模型选择', () => {
  it('R1 有图时使用 DEEPSEEK_VISION_MODEL，并把 text+image_url 转成 OpenAI 多模态 parts', async () => {
    const capture: CapturedRequest = { url: '', body: {} };
    const model = new DeepseekChatModel({
      fetch: jsonFetch({ choices: [{ message: { content: '已识别' }, finish_reason: 'stop' }] }, capture),
      settings: SETTINGS,
    });

    const result = await model.complete({
      messages: [
        { role: 'system', content: '系统提示' },
        {
          role: 'user',
          content: [
            { type: 'text', text: '按这张图重构首页' },
            { type: 'image_url', imageUrl: { url: IMAGE_URL } },
          ],
        },
      ],
      maxTokens: 3_000,
    });

    expect(capture.url).toBe('https://api.deepseek.test/chat/completions');
    expect(capture.body.model).toBe('deepseek-vision-test');
    expect(capture.body.max_tokens).toBe(3_000);
    const messages = capture.body.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({ role: 'system', content: '系统提示' });
    expect(messages[1]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: '按这张图重构首页' },
        { type: 'image_url', image_url: { url: IMAGE_URL } },
      ],
    });
    expect(result.message.content).toBe('已识别');
    expect(result.truncated).toBe(false);
  });

  it('R2 无图时保持旧行为：DEEPSEEK_MODEL、字符串 content、默认 max_tokens', async () => {
    const capture: CapturedRequest = { url: '', body: {} };
    const model = new DeepseekChatModel({
      fetch: jsonFetch({ choices: [{ message: { content: '旧路径' }, finish_reason: 'stop' }] }, capture),
      settings: SETTINGS,
    });

    const result = await model.complete({
      messages: [
        { role: 'system', content: '系统' },
        { role: 'user', content: '只发文字' },
        {
          role: 'assistant',
          content: '调用工具',
          toolCalls: [{ id: 'call_1', name: 'get_store_draft', argumentsText: '{}' }],
        },
        { role: 'tool', toolCallId: 'call_1', content: '{"ok":true}' },
      ],
    });

    expect(capture.body.model).toBe('deepseek-chat');
    expect(capture.body.max_tokens).toBe(1_200);
    const messages = capture.body.messages as Array<Record<string, unknown>>;
    expect(messages[1]).toEqual({ role: 'user', content: '只发文字' });
    expect(messages[2]).toMatchObject({
      role: 'assistant',
      content: '调用工具',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_store_draft', arguments: '{}' } }],
    });
    expect(messages[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' });
    expect(result.truncated).toBe(false);
  });

  it('R3 finish_reason=length 被标记为 truncated，且不解析残片', async () => {
    const capture: CapturedRequest = { url: '', body: {} };
    const model = new DeepseekChatModel({
      fetch: jsonFetch(
        { choices: [{ message: { content: '{"pages": [' }, finish_reason: 'length' }] },
        capture,
      ),
      settings: SETTINGS,
    });

    const result = await model.complete({
      messages: [{ role: 'user', content: '生成 JSON' }],
    });
    expect(result.finishReason).toBe('length');
    expect(result.truncated).toBe(true);
    // 适配器只做文本透传，绝不把残片 JSON 解析成对象。
    expect(result.message.content).toBe('{"pages": [');
  });

  it('R4 适配器字符上限裁剪也标记 truncated', async () => {
    const capture: CapturedRequest = { url: '', body: {} };
    const model = new DeepseekChatModel({
      fetch: jsonFetch(
        { choices: [{ message: { content: 'x'.repeat(20_050) }, finish_reason: 'stop' }] },
        capture,
      ),
      settings: SETTINGS,
    });
    const result = await model.complete({ messages: [{ role: 'user', content: '长输出' }] });
    expect(result.truncated).toBe(true);
    expect((result.message.content as string).length).toBe(20_000);
  });

  it('R5 readDeepseekChatSettings 读取 DEEPSEEK_VISION_MODEL（缺省 deepseek-flash）', () => {
    const values: Record<string, string> = {
      DEEPSEEK_API_KEY: 'placeholder',
      DEEPSEEK_MODEL: 'deepseek-chat',
      DEEPSEEK_VISION_MODEL: 'cn:deepseek-v4.1-flash',
    };
    const settings = readDeepseekChatSettings((key) => values[key]);
    expect(settings.model).toBe('deepseek-chat');
    expect(settings.visionModel).toBe('cn:deepseek-v4.1-flash');

    const defaults = readDeepseekChatSettings((key) => (key === 'DEEPSEEK_API_KEY' ? 'placeholder' : undefined));
    expect(defaults.model).toBe('deepseek-chat');
    expect(defaults.visionModel).toBe('deepseek-flash');
  });
});

describe('Runtime 多模态 userMessage 与截断透传', () => {
  const registry = new ToolRegistry();

  it('R6 runAgent 接受 text+image_url 片段，消息序列保持类型化', async () => {
    const seen: unknown[] = [];
    const model = scriptedModel([completion({ content: '完成' })], seen);
    const result = await runAgent({
      model,
      registry,
      systemPrompt: '系统',
      userMessage: [
        { type: 'text', text: '看图' },
        { type: 'image_url', imageUrl: { url: IMAGE_URL } },
      ],
    });

    expect(result.messages[1]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: '看图' },
        { type: 'image_url', imageUrl: { url: IMAGE_URL } },
      ],
    });
    const request = seen[0] as { messages: unknown[]; maxTokens?: number };
    expect(request.messages[1]).toEqual(result.messages[1]);
    expect(request.maxTokens).toBeUndefined();
    expect(result.truncated).toBe(false);
  });

  it('R7 字符串 userMessage 仍是旧行为：trim 校验、消息 content 为字符串', async () => {
    const seen: unknown[] = [];
    const result = await runAgent({
      model: scriptedModel([completion({ content: '完成' })], seen),
      registry,
      systemPrompt: '系统',
      userMessage: '只发文字',
    });
    expect(result.messages[1]).toEqual({ role: 'user', content: '只发文字' });
    expect((seen[0] as { messages: unknown[] }).messages[1]).toEqual({
      role: 'user',
      content: '只发文字',
    });
  });

  it('R8 拒绝远程 URL / 非 data URL 图片与空文本，避免服务端变成图片代理', async () => {
    const model = scriptedModel([]);
    await expect(
      runAgent({
        model,
        registry,
        systemPrompt: '系统',
        userMessage: [
          { type: 'text', text: '看图' },
          { type: 'image_url', imageUrl: { url: 'https://evil.example/x.png' } },
        ],
      }),
    ).rejects.toBeInstanceOf(AgentConfigurationError);

    await expect(
      runAgent({
        model,
        registry,
        systemPrompt: '系统',
        userMessage: [{ type: 'image_url', imageUrl: { url: IMAGE_URL } }],
      }),
    ).rejects.toBeInstanceOf(AgentConfigurationError);

    await expect(
      runAgent({
        model,
        registry,
        systemPrompt: '系统',
        userMessage: [{ type: 'text', text: '   ' }],
      }),
    ).rejects.toBeInstanceOf(AgentConfigurationError);
  });

  it('R9 模型截断传递到 AgentStepTrace / AgentRunResult', async () => {
    const model = scriptedModel([completion({ content: '{"a":', finishReason: 'length', truncated: true })]);
    const result = await runAgent({
      model,
      registry,
      systemPrompt: '系统',
      userMessage: '生成 JSON',
    });
    expect(result.truncated).toBe(true);
    expect(result.steps[0]?.truncated).toBe(true);
    expect(result.steps[0]?.finishReason).toBe('length');
    expect(result.stopReason).toBe('final_answer');
  });

  it('R10 无截断的旧响应 truncated=false（不改变既有调用方语义）', async () => {
    const result = await runAgent({
      model: scriptedModel([completion({ content: '正常回复' })]),
      registry,
      systemPrompt: '系统',
      userMessage: '正常请求',
    });
    expect(result.truncated).toBe(false);
    expect(result.steps.every((step) => step.truncated === false)).toBe(true);
    expect(result.stopReason).toBe('final_answer');
    expect(result.degraded).toBe(false);
  });
});
