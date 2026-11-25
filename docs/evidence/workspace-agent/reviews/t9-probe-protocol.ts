/**
 * t24 / Review-t9 独立探针 4：跨进程令牌协议互操作（桌面 ↔ 服务端）+ 静态出口/变量/X9 核对。
 *
 * 运行：cd server; npx tsx ../docs/evidence/workspace-agent/reviews/t9-probe-protocol.ts
 * 只写 os.tmpdir()。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import {
  MAX_UPSTREAM_CONCURRENCY,
  DEFAULT_LEASE_TTL_MS,
  createUpstreamTokenBroker as createServerBroker,
  resolveSchedulerOptionsFromEnv,
} from '../../../../server/src/agent/model-scheduler/index.ts';

const require = createRequire(import.meta.url);
const desktop = require('../../../../desktop/model-call-scheduler.cjs');
const SERVER_DIR = path.resolve(process.cwd());
const SERVER_SRC = path.join(SERVER_DIR, 'src');
const results: Array<Record<string, unknown>> = [];
function check(id: string, ok: boolean, detail: unknown): void {
  results.push({ id, ok, detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + id + (ok ? '' : ' :: ' + JSON.stringify(detail)));
}
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function readTokens(dir: string): Array<{ file: string; payload: Record<string, unknown> }> {
  return fs.readdirSync(dir)
    .filter((name) => /^slot-\d+\.token$/.test(name))
    .sort()
    .map((name) => ({ file: name, payload: JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) }));
}

/* ------------------------------------------------------------------ */
/* T1：两侧令牌文件形状/命名/租约字段一致                               */
/* ------------------------------------------------------------------ */

async function t1(): Promise<void> {
  const desktopDir = tempDir('t9-proto-desktop-');
  const serverDir = tempDir('t9-proto-server-');
  const desktopBroker = desktop.createUpstreamTokenBroker({ dir: desktopDir });
  const serverBroker = createServerBroker({ dir: serverDir });
  const desktopToken = await desktopBroker.acquire({ waitMs: 2000, label: 'desktop' });
  const serverToken = await serverBroker.acquire({ waitMs: 2000, label: 'server' });
  try {
    const desktopFiles = readTokens(desktopDir);
    const serverFiles = readTokens(serverDir);
    const desktopKeys = Object.keys(desktopFiles[0].payload).sort();
    const serverKeys = Object.keys(serverFiles[0].payload).sort();
    const desktopPayload = desktopFiles[0].payload;
    const serverPayload = serverFiles[0].payload;
    check('T01-token-file-shape-identical',
      desktopFiles[0].file === 'slot-1.token'
      && serverFiles[0].file === 'slot-1.token'
      && JSON.stringify(desktopKeys) === JSON.stringify(serverKeys)
      && JSON.stringify(desktopKeys) === JSON.stringify(['acquiredAt', 'expiresAt', 'host', 'label', 'pid', 'v'])
      && desktopPayload.v === 1 && serverPayload.v === 1
      && desktopPayload.host === serverPayload.host
      && typeof desktopPayload.pid === 'number' && typeof serverPayload.pid === 'number'
      && Number(desktopPayload.expiresAt) - Number(desktopPayload.acquiredAt) === DEFAULT_LEASE_TTL_MS
      && Number(serverPayload.expiresAt) - Number(serverPayload.acquiredAt) === DEFAULT_LEASE_TTL_MS
      && desktopBroker.maxTokens === MAX_UPSTREAM_CONCURRENCY
      && serverBroker.maxTokens === MAX_UPSTREAM_CONCURRENCY
      && desktopBroker.leaseTtlMs === DEFAULT_LEASE_TTL_MS
      && serverBroker.leaseTtlMs === DEFAULT_LEASE_TTL_MS,
    {
      desktopFiles,
      serverFiles,
      desktopKeys,
      serverKeys,
      desktopTtl: desktopBroker.leaseTtlMs,
      serverTtl: serverBroker.leaseTtlMs,
      desktopMax: desktopBroker.maxTokens,
      serverMax: serverBroker.maxTokens,
    });
  } finally {
    desktopToken.release();
    serverToken.release();
  }
}

/* ------------------------------------------------------------------ */
/* T2/T3：一侧占满 3 个令牌 → 另一侧必须看得到（排队超时），释放后拿到   */
/* ------------------------------------------------------------------ */

async function t2t3(): Promise<void> {
  // T2：桌面占满 → 服务端排队超时；释放 1 个 → 服务端拿到
  const sharedDir = tempDir('t9-proto-shared-');
  const desktopBroker = desktop.createUpstreamTokenBroker({ dir: sharedDir });
  const serverBroker = createServerBroker({ dir: sharedDir, pollMs: 10 });
  const desktopTokens = [];
  for (let index = 0; index < 3; index += 1) desktopTokens.push(await desktopBroker.acquire({ waitMs: 2000 }));
  const serverCode = await serverBroker.acquire({ waitMs: 300 }).then(() => null, (error: { code?: string }) => error.code ?? 'ERROR');
  desktopTokens[0].release();
  const serverAfterRelease = await serverBroker.acquire({ waitMs: 5000 }).then(() => true, (error: { code?: string }) => error.code ?? 'ERROR');
  check('T02-desktop-tokens-block-server',
    serverCode === 'MODEL_QUEUE_TIMEOUT' && serverAfterRelease === true,
    { serverCode, serverAfterRelease, heldByDesktop: readTokens(sharedDir).length });
  if (serverAfterRelease === true) {
    // 清空
  }
  desktopTokens.forEach((token: { release: () => void }) => token.release());

  // T3：服务端占满 → 桌面排队超时；释放 1 个 → 桌面拿到
  const sharedDir2 = tempDir('t9-proto-shared2-');
  const serverBroker2 = createServerBroker({ dir: sharedDir2 });
  const desktopBroker2 = desktop.createUpstreamTokenBroker({ dir: sharedDir2, pollMs: 10 });
  const serverTokens = [];
  for (let index = 0; index < 3; index += 1) serverTokens.push(await serverBroker2.acquire({ waitMs: 2000 }));
  const desktopCode = await desktopBroker2.acquire({ waitMs: 300 }).then(() => null, (error: { code?: string }) => error.code ?? 'ERROR');
  serverTokens[0].release();
  const desktopAfterRelease = await desktopBroker2.acquire({ waitMs: 5000 }).then(() => true, (error: { code?: string }) => error.code ?? 'ERROR');
  check('T03-server-tokens-block-desktop',
    desktopCode === 'MODEL_QUEUE_TIMEOUT' && desktopAfterRelease === true,
    { desktopCode, desktopAfterRelease });
  serverTokens.forEach((token: { release: () => void }) => token.release());
}

/* ------------------------------------------------------------------ */
/* T4：过期令牌（同机死 pid）两侧都能回收                               */
/* ------------------------------------------------------------------ */

async function t4(): Promise<void> {
  const payload = (now: number): string => JSON.stringify({
    v: 1,
    pid: 2147480000, // 不存在的 pid
    host: os.hostname(),
    acquiredAt: now - 60000,
    expiresAt: now - 30000,
    label: 'dead',
  });
  const desktopDir = tempDir('t9-proto-reclaim-desktop-');
  fs.writeFileSync(path.join(desktopDir, 'slot-1.token'), payload(Date.now()));
  const desktopBroker = desktop.createUpstreamTokenBroker({ dir: desktopDir });
  const desktopToken = await desktopBroker.acquire({ waitMs: 2000 }).then((token: { index: number }) => token.index, (error: { code?: string }) => error.code ?? 'ERROR');
  const serverDir = tempDir('t9-proto-reclaim-server-');
  fs.writeFileSync(path.join(serverDir, 'slot-1.token'), payload(Date.now()));
  const serverBroker = createServerBroker({ dir: serverDir, pollMs: 10 });
  const serverToken = await serverBroker.acquire({ waitMs: 2000 }).then((token: { index: number }) => token.index, (error: { code?: string }) => error.code ?? 'ERROR');
  check('T04-expired-dead-pid-reclaimed-both',
    desktopToken === 1 && serverToken === 1,
    { desktopToken, serverToken });
}

/* ------------------------------------------------------------------ */
/* T5：静态核对（出口清单 / 静态测试覆盖 / AGENT_MAX_CONCURRENT / X9）  */
/* ------------------------------------------------------------------ */

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

function t5(): void {
  const files = listTsFiles(SERVER_SRC);
  const outlets = files
    .map((file) => ({ file, rel: path.relative(SERVER_DIR, file).split(path.sep).join('/') }))
    .filter(({ rel, file }) => !rel.startsWith('src/agent/model-scheduler/')
      && /chat\/completions/.test(fs.readFileSync(file, 'utf8')))
    .map(({ rel }) => rel);

  // t9 静态用例的过滤条件（必须同时含 chat/completions 与 `fetch(`）
  const t9Filter = files
    .map((file) => ({ file, rel: path.relative(SERVER_DIR, file).split(path.sep).join('/') }))
    .filter(({ rel, file }) => !rel.startsWith('src/agent/model-scheduler/')
      && /chat\/completions/.test(fs.readFileSync(file, 'utf8'))
      && /\bfetch\s*\(/.test(fs.readFileSync(file, 'utf8')))
    .map(({ rel }) => rel);

  const explicit = [
    'src/agent/runtime/adapters/deepseek-chat-model.ts',
    'src/agent/provider/deepseek-agent.provider.ts',
    'src/agent/workspace/workspace-agent.module.ts',
  ];
  const guardCovered = [
    'src/agent/presentation/template-revise.provider.ts',
    'src/generation/model-provider.service.ts',
  ];
  const wiring: Record<string, boolean> = {};
  for (const rel of explicit) {
    if (!outlets.includes(rel)) continue;
    const source = fs.readFileSync(path.join(SERVER_DIR, rel), 'utf8');
    wiring[rel] = /scheduler\.run\(|createScheduledFetch\(/.test(source);
  }
  check('T05-outlet-inventory',
    outlets.length === 5
    && outlets.every((rel) => explicit.includes(rel) || guardCovered.includes(rel))
    && Object.values(wiring).every(Boolean),
    { outlets, wiring });

  check('T06-t9-static-filter-misses-3-of-5',
    t9Filter.length === 2
    && !t9Filter.includes('src/agent/presentation/template-revise.provider.ts')
    && !t9Filter.includes('src/agent/runtime/adapters/deepseek-chat-model.ts')
    && !t9Filter.includes('src/agent/provider/deepseek-agent.provider.ts'),
    { t9Filter, outlets });

  const schedulerFiles = listTsFiles(path.join(SERVER_SRC, 'agent', 'model-scheduler'));
  const schedulerText = schedulerFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  const agentMaxReads = schedulerFiles
    .filter((file) => /AGENT_MAX_CONCURRENT/.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(SERVER_DIR, file).split(path.sep).join('/'));
  check('T07-scheduler-does-not-read-agent-max',
    !/process\.env\.AGENT_MAX_CONCURRENT|get\(['"]AGENT_MAX_CONCURRENT['"]\)/.test(schedulerText)
    && agentMaxReads.every((rel) => rel.endsWith('agent-entry-queue.ts') || rel.endsWith('index.ts') || rel.endsWith('model-scheduler.ts') || rel.endsWith('model-scheduler.types.ts')),
    { agentMaxReads, resolve: resolveSchedulerOptionsFromEnv({ AGENT_MAX_CONCURRENT: '9' }) });

  const serviceSource = fs.readFileSync(path.join(SERVER_SRC, 'agent', 'workspace', 'workspace-agent.service.ts'), 'utf8');
  const allServerText = listTsFiles(SERVER_SRC).map((file) => ({ rel: path.relative(SERVER_DIR, file).split(path.sep).join('/'), text: fs.readFileSync(file, 'utf8') }));
  const pendingConfirmation = allServerText.filter(({ text }) => text.includes('待本地确认')).map(({ rel }) => rel);
  const forbiddenRewrite = /\.replace\([^;\n]*(已采用|已验证|已导出)/.test(serviceSource);
  check('T08-x9-server-rewrite-removed',
    !serviceSource.includes('FORBIDDEN_CLAIM_PATTERN')
    && !forbiddenRewrite
    && pendingConfirmation.length === 0
    && serviceSource.includes('[path]'),
    { pendingConfirmation, forbiddenRewrite, hasPathScrub: serviceSource.includes('[path]') });

  const testText = fs.readFileSync(path.join(SERVER_DIR, 'test', 'workspace-agent.test.ts'), 'utf8');
  check('T09-x9-absence-assertion-present',
    /not\.toContain\(['"]待本地确认['"]\)|not\.toMatch\([^)]*待本地确认/.test(testText)
    && /not\.toContain\(['"]FORBIDDEN_CLAIM_PATTERN['"]\)/.test(testText),
    {
      hasPendingAssert: /not\.toContain\(['"]待本地确认['"]\)/.test(testText),
      hasPatternAssert: /not\.toContain\(['"]FORBIDDEN_CLAIM_PATTERN['"]\)/.test(testText),
    });

  // 「不得有第二份用例」：scenario 名只允许出现在 runner 的 `spec.scenario === 'x'` 分派里，
  // 不允许出现 `id: 'x'` / `expect: {...}` 形式的内联副本；仓库里也不允许有第二个 cases JSON。
  const serverTests = [
    'test/model-scheduler/model-scheduler.test.ts',
    'test/model-scheduler/cross-process.test.ts',
    'test/workspace-agent.test.ts',
  ].map((rel) => fs.readFileSync(path.join(SERVER_DIR, rel), 'utf8')).join('\n');
  const scenarioIds = JSON.parse(fs.readFileSync(path.join(SERVER_DIR, '..', 'test', 'fixtures', 'model-scheduler', 'cases.json'), 'utf8'))
    .cases.map((item: { id: string }) => item.id);
  const withoutDispatch = serverTests.replace(/spec\.scenario === '[a-z-]+'/g, '');
  const duplicatedIds = scenarioIds.filter((id: string) => withoutDispatch.includes(id));
  const fixtureDirs = fs.readdirSync(path.join(SERVER_DIR, '..', 'test', 'fixtures', 'model-scheduler'));
  const serverFixtureCopies = fs.existsSync(path.join(SERVER_DIR, 'test', 'fixtures'))
    ? listTsFiles(path.join(SERVER_DIR, 'test', 'fixtures')).length
    : 0;
  check('T10-no-second-case-copy',
    duplicatedIds.length === 0
    && JSON.stringify(fixtureDirs) === JSON.stringify(['cases.json'])
    && serverFixtureCopies === 0
    && /cases\.json/.test(serverTests),
    { duplicatedIds, fixtureDirs, serverFixtureCopies, referencesFixture: /cases\.json/.test(serverTests) });

  const envSource = fs.readFileSync(path.join(SERVER_SRC, 'common', 'config', 'env.validation.ts'), 'utf8');
  const railsSource = fs.readFileSync(path.join(SERVER_SRC, 'agent', 'agent-guard-rails.ts'), 'utf8');
  check('T11-agent-max-default-3',
    /AGENT_MAX_CONCURRENT = 3;/.test(envSource)
    && /AGENT_MAX_CONCURRENT: 3,/.test(envSource)
    && /DEFAULT_AGENT_MAX_CONCURRENT = 3;/.test(railsSource),
    {
      envClassDefault: /AGENT_MAX_CONCURRENT = 3;/.test(envSource),
      numericDefault: /AGENT_MAX_CONCURRENT: 3,/.test(envSource),
      railsDefault: /DEFAULT_AGENT_MAX_CONCURRENT = 3;/.test(railsSource),
      railsResidualFallback2: /: 2,/.test(railsSource.slice(railsSource.indexOf('AGENT_MAX_CONCURRENT') - 400)),
    });
}

(async () => {
  await t1();
  await t2t3();
  await t4();
  t5();
  console.log('---');
  console.log('TOTAL=' + results.length + ' FAILED=' + results.filter((item) => !item.ok).length);
  fs.writeFileSync(path.join(os.tmpdir(), 't9-protocol-result.json'), JSON.stringify(results, null, 2), 'utf8');
  process.exitCode = results.every((item) => item.ok) ? 0 : 1;
})();
