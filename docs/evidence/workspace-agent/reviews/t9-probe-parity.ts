/**
 * t24 / Review-t9 独立探针 1：共享用例 parity（服务端 vs 桌面，同一份 test/fixtures/model-scheduler/cases.json）。
 *
 * 我自己的场景执行器（不复用 t9 的 runSharedScenario），对两侧实现分别执行同一份 fixture，
 * 再比较「观测值 == 期望值」且「服务端观测 == 桌面观测」。
 *
 * 运行：cd server; npx tsx ../docs/evidence/workspace-agent/reviews/t9-probe-parity.ts
 * 只写 os.tmpdir()。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import {
  MAX_UPSTREAM_CONCURRENCY,
  MIN_QUEUE_TIMEOUT_MS,
  MAX_QUEUE_TIMEOUT_MS,
  DEFAULT_QUEUE_TIMEOUT_MS,
  createModelCallScheduler as createServerScheduler,
} from '../../../../server/src/agent/model-scheduler/index.ts';

const require = createRequire(import.meta.url);
const { createModelCallScheduler: createDesktopScheduler } = require('../../../../desktop/model-call-scheduler.cjs');

interface Slot {
  signal: AbortSignal;
  slotId: string;
  waitMs: number;
  acquiredAt: number;
}
interface Scheduler {
  run<T>(task: (slot: Slot) => Promise<T> | T, options?: { signal?: AbortSignal | null; label?: string }): Promise<T>;
  stats(): Record<string, number>;
  globalStats(): Record<string, unknown>;
  config(): Record<string, unknown>;
  close(): unknown;
}
type Factory = (options: Record<string, unknown>) => Scheduler;

const CASES_FILE = path.resolve(process.cwd(), '..', 'test', 'fixtures', 'model-scheduler', 'cases.json');
const casesDoc = JSON.parse(fs.readFileSync(CASES_FILE, 'utf8'));
const results: Array<Record<string, unknown>> = [];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function controlledClock() {
  let current = 0;
  let seq = 0;
  const scheduled = new Map<number, { callback: () => void; at: number }>();
  return {
    now: () => current,
    timers: {
      setTimeout(callback: () => void, ms: number): unknown {
        seq += 1;
        scheduled.set(seq, { callback, at: current + Math.max(0, Number(ms) || 0) });
        return { id: seq };
      },
      clearTimeout(handle: unknown): void {
        const id = (handle as { id?: number } | null)?.id;
        if (typeof id === 'number') scheduled.delete(id);
      },
    },
    advance(ms: number): void {
      const target = current + Math.max(0, ms);
      for (;;) {
        let pick: { id: number; item: { callback: () => void; at: number } } | null = null;
        for (const [id, item] of scheduled) {
          if (item.at <= target && (pick === null || item.at < pick.item.at)) pick = { id, item };
        }
        if (!pick) break;
        scheduled.delete(pick.id);
        current = pick.item.at;
        pick.item.callback();
      }
      current = target;
    },
  };
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 4000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error('waitFor 超时：' + label);
}

function baseOptions(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { tokenDir: tempDir('t9-parity-slots-'), ...extra };
}

/** 每个 scenario 返回「可比较的观测值」（键与 fixture.expect 对齐，另加必要中间量）。 */
async function observe(factory: Factory, spec: { scenario: string; given: Record<string, any> }): Promise<Record<string, unknown>> {
  const given = spec.given;

  if (spec.scenario === 'fifo-order') {
    const scheduler = factory(baseOptions({ maxConcurrent: given.maxConcurrent }));
    const order: number[] = [];
    let inFlight = 0;
    let peak = 0;
    const tasks = Array.from({ length: given.requestCount }, (_, index) => scheduler.run(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      order.push(index + 1);
      await sleep(5);
      inFlight -= 1;
      return index + 1;
    }));
    await Promise.all(tasks);
    const observed = {
      dispatchOrder: order,
      maxUpstreamConcurrency: peak,
      queueLengthPeak: scheduler.stats().maxQueueLength,
    };
    scheduler.close();
    return observed;
  }

  if (spec.scenario === 'queue-timeout-local') {
    const clock = controlledClock();
    const scheduler = factory(baseOptions({
      maxConcurrent: given.maxConcurrent,
      queueTimeoutMs: given.queueWaitMs,
      now: clock.now,
      timers: clock.timers,
    }));
    let upstreamCalls = 0;
    const occupier = scheduler.run(async () => {
      upstreamCalls += 1;
      await sleep(100);
    });
    await waitFor(() => scheduler.stats().active === 1, '占槽');
    const timedOut = scheduler.run(async () => {
      upstreamCalls += 1;
    }).then(() => ({ code: null as string | null }), (error: { code?: string }) => ({ code: error.code ?? null }));
    await waitFor(() => scheduler.stats().queued === given.queuedRequestCount, '入队');
    clock.advance(given.queueWaitMs + 1000);
    const outcome = await timedOut;
    await occupier;
    const observed = {
      errorCode: outcome.code,
      upstreamCallsForTimedOutRequest: upstreamCalls - 1,
      totalTimedOut: scheduler.stats().totalTimedOut,
      notUpstreamTimeoutCode: 'DEEPSEEK_TIMEOUT',
    };
    scheduler.close();
    return observed;
  }

  if (spec.scenario === 'release-after-body') {
    const scheduler = factory(baseOptions({ maxConcurrent: given.maxConcurrent }));
    let bodyDone = false;
    let secondStarted = false;
    const first = scheduler.run(async () => {
      await sleep(30);
      bodyDone = true;
    });
    await waitFor(() => scheduler.stats().active === 1, '第一个占槽');
    const second = scheduler.run(async () => {
      secondStarted = true;
    });
    await waitFor(() => scheduler.stats().queued === 1, '第二个排队');
    await sleep(10);
    const secondStartsBeforeBodyRead = secondStarted;
    await first;
    await waitFor(() => secondStarted === true, '读完后派发');
    await second;
    const observed = { secondStartsBeforeBodyRead, secondStartsAfterBodyRead: secondStarted, bodyDone };
    scheduler.close();
    return observed;
  }

  if (spec.scenario === 'cancel-queued') {
    const scheduler = factory(baseOptions({ maxConcurrent: given.maxConcurrent }));
    let cancelledCalls = 0;
    const occupier = scheduler.run(async () => {
      await sleep(80);
    });
    await waitFor(() => scheduler.stats().active === 1, '占槽');
    const before = scheduler.stats().totalAcquired;
    const controller = new AbortController();
    const queued = scheduler.run(async () => {
      cancelledCalls += 1;
    }, { signal: controller.signal });
    await waitFor(() => scheduler.stats().queued === 1, '入队');
    controller.abort();
    const outcome = await queued.then(() => ({ code: null as string | null }), (error: { code?: string }) => ({ code: error.code ?? null }));
    const observed = {
      errorCode: outcome.code,
      upstreamCallsForCancelled: cancelledCalls,
      totalAcquiredUnchanged: scheduler.stats().totalAcquired === before,
      queuedAfter: scheduler.stats().queued,
    };
    await occupier;
    scheduler.close();
    return observed;
  }

  if (spec.scenario === 'cancel-running') {
    const scheduler = factory(baseOptions({ maxConcurrent: given.maxConcurrent }));
    const controller = new AbortController();
    let nextDispatched = false;
    const running = scheduler.run(async ({ signal }) => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 5000);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      }, { once: true });
    }), { signal: controller.signal });
    await waitFor(() => scheduler.stats().active === 1, '运行中占槽');
    const waiting = scheduler.run(async () => {
      nextDispatched = true;
    });
    await waitFor(() => scheduler.stats().queued === 1, '后续排队');
    controller.abort();
    const outcome = await running.then(() => ({ code: null as string | null }), (error: { code?: string }) => ({ code: error.code ?? null }));
    await waiting;
    const observed = {
      errorCode: outcome.code,
      slotReleased: scheduler.stats().active === 0,
      nextDispatched,
    };
    scheduler.close();
    return observed;
  }

  if (spec.scenario === 'retry-holds-slot') {
    const scheduler = factory(baseOptions({ maxConcurrent: given.maxConcurrent }));
    let inFlight = 0;
    let peak = 0;
    const attempts = await Promise.all(Array.from({ length: given.requestCount }, () => scheduler.run(async () => {
      let attempt = 0;
      for (;;) {
        attempt += 1;
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        try {
          await sleep(5);
          const status = attempt === 1 ? given.firstAttemptStatus : 200;
          if (status === 200) return attempt;
        } finally {
          inFlight -= 1;
        }
        await sleep(5);
      }
    })));
    const observed = {
      maxUpstreamConcurrency: peak,
      attemptsPerRequest: attempts[0],
      allSucceeded: attempts.every((value) => value === attempts[0]),
      totalAcquired: scheduler.stats().totalAcquired,
    };
    scheduler.close();
    return observed;
  }

  if (spec.scenario === 'env-clamp') {
    const warnings: string[] = [];
    const scheduler = factory({ env: given.env, onWarn: (message: string) => warnings.push(message) });
    const observed = { maxConcurrent: scheduler.stats().maxConcurrent, warningCount: warnings.length, configWarnings: (scheduler.config().warnings as string[]).length };
    scheduler.close();
    return observed;
  }

  if (spec.scenario === 'env-queue-wait') {
    const warnings: string[] = [];
    const scheduler = factory({ env: given.env, onWarn: (message: string) => warnings.push(message) });
    const observed = {
      queueWaitMs: scheduler.config().queueTimeoutMs,
      aliasWarning: warnings.some((message) => message.includes('兼容别名')),
    };
    scheduler.close();
    return observed;
  }

  if (spec.scenario === 'env-ignored-agent') {
    const warnings: string[] = [];
    const scheduler = factory({ env: given.env, onWarn: (message: string) => warnings.push(message) });
    const observed = { maxConcurrent: scheduler.stats().maxConcurrent, warningCount: warnings.length };
    scheduler.close();
    return observed;
  }

  if (spec.scenario === 'stats-purity') {
    const scheduler = factory(baseOptions());
    const observed = { keys: Object.keys(scheduler.stats()) };
    const serialized = JSON.stringify(scheduler.stats()) + JSON.stringify(scheduler.globalStats()) + JSON.stringify(scheduler.config());
    scheduler.close();
    return { ...observed, leaked: ['prompt', 'sk-', 'base64', 'image_url'].filter((needle) => serialized.includes(needle)) };
  }

  throw new Error('未知 scenario：' + spec.scenario);
}

function check(id: string, ok: boolean, detail: unknown): void {
  results.push({ id, ok, detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + id + (ok ? '' : ' :: ' + JSON.stringify(detail)));
}

(async () => {
  // 0) 常量/元数据：两侧都对齐 cases.json
  const metaOk = MAX_UPSTREAM_CONCURRENCY === casesDoc.constants.maxUpstreamConcurrency
    && MIN_QUEUE_TIMEOUT_MS === casesDoc.constants.minQueueWaitMs
    && MAX_QUEUE_TIMEOUT_MS === casesDoc.constants.maxQueueWaitMs
    && DEFAULT_QUEUE_TIMEOUT_MS === casesDoc.constants.defaultQueueWaitMs
    && casesDoc.contractVersion === 'model-scheduler.v1'
    && casesDoc.cases.length >= 12;
  check('P00-fixture-meta', metaOk, { count: casesDoc.cases.length, contractVersion: casesDoc.contractVersion });

  let allOk = true;
  for (const spec of casesDoc.cases) {
    const serverObserved = await observe(createServerScheduler as unknown as Factory, spec);
    const desktopObserved = await observe(createDesktopScheduler as unknown as Factory, spec);
    const expect = spec.expect as Record<string, unknown>;
    const mismatched = Object.keys(expect).filter((key) => {
      const expected = expect[key];
      const actual = serverObserved[key];
      return JSON.stringify(expected) !== JSON.stringify(actual);
    });
    const serverVsDesktop = Object.keys(expect).filter((key) => JSON.stringify(serverObserved[key]) !== JSON.stringify(desktopObserved[key]));
    const ok = mismatched.length === 0 && serverVsDesktop.length === 0;
    if (!ok) allOk = false;
    check('P01-' + spec.id, ok, {
      expect,
      serverObserved,
      desktopObserved,
      mismatched,
      serverVsDesktop,
    });
  }
  console.log('---');
  console.log('TOTAL=' + results.length + ' FAILED=' + results.filter((item) => !item.ok).length + (allOk ? '' : ' [有失败]'));
  fs.writeFileSync(path.join(os.tmpdir(), 't9-parity-result.json'), JSON.stringify(results, null, 2), 'utf8');
  process.exitCode = allOk ? 0 : 1;
})();
