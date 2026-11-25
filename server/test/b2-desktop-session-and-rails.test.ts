/**
 * B2：收口号令、监听来源与模型调用滥用风险。
 *
 * 覆盖点（对应 B2 验收第 8 条）：
 * 1. 无凭证 / 伪造凭证 / 过期凭证一律 401，且**没有任何上游模型调用**；
 * 2. 桌面短期本地会话（POST /api/v1/desktop/session）只对回环来源签发，token 可调模型接口；
 * 3. 默认只监听 127.0.0.1；非回环监听必须强制 AGENT_REQUIRE_AUTH=true，否则启动即失败；
 * 4. CORS 显式白名单：非白名单 Origin 直接 403，无 Origin 请求不受影响；
 * 5. 超限 429 + Retry-After，且被拒绝的请求不进 handler（上游零调用）；
 * 6. 健康检查不受鉴权与护栏影响。
 *
 * 注意：本文件不用装饰器声明测试用控制器。`test/` 不在 tsconfig 的 include 里，
 * vitest 会对未覆盖文件按默认 TS 目标降级装饰器，导致 SyntaxError；
 * 这里改用 Nest 运行时依赖的同一套元数据键来声明路由（见 defineFakeAgentRoute）。
 */
import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { readFileSync } from 'node:fs';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentAuthGuard } from '../src/agent/agent-auth.guard';
import {
  AGENT_BUSY_CODE,
  AGENT_RATE_LIMITED_CODE,
  AgentConcurrencyInterceptor,
  AgentRateLimitGuard,
  AgentRailsStore,
  readAgentRailsOptions,
  resolveRateKey,
} from '../src/agent/agent-guard-rails';
import { SessionAuthGuard } from '../src/common/auth/session-auth.guard';
import { AppError } from '../src/common/http/app-error';
import { validateEnv } from '../src/common/config/env.validation';
import { DesktopSessionController } from '../src/desktop/desktop-session.controller';
import { DesktopSessionService } from '../src/desktop/desktop-session.service';
import { DesktopSessionStore, hashDesktopToken, resetSharedDesktopStore } from '../src/desktop/desktop-session.store';
import { isLoopbackAddress, isLoopbackHost } from '../src/desktop/loopback';
import {
  createOriginGuard,
  DEFAULT_SERVER_HOST,
  resolveAllowedOrigins,
  resolveListenHost,
} from '../src/main';

// ---------------------------------------------------------------------------
// 测试用 agent 控制器：只统计「有没有真的进 handler」，用来证明 401/429 时上游零调用。
// ---------------------------------------------------------------------------

const upstream = { calls: 0 };

class FakeAgentController {
  turn(): { ok: true } {
    upstream.calls += 1;
    return { ok: true };
  }
}

/** 用与装饰器等价的元数据声明 `POST /agent/turn` + 控制器级 AgentAuthGuard。 */
function defineFakeAgentRoute(): void {
  Reflect.defineMetadata(PATH_METADATA, 'agent', FakeAgentController);
  Reflect.defineMetadata(METHOD_METADATA, RequestMethod.POST, FakeAgentController.prototype.turn);
  Reflect.defineMetadata(PATH_METADATA, 'turn', FakeAgentController.prototype.turn);
  Reflect.defineMetadata(GUARDS_METADATA, [AgentAuthGuard], FakeAgentController);
}
defineFakeAgentRoute();

function makeConfig(values: Record<string, string>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

function makeDesktopSessions(overrides: Record<string, string> = {}): DesktopSessionService {
  return new DesktopSessionService(
    makeConfig({ DESKTOP_SESSION_TTL_SECONDS: '900', DESKTOP_SESSION_ISSUE_PER_MINUTE: '10', ...overrides }),
  );
}

interface AppOptions {
  perMinute?: number;
  maxConcurrent?: number;
  requireAuth?: boolean;
}

async function createApp(options: AppOptions = {}) {
  const config = makeConfig({
    NODE_ENV: 'test',
    AGENT_REQUIRE_AUTH: options.requireAuth === false ? 'false' : 'true',
    DESKTOP_SESSION_TTL_SECONDS: '900',
    DESKTOP_SESSION_ISSUE_PER_MINUTE: '10',
  });
  const moduleRef = await Test.createTestingModule({
    controllers: [DesktopSessionController, FakeAgentController],
    providers: [
      DesktopSessionService,
      AgentAuthGuard,
      { provide: ConfigService, useValue: config },
      // 店主会话（微信登录）在本套件里用桩：伪造 token 必须被拒。
      {
        provide: SessionAuthGuard,
        useValue: {
          canActivate: vi.fn(async () => {
            throw new AppError(401, 'AUTH_INVALID', '登录状态无效，请重新登录');
          }),
        },
      },
      {
        provide: AgentRailsStore,
        useValue: new AgentRailsStore({
          perMinute: options.perMinute ?? 0,
          maxConcurrent: options.maxConcurrent ?? 0,
        }),
      },
      { provide: APP_GUARD, useClass: AgentRateLimitGuard },
      { provide: APP_INTERCEPTOR, useClass: AgentConcurrencyInterceptor },
    ],
  }).compile();

  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  await app.init();
  return app;
}

type TestApp = Awaited<ReturnType<typeof createApp>>;

let app: TestApp | null = null;

beforeEach(() => {
  // 桌面 token 表是进程内单例：每个用例从空表开始，等价于一次重启。
  resetSharedDesktopStore();
});

afterEach(async () => {
  upstream.calls = 0;
  if (app) {
    await app.close();
    app = null;
  }
});

// ---------------------------------------------------------------------------

describe('回环判定', () => {
  it('只把本机地址当回环，局域网/公网一律不算', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('127.8.9.10')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('192.168.1.20')).toBe(false);
    expect(isLoopbackAddress('10.0.0.5')).toBe(false);
    expect(isLoopbackAddress('8.8.8.8')).toBe(false);
    expect(isLoopbackAddress('')).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('::')).toBe(false);
  });
});

describe('桌面短期本地会话', () => {
  it('签发后可用；过期与未知都判无效；token 不以明文规则保存', () => {
    let now = 1_000_000;
    const store = new DesktopSessionStore({ ttlSeconds: 60, now: () => now });
    const issued = store.issue();
    expect(issued.token).toMatch(/^ds_[0-9a-f]{48}$/);
    expect(store.verify(issued.token)).toMatchObject({ ok: true });
    expect(hashDesktopToken(issued.token)).toHaveLength(64);

    now += 59_000;
    expect(store.verify(issued.token)).toMatchObject({ ok: true });
    now += 2_000;
    expect(store.verify(issued.token)).toMatchObject({ ok: false, reason: 'expired' });

    expect(store.verify('ds_' + 'a'.repeat(48))).toMatchObject({ ok: false, reason: 'unknown' });
    expect(store.verify('')).toMatchObject({ ok: false, reason: 'unknown' });
    expect(store.verify(null)).toMatchObject({ ok: false, reason: 'unknown' });
    expect(store.size()).toBe(0);
  });

  it('同时在世 token 有上限，超出淘汰最早的，避免本地进程无限签发', () => {
    const store = new DesktopSessionStore({ ttlSeconds: 900, maxLive: 2 });
    const first = store.issue();
    const second = store.issue();
    const third = store.issue();
    expect(store.size()).toBe(2);
    expect(store.verify(first.token).ok).toBe(false);
    expect(store.verify(second.token).ok).toBe(true);
    expect(store.verify(third.token).ok).toBe(true);
  });

  it('申领有每分钟配额，超限给出可重试秒数', () => {
    const service = makeDesktopSessions({ DESKTOP_SESSION_ISSUE_PER_MINUTE: '2' });
    expect(service.takeIssueSlot('127.0.0.1').ok).toBe(true);
    expect(service.takeIssueSlot('127.0.0.1').ok).toBe(true);
    const blocked = service.takeIssueSlot('127.0.0.1');
    expect(blocked.ok).toBe(false);
    if (blocked.ok === false) {
      expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    }
    // 其它来源不受影响
    expect(service.takeIssueSlot('127.0.0.2').ok).toBe(true);
  });

  it('只对回环来源签发：局域网来源拿到 403', () => {
    const controller = new DesktopSessionController(makeDesktopSessions());
    const headers: Record<string, string> = {};
    const response = {
      setHeader: (key: string, value: string) => {
        headers[key] = value;
      },
    } as never;

    let caught: unknown = null;
    try {
      controller.issue({ socket: { remoteAddress: '192.168.1.30' } } as never, response);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { getStatus: () => number }).getStatus()).toBe(403);
    expect((caught as { getResponse: () => unknown }).getResponse()).toMatchObject({
      code: 'DESKTOP_SESSION_LOOPBACK_ONLY',
    });

    const issued = controller.issue({ socket: { remoteAddress: '127.0.0.1' } } as never, response);
    expect(issued.contract).toBe('desktop-session.v1');
    expect(issued.token).toMatch(/^ds_[0-9a-f]{48}$/);
    expect(headers['Cache-Control']).toBe('no-store');
    expect(Date.parse(issued.expiresAt)).toBeGreaterThan(Date.now());
  });
});

describe('模型接口鉴权（HTTP）', () => {
  it('无凭证：401 AUTH_REQUIRED，上游零调用', async () => {
    app = await createApp();
    const res = await request(app.getHttpServer()).post('/api/v1/agent/turn').send({});
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_REQUIRED');
    expect(upstream.calls).toBe(0);
  });

  it('伪造凭证：401，上游零调用', async () => {
    app = await createApp();
    const res = await request(app.getHttpServer())
      .post('/api/v1/agent/turn')
      .set('Authorization', 'Bearer ds_' + 'b'.repeat(48))
      .send({});
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_INVALID');
    expect(upstream.calls).toBe(0);
  });

  it('Authorization 头格式不合法同样 401，且不进 handler', async () => {
    app = await createApp();
    const res = await request(app.getHttpServer())
      .post('/api/v1/agent/turn')
      .set('Authorization', 'Bearer')
      .send({});
    expect(res.status).toBe(401);
    expect(upstream.calls).toBe(0);
  });

  it('有效桌面会话：可以使用模型接口（上游被调用一次）', async () => {
    app = await createApp();
    const issued = await request(app.getHttpServer()).post('/api/v1/desktop/session').send({});
    expect(issued.status).toBe(201);
    expect(issued.body.contract).toBe('desktop-session.v1');
    const res = await request(app.getHttpServer())
      .post('/api/v1/agent/turn')
      .set('Authorization', 'Bearer ' + issued.body.token)
      .send({});
    expect(res.status).toBe(201);
    expect(upstream.calls).toBe(1);
  });

  it('过期桌面会话：401 AUTH_SESSION_EXPIRED，上游零调用（不伪装成模型不可用）', async () => {
    app = await createApp();
    const issued = await request(app.getHttpServer()).post('/api/v1/desktop/session').send({});
    const token = String(issued.body.token);
    const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 901_000);
    let res: request.Response | null = null;
    try {
      res = await request(app.getHttpServer())
        .post('/api/v1/agent/turn')
        .set('Authorization', 'Bearer ' + token)
        .send({});
    } finally {
      spy.mockRestore();
    }
    expect(res?.status).toBe(401);
    expect(res?.body.code).toBe('AUTH_SESSION_EXPIRED');
    expect(upstream.calls).toBe(0);
  });

  it('development 免登录只对回环生效：远程来源即使开关关闭也必须带凭证', async () => {
    app = await createApp({ requireAuth: false });
    // supertest 的来源是回环，免登录联调仍可用（保证本地一键启动不被破坏）。
    const allowLoopback = await request(app.getHttpServer()).post('/api/v1/agent/turn').send({});
    expect(allowLoopback.status).toBe(201);

    const guard = new AgentAuthGuard(
      makeConfig({ NODE_ENV: 'development', AGENT_REQUIRE_AUTH: 'false' }),
      { canActivate: vi.fn() } as unknown as SessionAuthGuard,
    );
    const makeCtx = (remoteAddress: string) =>
      ({
        switchToHttp: () => ({
          getRequest: () => ({ headers: {}, socket: { remoteAddress } }),
          getResponse: () => ({ setHeader: () => undefined }),
        }),
      }) as never;

    await expect(guard.canActivate(makeCtx('127.0.0.1'))).resolves.toBe(true);
    await expect(guard.canActivate(makeCtx('192.168.1.30'))).rejects.toMatchObject({ status: 401 });
  });
});

describe('模型接口额度护栏', () => {
  it('超过每分钟配额即 429 + Retry-After，且请求不进 handler', async () => {
    app = await createApp({ perMinute: 2 });
    const post = () =>
      request(app!.getHttpServer())
        .post('/api/v1/agent/turn')
        .set('Authorization', 'Bearer ' + 'f'.repeat(12))
        .send({});
    const first = await post();
    const second = await post();
    const third = await post();
    // 前两次因为没有有效会话被 401，但配额已被消耗：第三次必须直接 429。
    expect(first.status).toBe(401);
    expect(second.status).toBe(401);
    expect(third.status).toBe(429);
    expect(third.body.code).toBe(AGENT_RATE_LIMITED_CODE);
    expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);
    expect(upstream.calls).toBe(0);
  });

  it('窗口计数与并发进入/释放语义', () => {
    let now = 0;
    const rails = new AgentRailsStore({ perMinute: 2, maxConcurrent: 1, now: () => now });
    expect(rails.takeRate('k').ok).toBe(true);
    expect(rails.takeRate('k').ok).toBe(true);
    expect(rails.takeRate('k').ok).toBe(false);
    now = 61_000;
    expect(rails.takeRate('k').ok).toBe(true);

    const first = rails.enter();
    expect(first.ok).toBe(true);
    expect(rails.enter().ok).toBe(false);
    if (first.ok) first.release();
    expect(rails.enter().ok).toBe(true);
  });

  it('并发占满时返回 429 AGENT_BUSY，且不进 handler', async () => {
    app = await createApp({ maxConcurrent: 1 });
    const rails = app.get(AgentRailsStore);
    const issued = await request(app.getHttpServer()).post('/api/v1/desktop/session').send({});
    const held = rails.enter();
    expect(held.ok).toBe(true);
    try {
      const res = await request(app.getHttpServer())
        .post('/api/v1/agent/turn')
        .set('Authorization', 'Bearer ' + issued.body.token)
        .send({});
      expect(res.status).toBe(429);
      expect(res.body.code).toBe(AGENT_BUSY_CODE);
      expect(upstream.calls).toBe(0);
    } finally {
      if (held.ok) held.release();
    }
  });

  it('健康检查不在这两道护栏里', async () => {
    app = await createApp({ perMinute: 1 });
    const rails = app.get(AgentRailsStore);
    rails.takeRate('ip:127.0.0.1');
    rails.takeRate('ip:127.0.0.1');
    const guard = new AgentRateLimitGuard(rails);
    const ctxFor = (path: string) =>
      ({
        switchToHttp: () => ({
          getRequest: () => ({ path, headers: {}, socket: { remoteAddress: '127.0.0.1' } }),
          getResponse: () => ({ setHeader: () => undefined }),
        }),
      }) as never;
    expect(guard.canActivate(ctxFor('/api/v1/health'))).toBe(true);
    expect(guard.canActivate(ctxFor('/api/v1/readyz'))).toBe(true);
    expect(() => guard.canActivate(ctxFor('/api/v1/agent/turn'))).toThrow();

    // 健康检查控制器本身不挂任何 guard。
    const source = readFileSync(new URL('../src/health.controller.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/UseGuards|AgentAuthGuard|AgentRateLimitGuard/);
  });

  it('限流键只用 token 摘要，不把 token 原文放进键里', () => {
    const key = resolveRateKey({
      headers: { authorization: 'Bearer ds_secret_value_should_not_appear' },
      socket: { remoteAddress: '127.0.0.1' },
    } as never);
    expect(key.startsWith('token:')).toBe(true);
    expect(key.includes('ds_secret_value_should_not_appear')).toBe(false);
    expect(resolveRateKey({ headers: {}, socket: { remoteAddress: '127.0.0.1' } } as never)).toBe(
      'ip:127.0.0.1',
    );
  });

  it('测试环境默认关闭护栏，显式开关才生效', () => {
    expect(readAgentRailsOptions(makeConfig({ NODE_ENV: 'test' }))).toEqual({
      perMinute: 0,
      maxConcurrent: 0,
    });
    expect(readAgentRailsOptions(makeConfig({ NODE_ENV: 'test', AGENT_RAILS_ENFORCE: '1' })).perMinute).toBe(
      120,
    );
    // E0-R1（rev15 §14.7 / Captain 2026-11-25 裁定）：入口并发默认 2 → 3，
    // 与 env.validation.ts 的 AGENT_MAX_CONCURRENT 默认值同源（DEFAULT_AGENT_MAX_CONCURRENT）。
    expect(readAgentRailsOptions(makeConfig({ NODE_ENV: 'development' })).maxConcurrent).toBe(3);
  });
});

describe('监听来源与 CORS 白名单', () => {
  it('默认只监听回环；SERVER_HOST 显式配置才改', () => {
    expect(resolveListenHost({} as NodeJS.ProcessEnv)).toBe(DEFAULT_SERVER_HOST);
    expect(DEFAULT_SERVER_HOST).toBe('127.0.0.1');
    expect(resolveListenHost({ SERVER_HOST: '  ' } as NodeJS.ProcessEnv)).toBe('127.0.0.1');
    expect(resolveListenHost({ SERVER_HOST: '0.0.0.0' } as NodeJS.ProcessEnv)).toBe('0.0.0.0');
  });

  it('来源白名单来自 DESKTOP_ORIGIN + CORS_ALLOWED_ORIGINS，不反射任意来源', () => {
    expect(resolveAllowedOrigins({} as NodeJS.ProcessEnv)).toEqual([
      'http://127.0.0.1:5173',
      'http://localhost:5173',
      'app://desktop',
    ]);
    expect(
      resolveAllowedOrigins({
        DESKTOP_ORIGIN: 'http://127.0.0.1:5173/',
        CORS_ALLOWED_ORIGINS: 'https://demo.example.com, http://192.168.1.5:5173 ,not-a-url',
      } as NodeJS.ProcessEnv),
    ).toEqual(['http://127.0.0.1:5173', 'https://demo.example.com', 'http://192.168.1.5:5173']);
  });

  it('非白名单 Origin 直接 403，白名单与无 Origin 请求放行', () => {
    const middleware = createOriginGuard(resolveAllowedOrigins({} as NodeJS.ProcessEnv));
    const run = (origin?: string) => {
      const state = {
        next: false,
        status: 0,
        body: null as unknown,
        headers: {} as Record<string, string>,
      };
      const response = {
        status(code: number) {
          state.status = code;
          return this;
        },
        json(body: unknown) {
          state.body = body;
          return this;
        },
        setHeader(key: string, value: string) {
          state.headers[key] = value;
        },
      };
      middleware(
        { headers: origin ? { origin } : {} } as never,
        response as never,
        () => {
          state.next = true;
        },
      );
      return state;
    };

    expect(run(undefined).next).toBe(true);
    expect(run('http://127.0.0.1:5173').next).toBe(true);
    expect(run('app://desktop').next).toBe(true);
    const blocked = run('https://evil.example.com');
    expect(blocked.next).toBe(false);
    expect(blocked.status).toBe(403);
    expect(blocked.body).toMatchObject({ code: 'CORS_ORIGIN_REJECTED' });
  });

  it('环境校验：非回环监听必须强制鉴权，否则启动失败', () => {
    const managed = [
      'NODE_ENV',
      'SERVER_HOST',
      'AGENT_REQUIRE_AUTH',
      'CORS_ALLOWED_ORIGINS',
      'DESKTOP_SESSION_TTL_SECONDS',
      'DESKTOP_SESSION_ISSUE_PER_MINUTE',
      'AGENT_RATE_LIMIT_PER_MINUTE',
      'AGENT_MAX_CONCURRENT',
      'AGENT_RAILS_ENFORCE',
      'DESKTOP_ORIGIN',
    ];
    const saved = new Map<string, string | undefined>();
    for (const key of managed) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
    try {
      expect(() =>
        validateEnv({
          DATABASE_URL: 'mysql://u:p@127.0.0.1:3306/db',
          SERVER_HOST: '0.0.0.0',
          AGENT_REQUIRE_AUTH: 'false',
        }),
      ).toThrow(/SERVER_HOST/);
      expect(() =>
        validateEnv({
          DATABASE_URL: 'mysql://u:p@127.0.0.1:3306/db',
          SERVER_HOST: '192.168.1.20',
          AGENT_REQUIRE_AUTH: 'false',
        }),
      ).toThrow(/AGENT_REQUIRE_AUTH=true/);

      const lan = validateEnv({
        DATABASE_URL: 'mysql://u:p@127.0.0.1:3306/db',
        SERVER_HOST: '0.0.0.0',
        AGENT_REQUIRE_AUTH: 'true',
      });
      expect(lan.SERVER_HOST).toBe('0.0.0.0');

      const localDefault = validateEnv({ DATABASE_URL: 'mysql://u:p@127.0.0.1:3306/db' });
      expect(localDefault.SERVER_HOST).toBe('127.0.0.1');
      expect(Number(localDefault.DESKTOP_SESSION_TTL_SECONDS)).toBe(900);
      expect(Number(localDefault.AGENT_RATE_LIMIT_PER_MINUTE)).toBe(120);
      // E0-R1b：入口门槛默认 3（只保护 Agent HTTP 入口，不参与上游模型并发）。
      expect(Number(localDefault.AGENT_MAX_CONCURRENT)).toBe(3);
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
