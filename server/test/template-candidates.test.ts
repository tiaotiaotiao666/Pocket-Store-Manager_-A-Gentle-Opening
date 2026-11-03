import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { json } from 'express';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { AgentAuthGuard } from '../src/agent/agent-auth.guard';
import { AGENT_FETCH } from '../src/agent/agent.types';
import { TemplateCandidatesController } from '../src/agent/presentation/template-candidates.controller';
import { TemplateCandidatesService } from '../src/agent/presentation/template-candidates.service';
import { DeepseekPresentationProvider } from '../src/agent/presentation/template-revise.provider';
import { SessionAuthGuard } from '../src/common/auth/session-auth.guard';
import { PrismaService } from '../src/database/prisma.service';
import type { AgentFetch } from '../src/agent/provider/agent-provider.interface';

const CONTRACT = 'agent-template-candidates.v1';
const TEST_KEY = 'sk-test-key-never-real';

function makeRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: CONTRACT,
    selectedFeatures: ['poster-carousel'],
    brief: '家常菜社区小馆',
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

const unexpectedFetch: AgentFetch = async () => {
  throw new Error('测试中禁止真实请求 DeepSeek');
};

const apps: INestApplication[] = [];

async function createApp(options: {
  config?: Record<string, unknown>;
  fetchImpl?: AgentFetch;
} = {}): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [TemplateCandidatesController],
    providers: [
      TemplateCandidatesService,
      DeepseekPresentationProvider,
      SessionAuthGuard,
      AgentAuthGuard,
      {
        provide: ConfigService,
        useValue: new ConfigService({
          NODE_ENV: 'development',
          AGENT_REQUIRE_AUTH: 'false',
          DEEPSEEK_API_BASE_URL: 'https://api.deepseek.com',
          DEEPSEEK_API_KEY: TEST_KEY,
          DEEPSEEK_MODEL: 'deepseek-chat',
          DEEPSEEK_VISION_MODEL: 'deepseek-flash',
          DEEPSEEK_TIMEOUT_MS: '30000',
          ...options.config,
        }),
      },
      {
        provide: PrismaService,
        useValue: { session: { findUnique: async () => null } },
      },
      { provide: AGENT_FETCH, useValue: options.fetchImpl ?? unexpectedFetch },
    ],
  }).compile();

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

const VALID_OUTPUT = {
  orderedTemplateIds: ['signature-kitchen', 'warm-bistro', 'modern-coffee'],
  reasons: {
    'signature-kitchen': '主打招牌菜陈列，适合强调视觉冲击的门店。',
    'warm-bistro': '暖色小馆氛围，适合家常菜与社区餐馆。',
    'modern-coffee': '现代咖啡风格，作为备选。',
  },
};

describe('POST /api/v1/agent/template-candidates 成功路径', () => {
  it('返回 3 个已知模板 ID 与理由，meta 字段严格符合契约', async () => {
    let capturedBody: Record<string, unknown> = {};
    const fetchImpl: AgentFetch = async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return modelResponse(VALID_OUTPUT);
    };

    const app = await createApp({ fetchImpl });
    const response = await request(app.getHttpServer())
      .post('/api/v1/agent/template-candidates')
      .send(makeRequest());

    expect(response.status).toBe(200);
    expect(response.headers['x-request-id']).toMatch(/^req_/);
    expect(response.body).toMatchObject({
      contractVersion: CONTRACT,
      orderedTemplateIds: ['signature-kitchen', 'warm-bistro', 'modern-coffee'],
      reasons: VALID_OUTPUT.reasons,
      meta: { transport: 'http', provider: 'deepseek', mock: false, model: 'deepseek-chat' },
    });
    expect(response.body.turnId).toMatch(/^turn-[0-9a-f-]{36}$/);
    expect(typeof response.body.meta.latencyMs).toBe('number');
    expect(JSON.stringify(response.body)).not.toContain(TEST_KEY);

    expect(capturedBody.model).toBe('deepseek-chat');
    const messages = capturedBody.messages as Array<{ content: unknown }>;
    expect(typeof messages[0].content).toBe('string');
    expect(String(messages[0].content)).toContain('warm-bistro');
  });

  it('理由超过 80 码点时截断到 80', async () => {
    const longReason = '很'.repeat(120);
    const fetchImpl: AgentFetch = async () =>
      modelResponse({
        orderedTemplateIds: ['warm-bistro', 'modern-coffee', 'signature-kitchen'],
        reasons: {
          'warm-bistro': longReason,
          'modern-coffee': '现代咖啡。',
          'signature-kitchen': '招牌厨房。',
        },
      });

    const app = await createApp({ fetchImpl });
    const response = await request(app.getHttpServer())
      .post('/api/v1/agent/template-candidates')
      .send(makeRequest());

    expect(response.status).toBe(200);
    expect([...response.body.reasons['warm-bistro']].length).toBe(80);
  });

  it('忽略 reasons 中的额外键，只保留 3 个模板', async () => {
    const fetchImpl: AgentFetch = async () =>
      modelResponse({
        ...VALID_OUTPUT,
        reasons: { ...VALID_OUTPUT.reasons, ghost: '不应出现' },
      });

    const app = await createApp({ fetchImpl });
    const response = await request(app.getHttpServer())
      .post('/api/v1/agent/template-candidates')
      .send(makeRequest());

    expect(response.status).toBe(200);
    expect(Object.keys(response.body.reasons).sort()).toEqual([
      'modern-coffee',
      'signature-kitchen',
      'warm-bistro',
    ]);
  });
});

describe('POST /api/v1/agent/template-candidates 失败路径', () => {
  it('模型只返回 2 个 ID 时 502 DEEPSEEK_RESPONSE_INVALID', async () => {
    const fetchImpl: AgentFetch = async () =>
      modelResponse({
        orderedTemplateIds: ['warm-bistro', 'modern-coffee'],
        reasons: { 'warm-bistro': 'a', 'modern-coffee': 'b' },
      });
    const app = await createApp({ fetchImpl });
    const response = await request(app.getHttpServer())
      .post('/api/v1/agent/template-candidates')
      .send(makeRequest());

    expect(response.status).toBe(502);
    expect(response.body.code).toBe('DEEPSEEK_RESPONSE_INVALID');
    expect(response.body.requestId).toMatch(/^req_/);
    expect(response.body).not.toHaveProperty('orderedTemplateIds');
  });

  it('模型返回未知模板 ID 时 502', async () => {
    const fetchImpl: AgentFetch = async () =>
      modelResponse({
        orderedTemplateIds: ['warm-bistro', 'modern-coffee', 'ghost-template'],
        reasons: { 'warm-bistro': 'a', 'modern-coffee': 'b', 'ghost-template': 'c' },
      });
    const app = await createApp({ fetchImpl });
    const response = await request(app.getHttpServer())
      .post('/api/v1/agent/template-candidates')
      .send(makeRequest());

    expect(response.status).toBe(502);
    expect(response.body.code).toBe('DEEPSEEK_RESPONSE_INVALID');
  });

  it('模型返回重复 ID 时 502', async () => {
    const fetchImpl: AgentFetch = async () =>
      modelResponse({
        orderedTemplateIds: ['warm-bistro', 'warm-bistro', 'modern-coffee'],
        reasons: { 'warm-bistro': 'a', 'modern-coffee': 'b' },
      });
    const app = await createApp({ fetchImpl });
    const response = await request(app.getHttpServer())
      .post('/api/v1/agent/template-candidates')
      .send(makeRequest());

    expect(response.status).toBe(502);
    expect(response.body.code).toBe('DEEPSEEK_RESPONSE_INVALID');
  });

  it('缺少某个模板的理由时 502', async () => {
    const fetchImpl: AgentFetch = async () =>
      modelResponse({
        orderedTemplateIds: ['warm-bistro', 'modern-coffee', 'signature-kitchen'],
        reasons: { 'warm-bistro': 'a', 'modern-coffee': 'b' },
      });
    const app = await createApp({ fetchImpl });
    const response = await request(app.getHttpServer())
      .post('/api/v1/agent/template-candidates')
      .send(makeRequest());

    expect(response.status).toBe(502);
    expect(response.body.code).toBe('DEEPSEEK_RESPONSE_INVALID');
  });

  it('模型返回非 JSON 时 502', async () => {
    const fetchImpl: AgentFetch = async () => modelResponse('oops');
    const app = await createApp({ fetchImpl });
    const response = await request(app.getHttpServer())
      .post('/api/v1/agent/template-candidates')
      .send(makeRequest());

    expect(response.status).toBe(502);
    expect(response.body.code).toBe('DEEPSEEK_RESPONSE_INVALID');
  });

  it('未配置 DEEPSEEK_API_KEY 时 503，且不发起请求', async () => {
    let called = 0;
    const fetchImpl: AgentFetch = async () => {
      called += 1;
      return modelResponse(VALID_OUTPUT);
    };
    const app = await createApp({ fetchImpl, config: { DEEPSEEK_API_KEY: '' } });
    const response = await request(app.getHttpServer())
      .post('/api/v1/agent/template-candidates')
      .send(makeRequest());

    expect(response.status).toBe(503);
    expect(response.body.code).toBe('DEEPSEEK_NOT_CONFIGURED');
    expect(called).toBe(0);
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
      .post('/api/v1/agent/template-candidates')
      .send(makeRequest());

    expect(response.status).toBe(504);
    expect(response.body.code).toBe('DEEPSEEK_TIMEOUT');
  });

  it('请求不合法时 400 AGENT_REQUEST_INVALID，且不调用模型', async () => {
    let called = 0;
    const fetchImpl: AgentFetch = async () => {
      called += 1;
      return modelResponse(VALID_OUTPUT);
    };
    const app = await createApp({ fetchImpl });

    for (const body of [
      makeRequest({ contractVersion: 'agent-template-candidates.v0' }),
      makeRequest({ selectedFeatures: Array.from({ length: 12 }, (_, index) => `f-${index}`) }),
      makeRequest({ selectedFeatures: 'not-an-array' }),
      makeRequest({ brief: '描'.repeat(501) }),
      makeRequest({ client: { surface: 'desktop', phase: 'store-info' } }),
      makeRequest({ projectId: 'project-1' }),
      makeRequest({ unknownField: true }),
    ]) {
      const response = await request(app.getHttpServer())
        .post('/api/v1/agent/template-candidates')
        .send(body);
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('AGENT_REQUEST_INVALID');
      expect(response.body.requestId).toMatch(/^req_/);
    }

    expect(called).toBe(0);
  });

  it('production 未认证时 401 AUTH_REQUIRED', async () => {
    const app = await createApp({ config: { NODE_ENV: 'production' } });
    const response = await request(app.getHttpServer())
      .post('/api/v1/agent/template-candidates')
      .send(makeRequest());

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('AUTH_REQUIRED');
    expect(response.body.requestId).toMatch(/^req_/);
  });
});