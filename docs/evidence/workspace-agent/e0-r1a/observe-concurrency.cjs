'use strict';

/**
 * E0-R1a 并发观测：给 `report.md` 提供可复现的真实数字（全部 fake 上游，不打 api.deepseek.com）。
 *
 * 用法（仓库根目录）：
 *   node docs/evidence/workspace-agent/e0-r1a/observe-concurrency.cjs
 *
 * 产出（stdout JSON）：
 * - `inProcess`：5 个并发 `credentials.chat` 的 active/queued/上游并发峰值；
 * - `crossProcess`：两个独立 node 子进程各 2 次真实 HTTP 请求，父进程 HTTP 上游观测到的并发峰值；
 * - `tokenDir`：全局令牌目录与峰值占用。
 */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const SCHEDULER_MODULE = path.join(ROOT, 'desktop', 'model-call-scheduler.cjs');
const { createModelCallScheduler } = require(SCHEDULER_MODULE);
const { createModelCredentials } = require(path.join(ROOT, 'desktop', 'model-credentials.cjs'));

const API_KEY = 'sk-test-0123456789abcdef';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from(`enc:${Buffer.from(text, 'utf8').toString('base64')}`, 'utf8'),
    decryptString: (buffer) => Buffer.from(buffer.toString('utf8').slice(4), 'base64').toString('utf8'),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function inProcessObservation() {
  const tokenDir = makeTempDir('e0r1a-slots-');
  const scheduler = createModelCallScheduler({ tokenDir, maxConcurrent: 3 });
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchImpl = async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await sleep(120);
    inFlight -= 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ model: 'deepseek-flash', choices: [{ message: { content: 'ok' } }] }),
    };
  };
  const credentials = createModelCredentials({
    userDataDir: makeTempDir('e0r1a-creds-'),
    safeStorage: fakeSafeStorage(),
    fetchImpl,
    scheduler,
  });
  await credentials.setKey(API_KEY);

  const jobs = Array.from({ length: 5 }, (_, index) => credentials.chat({
    messages: [{ role: 'user', content: `并发观测 ${index}` }],
  }));
  await sleep(40);
  const during = scheduler.stats();
  const duringGlobal = scheduler.globalStats();
  await Promise.all(jobs);
  const after = scheduler.stats();
  scheduler.close();
  return {
    requests: 5,
    activeDuring: during.active,
    queuedDuring: during.queued,
    upstreamPeakInFlight: maxInFlight,
    totalAcquired: after.totalAcquired,
    maxQueueLength: after.maxQueueLength,
    globalTokensHeldDuring: duringGlobal.held,
    tokenDir,
  };
}

async function crossProcessObservation() {
  const tokenDir = makeTempDir('e0r1a-xproc-slots-');
  const outDir = makeTempDir('e0r1a-xproc-out-');
  let inFlight = 0;
  let maxInFlight = 0;
  let served = 0;
  let peakTokens = 0;

  const server = http.createServer((request, response) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const tokenFiles = fs.readdirSync(tokenDir).filter((name) => name.endsWith('.token')).length;
    peakTokens = Math.max(peakTokens, tokenFiles);
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
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
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
Promise.all(Array.from({ length: Number(process.env.REQUESTS || '2') }, (_, index) => scheduler.run(async ({ signal }) => {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal });
  await response.json();
  return index;
}, { label: 'xproc' }))).then((results) => {
  fs.writeFileSync(process.env.OUT_FILE, JSON.stringify({ ok: true, done: results.length, stats: scheduler.stats(), global: scheduler.globalStats() }));
  process.exit(0);
}).catch((error) => {
  fs.writeFileSync(process.env.OUT_FILE, JSON.stringify({ ok: false, code: error && error.code }));
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
    });
  }

  const results = await Promise.all([runChild(1), runChild(2)]);
  server.close();
  return {
    processes: 2,
    requestsPerProcess: 2,
    upstreamReceived: served,
    upstreamPeakInFlight: maxInFlight,
    peakTokenFiles: peakTokens,
    children: results,
    tokenDir,
  };
}

(async () => {
  const inProcess = await inProcessObservation();
  const crossProcess = await crossProcessObservation();
  const report = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    fakeUpstream: true,
    realUpstreamCalls: 0,
    inProcess,
    crossProcess,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
})().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exit(1);
});
