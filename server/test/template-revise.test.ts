import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { json } from 'express';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { AgentAuthGuard } from '../src/agent/agent-auth.guard';
import { AGENT_FETCH } from '../src/agent/agent.types';
import { DeepseekPresentationProvider } from '../src/agent/presentation/template-revise.provider';
import { TemplateReviseController } from '../src/agent/presentation/template-revise.controller';
import { TemplateReviseService } from '../src/agent/presentation/template-revise.service';
import { hashSessionToken, SessionAuthGuard } from '../src/common/auth/session-auth.guard';
import { PrismaService } from '../src/database/prisma.service';
import type { AgentFetch } from '../src/agent/provider/agent-provider.interface';

const CONTRACT = 'agent-template-revise.v1';
const TEST_KEY = 'sk-test-key-never-real';
const TEST_BASE_URL = 'https://api.deepseek.com';

function emptyDraft(): Record<string, unknown> {
  return {
    storeName: '',
    category: '',
    businessHours: '',
    fulfillment: { dineIn: false, takeaway: false },
    dishes: [],
  };
}

function makeRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: CONTRACT,
    utterance: '把主色改成墨绿',
    candidate: { templateId: 'warm-bistro', layout: 'menu' },
    planFeatures: [],
    basePatch: {},
    baseDraft: emptyDraft(),
    client: { surface: 'desktop', phase: 'template-pick' },
    projectId: null,
    ...overrides,
  };
}

function modelResponse(content: unknown): Response {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      choices: [{ message: { role: 'assistant', content: typeof content === 'string' ? content : JSON.stringify(content) } }],
    }),
  } as unknown as Response;
}

function upstreamError(status: number): Response {
  return {
    ok: false,
    status,
    text: async () => JSON.stringify({ error: { message: 'upstream failed' } }),
  } as unknown as Response;
}

const unexpectedFetch: AgentFetch = async () => {
  throw new Error('测试中禁止真实请求 DeepSeek');
};

const apps: INestApplication[] = [];

async function createApp(options: {
  config?: Record<string, unknown>;
  fetchImpl?: AgentFetch;
  session?: { token: string; expiresAt?: Date };
} = {}): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [TemplateReviseController],
    providers: [
      TemplateReviseService,
      DeepseekPresentationProvider,
      SessionAuthGuard,
      AgentAuthGuard,
      {
        provide: ConfigService,
        useValue: new ConfigService({
          NODE_ENV: 'development',
          AGENT_REQUIRE_AUTH: 'false',
          DEEPSEEK_API_BASE_URL: TEST_BASE_URL,
          DEEPSEEK_API_KEY: TEST_KEY,
          DEEPSEEK_MODEL: 'deepseek-chat',
          DEEPSEEK_VISION_MODEL: 'deepseek-flash',
          DEEPSEEK_TIMEOUT_MS: '30000',
          ...options.config,
        }),
      },
      {
        provide: PrismaService,
        useValue: {
          session: {
            findUnique: async ({ where }: { where: { tokenHash: string } }) => {
              if (!options.session || where.tokenHash !== hashSessionToken(options.session.token)) return null;
              return {
                id: 'session-1',
                expiresAt: options.session.expiresAt ?? new Date(Date.now() + 60_000),
                user: { id: 'user-1', displayName: '店主' },
              };
            },
          },
        },
      },
      { provide: AGENT_FETCH, useValue: options.fetchImpl ?? unexpectedFetch },
    ],
  }).compile();

  // T9 会统一配置 AGENT_MAX_BODY_BYTES；此处显式抬高上限，避免默认 100 KiB
  // 在进入应用层之前就返回 413，从而能验证图片解码大小校验本身。
  const app = moduleRef.createNestApplication({ bodyParser: false });
  app.use(json({ limit: '2mb' }));
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

describe('POST /api/v1/agent/template-revise 成功路径', () => {
  it('合并模型补丁、服务端重算 changes，并忽略模型自述的 changes', async () => {
    let capturedUrl = '';
    let capturedBody: Record<string, unknown> = {};
    const fetchImpl: AgentFetch = async (url, init) => {
      capturedUrl = url;
      capturedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return modelResponse({
        reply: '已把主色改为墨绿。',
        presentationPatch: { theme: { primaryColor: '#1F6F5C' } },
        // 模型自述的 changes 必须被丢弃。
        changes: [{ path: 'fake.change', label: '伪造', before: null, after: null }],
      });
    };

    const app = await createApp({ fetchImpl });
    const response = await request(app.getHttpServer())
      .post('/api/v1/agent/template-revise')
      .set('X-Agent-Contract', CONTRACT)
      .send(makeRequest());

    expect(response.status).toBe(200);
    expect(response.headers['x-request-id']).toMatch(/^req_/);
    expect(response.body).toMatchObject({
      contractVersion: CONTRACT,
      reply: '已把主色改为墨绿。',
      patch: { theme: { primaryColor: '#1F6F5C' } },
      changes: [
        { path: 'theme.primaryColor', label: '主色', before: null, after: '#1F6F5C' },
      ],
      meta: { transport: 'http', provider: 'deepseek', mock: false, model: 'deepseek-chat' },
    });
    expect(response.body.turnId).toMatch(/^turn-[0-9a-f-]{36}$/);
    expect(typeof response.body.meta.latencyMs).toBe('number');
    expect(JSON.stringify(response.body)).not.toContain(TEST_KEY);

    // 无图片时使用文本模型，content 是字符串。
    expect(capturedUrl).toBe(`${TEST_BASE_URL}/chat/completions`);
    expect(capturedBody.model).toBe('deepseek-chat');
    const messages = capturedBody.messages as Array<{ role: string; content: unknown }>;
    expect(Array.isArray(messages)).toBe(true);
    expect(typeof messages[0].content).toBe('string');
    expect(String(messages[0].content)).toContain('presentationPatch');
  });

  it('连续两轮：第二轮携带第一轮 patch，结果累积', async () => {
    let call = 0;
    const fetchImpl: AgentFetch = async () => {
      call += 1;
      if (call === 1) {
        return modelResponse({ reply: '已改主色', presentationPatch: { theme: { primaryColor: '#1F6F5C' } } });
      }
      return modelResponse({ reply: '已加底色', presentationPatch: { theme: { pageBackground: '#FFFDF7' } } });
    };

    const app = await createApp({ fetchImpl });
    const server = app.getHttpServer();

    const first = await request(server).post('/api/v1/agent/template-revise').send(makeRequest());
    expect(first.status).toBe(200);

    const second = await request(server)
      .post('/api/v1/agent/template-revise')
      .send(makeRequest({ utterance: '再加一个米白底色', basePatch: first.body.patch }));

    expect(second.status).toBe(200);
    expect(second.body.patch).toEqual({
      theme: { primaryColor: '#1F6F5C', pageBackground: '#FFFDF7' },
    });
    expect(second.body.changes).toEqual([
      { path: 'theme.pageBackground', label: '页面背景色', before: null, after: '#FFFDF7' },
    ]);
  });

  it('planFeatures 含 poster-carousel 时允许把区块落到 menu-hero', async () => {
    const fetchImpl: AgentFetch = async () =>
      modelResponse({
        reply: '已把轮播移到菜单首屏。',
        presentationPatch: {
          slotOrder: [{ featureId: 'poster-carousel', pageId: 'menu', slotId: 'menu-hero' }],
        },
      });

    const app = await createApp({ fetchImpl });
    const response = await request(app.getHttpServer())
      .post('/api/v1/agent/template-revise')
      .send(makeRequest({ planFeatures: [{ featureId: 'poster-carousel', pageId: 'home', slotId: 'home-hero' }] }));

    expect(response.status).toBe(200);
    expect(response.body.patch.slotOrder).toEqual([
      { featureId: 'poster-carousel', pageId: 'menu', slotId: 'menu-hero' },
    ]);
    expect(response.body.changes).toContainEqual({
      path: 'slotOrder.poster-carousel',
      label: '区块位置',
      before: null,
      after: 'menu/menu-hero',
    });
  });

  it('带图片时使用 DEEPSEEK_VISION_MODEL 并构造 OpenAI 多模态 content parts', async () => {
    let capturedBody: Record<string, unknown> = {};
    const fetchImpl: AgentFetch = async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return modelResponse({ reply: '按门店环境照调整了强调色', presentationPatch: { theme: { accentColor: '#D97706' } } });
    };

    const imageData = Buffer.alloc(16, 7).toString('base64');
    const app = await createApp({ fetchImpl });
    const response = await request(app.getHttpServer())
      .post('/api/v1/agent/template-revise')
      .send(makeRequest({
        utterance: '按门店照片调一下强调色',
        images: [{ kind: 'store', mediaType: 'image/png', data: imageData }],
      }));

    expect(response.status).toBe(200);
    expect(capturedBody.model).toBe('deepseek-flash');
    const messages = capturedBody.messages as Array<{ content: unknown }>;
    const content = messages[0].content as Array<Record<string, unknown>>;
    expect(Array.isArray(content)).toBe(true);
    expect(content[0]).toMatchObject({ type: 'text' });
    expect(content[1]).toMatchObject({
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${imageData}`, detail: 'low' },
    });
    expect(response.body.meta.model).toBe('deepseek-flash');
    // 响应体不得回传 base64 或密钥。
    expect(JSON.stringify(response.body)).not.toContain(imageData);
    expect(JSON.stringify(response.body)).not.toContain(TEST_KEY);
  });
});

describe('POST /api/v1/agent/template-revise 失败路径', () => {
  it('模型返回非法颜色时 422 PATCH_THEME_COLOR_INVALID，无部分写入', async () => {
    const fetchImpl: AgentFetch = async () =>
      modelResponse({ reply: '已修改', presentationPatch: { theme: { primaryColor: '#123' } } });

    const app = await createApp({ fetchImpl });
    const response = await request(app.getHttpServer())
      .post('/api/v1/agent/template-revise')
      .send(makeRequest());

    expect(response.status).toBe(422);
    expect(response.body.code).toBe('PATCH_THEME_COLOR_INVALID');
    expect(response.body.requestId).toMatch(/^req_/);
    expect(response.headers['x-request-id']).toBe(response.body.requestId);
    expect(response.body).not.toHaveProperty('patch');
    expect(response.body).not.toHaveProperty('changes');
    expect(response.body).not.toHaveProperty('meta');
  });

  it('模型返回未知补丁键时 422 PRESENTATION_PATCH_INVALID', async () => {
    const fetchImpl: AgentFetch = async () =>
      modelResponse({ reply: '已修改', presentationPatch: { layout: 'menu' } });

    const app = await createApp({ fetchImpl });
    const response = await request(app.getHttpServer())
      .post('/api/v1/agent/template-revise')
      .send(makeRequest());

    expect(response.status).toBe(422);
    expect(response.body.code).toBe('PRESENTATION_PATCH_INVALID');
  });

  it('模型返回非 JSON 时 502 DEEPSEEK_RESPONSE_INVALID', async () => {
    const fetchImpl: AgentFetch = async () => modelResponse('这不是 JSON');
    const app = await createApp({ fetchImpl });
    const response = await request(app.getHttpServer())
      .post('/api/v1/agent/template-revise')
      .send(makeRequest());

    expect(response.status).toBe(502);
    expect(response.body.code).toBe('DEEPSEEK_RESPONSE_INVALID');
    expect(response.body.requestId).toMatch(/^req_/);
  });

  it('模型缺少 presentationPatch 字段时 502，不返回部分成功', async () => {
    const fetchImpl: AgentFetch = async () => modelResponse({ reply: '只说了句话' });
    const app = await createApp({ fetchImpl });
    const response = await request(app.getHttpServer())
      .post('/api/v1/agent/template-revise')
      .send(makeRequest());

    expect(response.status).toBe(502);
    expect(response.body.code).toBe('DEEPSEEK_RESPONSE_INVALID');
    expect(response.body).not.toHaveProperty('patch');
  });

  it('未配置 DEEPSEEK_API_KEY 时 503 DEEPSEEK_NOT_CONFIGURED，且不发起请求', async () => {
    let called = 0;
    const fetchImpl: AgentFetch = async () => {
      called += 1;
      return modelResponse({ presentationPatch: {} });
    };
    const app = await createApp({ fetchImpl, config: { DEEPSEEK_API_KEY: '' } });
    const response = await request(app.getHttpServer())
      .post('/api/v1/agent/template-revise')
      .send(makeRequest());

    expect(response.status).toBe(503);
    expect(response.body.code).toBe('DEEPSEEK_NOT_CONFIGURED');
    expect(response.body.message).toBe('DeepSeek 未配置');
    expect(called).toBe(0);
    expect(JSON.stringify(response.body)).not.toContain(TEST_KEY);
  });

  it('上游超时 504 DEEPSEEK_TIMEOUT', async () => {
    const hangingFetch: AgentFetch = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }
      });

    const app = await createApp({ fetchImpl: hangingFetch, config: { DEEPSEEK_TIMEOUT_MS: '20' } });
    const response = await request(app.getHttpServer())
      .post('/api/v1/agent/template-revise')
      .send(makeRequest());

    expect(response.status).toBe(504);
    expect(response.body.code).toBe('DEEPSEEK_TIMEOUT');
  });

  it('上游 5xx 映射为 502 DEEPSEEK_UPSTREAM_ERROR', async () => {
    const fetchImpl: AgentFetch = async () => upstreamError(500);
    const app = await createApp({ fetchImpl });
    const response = await request(app.getHttpServer())
      .post('/api/v1/agent/template-revise')
      .send(makeRequest());

    expect(response.status).toBe(502);
    expect(response.body.code).toBe('DEEPSEEK_UPSTREAM_ERROR');
  });

  it('请求不合法时 400 AGENT_REQUEST_INVALID，且不调用模型', async () => {
    let called = 0;
    const fetchImpl: AgentFetch = async () => {
      called += 1;
      return modelResponse({ presentationPatch: {} });
    };
    const app = await createApp({ fetchImpl });

    for (const body of [
      makeRequest({ utterance: '   ' }),
      makeRequest({ contractVersion: 'agent-template-revise.v0' }),
      makeRequest({ candidate: { templateId: 'ghost', layout: 'menu' } }),
      makeRequest({ planFeatures: [{ featureId: 'poster-carousel', pageId: 'menu', slotId: 'home-hero' }] }),
      makeRequest({ client: { surface: 'desktop', phase: 'store-info' } }),
      makeRequest({ unknownField: true }),
    ]) {
      const response = await request(app.getHttpServer())
        .post('/api/v1/agent/template-revise')
        .send(body);
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('AGENT_REQUEST_INVALID');
      expect(response.body.requestId).toMatch(/^req_/);
    }

    expect(called).toBe(0);
  });

  it('basePatch 本身不合法时 422，且不调用模型', async () => {
    let called = 0;
    const fetchImpl: AgentFetch = async () => {
      called += 1;
      return modelResponse({ presentationPatch: {} });
    };
    const app = await createApp({ fetchImpl });
    const response = await request(app.getHttpServer())
      .post('/api/v1/agent/template-revise')
      .send(makeRequest({ basePatch: { theme: { primaryColor: 'red' } } }));

    expect(response.status).toBe(422);
    expect(response.body.code).toBe('PATCH_THEME_COLOR_INVALID');
    expect(called).toBe(0);
  });

  it('图片超过 400 KiB 时 422 AGENT_IMAGE_TOO_LARGE，且不调用模型', async () => {
    let called = 0;
    const fetchImpl: AgentFetch = async () => {
      called += 1;
      return modelResponse({ presentationPatch: {} });
    };
    const app = await createApp({ fetchImpl });
    const response = await request(app.getHttpServer())
      .post('/api/v1/agent/template-revise')
      .send(makeRequest({
        images: [
          { kind: 'store', mediaType: 'image/png', data: Buffer.alloc(409601, 1).toString('base64') },
        ],
      }));

    expect(response.status).toBe(422);
    expect(response.body.code).toBe('AGENT_IMAGE_TOO_LARGE');
    expect(called).toBe(0);
  });

  it('production 未认证时 401 AUTH_REQUIRED，错误体含 requestId', async () => {
    const app = await createApp({ config: { NODE_ENV: 'production', AGENT_REQUIRE_AUTH: 'false' } });
    const response = await request(app.getHttpServer())
      .post('/api/v1/agent/template-revise')
      .send(makeRequest());

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('AUTH_REQUIRED');
    expect(response.body.requestId).toMatch(/^req_/);
    expect(response.headers['x-request-id']).toBe(response.body.requestId);
  });
});