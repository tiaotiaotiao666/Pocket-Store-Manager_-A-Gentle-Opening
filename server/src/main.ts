import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import express, { json, urlencoded } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { mkdirSync } from 'node:fs';
import { AppModule } from './app.module';
import { resolveRequestId } from './common/request-id';
import { resolveMediaStorageDirectory } from './media/media-storage';

/**
 * Agent 路由前缀：v2 图片请求（base64）需要比 express 默认 100kb 更大的 JSON 上限。
 * 只有这一段路由放宽，其它路由保持原有 100kb 行为。
 */
export const AGENT_ROUTE_PREFIX = '/api/v1/agent';

/** 与 C-SERVER-ENV@1 一致：默认 2 MiB，允许 256 KiB ~ 8 MiB。 */
export const DEFAULT_AGENT_MAX_BODY_BYTES = 2097152;
export const MIN_AGENT_MAX_BODY_BYTES = 262144;
export const MAX_AGENT_MAX_BODY_BYTES = 8388608;

/** 请求体超限的统一错误码与文案（不泄漏堆栈、base64、Key 或上游原始响应）。 */
export const AGENT_BODY_TOO_LARGE_CODE = 'AGENT_BODY_TOO_LARGE';
export const AGENT_BODY_TOO_LARGE_MESSAGE = '请求体超过服务端上限，请压缩图片或减少内容后重试。';

/** express body-parser 默认的 JSON 上限，用于其它路由保持原行为。 */
const DEFAULT_JSON_BODY_LIMIT = '100kb';

/**
 * B2：默认只对本机监听。
 *
 * 桌面本地生成器只需要 127.0.0.1；把默认值写成 0.0.0.0 等于默认把模型接口
 * 摆到局域网里。要局域网访问必须显式设 SERVER_HOST，并强制 AGENT_REQUIRE_AUTH=true
 * （见 resolveListenHost 与 env.validation.ts 的启动校验）。
 */
export const DEFAULT_SERVER_HOST = '127.0.0.1';

/** CORS：明确来源白名单，绝不用 `origin: true` 反射任意来源。 */
export const DEFAULT_ALLOWED_ORIGINS = Object.freeze([
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  'app://desktop',
]);

export function resolveListenHost(env: NodeJS.ProcessEnv = process.env): string {
  const raw = typeof env.SERVER_HOST === 'string' ? env.SERVER_HOST.trim() : '';
  return raw || DEFAULT_SERVER_HOST;
}

/**
 * 允许的浏览器来源。`DESKTOP_ORIGIN`（单值，兼容旧配置）与
 * `CORS_ALLOWED_ORIGINS`（逗号分隔）合并，未配置时用本地开发默认值。
 */
export function resolveAllowedOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const list: string[] = [];
  const push = (value: string) => {
    const trimmed = value.trim().replace(/\/+$/, '');
    if (!trimmed) return;
    if (!/^[a-z][a-z0-9+.-]*:\/\/[^\s]+$/i.test(trimmed)) return;
    if (!list.includes(trimmed)) list.push(trimmed);
  };
  if (typeof env.DESKTOP_ORIGIN === 'string') push(env.DESKTOP_ORIGIN);
  if (typeof env.CORS_ALLOWED_ORIGINS === 'string') {
    env.CORS_ALLOWED_ORIGINS.split(',').forEach(push);
  }
  if (list.length === 0) DEFAULT_ALLOWED_ORIGINS.forEach(push);
  return list;
}

/**
 * 显式拒绝非白名单 Origin。
 *
 * CORS 头只是浏览器侧约束；这里由服务端直接 403，避免「看起来配了白名单、
 * 实际上任何网页都能打」的假象。无 Origin 的请求（桌面主进程、curl、健康检查）
 * 不受影响 —— 凭证校验仍由各自的 guard 负责，CORS 不替代鉴权。
 */
export function createOriginGuard(allowedOrigins: string[]) {
  const allowed = new Set(allowedOrigins);
  return (request: Request, response: Response, next: NextFunction): void => {
    const origin = request.headers?.origin;
    if (typeof origin !== 'string' || !origin.trim()) {
      next();
      return;
    }
    const normalized = origin.trim().replace(/\/+$/, '');
    if (allowed.has(normalized)) {
      next();
      return;
    }
    if (typeof response.setHeader === 'function') {
      response.setHeader('Vary', 'Origin');
    }
    response.status(403).json({
      code: 'CORS_ORIGIN_REJECTED',
      message: '该来源未在白名单内，服务端拒绝跨来源访问。',
    });
  };
}

interface RequestWithId extends Request {
  requestId?: string;
}

interface HttpErrorLike {
  status?: unknown;
  statusCode?: unknown;
  type?: unknown;
}

/**
 * 解析 AGENT_MAX_BODY_BYTES。
 *
 * 非法值不会让服务崩溃（env.validation.ts 已在启动时拒绝），这里再兜底回落到默认值，
 * 保证即便绕过 ConfigModule 直接调用本模块也不会得到 0/NaN 之类的危险上限。
 */
export function resolveAgentMaxBodyBytes(
  raw: string | number | undefined = process.env.AGENT_MAX_BODY_BYTES,
): number {
  if (raw === undefined || raw === null) return DEFAULT_AGENT_MAX_BODY_BYTES;
  const text = String(raw).trim();
  if (!text) return DEFAULT_AGENT_MAX_BODY_BYTES;

  const parsed = Number(text);
  if (
    !Number.isInteger(parsed) ||
    parsed < MIN_AGENT_MAX_BODY_BYTES ||
    parsed > MAX_AGENT_MAX_BODY_BYTES
  ) {
    return DEFAULT_AGENT_MAX_BODY_BYTES;
  }
  return parsed;
}

/** 判断是否为 body-parser 的“请求体过大”错误（413 / entity.too.large）。 */
export function isPayloadTooLargeError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as HttpErrorLike;
  return (
    record.status === 413 ||
    record.statusCode === 413 ||
    record.type === 'entity.too.large'
  );
}

/**
 * body-parser 在 Nest 路由之前抛错，默认会落到 express 默认错误页（HTML + 堆栈）。
 * 这里统一改成 JSON：{ code, message, requestId }，并回写 X-Request-Id。
 */
export function createBodyLimitErrorHandler() {
  return (error: unknown, request: RequestWithId, response: Response, next: NextFunction): void => {
    if (!isPayloadTooLargeError(error)) {
      next(error);
      return;
    }
    // 响应已开始（例如流式返回中途）时不能再写 JSON，交回 express。
    if (response.headersSent) {
      next(error);
      return;
    }

    const requestId = resolveRequestId(
      request.headers as unknown as Record<string, unknown>,
      request.requestId,
    );
    request.requestId = requestId;

    response.setHeader('X-Request-Id', requestId);
    response.status(413).json({
      code: AGENT_BODY_TOO_LARGE_CODE,
      message: AGENT_BODY_TOO_LARGE_MESSAGE,
      requestId,
    });
  };
}

/**
 * 显式注册 body parser（配合 `NestFactory.create(AppModule, { bodyParser: false })`）。
 *
 * 1. `/api/v1/agent` 使用 AGENT_MAX_BODY_BYTES（默认 2 MiB），覆盖 v2 图片 base64。
 * 2. 其它路由沿用 express 默认 100kb，行为与改造前保持一致。
 * 3. 超限错误统一转成 JSON 413，不返回 HTML 堆栈。
 */
export function configureBodyParsers(
  app: INestApplication,
  agentMaxBodyBytes: number = resolveAgentMaxBodyBytes(),
): void {
  app.use(AGENT_ROUTE_PREFIX, json({ limit: agentMaxBodyBytes }));
  app.use(json({ limit: DEFAULT_JSON_BODY_LIMIT }));
  app.use(urlencoded({ extended: true, limit: DEFAULT_JSON_BODY_LIMIT }));
  app.use(createBodyLimitErrorHandler());
}

export async function bootstrap(): Promise<void> {
  // 关闭 Nest 内置 body parser，改为按路由前缀配置，避免 agent 图片请求被 100kb 限制拦成 413。
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.setGlobalPrefix('api/v1');
  const uploadDirectory = resolveMediaStorageDirectory();
  mkdirSync(uploadDirectory, { recursive: true });
  app.use('/uploads', express.static(uploadDirectory, { maxAge: '1d', immutable: true }));
  const allowedOrigins = resolveAllowedOrigins();
  app.enableCors({
    // B2：显式来源白名单（DESKTOP_ORIGIN / CORS_ALLOWED_ORIGINS），不再反射任意来源。
    // 无 Origin 的请求（桌面主进程 fetch、curl）本来就不受 CORS 约束，交给鉴权处理。
    origin: (origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) => {
      if (!origin) {
        callback(null, true);
        return;
      }
      const normalized = String(origin).trim().replace(/\/+$/, '');
      callback(null, allowedOrigins.includes(normalized));
    },
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    // P5：桌面端 agent-run transport 用 `X-Request-Id` 传 requestId
    // （见 src/services/agentTurn/agentRunTransport.js）。旧白名单只有 `X-Agent-Request-Id`，
    // 预检虽通过，实际请求仍被浏览器判 CORS 失败（net::ERR_FAILED），
    // 表现为「整理资料」永久失败。两个名字都放行，兼容既有调用方。
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Agent-Contract', 'X-Agent-Request-Id', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id'],
  });
  app.use(createOriginGuard(allowedOrigins));
  configureBodyParsers(app);
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, resolveListenHost());
}

// 仅在被直接执行时启动；被测试 import 时不监听端口。
if (typeof require !== 'undefined' && require.main === module) {
  void bootstrap();
}
