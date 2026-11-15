'use strict';

/**
 * W0 / P0-1：后端就绪判定的行为测试。
 *
 * 验收口径：ready === /api/v1/readyz HTTP 200 && body.database === 'ok'。
 * 这里用真实 HTTP 服务（node:http）跑判定，不用 mock 断言字符串。
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const modulePath = path.join(REPO, 'scripts', 'backend-readiness.cjs');
const readiness = require(modulePath);

/** 起一个只回指定 status/body 的临时服务。 */
async function startServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

function jsonHandler(status, body) {
  return (request, response) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
}

test('database=ok 且 HTTP 200 才算就绪，并如实带出 cache=memory 降级标识', async () => {
  const server = await startServer(jsonHandler(200, { status: 'ok', database: 'ok', cache: 'memory' }));
  try {
    const result = await readiness.waitForReadiness({ port: server.port });
    assert.strictEqual(result.ready, true);
    assert.strictEqual(result.httpStatus, 200);
    assert.strictEqual(result.database, 'ok');
    assert.strictEqual(result.cache, 'memory');
    assert.strictEqual(result.cacheDegraded, true, 'cache=memory 必须被标记为降级');
    assert.strictEqual(result.attempts, 1);
  } finally {
    await server.stop();
  }
});

test('readyz 200 但 database 不是 ok → 判定为未就绪（端口正常不等于数据库可用）', async () => {
  const server = await startServer(jsonHandler(200, { status: 'degraded', database: 'down', cache: 'memory' }));
  try {
    const result = await readiness.waitForReadiness({ port: server.port });
    assert.strictEqual(result.ready, false);
    assert.strictEqual(result.code, readiness.READINESS_CODES.DATABASE_NOT_READY);
    assert.strictEqual(result.database, 'down');
    assert.match(result.message, /database=down/);
  } finally {
    await server.stop();
  }
});

test('readyz 返回非 200 → BACKEND_HTTP_ERROR，并保留状态码', async () => {
  const server = await startServer(jsonHandler(503, { status: 'error', database: 'ok' }));
  try {
    const result = await readiness.waitForReadiness({ port: server.port });
    assert.strictEqual(result.ready, false);
    assert.strictEqual(result.code, readiness.READINESS_CODES.BACKEND_HTTP_ERROR);
    assert.strictEqual(result.httpStatus, 503);
  } finally {
    await server.stop();
  }
});

test('端口没有监听 → BACKEND_UNREACHABLE，且不抛异常', async () => {
  const server = await startServer(jsonHandler(200, { database: 'ok' }));
  const port = server.port;
  await server.stop();
  const result = await readiness.waitForReadiness({ port, timeoutMs: 800 });
  assert.strictEqual(result.ready, false);
  assert.strictEqual(result.code, readiness.READINESS_CODES.BACKEND_UNREACHABLE);
  assert.strictEqual(result.httpStatus, null);
  assert.ok(result.message.length > 0);
});

test('非 JSON 响应 → BACKEND_BAD_RESPONSE，不把 HTML 错误页当成正常', async () => {
  const server = await startServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<html>proxy error</html>');
  });
  try {
    const result = await readiness.waitForReadiness({ port: server.port });
    assert.strictEqual(result.ready, false);
    assert.strictEqual(result.code, readiness.READINESS_CODES.BACKEND_BAD_RESPONSE);
  } finally {
    await server.stop();
  }
});

test('waitForReadiness 会轮询到真正就绪（先在预热、后转 ok）', async () => {
  let calls = 0;
  const server = await startServer((request, response) => {
    calls += 1;
    const ready = calls >= 3;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ database: ready ? 'ok' : 'connecting', cache: 'memory' }));
  });
  try {
    const result = await readiness.waitForReadiness({ port: server.port, waitSeconds: 5, intervalMs: 60 });
    assert.strictEqual(result.ready, true);
    assert.ok(result.attempts >= 3, `应至少探测 3 次，实际 ${result.attempts}`);
  } finally {
    await server.stop();
  }
});

test('waitSeconds=0 只探测一次，不会因为等待而变成通过', async () => {
  const server = await startServer(jsonHandler(200, { database: 'connecting' }));
  try {
    const result = await readiness.waitForReadiness({ port: server.port, waitSeconds: 0 });
    assert.strictEqual(result.ready, false);
    assert.strictEqual(result.attempts, 1);
  } finally {
    await server.stop();
  }
});

test('参数解析对越界值做钳制，未知参数返回错误而不是静默忽略', () => {
  const parsed = readiness.parseArgs(['--port', '70000', '--wait-seconds', '-5', '--timeout-ms', '10']);
  assert.strictEqual(parsed.options.port, 65535);
  assert.strictEqual(parsed.options.waitSeconds, 0);
  assert.strictEqual(parsed.options.timeoutMs, 200);
  const bad = readiness.parseArgs(['--nope']);
  assert.match(bad.error, /未知参数/);
});

test('CLI：就绪时退出码 0、未就绪时退出码 1，stdout 始终是单行可解析 JSON', async () => {
  const server = await startServer(jsonHandler(200, { database: 'ok', cache: 'memory' }));
  const runCli = (port) => new Promise((resolve) => {
    const child = spawn(process.execPath, [modulePath, '--port', String(port), '--timeout-ms', '1500'], {
      cwd: REPO,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.on('close', (code) => resolve({ code, stdout }));
  });

  try {
    const okRun = await runCli(server.port);
    assert.strictEqual(okRun.code, 0);
    const okBody = JSON.parse(okRun.stdout.trim());
    assert.strictEqual(okBody.ready, true);
    assert.strictEqual(okBody.database, 'ok');
  } finally {
    await server.stop();
  }

  const closedPort = await startServer(jsonHandler(200, { database: 'ok' }));
  const closed = closedPort.port;
  await closedPort.stop();
  const failRun = await runCli(closed);
  assert.strictEqual(failRun.code, 1);
  const failBody = JSON.parse(failRun.stdout.trim());
  assert.strictEqual(failBody.ready, false);
  assert.strictEqual(failBody.code, 'BACKEND_UNREACHABLE');
});
