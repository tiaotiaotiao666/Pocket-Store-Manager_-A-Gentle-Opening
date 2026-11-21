import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SERVER = path.join(ROOT, 'server');
const PORT = 3101;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const result = { schemaVersion: 'sidebar-preview-store-probe.v1', port: PORT, checks: [], cleanup: null };
const createdStoreIds = new Set();
const createdUserIds = new Set(['usr_01M7W1ZKR05V056B93W78T']);
const serverRequire = createRequire(path.join(SERVER, 'package.json'));
serverRequire('dotenv').config({ path: path.join(SERVER, '.env') });
const { PrismaClient } = serverRequire('@prisma/client');
const prisma = new PrismaClient();
const serverLog = fs.createWriteStream(path.join(HERE, 'server-3101.log'), { flags: 'w' });
let child = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const record = (name, evidence = {}) => {
  result.checks.push({ name, status: 'PASS', ...evidence });
  console.log(`PASS ${name} ${JSON.stringify(evidence)}`);
};
const fail = (name, evidence = {}) => {
  result.checks.push({ name, status: 'FAIL', ...evidence });
  process.exitCode = 1;
  console.log(`FAIL ${name} ${JSON.stringify(evidence)}`);
};

async function http(route, { method = 'GET', token = null, body, headers = {} } = {}) {
  const response = await fetch(BASE + route, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await response.json(); } catch { data = null; }
  return { status: response.status, data };
}

async function login(openId) {
  const response = await http('/auth/wechat/login', { method: 'POST', body: { demoOpenId: openId } });
  assert.ok([200, 201].includes(response.status), `登录失败：HTTP ${response.status} / ${response.data?.code || 'UNKNOWN'}`);
  assert.ok(response.data?.token);
  createdUserIds.add(response.data.user.id);
  return response.data;
}

function expectedStoreId(userId, bindingKey) {
  return 'store-preview-' + createHash('sha256').update(`${userId}:${bindingKey}`, 'utf8').digest('hex').slice(0, 32);
}

async function stopServer() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([exited, sleep(5000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await Promise.race([exited, sleep(2000)]);
  }
}

try {
  const previousDemoOwner = await prisma.user.findUnique({ where: { openId: 'demo-owner-001' }, select: { id: true } });
  if (previousDemoOwner) {
    createdStoreIds.add(expectedStoreId(previousDemoOwner.id, 'verify:1795164247612-9f7f3b4d:project-a'));
  }
  child = spawn(process.execPath, [path.join(SERVER, 'dist', 'main.js')], {
    cwd: SERVER,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(PORT),
      SERVER_HOST: '127.0.0.1',
      ALLOW_DEMO_LOGIN: 'true',
      AGENT_REQUIRE_AUTH: 'false',
      CACHE_DRIVER: 'memory',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.pipe(serverLog);
  child.stderr.pipe(serverLog);

  let healthy = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) break;
    try {
      const response = await http('/health');
      if (response.status === 200 && response.data?.status === 'ok') {
        healthy = true;
        break;
      }
    } catch { /* 服务尚在启动，有限次重试。 */ }
    await sleep(250);
  }
  assert.ok(healthy, '3101 新构建服务未在 20 秒内就绪，见 server-3101.log');
  record('isolated-new-build-ready', { url: BASE });

  const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const userA = await login(`verify-sidebar-a-${suffix}`);
  const userB = await login(`verify-sidebar-b-${suffix}`);

  const unauthorized = await http('/merchant/preview-stores', { method: 'POST', body: { bindingKey: 'verify:unauthorized' } });
  assert.equal(unauthorized.status, 401);
  record('endpoint-requires-session', { status: unauthorized.status, code: unauthorized.data?.code });

  const invalid = await http('/merchant/preview-stores', { method: 'POST', token: userA.token, body: { bindingKey: 'bad key with spaces' } });
  assert.equal(invalid.status, 422);
  record('invalid-binding-422', { status: invalid.status, code: invalid.data?.code });

  const binding = `verify:${suffix}:ensure`;
  const ensured = await http('/merchant/preview-stores', { method: 'POST', token: userA.token, body: { bindingKey: binding } });
  assert.equal(ensured.status, 201, JSON.stringify(ensured));
  assert.equal(ensured.data.created, true);
  assert.equal(ensured.data.storeId, expectedStoreId(userA.user.id, binding));
  createdStoreIds.add(ensured.data.storeId);
  const ensuredAgain = await http('/merchant/preview-stores', { method: 'POST', token: userA.token, body: { bindingKey: binding } });
  assert.equal(ensuredAgain.status, 201);
  assert.equal(ensuredAgain.data.created, false);
  assert.deepEqual(ensuredAgain.data, { ...ensured.data, created: false });
  record('ensure-deterministic-and-idempotent', { storeId: ensured.data.storeId, first: ensured.data, replay: ensuredAgain.data });

  const raceBinding = `verify:${suffix}:race`;
  const race = await Promise.all(Array.from({ length: 6 }, () => http('/merchant/preview-stores', {
    method: 'POST', token: userA.token, body: { bindingKey: raceBinding },
  })));
  assert.ok(race.every((item) => item.status === 201), JSON.stringify(race));
  const raceId = expectedStoreId(userA.user.id, raceBinding);
  createdStoreIds.add(raceId);
  assert.ok(race.every((item) => item.data.storeId === raceId));
  assert.equal(race.filter((item) => item.data.created === true).length, 1, JSON.stringify(race));
  assert.equal(await prisma.storeMember.count({ where: { storeId: raceId, userId: userA.user.id } }), 1);
  record('concurrent-ensure-single-owner', { requests: 6, createdTrue: 1, ownerMemberships: 1, storeId: raceId });

  const conflictBinding = `verify:${suffix}:conflict`;
  const conflictStoreId = expectedStoreId(userB.user.id, conflictBinding);
  createdStoreIds.add(conflictStoreId);
  const now = new Date();
  await prisma.store.create({ data: { id: conflictStoreId, name: '验证冲突门店', createdAt: now, updatedAt: now } });
  await prisma.storeMember.create({
    data: {
      id: `mem${randomUUID().replace(/-/g, '').slice(0, 23)}`,
      storeId: conflictStoreId,
      userId: userA.user.id,
      role: 'OWNER',
      createdAt: now,
    },
  });
  const conflict = await http('/merchant/preview-stores', { method: 'POST', token: userB.token, body: { bindingKey: conflictBinding } });
  assert.equal(conflict.status, 409, JSON.stringify(conflict));
  assert.equal(conflict.data?.code, 'PREVIEW_STORE_CONFLICT');
  record('foreign-owner-conflict-409', { status: conflict.status, code: conflict.data.code });

  const nativeFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const rewritten = typeof input === 'string'
      ? input.replace('http://127.0.0.1:3000/api/v1', BASE)
      : input;
    return nativeFetch(rewritten, init);
  };
  const importService = await import(pathToFileURL(path.join(ROOT, 'src', 'services', 'importService.js')).href + `?verify=${suffix}`);
  importService.resetImportSession();
  const invalidHelper = await importService.prepareProjectPreview({ bindingKey: 'bad key', agentDraft: {}, store: {} });
  assert.equal(invalidHelper.status, 'failed');
  assert.equal(invalidHelper.code, 'PREVIEW_STORE_BINDING_INVALID');
  record('frontend-helper-invalid-binding-fail-closed', { code: invalidHelper.code });

  const store = { name: '独立预览验证店', type: '验证餐饮', address: '验证路 1 号', phone: '13800000000', notes: '' };
  const draftV1 = {
    storeName: store.name,
    category: store.type,
    businessHours: '09:00-21:00',
    fulfillment: { dineIn: true, takeaway: true },
    dishes: [
      { id: 'dish-a', name: '验证面', priceCents: 2345, description: '第一版' },
      { id: 'dish-b', name: '验证饭', priceCents: 1800, description: '固定对照' },
      { id: 'dish-c', name: '验证汤', priceCents: 1200, description: '固定对照' },
    ],
  };
  const bindingA = `verify:${suffix}:project-a`;
  const bindingB = `verify:${suffix}:project-b`;
  const firstA = await importService.prepareProjectPreview({ bindingKey: bindingA, agentDraft: draftV1, store });
  assert.equal(firstA.status, 'ok', JSON.stringify(firstA));
  createdStoreIds.add(firstA.storeId);
  assert.notEqual(firstA.storeId, 'store-demo-001');
  assert.equal(firstA.replay, false);
  const replayA = await importService.prepareProjectPreview({ bindingKey: bindingA, agentDraft: draftV1, store });
  if (replayA.status === 'ok'
    && replayA.replay === true
    && replayA.importId === firstA.importId
    && JSON.stringify(replayA.backendVersions) === JSON.stringify(firstA.backendVersions)) {
    record('prepare-same-payload-replay-no-version-increase', { first: firstA, replay: replayA });
  } else {
    fail('prepare-same-payload-replay-no-version-increase', { expected: { status: 'ok', replay: true, backendVersions: firstA.backendVersions, importId: firstA.importId }, actual: replayA });
  }

  const firstB = await importService.prepareProjectPreview({ bindingKey: bindingB, agentDraft: draftV1, store });
  assert.equal(firstB.status, 'ok', JSON.stringify(firstB));
  createdStoreIds.add(firstB.storeId);
  assert.notEqual(firstB.storeId, firstA.storeId);
  record('different-binding-isolated-store', { projectA: firstA.storeId, projectB: firstB.storeId });

  const draftV2 = {
    ...draftV1,
    dishes: draftV1.dishes.map((dish, index) => index === 0
      ? { ...dish, priceCents: 3456, description: '第二版只改 A' }
      : dish),
  };
  const secondA = await importService.prepareProjectPreview({ bindingKey: bindingA, agentDraft: draftV2, store });
  assert.equal(secondA.status, 'ok', JSON.stringify(secondA));
  assert.equal(secondA.storeId, firstA.storeId);
  assert.ok(secondA.backendVersions.storeConfigVersion > firstA.backendVersions.storeConfigVersion);
  assert.ok(secondA.backendVersions.catalogVersion > firstA.backendVersions.catalogVersion);
  const replaySecondA = await importService.prepareProjectPreview({ bindingKey: bindingA, agentDraft: draftV2, store });
  if (replaySecondA.status !== 'ok'
    || replaySecondA.replay !== true
    || JSON.stringify(replaySecondA.backendVersions) !== JSON.stringify(secondA.backendVersions)) {
    fail('prepare-updated-payload-replay-no-version-increase', {
      expected: { status: 'ok', replay: true, backendVersions: secondA.backendVersions },
      actual: replaySecondA,
    });
  }
  const [productsA, productsB] = await Promise.all([
    prisma.product.findMany({ where: { storeId: firstA.storeId }, select: { name: true, priceCents: true, description: true } }),
    prisma.product.findMany({ where: { storeId: firstB.storeId }, select: { name: true, priceCents: true, description: true } }),
  ]);
  const productFacts = (rows) => Object.fromEntries(rows.map((row) => [row.name, {
    priceCents: row.priceCents,
    description: row.description,
  }]));
  const expectedA = {
    验证面: { priceCents: 3456, description: '第二版只改 A' },
    验证饭: { priceCents: 1800, description: '固定对照' },
    验证汤: { priceCents: 1200, description: '固定对照' },
  };
  const expectedB = {
    验证面: { priceCents: 2345, description: '第一版' },
    验证饭: { priceCents: 1800, description: '固定对照' },
    验证汤: { priceCents: 1200, description: '固定对照' },
  };
  const actualA = productFacts(productsA);
  const actualB = productFacts(productsB);
  const updateEvidence = {
    before: firstA.backendVersions,
    after: secondA.backendVersions,
    replay: replaySecondA.backendVersions || replaySecondA,
    productsA,
    productsB,
  };
  if (JSON.stringify(actualA) === JSON.stringify(expectedA) && JSON.stringify(actualB) === JSON.stringify(expectedB)) {
    record('new-payload-updates-only-current-binding', updateEvidence);
  } else {
    fail('new-payload-updates-only-current-binding', { ...updateEvidence, expectedA, actualA, expectedB, actualB });
  }

  const demo = await login('demo-owner-001');
  createdUserIds.delete(demo.user.id);
  const ensuredAfterImport = await http('/merchant/preview-stores', { method: 'POST', token: demo.token, body: { bindingKey: bindingA } });
  assert.equal(ensuredAfterImport.status, 201);
  assert.equal(ensuredAfterImport.data.created, false);
  assert.equal(ensuredAfterImport.data.configVersion, secondA.backendVersions.storeConfigVersion);
  assert.equal(ensuredAfterImport.data.catalogVersion, secondA.backendVersions.catalogVersion);
  record('ensure-repeat-does-not-overwrite-imported-versions', { response: ensuredAfterImport.data });
} catch (error) {
  result.error = { message: error?.message || String(error), stack: error?.stack || null };
  console.error(`PROBE_FAILURE ${error?.stack || error}`);
  process.exitCode = 1;
} finally {
  try {
    if (createdStoreIds.size) {
      const deleted = await prisma.store.deleteMany({ where: { id: { in: [...createdStoreIds] } } });
      result.cleanup = { stores: deleted.count, users: 0 };
    }
    if (createdUserIds.size) {
      const deletedUsers = await prisma.user.deleteMany({ where: { id: { in: [...createdUserIds] } } });
      result.cleanup = { ...(result.cleanup || { stores: 0 }), users: deletedUsers.count };
    }
  } catch (error) {
    result.cleanupError = error?.message || String(error);
    process.exitCode = 1;
  }
  await prisma.$disconnect();
  await stopServer();
  serverLog.end();
  fs.writeFileSync(path.join(HERE, 'server-probe-result.json'), JSON.stringify(result, null, 2) + '\n', 'utf8');
  console.log(`PROBE_RESULT ${process.exitCode ? 'FAIL' : 'PASS'} checks=${result.checks.length} cleanup=${JSON.stringify(result.cleanup)}`);
}