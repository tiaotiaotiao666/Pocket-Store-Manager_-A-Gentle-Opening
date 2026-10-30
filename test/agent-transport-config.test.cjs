const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const projectRoot = join(__dirname, '..');

async function loadModule(path) {
  return import(path);
}

test('C1 默认（未设置环境变量）仍为 mock，超时 12s，标签可辨识', async () => {
  const config = await loadModule('../src/services/agentTurn/agentServiceConfig.js');
  assert.equal(config.AGENT_TRANSPORT, 'mock');
  assert.equal(config.AGENT_ENDPOINT, '/api/v1/agent/turn');
  assert.equal(config.AGENT_TIMEOUT_MS, 12000);
  assert.equal(config.AGENT_CONTRACT_VERSION, 'agent-turn.v1');
  assert.deepEqual(config.describeAgentTransport(), {
    mode: 'mock',
    label: '本地 Mock（未接入真实模型）',
  });
});

test('C2 resolveAgentTransportConfig 支持 http 覆盖与 endpoint/timeout 覆盖', async () => {
  const config = await loadModule('../src/services/agentTurn/agentServiceConfig.js');

  const http = config.resolveAgentTransportConfig({ transport: 'http' });
  assert.equal(http.mode, 'http');
  assert.equal(http.endpoint, '/api/v1/agent/turn');
  assert.equal(http.timeoutMs, 30000);
  assert.equal(http.label, 'DeepSeek 后端（真实模型）');

  const custom = config.resolveAgentTransportConfig({
    transport: 'http',
    endpoint: 'http://127.0.0.1:3000/api/v1/agent/turn',
    timeoutMs: 45000,
  });
  assert.equal(custom.endpoint, 'http://127.0.0.1:3000/api/v1/agent/turn');
  assert.equal(custom.timeoutMs, 45000);

  // 非法模式回落 mock；非法超时回落该模式默认值。
  assert.equal(config.resolveAgentTransportConfig({ transport: 'grpc' }).mode, 'mock');
  assert.equal(config.resolveAgentTransportConfig({ transport: 'http', timeoutMs: 10 }).timeoutMs, 30000);
});

test('C3 真正设置 VITE_AGENT_TRANSPORT=http 时模块级配置切换为 http', () => {
  const script = [
    "import('./src/services/agentTurn/agentServiceConfig.js')",
    ".then((m) => console.log(JSON.stringify({",
    'mode: m.AGENT_TRANSPORT,',
    'timeout: m.AGENT_TIMEOUT_MS,',
    'endpoint: m.AGENT_ENDPOINT,',
    'label: m.describeAgentTransport().label,',
    '})))',
  ].join('');
  const output = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', script],
    {
      cwd: projectRoot,
      env: { ...process.env, VITE_AGENT_TRANSPORT: 'http', VITE_AGENT_TIMEOUT_MS: '28000' },
      encoding: 'utf8',
    },
  ).trim();

  const parsed = JSON.parse(output);
  assert.equal(parsed.mode, 'http');
  assert.equal(parsed.timeout, 28000);
  assert.equal(parsed.endpoint, '/api/v1/agent/turn');
  assert.equal(parsed.label, 'DeepSeek 后端（真实模型）');
});

test('C4 前端 HTTP transport 默认不携带 Authorization（绝不携带 DeepSeek Key）', async () => {
  const http = await loadModule('../src/services/agentTurn/httpAgentTransport.js');
  const draft = {
    storeName: '',
    category: '',
    businessHours: '',
    fulfillment: { dineIn: false, takeaway: false },
    dishes: [],
  };
  let capturedHeaders = null;
  const transport = http.createHttpTransport({
    fetchImpl: async (url, init) => {
      capturedHeaders = init.headers;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          contractVersion: 'agent-turn.v1',
          turnId: 'turn-http-9',
          status: 'collecting',
          reply: '已记录。',
          draft,
          missingFields: [{ field: 'storeName', label: '店名', detail: '例如：松月食堂' }],
          errors: [],
          nextQuestion: { field: 'storeName', label: '店名', text: '这家店叫什么名字？' },
          meta: { transport: 'http', provider: 'deepseek', mock: false, model: 'deepseek-chat', latencyMs: 12 },
        }),
      };
    },
  });

  const response = await transport.send({
    contractVersion: 'agent-turn.v1',
    utterance: '你好',
    draft,
    client: { surface: 'desktop', phase: 'store-info' },
    projectId: null,
  });

  assert.equal(capturedHeaders.Authorization, undefined);
  assert.equal(capturedHeaders['X-Agent-Contract'], 'agent-turn.v1');
  assert.equal(response.meta.provider, 'deepseek');
  assert.equal(response.meta.mock, false);
  assert.equal(JSON.stringify(capturedHeaders).toLowerCase().includes('deepseek_api_key'), false);
});

test('C5 service 在 http 配置下创建 createHttpTransport，不写死 mock', () => {
  const source = readFileSync(join(projectRoot, 'src/services/agentTurn/agentTurnService.js'), 'utf8');
  assert.equal(source.includes("AGENT_TRANSPORT === 'http'"), true);
  assert.equal(source.includes('createHttpTransport'), true);
  assert.equal(source.includes('AGENT_TRANSPORT === \'mock\''), true);
  // 前端不得出现任何读取 DeepSeek Key 的代码。
  assert.equal(source.toLowerCase().includes('deepseek_api_key'), false);
});