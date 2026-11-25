/**
 * 跨进程不叠加（HTTP + desktop direct 共用同一批令牌）。
 *
 * 复用桌面 E0-R1a 的令牌协议（`desktop/model-call-scheduler.cjs` 的 `MODEL_UPSTREAM_TOKEN_DIR`），
 * 不另定协议：
 * - 子进程 A：桌面调度器（plain node，require desktop/model-call-scheduler.cjs），本进程上限 2；
 * - 子进程 B：服务端调度器（tsx 直跑 server/src/agent/model-scheduler），本进程上限 2；
 * - 两者都指向同一个令牌目录，同时各发 2 个上游请求（合计 4）。
 * 若两边各算一套，峰值会是 4；共用令牌协议时峰值必须是 3。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

const SERVER_ROOT = path.resolve(process.cwd());
const REPO_ROOT = path.resolve(SERVER_ROOT, '..');
const DESKTOP_SCHEDULER = path.join(REPO_ROOT, 'desktop', 'model-call-scheduler.cjs');
const CHILD_SCRIPT = path.join(SERVER_ROOT, 'test', 'model-scheduler', '.tmp-cross-process-child.ts');
const REQUESTS_PER_CHILD = 2;
const LOCAL_LIMIT_PER_CHILD = 2;

interface ChildReport {
  role: string;
  statuses?: number[];
  error?: string;
  stats?: { maxConcurrent: number; totalAcquired: number; queued: number; active: number };
  global?: { enabled: boolean; degraded: boolean; held: number; reason: string | null; dir: string | null };
}

function runChild(label: string, args: string[], logFile: string): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve) => {
    const fd = fs.openSync(logFile, 'w');
    const child = spawn(process.execPath, args, {
      cwd: SERVER_ROOT,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill();
    }, 40_000);
    child.on('error', () => {
      clearTimeout(timer);
      try { fs.closeSync(fd); } catch { /* ignore */ }
      resolve({ code: -1, signal: 'spawn-error' });
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      try { fs.closeSync(fd); } catch { /* ignore */ }
      resolve({ code, signal });
    });
  });
}

const desktopChildSource = `
const fs = require('node:fs');
const { createModelCallScheduler } = require(process.argv[2]);
const cfg = JSON.parse(process.argv[3]);
const scheduler = createModelCallScheduler({
  maxConcurrent: cfg.concurrency,
  queueTimeoutMs: cfg.queueTimeoutMs,
  tokenDir: cfg.tokenDir,
  env: {},
});
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
(async () => {
  const wait = Math.max(0, cfg.startAt - Date.now());
  if (wait > 0) await sleep(wait);
  const statuses = await Promise.all(Array.from({ length: cfg.requests }, () => scheduler.run(async () => {
    const response = await fetch(cfg.url, { method: 'POST', body: '{}' });
    await response.text();
    return response.status;
  }, { label: 'desktop-child' })));
  fs.writeFileSync(cfg.out, JSON.stringify({
    role: 'desktop',
    statuses,
    stats: scheduler.stats(),
    global: scheduler.globalStats(),
  }));
  scheduler.close();
})().catch((error) => {
  fs.writeFileSync(cfg.out, JSON.stringify({ role: 'desktop', error: String((error && error.message) || error) }));
  process.exitCode = 1;
});
`;

const serverChildSource = `
import fs from 'node:fs';

import { createModelCallScheduler } from '../../src/agent/model-scheduler/model-scheduler';

const cfg = JSON.parse(process.argv[2] as string);
const scheduler = createModelCallScheduler({
  maxConcurrent: cfg.concurrency,
  queueTimeoutMs: cfg.queueTimeoutMs,
  tokenDir: cfg.tokenDir,
  env: {},
});
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
(async () => {
  const wait = Math.max(0, cfg.startAt - Date.now());
  if (wait > 0) await sleep(wait);
  const statuses = await Promise.all(
    Array.from({ length: cfg.requests }, () =>
      scheduler.run(async () => {
        const response = await fetch(cfg.url, { method: 'POST', body: '{}' });
        await response.text();
        return response.status;
      }, { label: 'server-child' }),
    ),
  );
  fs.writeFileSync(cfg.out, JSON.stringify({
    role: 'server',
    statuses,
    stats: scheduler.stats(),
    global: scheduler.globalStats(),
  }));
  scheduler.close();
})().catch((error: unknown) => {
  fs.writeFileSync(cfg.out, JSON.stringify({ role: 'server', error: String((error as Error)?.message ?? error) }));
  process.exitCode = 1;
});
`;

describe('跨进程不叠加：桌面 direct 与 HTTP 共用 MODEL_UPSTREAM_TOKEN_DIR', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-xproc-'));
  const tokenDir = path.join(tmpDir, 'tokens');
  fs.mkdirSync(tokenDir, { recursive: true });

  afterAll(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(CHILD_SCRIPT, { force: true }); } catch { /* ignore */ }
  });

  it('两进程各 2 个请求：上游并发峰值 = 3（不是 4）', async () => {
    let inFlight = 0;
    let peak = 0;
    let served = 0;
    const server = http.createServer((request, response) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      served += 1;
      request.on('data', () => undefined);
      request.on('end', () => {
        setTimeout(() => {
          inFlight -= 1;
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ ok: true }));
        }, 150);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as { port: number }).port;
    const url = `http://127.0.0.1:${port}/chat/completions`;

    const desktopOut = path.join(tmpDir, 'desktop.json');
    const serverOut = path.join(tmpDir, 'server.json');
    const desktopScript = path.join(tmpDir, 'desktop-child.cjs');
    fs.writeFileSync(desktopScript, desktopChildSource, 'utf8');
    fs.writeFileSync(CHILD_SCRIPT, serverChildSource, 'utf8');

    const cfg = {
      concurrency: LOCAL_LIMIT_PER_CHILD,
      requests: REQUESTS_PER_CHILD,
      queueTimeoutMs: 60_000,
      tokenDir,
      url,
      // 两个子进程对齐起跑，保证 4 个请求真的重叠。
      startAt: Date.now() + 4000,
    };

    const desktopLog = path.join(tmpDir, 'desktop.log');
    const serverLog = path.join(tmpDir, 'server.log');

    try {
      const [desktopExit, serverExit] = await Promise.all([
        runChild('desktop', [desktopScript, DESKTOP_SCHEDULER, JSON.stringify({ ...cfg, out: desktopOut })], desktopLog),
        runChild(
          'server',
          ['--import', 'tsx', CHILD_SCRIPT, JSON.stringify({ ...cfg, out: serverOut })],
          serverLog,
        ),
      ]);

      const diagnostics = () => [
        `desktop exit=${JSON.stringify(desktopExit)} log=${fs.existsSync(desktopLog) ? fs.readFileSync(desktopLog, 'utf8').slice(-800) : 'n/a'}`,
        `server exit=${JSON.stringify(serverExit)} log=${fs.existsSync(serverLog) ? fs.readFileSync(serverLog, 'utf8').slice(-800) : 'n/a'}`,
      ].join('\n');

      expect(desktopExit.code, diagnostics()).toBe(0);
      expect(serverExit.code, diagnostics()).toBe(0);

      const desktopReport = JSON.parse(fs.readFileSync(desktopOut, 'utf8')) as ChildReport;
      const serverReport = JSON.parse(fs.readFileSync(serverOut, 'utf8')) as ChildReport;
      expect(desktopReport.error, JSON.stringify(desktopReport)).toBeUndefined();
      expect(serverReport.error, JSON.stringify(serverReport)).toBeUndefined();

      // 两边都真的发满了自己的请求。
      expect(desktopReport.statuses).toEqual(Array.from({ length: REQUESTS_PER_CHILD }, () => 200));
      expect(serverReport.statuses).toEqual(Array.from({ length: REQUESTS_PER_CHILD }, () => 200));
      expect(served).toBe(REQUESTS_PER_CHILD * 2);

      // 共用令牌池：4 个请求同时在线，上游只允许 3 个。
      expect(peak).toBe(3);
      // 若两边各算一套，峰值会是 4；这里显式证明没有叠加。
      expect(peak).toBeLessThan(REQUESTS_PER_CHILD * 2);

      for (const report of [desktopReport, serverReport]) {
        expect(report.global?.enabled).toBe(true);
        expect(report.global?.degraded).toBe(false);
        expect(report.global?.held).toBe(0);
        expect(report.global?.dir).toBe(tokenDir);
        expect(report.stats?.totalAcquired).toBe(REQUESTS_PER_CHILD);
        expect(report.stats?.active).toBe(0);
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 120_000);
});
