'use strict';

/**
 * S 组（E0-V1a 增量）：对 **t2 E0-R1a `model-call-scheduler.cjs`** 的独立执行断言。
 *
 * 判定对象：X12（桌面侧）。依据：rev15 §14.6（ModelCallScheduler：并发上限 3、公平 FIFO、
 * 排队超时 `MODEL_QUEUE_TIMEOUT`、跨进程令牌池 3、降级可见）+ 计划 §4 E0-V1。
 *
 * 纪律：
 *  - 只调用调度器公开导出（`createModelCallScheduler` 返回的 run/stats/configure/close/globalStats）；
 *  - 任务体是验证器自己的“假上游”（sleep + 计数），不冒充真实模型证据；
 *  - 排队超时用**注入的虚拟时钟**（模块允许 `now`/`timers` 注入），不靠真实等待 30 秒；
 *  - 跨进程用例真的起两个子进程（`stdio:'ignore'` + 结果落文件，避免管道限制），
 *    子进程日志时间戳算全局峰值并发。
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { assert, assertEqual } = require('../lib/harness.cjs');

const SCHEDULER_REQUIRES = ['model-call-scheduler'];
const CHILD_SCRIPT = path.join(__dirname, '..', 'lib', 'scheduler-child.cjs');

function loadModule(ctx) {
  return ctx.frozen.requireStrict('model-call-scheduler');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 虚拟时钟：只实现调度器用到的最小 surface（setTimeout/clearTimeout + now）。 */
function createFakeClock(startAt) {
  let nowMs = Number.isFinite(startAt) ? startAt : 1700000000000;
  let seq = 0;
  const pending = new Map();
  const clock = {
    now: () => nowMs,
    timers: {
      setTimeout(fn, ms) {
        seq += 1;
        const id = seq;
        pending.set(id, { at: nowMs + Math.max(0, Number(ms) || 0), fn });
        return id;
      },
      clearTimeout(id) {
        pending.delete(id);
      },
      setInterval() {
        seq += 1;
        return seq;
      },
      clearInterval() {},
    },
    advance(ms) {
      const target = nowMs + ms;
      for (;;) {
        let nextId = null;
        let nextAt = Infinity;
        for (const [id, item] of pending) {
          if (item.at <= target && item.at < nextAt) {
            nextAt = item.at;
            nextId = id;
          }
        }
        if (nextId === null) break;
        const item = pending.get(nextId);
        pending.delete(nextId);
        nowMs = Math.max(nowMs, item.at);
        try {
          item.fn();
        } catch {
          /* 调度器内部异常由用例断言，不在这里吞成 PASS */
        }
      }
      nowMs = target;
      return nowMs;
    },
    pendingCount: () => pending.size,
  };
  return clock;
}

function isSchedulerError(error, code) {
  return Boolean(error) && (error.code === code || error.name === 'ModelSchedulerError');
}

function runChild(tokenDir, outFile, tasks, holdMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CHILD_SCRIPT, tokenDir, outFile, String(tasks), String(holdMs)], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }, 60000);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ spawnError: error && (error.code || error.message) });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code });
    });
  });
}

function readJsonOrNull(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 由若干 [start,end) 区间算全局峰值并发。 */
function peakConcurrency(intervals) {
  const points = [];
  for (const item of intervals) {
    points.push({ at: item.start, delta: 1 });
    points.push({ at: item.end, delta: -1 });
  }
  points.sort((a, b) => (a.at === b.at ? a.delta - b.delta : a.at - b.at));
  let current = 0;
  let peak = 0;
  for (const point of points) {
    current += point.delta;
    if (current > peak) peak = current;
  }
  return peak;
}

const CASES = [
  {
    id: 'S01',
    group: 'S 调度器（X12 桌面侧）',
    title: '5 个并发任务：同时在跑恒为 3、排队峰值 2，5 个全部完成',
    x: ['X12'],
    requires: SCHEDULER_REQUIRES,
    basis: 'rev15 §14.6（进程内并发上限 3，公平 FIFO）+ 计划 §4「5 个并发第 4 个排队」',
    expected: 'active 峰值=3；stats().maxQueueLength=2；5 个任务全部 fulfilled；结束后 active=0、queued=0',
    async run(ctx) {
      const mod = loadModule(ctx);
      const scheduler = mod.createModelCallScheduler({ globalTokens: false, requestTimeoutMs: 20000 });
      assertEqual(scheduler.stats().maxConcurrent, 3, '默认并发上限应为 3');

      let active = 0;
      let peak = 0;
      const started = [];
      const tasks = [];
      for (let index = 0; index < 5; index += 1) {
        tasks.push(scheduler.run(async () => {
          active += 1;
          peak = Math.max(peak, active);
          started.push({ index, at: Date.now() });
          await sleep(40);
          active -= 1;
          return 'task-' + index;
        }, { label: 'p' + index }));
      }
      const results = await Promise.allSettled(tasks);
      const stats = scheduler.stats();
      scheduler.close();

      assertEqual(results.filter((item) => item.status === 'fulfilled').length, 5, '5 个任务应全部完成');
      assertEqual(peak, 3, 'on-the-fly 并发峰值应为 3');
      assertEqual(stats.maxQueueLength, 2, '排队峰值应为 2');
      assertEqual(stats.maxConcurrent, 3, 'stats().maxConcurrent 应为 3');
      assertEqual(stats.active, 0, '结束后 active 应归零');
      assertEqual(stats.queued, 0, '结束后 queued 应归零');
      assertEqual(stats.totalAcquired, 5, '5 个任务都应拿到过槽位');

      return {
        status: 'PASS',
        observed: { peakActive: peak, maxQueueLength: stats.maxQueueLength, totalAcquired: stats.totalAcquired },
        detail: '5 并发被限到 3 并发 + 2 排队，全部完成',
      };
    },
  },
  {
    id: 'S02',
    group: 'S 调度器（X12 桌面侧）',
    title: '排队超过 queueTimeoutMs → MODEL_QUEUE_TIMEOUT（虚拟时钟推进，不真等 30s）',
    x: ['X12'],
    requires: SCHEDULER_REQUIRES,
    basis: 'rev15 §14.6（排队超时给 MODEL_QUEUE_TIMEOUT，不是上游超时/429）',
    expected: '3 个槽位被占满后第 4 个排队；虚拟时间推进到 queueTimeoutMs 之后 → 第 4 个以 MODEL_QUEUE_TIMEOUT 结束；'
      + '已占槽位的 3 个不受影响且随后正常完成',
    async run(ctx) {
      const mod = loadModule(ctx);
      const clock = createFakeClock();
      const queueTimeoutMs = 30000;
      const scheduler = mod.createModelCallScheduler({
        globalTokens: false,
        maxConcurrent: 3,
        queueTimeoutMs,
        now: clock.now,
        timers: clock.timers,
      });

      let releaseHolders = null;
      const holdersReady = new Promise((resolve) => { releaseHolders = resolve; });
      const holders = [];
      for (let index = 0; index < 3; index += 1) {
        holders.push(scheduler.run(async () => {
          await holdersReady;
          return 'holder-' + index;
        }, { label: 'holder' + index }));
      }
      // 让 3 个 holder 先真正拿到槽位
      await new Promise((resolve) => setImmediate(resolve));
      assertEqual(scheduler.stats().active, 3, '3 个 holder 应占满槽位');

      const queued = scheduler.run(async () => 'queued-task', { label: 'queued' });
      let queuedError = null;
      const queuedSettled = queued.catch((error) => { queuedError = error; });
      await new Promise((resolve) => setImmediate(resolve));
      assertEqual(scheduler.stats().queued, 1, '第 4 个任务应处于排队');

      clock.advance(queueTimeoutMs + 1);
      await queuedSettled;
      assert(queuedError, '第 4 个任务应以错误结束（排队超时）');
      assertEqual(queuedError.code, 'MODEL_QUEUE_TIMEOUT', '排队超时码应为 MODEL_QUEUE_TIMEOUT');

      const afterTimeout = scheduler.stats();
      assertEqual(afterTimeout.totalTimedOut, 1, 'totalTimedOut 应记 1');

      releaseHolders();
      const holderResults = await Promise.allSettled(holders);
      const stats = scheduler.stats();
      scheduler.close();
      assertEqual(holderResults.filter((item) => item.status === 'fulfilled').length, 3, '占槽位的 3 个任务应正常完成');
      assertEqual(stats.active, 0, '结束后 active 应归零');

      return {
        status: 'PASS',
        observed: { queueTimeoutMs, code: queuedError.code, totalTimedOut: afterTimeout.totalTimedOut, queuedBeforeTimeout: 1 },
        detail: '排队超时命中 MODEL_QUEUE_TIMEOUT，占槽任务不受影响',
      };
    },
  },
  {
    id: 'S03',
    group: 'S 调度器（X12 桌面侧）',
    title: '取消排队任务：以 MODEL_ABORTED 结束且不泄漏槽位（后续任务仍能跑完）',
    x: ['X12'],
    requires: SCHEDULER_REQUIRES,
    basis: 'rev15 §14.6（取消不泄漏槽位）+ 计划 §4（取消后不再发起上游）',
    expected: '占满 3 槽后排队 2 个，abort 其一 → MODEL_ABORTED；另一个取消排队项后队列归零；'
      + '释放 holder 后新任务能立刻拿到槽位并完成，active 最终归零',
    async run(ctx) {
      const mod = loadModule(ctx);
      const scheduler = mod.createModelCallScheduler({ globalTokens: false, requestTimeoutMs: 20000 });

      let releaseHolders = null;
      const holdersReady = new Promise((resolve) => { releaseHolders = resolve; });
      const holders = [];
      for (let index = 0; index < 3; index += 1) {
        holders.push(scheduler.run(async () => {
          await holdersReady;
          return 'holder-' + index;
        }));
      }
      await new Promise((resolve) => setImmediate(resolve));
      assertEqual(scheduler.stats().active, 3, '3 个 holder 应占满槽位');

      const controllerA = new AbortController();
      const cancelled = scheduler.run(async () => 'never', { signal: controllerA.signal, label: 'cancel-a' });
      const controllerB = new AbortController();
      const cancelledB = scheduler.run(async () => 'never', { signal: controllerB.signal, label: 'cancel-b' });
      await new Promise((resolve) => setImmediate(resolve));
      assertEqual(scheduler.stats().queued, 2, '应有 2 个任务在排队');

      const errors = {};
      const settledA = cancelled.catch((error) => { errors.a = error; });
      controllerA.abort();
      await settledA;
      assert(errors.a, '被取消的排队任务应报错');
      assertEqual(errors.a.code, 'MODEL_ABORTED', '取消排队任务的码应为 MODEL_ABORTED');

      const settledB = cancelledB.catch((error) => { errors.b = error; });
      controllerB.abort();
      await settledB;
      assertEqual(errors.b.code, 'MODEL_ABORTED', '第二个取消也应 MODEL_ABORTED');
      assertEqual(scheduler.stats().queued, 0, '取消后队列应清空');

      releaseHolders();
      await Promise.allSettled(holders);

      // 槽位没泄漏：新任务立刻能跑完
      const after = await scheduler.run(async () => 'post-cancel-ok', { label: 'post' });
      const stats = scheduler.stats();
      scheduler.close();
      assertEqual(after, 'post-cancel-ok', '取消后新任务应能正常执行');
      assertEqual(stats.active, 0, '结束后 active 应归零');
      assertEqual(stats.queued, 0, '结束后 queued 应归零');

      return {
        status: 'PASS',
        observed: { cancelCodes: [errors.a.code, errors.b.code], postCancelRan: true, activeAfter: stats.active },
        detail: '取消命中 MODEL_ABORTED，槽位不泄漏',
      };
    },
  },
  {
    id: 'S04',
    group: 'S 调度器（X12 桌面侧）',
    title: '跨进程：两个进程各 2 个任务共享令牌池 → 全局上游并发峰值 ≤3',
    x: ['X12'],
    requires: SCHEDULER_REQUIRES,
    basis: 'rev15 §14.6（跨进程令牌池 3；降级必须可见）+ e0-r1a 声称“两进程峰值 3”',
    expected: '两个子进程各 2 个任务全部完成；合并时间线算出的全局峰值 ≤3；'
      + '任一子进程报 degraded=true → 本条记 BLOCKED（环境不支持文件令牌），不得记 PASS',
    async run(ctx) {
      const tokenDir = path.join(ctx.temp.real, 'model-tokens');
      const outA = path.join(ctx.temp.real, 'child-a.json');
      const outB = path.join(ctx.temp.real, 'child-b.json');

      const [resultA, resultB] = await Promise.all([
        runChild(tokenDir, outA, 2, 400),
        runChild(tokenDir, outB, 2, 400),
      ]);
      const spawnError = (resultA && resultA.spawnError) || (resultB && resultB.spawnError);
      if (spawnError) {
        return {
          status: 'BLOCKED',
          observed: { spawnError },
          detail: '子进程无法启动（' + spawnError + '），跨进程并发无法在此环境验证',
        };
      }

      const childA = readJsonOrNull(outA);
      const childB = readJsonOrNull(outB);
      assert(childA && childB, '两个子进程都应写出结果文件');
      assertEqual(childA.ok, true, '子进程 A 的 2 个任务都应成功：' + JSON.stringify(childA.error || null));
      assertEqual(childB.ok, true, '子进程 B 的 2 个任务都应成功：' + JSON.stringify(childB.error || null));

      const degraded = Boolean((childA.global && childA.global.degraded) || (childB.global && childB.global.degraded));
      if (degraded) {
        return {
          status: 'BLOCKED',
          observed: {
            degraded: true,
            reasonA: childA.global && childA.global.reason,
            reasonB: childB.global && childB.global.reason,
          },
          detail: '文件令牌池不可用（degraded），跨进程上限 3 无法验证；不得据此判 PASS',
        };
      }

      const intervals = [...(childA.log || []), ...(childB.log || [])];
      assertEqual(intervals.length, 4, '两个进程应共记录 4 次任务执行');
      const peak = peakConcurrency(intervals);
      assert(peak <= 3, '跨进程全局并发峰值必须 ≤3，实际 ' + peak);

      return {
        status: 'PASS',
        observed: {
          peakGlobalConcurrency: peak,
          tasksA: (childA.log || []).length,
          tasksB: (childB.log || []).length,
          heldA: childA.global && childA.global.held,
          degraded: false,
        },
        detail: '两进程 4 个任务、全局峰值 ' + peak + '（≤3）',
      };
    },
  },
  {
    id: 'S05',
    group: 'S 调度器（X12 桌面侧）',
    title: '并发上限只允许 1–3：configure(4) clamp 到 3 且有警告，configure(0) 抛 MODEL_CONFIG_INVALID',
    x: ['X12'],
    requires: SCHEDULER_REQUIRES,
    basis: 'rev15 §14.6（>3 截断 + 可见警告；非法值报错）',
    expected: 'configure({maxConcurrent:4}) → config().maxConcurrent=3 且 warnings 非空；'
      + 'configure({maxConcurrent:0}) → 抛 MODEL_CONFIG_INVALID；env 里 MODEL_MAX_CONCURRENT=9 也被截断到 3',
    async run(ctx) {
      const mod = loadModule(ctx);
      const warnings = [];
      const scheduler = mod.createModelCallScheduler({ globalTokens: false, onWarn: (message) => warnings.push(message) });

      const afterClamp = scheduler.configure({ maxConcurrent: 4 });
      assertEqual(afterClamp.maxConcurrent, 3, 'configure(4) 应 clamp 到 3');
      assert(warnings.length > 0, 'clamp 必须有可见警告');
      assertEqual(scheduler.stats().maxConcurrent, 3, 'stats().maxConcurrent 应为 3');

      let invalidError = null;
      try {
        scheduler.configure({ maxConcurrent: 0 });
      } catch (error) {
        invalidError = error;
      }
      assert(invalidError, 'configure(0) 应抛错');
      assertEqual(invalidError.code, 'MODEL_CONFIG_INVALID', '非法并发应报 MODEL_CONFIG_INVALID');
      scheduler.close();

      const envScheduler = mod.createModelCallScheduler({ globalTokens: false, env: { MODEL_MAX_CONCURRENT: '9' } });
      const envMax = envScheduler.stats().maxConcurrent;
      envScheduler.close();
      assertEqual(envMax, 3, 'env 里 9 也应被截断到 3');

      const legacy = mod.createModelCallScheduler({ globalTokens: false, env: { AGENT_MAX_CONCURRENT: '1' } });
      const legacyMax = legacy.stats().maxConcurrent;
      legacy.close();
      assertEqual(legacyMax, 3, '不得读取被禁止的 AGENT_MAX_CONCURRENT（应保持默认 3）');

      return {
        status: 'PASS',
        observed: { clamped: afterClamp.maxConcurrent, invalidCode: invalidError.code, envMax, legacyEnvIgnoredAs: legacyMax, warnings: warnings.length },
        detail: '上限只接受 1–3；非法值报错；AGENT_* 旧名不生效',
      };
    },
  },
  {
    id: 'S06',
    group: 'S 调度器（X12 桌面侧）',
    title: '排队公平性：先到先得（FIFO），释放一个槽位只放出队首',
    x: ['X12'],
    requires: SCHEDULER_REQUIRES,
    basis: 'rev15 §14.6（公平 FIFO 队列）',
    expected: '3 槽占满后排队 q0/q1/q2；释放 1 个槽位 → 只有 q0 开始；依次释放 → 顺序 q0→q1→q2，无插队',
    async run(ctx) {
      const mod = loadModule(ctx);
      const scheduler = mod.createModelCallScheduler({ globalTokens: false, requestTimeoutMs: 20000 });
      const order = [];
      const holdReleases = [];
      let holderGateResolve = null;
      const holderGate = new Promise((resolve) => { holderGateResolve = resolve; });

      const holders = [];
      for (let index = 0; index < 3; index += 1) {
        holders.push(scheduler.run(async () => {
          await holderGate;
          return 'holder-' + index;
        }));
      }
      await new Promise((resolve) => setImmediate(resolve));
      assertEqual(scheduler.stats().active, 3, '3 个 holder 应占满槽位');

      const queued = [];
      for (let index = 0; index < 3; index += 1) {
        let releaseTask = null;
        const gate = new Promise((resolve) => { releaseTask = resolve; });
        holdReleases.push(() => releaseTask());
        queued.push(scheduler.run(async () => {
          order.push('q' + index);
          await gate;
          return 'q' + index;
        }, { label: 'q' + index }));
      }
      await new Promise((resolve) => setImmediate(resolve));
      assertEqual(scheduler.stats().queued, 3, '3 个任务应在排队');

      holderGateResolve();
      // 释放 holder 逐个空出槽位：先放 1 个，再放 2 个
      await sleep(30);
      holdReleases[0]();
      await sleep(30);
      holdReleases[1]();
      await sleep(30);
      holdReleases[2]();
      await Promise.allSettled(queued);
      await Promise.allSettled(holders);
      const stats = scheduler.stats();
      scheduler.close();

      assertEqual(order.join(','), 'q0,q1,q2', '排队必须 FIFO，实际 ' + order.join(','));
      assertEqual(stats.active, 0, '结束后 active 应归零');

      return {
        status: 'PASS',
        observed: { order, stats: { totalAcquired: stats.totalAcquired, maxQueueLength: stats.maxQueueLength } },
        detail: 'FIFO 顺序成立，无插队',
      };
    },
  },
];

module.exports = { CASES, SCHEDULER_REQUIRES, peakConcurrency };
