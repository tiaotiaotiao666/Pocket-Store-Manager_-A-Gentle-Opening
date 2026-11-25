/**
 * Agent HTTP 入口保护（`AGENT_MAX_CONCURRENT`）。
 *
 * 冻结语义（rev15 §14.6.1 / 计划 E0-R1b）：
 * - `AGENT_MAX_CONCURRENT` **只**是 Agent HTTP 入口门槛，默认 3，0 = 关闭；
 * - 超限时**入口排队**（FIFO）而不是立刻 429；只有排队预算耗尽才回落到 429 `AGENT_BUSY`；
 * - 它**不参与**上游模型并发计算，也**不得**替代 `ModelCallScheduler`
 *   （真实上游并发由 `server/src/agent/model-scheduler` 负责，两者互不读取对方的变量）。
 */

import {
  CallHandler,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { from, type Observable } from 'rxjs';
import { finalize, mergeMap } from 'rxjs/operators';

export const AGENT_ROUTE_PREFIX = '/api/v1/agent/';
export const AGENT_ENTRY_BUSY_CODE = 'AGENT_BUSY';
/** `AGENT_MAX_CONCURRENT` 默认值（入口门槛，和上游并发上限数值相同但语义无关）。 */
export const DEFAULT_AGENT_MAX_CONCURRENT = 3;
const BUSY_MESSAGE = '已有识别任务在进行中，请稍后再试。';
/** 入口排队预算：足够覆盖一次正常模型排队，避免把用户直接推成 429。 */
export const DEFAULT_AGENT_ENTRY_WAIT_MS = 180_000;

export interface AgentEntryQueueOptions {
  maxConcurrent?: number;
  waitMs?: number;
  now?: () => number;
}

export interface AgentEntryStats {
  maxConcurrent: number;
  active: number;
  queued: number;
  maxQueueLength: number;
  totalAdmitted: number;
  totalBusy: number;
  lastWaitMs: number;
}

interface WaitingEntry {
  resolve: (value: { waitMs: number; release: () => void }) => void;
  reject: (reason: unknown) => void;
  enqueuedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  settled: boolean;
}

/** 公平 FIFO 的入口闸门：满了就排队，预算耗尽才拒绝。 */
export class AgentEntryQueue {
  private maxConcurrent: number;

  private readonly waitMs: number;

  private readonly now: () => number;

  private active = 0;

  private readonly queue: WaitingEntry[] = [];

  private maxQueueLength = 0;

  private totalAdmitted = 0;

  private totalBusy = 0;

  private lastWaitMs = 0;

  constructor(options: AgentEntryQueueOptions = {}) {
    this.maxConcurrent = Math.max(0, Math.trunc(options.maxConcurrent ?? DEFAULT_AGENT_MAX_CONCURRENT));
    this.waitMs = Math.max(0, Math.trunc(options.waitMs ?? DEFAULT_AGENT_ENTRY_WAIT_MS));
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
  }

  acquire(): Promise<{ waitMs: number; release: () => void }> {
    if (this.maxConcurrent <= 0) {
      return Promise.resolve({ waitMs: 0, release: () => undefined });
    }
    if (this.active < this.maxConcurrent && this.queue.length === 0) {
      return Promise.resolve(this.admit(0));
    }
    return new Promise((resolve, reject) => {
      const entry: WaitingEntry = {
        resolve,
        reject,
        enqueuedAt: this.now(),
        timer: null,
        settled: false,
      };
      entry.timer = setTimeout(() => {
        if (entry.settled) return;
        entry.settled = true;
        const index = this.queue.indexOf(entry);
        if (index >= 0) this.queue.splice(index, 1);
        this.totalBusy += 1;
        entry.reject(new HttpException(
          { code: AGENT_ENTRY_BUSY_CODE, message: BUSY_MESSAGE, retryable: true },
          HttpStatus.TOO_MANY_REQUESTS,
        ));
      }, this.waitMs);
      const candidate = entry.timer as unknown as { unref?: () => void };
      if (typeof candidate.unref === 'function') candidate.unref();
      this.queue.push(entry);
      this.maxQueueLength = Math.max(this.maxQueueLength, this.queue.length);
    });
  }

  stats(): AgentEntryStats {
    return {
      maxConcurrent: this.maxConcurrent,
      active: this.active,
      queued: this.queue.length,
      maxQueueLength: this.maxQueueLength,
      totalAdmitted: this.totalAdmitted,
      totalBusy: this.totalBusy,
      lastWaitMs: this.lastWaitMs,
    };
  }

  /** 仅供测试/自检：动态调整入口门槛。 */
  configure(maxConcurrent: number): void {
    this.maxConcurrent = Math.max(0, Math.trunc(maxConcurrent));
    this.drain();
  }

  private admit(waitMs: number): { waitMs: number; release: () => void } {
    this.active += 1;
    this.totalAdmitted += 1;
    this.lastWaitMs = waitMs;
    let released = false;
    return {
      waitMs,
      release: () => {
        if (released) return;
        released = true;
        this.active = Math.max(0, this.active - 1);
        this.drain();
      },
    };
  }

  private drain(): void {
    while (this.maxConcurrent > 0 && this.active < this.maxConcurrent && this.queue.length > 0) {
      const next = this.queue.shift();
      if (!next || next.settled) continue;
      next.settled = true;
      if (next.timer) clearTimeout(next.timer);
      next.timer = null;
      next.resolve(this.admit(Math.max(0, this.now() - next.enqueuedAt)));
    }
  }
}

export function isAgentRoute(request: Request): boolean {
  const raw = typeof request.path === 'string' && request.path ? request.path : String(request.url ?? '');
  const normalized = raw.startsWith('/') ? raw : `/${raw}`;
  return normalized.startsWith(AGENT_ROUTE_PREFIX);
}

function readBooleanLike(value: unknown): boolean {
  return String(value ?? '').trim() === '1' || String(value ?? '').trim().toLowerCase() === 'true';
}

/** 由环境变量构造入口闸门选项（`AGENT_MAX_CONCURRENT` 默认 3）。 */
export function readAgentEntryQueueOptions(config?: ConfigService | null): AgentEntryQueueOptions {
  const read = (key: string): unknown => (config ? config.get(key) : process.env[key]);
  const nodeEnv = String(read('NODE_ENV') ?? process.env.NODE_ENV ?? 'development').toLowerCase();
  const enforce = readBooleanLike(read('AGENT_RAILS_ENFORCE'));
  const rawMax = Number(read('AGENT_MAX_CONCURRENT') ?? DEFAULT_AGENT_MAX_CONCURRENT);
  const maxConcurrent = Number.isFinite(rawMax) ? Math.max(0, Math.trunc(rawMax)) : DEFAULT_AGENT_MAX_CONCURRENT;
  if (nodeEnv === 'test' && !enforce) return { maxConcurrent: 0, waitMs: 0 };
  return { maxConcurrent };
}

/**
 * 入口排队拦截器。
 *
 * 只作用于 `/api/v1/agent/**`。因为它在 handler 之前就把请求排在队列里，
 * 所以既有 `AgentConcurrencyInterceptor`（同一个 `AGENT_MAX_CONCURRENT` 计数）不会直接对第 4 个
 * 请求回 429——排队发生在前，用户看到的是等待而不是失败。
 */
@Injectable()
export class AgentEntryQueueInterceptor implements NestInterceptor {
  constructor(@Inject(AgentEntryQueue) private readonly queue: AgentEntryQueue) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    if (!isAgentRoute(request)) return next.handle();
    return from(this.queue.acquire()).pipe(
      mergeMap((slot) => next.handle().pipe(finalize(() => slot.release()))),
    );
  }
}

/**
 * 给入口闸门 + 既有护栏共用的 429 响应头补 `Retry-After`，
 * 让「排队预算耗尽」这种情况仍是可重试的显式状态。
 */
export function decorateBusyResponse(response: { setHeader?: (name: string, value: string) => void } | null, retryAfterSeconds: number): void {
  if (response && typeof response.setHeader === 'function') {
    response.setHeader('Retry-After', String(Math.max(1, Math.trunc(retryAfterSeconds))));
  }
}
