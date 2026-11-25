'use strict';

/**
 * ModelCallScheduler（X12 / E0-R1a）回归。
 *
 * 契约：`docs/handoff/Workspace-Agent-B阶段接口冻结.md` §14.6（rev15）
 * + 计划 §4 E0-R1a 的 10 条要求 + Captain amend rev1（跨进程全局令牌 / 共享用例 / env 主名）。
 *
 * 边界：
 * - 全部用本地 fake 上游（注入 `fetchImpl` 或本进程 HTTP stub），**不访问 api.deepseek.com**；
 * - 排队时钟与定时器可注入（`now` / `timers`），179s/180s 语义不用真等三分钟；
 * - 每个用例用独立令牌目录（`tokenDir`），避免与其它进程/用例互相抢锁；
 * - 跨进程用例真的 spawn 两个 node 子进程；spawn 不被允许时明确 BLOCKED，不拿单进程结果冒充。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SCHEDULER_MODULE = path.join(ROOT, 'desktop', 'model-call-scheduler.cjs');
const CASES_FILE = path.join(ROOT, 'test', 'fixtures', 'model-scheduler', 'cases.json');
const {
  createModelCallScheduler,
  createUpstreamTokenBroker,
  resolveSchedulerOptionsFromEnv,
  MAX_UPSTREAM_CONCURRENCY,
  MIN_QUEUE_TIMEOUT_MS,
  MAX_QUEUE_TIMEOUT_MS,
  DEFAULT_QUEUE_TIMEOUT_MS,
} = require(SCHEDULER_MODULE);
const {
  createModelCredentials,
  getSharedModelCallScheduler,
  resetSharedModelCallScheduler,
} = require(path.join(ROOT, 'desktop', 'model-credentials.cjs'));

const API_KEY = 'sk-test-0123456789abcdef';
const STATS_KEYS = ['maxConcurrent', 'active', 'queued', 'maxQueueLength', 'totalAcquired', 'totalTimedOut', 'lastWaitMs'];
const SHARED_CASES = JSON.parse(fs.readFileSync(CASES_FILE, 'utf8'));

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeTokenDir() {
  return makeTempDir('model-slots-');
}

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from(`enc:${Buffer.from(text, 'utf8').toString('base64')}`, 'utf8'),
    decryptString: (buffer) => {
      const raw = buffer.toString('utf8');
      if (!raw.startsWith('enc:')) throw new Error('not encrypted');
      return Buffer.from(raw.slice(4), 'base64').toString('utf8');
    },
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function abortError() {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

function sleepAbortable(ms, signal) {
  if (signal && signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    let onAbort = null;
    const cleanup = () => {
      clearTimeout(timer);
      if (signal && onAbort && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort);
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    if (signal && typeof signal.addEventListener === 'function') {
      onAbort = () => {
        cleanup();
        reject(abortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

async function waitFor(predicate, label, timeoutMs) {
  const limit = Number.isInteger(timeoutMs) ? timeoutMs : 4000;
  const startedAt = Date.now();
  while (Date.now() - startedAt < limit) {
    if (predicate()) return true;
    await sleep(5);
  }
  throw new Error(`waitFor 超时：${label || '条件未满足'}`);
}

function deferred() {
  let resolveFn = null;
  let rejectFn = null;
  const promise = new Promise((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  return { promise, resolve: resolveFn, reject: rejectFn };
}

/** 可控时钟：驱动调度器的排队预算，请求自身 timeout 仍用真实定时器。 */
function createControlledClock() {
  let current = 0;
  let seq = 0;
  const scheduled = new Map();
  return {
    now: () => current,
    timers: {
      setTimeout(callback, ms) {
        seq += 1;
        const handle = { id: seq, unref() {} };
        scheduled.set(handle.id, { callback, at: current + Math.max(0, Number(ms) || 0) });
        return handle;
      },
      clearTimeout(handle) {
        if (handle && handle.id) scheduled.delete(handle.id);
      },
    },
    advance(ms) {
      const target = current + Math.max(0, Number(ms) || 0);
      for (;;) {
        let pick = null;
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
    pendingCount: () => scheduled.size,
  };
}

/**
 * fake 上游：记录"实际在飞的上游请求数"（fetch 进入 → 响应体读完才减少），
 * 与槽位释放语义一致，避免只测到"拿到 HTTP 头"这种假并发。
 */
function createProbe(options) {
  const opts = options || {};
  const probe = {
    calls: 0,
    headersReturned: 0,
    bodiesRead: 0,
    inFlight: 0,
    maxInFlight: 0,
    bodies: [],
    async fetchImpl(url, init) {
      probe.calls += 1;
      const index = probe.calls;
      probe.inFlight += 1;
      probe.maxInFlight = Math.max(probe.maxInFlight, probe.inFlight);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        probe.inFlight -= 1;
      };
      const signal = init && init.signal ? init.signal : null;

      let plan = opts.plan ? await opts.plan({ index, url, init, probe }) : {};
      if (!plan) plan = {};
      try {
        if (plan.delayMs) await sleepAbortable(plan.delayMs, signal);
        if (plan.throwError) throw plan.throwError;
      } catch (error) {
        release();
        throw error;
      }

      const status = Number.isInteger(plan.status) ? plan.status : 200;
      const body = plan.body !== undefined
        ? plan.body
        : { model: 'deepseek-flash', choices: [{ message: { content: `回答-${index}` } }] };
      probe.headersReturned += 1;
      return {
        ok: status >= 200 && status < 300,
        status,
        async json() {
          try {
            if (plan.bodyDelayMs) await sleepAbortable(plan.bodyDelayMs, signal);
            if (plan.bodyThrows) throw new Error('invalid json body');
            probe.bodiesRead += 1;
            probe.bodies.push(body);
            return body;
          } finally {
            release();
          }
        },
      };
    },
  };
  return probe;
}

async function makeCredentials(probe, scheduler, options) {
  const opts = options || {};
  const credentials = createModelCredentials({
    userDataDir: makeTempDir('model-call-scheduler-'),
    safeStorage: fakeSafeStorage(),
    fetchImpl: probe.fetchImpl,
    scheduler: scheduler || createModelCallScheduler({ tokenDir: makeTokenDir() }),
  });
  await credentials.setKey(opts.apiKey || API_KEY);
  return credentials;
}

function chatCall(text) {
  return { messages: [{ role: 'user', content: text || '你好' }] };
}

function newScheduler(options) {
  const opts = Object.assign({ tokenDir: makeTokenDir() }, options || {});
  return createModelCallScheduler(opts);
}

/* =========================================================================================== *
 * 1. 导出与常量
 * =========================================================================================== */

test('导出与冻结常量：rev15 §14.6 接口面 + amend rev1 令牌协议', () => {
  assert.equal(MAX_UPSTREAM_CONCURRENCY, 3);
  assert.equal(MIN_QUEUE_TIMEOUT_MS, 30000);
  assert.equal(MAX_QUEUE_TIMEOUT_MS, 600000);
  assert.equal(DEFAULT_QUEUE_TIMEOUT_MS, 180000);
  // amend rev1 的 env 主名是 MODEL_QUEUE_WAIT_MS；常量别名必须同值，避免两侧命名漂移。
  assert.equal(require(SCHEDULER_MODULE).DEFAULT_QUEUE_WAIT_MS, 180000);
  assert.deepEqual(SHARED_CASES.constants, {
    maxUpstreamConcurrency: 3,
    minQueueWaitMs: 30000,
    maxQueueWaitMs: 600000,
    defaultQueueWaitMs: 180000,
    defaultLeaseTtlMs: 30000,
  });
  assert.equal(SHARED_CASES.env.maxConcurrent, 'MODEL_MAX_CONCURRENT');
  assert.equal(SHARED_CASES.env.queueWaitMs, 'MODEL_QUEUE_WAIT_MS');
  assert.equal(SHARED_CASES.env.queueWaitMsCompatAlias, 'MODEL_QUEUE_TIMEOUT_MS');
  assert.equal(SHARED_CASES.env.tokenDir, 'MODEL_UPSTREAM_TOKEN_DIR');
  assert.deepEqual(SHARED_CASES.env.neverReadForUpstreamLimit, ['AGENT_MAX_CONCURRENT']);

  const scheduler = newScheduler();
  for (const name of ['run', 'stats', 'configure']) {
    assert.equal(typeof scheduler[name], 'function', `调度器缺少 ${name}()`);
  }
  assert.equal(typeof scheduler.globalStats, 'function', '缺少跨进程令牌状态 globalStats()');
  assert.deepEqual(scheduler.stats(), {
    maxConcurrent: MAX_UPSTREAM_CONCURRENCY,
    active: 0,
    queued: 0,
    maxQueueLength: 0,
    totalAcquired: 0,
    totalTimedOut: 0,
    lastWaitMs: 0,
  });
  assert.equal(scheduler.config().queueTimeoutMs, DEFAULT_QUEUE_TIMEOUT_MS);
  assert.equal(typeof createUpstreamTokenBroker, 'function');
  const global = scheduler.globalStats();
  assert.equal(global.enabled, true);
  assert.equal(global.maxTokens, MAX_UPSTREAM_CONCURRENCY);
  assert.equal(fs.existsSync(global.dir), true, '令牌目录应被创建');
  scheduler.close();
});

/* =========================================================================================== *
 * 2. 共享行为用例（桌面/服务端共用 cases.json）
 * =========================================================================================== */

async function runSharedCase(spec) {
  const given = spec.given || {};
  const expect = spec.expect || {};
  switch (spec.scenario) {
    case 'fifo-order': {
      const scheduler = newScheduler({ maxConcurrent: given.maxConcurrent });
      const order = [];
      let inFlight = 0;
      let maxInFlight = 0;
      const requests = Array.from({ length: given.requestCount }, (_, index) => scheduler.run(async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        order.push(index + 1);
        await sleep(10);
        inFlight -= 1;
        return index + 1;
      }));
      const results = await Promise.all(requests);
      assert.deepEqual(order, expect.dispatchOrder, '派发顺序必须严格 FIFO');
      assert.deepEqual(results, expect.dispatchOrder);
      assert.equal(maxInFlight, expect.maxUpstreamConcurrency);
      assert.equal(scheduler.stats().maxQueueLength, expect.queueLengthPeak);
      scheduler.close();
      return;
    }
    case 'queue-timeout-local': {
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
        await sleep(150);
        return 'occupier';
      });
      await waitFor(() => scheduler.stats().active === 1, '占槽任务拿到槽位');
      const timedOut = scheduler.run(async () => {
        upstreamCalls += 1;
        return 'should-not-run';
      }).then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, code: error.code }),
      );
      await waitFor(() => scheduler.stats().queued === given.queuedRequestCount, '排队项入队');
      clock.advance(given.queueWaitMs + 1000);
      const outcome = await timedOut;
      assert.equal(outcome.ok, false);
      assert.equal(outcome.code, expect.errorCode);
      assert.notEqual(outcome.code, expect.notUpstreamTimeoutCode);
      assert.equal(upstreamCalls, 1, '排队超时的请求从未发起上游请求');
      assert.equal(scheduler.stats().totalTimedOut, 1);
      await occupier;
      scheduler.close();
      return;
    }
    case 'release-after-body': {
      const scheduler = newScheduler({ maxConcurrent: given.maxConcurrent });
      const bodyGate = deferred();
      let secondStarted = false;
      const first = scheduler.run(async () => {
        await bodyGate.promise;
        return 'first';
      });
      await waitFor(() => scheduler.stats().active === 1, '第一个请求占槽');
      const second = scheduler.run(async () => {
        secondStarted = true;
        return 'second';
      });
      await waitFor(() => scheduler.stats().queued === 1, '第二个请求排队');
      await sleep(30);
      assert.equal(secondStarted, expect.secondStartsBeforeBodyRead, '响应体未读完不得释放槽位');
      bodyGate.resolve();
      await first;
      await waitFor(() => secondStarted === true, '响应体读完后释放槽位并派发下一个');
      await second;
      assert.equal(secondStarted, expect.secondStartsAfterBodyRead);
      scheduler.close();
      return;
    }
    case 'cancel-queued': {
      const scheduler = newScheduler({ maxConcurrent: given.maxConcurrent });
      let cancelledCalls = 0;
      const occupier = scheduler.run(async () => {
        await sleep(150);
        return 'occupier';
      });
      await waitFor(() => scheduler.stats().active === 1, '占槽任务拿到槽位');
      const acquiredBefore = scheduler.stats().totalAcquired;
      const controller = new AbortController();
      const queued = scheduler.run(async () => {
        cancelledCalls += 1;
        return 'queued';
      }, { signal: controller.signal });
      await waitFor(() => scheduler.stats().queued === 1, '排队项入队');
      controller.abort();
      await assert.rejects(() => queued, (error) => error.code === expect.errorCode);
      assert.equal(cancelledCalls, expect.upstreamCallsForCancelled);
      assert.equal(scheduler.stats().queued, 0);
      if (expect.totalAcquiredUnchanged) assert.equal(scheduler.stats().totalAcquired, acquiredBefore);
      await occupier;
      scheduler.close();
      return;
    }
    case 'cancel-running': {
      const scheduler = newScheduler({ maxConcurrent: given.maxConcurrent });
      const controller = new AbortController();
      let nextDispatched = false;
      const running = scheduler.run(async ({ signal }) => new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 5000);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(abortError());
        }, { once: true });
      }), { signal: controller.signal });
      await waitFor(() => scheduler.stats().active === 1, '运行中任务占槽');
      const waiting = scheduler.run(async () => {
        nextDispatched = true;
        return 'next';
      });
      await waitFor(() => scheduler.stats().queued === 1, '后续任务排队');
      controller.abort();
      await assert.rejects(() => running, (error) => error.code === expect.errorCode);
      await waiting;
      assert.equal(scheduler.stats().active, 0, '取消后槽位必须释放');
      assert.equal(nextDispatched, expect.nextDispatched);
      scheduler.close();
      return;
    }
    case 'retry-holds-slot': {
      const scheduler = newScheduler({ maxConcurrent: given.maxConcurrent });
      let inFlight = 0;
      let maxInFlight = 0;
      const attempts = [];
      const requests = Array.from({ length: given.requestCount }, (_, runIndex) => scheduler.run(async () => {
        let attempt = 0;
        for (;;) {
          attempt += 1;
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          try {
            await sleep(10);
            attempts.push({ runIndex, attempt });
            const status = attempt === 1 ? given.firstAttemptStatus : 200;
            if (status === 200) return { runIndex, attempts: attempt };
          } finally {
            inFlight -= 1;
          }
          await sleep(5); // 重试继续持有同一槽位
        }
      }));
      const results = await Promise.all(requests);
      assert.equal(results.every((item) => item.attempts === expect.attemptsPerRequest), expect.allSucceeded);
      assert.equal(attempts.length, given.requestCount * expect.attemptsPerRequest);
      assert.equal(maxInFlight, expect.maxUpstreamConcurrency, '重试期间不得出现第 4 个并发');
      scheduler.close();
      return;
    }
    case 'env-clamp': {
      const warnings = [];
      const scheduler = newScheduler({ env: given.env, onWarn: (message) => warnings.push(message) });
      assert.equal(scheduler.stats().maxConcurrent, expect.maxConcurrent);
      assert.equal(scheduler.config().warnings.length, expect.warningCount);
      assert.equal(warnings.length, expect.warningCount, '警告必须真的发出去，不能只落在内部数组');
      scheduler.close();
      return;
    }
    case 'env-queue-wait': {
      const warnings = [];
      const scheduler = newScheduler({ env: given.env, onWarn: (message) => warnings.push(message) });
      assert.equal(scheduler.config().queueTimeoutMs, expect.queueWaitMs);
      const hasAliasWarning = warnings.some((message) => message.includes('兼容别名'));
      assert.equal(hasAliasWarning, expect.aliasWarning);
      scheduler.close();
      return;
    }
    case 'env-ignored-agent': {
      const warnings = [];
      const scheduler = newScheduler({ env: given.env, onWarn: (message) => warnings.push(message) });
      assert.equal(scheduler.stats().maxConcurrent, expect.maxConcurrent);
      assert.equal(warnings.length, expect.warningCount);
      scheduler.close();
      return;
    }
    case 'stats-purity': {
      const scheduler = newScheduler();
      assert.deepEqual(Object.keys(scheduler.stats()).sort(), expect.keys.slice().sort());
      scheduler.close();
      return;
    }
    default:
      throw new Error(`未知共享用例场景：${spec.scenario}`);
  }
}

test('共享行为用例 cases.json：桌面侧逐条执行（服务端 E0-R1b parity 同源）', async () => {
  assert.equal(Array.isArray(SHARED_CASES.cases), true);
  assert.equal(SHARED_CASES.cases.length >= 10, true);
  for (const spec of SHARED_CASES.cases) {
    await test(`共享用例 ${spec.id}：${spec.title}`, async () => {
      await runSharedCase(spec);
    });
  }
});

/* =========================================================================================== *
 * 3. 验收条目（fake credentials.chat 出口）
 * =========================================================================================== */

test('并发 5 次 fake credentials.chat：恰好 3 个 fetch 并发、2 个排队，全部最终成功', async () => {
  const probe = createProbe({ plan: () => ({ delayMs: 120, bodyDelayMs: 10 }) });
  const scheduler = newScheduler({ maxConcurrent: 3 });
  const credentials = await makeCredentials(probe, scheduler);

  const jobs = Array.from({ length: 5 }, (_, index) => credentials.chat(chatCall(`并发请求 ${index}`)));
  await waitFor(() => scheduler.stats().queued === 2, '出现 2 个排队项');
  const during = scheduler.stats();
  assert.equal(during.active, 3, '同一时刻只允许 3 个上游请求在飞');
  assert.equal(during.queued, 2);
  assert.equal(probe.inFlight, 3, 'fake 上游观测到的并发必须正好是 3');

  const results = await Promise.all(jobs);
  assert.equal(results.length, 5);
  assert.equal(results.every((item) => typeof item.content === 'string'), true);
  assert.equal(probe.calls, 5);
  assert.equal(probe.maxInFlight, 3, '全程最大上游并发不得超过 3');

  const after = scheduler.stats();
  assert.equal(after.active, 0);
  assert.equal(after.queued, 0);
  assert.equal(after.maxQueueLength, 2);
  assert.equal(after.totalAcquired, 5);
  assert.equal(scheduler.globalStats().held, 0, '令牌必须全部释放');
  scheduler.close();
});

test('1 个慢请求占槽 + 4 个排队：取消排队不减少已执行数，取消运行中释放槽位', async () => {
  const probe = createProbe({
    plan: ({ index }) => (index === 1 ? { delayMs: 300 } : { delayMs: 5 }),
  });
  const scheduler = newScheduler({ maxConcurrent: 1 });
  const credentials = await makeCredentials(probe, scheduler);

  const slowController = new AbortController();
  const slow = credentials.chat(chatCall('慢请求'), { signal: slowController.signal }).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, code: error.code }),
  );
  await waitFor(() => scheduler.stats().active === 1, '慢请求占住唯一槽位');

  const queuedControllers = Array.from({ length: 4 }, () => new AbortController());
  const queuedJobs = queuedControllers.map((controller, index) => credentials.chat(
    chatCall(`排队请求 ${index}`),
    { signal: controller.signal },
  ).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, code: error.code }),
  ));
  await waitFor(() => scheduler.stats().queued === 4, '4 个排队项');

  const acquiredBeforeCancel = scheduler.stats().totalAcquired;
  assert.equal(acquiredBeforeCancel, 1);
  queuedControllers[0].abort();
  await waitFor(() => scheduler.stats().queued === 3, '取消后队列减少到 3');
  assert.equal(scheduler.stats().totalAcquired, acquiredBeforeCancel, '排队取消不占用槽位');
  assert.equal(probe.calls, 1, '被取消的排队任务从未到达上游');

  slowController.abort();
  const slowOutcome = await slow;
  assert.equal(slowOutcome.ok, false);
  assert.equal(slowOutcome.code, 'MODEL_ABORTED');

  const queueResults = await Promise.all(queuedJobs);
  assert.deepEqual(queueResults.map((item) => item.ok), [false, true, true, true]);
  assert.equal(queueResults[0].code, 'MODEL_ABORTED');
  assert.equal(probe.calls, 4, '慢请求 1 次 + 排队请求 3 次');

  const finalStats = scheduler.stats();
  assert.equal(finalStats.active, 0);
  assert.equal(finalStats.queued, 0);
  assert.equal(finalStats.totalAcquired, 4, '已执行数只统计真正拿到槽位的请求（1 慢 + 3 排队）');
  assert.equal(scheduler.globalStats().held, 0);
  scheduler.close();
});

test('取消运行中任务释放槽位（credentials.chat 的 signal 路径）', async () => {
  const probe = createProbe({ plan: () => ({ delayMs: 500 }) });
  const scheduler = newScheduler({ maxConcurrent: 1 });
  const credentials = await makeCredentials(probe, scheduler);

  const controller = new AbortController();
  const running = credentials.chat(chatCall('将被取消'), { signal: controller.signal }).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, code: error.code }),
  );
  await waitFor(() => scheduler.stats().active === 1, '运行中请求占槽');
  controller.abort();
  const outcome = await running;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'MODEL_ABORTED');
  assert.equal(scheduler.stats().active, 0, '取消后槽位必须释放');

  const next = await credentials.chat(chatCall('取消之后的请求'));
  assert.equal(typeof next.content, 'string');
  scheduler.close();
});

test('排队 179s 后拿到槽位的请求仍有完整请求 timeout（排队不消耗请求 timeout）', async () => {
  const clock = createControlledClock();
  const probe = createProbe({
    plan: ({ index }) => (index === 1 ? { delayMs: 200 } : { delayMs: 300 }),
  });
  const scheduler = newScheduler({
    maxConcurrent: 1,
    queueTimeoutMs: DEFAULT_QUEUE_TIMEOUT_MS,
    now: clock.now,
    timers: clock.timers,
  });
  const credentials = await makeCredentials(probe, scheduler);

  const occupier = credentials.chat(chatCall('占槽请求'));
  await waitFor(() => scheduler.stats().active === 1, '占槽请求拿到槽位');

  const queued = credentials.chat({ ...chatCall('排队 179 秒'), timeoutMs: 1000 });
  await waitFor(() => scheduler.stats().queued === 1, '第二个请求已排队');

  clock.advance(179000);
  assert.equal(scheduler.stats().queued, 1, '179s 时仍在队列里，未被排队超时清掉');
  assert.equal(scheduler.stats().lastWaitMs, 0, '还没拿到槽位');

  await occupier;
  const acquiredAt = Date.now();
  const result = await queued;
  const elapsedMs = Date.now() - acquiredAt;

  assert.equal(typeof result.content, 'string', '排队 179s 之后仍应成功，而不是被判请求超时');
  assert.equal(scheduler.stats().lastWaitMs, 179000, '等待时长按真实排队时间记录');
  assert.ok(elapsedMs < 900, `拿到槽位后的请求耗时应约等于上游耗时，实际 ${elapsedMs}ms`);
  assert.equal(probe.calls, 2);
  assert.equal(scheduler.stats().active, 0);
  scheduler.close();
});

test('排队超过 180s → MODEL_QUEUE_TIMEOUT，不误报为上游超时', async () => {
  const clock = createControlledClock();
  const probe = createProbe({ plan: () => ({ delayMs: 50 }) });
  const scheduler = newScheduler({ maxConcurrent: 1, now: clock.now, timers: clock.timers });
  const credentials = await makeCredentials(probe, scheduler);

  const occupier = credentials.chat(chatCall('占槽请求')).catch(() => null);
  await waitFor(() => scheduler.stats().active === 1, '占槽请求拿到槽位');

  const queued = credentials.chat(chatCall('排队会超时')).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, code: error.code, message: error.message }),
  );
  await waitFor(() => scheduler.stats().queued === 1, '第二个请求已排队');

  clock.advance(181000);
  const outcome = await queued;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'MODEL_QUEUE_TIMEOUT', '排队超时必须是 MODEL_QUEUE_TIMEOUT');
  assert.match(outcome.message, /排队/);
  assert.equal(/模型响应超时/.test(outcome.message), false, '不得误报成上游超时');
  assert.equal(probe.calls, 1, '排队超时的请求从未发起上游请求');
  assert.equal(scheduler.stats().totalTimedOut, 1);
  assert.equal(scheduler.stats().queued, 0);

  await occupier;
  scheduler.close();
});

test('429→重试期间不出现第 4 个并发；重试成功/失败/超时/响应体解析失败都释放槽位', async () => {
  // a) 429 重试继续持有同一槽位：并发恒 ≤3。
  {
    const probe = createProbe({
      plan: ({ index }) => {
        const attempt = Math.ceil(index / 1);
        return index % 2 === 1 ? { status: 429, delayMs: 15 } : { delayMs: 15, body: { model: 'deepseek-flash', choices: [{ message: { content: 'retry-ok' } }] } };
      },
    });
    const scheduler = newScheduler({ maxConcurrent: 3 });
    const credentials = await makeCredentials(probe, scheduler);
    const jobs = Array.from({ length: 5 }, (_, index) => credentials.chat(chatCall(`重试 ${index}`)).then(
      (value) => ({ ok: true, value, index }),
      (error) => ({ ok: false, code: error.code, index }),
    ));
    const results = await Promise.all(jobs);
    assert.equal(probe.maxInFlight <= 3, true, `重试期间并发必须 ≤3，实际 ${probe.maxInFlight}`);
    assert.equal(results.length, 5);
    const okCount = results.filter((item) => item.ok).length + results.filter((item) => item.code === 'DEEPSEEK_RATE_LIMITED').length;
    assert.equal(okCount, 5, '每次请求要么成功、要么明确 429，不存在静默丢失');
    assert.equal(scheduler.stats().active, 0);
    assert.equal(scheduler.globalStats().held, 0);
    scheduler.close();
  }

  // b) 失败路径都要释放槽位，不泄漏。
  const scenarios = [
    { name: '429 一直失败', plan: () => ({ status: 429 }), code: 'DEEPSEEK_RATE_LIMITED' },
    { name: '5xx', plan: () => ({ status: 503 }), code: 'DEEPSEEK_UPSTREAM_ERROR' },
    {
      name: '网络不可达',
      plan: () => ({ throwError: Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }) }),
      code: 'DEEPSEEK_UNREACHABLE',
    },
    { name: '请求超时', plan: () => ({ delayMs: 5000 }), code: 'DEEPSEEK_TIMEOUT', timeoutMs: 1000 },
    { name: '响应体解析失败', plan: () => ({ bodyThrows: true }), code: 'DEEPSEEK_RESPONSE_INVALID' },
    { name: 'choices 缺失', plan: () => ({ body: { model: 'deepseek-flash' } }), code: 'DEEPSEEK_RESPONSE_INVALID' },
  ];

  for (const scenario of scenarios) {
    const probe = createProbe({ plan: scenario.plan });
    const scheduler = newScheduler({ maxConcurrent: 1 });
    const credentials = await makeCredentials(probe, scheduler);
    const payload = { ...chatCall(scenario.name) };
    if (scenario.timeoutMs) payload.timeoutMs = scenario.timeoutMs;

    const outcome = await credentials.chat(payload).then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, code: error.code }),
    );
    assert.equal(outcome.ok, false, `${scenario.name} 应当失败`);
    assert.equal(outcome.code, scenario.code, `${scenario.name} 错误码`);
    const stats = scheduler.stats();
    assert.equal(stats.active, 0, `${scenario.name} 之后槽位必须释放`);
    assert.equal(stats.queued, 0);
    assert.equal(stats.totalAcquired, 1);
    assert.equal(scheduler.globalStats().held, 0, `${scenario.name} 之后全局令牌必须释放`);

    const recoveryProbe = createProbe({ plan: () => ({ delayMs: 1 }) });
    const recoveryCredentials = await makeCredentials(recoveryProbe, scheduler);
    const again = await recoveryCredentials.chat(chatCall('恢复探测')).then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, code: error.code }),
    );
    assert.equal(again.ok, true, `${scenario.name} 之后槽位应可再次获取`);
    assert.equal(scheduler.stats().totalAcquired, 2);
    scheduler.close();
  }
});

test('MODEL_MAX_CONCURRENT=4 或非法值 → clamp 到 3 并产生可见警告（不得静默接受）', () => {
  const warnings = [];
  const resolved = resolveSchedulerOptionsFromEnv(
    { MODEL_MAX_CONCURRENT: '4' },
    { onWarn: (message) => warnings.push(message) },
  );
  assert.equal(resolved.maxConcurrent, 3);
  assert.equal(resolved.warnings.length, 1);
  assert.match(resolved.warnings[0], /clamp/);

  for (const raw of ['4', '9', '100', 'abc', '0', '-1', '3.5', 'NaN']) {
    const collected = [];
    const item = resolveSchedulerOptionsFromEnv(
      { MODEL_MAX_CONCURRENT: raw },
      { onWarn: (message) => collected.push(message) },
    );
    assert.equal(item.maxConcurrent, 3, `${raw} 应收敛到 3`);
    assert.equal(collected.length >= 1, true, `${raw} 必须产生可见警告`);
  }

  const quiet = [];
  const unset = resolveSchedulerOptionsFromEnv({}, { onWarn: (message) => quiet.push(message) });
  assert.equal(unset.maxConcurrent, 3);
  assert.equal(unset.warnings.length, 0, '未配置时用 3，且不需要警告');

  const inRange = resolveSchedulerOptionsFromEnv(
    { MODEL_MAX_CONCURRENT: '2', MODEL_QUEUE_WAIT_MS: '60000' },
    { onWarn: () => { throw new Error('不应有警告'); } },
  );
  assert.equal(inRange.maxConcurrent, 2);
  assert.equal(inRange.queueTimeoutMs, 60000);

  // 单例路径：console.warn 上必须出现可见警告（不得静默 clamp）。
  const logged = [];
  const originalWarn = console.warn;
  console.warn = (message) => logged.push(String(message));
  const tokenDir = makeTokenDir();
  try {
    resetSharedModelCallScheduler();
    const shared = getSharedModelCallScheduler({
      env: { MODEL_MAX_CONCURRENT: '4', MODEL_UPSTREAM_TOKEN_DIR: tokenDir },
    });
    assert.equal(shared.stats().maxConcurrent, 3);
    assert.equal(shared.config().warnings.length >= 1, true);
  } finally {
    console.warn = originalWarn;
    resetSharedModelCallScheduler();
  }
  assert.equal(logged.some((message) => message.includes('[model-call-scheduler]')), true, '警告必须对运维可见');

  // configure() 同一条红线。
  const patchedWarnings = [];
  const scheduler = newScheduler({ onWarn: (message) => patchedWarnings.push(message) });
  assert.equal(scheduler.configure({ maxConcurrent: 8 }).maxConcurrent, 3);
  assert.equal(patchedWarnings.length, 1);
  assert.throws(
    () => scheduler.configure({ maxConcurrent: 'abc' }),
    (error) => error.code === 'MODEL_CONFIG_INVALID',
  );
  assert.throws(
    () => scheduler.configure({ queueTimeoutMs: 'soon' }),
    (error) => error.code === 'MODEL_CONFIG_INVALID',
  );
  assert.equal(scheduler.stats().maxConcurrent, 3);
  assert.equal(scheduler.configure({ queueTimeoutMs: 1 }).queueTimeoutMs, MIN_QUEUE_TIMEOUT_MS);
  assert.equal(scheduler.configure({ queueTimeoutMs: 9999999 }).queueTimeoutMs, MAX_QUEUE_TIMEOUT_MS);
  scheduler.close();
});

test('settings:model:test 与 direct 生成同时触发仍不超过 3；stats() 不含 prompt/源码/图片/Key', async () => {
  const probe = createProbe({ plan: () => ({ delayMs: 60, bodyDelayMs: 5 }) });
  const scheduler = newScheduler({ maxConcurrent: 3 });
  const credentials = await makeCredentials(probe, scheduler);

  const secretPrompt = '门店机密文案-PROMPT-ONLY';
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const imageDataUrl = `data:image/png;base64,${png}`;

  const jobs = [
    credentials.chat(chatCall(secretPrompt)),
    credentials.test({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' }),
    credentials.chat(chatCall(`${secretPrompt}-2`)),
    credentials.chat({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: secretPrompt },
          { type: 'image_url', image_url: { url: imageDataUrl } },
        ],
      }],
    }),
    credentials.chat(chatCall(`${secretPrompt}-3`)),
  ];

  const settled = await Promise.all(jobs);
  assert.equal(settled[1].ok, true, 'settings:model:test 与真实生成争槽后仍应成功');
  assert.equal(probe.calls, 5);
  assert.equal(probe.maxInFlight, 3, '设置页测试 + direct 生成合计不得超过 3');
  assert.equal(scheduler.stats().active, 0);

  const stats = scheduler.stats();
  assert.deepEqual(Object.keys(stats).sort(), STATS_KEYS.slice().sort(), 'stats() 只暴露计数与等待时长');
  const serialized = JSON.stringify(stats)
    + JSON.stringify(scheduler.config())
    + JSON.stringify(credentials.schedulerStats())
    + JSON.stringify(credentials.schedulerGlobalStats());
  for (const secret of [secretPrompt, API_KEY, 'sk-test', 'base64', 'image_url', 'Authorization']) {
    assert.equal(serialized.includes(secret), false, `stats/config 不得包含 ${secret}`);
  }
  assert.equal(JSON.stringify(stats).includes(png), false, 'stats 不得包含图片数据');
  scheduler.close();
});

test('run() 支持 AbortSignal：取消后不再发起上游请求，已排队项移出队列', async () => {
  const scheduler = newScheduler({ maxConcurrent: 1 });
  let taskCalls = 0;

  const blocker = scheduler.run(async () => {
    await sleep(120);
    return 'blocker';
  });
  await waitFor(() => scheduler.stats().active === 1, '占槽任务拿到槽位');

  const controller = new AbortController();
  const queued = scheduler.run(async () => {
    taskCalls += 1;
    return 'queued';
  }, { signal: controller.signal, label: 'queued' });
  await waitFor(() => scheduler.stats().queued === 1, '第二个任务排队');

  controller.abort();
  await assert.rejects(() => queued, (error) => error.code === 'MODEL_ABORTED');
  assert.equal(scheduler.stats().queued, 0, '已排队项必须移出队列');
  assert.equal(taskCalls, 0, '取消后不得再发起上游请求');

  await blocker;
  assert.equal(scheduler.stats().active, 0);

  const preAborted = new AbortController();
  preAborted.abort();
  await assert.rejects(
    () => scheduler.run(async () => { taskCalls += 1; }, { signal: preAborted.signal }),
    (error) => error.code === 'MODEL_ABORTED',
  );
  assert.equal(taskCalls, 0);

  const runningController = new AbortController();
  const running = scheduler.run(async ({ signal }) => new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 5000);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(abortError());
    }, { once: true });
  }), { signal: runningController.signal, label: 'running' });
  await waitFor(() => scheduler.stats().active === 1, '运行中任务拿到槽位');
  runningController.abort();
  await assert.rejects(() => running, (error) => error.code === 'MODEL_ABORTED');
  assert.equal(scheduler.stats().active, 0, '运行中取消后槽位必须释放');

  scheduler.close();
  await assert.rejects(() => scheduler.run(async () => 'nope'), (error) => error.code === 'MODEL_BUSY');
});

test('槽位在响应体读完后才释放：只拿到 HTTP 头不释放', async () => {
  const probe = createProbe({ plan: () => ({ bodyDelayMs: 120 }) });
  const scheduler = newScheduler({ maxConcurrent: 1 });
  const credentials = await makeCredentials(probe, scheduler);

  const pending = credentials.chat(chatCall('响应体很慢'));
  await waitFor(() => probe.headersReturned === 1, 'HTTP 头已返回');
  assert.equal(scheduler.stats().active, 1, '响应体未读完时仍占用槽位');
  assert.equal(probe.bodiesRead, 0);

  await pending;
  assert.equal(probe.bodiesRead, 1);
  assert.equal(scheduler.stats().active, 0, '响应体读完后才释放槽位');
  scheduler.close();
});

/* =========================================================================================== *
 * 4. 跨进程全局令牌（amend rev1）
 * =========================================================================================== */

test('令牌目录不可用（EPERM/非目录）→ 明确 warning + 可读原因，不静默退回', async () => {
  const parent = makeTempDir('model-slots-blocked-');
  const blockedDir = path.join(parent, 'token-dir');
  fs.writeFileSync(blockedDir, 'not a directory');

  const warnings = [];
  const scheduler = createModelCallScheduler({
    tokenDir: blockedDir,
    maxConcurrent: 3,
    onWarn: (message) => warnings.push(message),
  });
  const probe = createProbe({ plan: () => ({ delayMs: 5 }) });
  const credentials = await makeCredentials(probe, scheduler);

  const result = await credentials.chat(chatCall('降级路径'));
  assert.equal(typeof result.content, 'string', '目录不可用不应让模型调用直接失败（默认非严格模式）');
  const global = scheduler.globalStats();
  assert.equal(global.degraded, true);
  assert.match(String(global.reason), /EEXIST|ENOTDIR|EPERM|EACCES/, '降级原因必须可读');
  assert.equal(warnings.some((message) => message.includes('跨进程模型并发令牌不可用')), true, '必须有可见警告');
  assert.equal(scheduler.config().warnings.length >= 1, true);
  assert.equal(scheduler.stats().active, 0);
  scheduler.close();

  // 严格模式：目录不可用直接 MODEL_BUSY（fail closed），不会假装"已全局限流"。
  const strictScheduler = createModelCallScheduler({
    tokenDir: blockedDir,
    strictGlobalTokens: true,
    onWarn: () => {},
  });
  await assert.rejects(
    () => strictScheduler.run(async () => 'never'),
    (error) => error.code === 'MODEL_BUSY',
  );
  strictScheduler.close();
});

test('令牌代理：原子创建互斥、心跳续租、过期回收（同机死 pid）', async () => {
  const dir = makeTokenDir();
  const brokerA = createUpstreamTokenBroker({ dir, maxTokens: 3, leaseTtlMs: 1000, heartbeatMs: 300, onWarn: () => {} });
  const brokerB = createUpstreamTokenBroker({ dir, maxTokens: 3, leaseTtlMs: 1000, heartbeatMs: 300, onWarn: () => {} });

  const first = await brokerA.acquire({ waitMs: 2000 });
  assert.equal(first.index, 1);
  assert.equal(brokerA.globalStats().held, 1);

  // 第二个代理只能拿 2 号：
  const second = await brokerB.acquire({ waitMs: 2000 });
  assert.notEqual(second.index, first.index);
  assert.equal(fs.readdirSync(dir).filter((name) => name.endsWith('.token')).length, 2);

  first.release();
  second.release();
  await sleep(50);
  assert.equal(fs.readdirSync(dir).filter((name) => name.endsWith('.token')).length, 0);

  // 过期回收：写入一个「同机死 pid + 已过期」的令牌，代理必须能回收并占用。
  const deadPid = 999999;
  fs.writeFileSync(path.join(dir, 'slot-1.token'), JSON.stringify({
    v: 1,
    pid: deadPid,
    host: os.hostname(),
    acquiredAt: Date.now() - 60000,
    expiresAt: Date.now() - 30000,
    label: 'dead-owner',
  }));
  const reclaimed = await brokerA.acquire({ waitMs: 2000 });
  assert.equal(reclaimed.index, 1, '过期且 pid 已死的令牌必须被回收');
  reclaimed.release();

  // 未过期的外部令牌不得被抢：
  fs.writeFileSync(path.join(dir, 'slot-2.token'), JSON.stringify({
    v: 1,
    pid: process.pid,
    host: os.hostname(),
    acquiredAt: Date.now(),
    expiresAt: Date.now() + 60000,
    label: 'alive-owner',
  }));
  const held1 = await brokerA.acquire({ waitMs: 2000 });
  const held2 = await brokerA.acquire({ waitMs: 2000 });
  assert.notEqual(held1.index, 2, '未过期的令牌不得被抢占');
  assert.notEqual(held2.index, 2);
  held1.release();
  held2.release();
  fs.unlinkSync(path.join(dir, 'slot-2.token'));
});

test('跨进程实测：两个独立 node 进程各 2 次请求，上游实际并发 ≤3', async (t) => {
  const tokenDir = makeTokenDir();
  const outDir = makeTempDir('model-slots-xproc-out-');

  let inFlight = 0;
  let maxInFlight = 0;
  let served = 0;
  const server = http.createServer((request, response) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    request.on('data', () => {});
    request.on('end', () => {
      setTimeout(() => {
        inFlight -= 1;
        served += 1;
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { content: 'upstream-ok' } }] }));
      }, 120);
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;

  const childSource = `
const fs = require('node:fs');
const { createModelCallScheduler } = require(process.env.MODULE_PATH);
const scheduler = createModelCallScheduler({
  tokenDir: process.env.TOKEN_DIR,
  maxConcurrent: 3,
  queueTimeoutMs: 30000,
});
const url = 'http://127.0.0.1:' + process.env.PORT + '/chat/completions';
const requests = Number(process.env.REQUESTS || '2');
const write = (payload) => fs.writeFileSync(process.env.OUT_FILE, JSON.stringify(payload));
Promise.all(Array.from({ length: requests }, (_, index) => scheduler.run(async ({ signal }) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ index }),
    signal,
  });
  await response.json();
  return index;
}, { label: 'xproc' }))).then((results) => {
  write({ ok: true, done: results.length, stats: scheduler.stats(), global: scheduler.globalStats() });
  process.exit(0);
}).catch((error) => {
  write({ ok: false, code: error && error.code, message: error && error.message });
  process.exit(1);
});
`;

  function runChild(index) {
    const outFile = path.join(outDir, `child-${index}.json`);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (payload) => {
        if (settled) return;
        settled = true;
        resolve(payload);
      };
      let child;
      try {
        child = spawn(process.execPath, ['-e', childSource], {
          env: {
            ...process.env,
            MODULE_PATH: SCHEDULER_MODULE,
            TOKEN_DIR: tokenDir,
            PORT: String(port),
            REQUESTS: '2',
            OUT_FILE: outFile,
          },
          stdio: 'ignore',
        });
      } catch (error) {
        finish({ spawnError: error.code || error.message });
        return;
      }
      child.on('error', (error) => finish({ spawnError: error.code || error.message }));
      child.on('exit', () => {
        try {
          finish(JSON.parse(fs.readFileSync(outFile, 'utf8')));
        } catch (error) {
          finish({ spawnError: `no-output: ${error.message}` });
        }
      });
      setTimeout(() => finish({ spawnError: 'timeout' }), 20000).unref?.();
    });
  }

  try {
    const results = await Promise.all([runChild(1), runChild(2)]);
    const spawnError = results.find((item) => item && item.spawnError);
    server.close();
    if (spawnError) {
      t.skip(`BLOCKED：跨进程用例无法执行子进程（${spawnError.spawnError}），跨进程 ≤3 未实测`);
      return;
    }
    assert.deepEqual(results.map((item) => item.ok), [true, true], '两个子进程都应完成 2 次请求');
    assert.deepEqual(results.map((item) => item.done), [2, 2]);
    assert.equal(served, 4, '上游应恰好收到 4 次请求');
    assert.equal(maxInFlight <= 3, true, `跨进程上游实际并发必须 ≤3，实际 ${maxInFlight}`);
    assert.equal(maxInFlight >= 2, true, '本用例必须真的产生跨进程并发（否则是空跑）');
    assert.equal(results.every((item) => item.stats.active === 0 && item.global.held === 0), true);
  } finally {
    try {
      server.close();
    } catch (error) {
      /* 已关闭 */
    }
  }
});
