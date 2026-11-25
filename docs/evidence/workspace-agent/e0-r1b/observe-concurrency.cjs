'use strict';

/**
 * E0-R1b 并发观测：给 `report.md` 提供可复现的真实数字（全部 fake 上游，不打 api.deepseek.com）。
 *
 * 用法（server 目录，需要 tsx 直跑服务端 TS 源码）：
 *   cd server
 *   npx tsx ../docs/evidence/workspace-agent/e0-r1b/observe-concurrency.cjs
 *
 * 产出（stdout JSON）：
 * - `inProcess`：5 个并发 `DeepseekChatModel.complete`（经 createScheduledFetch 接线）
 *   的 active/queued/上游并发峰值；
 * - `crossProcess`：桌面调度器进程（plain node，复用 E0-R1a 的 `observe-concurrency.cjs`
 *   协议：同一个 `MODEL_UPSTREAM_TOKEN_DIR`、每进程 2 次真实 HTTP）与服务端调度器进程同时请求，
 *   父进程 HTTP 上游观测到的并发峰值（≥4 即说明两边各算一套）；
 * - `tokenDir`：全局令牌目录、峰值占用文件数、各子进程 globalStats。
 */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SERVER_DIR = process.cwd();
const ROOT = path.resolve(SERVER_DIR, '..');
const DESKTOP_SCHEDULER = path.join(ROOT, 'desktop', 'model-call-scheduler.cjs');
const SERVER_SCHEDULER = path.join(SERVER_DIR, 'src', 'agent', 'model-scheduler');

const { createModelCallScheduler } = require(path.join(SERVER_SCHEDULER, 'model-scheduler.ts'));
const { createScheduledFetch } = require(path.join(SERVER_SCHEDULER, 'scheduled-fetch.ts'));
const { DeepseekChatModel } = require(path.join(SERVER_DIR, 'src', 'agent', 'runtime', 'adapters', 'deepseek-chat-model.ts'));

const API_KEY = 'sk-test-0123456789abcdef';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chatSettings() {
  return {
    baseUrl: 'http://127.0.0.1:1',
    apiKey: API_KEY,
    model: 'deepseek-chat',
    visionModel: 'deepseek-flash',
    timeoutMs: 30000,
    maxTokens: 512,
    temperature: 0.2,
    reasoningEffort: '',
  };
}

function chatBody() {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      model: 'deepseek-chat',
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  };
}

async function inProcessObservation() {
  const tokenDir = makeTempDir('e0r1b-slots-');
  const scheduler = createModelCallScheduler({ tokenDir, maxConcurrent: 3, env: {} });
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchImpl = async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await sleep(120);
    inFlight -= 1;
    return chatBody();
  };
  const model = new DeepseekChatModel({
    fetch: createScheduledFetch(fetchImpl, scheduler, 'evidence-observe'),
    settings: chatSettings,
    scheduler,
  });

  const pending = Array.from({ length: 5 }, () => model.complete({ messages: [{ role: 'user', content: '门店名：观测' }] }));
  await sleep(60);
  const midFlight = scheduler.stats();
  const results = await Promise.all(pending);
  const done = scheduler.stats();
  const global = scheduler.globalStats();
  scheduler.close();

  return {
    requests: 5,
    succeeded: results.filter((item) => item.message.content === 'ok').length,
    maxConcurrent: midFlight.maxConcurrent,
    activeWhileQueued: midFlight.active,
    queuedWhileQueued: midFlight.queued,
    maxQueueLength: done.maxQueueLength,
    totalAcquired: done.totalAcquired,
    upstreamPeakInFlight: maxInFlight,
    tokenDir: global.dir,
    tokenHeldAfterDone: global.held,
    degraded: global.degraded,
  };
}

const DESKTOP_CHILD = `
const fs = require('node:fs');
const { createModelCallScheduler } = require(process.env.MODULE_PATH);
const scheduler = createModelCallScheduler({
  tokenDir: process.env.TOKEN_DIR,
  maxConcurrent: Number(process.env.LOCAL_LIMIT || '2'),
  queueTimeoutMs: 60000,
  env: {},
});
const url = 'http://127.0.0.1:' + process.env.PORT + '/chat/completions';
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
(async () => {
  const wait = Math.max(0, Number(process.env.START_AT) - Date.now());
  if (wait > 0) await sleep(wait);
  const results = await Promise.all(Array.from({ length: Number(process.env.REQUESTS || '2') }, () => scheduler.run(async ({ signal }) => {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal });
    await response.text();
    return response.status;
  }, { label: 'desktop-child' })));
  fs.writeFileSync(process.env.OUT_FILE, JSON.stringify({ ok: true, statuses: results, stats: scheduler.stats(), global: scheduler.globalStats() }));
  scheduler.close();
  process.exit(0);
})().catch((error) => {
  fs.writeFileSync(process.env.OUT_FILE, JSON.stringify({ ok: false, code: (error && error.code) || String(error) }));
  process.exit(1);
});
`;

const SERVER_CHILD = `
const fs = require('node:fs');
const { createModelCallScheduler } = require(process.env.MODULE_PATH);
const scheduler = createModelCallScheduler({
  tokenDir: process.env.TOKEN_DIR,
  maxConcurrent: Number(process.env.LOCAL_LIMIT || '2'),
  queueTimeoutMs: 60000,
  env: {},
});
const url = 'http://127.0.0.1:' + process.env.PORT + '/chat/completions';
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
(async () => {
  const wait = Math.max(0, Number(process.env.START_AT) - Date.now());
  if (wait > 0) await sleep(wait);
  const results = await Promise.all(Array.from({ length: Number(process.env.REQUESTS || '2') }, () => scheduler.run(async ({ signal }) => {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal });
    await response.text();
    return response.status;
  }, { label: 'server-child' })));
  fs.writeFileSync(process.env.OUT_FILE, JSON.stringify({ ok: true, statuses: results, stats: scheduler.stats(), global: scheduler.globalStats() }));
  scheduler.close();
  process.exit(0);
})().catch((error) => {
  fs.writeFileSync(process.env.OUT_FILE, JSON.stringify({ ok: false, code: (error && error.code) || String(error) }));
  process.exit(1);
});
`;

async function crossProcessObservation() {
  const tokenDir = path.join(makeTempDir('e0r1b-xproc-'), 'tokens');
  fs.mkdirSync(tokenDir, { recursive: true });
  const outDir = makeTempDir('e0r1b-xproc-out-');
  let inFlight = 0;
  let maxInFlight = 0;
  let served = 0;
  let peakTokens = 0;

  const server = http.createServer((request, response) => {
    inFlight += 1;
    served += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      peakTokens = Math.max(peakTokens, fs.readdirSync(tokenDir).filter((name) => name.startsWith('slot-')).length);
    } catch {
      /* 目录读不到就不计入峰值 */
    }
    request.on('data', () => undefined);
    request.on('end', () => {
      setTimeout(() => {
        inFlight -= 1;
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ ok: true }));
      }, 150);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  function runChild(label, modulePath, index, startAt) {
    const outFile = path.join(outDir, `${label}-${index}.json`);
    const source = label === 'desktop' ? DESKTOP_CHILD : SERVER_CHILD;
    const args = label === 'desktop'
      ? ['-e', source]
      // 服务端调度器是 TS：用 tsx 的 require 钩子直跑源码。
      : ['--import', 'tsx', '-e', source];
    return new Promise((resolve) => {
      let settled = false;
      const finish = (payload) => {
        if (settled) return;
        settled = true;
        resolve(payload);
      };
      let child;
      try {
        child = spawn(process.execPath, args, {
          cwd: SERVER_DIR,
          env: {
            ...process.env,
            MODULE_PATH: modulePath,
            TOKEN_DIR: tokenDir,
            PORT: String(port),
            REQUESTS: '2',
            LOCAL_LIMIT: '2',
            START_AT: String(startAt),
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

  const startAt = Date.now() + 4000;
  const children = await Promise.all([
    runChild('desktop', DESKTOP_SCHEDULER, 1, startAt),
    runChild('server', path.join(SERVER_SCHEDULER, 'model-scheduler.ts'), 2, startAt),
    runChild('desktop', DESKTOP_SCHEDULER, 3, startAt),
    runChild('server', path.join(SERVER_SCHEDULER, 'model-scheduler.ts'), 4, startAt),
  ]);
  server.close();
  return {
    processes: 4,
    requestsPerProcess: 2,
    upstreamReceived: served,
    upstreamPeakInFlight: maxInFlight,
    peakTokenFiles: peakTokens,
    wouldBeWithoutSharedTokens: 4 * 2,
    children,
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
  process.stderr.write(`${String((error && error.stack) || error)}\n`);
  process.exit(1);
});
