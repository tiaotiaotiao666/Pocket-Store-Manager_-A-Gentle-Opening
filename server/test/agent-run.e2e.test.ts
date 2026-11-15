import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import type { ContractDraft } from '../src/agent/agent.types';
import { AgentAuthGuard } from '../src/agent/agent-auth.guard';
import { AgentExceptionFilter } from '../src/agent/agent-exception.filter';
import { AGENT_CHAT_MODEL } from '../src/agent/agent.types';
import { AgentModelError, type ChatCompletionResult, type ChatModel } from '../src/agent/runtime';
import { StoreSetupAgentController } from '../src/agent/store-setup/store-setup.controller';
import { StoreSetupAgentService } from '../src/agent/store-setup/store-setup.service';
import { AGENT_RUN_CONTRACT_VERSION } from '../src/agent/store-setup/store-setup.types';
import { SessionAuthGuard } from '../src/common/auth/session-auth.guard';
import { PrismaService } from '../src/database/prisma.service';

const EMPTY_DRAFT: ContractDraft = {
  storeName: '',
  category: '',
  businessHours: '',
  fulfillment: { dineIn: false, takeaway: false },
  dishes: [],
};

function makeRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: AGENT_RUN_CONTRACT_VERSION,
    utterance: '帮我开一家面馆。',
    draft: EMPTY_DRAFT,
    client: { surface: 'desktop', phase: 'store-info' },
    projectId: null,
    ...overrides,
  };
}

function toolResult(args: unknown, id = 'call_1'): ChatCompletionResult {
  return {
    message: {
      role: 'assistant',
      content: null,
      toolCalls: [{ id, name: 'update_store_draft', argumentsText: JSON.stringify(args) }],
    },
    finishReason: 'tool_calls',
    model: 'deepseek-chat',
    latencyMs: 3,
    usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60 },
  };
}

function textResult(text: string): ChatCompletionResult {
  return {
    message: { role: 'assistant', content: text },
    finishReason: 'stop',
    model: 'deepseek-chat',
    latencyMs: 2,
  };
}

function scriptedModel(results: ChatCompletionResult[]): ChatModel {
  const queue = [...results];
  return {
    name: 'scripted',
    complete: async () => {
      const next = queue.shift();
      if (next === undefined) throw new Error('模型脚本已用尽。');
      return next;
    },
  };
}

const apps: INestApplication[] = [];

async function createApp(options: {
  config?: Record<string, unknown>;
  model?: ChatModel;
}): Promise<INestApplication> {
  const config = {
    NODE_ENV: 'development',
    AGENT_REQUIRE_AUTH: 'false',
    AGENT_RUN_MAX_STEPS: 6,
    AGENT_RUN_MAX_TOOL_CALLS: 12,
    AGENT_RUN_TIMEOUT_MS: 60_000,
    ...options.config,
  };
  const model =
    options.model ??
    scriptedModel([
      toolResult({
        storeName: '孙记面馆',
        category: '面馆',
        businessHours: '10:00-21:00',
        fulfillment: { dineIn: true, takeaway: true },
        dishes: [
          { name: '牛肉面', priceCents: 2800 },
          { name: '凉皮', priceCents: 1200 },
          { name: '酸梅汤', priceCents: 800 },
        ],
      }),
      textResult('资料已整理好，请确认。'),
    ]);

  const moduleRef = await Test.createTestingModule({
    controllers: [StoreSetupAgentController],
    providers: [
      StoreSetupAgentService,
      SessionAuthGuard,
      AgentAuthGuard,
      AgentExceptionFilter,
      { provide: ConfigService, useValue: new ConfigService(config) },
      {
        provide: PrismaService,
        useValue: {
          session: { findUnique: async () => null },
        },
      },
      { provide: AGENT_CHAT_MODEL, useValue: model },
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

describe('POST /api/v1/agent/run', () => {
  it('跑完 function calling 循环并返回 agent-run.v1 响应', async () => {
    const app = await createApp({});

    const response = await request(app.getHttpServer())
      .post('/api/v1/agent/run')
      .set('X-Request-Id', 'req_0123456789abcdef01234567')
      .send(makeRequest());

    expect(response.status).toBe(200);
    expect(response.headers['x-request-id']).toBe('req_0123456789abcdef01234567');
    expect(response.body.contractVersion).toBe(AGENT_RUN_CONTRACT_VERSION);
    expect(response.body.status).toBe('reviewing');
    expect(response.body.reply).toBe('资料已整理好，请确认。');
    expect(response.body.draft.storeName).toBe('孙记面馆');
    expect(response.body.trace).toMatchObject({
      modelCalls: 2,
      stopReason: 'final_answer',
      degraded: false,
    });
    expect(response.body.trace.toolCalls).toHaveLength(1);
    expect(response.body.trace.toolCalls[0]).toMatchObject({
      name: 'update_store_draft',
      ok: true,
      attempts: 1,
    });
    expect(response.body.meta).toMatchObject({
      transport: 'http',
      provider: 'deepseek',
      mock: false,
      model: 'deepseek-chat',
    });
  });

  it('缺少 X-Request-Id 时自动生成并回写', async () => {
    const app = await createApp({});

    const response = await request(app.getHttpServer())
      .post('/api/v1/agent/run')
      .send(makeRequest({ utterance: '只回应一下。' }));

    expect(response.status).toBe(200);
    expect(response.headers['x-request-id']).toMatch(/^req_[0-9a-f]{24}$/);
  });

  it('契约版本不匹配时返回 400 AGENT_CONTRACT_MISMATCH', async () => {
    const app = await createApp({});

    const response = await request(app.getHttpServer())
      .post('/api/v1/agent/run')
      .send(makeRequest({ contractVersion: 'agent-run.v2' }));

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('AGENT_CONTRACT_MISMATCH');
    expect(response.body.requestId).toBe(response.headers['x-request-id']);
  });

  it('production 未认证时返回 401 AUTH_REQUIRED', async () => {
    const app = await createApp({ config: { NODE_ENV: 'production' } });

    const response = await request(app.getHttpServer())
      .post('/api/v1/agent/run')
      .send(makeRequest());

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('AUTH_REQUIRED');
  });

  it('模型未配置时返回 503，且不泄露上游细节', async () => {
    const model: ChatModel = {
      name: 'unconfigured',
      complete: async () => {
        throw new AgentModelError('DEEPSEEK_NOT_CONFIGURED', '未配置 DEEPSEEK_API_KEY。', {
          retryable: false,
        });
      },
    };
    const app = await createApp({ model });

    const response = await request(app.getHttpServer())
      .post('/api/v1/agent/run')
      .send(makeRequest());

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ code: 'DEEPSEEK_NOT_CONFIGURED' });
    expect(JSON.stringify(response.body)).not.toContain('stack');
  });
});
