import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { AgentAuthGuard } from '../src/agent/agent-auth.guard';
import { AgentController } from '../src/agent/agent.controller';
import { hashSessionToken, SessionAuthGuard } from '../src/common/auth/session-auth.guard';
import { PrismaService } from '../src/database/prisma.service';
import { AgentService } from '../src/agent/agent.service';
import { AGENT_FETCH, AGENT_PROVIDER, AGENT_TURN_CONTRACT_VERSION } from '../src/agent/agent.types';
import { DeepseekAgentProvider } from '../src/agent/provider/deepseek-agent.provider';
import type { AgentProvider } from '../src/agent/provider/agent-provider.interface';
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

function makeRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: AGENT_TURN_CONTRACT_VERSION,
    utterance: '店名叫松月食堂',
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

const stubProvider: AgentProvider = {
  name: 'deepseek',
  async extractTurn() {
    return { reply: '好的', draftPatch: completePatch(), model: 'deepseek-chat', latencyMs: 1 };
  },
};

const unexpectedFetch = async (): Promise<Response> => {
  throw new Error('测试中禁止真实请求 DeepSeek');
};

const apps: INestApplication[] = [];

async function createApp(options: {
  config: Record<string, unknown>;
  provider?: unknown;
  session?: { token: string; expiresAt?: Date };
}): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [AgentController],
    providers: [
      AgentService,
      SessionAuthGuard,
      AgentAuthGuard,
      { provide: ConfigService, useValue: new ConfigService(options.config) },
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
      { provide: AGENT_PROVIDER, useValue: options.provider ?? stubProvider },
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

describe('POST /api/v1/agent/turn', () => {
  it('development + AGENT_REQUIRE_AUTH=false 允许未认证联调，并返回 agent-turn.v1', async () => {
    const app = await createApp({
      config: { NODE_ENV: 'development', AGENT_REQUIRE_AUTH: 'false' },
    });

    const response = await request(app.getHttpServer())
      .post('/api/v1/agent/turn')
      .set('X-Agent-Contract', AGENT_TURN_CONTRACT_VERSION)
      .send(makeRequest());

    expect(response.status).toBe(200);
    expect(response.headers['x-request-id']).toMatch(/^req_[0-9a-f]{24}$/);
    expect(response.body.contractVersion).toBe(AGENT_TURN_CONTRACT_VERSION);
    expect(response.body.status).toBe('reviewing');
    expect(response.body.meta).toMatchObject({ transport: 'http', provider: 'deepseek', mock: false });
  });

  it('T13 production 无 Authorization 返回 401 AUTH_REQUIRED，并带 requestId', async () => {
    const app = await createApp({
      config: { NODE_ENV: 'production', AGENT_REQUIRE_AUTH: 'false' },
    });

    const response = await request(app.getHttpServer())
      .post('/api/v1/agent/turn')
      .send(makeRequest());

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('AUTH_REQUIRED');
    expect(response.body.requestId).toMatch(/^req_/);
    expect(response.headers['x-request-id']).toBe(response.body.requestId);
  });

  it('AGENT_REQUIRE_AUTH=true 时 development 也拒绝未认证调用', async () => {
    const app = await createApp({
      config: { NODE_ENV: 'development', AGENT_REQUIRE_AUTH: 'true' },
    });
    const response = await request(app.getHttpServer())
      .post('/api/v1/agent/turn')
      .send(makeRequest());
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('AUTH_REQUIRED');
  });

  it('production 伪造 Bearer 返回 401 AUTH_INVALID', async () => {
    const app = await createApp({
      config: { NODE_ENV: 'production', AGENT_REQUIRE_AUTH: 'true' },
    });
    const response = await request(app.getHttpServer())
      .post('/api/v1/agent/turn')
      .set('Authorization', 'Bearer local-placeholder-token')
      .send(makeRequest());
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('AUTH_INVALID');
  });

  it('production 过期会话返回 401 AUTH_INVALID', async () => {
    const app = await createApp({
      config: { NODE_ENV: 'production', AGENT_REQUIRE_AUTH: 'true' },
      session: { token: 'expired-session-token', expiresAt: new Date(Date.now() - 1000) },
    });
    const response = await request(app.getHttpServer())
      .post('/api/v1/agent/turn')
      .set('Authorization', 'Bearer expired-session-token')
      .send(makeRequest());
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('AUTH_INVALID');
  });

  it('production 有效会话返回 200', async () => {
    const app = await createApp({
      config: { NODE_ENV: 'production', AGENT_REQUIRE_AUTH: 'true' },
      session: { token: 'valid-session-token' },
    });
    const response = await request(app.getHttpServer())
      .post('/api/v1/agent/turn')
      .set('Authorization', 'Bearer valid-session-token')
      .send(makeRequest());
    expect(response.status).toBe(200);
  });

  it('Authorization 不是 Bearer 时返回 401 AUTH_INVALID', async () => {
    const app = await createApp({
      config: { NODE_ENV: 'development', AGENT_REQUIRE_AUTH: 'false' },
    });
    const response = await request(app.getHttpServer())
      .post('/api/v1/agent/turn')
      .set('Authorization', 'Basic abc123')
      .send(makeRequest());
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('AUTH_INVALID');
  });

  it('T10 服务端缺少 DEEPSEEK_API_KEY 时返回 503 DEEPSEEK_NOT_CONFIGURED，不回退 Mock', async () => {
    const app = await createApp({
      config: { NODE_ENV: 'development', AGENT_REQUIRE_AUTH: 'false', DEEPSEEK_API_KEY: '' },
      provider: new DeepseekAgentProvider(
        new ConfigService({ DEEPSEEK_API_KEY: '', DEEPSEEK_API_BASE_URL: 'https://api.deepseek.com' }),
        unexpectedFetch,
      ),
    });

    const response = await request(app.getHttpServer())
      .post('/api/v1/agent/turn')
      .send(makeRequest());

    expect(response.status).toBe(503);
    expect(response.body.code).toBe('DEEPSEEK_NOT_CONFIGURED');
    expect(response.body.message).toBe('DeepSeek 未配置');
    expect(response.body).not.toHaveProperty('meta');
    expect(JSON.stringify(response.body)).not.toContain('sk-');
  });

  it('请求契约不合法返回 400 AGENT_CONTRACT_MISMATCH', async () => {
    const app = await createApp({
      config: { NODE_ENV: 'development', AGENT_REQUIRE_AUTH: 'false' },
    });
    const response = await request(app.getHttpServer())
      .post('/api/v1/agent/turn')
      .send(makeRequest({ contractVersion: 'agent-turn.v0' }));
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('AGENT_CONTRACT_MISMATCH');
  });
});

describe('安全边界静态检查', () => {
  function listTypeScriptFiles(dir: string): string[] {
    const result: string[] = [];
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      if (statSync(fullPath).isDirectory()) {
        result.push(...listTypeScriptFiles(fullPath));
      } else if (entry.endsWith('.ts')) {
        result.push(fullPath);
      }
    }
    return result;
  }

  it('T14 确认前没有任何数据库写入：agent 模块不依赖 Prisma 或本地存储', () => {
    const files = listTypeScriptFiles(join(process.cwd(), 'src/agent'));
    expect(files.length).toBeGreaterThan(5);

    const forbidden = [
      'PrismaService',
      'PrismaClient',
      '$executeRaw',
      '$queryRaw',
      'localStorage',
      'sessionStorage',
      'document.cookie',
    ];

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const token of forbidden) {
        expect(source.includes(token), `${file} 不应包含 ${token}`).toBe(false);
      }
    }
  });

  it('main.ts 的 CORS allowedHeaders 包含 X-Agent-Contract 与 X-Agent-Request-Id，并暴露 X-Request-Id', () => {
    const source = readFileSync(join(process.cwd(), 'src/main.ts'), 'utf8');
    expect(source).toContain("'X-Agent-Contract'");
    expect(source).toContain("'X-Agent-Request-Id'");
    expect(source).toContain("exposedHeaders: ['X-Request-Id']");
  });

  it('app.module.ts 已注册 AgentModule', () => {
    const source = readFileSync(join(process.cwd(), 'src/app.module.ts'), 'utf8');
    expect(source).toContain("from './agent/agent.module'");
    expect(source).toContain('AgentModule');
  });

  it('env.validation.ts 校验 DeepSeek 配置且生产强制 AGENT_REQUIRE_AUTH=true', () => {
    const source = readFileSync(join(process.cwd(), 'src/common/config/env.validation.ts'), 'utf8');
    for (const key of [
      'DEEPSEEK_API_BASE_URL',
      'DEEPSEEK_API_KEY',
      'DEEPSEEK_MODEL',
      'DEEPSEEK_TIMEOUT_MS',
      'AGENT_REQUIRE_AUTH',
    ]) {
      expect(source).toContain(key);
    }
    expect(source).toContain('生产环境必须配置 AGENT_REQUIRE_AUTH=true');
  });
});