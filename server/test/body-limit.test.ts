import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * T9：请求体上限与统一 413。
 *
 * 覆盖点：
 * 1. /api/v1/agent 前缀放宽到 AGENT_MAX_BODY_BYTES（默认 2 MiB），图片 base64 不再被 express 100kb 拦下；
 * 2. 超限统一返回 HTTP 413 + { code: 'AGENT_BODY_TOO_LARGE', message, requestId }，不返回 HTML 堆栈；
 * 3. AGENT_MAX_BODY_BYTES 可覆盖；
 * 4. 其它路由仍保持 express 默认 100kb 行为；
 * 5. requestId 复用调用方透传的 X-Request-Id，否则生成 req_ 前缀的新 id。
 *
 * 本文件不触网、不连数据库；用空 Nest 模块 + 原生 express 路由回显 body，
 * 避免在测试文件内使用参数装饰器（Vitest SSR transform 限制）。
 */

// AppModule 里的 ConfigModule.forRoot 在 import 时就会校验环境变量；
// 先补齐最小值，避免依赖开发者本地 server/.env。
process.env['DATABASE_URL'] ??= 'mysql://smart_store:smart_store_dev@127.0.0.1:3306/smart_store';
process.env['NODE_ENV'] = process.env['NODE_ENV'] ?? 'test';

const mainModule = await import('../src/main');
const {
  AGENT_BODY_TOO_LARGE_CODE,
  DEFAULT_AGENT_MAX_BODY_BYTES,
  MAX_AGENT_MAX_BODY_BYTES,
  MIN_AGENT_MAX_BODY_BYTES,
  configureBodyParsers,
  resolveAgentMaxBodyBytes,
} = mainModule;

/** 生成一个合法但体积精确可控的 JSON 字符串，避免 supertest 二次序列化改变字节数。 */
function jsonOfBytes(totalBytes: number): string {
  const prefix = '{"utterance":"';
  const suffix = '"}';
  const overhead = Buffer.byteLength(prefix) + Buffer.byteLength(suffix);
  const paddingSize = Math.max(0, totalBytes - overhead);
  return `${prefix}${'x'.repeat(paddingSize)}${suffix}`;
}

/** 回显已被 body parser 解析后的字节数，证明请求确实进入了 handler。 */
function echoHandler(request_: ExpressRequest, response: ExpressResponse): void {
  const serialized = JSON.stringify(request_.body ?? {});
  response.status(200).json({ ok: true, bytes: Buffer.byteLength(serialized, 'utf8') });
}

const apps: INestApplication[] = [];

async function createApp(agentMaxBodyBytes?: number): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({}).compile();
  const app = moduleRef.createNestApplication({ bodyParser: false });

  app.setGlobalPrefix('api/v1');
  configureBodyParsers(app, agentMaxBodyBytes);

  // 模拟 POST /api/v1/agent/turn 与一条普通路由（仅用于验证 body parser 行为）。
  app.use('/api/v1/agent/turn', echoHandler);
  app.use('/api/v1/health/echo', echoHandler);

  await app.init();
  apps.push(app);
  return app;
}

let defaultApp: INestApplication;
let smallLimitApp: INestApplication;

beforeAll(async () => {
  defaultApp = await createApp();
  // 覆盖为契约允许的最小值 256 KiB，用于验证 AGENT_MAX_BODY_BYTES 生效。
  smallLimitApp = await createApp(MIN_AGENT_MAX_BODY_BYTES);
});

afterAll(async () => {
  for (const app of apps) {
    await app.close();
  }
});

describe('请求体上限纯函数', () => {
  it('未配置时回落默认 2 MiB，并接受契约区间内的覆盖值', () => {
    expect(resolveAgentMaxBodyBytes(undefined)).toBe(DEFAULT_AGENT_MAX_BODY_BYTES);
    expect(resolveAgentMaxBodyBytes('')).toBe(DEFAULT_AGENT_MAX_BODY_BYTES);
    expect(resolveAgentMaxBodyBytes('   ')).toBe(DEFAULT_AGENT_MAX_BODY_BYTES);
    expect(resolveAgentMaxBodyBytes('524288')).toBe(524288);
    expect(resolveAgentMaxBodyBytes(262144)).toBe(262144);
    expect(resolveAgentMaxBodyBytes(String(MAX_AGENT_MAX_BODY_BYTES))).toBe(MAX_AGENT_MAX_BODY_BYTES);
  });

  it('非法值（非整数/越界）回落默认值，不会得到 0 或 NaN', () => {
    expect(resolveAgentMaxBodyBytes('abc')).toBe(DEFAULT_AGENT_MAX_BODY_BYTES);
    expect(resolveAgentMaxBodyBytes('1.5')).toBe(DEFAULT_AGENT_MAX_BODY_BYTES);
    expect(resolveAgentMaxBodyBytes('1024')).toBe(DEFAULT_AGENT_MAX_BODY_BYTES);
    expect(resolveAgentMaxBodyBytes('99999999')).toBe(DEFAULT_AGENT_MAX_BODY_BYTES);
  });
});

describe('agent 路由请求体上限', () => {
  it('1 MiB 的 JSON（远超 express 默认 100kb）正常进入 handler 并返回 200', async () => {
    const raw = jsonOfBytes(1024 * 1024);
    const response = await request(defaultApp.getHttpServer())
      .post('/api/v1/agent/turn')
      .set('Content-Type', 'application/json')
      .send(raw);

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.bytes).toBeGreaterThan(1024 * 1024 - 64);
  });

  it('超过默认 2 MiB 时返回 413 与 AGENT_BODY_TOO_LARGE 错误体（JSON，无 HTML 堆栈）', async () => {
    const raw = jsonOfBytes(DEFAULT_AGENT_MAX_BODY_BYTES + 1024);
    const response = await request(defaultApp.getHttpServer())
      .post('/api/v1/agent/turn')
      .set('Content-Type', 'application/json')
      .send(raw);

    expect(response.status).toBe(413);
    expect(response.headers['content-type']).toMatch(/application\/json/);
    expect(response.body).toMatchObject({
      code: AGENT_BODY_TOO_LARGE_CODE,
      message: expect.any(String),
      requestId: expect.any(String),
    });
    expect(response.body.requestId).toMatch(/^req_[0-9a-f]{24}$/);
    expect(response.text).not.toMatch(/<html|<pre|PayloadTooLargeError/);
  });

  it('复用调用方透传的 X-Request-Id：错误体与响应头一致', async () => {
    const requestId = 'req_body_limit_custom_0001';
    const raw = jsonOfBytes(DEFAULT_AGENT_MAX_BODY_BYTES + 1024);
    const response = await request(defaultApp.getHttpServer())
      .post('/api/v1/agent/turn')
      .set('Content-Type', 'application/json')
      .set('X-Request-Id', requestId)
      .send(raw);

    expect(response.status).toBe(413);
    expect(response.body.code).toBe(AGENT_BODY_TOO_LARGE_CODE);
    expect(response.body.requestId).toBe(requestId);
    expect(response.headers['x-request-id']).toBe(requestId);
  });

  it('AGENT_MAX_BODY_BYTES 覆盖为 256 KiB 后，同一 300KB 请求在默认实例通过、在小实例 413', async () => {
    const raw = jsonOfBytes(300 * 1024);

    const passthrough = await request(defaultApp.getHttpServer())
      .post('/api/v1/agent/turn')
      .set('Content-Type', 'application/json')
      .send(raw);
    expect(passthrough.status).toBe(200);

    const rejected = await request(smallLimitApp.getHttpServer())
      .post('/api/v1/agent/turn')
      .set('Content-Type', 'application/json')
      .send(raw);
    expect(rejected.status).toBe(413);
    expect(rejected.body.code).toBe(AGENT_BODY_TOO_LARGE_CODE);
  });
});

describe('非 agent 路由保持原有 100kb 行为', () => {
  it('200KB 请求打到普通路由仍被 413 拒绝（未因 agent 需求放宽全局上限）', async () => {
    const raw = jsonOfBytes(200 * 1024);
    const response = await request(defaultApp.getHttpServer())
      .post('/api/v1/health/echo')
      .set('Content-Type', 'application/json')
      .send(raw);

    expect(response.status).toBe(413);
    expect(response.headers['content-type']).toMatch(/application\/json/);
    expect(response.body.code).toBe(AGENT_BODY_TOO_LARGE_CODE);
    expect(response.body.requestId).toMatch(/^req_[0-9a-f]{24}$/);
  });

  it('普通小请求照常解析并返回 200', async () => {
    const response = await request(defaultApp.getHttpServer())
      .post('/api/v1/health/echo')
      .set('Content-Type', 'application/json')
      .send({ hello: 'world' });

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.bytes).toBeGreaterThan(0);
  });
});