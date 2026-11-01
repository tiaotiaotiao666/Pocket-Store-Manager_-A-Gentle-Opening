import { HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import {
  DEEPSEEK_SYSTEM_PROMPT,
  DeepseekAgentProvider,
  extractModelContent,
  stripMarkdownFence,
} from '../src/agent/provider/deepseek-agent.provider';
import type { ContractDraft } from '../src/agent/agent.types';

function emptyDraft(): ContractDraft {
  return {
    storeName: '',
    category: '',
    businessHours: '',
    fulfillment: { dineIn: false, takeaway: false },
    dishes: [],
  };
}

function responseStub(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

function makeConfig(overrides: Record<string, unknown> = {}): ConfigService {
  return new ConfigService({
    DEEPSEEK_API_BASE_URL: 'https://api.deepseek.com',
    DEEPSEEK_API_KEY: 'sk-test-key-never-real',
    DEEPSEEK_MODEL: 'deepseek-chat',
    DEEPSEEK_TIMEOUT_MS: '30000',
    ...overrides,
  });
}

function expectHttpError(error: unknown, status: number, code: string): void {
  expect(error).toBeInstanceOf(HttpException);
  const httpError = error as HttpException;
  expect(httpError.getStatus()).toBe(status);
  const payload = httpError.getResponse() as Record<string, unknown>;
  expect(payload.code).toBe(code);
  // 错误体不得泄露密钥或上游原始响应。
  expect(JSON.stringify(payload)).not.toContain('sk-test-key-never-real');
}

function modelBody(content: string): unknown {
  return { choices: [{ message: { role: 'assistant', content } }] };
}

async function expectHttpFailure(
  promise: Promise<unknown>,
  status: number,
  code: string,
): Promise<void> {
  let caught: unknown = null;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).not.toBeNull();
  expectHttpError(caught, status, code);
}

describe('DeepseekAgentProvider 请求构造', () => {
  it('按 OpenAI 兼容协议调用 /chat/completions，携带 Bearer 与并入用户消息的结构约束', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      captured = { url, init: init ?? {} };
      return responseStub(modelBody(JSON.stringify({ reply: '已记录', draftPatch: { storeName: '松月食堂' } })));
    };

    const provider = new DeepseekAgentProvider(makeConfig(), fetchImpl);
    const result = await provider.extractTurn({ utterance: '店名叫松月食堂', draft: emptyDraft() });

    expect(result.reply).toBe('已记录');
    expect(result.draftPatch).toEqual({ storeName: '松月食堂' });
    expect(result.model).toBe('deepseek-chat');

    expect(captured).not.toBeNull();
    const { url, init } = captured as unknown as { url: string; init: RequestInit };
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Authorization).toBe('Bearer sk-test-key-never-real');

    const body = JSON.parse(String(init.body)) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
      response_format: { type: string };
      stream: boolean;
    };
    expect(body.model).toBe('deepseek-chat');
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.stream).toBe(false);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe('user');
    expect(body.messages[0].content).toContain(DEEPSEEK_SYSTEM_PROMPT);
    expect(body.messages[0].content).toContain('不得臆造价格、营业时间、菜品或取餐方式');
    expect(body.messages[0].content).toContain('只输出 JSON');
    expect(body.messages[0].content).toContain('店名叫松月食堂');
  });

  it('允许通过环境变量覆盖 baseUrl 与 model', async () => {
    let capturedUrl = '';
    let capturedBody = '';
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      capturedUrl = url;
      capturedBody = String(init?.body ?? '');
      return responseStub(modelBody(JSON.stringify({ reply: '好的', draftPatch: {} })));
    };
    const config = makeConfig({
      DEEPSEEK_API_BASE_URL: 'https://example.internal/deepseek/',
      DEEPSEEK_MODEL: 'deepseek-reasoner',
    });
    const provider = new DeepseekAgentProvider(config, fetchImpl);
    await provider.extractTurn({ utterance: '你好', draft: emptyDraft() });

    expect(capturedUrl).toBe('https://example.internal/deepseek/chat/completions');
    expect(JSON.parse(capturedBody).model).toBe('deepseek-reasoner');
  });

  it('按配置发送思考档位与输出上限，缺省不附加思考档位', async () => {
    let capturedBody = '';
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      capturedBody = String(init?.body ?? '');
      return responseStub(modelBody(JSON.stringify({ reply: '好的', draftPatch: {} })));
    };
    const provider = new DeepseekAgentProvider(makeConfig({
      DEEPSEEK_REASONING_EFFORT: 'low',
      DEEPSEEK_MAX_TOKENS: '1000',
    }), fetchImpl);
    await provider.extractTurn({ utterance: '你好', draft: emptyDraft() });

    const body = JSON.parse(capturedBody);
    expect(body.reasoning_effort).toBe('low');
    expect(body.max_tokens).toBe(1000);

    const defaultProvider = new DeepseekAgentProvider(makeConfig(), fetchImpl);
    await defaultProvider.extractTurn({ utterance: '你好', draft: emptyDraft() });
    const defaultBody = JSON.parse(capturedBody);
    expect(defaultBody.reasoning_effort).toBeUndefined();
    expect(defaultBody.max_tokens).toBe(1200);
  });
});

describe('DeepseekAgentProvider 响应解析', () => {
  it('T1 正常 JSON 响应被解析为 reply + draftPatch', async () => {
    const payload = {
      reply: '记下了店名。',
      draftPatch: { storeName: '松月食堂', dishes: [{ name: '米饭', priceCents: 300 }] },
    };
    const provider = new DeepseekAgentProvider(
      makeConfig(),
      async () => responseStub(modelBody(JSON.stringify(payload))),
    );
    const result = await provider.extractTurn({ utterance: '店名松月食堂', draft: emptyDraft() });
    expect(result.reply).toBe('记下了店名。');
    expect(result.draftPatch).toEqual(payload.draftPatch);
  });

  it('T2 Markdown 包裹的 JSON 能去掉围栏后解析', async () => {
    const content = '```json\n{"reply":"好的","draftPatch":{"category":"社区餐馆"}}\n```';
    const provider = new DeepseekAgentProvider(
      makeConfig(),
      async () => responseStub(modelBody(content)),
    );
    const result = await provider.extractTurn({ utterance: '做家常菜', draft: emptyDraft() });
    expect(result.reply).toBe('好的');
    expect(result.draftPatch).toEqual({ category: '社区餐馆' });
  });

  it('T2b 模型在 JSON 前后加解释文字时仍能提取对象', async () => {
    const content = '好的，这是结果：{"reply":"收到了","draftPatch":{}} 谢谢';
    const provider = new DeepseekAgentProvider(
      makeConfig(),
      async () => responseStub(modelBody(content)),
    );
    const result = await provider.extractTurn({ utterance: '随便说', draft: emptyDraft() });
    expect(result.reply).toBe('收到了');
  });

  it('T3 非法 JSON 返回 502 DEEPSEEK_RESPONSE_INVALID', async () => {
    const provider = new DeepseekAgentProvider(
      makeConfig(),
      async () => responseStub(modelBody('这不是 JSON，也不是对象')),
    );
    await expectHttpFailure(
      provider.extractTurn({ utterance: '店名松月食堂', draft: emptyDraft() }),
      502,
      'DEEPSEEK_RESPONSE_INVALID',
    );
  });

  it('T3b 响应没有 choices/content 时返回 502', async () => {
    const provider = new DeepseekAgentProvider(
      makeConfig(),
      async () => responseStub({ choices: [] }),
    );
    await expectHttpFailure(
      provider.extractTurn({ utterance: '店名松月食堂', draft: emptyDraft() }),
      502,
      'DEEPSEEK_RESPONSE_INVALID',
    );
  });

  it('T4 模型返回的 status/missingFields/errors 不进入 Provider 结果', async () => {
    const content = JSON.stringify({
      reply: '资料齐了',
      status: 'reviewing',
      missingFields: [],
      errors: [],
      readyForReview: true,
      draftPatch: { storeName: '松月食堂' },
    });
    const provider = new DeepseekAgentProvider(
      makeConfig(),
      async () => responseStub(modelBody(content)),
    );
    const result = await provider.extractTurn({ utterance: '店名松月食堂', draft: emptyDraft() });
    expect(Object.keys(result).sort()).toEqual(['draftPatch', 'latencyMs', 'model', 'reply'].sort());
    expect(result).not.toHaveProperty('status');
  });

  it('T6 超时返回 504 DEEPSEEK_TIMEOUT', async () => {
    const fetchImpl = (_url: string, init?: RequestInit): Promise<Response> => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });
    const provider = new DeepseekAgentProvider(makeConfig({ DEEPSEEK_TIMEOUT_MS: '20' }), fetchImpl);
    await expectHttpFailure(
      provider.extractTurn({ utterance: '店名松月食堂', draft: emptyDraft() }),
      504,
      'DEEPSEEK_TIMEOUT',
    );
  });

  it('T7 上游 401 映射为 502 DEEPSEEK_AUTH_FAILED，不泄露 Key', async () => {
    const provider = new DeepseekAgentProvider(
      makeConfig(),
      async () => responseStub({ error: { message: 'invalid key' } }, 401),
    );
    await expectHttpFailure(
      provider.extractTurn({ utterance: '店名松月食堂', draft: emptyDraft() }),
      502,
      'DEEPSEEK_AUTH_FAILED',
    );
  });

  it('T8 上游 429 映射为 503 DEEPSEEK_RATE_LIMITED', async () => {
    const provider = new DeepseekAgentProvider(
      makeConfig(),
      async () => responseStub({ error: 'rate limited' }, 429),
    );
    await expectHttpFailure(
      provider.extractTurn({ utterance: '店名松月食堂', draft: emptyDraft() }),
      503,
      'DEEPSEEK_RATE_LIMITED',
    );
  });

  it('T9 上游 5xx 映射为 502 DEEPSEEK_UPSTREAM_ERROR', async () => {
    const provider = new DeepseekAgentProvider(
      makeConfig(),
      async () => responseStub('internal error', 500),
    );
    await expectHttpFailure(
      provider.extractTurn({ utterance: '店名松月食堂', draft: emptyDraft() }),
      502,
      'DEEPSEEK_UPSTREAM_ERROR',
    );
  });

  it('T10 缺少 API Key 返回 503 DEEPSEEK_NOT_CONFIGURED 且不发请求', async () => {
    let called = 0;
    const fetchImpl = async (): Promise<Response> => {
      called += 1;
      return responseStub(modelBody('{}'));
    };
    const provider = new DeepseekAgentProvider(makeConfig({ DEEPSEEK_API_KEY: '' }), fetchImpl);
    await expectHttpFailure(
      provider.extractTurn({ utterance: '店名松月食堂', draft: emptyDraft() }),
      503,
      'DEEPSEEK_NOT_CONFIGURED',
    );
    expect(called).toBe(0);
  });

  it('describeConfiguration 只报告是否配置，不返回 Key', () => {
    const provider = new DeepseekAgentProvider(makeConfig(), async () => responseStub('{}'));
    const summary = provider.describeConfiguration();
    expect(summary.configured).toBe(true);
    expect(JSON.stringify(summary)).not.toContain('sk-test-key-never-real');
  });
});

describe('响应清洗工具', () => {
  it('stripMarkdownFence 处理围栏与裸 JSON', () => {
    expect(stripMarkdownFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripMarkdownFence('```\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripMarkdownFence('前言 {"a":1} 后记')).toBe('{"a":1}');
    expect(stripMarkdownFence('')).toBe('');
  });

  it('extractModelContent 兼容字符串与数组形式', () => {
    expect(extractModelContent({ choices: [{ message: { content: 'hi' } }] })).toBe('hi');
    expect(extractModelContent({ choices: [{ message: { content: [{ text: 'a' }, { text: 'b' }] } }] })).toBe('ab');
    expect(extractModelContent(null)).toBe('');
    expect(extractModelContent({ choices: [] })).toBe('');
  });
});