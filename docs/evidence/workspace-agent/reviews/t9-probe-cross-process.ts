/**
 * t24 / Review-t9 独立探针 2：两进程（桌面调度器 + 服务端调度器）共享 MODEL_UPSTREAM_TOKEN_DIR 时的
 * 上游真实并发峰值。
 *
 * 对照组：两个进程各用**不同**令牌目录 → 峰值应为 4（证明「同一目录」才是真正的不叠加机制）。
 * 运行：cd server; npx tsx ../docs/evidence/workspace-agent/reviews/t9-probe-cross-process.ts
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const HERE = path.resolve(process.cwd(), '..', 'docs', 'evidence', 'workspace-agent', 'reviews');
const SERVER_DIR = path.resolve(process.cwd());
const results: Array<Record<string, unknown>> = [];

function check(id: string, ok: boolean, detail: unknown): void {
  results.push({ id, ok, detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + id + (ok ? '' : ' :: ' + JSON.stringify(detail)));
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function tokenFileCount(dir: string): number {
  try {
    return fs.readdirSync(dir).filter((name) => /^slot-\d+\.token$/.test(name)).length;
  } catch {
    return 0;
  }
}

function runChild(command: string, args: string[], options: { cwd?: string; env: NodeJS.ProcessEnv }): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString().slice(0, 4000); });
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      resolve({ code: null, stderr: stderr + ' [timeout]' });
    }, 30000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, stderr: String(error) });
    });
  });
}

async function runPair(options: { sameDir: boolean; localMax: number; count: number; label: string }): Promise<Record<string, unknown>> {
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
        response.end(JSON.stringify({ ok: true }));
      }, 120);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  const targetUrl = `http://127.0.0.1:${port}/chat/completions`;

  const sharedDir = options.sameDir ? tempDir('t9-shared-slots-') : '';
  const desktopDir = options.sameDir ? sharedDir : tempDir('t9-desktop-slots-');
  const serverDir = options.sameDir ? sharedDir : tempDir('t9-server-slots-');
  const outDir = tempDir('t9-out-');
  const desktopOut = path.join(outDir, 'desktop.json');
  const serverOut = path.join(outDir, 'server.json');

  let tokenPeak = 0;
  const pollTokenPeak = (): void => {
    tokenPeak = Math.max(tokenPeak, tokenFileCount(desktopDir), tokenFileCount(serverDir));
  };
  const poller = setInterval(pollTokenPeak, 5);
  // 起跑对齐：tsx 子进程启动较慢，给 3s 让两侧都加载完，再在同一时刻开始发请求。
  const startAt = Date.now() + 3000;

  const desktopPromise = runChild(process.execPath, [path.join(HERE, 't9-probe-child-desktop.cjs')], {
    env: {
      ...process.env,
      TOKEN_DIR: desktopDir,
      TARGET_URL: targetUrl,
      COUNT: String(options.count),
      MAX_CONCURRENT: String(options.localMax),
      START_AT: String(startAt),
      OUT_FILE: desktopOut,
    },
  });
  const serverPromise = runChild(process.execPath, ['--import', 'tsx', path.join(HERE, 't9-probe-child-server.ts')], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      TOKEN_DIR: serverDir,
      TARGET_URL: targetUrl,
      COUNT: String(options.count),
      MAX_CONCURRENT: String(options.localMax),
      START_AT: String(startAt),
      OUT_FILE: serverOut,
    },
  });

  const [desktopExit, serverExit] = await Promise.all([desktopPromise, serverPromise]);
  clearInterval(poller);
  await sleep(30);
  server.close();

  const readJson = (file: string): Record<string, any> | null => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  };
  return {
    label: options.label,
    sameDir: options.sameDir,
    peakUpstream: peak,
    requests,
    tokenPeak,
    desktopExit,
    serverExit,
    desktop: readJson(desktopOut),
    server: readJson(serverOut),
  };
}

(async () => {
  const same = await runPair({ sameDir: true, localMax: 3, count: 2, label: 'shared-token-dir' });
  check('C01-two-processes-shared-token-dir-peak<=3',
    same.peakUpstream === 3 && same.requests === 4 && same.tokenPeak === 3,
    same);
  const childOk = [same.desktop, same.server].every((child) => child
    && Array.isArray(child.statuses) && child.statuses.length === 2
    && child.statuses.every((status: unknown) => status === 200)
    && child.global && child.global.degraded === false && child.global.held === 0);
  check('C02-children-report-no-degradation', childOk, { desktop: same.desktop, server: same.server });

  const separate = await runPair({ sameDir: false, localMax: 3, count: 2, label: 'separate-token-dirs-control' });
  check('C03-control-separate-dirs-peak=4', separate.peakUpstream === 4 && separate.tokenPeak === 2, {
    peakUpstream: separate.peakUpstream,
    tokenPeak: separate.tokenPeak,
    requests: separate.requests,
  });

  console.log('---');
  console.log('TOTAL=' + results.length + ' FAILED=' + results.filter((item) => !item.ok).length);
  fs.writeFileSync(path.join(os.tmpdir(), 't9-cross-process-result.json'), JSON.stringify(results, null, 2), 'utf8');
  process.exitCode = results.every((item) => item.ok) ? 0 : 1;
})();
