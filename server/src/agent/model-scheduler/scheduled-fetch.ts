/**
 * 单一出口保证（rev15 §14.6.1）：
 *
 * 1. `createScheduledFetch()` —— 适配器把自己的 `fetch` 注入点包一层，所有 `/chat/completions`
 *    实际请求都经 `scheduler.run()`；
 * 2. `ensureUpstreamFetchGuard()` —— 进程级兜底：把 `globalThis.fetch` 中对 `/chat/completions`
 *    的调用也收进同一个调度器。这样即使某个适配器（presentation / generation 等）用裸 `fetch`，
 *    也不会形成第二条绕过路径；配合 `findRawChatCompletionOutlets()` 的静态断言一起用。
 *
 * 用 `AsyncLocalStorage` 标记「已经在槽位内」，避免适配器显式 `run()` + 全局兜底重复占槽。
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import type { ModelCallScheduler } from './model-scheduler.types';

const slotContext = new AsyncLocalStorage<boolean>();

export type AnyFetch = (input: unknown, init?: unknown) => Promise<unknown>;

/** 当前调用是否已经在调度器槽位内（防止重复占槽）。 */
export function isInsideScheduledSlot(): boolean {
  return slotContext.getStore() === true;
}

/** 在标记「槽位内」的上下文中执行（调度器 run 的 task 内部用）。 */
export function runInsideSlot<T>(callback: () => T): T {
  return slotContext.run(true, callback);
}

/** 是否是发往 `/chat/completions` 的请求（含 query string / 尾斜杠）。 */
export function isChatCompletionsUrl(url: string): boolean {
  return /\/chat\/completions\/?(?:\?|#|$)/i.test(url);
}

function urlOf(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  const maybeRequest = input as { url?: unknown } | null;
  return maybeRequest && typeof maybeRequest.url === 'string' ? maybeRequest.url : '';
}

function signalOf(init: unknown): AbortSignal | null {
  const candidate = (init as { signal?: unknown } | null)?.signal;
  return candidate && typeof candidate === 'object' ? (candidate as AbortSignal) : null;
}

/**
 * 把 fetch 包成「先拿槽位再发请求」。
 * 已经在槽位内时直接透传，避免同一请求重复排队。
 */
export function createScheduledFetch<A extends unknown[], R>(
  original: (...args: A) => Promise<R>,
  scheduler: ModelCallScheduler,
  label = 'http-chat',
): (...args: A) => Promise<R> {
  return async (...args: A): Promise<R> => {
    if (isInsideScheduledSlot()) return original(...args);
    const signal = signalOf(args[1]);
    return scheduler.run((slot) => runInsideSlot(() => original(...args)), { signal, label });
  };
}

type FetchLike = (input: never, init?: never) => Promise<Response>;

let installedOriginal: FetchLike | null = null;
let installedScheduler: ModelCallScheduler | null = null;

/**
 * 进程级兜底：任何未显式接线的 `/chat/completions` 调用也走同一个调度器。
 * 幂等；`uninstallUpstreamFetchGuard()` 用于测试收尾。
 */
export function ensureUpstreamFetchGuard(scheduler: ModelCallScheduler): void {
  if (typeof globalThis.fetch !== 'function') return;
  if (installedScheduler === scheduler && installedOriginal === (globalThis.fetch as unknown as FetchLike)) return;
  if (installedOriginal !== null) {
    // 多个调度器实例时以最后一个为准（测试会 reset 单例）。
    installedScheduler = scheduler;
    return;
  }
  const original = globalThis.fetch as unknown as FetchLike;
  installedOriginal = original;
  installedScheduler = scheduler;
  const guarded = ((input: unknown, init?: unknown) => {
    if (!isChatCompletionsUrl(urlOf(input)) || isInsideScheduledSlot()) {
      return (original as unknown as AnyFetch)(input, init) as Promise<Response>;
    }
    return scheduler.run(
      () => runInsideSlot(() => (original as unknown as AnyFetch)(input, init)) as Promise<Response>,
      { signal: signalOf(init), label: 'http-chat-guard' },
    );
  }) as unknown as typeof globalThis.fetch;
  globalThis.fetch = guarded;
}

/** 测试收尾：恢复被兜底替换的全局 fetch。 */
export function uninstallUpstreamFetchGuard(): void {
  if (installedOriginal !== null) {
    globalThis.fetch = installedOriginal as unknown as typeof globalThis.fetch;
  }
  installedOriginal = null;
  installedScheduler = null;
}

export function isUpstreamFetchGuardInstalled(): boolean {
  return installedOriginal !== null;
}
