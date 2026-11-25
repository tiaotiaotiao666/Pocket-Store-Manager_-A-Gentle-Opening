import {
  CallHandler,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import type { Observable } from 'rxjs';
import { finalize } from 'rxjs/operators';

/**
 * B2：模型额度护栏（限流 + 并发）。
 *
 * 只作用于 `/api/v1/agent/**`（会花模型额度的路由），健康检查等不受影响。
 * 两件事都在「进 handler 之前」完成，所以超限一定不会触发上游模型调用。
 *
 * 配置：
 * - AGENT_RATE_LIMIT_PER_MINUTE：同一来源每分钟最多请求数，0 = 关闭（默认 120）；
 * - AGENT_MAX_CONCURRENT：同时进行中的请求上限，0 = 关闭（默认 3；与 env.validation.ts 同源，
 *   只保护入口，不参与上游并发计算）。
 *
 * 测试环境默认关闭这两道护栏，避免既有套件被计数误伤；
 * 需要验证 429 的用例显式打开（AGENT_RAILS_ENFORCE=1 或直接构造本模块）。
 */

export const AGENT_ROUTE_PREFIX = '/api/v1/agent/';
export const AGENT_RATE_LIMITED_CODE = 'AGENT_RATE_LIMITED';
export const AGENT_BUSY_CODE = 'AGENT_BUSY';
/**
 * Agent HTTP 入口并发默认值（唯一常量，不再散落字面量）。
 * 必须与 `common/config/env.validation.ts` 里 `AGENT_MAX_CONCURRENT` 的默认值一致
 * （E0-R1：2 → 3）；`server/test/runtime/guard-rails-default.test.cjs` 直接比对两处，漂移即失败。
 */
export const DEFAULT_AGENT_MAX_CONCURRENT = 3;
const RATE_LIMITED_MESSAGE = '请求过于频繁，请稍后再试。';
const BUSY_MESSAGE = '已有识别任务在进行中，请稍后再试。';

export interface AgentRailsOptions {
  perMinute?: number;
  maxConcurrent?: number;
  now?: () => number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export class AgentRailsStore {
  private readonly perMinute: number;
  private readonly maxConcurrent: number;
  private readonly now: () => number;
  private readonly buckets = new Map<string, Bucket>();
  private inFlight = 0;

  constructor(options: AgentRailsOptions = {}) {
    this.perMinute = Math.max(0, Math.trunc(options.perMinute ?? 120));
    this.maxConcurrent = Math.max(0, Math.trunc(options.maxConcurrent ?? DEFAULT_AGENT_MAX_CONCURRENT));
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
  }

  /** 计数窗口 60 秒，窗口内超过配额即拒绝，并给出可重试秒数。 */
  takeRate(key: string): { ok: true } | { ok: false; retryAfterSeconds: number } {
    if (this.perMinute <= 0) return { ok: true };
    const now = this.now();
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + 60_000 });
      return { ok: true };
    }
    if (bucket.count >= this.perMinute) {
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
    }
    bucket.count += 1;
    return { ok: true };
  }

  enter(): { ok: true; release: () => void } | { ok: false; retryAfterSeconds: number } {
    if (this.maxConcurrent <= 0) return { ok: true, release: () => undefined };
    if (this.inFlight >= this.maxConcurrent) {
      return { ok: false, retryAfterSeconds: 5 };
    }
    this.inFlight += 1;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.inFlight = Math.max(0, this.inFlight - 1);
      },
    };
  }

  /** 仅供测试与自检。 */
  snapshot(): { inFlight: number; buckets: number; perMinute: number; maxConcurrent: number } {
    return {
      inFlight: this.inFlight,
      buckets: this.buckets.size,
      perMinute: this.perMinute,
      maxConcurrent: this.maxConcurrent,
    };
  }
}

function isAgentRoute(request: Request): boolean {
  const path = typeof request.path === 'string' && request.path ? request.path : String(request.url ?? '');
  const normalized = path.startsWith('/') ? path : '/' + path;
  return normalized.startsWith(AGENT_ROUTE_PREFIX);
}

/**
 * 限流键：优先按会话（桌面/店主）分桶，没有凭证时退回来源 IP。
 * 只取 token 的短摘要，绝不把 token 原文放进 map key 或日志。
 */
export function resolveRateKey(request: Request & { authKey?: string }): string {
  const authorization = request.headers?.authorization;
  if (typeof authorization === 'string' && authorization.trim()) {
    const token = authorization.trim().split(/\s+/, 2)[1] || '';
    if (token) return 'token:' + createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 16);
  }
  if (typeof request.authKey === 'string' && request.authKey) return request.authKey;
  const remote = request.socket && request.socket.remoteAddress ? request.socket.remoteAddress : '';
  return 'ip:' + (remote || 'unknown');
}

@Injectable()
export class AgentRateLimitGuard implements CanActivate {
  constructor(@Inject(AgentRailsStore) private readonly rails: AgentRailsStore) {}

  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    if (!isAgentRoute(request)) return true;
    const verdict = this.rails.takeRate(resolveRateKey(request));
    if (!verdict.ok) {
      const response = http.getResponse<Response>();
      if (response && typeof response.setHeader === 'function') {
        response.setHeader('Retry-After', String(verdict.retryAfterSeconds));
      }
      throw new HttpException(
        { code: AGENT_RATE_LIMITED_CODE, message: RATE_LIMITED_MESSAGE, retryable: true },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}

@Injectable()
export class AgentConcurrencyInterceptor implements NestInterceptor {
  constructor(@Inject(AgentRailsStore) private readonly rails: AgentRailsStore) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    if (!isAgentRoute(request)) return next.handle();
    const slot = this.rails.enter();
    if (!slot.ok) {
      const response = context.switchToHttp().getResponse<Response>();
      if (response && typeof response.setHeader === 'function') {
        response.setHeader('Retry-After', String(slot.retryAfterSeconds));
      }
      throw new HttpException(
        { code: AGENT_BUSY_CODE, message: BUSY_MESSAGE, retryable: true },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return next.handle().pipe(finalize(() => slot.release()));
  }
}

/**
 * 由环境变量构造共享的护栏状态。
 *
 * 测试环境（NODE_ENV=test）默认两道护栏都关闭，避免历史套件被计数误伤；
 * 需要验证 429 的用例显式设 `AGENT_RAILS_ENFORCE=1` 并给出小配额。
 */
export function readAgentRailsOptions(config: ConfigService): AgentRailsOptions {
  const nodeEnv = String(config.get('NODE_ENV') ?? process.env.NODE_ENV ?? 'development').toLowerCase();
  const enforce = String(config.get('AGENT_RAILS_ENFORCE') ?? '').trim() === '1';
  if (nodeEnv === 'test' && !enforce) return { perMinute: 0, maxConcurrent: 0 };
  const perMinute = Number(config.get('AGENT_RATE_LIMIT_PER_MINUTE') ?? 120);
  const maxConcurrent = Number(config.get('AGENT_MAX_CONCURRENT') ?? DEFAULT_AGENT_MAX_CONCURRENT);
  return {
    perMinute: Number.isFinite(perMinute) ? perMinute : 120,
    maxConcurrent: Number.isFinite(maxConcurrent) ? maxConcurrent : 2,
  };
}
