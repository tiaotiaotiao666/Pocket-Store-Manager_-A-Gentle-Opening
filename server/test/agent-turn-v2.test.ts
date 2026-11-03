import { HttpException, Logger } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { AgentAuthGuard } from '../src/agent/agent-auth.guard';
import { AgentController } from '../src/agent/agent.controller';
import { AgentService } from '../src/agent/agent.service';
import {
  AGENT_IMAGE_LIMITS,
  validateAgentImages,
} from '../src/agent/agent-image.validator';
import {
  AGENT_FETCH,
  AGENT_PROVIDER,
  AGENT_TURN_CONTRACT_VERSION,
  AGENT_TURN_V2_CONTRACT_VERSION,
} from '../src/agent/agent.types';
import type { AgentTurnV2Response, ContractDraft } from '../src/agent/agent.types';
import {
  DEEPSEEK_SYSTEM_PROMPT,
  DEEPSEEK_VISION_PROMPT_ADDENDUM,
  DeepseekAgentProvider,
} from '../src/agent/provider/deepseek-agent.provider';
import type {
  AgentProvider,
  AgentProviderExtractInput,
  AgentProviderExtractResult,
} from '../src/agent/provider/agent-provider.interface';
import { PrismaService } from '../src/database/prisma.service';
import { SessionAuthGuard } from '../src/common/auth/session-auth.guard';

/**
 * agent-turn.v2（C-AGENT-TURN-V2@1）后端测试。
 *
 * 约束：
 * - 全部模型请求走注入的 fetch stub，绝不真实访问 DeepSeek；
 * - 断言错误码、HTTP 状态与“失败不返回部分草稿”；
 * - 断言日志不含 base64 / API Key / 模型 payload。
 */

function emptyDraft(): ContractDraft {
  return {
    storeName: '',
    category: '',
    businessHours: '',
    fulfillment: { dineIn: false, takeaway: false },
    dishes: [],
  };
}

function makeV1Request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: AGENT_TURN_CONTRACT_VERSION,
    utterance: '店名叫松月食堂',
    draft: emptyDraft(),
    client: { surface: 'desktop', phase: 'store-info' },
    projectId: null,
    ...overrides,
  };
}

function makeV2Request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: AGENT_TURN_V2_CONTRACT_VERSION,
    utterance: '这是我们的菜单照片',
    draft: emptyDraft(),
    client: { surface: 'desktop', phase: 'store-info' },
    projectId: null,
    ...overrides,
  };
}

const completePatch = (): Record<string, unknown> => ({
  storeName: '松月食堂',
  category: '社区餐馆',
  businessHours: '10:00-21:00',
  fulfillment: { dineIn: true, takeaway: true },
  dishes: [
    { id: 'dish-1', name: '宫保鸡丁', priceCents: 2800, description: '' },
    { id: 'dish-2', name: '番茄炒蛋', priceCents: 1600, description: '' },
    { id: 'dish-3', name: '米饭', priceCents: 300, description: '' },
  ],
});

/** 生成指定解码字节数的合法 base64（内容本身无意义，只用于体积校验）。 */
function base64OfBytes(bytes: number): string {
  return Buffer.alloc(bytes, 0x2f).toString('base64');
}

function imagePayload(
  kind: 'menu' | 'store',
  bytes = 128,
  mediaType = 'image/png',
): Record<string, unknown> {
  return { kind, mediaType, data: base64OfBytes(bytes) };
}

interface RecordingProvider {
  provider: AgentProvider;
  calls: AgentProviderExtractInput[];
}

function recordingProvider(draftPatch: unknown = completePatch()): RecordingProvider {
  const calls: AgentProviderExtractInput[] = [];
  const provider: AgentProvider = {
    name: 'deepseek',
    async extractTurn(input: AgentProviderExtractInput): Promise<AgentProviderExtractResult> {
      calls.push(input);
      const hasImages = Array.isArray(input.images) && input.images.length > 0;
      return {
        reply: '好的，已整理菜单。',
        draftPatch,
        model: hasImages ? 'deepseek-flash' : 'deepseek-chat',
        latencyMs: 1,
        ...(hasImages ? { visionAnalyzed: true } : {}),
      };
    },
  };
  return { provider, calls };
}

async function expectRejection(
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
  expect(caught).toBeInstanceOf(HttpException);
  const httpError = caught as HttpException;
  expect(httpError.getStatus()).toBe(status);
  expect((httpError.getResponse() as Record<string, unknown>).code).toBe(code);
}

/** 抓取 Logger 输出文本，用于断言日志不含敏感内容。 */
function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const record = (...args: unknown[]): void => {
    lines.push(args.map((item) => String(item)).join(' '));
  };
  const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(record);
  const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(record);
  const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(record);
  return {
    lines,
    restore: () => {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    },
  };
}

describe('AgentService 契约分派：v1 完全兼容', () => {
  it('v1 响应不含 vision，字段与既有实现一致', async () => {
    const { provider, calls } = recordingProvider();
    const service = new AgentService(provider);
    const response = await service.handleTurn(makeV1Request(), { requestId: 'req_v1_0001' });

    expect(response.contractVersion).toBe(AGENT_TURN_CONTRACT_VERSION);
    expect(Object.keys(response).sort()).toEqual([
      'contractVersion',
      'draft',
      'errors',
      'meta',
      'missingFields',
      'nextQuestion',
      'reply',
      'status',
      'turnId',
    ]);
    expect(response).not.toHaveProperty('vision');
    expect(response.meta.model).toBe('deepseek-chat');
    // v1 不向 Provider 传 images，Provider 走字符串 content 路径。
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty('images');
  });

  it('缺省 contractVersion 仍走 v1 校验（保持既有 400 语义，不静默升级）', async () => {
    const { provider } = recordingProvider();
    const service = new AgentService(provider);
    const body = makeV1Request();
    delete (body as Record<string, unknown>).contractVersion;
    await expectRejection(
      service.handleTurn(body, { requestId: 'req_v1_0002' }),
      400,
      'AGENT_CONTRACT_MISMATCH',
    );
  });
});

describe('AgentService agent-turn.v2', () => {
  it('2 张菜单照 + 1 张环境照：200 语义、vision 计数与 analyzed 正确', async () => {
    const { provider, calls } = recordingProvider();
    const service = new AgentService(provider);
    const response = (await service.handleTurn(
      makeV2Request({
        images: [imagePayload('menu'), imagePayload('menu', 256), imagePayload('store', 512)],
      }),
      { requestId: 'req_v2_0001' },
    )) as AgentTurnV2Response;

    expect(response.contractVersion).toBe(AGENT_TURN_V2_CONTRACT_VERSION);
    expect(response.status).toBe('reviewing');
    expect(response.vision).toEqual({
      menuImages: 2,
      storeImages: 1,
      analyzed: true,
      degraded: false,
    });
    // 模型补丁照常合并，服务端仍掌握 status/missingFields/errors。
    expect(response.draft.storeName).toBe('松月食堂');
    expect(response.meta.model).toBe('deepseek-flash');

    expect(calls).toHaveLength(1);
    expect(calls[0].images).toHaveLength(3);
    expect(calls[0].images?.map((item) => item.kind)).toEqual(['menu', 'menu', 'store']);
    // Provider 收到的是解码后的真实字节数，且不含 dataUrl 前缀。
    expect(calls[0].images?.[0].bytes).toBe(128);
    expect(calls[0].images?.[0].data.startsWith('data:')).toBe(false);
  });

  it('v2 不带 images 时 vision 计数为 0 且 analyzed=false，Provider 无多模态输入', async () => {
    const { provider, calls } = recordingProvider();
    const service = new AgentService(provider);
    const response = (await service.handleTurn(makeV2Request(), {
      requestId: 'req_v2_0002',
    })) as AgentTurnV2Response;

    expect(response.vision).toEqual({
      menuImages: 0,
      storeImages: 0,
      analyzed: false,
      degraded: false,
    });
    expect(calls[0]).not.toHaveProperty('images');
  });

  it('接受 dataBase64 别名（与 data 二选一）', async () => {
    const { provider } = recordingProvider();
    const service = new AgentService(provider);
    const response = (await service.handleTurn(
      makeV2Request({
        images: [{ kind: 'menu', mediaType: 'image/png', dataBase64: base64OfBytes(64) }],
      }),
      { requestId: 'req_v2_0003' },
    )) as AgentTurnV2Response;
    expect(response.vision?.analyzed).toBe(true);
  });

  it('未知顶层字段整包拒绝 400 AGENT_REQUEST_INVALID', async () => {
    const { provider, calls } = recordingProvider();
    const service = new AgentService(provider);
    await expectRejection(
      service.handleTurn(makeV2Request({ clientHints: { anything: true } }), {
        requestId: 'req_v2_0004',
      }),
      400,
      'AGENT_REQUEST_INVALID',
    );
    expect(calls).toHaveLength(0);
  });

  it('images 元素出现未知键整包拒绝 400', async () => {
    const { provider, calls } = recordingProvider();
    const service = new AgentService(provider);
    await expectRejection(
      service.handleTurn(
        makeV2Request({
          images: [{ ...imagePayload('menu'), bytes: 128 }],
        }),
        { requestId: 'req_v2_0005' },
      ),
      400,
      'AGENT_REQUEST_INVALID',
    );
    expect(calls).toHaveLength(0);
  });

  it('images.kind 非法返回 400', async () => {
    const { provider } = recordingProvider();
    const service = new AgentService(provider);
    await expectRejection(
      service.handleTurn(
        makeV2Request({ images: [{ ...imagePayload('menu'), kind: 'dish' }] }),
        { requestId: 'req_v2_0006' },
      ),
      400,
      'AGENT_REQUEST_INVALID',
    );
  });
});

describe('agent-turn.v2 图片限制（422 整包拒绝，不返回部分草稿）', () => {
  const cases: Array<{
    title: string;
    images: Record<string, unknown>[];
    code: string;
  }> = [
    {
      title: '菜单照超过 2 张',
      images: [imagePayload('menu'), imagePayload('menu'), imagePayload('menu')],
      code: 'AGENT_IMAGE_COUNT_EXCEEDED',
    },
    {
      title: '环境照超过 1 张',
      images: [imagePayload('store'), imagePayload('store')],
      code: 'AGENT_IMAGE_COUNT_EXCEEDED',
    },
    {
      title: '合计超过 3 张',
      images: [
        imagePayload('menu'),
        imagePayload('menu'),
        imagePayload('store'),
        imagePayload('store'),
      ],
      code: 'AGENT_IMAGE_COUNT_EXCEEDED',
    },
    {
      title: 'MIME 不在白名单',
      images: [{ kind: 'menu', mediaType: 'image/gif', data: base64OfBytes(32) }],
      code: 'AGENT_IMAGE_TYPE_UNSUPPORTED',
    },
    {
      title: 'MIME 缺失',
      images: [{ kind: 'menu', data: base64OfBytes(32) }],
      code: 'AGENT_IMAGE_TYPE_UNSUPPORTED',
    },
    {
      title: 'base64 长度不是 4 的倍数',
      images: [{ kind: 'menu', mediaType: 'image/png', data: 'abc' }],
      code: 'AGENT_IMAGE_INVALID',
    },
    {
      title: 'base64 含非法字符',
      images: [{ kind: 'menu', mediaType: 'image/png', data: 'abc$defg' }],
      code: 'AGENT_IMAGE_INVALID',
    },
    {
      title: 'data 缺失',
      images: [{ kind: 'menu', mediaType: 'image/png' }],
      code: 'AGENT_IMAGE_INVALID',
    },
    {
      title: '单张解码超过 400KiB',
      images: [imagePayload('menu', AGENT_IMAGE_LIMITS.maxImageBytes + 1)],
      code: 'AGENT_IMAGE_TOO_LARGE',
    },
    {
      title: '合计解码超过 1MiB（三张均在单张上限内）',
      images: [
        imagePayload('menu', 360000),
        imagePayload('menu', 360000),
        imagePayload('store', 360000),
      ],
      code: 'AGENT_IMAGE_TOO_LARGE',
    },
  ];

  for (const testCase of cases) {
    it(`${testCase.title} → 422 ${testCase.code}`, async () => {
      const { provider, calls } = recordingProvider();
      const service = new AgentService(provider);
      await expectRejection(
        service.handleTurn(makeV2Request({ images: testCase.images }), {
          requestId: 'req_v2_limit',
        }),
        422,
        testCase.code,
      );
      // 关键：整包拒绝时根本没有调用模型，因此不存在“部分草稿”。
      expect(calls).toHaveLength(0);
    });
  }

  it('单张恰好 400KiB 与合计恰好 1MiB 可通过', async () => {
    const service = new AgentService(recordingProvider().provider);
    const response = (await service.handleTurn(
      makeV2Request({ images: [imagePayload('menu', AGENT_IMAGE_LIMITS.maxImageBytes)] }),
      { requestId: 'req_v2_boundary' },
    )) as AgentTurnV2Response;
    expect(response.vision?.analyzed).toBe(true);
  });

  it('只用真实解码字节数判断大小，客户端 bytes 声明会被整包拒绝', () => {
    const validated = validateAgentImages([
      { kind: 'menu', mediaType: 'image/png', data: base64OfBytes(96) },
    ]);
    expect(validated.totalBytes).toBe(96);

    // bytes 不是契约允许的键，不能靠它“声明”大小。
    expect(() => validateAgentImages([
      { kind: 'menu', mediaType: 'image/png', data: base64OfBytes(96), bytes: 1 },
    ] as unknown)).toThrow(HttpException);
  });
});

describe('agent-turn.v2 日志安全', () => {
  it('日志只含计数与耗时，不含 base64 或 API Key', async () => {
    const logs = captureLogs();
    try {
      const { provider } = recordingProvider();
      const service = new AgentService(provider);
      const data = base64OfBytes(300);
      await service.handleTurn(
        makeV2Request({ images: [{ kind: 'menu', mediaType: 'image/png', data }] }),
        { requestId: 'req_v2_logs' },
      );

      const joined = logs.lines.join('\n');
      expect(joined).toContain('menuImages=1');
      expect(joined).toContain('storeImages=0');
      expect(joined).toContain('totalBytes=300');
      // 取 base64 的前 32 个字符做指纹，日志里不得出现。
      expect(joined).not.toContain(data.slice(0, 32));
      expect(joined).not.toContain('base64');
      expect(joined).not.toContain('sk-');
    } finally {
      logs.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Provider：多模态 content 形状、模型选择、错误映射
// ---------------------------------------------------------------------------

function responseStub(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

function modelBody(content: string): unknown {
  return { choices: [{ message: { role: 'assistant', content } }] };
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

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

function capturingFetch(
  respond: () => Response,
): { fetchImpl: (url: string, init?: RequestInit) => Promise<Response>; captured: CapturedRequest[] } {
  const captured: CapturedRequest[] = [];
  return {
    captured,
    fetchImpl: async (url: string, init?: RequestInit): Promise<Response> => {
      captured.push({ url, init: init ?? {} });
      return respond();
    },
  };
}

function providerImage(kind: 'menu' | 'store', bytes = 64, mediaType = 'image/png') {
  return { kind, mediaType, data: base64OfBytes(bytes), bytes };
}

function parseRequestBody(captured: CapturedRequest[]): Record<string, unknown> {
  return JSON.parse(String(captured[0].init.body)) as Record<string, unknown>;
}

const okContent = modelBody(JSON.stringify({ reply: '已整理', draftPatch: { storeName: '松月食堂' } }));

describe('DeepseekAgentProvider 多模态请求', () => {
  it('有图片时 content 为 text + image_url 数组，且使用 DEEPSEEK_VISION_MODEL', async () => {
    const { fetchImpl, captured } = capturingFetch(() => responseStub(okContent));
    const provider = new DeepseekAgentProvider(makeConfig({ DEEPSEEK_VISION_MODEL: 'deepseek-flash' }), fetchImpl);

    const result = await provider.extractTurn({
      utterance: '这是菜单照',
      draft: emptyDraft(),
      requestId: 'req_provider_v2',
      images: [providerImage('menu', 64), providerImage('store', 32, 'image/jpeg')],
    });

    expect(result.visionAnalyzed).toBe(true);
    expect(result.model).toBe('deepseek-flash');

    const body = parseRequestBody(captured);
    expect(body.model).toBe('deepseek-flash');
    const content = (body.messages as Array<{ content: unknown }>)[0].content;
    expect(Array.isArray(content)).toBe(true);
    const parts = content as Array<Record<string, unknown>>;
    expect(parts).toHaveLength(3);
    expect(parts[0].type).toBe('text');
    expect(String(parts[0].text)).toContain(DEEPSEEK_SYSTEM_PROMPT);
    expect(String(parts[0].text)).toContain(DEEPSEEK_VISION_PROMPT_ADDENDUM);
    expect(String(parts[0].text)).toContain('这是菜单照');
    expect(parts[1]).toEqual({
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${providerImage('menu', 64).data}` },
    });
    expect(parts[2]).toEqual({
      type: 'image_url',
      image_url: { url: `data:image/jpeg;base64,${providerImage('store', 32).data}` },
    });
  });

  it('DEEPSEEK_VISION_MODEL 未配置时默认 deepseek-flash', async () => {
    const { fetchImpl, captured } = capturingFetch(() => responseStub(okContent));
    const provider = new DeepseekAgentProvider(makeConfig(), fetchImpl);
    await provider.extractTurn({
      utterance: '菜单照',
      draft: emptyDraft(),
      images: [providerImage('menu')],
    });
    expect(parseRequestBody(captured).model).toBe('deepseek-flash');
  });

  it('无图片时 content 仍是字符串且使用 DEEPSEEK_MODEL，不含视觉约束', async () => {
    const { fetchImpl, captured } = capturingFetch(() => responseStub(okContent));
    const provider = new DeepseekAgentProvider(makeConfig(), fetchImpl);
    const result = await provider.extractTurn({ utterance: '店名松月食堂', draft: emptyDraft() });

    expect(result).not.toHaveProperty('visionAnalyzed');
    const body = parseRequestBody(captured);
    expect(body.model).toBe('deepseek-chat');
    const content = (body.messages as Array<{ content: unknown }>)[0].content;
    expect(typeof content).toBe('string');
    expect(content as string).toContain(DEEPSEEK_SYSTEM_PROMPT);
    expect(content as string).not.toContain(DEEPSEEK_VISION_PROMPT_ADDENDUM);
  });

  it('空 images 数组按无图处理（content 为字符串）', async () => {
    const { fetchImpl, captured } = capturingFetch(() => responseStub(okContent));
    const provider = new DeepseekAgentProvider(makeConfig(), fetchImpl);
    const result = await provider.extractTurn({ utterance: '店名', draft: emptyDraft(), images: [] });
    expect(typeof (parseRequestBody(captured).messages as Array<{ content: unknown }>)[0].content).toBe('string');
    expect(result).not.toHaveProperty('visionAnalyzed');
  });

  it('视觉请求返回非 JSON → 502 DEEPSEEK_VISION_UNAVAILABLE', async () => {
    const { fetchImpl } = capturingFetch(() => responseStub(modelBody('这不是 JSON')));
    const provider = new DeepseekAgentProvider(makeConfig(), fetchImpl);
    await expectRejection(
      provider.extractTurn({
        utterance: '菜单照',
        draft: emptyDraft(),
        images: [providerImage('menu')],
      }),
      502,
      'DEEPSEEK_VISION_UNAVAILABLE',
    );
  });

  it('视觉请求上游 400（模型不接受图片）→ 502 DEEPSEEK_VISION_UNAVAILABLE', async () => {
    const { fetchImpl } = capturingFetch(() => responseStub({ error: { message: 'invalid content type' } }, 400));
    const provider = new DeepseekAgentProvider(makeConfig(), fetchImpl);
    await expectRejection(
      provider.extractTurn({
        utterance: '菜单照',
        draft: emptyDraft(),
        images: [providerImage('menu')],
      }),
      502,
      'DEEPSEEK_VISION_UNAVAILABLE',
    );
  });

  it('视觉请求超时 → 504 DEEPSEEK_TIMEOUT', async () => {
    const fetchImpl = (_url: string, init?: RequestInit): Promise<Response> => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });
    const provider = new DeepseekAgentProvider(makeConfig({ DEEPSEEK_TIMEOUT_MS: '20' }), fetchImpl);
    await expectRejection(
      provider.extractTurn({
        utterance: '菜单照',
        draft: emptyDraft(),
        images: [providerImage('menu')],
      }),
      504,
      'DEEPSEEK_TIMEOUT',
    );
  });

  it('文本请求返回非 JSON 仍是 502 DEEPSEEK_RESPONSE_INVALID（v1 不回归）', async () => {
    const { fetchImpl } = capturingFetch(() => responseStub(modelBody('不是 JSON')));
    const provider = new DeepseekAgentProvider(makeConfig(), fetchImpl);
    await expectRejection(
      provider.extractTurn({ utterance: '店名', draft: emptyDraft() }),
      502,
      'DEEPSEEK_RESPONSE_INVALID',
    );
  });

  it('视觉请求日志不含 base64 / Key / payload', async () => {
    const logs = captureLogs();
    try {
      const { fetchImpl } = capturingFetch(() => responseStub(okContent));
      const provider = new DeepseekAgentProvider(makeConfig(), fetchImpl);
      const data = base64OfBytes(128);
      await provider.extractTurn({
        utterance: '菜单照',
        draft: emptyDraft(),
        images: [{ kind: 'menu', mediaType: 'image/png', data, bytes: 128 }],
      });
      const joined = logs.lines.join('\n');
      expect(joined).toContain('images=1');
      expect(joined).not.toContain(data.slice(0, 32));
      expect(joined).not.toContain('sk-test-key-never-real');
    } finally {
      logs.restore();
    }
  });

  it('describeConfiguration 额外报告视觉模型，但不返回 Key', () => {
    const provider = new DeepseekAgentProvider(makeConfig(), async () => responseStub(okContent));
    const summary = provider.describeConfiguration();
    expect(summary.model).toBe('deepseek-chat');
    expect(summary.visionModel).toBe('deepseek-flash');
    expect(JSON.stringify(summary)).not.toContain('sk-test-key-never-real');
  });
});

// ---------------------------------------------------------------------------
// HTTP 层：同一路由按 contractVersion 分派
// ---------------------------------------------------------------------------

const apps: INestApplication[] = [];

const unexpectedFetch = async (): Promise<Response> => {
  throw new Error('测试中禁止真实请求 DeepSeek');
};

async function createApp(provider: AgentProvider = recordingProvider().provider): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [AgentController],
    providers: [
      AgentService,
      SessionAuthGuard,
      AgentAuthGuard,
      { provide: ConfigService, useValue: new ConfigService({ NODE_ENV: 'development', AGENT_REQUIRE_AUTH: 'false' }) },
      {
        provide: PrismaService,
        useValue: { session: { findUnique: async () => null } },
      },
      { provide: AGENT_PROVIDER, useValue: provider },
      { provide: AGENT_FETCH, useValue: unexpectedFetch },
    ],
  }).compile();

  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  await app.init();
  apps.push(app);
  return app;
}

afterAll(async () => {
  for (const app of apps) {
    await app.close();
  }
});

describe('POST /api/v1/agent/turn 路由分派', () => {
  it('v1 请求返回 200 且响应体没有 vision 字段', async () => {
    const app = await createApp();
    const response = await request(app.getHttpServer())
      .post('/api/v1/agent/turn')
      .set('X-Agent-Contract', AGENT_TURN_CONTRACT_VERSION)
      .send(makeV1Request());

    expect(response.status).toBe(200);
    expect(response.body.contractVersion).toBe(AGENT_TURN_CONTRACT_VERSION);
    expect(response.body).not.toHaveProperty('vision');
    expect(Object.keys(response.body).sort()).toEqual([
      'contractVersion',
      'draft',
      'errors',
      'meta',
      'missingFields',
      'nextQuestion',
      'reply',
      'status',
      'turnId',
    ]);
  });

  it('v2 请求返回 200，带 vision 计数且回显 agent-turn.v2', async () => {
    const app = await createApp();
    const response = await request(app.getHttpServer())
      .post('/api/v1/agent/turn')
      .set('X-Agent-Contract', AGENT_TURN_V2_CONTRACT_VERSION)
      .send(makeV2Request({ images: [imagePayload('menu'), imagePayload('menu'), imagePayload('store')] }));

    expect(response.status).toBe(200);
    expect(response.body.contractVersion).toBe(AGENT_TURN_V2_CONTRACT_VERSION);
    expect(response.body.vision).toEqual({
      menuImages: 2,
      storeImages: 1,
      analyzed: true,
      degraded: false,
    });
  });

  it('v2 图片 MIME 非法返回 422，错误体不含 draft / meta', async () => {
    const app = await createApp();
    const response = await request(app.getHttpServer())
      .post('/api/v1/agent/turn')
      .send(makeV2Request({ images: [{ kind: 'menu', mediaType: 'image/gif', data: base64OfBytes(32) }] }));

    expect(response.status).toBe(422);
    expect(response.body.code).toBe('AGENT_IMAGE_TYPE_UNSUPPORTED');
    expect(response.body).not.toHaveProperty('draft');
    expect(response.body).not.toHaveProperty('meta');
    expect(typeof response.body.requestId).toBe('string');
  });

  it('v2 未知字段返回 400 AGENT_REQUEST_INVALID', async () => {
    const app = await createApp();
    const response = await request(app.getHttpServer())
      .post('/api/v1/agent/turn')
      .send(makeV2Request({ images: [], extra: 'x' }));

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('AGENT_REQUEST_INVALID');
  });

  it('未知 contractVersion 返回 400 AGENT_CONTRACT_MISMATCH', async () => {
    const app = await createApp();
    const response = await request(app.getHttpServer())
      .post('/api/v1/agent/turn')
      .send(makeV1Request({ contractVersion: 'agent-turn.v3' }));

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('AGENT_CONTRACT_MISMATCH');
  });
});
