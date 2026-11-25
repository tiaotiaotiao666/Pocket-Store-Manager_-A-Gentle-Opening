/**
 * t24 / Review-t9 独立探针 3：令牌目录不可用 fail-closed、进程级 fetch 兜底的槽位释放语义、
 * 入口排队、Nest 引导期兜底安装、默认令牌目录一致。
 *
 * 运行：cd server; npx tsx ../docs/evidence/workspace-agent/reviews/t9-probe-guard.ts
 * 只写 os.tmpdir()；不联网（全部 127.0.0.1）。
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import {
  AgentEntryQueue,
  DEFAULT_AGENT_MAX_CONCURRENT,
  createModelCallScheduler,
  createScheduledFetch,
  defaultTokenDir,
  ensureUpstreamFetchGuard,
  getSharedModelCallScheduler,
  isUpstreamFetchGuardInstalled,
  peekSharedModelCallScheduler,
  readAgentEntryQueueOptions,
  resetSharedModelCallScheduler,
  resolveSchedulerOptionsFromEnv,
  uninstallUpstreamFetchGuard,
  MAX_UPSTREAM_CONCURRENCY,
} from '../../../../server/src/agent/model-scheduler/index.ts';
import { DeepseekChatModel, type DeepseekChatSettings } from '../../../../server/src/agent/runtime/adapters/deepseek-chat-model.ts';
import { WorkspaceAgentModule } from '../../../../server/src/agent/workspace/workspace-agent.module.ts';
import { PrismaService } from '../../../../server/src/database/prisma.service.ts';

const require = createRequire(import.meta.url);
const requireFromServer = createRequire(path.join(path.resolve(process.cwd()), 'package.json'));
const desktopScheduler = require('../../../../desktop/model-call-scheduler.cjs');
// Nest 运行时依赖装在 server/node_modules：从 server 目录解析，避免探针文件位置影响模块解析。
const { Test } = requireFromServer('@nestjs/testing') as { Test: typeof import('@nestjs/testing').Test };
const { ConfigModule } = requireFromServer('@nestjs/config') as { ConfigModule: typeof import('@nestjs/config').ConfigModule };

const results: Array<Record<string, unknown>> = [];
function check(id: string, ok: boolean, detail: unknown): void {
  results.push({ id, ok, detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + id + (ok ? '' : ' :: ' + JSON.stringify(detail)));
}
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const SETTINGS: DeepseekChatSettings = {
  baseUrl: 'http://127.0.0.1:1',
  apiKey: 'sk-t9-probe-0123456789',
  model: 'deepseek-chat',
  visionModel: 'deepseek-flash',
  timeoutMs: 5000,
  maxTokens: 200,
  temperature: 0.2,
  reasoningEffort: '',
};

interface Probe {
  calls: number;
  peak: number;
  inFlight: number;
  fetch: (input: string, init?: RequestInit) => Promise<unknown>;
}

function countingFetch(delayMs = 20): Probe {
  const probe: Probe = {
    calls: 0,
    peak: 0,
    inFlight: 0,
    async fetch(): Promise<unknown> {
      probe.calls += 1;
      probe.inFlight += 1;
      probe.peak = Math.max(probe.peak, probe.inFlight);
      await sleep(delayMs);
      probe.inFlight -= 1;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ model: 'deepseek-chat', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
      };
    },
  };
  return probe;
}

function newServerScheduler(options: Record<string, unknown>) {
  return createModelCallScheduler({ tokenDir: tempDir('t9-guard-slots-'), ...options });
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error('waitFor 超时：' + label);
}

/* ------------------------------------------------------------------ */
/* G1/G2：令牌目录不可用（严格 fail-closed / 非严格 degraded）          */
/* ------------------------------------------------------------------ */

async function g1g2(): Promise<void> {
  const parent = tempDir('t9-blocked-');
  const blockedDir = path.join(parent, 'token-dir');
  fs.writeFileSync(blockedDir, 'not a directory');

  const warnings: string[] = [];
  const strictScheduler = createModelCallScheduler({
    tokenDir: blockedDir,
    strictGlobalTokens: true,
    onWarn: (message: string) => warnings.push(message),
  });
  const probe = countingFetch(1);
  const model = new DeepseekChatModel({
    fetch: createScheduledFetch(probe.fetch as never, strictScheduler, 'probe'),
    settings: () => SETTINGS,
    scheduler: strictScheduler,
  });
  const strictOutcome = await model
    .complete({ messages: [{ role: 'user', content: 'x' }] })
    .then(() => ({ ok: true, code: null as string | null, message: '' }),
      (error: { code?: string; message?: string }) => ({ ok: false, code: error.code ?? null, message: String(error.message ?? '') }));
  check('G01-strict-fail-closed-zero-upstream',
    strictOutcome.ok === false
    && strictOutcome.code === 'DEEPSEEK_UNAVAILABLE'
    && probe.calls === 0
    && /模型并发通道不可用/.test(strictOutcome.message)
    && warnings.some((message) => message.includes('跨进程模型并发令牌不可用'))
    && strictScheduler.globalStats().degraded === true
    && /ENOTDIR|EEXIST|EPERM|EACCES/.test(String(strictScheduler.globalStats().reason))
    && strictScheduler.stats().active === 0,
  { outcome: strictOutcome, calls: probe.calls, warnings, global: strictScheduler.globalStats() });
  strictScheduler.close();

  const warnings2: string[] = [];
  const looseScheduler = createModelCallScheduler({
    tokenDir: blockedDir,
    onWarn: (message: string) => warnings2.push(message),
  });
  const looseProbe = countingFetch(1);
  const looseModel = new DeepseekChatModel({
    fetch: createScheduledFetch(looseProbe.fetch as never, looseScheduler, 'probe'),
    settings: () => SETTINGS,
    scheduler: looseScheduler,
  });
  const looseResult = await looseModel.complete({ messages: [{ role: 'user', content: 'x' }] });
  check('G02-loose-visible-warning-degraded',
    looseResult.message.content === 'ok'
    && looseProbe.calls === 1
    && looseScheduler.globalStats().degraded === true
    && warnings2.some((message) => message.includes('这不再是「全局最多 3」的保证')),
  { calls: looseProbe.calls, degraded: looseScheduler.globalStats().degraded, warnings: warnings2 });
  looseScheduler.close();
}

/* ------------------------------------------------------------------ */
/* G3：进程级 fetch 兜底的槽位释放时机（对照适配器路径）                */
/* ------------------------------------------------------------------ */

async function g3(): Promise<void> {
  resetSharedModelCallScheduler();
  uninstallUpstreamFetchGuard();

  let bodyDone = false;
  let headersSent = false;
  const server = http.createServer((request, response) => {
    request.on('data', () => undefined);
    request.on('end', () => {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '11' });
      (response as unknown as { flushHeaders?: () => void }).flushHeaders?.();
      headersSent = true;
      setTimeout(() => {
        bodyDone = true;
        response.end('{"ok":true}');
      }, 250);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/chat/completions`;

  // (a) 裸 fetch + 进程级兜底：fetch 解析（HTTP 头）即释放槽位？
  const scheduler = newServerScheduler({ maxConcurrent: 1 });
  ensureUpstreamFetchGuard(scheduler);
  let bareSecondDuringBody: boolean | null = null;
  try {
    await waitFor(() => isUpstreamFetchGuardInstalled(), '兜底已安装');
    const first = await fetch(url, { method: 'POST', body: '{}' });
    const headersDone = headersSent;
    let secondStarted = false;
    const second = scheduler.run(async () => {
      secondStarted = true;
      bareSecondDuringBody = !bodyDone;
    });
    await second;
    await first.text();
    check('G03-guard-covered-raw-fetch-releases-at-headers',
      headersDone === true && bareSecondDuringBody === true && bodyDone === true,
      { headersDone, secondStartedDuringBody: bareSecondDuringBody, bodyDone });
  } finally {
    uninstallUpstreamFetchGuard();
    scheduler.close();
  }

  // (b) 适配器路径（DeepseekChatModel.complete）：槽位持有到响应体读完
  bodyDone = false;
  headersSent = false;
  const chatPayload = JSON.stringify({
    model: 'deepseek-chat',
    choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
  });
  const chatServer = http.createServer((request, response) => {
    request.on('data', () => undefined);
    request.on('end', () => {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(chatPayload)) });
      (response as unknown as { flushHeaders?: () => void }).flushHeaders?.();
      headersSent = true;
      setTimeout(() => {
        bodyDone = true;
        response.end(chatPayload);
      }, 250);
    });
  });
  await new Promise<void>((resolve) => chatServer.listen(0, '127.0.0.1', () => resolve()));
  const chatPort = (chatServer.address() as { port: number }).port;
  const scheduler2 = newServerScheduler({ maxConcurrent: 1 });
  ensureUpstreamFetchGuard(scheduler2);
  try {
    const model = new DeepseekChatModel({
      fetch: createScheduledFetch(((input: string, init?: RequestInit) => fetch(input, init)) as never, scheduler2, 'probe'),
      settings: () => ({ ...SETTINGS, baseUrl: `http://127.0.0.1:${chatPort}` }),
      scheduler: scheduler2,
    });
    let modelError: string | null = null;
    const running = model.complete({ messages: [{ role: 'user', content: 'x' }] }).catch((error: { code?: string }) => {
      modelError = String(error?.code ?? error);
      return null;
    });
    await waitFor(() => headersSent === true, '响应头已到');
    let secondStarted = false;
    const second = scheduler2.run(async () => {
      secondStarted = true;
    });
    await sleep(80);
    const secondDuringBody = secondStarted;
    await running;
    await second;
    check('G04-adapter-path-holds-slot-until-body-read',
      secondDuringBody === false && bodyDone === true && modelError === null,
      { secondDuringBody, bodyDone, modelError, stats: scheduler2.stats() });
  } finally {
    uninstallUpstreamFetchGuard();
    scheduler2.close();
    chatServer.close();
    server.close();
  }
}

/* ------------------------------------------------------------------ */
/* G5：进程级兜底对 5 个裸 fetch 的实际并发上限                         */
/* ------------------------------------------------------------------ */

async function g5(): Promise<void> {
  resetSharedModelCallScheduler();
  uninstallUpstreamFetchGuard();
  let inFlight = 0;
  let peak = 0;
  let requests = 0;
  const server = http.createServer((request, response) => {
    requests += 1;
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    request.on('data', () => undefined);
    request.on('end', () => {
      setTimeout(() => {
        inFlight -= 1;
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{"ok":true}');
      }, 60);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  const scheduler = getSharedModelCallScheduler({
    env: {},
    onWarn: () => undefined,
    overrides: { maxConcurrent: 3, tokenDir: tempDir('t9-guard5-') },
  });
  try {
    await Promise.all(Array.from({ length: 5 }, () => fetch(`http://127.0.0.1:${port}/chat/completions`, { method: 'POST', body: '{}' })));
    const afterChat = scheduler.stats().totalAcquired;
    await fetch(`http://127.0.0.1:${port}/images/generations`, { method: 'POST', body: '{}' });
    check('G05-guard-limits-raw-fetch-to-3',
      peak === MAX_UPSTREAM_CONCURRENCY && requests === 6 && afterChat === 5 && scheduler.stats().totalAcquired === 5,
      { peak, requests, totalAcquiredAfterChat: afterChat, totalAcquired: scheduler.stats().totalAcquired });
  } finally {
    server.close();
    resetSharedModelCallScheduler();
    uninstallUpstreamFetchGuard();
  }
}

/* ------------------------------------------------------------------ */
/* G6：入口排队（AGENT_MAX_CONCURRENT 只排队，不直接 429）              */
/* ------------------------------------------------------------------ */

async function g6(): Promise<void> {
  const queue = new AgentEntryQueue({ maxConcurrent: 3, waitMs: 5000 });
  const admitted: number[] = [];
  const releases: Array<() => void> = [];
  const pending = Array.from({ length: 5 }, (_, index) => queue.acquire().then((slot) => {
    admitted.push(index);
    releases.push(slot.release);
  }));
  await waitFor(() => admitted.length === 3, '3 个放行');
  const queued = queue.stats().queued;
  const busyBefore = queue.stats().totalBusy;
  releases.shift()?.();
  await waitFor(() => admitted.length === 4, '第 4 个放行');
  while (releases.length > 0) releases.shift()?.();
  await Promise.all(pending);
  check('G06-entry-queue-3-admit-2-wait-no-429',
    admitted.length === 5 && admitted[3] === 3 && queued === 2 && busyBefore === 0 && queue.stats().totalBusy === 0,
    { admitted, queued, busyBefore, totalBusy: queue.stats().totalBusy });

  const saved = { NODE_ENV: process.env.NODE_ENV, AGENT_RAILS_ENFORCE: process.env.AGENT_RAILS_ENFORCE, AGENT_MAX_CONCURRENT: process.env.AGENT_MAX_CONCURRENT };
  try {
    process.env.NODE_ENV = 'development';
    delete process.env.AGENT_RAILS_ENFORCE;
    delete process.env.AGENT_MAX_CONCURRENT;
    const defaultOptions = readAgentEntryQueueOptions();
    process.env.AGENT_MAX_CONCURRENT = '9';
    const nineOptions = readAgentEntryQueueOptions();
    check('G07-entry-default-3-and-env-honored',
      DEFAULT_AGENT_MAX_CONCURRENT === 3 && defaultOptions.maxConcurrent === 3 && nineOptions.maxConcurrent === 9,
      { defaultOptions, nineOptions });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key as keyof NodeJS.ProcessEnv];
      else process.env[key as keyof NodeJS.ProcessEnv] = value;
    }
  }

  const resolved = resolveSchedulerOptionsFromEnv({ AGENT_MAX_CONCURRENT: '9' });
  check('G08-scheduler-ignores-agent-max-concurrent', resolved.maxConcurrent === 3 && resolved.warnings.length === 0, resolved);
}

/* ------------------------------------------------------------------ */
/* G9：Nest 引导期就装好进程级兜底（不手动 get provider）                */
/* ------------------------------------------------------------------ */

async function g9(): Promise<void> {
  resetSharedModelCallScheduler();
  uninstallUpstreamFetchGuard();
  const savedEnv = { NODE_ENV: process.env.NODE_ENV, AGENT_RAILS_ENFORCE: process.env.AGENT_RAILS_ENFORCE };
  process.env.NODE_ENV = 'development';
  delete process.env.AGENT_RAILS_ENFORCE;
  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), WorkspaceAgentModule],
  })
    // 本机没有 MySQL：把 Prisma 的 onModuleInit 替身掉，只验证 Nest 引导期的拦截器/调度器初始化。
    .overrideProvider(PrismaService)
    .useValue({ onModuleInit: async () => undefined, onModuleDestroy: async () => undefined })
    .compile();
  const app = moduleRef.createNestApplication();
  try {
    await app.init();
    const installedAfterInit = isUpstreamFetchGuardInstalled();
    const schedulerAfterInit = peekSharedModelCallScheduler();
    const queue = app.get(AgentEntryQueue);
    check('G09-bootstrap-installs-guard',
      installedAfterInit === true
      && schedulerAfterInit !== null
      && queue.stats().maxConcurrent === DEFAULT_AGENT_MAX_CONCURRENT,
      { installedAfterInit, hasScheduler: schedulerAfterInit !== null, queueMax: queue.stats().maxConcurrent });
  } finally {
    await app.close();
    resetSharedModelCallScheduler();
    uninstallUpstreamFetchGuard();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key as keyof NodeJS.ProcessEnv];
      else process.env[key as keyof NodeJS.ProcessEnv] = value;
    }
  }
}

/* ------------------------------------------------------------------ */
/* G11：进程级单例默认 strict（令牌目录不可用 → MODEL_BUSY）            */
/* ------------------------------------------------------------------ */

async function g11(): Promise<void> {
  resetSharedModelCallScheduler();
  uninstallUpstreamFetchGuard();
  const parent = tempDir('t9-singleton-blocked-');
  const blockedDir = path.join(parent, 'blocked');
  fs.writeFileSync(blockedDir, 'x');
  const scheduler = getSharedModelCallScheduler({
    env: {},
    onWarn: () => undefined,
    overrides: { tokenDir: blockedDir },
  });
  try {
    const outcome = await scheduler.run(async () => 'never')
      .then(() => ({ code: null as string | null }), (error: { code?: string }) => ({ code: error.code ?? null }));
    check('G11-shared-singleton-defaults-to-strict',
      outcome.code === 'MODEL_BUSY'
      && scheduler.globalStats().degraded === true
      && scheduler.stats().active === 0
      && isUpstreamFetchGuardInstalled() === true,
      { code: outcome.code, global: scheduler.globalStats(), guard: isUpstreamFetchGuardInstalled() });
  } finally {
    resetSharedModelCallScheduler();
    uninstallUpstreamFetchGuard();
  }
}

/* ------------------------------------------------------------------ */
/* G12/G13：guard 路径的 timeout 语义；guard 被后续替换 fetch 后静默失效 */
/* ------------------------------------------------------------------ */

async function g12(): Promise<void> {
  resetSharedModelCallScheduler();
  uninstallUpstreamFetchGuard();
  let requests = 0;
  const server = http.createServer((request, response) => {
    requests += 1;
    request.on('data', () => undefined);
    request.on('end', () => {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '11' });
      response.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  const scheduler = newServerScheduler({ maxConcurrent: 1 });
  ensureUpstreamFetchGuard(scheduler);
  try {
    // 占满唯一槽位 400ms；第二个调用像 presentation/generation 那样「先起 100ms 请求计时器再 fetch」。
    const occupier = scheduler.run(async () => {
      await sleep(400);
    });
    const outcome = await (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 100);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/chat/completions`, {
          method: 'POST', body: '{}', signal: controller.signal,
        });
        await response.text();
        return 'ok';
      } catch (error) {
        return (error as Error).name;
      } finally {
        clearTimeout(timer);
      }
    })();
    await occupier;
    check('G12-guard-path-request-timeout-consumes-queue-wait',
      // 排队期间就被调用方自己的计时器 abort：outcome 是调度器错误（MODEL_ABORTED），上游 0 次调用。
      String(outcome) !== 'ok' && requests === 0 && scheduler.stats().totalAcquired === 1,
      { outcome, requests, stats: scheduler.stats() });
  } finally {
    uninstallUpstreamFetchGuard();
    scheduler.close();
    server.close();
  }
}

async function g13(): Promise<void> {
  resetSharedModelCallScheduler();
  uninstallUpstreamFetchGuard();
  const scheduler = newServerScheduler({ maxConcurrent: 1 });
  ensureUpstreamFetchGuard(scheduler);
  const guarded = globalThis.fetch;
  try {
    // 模拟「后续库/框架替换了 globalThis.fetch」：守卫已不再是最外层。
    const replacement = (async () => new Response('{}', { status: 200 })) as typeof globalThis.fetch;
    globalThis.fetch = replacement;
    ensureUpstreamFetchGuard(scheduler);
    const before = scheduler.stats().totalAcquired;
    await fetch('http://127.0.0.1:1/chat/completions', { method: 'POST', body: '{}' });
    const after = scheduler.stats().totalAcquired;
    check('G13-guard-not-reinstalled-after-fetch-replacement',
      isUpstreamFetchGuardInstalled() === true && after === before,
      { reportedInstalled: isUpstreamFetchGuardInstalled(), acquiredBefore: before, acquiredAfter: after });
  } finally {
    globalThis.fetch = guarded;
    uninstallUpstreamFetchGuard();
    scheduler.close();
  }
}

/* ------------------------------------------------------------------ */
/* G10：默认令牌目录两侧一致                                            */
/* ------------------------------------------------------------------ */

function g10(): void {
  const desktopDefault = desktopScheduler.defaultTokenDir
    ? desktopScheduler.defaultTokenDir()
    : null;
  const serverDefault = defaultTokenDir();
  check('G10-default-token-dir-same',
    serverDefault === path.join(os.tmpdir(), 'smart-store-model-slots')
    && (desktopDefault === null || desktopDefault === serverDefault),
    { serverDefault, desktopDefault });
}

(async () => {
  await g1g2();
  await g3();
  await g5();
  await g6();
  await g10();
  await g11();
  await g12();
  await g13();
  await g9();
  console.log('---');
  console.log('TOTAL=' + results.length + ' FAILED=' + results.filter((item) => !item.ok).length);
  fs.writeFileSync(path.join(os.tmpdir(), 't9-guard-result.json'), JSON.stringify(results, null, 2), 'utf8');
  process.exitCode = results.every((item) => item.ok) ? 0 : 1;
})();
