/**
 * E0-R1b：服务端 ModelCallScheduler parity + 适配器接线 + 入口排队 + 无第二条出口。
 *
 * 用例来源：`test/fixtures/model-scheduler/cases.json`（与桌面 E0-R1a **共用同一份**，
 * 服务端直接读它执行，不另写第二份用例）。
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { ConfigService } from '@nestjs/config';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { of, lastValueFrom } from 'rxjs';
import { delay } from 'rxjs/operators';

import { AgentConcurrencyInterceptor, AgentRailsStore } from '../../src/agent/agent-guard-rails';
import { DeepseekAgentProvider } from '../../src/agent/provider/deepseek-agent.provider';
import { WorkspaceAgentModule } from '../../src/agent/workspace/workspace-agent.module';
import { DeepseekChatModel, type DeepseekChatSettings } from '../../src/agent/runtime/adapters/deepseek-chat-model';
import {
  AGENT_ENTRY_BUSY_CODE,
  AgentEntryQueue,
  AgentEntryQueueInterceptor,
  DEFAULT_QUEUE_TIMEOUT_MS,
  ENV_NAMES,
  ERROR_CODES,
  MAX_QUEUE_TIMEOUT_MS,
  MAX_UPSTREAM_CONCURRENCY,
  MIN_QUEUE_TIMEOUT_MS,
  ModelSchedulerError,
  createModelCallScheduler,
  createScheduledFetch,
  ensureUpstreamFetchGuard,
  getSharedModelCallScheduler,
  isChatCompletionsUrl,
  isInsideScheduledSlot,
  isUpstreamFetchGuardInstalled,
  peekSharedModelCallScheduler,
  readAgentEntryQueueOptions,
  resetSharedModelCallScheduler,
  resolveSchedulerOptionsFromEnv,
  uninstallUpstreamFetchGuard,
  type ModelCallScheduler,
  type SchedulerStats,
} from '../../src/agent/model-scheduler';

const SERVER_ROOT = path.resolve(process.cwd());
const REPO_ROOT = path.resolve(SERVER_ROOT, '..');
const CASES_FILE = path.resolve(REPO_ROOT, 'test', 'fixtures', 'model-scheduler', 'cases.json');
const STATS_KEYS = [
  'maxConcurrent',
  'active',
  'queued',
  'maxQueueLength',
  'totalAcquired',
  'totalTimedOut',
  'lastWaitMs',
];

interface SharedCases {
  contractVersion: string;
  constants: Record<string, number>;
  errorCodes: Record<string, string>;
  env: Record<string, string | string[]>;
  tokenProtocol: Record<string, unknown>;
  statsKeys: string[];
  cases: Array<{
    id: string;
    title: string;
    scenario: string;
    given: Record<string, unknown>;
    expect: Record<string, unknown>;
  }>;
}

const sharedCases = JSON.parse(fs.readFileSync(CASES_FILE, 'utf8')) as SharedCases;

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 可控时钟：只接管 setTimeout/clearTimeout，用于排队预算语义（179s/180s 不用真等）。 */
function createControlledClock(): {
  now: () => number;
  timers: { setTimeout: (cb: () => void, ms: number) => unknown; clearTimeout: (h: unknown) => void };
  advance: (ms: number) => void;
} {
  let current = 0;
  let seq = 0;
  const scheduled = new Map<number, { callback: () => void; at: number }>();
  return {
    now: () => current,
    timers: {
      setTimeout(callback: () => void, ms: number): unknown {
        seq += 1;
        const handle = { id: seq, unref: () => undefined };
        scheduled.set(handle.id, { callback, at: current + Math.max(0, Number(ms) || 0) });
        return handle;
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

function newScheduler(options: Parameters<typeof createModelCallScheduler>[0] = {}): ModelCallScheduler {
  return createModelCallScheduler({ tokenDir: makeTempDir('srv-slots-'), ...options });
}

/* ------------------------------------------------------------------------------------------- *
 * 1. 冻结常量与共享用例元数据
 * ------------------------------------------------------------------------------------------- */

describe('服务端调度器：冻结常量与共享用例元数据', () => {
  it('常量、错误码、env 主名与 cases.json 完全一致', () => {
    expect(MAX_UPSTREAM_CONCURRENCY).toBe(sharedCases.constants.maxUpstreamConcurrency);
    expect(MIN_QUEUE_TIMEOUT_MS).toBe(sharedCases.constants.minQueueWaitMs);
    expect(MAX_QUEUE_TIMEOUT_MS).toBe(sharedCases.constants.maxQueueWaitMs);
    expect(DEFAULT_QUEUE_TIMEOUT_MS).toBe(sharedCases.constants.defaultQueueWaitMs);
    expect(sharedCases.contractVersion).toBe('model-scheduler.v1');
    expect(ENV_NAMES.maxConcurrent).toBe(sharedCases.env.maxConcurrent);
    expect(ENV_NAMES.queueWait).toBe(sharedCases.env.queueWaitMs);
    expect(ENV_NAMES.queueWaitLegacy).toBe(sharedCases.env.queueWaitMsCompatAlias);
    expect(ENV_NAMES.tokenDir).toBe(sharedCases.env.tokenDir);
    expect(sharedCases.env.neverReadForUpstreamLimit).toContain(ENV_NAMES.forbiddenAgentEntry);
    expect(Object.values(ERROR_CODES).sort()).toEqual(Object.values(sharedCases.errorCodes).sort());
    expect(sharedCases.tokenProtocol.poolSize).toBe(MAX_UPSTREAM_CONCURRENCY);
    expect(sharedCases.statsKeys).toEqual(STATS_KEYS);
  });

  it('stats() 只暴露计数与等待时长，globalStats() 只有目录/占用/降级原因', () => {
    const scheduler = newScheduler();
    expect(Object.keys(scheduler.stats()).sort()).toEqual([...STATS_KEYS].sort());
    const global = scheduler.globalStats();
    expect(global.enabled).toBe(true);
    expect(global.maxTokens).toBe(MAX_UPSTREAM_CONCURRENCY);
    expect(Object.keys(global).sort()).toEqual(
      ['available', 'degraded', 'dir', 'enabled', 'held', 'maxTokens', 'reason'].sort(),
    );
    const serialized = JSON.stringify(scheduler.stats()) + JSON.stringify(scheduler.config()) + JSON.stringify(global);
    for (const forbidden of ['prompt', 'Authorization', 'sk-', 'base64', 'image_url']) {
      expect(serialized).not.toContain(forbidden);
    }
    scheduler.close();
  });
});

/* ------------------------------------------------------------------------------------------- *
 * 2. 共享用例 parity（直接执行 cases.json）
 * ------------------------------------------------------------------------------------------- */

async function runSharedScenario(spec: SharedCases['cases'][number]): Promise<void> {
  const given = spec.given as Record<string, any>;
  const expected = spec.expect as Record<string, any>;

  if (spec.scenario === 'fifo-order') {
    const scheduler = newScheduler({ maxConcurrent: given.maxConcurrent });
    const order: number[] = [];
    let inFlight = 0;
    let peak = 0;
    const results = await Promise.all(
      Array.from({ length: given.requestCount as number }, (_, index) =>
        scheduler.run(async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          order.push(index + 1);
          await sleep(5);
          inFlight -= 1;
          return index + 1;
        }),
      ),
    );
    expect(order).toEqual(expected.dispatchOrder);
    expect(results).toEqual(expected.dispatchOrder);
    expect(peak).toBe(expected.maxUpstreamConcurrency);
    expect(scheduler.stats().maxQueueLength).toBe(expected.queueLengthPeak);
    scheduler.close();
    return;
  }

  if (spec.scenario === 'queue-timeout-local') {
    const clock = createControlledClock();
    const scheduler = newScheduler({
      maxConcurrent: given.maxConcurrent,
      queueTimeoutMs: given.queueWaitMs,
      now: clock.now,
      timers: clock.timers,
    });
    let upstreamCalls = 0;
    const occupier = scheduler.run(async () => {
      upstreamCalls += 1;
      await sleep(100);
      return 'occupier';
    });
    await waitFor(() => scheduler.stats().active === 1, '占槽任务拿到槽位');
    const timedOut = scheduler
      .run(async () => {
        upstreamCalls += 1;
        return 'never';
      })
      .then(() => ({ ok: true, code: null as string | null }), (error: ModelSchedulerError) => ({ ok: false, code: error.code }));
    await waitFor(() => scheduler.stats().queued === given.queuedRequestCount, '排队项入队');
    clock.advance((given.queueWaitMs as number) + 1000);
    const outcome = await timedOut;
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe(expected.errorCode);
    expect(outcome.code).not.toBe(expected.notUpstreamTimeoutCode);
    expect(upstreamCalls).toBe(1);
    expect(scheduler.stats().totalTimedOut).toBe(1);
    await occupier;
    scheduler.close();
    return;
  }

  if (spec.scenario === 'release-after-body') {
    const scheduler = newScheduler({ maxConcurrent: given.maxConcurrent });
    let bodyDone = false;
    let secondStarted = false;
    const gate = Promise.resolve();
    const first = scheduler.run(async () => {
      await gate;
      await sleep(30);
      bodyDone = true;
    });
    await waitFor(() => scheduler.stats().active === 1, '第一个请求占槽');
    const second = scheduler.run(async () => {
      secondStarted = true;
    });
    await waitFor(() => scheduler.stats().queued === 1, '第二个请求排队');
    await sleep(10);
    expect(secondStarted).toBe(expected.secondStartsBeforeBodyRead);
    await first;
    await waitFor(() => secondStarted === true, 'body 读完后释放槽位并派发下一个');
    await second;
    expect(bodyDone).toBe(true);
    expect(secondStarted).toBe(expected.secondStartsAfterBodyRead);
    scheduler.close();
    return;
  }

  if (spec.scenario === 'cancel-queued') {
    const scheduler = newScheduler({ maxConcurrent: given.maxConcurrent });
    let cancelledCalls = 0;
    const occupier = scheduler.run(async () => {
      await sleep(80);
    });
    await waitFor(() => scheduler.stats().active === 1, '占槽任务拿到槽位');
    const before = scheduler.stats().totalAcquired;
    const controller = new AbortController();
    const queued = scheduler.run(async () => {
      cancelledCalls += 1;
    }, { signal: controller.signal });
    await waitFor(() => scheduler.stats().queued === 1, '排队项入队');
    controller.abort();
    await expect(queued).rejects.toMatchObject({ code: expected.errorCode });
    expect(cancelledCalls).toBe(expected.upstreamCallsForCancelled);
    expect(scheduler.stats().queued).toBe(0);
    if (expected.totalAcquiredUnchanged) expect(scheduler.stats().totalAcquired).toBe(before);
    await occupier;
    scheduler.close();
    return;
  }

  if (spec.scenario === 'cancel-running') {
    const scheduler = newScheduler({ maxConcurrent: given.maxConcurrent });
    const controller = new AbortController();
    let nextDispatched = false;
    const running = scheduler.run(
      async ({ signal }) =>
        new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 5000);
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          }, { once: true });
        }),
      { signal: controller.signal },
    );
    await waitFor(() => scheduler.stats().active === 1, '运行中任务占槽');
    const waiting = scheduler.run(async () => {
      nextDispatched = true;
    });
    await waitFor(() => scheduler.stats().queued === 1, '后续任务排队');
    controller.abort();
    await expect(running).rejects.toMatchObject({ code: expected.errorCode });
    await waiting;
    expect(scheduler.stats().active).toBe(0);
    expect(nextDispatched).toBe(expected.nextDispatched);
    scheduler.close();
    return;
  }

  if (spec.scenario === 'retry-holds-slot') {
    const scheduler = newScheduler({ maxConcurrent: given.maxConcurrent });
    let inFlight = 0;
    let peak = 0;
    const requests = Array.from({ length: given.requestCount as number }, () =>
      scheduler.run(async () => {
        let attempt = 0;
        for (;;) {
          attempt += 1;
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          try {
            await sleep(5);
            const status = attempt === 1 ? (given.firstAttemptStatus as number) : 200;
            if (status === 200) return attempt;
          } finally {
            inFlight -= 1;
          }
          await sleep(5); // 重试继续持有同一槽位
        }
      }),
    );
    const attempts = await Promise.all(requests);
    expect(attempts.every((value) => value === expected.attemptsPerRequest)).toBe(expected.allSucceeded);
    expect(peak).toBe(expected.maxUpstreamConcurrency);
    scheduler.close();
    return;
  }

  if (spec.scenario === 'env-clamp') {
    const warnings: string[] = [];
    const scheduler = newScheduler({ env: given.env as Record<string, string>, onWarn: (m) => warnings.push(m) });
    expect(scheduler.stats().maxConcurrent).toBe(expected.maxConcurrent);
    expect(scheduler.config().warnings.length).toBe(expected.warningCount);
    expect(warnings.length).toBe(expected.warningCount);
    scheduler.close();
    return;
  }

  if (spec.scenario === 'env-queue-wait') {
    const warnings: string[] = [];
    const scheduler = newScheduler({ env: given.env as Record<string, string>, onWarn: (m) => warnings.push(m) });
    expect(scheduler.config().queueTimeoutMs).toBe(expected.queueWaitMs);
    const aliasWarning = warnings.some((message) => message.includes('兼容别名'));
    expect(aliasWarning).toBe(expected.aliasWarning);
    scheduler.close();
    return;
  }

  if (spec.scenario === 'env-ignored-agent') {
    const warnings: string[] = [];
    const scheduler = newScheduler({ env: given.env as Record<string, string>, onWarn: (m) => warnings.push(m) });
    expect(scheduler.stats().maxConcurrent).toBe(expected.maxConcurrent);
    expect(warnings.length).toBe(expected.warningCount);
    scheduler.close();
    return;
  }

  if (spec.scenario === 'stats-purity') {
    const scheduler = newScheduler();
    expect(Object.keys(scheduler.stats()).sort()).toEqual([...expected.keys].sort());
    scheduler.close();
    return;
  }

  throw new Error(`未知共享场景：${spec.scenario}`);
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 4000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error(`waitFor 超时：${label}`);
}

describe('共享行为用例 parity（直接执行 test/fixtures/model-scheduler/cases.json）', () => {
  expect(sharedCases.cases.length).toBeGreaterThanOrEqual(12);
  for (const spec of sharedCases.cases) {
    it(`共享用例 ${spec.id}：${spec.title}`, async () => {
      await runSharedScenario(spec);
    });
  }
});

/* ------------------------------------------------------------------------------------------- *
 * 3. 适配器接入：并发 5 → 3 执行 / 2 排队
 * ------------------------------------------------------------------------------------------- */

const CHAT_SETTINGS: DeepseekChatSettings = {
  baseUrl: 'http://127.0.0.1:1',
  apiKey: 'sk-test-0123456789abcdef',
  model: 'deepseek-chat',
  visionModel: 'deepseek-flash',
  timeoutMs: 5000,
  maxTokens: 200,
  temperature: 0.2,
  reasoningEffort: '',
};

interface ChatProbe {
  calls: number;
  inFlight: number;
  peakInFlight: number;
  plan: (index: number) => { status?: number; body?: unknown; delayMs?: number; throws?: boolean; hang?: boolean };
  fetch: (input: string, init?: RequestInit) => Promise<unknown>;
}

function createChatProbe(plan: ChatProbe['plan'] = () => ({ delayMs: 20 })): ChatProbe {
  const probe: ChatProbe = {
    calls: 0,
    inFlight: 0,
    peakInFlight: 0,
    plan,
    async fetch(input: string, init?: RequestInit) {
      probe.calls += 1;
      const index = probe.calls;
      const step = probe.plan(index);
      probe.inFlight += 1;
      probe.peakInFlight = Math.max(probe.peakInFlight, probe.inFlight);
      // 必须尊重 abort signal，否则「请求超时」用例会假装成功。
      const waitOrAbort = async (ms: number): Promise<void> => {
        const signal = init?.signal ?? null;
        if (signal?.aborted) throw abortError();
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, ms);
          signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(abortError());
          }, { once: true });
        });
      };
      try {
        if (step.hang) await waitOrAbort(5000);
        if (step.delayMs) await waitOrAbort(step.delayMs);
        if (step.throws) throw new Error('ECONNRESET');
      } catch (error) {
        probe.inFlight -= 1;
        throw error;
      }
      const status = step.status ?? 200;
      const body = step.body ?? {
        model: 'deepseek-chat',
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
      probe.inFlight -= 1;
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => JSON.stringify(body),
      };
    },
  };
  return probe;
}

function abortError(): Error {
  const error = new Error('This operation was aborted');
  error.name = 'AbortError';
  return error;
}

function makeChatModel(probe: ChatProbe, scheduler: ModelCallScheduler): DeepseekChatModel {
  // 与生产接线一致：fetch 经 createScheduledFetch 包一层，适配器自己也持有槽位。
  // 这一层绝不能二次排队（否则 3 个外层槽位被自己占满 → 死锁）。
  return new DeepseekChatModel({
    fetch: createScheduledFetch(probe.fetch as never, scheduler, 'test-chat'),
    settings: () => CHAT_SETTINGS,
    scheduler,
  });
}

describe('适配器接线：runtime/adapters 单一出口', () => {
  it('5 次并发 chat：3 个在飞、2 个排队，全部最终成功', async () => {
    const probe = createChatProbe(() => ({ delayMs: 40 }));
    const scheduler = newScheduler({ maxConcurrent: 3 });
    const model = makeChatModel(probe, scheduler);

    const jobs = Array.from({ length: 5 }, () => model.complete({ messages: [{ role: 'user', content: '你好' }] }));
    await waitFor(() => scheduler.stats().queued === 2, '出现 2 个排队项');
    const during = scheduler.stats();
    expect(during.active).toBe(3);
    expect(during.queued).toBe(2);
    expect(probe.inFlight).toBe(3);

    const results = await Promise.all(jobs);
    expect(results.every((item) => item.message.content === 'ok')).toBe(true);
    expect(probe.calls).toBe(5);
    expect(probe.peakInFlight).toBe(3);
    expect(scheduler.stats().active).toBe(0);
    expect(scheduler.globalStats().held).toBe(0);
    scheduler.close();
  });

  it('取消排队不影响执行中；取消运行中释放槽位', async () => {
    const probe = createChatProbe((index) => ({ delayMs: index === 1 ? 120 : 10 }));
    const scheduler = newScheduler({ maxConcurrent: 1 });
    const model = makeChatModel(probe, scheduler);

    const slowController = new AbortController();
    const slow = model
      .complete({ messages: [{ role: 'user', content: '慢' }] }, { signal: slowController.signal })
      .then(() => ({ ok: true, code: null as string | null }), (error: { code?: string }) => ({ ok: false, code: error.code ?? null }));
    await waitFor(() => scheduler.stats().active === 1, '慢请求占槽');

    const queuedControllers = Array.from({ length: 3 }, () => new AbortController());
    const queued = queuedControllers.map((controller) =>
      model
        .complete({ messages: [{ role: 'user', content: '排队' }] }, { signal: controller.signal })
        .then(() => ({ ok: true, code: null as string | null }), (error: { code?: string }) => ({ ok: false, code: error.code ?? null })),
    );
    await waitFor(() => scheduler.stats().queued === 3, '3 个排队项');
    const acquiredBefore = scheduler.stats().totalAcquired;
    queuedControllers[0].abort();
    await waitFor(() => scheduler.stats().queued === 2, '取消后队列减少');
    expect(scheduler.stats().totalAcquired).toBe(acquiredBefore);
    expect(probe.calls).toBe(1);

    slowController.abort();
    const slowOutcome = await slow;
    expect(slowOutcome.ok).toBe(false);
    expect(slowOutcome.code).toBe('AGENT_ABORTED');

    const rest = await Promise.all(queued);
    expect(rest.map((item) => item.ok)).toEqual([false, true, true]);
    expect(scheduler.stats().active).toBe(0);
    expect(scheduler.globalStats().held).toBe(0);
    scheduler.close();
  });

  it('429 重试不产生第 4 个并发（重试仍在同一槽位）；失败/超时/解析失败都不泄漏槽位', async () => {
    // a) 视觉重试：5 个请求各自第一次被 429、重试成功；峰值仍为 3，且 5 个请求只占 5 个槽位。
    const attemptsByKey = new Map<string, number>();
    const retryStats = { calls: 0, inFlight: 0, peak: 0 };
    const retryFetch = async (_input: unknown, init?: { body?: unknown }): Promise<unknown> => {
      retryStats.calls += 1;
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        messages?: Array<{ content?: unknown }>;
      };
      const rawContent = body.messages?.[0]?.content;
      const text = Array.isArray(rawContent)
        ? rawContent.map((part) => String((part as { text?: string }).text ?? '')).join('')
        : String(rawContent ?? '');
      const key = /重试测试(\d)/.exec(text)?.[1] ?? 'x';
      const attempt = (attemptsByKey.get(key) ?? 0) + 1;
      attemptsByKey.set(key, attempt);
      retryStats.inFlight += 1;
      retryStats.peak = Math.max(retryStats.peak, retryStats.inFlight);
      await sleep(10);
      retryStats.inFlight -= 1;
      const status = attempt === 1 ? 429 : 200;
      const payload = status === 200
        ? {
          model: 'deepseek-flash',
          choices: [{ message: { content: '{"reply":"ok","draftPatch":{}}' }, finish_reason: 'stop' }],
        }
        : {};
      return { ok: status === 200, status, text: async () => JSON.stringify(payload) };
    };
    const retryScheduler = newScheduler({ maxConcurrent: 3 });
    const retryConfig: Record<string, string> = {
      DEEPSEEK_API_BASE_URL: 'http://127.0.0.1:1',
      DEEPSEEK_API_KEY: CHAT_SETTINGS.apiKey,
      DEEPSEEK_MODEL: 'deepseek-chat',
      DEEPSEEK_VISION_MODEL: 'deepseek-flash',
      DEEPSEEK_TIMEOUT_MS: '5000',
      DEEPSEEK_MAX_TOKENS: '2000',
    };
    const retryProvider = new DeepseekAgentProvider(
      { get: (key: string) => retryConfig[key] } as unknown as ConfigService,
      retryFetch as never,
    );
    retryProvider.attachScheduler(retryScheduler);
    const retryResults = await Promise.allSettled(
      Array.from({ length: 5 }, (_, index) =>
        retryProvider.extractTurn({
          utterance: `门店名：重试测试${index}`,
          draft: {},
          images: [{ kind: 'logo', mediaType: 'image/png', data: 'AAAA' }],
        } as never),
      ),
    );
    expect(retryResults.map((item) => (item.status === 'fulfilled' ? 'fulfilled' : (item as PromiseRejectedResult).reason)))
      .toEqual(['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled', 'fulfilled']);
    expect(retryStats.peak).toBeLessThanOrEqual(3);
    expect(retryStats.peak).toBe(3);
    // 10 次上游调用（每个请求 1 次 429 + 1 次成功）但只占了 5 个槽位：重试继续持有同一槽位。
    expect(retryStats.calls).toBe(10);
    expect(retryScheduler.stats().totalAcquired).toBe(5);
    expect(retryScheduler.stats().active).toBe(0);
    expect(retryScheduler.globalStats().held).toBe(0);
    retryScheduler.close();

    // b) 各类失败都必须释放槽位，且能立刻再次获取。
    const scenarios: Array<{ name: string; plan: ChatProbe['plan']; code: string; timeoutMs?: number }> = [
      { name: '429', plan: () => ({ status: 429 }), code: 'DEEPSEEK_RATE_LIMITED' },
      { name: '5xx', plan: () => ({ status: 503 }), code: 'DEEPSEEK_UPSTREAM_ERROR' },
      { name: '网络异常', plan: () => ({ throws: true }), code: 'DEEPSEEK_UNAVAILABLE' },
      { name: '请求超时', plan: () => ({ hang: true }), code: 'DEEPSEEK_TIMEOUT', timeoutMs: 1000 },
      { name: '响应体非法', plan: () => ({ body: {} }), code: 'DEEPSEEK_RESPONSE_INVALID' },
    ];
    for (const scenario of scenarios) {
      const probe = createChatProbe(scenario.plan);
      const scheduler = newScheduler({ maxConcurrent: 1 });
      const model = makeChatModel(probe, scheduler);
      const outcome = await model
        .complete({ messages: [{ role: 'user', content: scenario.name }] }, { timeoutMs: scenario.timeoutMs })
        .then(() => ({ ok: true, code: null as string | null }), (error: { code?: string }) => ({ ok: false, code: error.code ?? null }));
      expect(outcome.ok).toBe(false);
      expect(outcome.code).toBe(scenario.code);
      const stats = scheduler.stats();
      expect(stats.active).toBe(0);
      expect(stats.queued).toBe(0);
      expect(scheduler.globalStats().held).toBe(0);
      // 槽位可再次获取
      const recovered = await makeChatModel(createChatProbe(() => ({ delayMs: 1 })), scheduler).complete({
        messages: [{ role: 'user', content: '恢复' }],
      });
      expect(recovered.message.content).toBe('ok');
      expect(scheduler.stats().totalAcquired).toBe(2);
      scheduler.close();
    }
  });

  it('settings/视觉测试与真实生成共用同一调度器：5 路混合不超 3', async () => {
    const probe = createChatProbe(() => ({ delayMs: 30 }));
    const scheduler = newScheduler({ maxConcurrent: 3 });
    const model = makeChatModel(probe, scheduler);
    const configValues: Record<string, string> = {
      DEEPSEEK_API_BASE_URL: 'http://127.0.0.1:1',
      DEEPSEEK_API_KEY: CHAT_SETTINGS.apiKey,
      DEEPSEEK_MODEL: 'deepseek-chat',
      DEEPSEEK_VISION_MODEL: 'deepseek-flash',
      DEEPSEEK_TIMEOUT_MS: '5000',
      DEEPSEEK_MAX_TOKENS: '400',
    };
    const provider = new DeepseekAgentProvider(
      { get: (key: string) => configValues[key] } as unknown as ConfigService,
      probe.fetch as never,
    );
    provider.attachScheduler(scheduler);

    const jobs = [
      model.complete({ messages: [{ role: 'user', content: '真实生成 1' }] }),
      provider.extractTurn({ utterance: '门店名：测试', draft: {} } as never),
      model.complete({ messages: [{ role: 'user', content: '真实生成 2' }] }),
      provider.extractTurn({ utterance: '门店名：测试2', draft: {} } as never),
      model.complete({ messages: [{ role: 'user', content: '真实生成 3' }] }),
    ];
    await Promise.allSettled(jobs);
    expect(probe.calls).toBe(5);
    expect(probe.peakInFlight).toBeLessThanOrEqual(3);
    expect(probe.peakInFlight).toBeGreaterThanOrEqual(2);
    expect(scheduler.stats().active).toBe(0);
    expect(scheduler.globalStats().held).toBe(0);
    scheduler.close();
  });
});

/* ------------------------------------------------------------------------------------------- *
 * 4. 令牌目录不可用 → 明确警告 + 禁用 HTTP 真实生成通道
 * ------------------------------------------------------------------------------------------- */

describe('跨进程令牌不可用：fail closed，不静默退回「各算 3」', () => {
  it('严格模式：HTTP 真实生成被禁用，带可读原因，且从未打到上游', async () => {
    const parent = makeTempDir('srv-slots-blocked-');
    const blockedDir = path.join(parent, 'token-dir');
    fs.writeFileSync(blockedDir, 'not a directory');

    const warnings: string[] = [];
    const scheduler = createModelCallScheduler({
      tokenDir: blockedDir,
      strictGlobalTokens: true,
      onWarn: (message) => warnings.push(message),
    });
    const probe = createChatProbe(() => ({ delayMs: 1 }));
    const model = makeChatModel(probe, scheduler);

    const outcome = await model
      .complete({ messages: [{ role: 'user', content: 'x' }] })
      .then(() => ({ ok: true, code: null as string | null, message: '' }), (error: { code?: string; message?: string }) => ({
        ok: false,
        code: error.code ?? null,
        message: String(error.message ?? ''),
      }));

    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe('DEEPSEEK_UNAVAILABLE');
    expect(outcome.message).toContain('模型并发通道不可用');
    expect(outcome.message).toMatch(/EEXIST|ENOTDIR|EPERM|EACCES/);
    expect(probe.calls).toBe(0);
    expect(warnings.some((message) => message.includes('跨进程模型并发令牌不可用'))).toBe(true);
    expect(scheduler.globalStats().degraded).toBe(true);
    expect(String(scheduler.globalStats().reason)).toMatch(/EEXIST|ENOTDIR|EPERM|EACCES/);
    expect(scheduler.stats().active).toBe(0);
    scheduler.close();
  });

  it('非严格模式：可见警告 + degraded 标记（不假装「已全局限流」）', async () => {
    const parent = makeTempDir('srv-slots-blocked2-');
    const blockedDir = path.join(parent, 'token-dir');
    fs.writeFileSync(blockedDir, 'not a directory');

    const warnings: string[] = [];
    const scheduler = createModelCallScheduler({ tokenDir: blockedDir, onWarn: (message) => warnings.push(message) });
    const probe = createChatProbe(() => ({ delayMs: 1 }));
    const result = await makeChatModel(probe, scheduler).complete({ messages: [{ role: 'user', content: 'x' }] });
    expect(result.message.content).toBe('ok');
    expect(scheduler.globalStats().degraded).toBe(true);
    expect(warnings.some((message) => message.includes('这不再是「全局最多 3」的保证'))).toBe(true);
    scheduler.close();
  });

  it('进程级单例默认 fail closed（strictGlobalTokens=true）', async () => {
    resetSharedModelCallScheduler();
    uninstallUpstreamFetchGuard();
    const dir = path.join(makeTempDir('srv-singleton-'), 'blocked');
    fs.writeFileSync(dir, 'x');
    const scheduler = getSharedModelCallScheduler({
      env: {},
      onWarn: () => undefined,
      overrides: { tokenDir: dir },
    });
    expect(isUpstreamFetchGuardInstalled()).toBe(true);
    // 令牌目录不可用 → 取令牌即失败（fail closed），而不是「各算 3」继续发真实请求。
    await expect(scheduler.run(async () => 'never')).rejects.toMatchObject({ code: ERROR_CODES.BUSY });
    expect(scheduler.globalStats().degraded).toBe(true);
    expect(scheduler.stats().active).toBe(0);
    resetSharedModelCallScheduler();
    uninstallUpstreamFetchGuard();
  });
});

/* ------------------------------------------------------------------------------------------- *
 * 5. 没有第二条出口
 * ------------------------------------------------------------------------------------------- */

describe('无绕过路径：静态清单 + 进程级兜底（行为证明）', () => {
  const GUARD_COVERED = new Set([
    'src/agent/presentation/template-revise.provider.ts',
    'src/generation/model-provider.service.ts',
  ]);
  const EXPLICITLY_SCHEDULED = new Set([
    'src/agent/runtime/adapters/deepseek-chat-model.ts',
    'src/agent/provider/deepseek-agent.provider.ts',
    // 接线点：AGENT_CHAT_MODEL 工厂用 createScheduledFetch 包住 fetch。
    'src/agent/workspace/workspace-agent.module.ts',
  ]);
  const SCHEDULER_INFRA = 'src/agent/model-scheduler/';

  function listSourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...listSourceFiles(full));
      else if (entry.name.endsWith('.ts')) out.push(full);
    }
    return out;
  }

  it('所有 chat/completions 出口都在清单内，且每个出口要么显式调度、要么被进程级兜底覆盖', () => {
    const files = listSourceFiles(path.join(SERVER_ROOT, 'src'));
    const outlets = files
      .map((file) => ({ file, rel: path.relative(SERVER_ROOT, file).split(path.sep).join('/') }))
      .filter(({ file, rel }) => !rel.startsWith(SCHEDULER_INFRA)
        && /chat\/completions/.test(fs.readFileSync(file, 'utf8'))
        && /\bfetch\s*\(/.test(fs.readFileSync(file, 'utf8')))
      .map(({ rel }) => rel);
    expect(outlets.length).toBeGreaterThan(0);
    const unexpected = outlets.filter((file) => !EXPLICITLY_SCHEDULED.has(file) && !GUARD_COVERED.has(file));
    expect(unexpected).toEqual([]);

    for (const file of outlets) {
      const source = fs.readFileSync(path.join(SERVER_ROOT, file), 'utf8');
      if (EXPLICITLY_SCHEDULED.has(file)) {
        // 显式接线：必须真的有 scheduler.run / createScheduledFetch。
        expect(/scheduler\.run\(|createScheduledFetch\(/.test(source), file).toBe(true);
      }
    }
    // 兜底方必须真的存在：共享单例安装进程级 guard。
    const schedulerSource = fs.readFileSync(
      path.join(SERVER_ROOT, 'src/agent/model-scheduler/model-scheduler.ts'),
      'utf8',
    );
    expect(schedulerSource).toContain('ensureUpstreamFetchGuard(scheduler)');
  });

  it('进程级兜底：未接线的裸 fetch 打 /chat/completions 也会被限流到 3', async () => {
    resetSharedModelCallScheduler();
    uninstallUpstreamFetchGuard();

    let inFlight = 0;
    let peak = 0;
    const server = http.createServer((request, response) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      request.on('data', () => undefined);
      request.on('end', () => {
        setTimeout(() => {
          inFlight -= 1;
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ ok: true }));
        }, 60);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as { port: number }).port;
    const url = `http://127.0.0.1:${port}/chat/completions`;

    const scheduler = getSharedModelCallScheduler({
      env: {},
      onWarn: () => undefined,
      overrides: { maxConcurrent: 3, tokenDir: makeTempDir('srv-guard-') },
    });
    expect(isUpstreamFetchGuardInstalled()).toBe(true);

    try {
      // 模拟「未显式接线的适配器」：裸调用全局 fetch。
      const calls = Array.from({ length: 5 }, () => fetch(url, { method: 'POST', body: '{}' }));
      await Promise.all(calls);
      expect(peak).toBeLessThanOrEqual(3);
      expect(peak).toBe(3);
      expect(scheduler.stats().totalAcquired).toBe(5);
      expect(scheduler.stats().active).toBe(0);
      // 非 chat/completions 的请求不进入调度器。
      await fetch(`http://127.0.0.1:${port}/images/generations`, { method: 'POST', body: '{}' });
      expect(scheduler.stats().totalAcquired).toBe(5);
    } finally {
      server.close();
      resetSharedModelCallScheduler();
      uninstallUpstreamFetchGuard();
    }
  });

  it('Nest 引导期就装好进程级兜底（不等第一次模型请求）', async () => {
    resetSharedModelCallScheduler();
    uninstallUpstreamFetchGuard();
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), WorkspaceAgentModule],
    }).compile();
    try {
      // APP_INTERCEPTOR 依赖 AgentEntryQueue；解析它等价于应用启动时的实例化。
      expect(moduleRef.get(AgentEntryQueue)).toBeInstanceOf(AgentEntryQueue);
      expect(moduleRef.get(AgentEntryQueueInterceptor)).toBeInstanceOf(AgentEntryQueueInterceptor);
      expect(isUpstreamFetchGuardInstalled()).toBe(true);
      expect(peekSharedModelCallScheduler()).not.toBeNull();
    } finally {
      await moduleRef.close();
      resetSharedModelCallScheduler();
      uninstallUpstreamFetchGuard();
    }
  });

  it('createScheduledFetch / isChatCompletionsUrl 语义', async () => {
    expect(isChatCompletionsUrl('https://api.deepseek.com/chat/completions')).toBe(true);
    expect(isChatCompletionsUrl('https://api.deepseek.com/chat/completions?x=1')).toBe(true);
    expect(isChatCompletionsUrl('https://api.deepseek.combeta/chat/completions')).toBe(true);
    expect(isChatCompletionsUrl('https://api.deepseek.com/images/generations')).toBe(false);

    const scheduler = newScheduler({ maxConcurrent: 1 });
    let nested = false;
    const raw = async () => {
      nested = isInsideScheduledSlot();
      return { ok: true, status: 200 };
    };
    const scheduled = createScheduledFetch(raw as never, scheduler, 'unit');
    await scheduled('http://127.0.0.1:1/chat/completions', {});
    expect(nested).toBe(true);
    expect(scheduler.stats().totalAcquired).toBe(1);
    scheduler.close();
  });
});

/* ------------------------------------------------------------------------------------------- *
 * 6. AGENT_MAX_CONCURRENT：入口排队而不是直接 429
 * ------------------------------------------------------------------------------------------- */

describe('Agent 入口保护：AGENT_MAX_CONCURRENT 只作入口门槛', () => {
  it('调度器完全不读 AGENT_MAX_CONCURRENT', () => {
    const resolved = resolveSchedulerOptionsFromEnv({ AGENT_MAX_CONCURRENT: '9' });
    expect(resolved.maxConcurrent).toBe(MAX_UPSTREAM_CONCURRENCY);
    expect(resolved.warnings).toEqual([]);
  });

  it('入口闸门：5 个并发只放行 3 个，其余排队（不抛 429）', async () => {
    const queue = new AgentEntryQueue({ maxConcurrent: 3, waitMs: 5000 });
    const admitted: number[] = [];
    const releases: Array<() => void> = [];
    const pending = Array.from({ length: 5 }, (_, index) =>
      queue.acquire().then((slot) => {
        admitted.push(index);
        releases.push(slot.release);
      }),
    );
    await waitFor(() => admitted.length === 3, '前 3 个被放行');
    expect(queue.stats().active).toBe(3);
    expect(queue.stats().queued).toBe(2);
    expect(queue.stats().maxQueueLength).toBe(2);

    releases.shift()?.();
    await waitFor(() => admitted.length === 4, '第 4 个被放行');
    while (releases.length > 0) releases.shift()?.();
    await Promise.all(pending);
    expect(admitted).toEqual([0, 1, 2, 3, 4]);
    expect(queue.stats().totalBusy).toBe(0);
  });

  it('入口排队 + 既有护栏叠加：5 个并发全部成功，没有 AGENT_BUSY', async () => {
    const queue = new AgentEntryQueue({ maxConcurrent: 3, waitMs: 5000 });
    const interceptor = new AgentEntryQueueInterceptor(queue);
    const railsStore = new AgentRailsStore({ perMinute: 0, maxConcurrent: 3 });
    const legacy = new AgentConcurrencyInterceptor(railsStore);

    const context = {
      switchToHttp: () => ({
        getRequest: () => ({ path: '/api/v1/agent/workspace', headers: {}, socket: {} }),
        getResponse: () => ({ setHeader: () => undefined }),
      }),
    } as never;

    let executed = 0;
    const next = { handle: () => of('ok').pipe(delay(30)) };
    const legacyNext = { handle: () => of('ok').pipe(delay(30)) };

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        lastValueFrom(
          interceptor.intercept(context, {
            handle: () => {
              executed += 1;
              return legacy.intercept(context, legacyNext);
            },
          }),
        ),
      ),
    );
    expect(results).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    expect(executed).toBe(5);
    expect(railsStore.snapshot().inFlight).toBe(0);
    expect(queue.stats().totalBusy).toBe(0);
    // 队列峰值证明真的排过队（不是全部直通）。
    expect(queue.stats().maxQueueLength).toBeGreaterThanOrEqual(2);
  });

  it('入口闸门在测试环境默认关闭，显式 AGENT_RAILS_ENFORCE=1 时才按 AGENT_MAX_CONCURRENT 生效', () => {
    const saved = { NODE_ENV: process.env.NODE_ENV, AGENT_RAILS_ENFORCE: process.env.AGENT_RAILS_ENFORCE, AGENT_MAX_CONCURRENT: process.env.AGENT_MAX_CONCURRENT };
    try {
      process.env.NODE_ENV = 'test';
      delete process.env.AGENT_RAILS_ENFORCE;
      expect(readAgentEntryQueueOptions().maxConcurrent).toBe(0);
      process.env.AGENT_RAILS_ENFORCE = '1';
      delete process.env.AGENT_MAX_CONCURRENT;
      expect(readAgentEntryQueueOptions().maxConcurrent).toBe(3);
      process.env.AGENT_MAX_CONCURRENT = '1';
      expect(readAgentEntryQueueOptions().maxConcurrent).toBe(1);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key as keyof NodeJS.ProcessEnv];
        else process.env[key as keyof NodeJS.ProcessEnv] = value;
      }
    }
  });

  it('入口排队预算耗尽才回落 429 AGENT_BUSY（可重试状态，不是静默丢弃）', async () => {
    const queue = new AgentEntryQueue({ maxConcurrent: 1, waitMs: 30 });
    const slot = await queue.acquire();
    await expect(queue.acquire()).rejects.toMatchObject({ response: expect.objectContaining({ code: AGENT_ENTRY_BUSY_CODE }) });
    expect(queue.stats().totalBusy).toBe(1);
    slot.release();
  });
});

/* ------------------------------------------------------------------------------------------- *
 * 7. workspace-agent：删掉「已验证/已采用 → 待本地确认」的正则改写
 * ------------------------------------------------------------------------------------------- */

describe('workspace-agent reply 只脱敏，不改写模型措辞（rev15 §14.12-3）', () => {
  const serviceSource = fs.readFileSync(
    path.join(SERVER_ROOT, 'src/agent/workspace/workspace-agent.service.ts'),
    'utf8',
  );

  it('源码里不再有 FORBIDDEN_CLAIM_PATTERN / 待本地确认 的替换', () => {
    expect(serviceSource).not.toContain('FORBIDDEN_CLAIM_PATTERN');
    expect(serviceSource).not.toContain("'待本地确认'");
    expect(serviceSource).not.toMatch(/replace\([^)]*已采用/);
    // 但敏感信息 scrub 必须保留。
    expect(serviceSource).toContain('[path]');
  });
});

afterEach(() => {
  resetSharedModelCallScheduler();
});

afterAll(() => {
  uninstallUpstreamFetchGuard();
});
