const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const AGENT_SERVICE_DIR = path.join(ROOT, 'src', 'services', 'agentTurn');
const MAIN_TS = path.join(ROOT, 'server', 'src', 'main.ts');

function readAllowedHeaders() {
  const source = fs.readFileSync(MAIN_TS, 'utf8');
  const match = /allowedHeaders:\s*\[([\s\S]*?)\]/.exec(source);
  assert.ok(match, 'server/src/main.ts 必须声明 allowedHeaders 数组');
  return match[1]
    .split(',')
    .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

function collectFrontendCustomHeaders() {
  const headers = new Set();
  const files = fs.readdirSync(AGENT_SERVICE_DIR).filter((name) => name.endsWith('.js'));
  for (const name of files) {
    const source = fs.readFileSync(path.join(AGENT_SERVICE_DIR, name), 'utf8');
    for (const match of source.matchAll(/'((?:X|x)-[A-Za-z0-9-]+)'\s*:/g)) {
      headers.add(match[1]);
    }
    for (const match of source.matchAll(/headers\['([^']+)'\]/g)) {
      if (/^[Xx]-/.test(match[1])) headers.add(match[1]);
    }
  }
  assert.ok(headers.size > 0, '前端 Agent transport 应至少使用一个 X- 自定义请求头');
  return headers;
}

test('后端 CORS allowedHeaders 覆盖前端 Agent 请求使用的全部自定义头', () => {
  const allowed = new Set(readAllowedHeaders().map((name) => name.toLowerCase()));
  const used = collectFrontendCustomHeaders();

  const missing = [...used].filter((name) => !allowed.has(name.toLowerCase()));
  assert.deepEqual(
    missing,
    [],
    `CORS 预检会拦截缺失的请求头，浏览器表现为 TypeError → AGENT_NETWORK。缺失：${missing.join(', ')}`,
  );
});