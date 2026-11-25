'use strict';

/**
 * 跨进程并发观测子进程（由 `chains/scheduler.cjs` 的 S04 拉起）。
 *
 * 用法：node scheduler-child.cjs <tokenDir> <outFile> <tasks> <holdMs>
 * 行为：用真实调度器 + 真实文件令牌池跑 N 个任务，把每个任务的 [start,end] 写进结果文件。
 * 输出走文件而不是管道，避免沙箱下 stdio 管道限制影响判定。
 */

const fs = require('node:fs');
const path = require('node:path');

function writeResult(outFile, value) {
  try {
    fs.writeFileSync(outFile, JSON.stringify(value, null, 2), 'utf8');
  } catch {
    /* ignore */
  }
}

async function main() {
  const [tokenDir, outFile, tasksRaw, holdRaw] = process.argv.slice(2);
  const taskCount = Number.parseInt(tasksRaw, 10) || 2;
  const holdMs = Number.parseInt(holdRaw, 10) || 400;
  let scheduler = null;
  try {
    const mod = require(path.resolve(__dirname, '..', '..', '..', 'desktop', 'model-call-scheduler.cjs'));
    scheduler = mod.createModelCallScheduler({
      tokenDir,
      requestTimeoutMs: 30000,
    });
    const log = [];
    const tasks = [];
    for (let index = 0; index < taskCount; index += 1) {
      tasks.push(scheduler.run(async () => {
        const start = Date.now();
        await new Promise((resolve) => setTimeout(resolve, holdMs));
        log.push({ index, start, end: Date.now() });
        return 'ok-' + index;
      }, { label: 'child-' + index }));
    }
    const settled = await Promise.allSettled(tasks);
    const global = typeof scheduler.globalStats === 'function' ? scheduler.globalStats() : null;
    writeResult(outFile, {
      ok: settled.every((item) => item.status === 'fulfilled'),
      log,
      stats: scheduler.stats(),
      global,
      failures: settled
        .filter((item) => item.status === 'rejected')
        .map((item) => ({ code: item.reason && item.reason.code, message: item.reason && item.reason.message })),
    });
  } catch (error) {
    writeResult(outFile, {
      ok: false,
      log: [],
      error: { code: error && error.code, message: error && error.message },
    });
  } finally {
    try {
      if (scheduler) scheduler.close();
    } catch {
      /* ignore */
    }
  }
}

main().then(() => {
  process.exit(0);
}).catch(() => {
  process.exit(1);
});
