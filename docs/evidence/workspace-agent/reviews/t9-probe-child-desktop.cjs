'use strict';

/**
 * t24 跨进程探针子进程（桌面侧）：用 desktop/model-call-scheduler.cjs 的调度器，
 * 共享 MODEL_UPSTREAM_TOKEN_DIR，向父进程的计数服务器发 COUNT 次真实 HTTP /chat/completions。
 *
 * 环境变量：TOKEN_DIR / TARGET_URL / COUNT / OUT_FILE / MAX_CONCURRENT
 */

const fs = require('node:fs');
const path = require('node:path');
const { createModelCallScheduler } = require(path.resolve(__dirname, '..', '..', '..', '..', 'desktop', 'model-call-scheduler.cjs'));

const tokenDir = process.env.TOKEN_DIR;
const targetUrl = process.env.TARGET_URL;
const count = Number(process.env.COUNT || '2');
const outFile = process.env.OUT_FILE;
const maxConcurrent = Number(process.env.MAX_CONCURRENT || '3');

async function waitForStartBarrier() {
  const startAt = Number(process.env.START_AT || '0');
  while (startAt > 0 && Date.now() < startAt) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function main() {
  await waitForStartBarrier();
  const scheduler = createModelCallScheduler({
    tokenDir,
    maxConcurrent,
    onWarn: () => undefined,
  });
  const started = Date.now();
  const results = await Promise.allSettled(Array.from({ length: count }, async (_, index) => {
    return scheduler.run(async () => {
      const response = await fetch(targetUrl, { method: 'POST', body: JSON.stringify({ i: index }) });
      await response.text();
      return response.status;
    }, { label: 'desktop-' + index });
  }));
  const stats = scheduler.stats();
  const global = scheduler.globalStats();
  scheduler.close();
  fs.writeFileSync(outFile, JSON.stringify({
    side: 'desktop',
    statuses: results.map((item) => (item.status === 'fulfilled' ? item.value : String(item.reason && item.reason.code || item.reason))),
    stats,
    global,
    elapsedMs: Date.now() - started,
  }, null, 2));
}

main().catch((error) => {
  try { fs.writeFileSync(outFile, JSON.stringify({ side: 'desktop', error: String(error && error.stack || error) })); } catch {}
  process.exitCode = 1;
});
