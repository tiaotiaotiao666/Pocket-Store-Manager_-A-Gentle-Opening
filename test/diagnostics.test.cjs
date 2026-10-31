'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const REPO = path.resolve(__dirname, '..');
const { DEFAULT_CONFIG } = require(path.join(REPO, 'desktop', 'settings-store.cjs'));

async function load() {
  const format = await import(pathToFileURL(path.join(REPO, 'src', 'domain', 'diagnosticFormat.mjs')).href);
  const service = await import(pathToFileURL(path.join(REPO, 'src', 'services', 'diagnosticsService.js')).href);
  const settings = await import(pathToFileURL(path.join(REPO, 'src', 'services', 'settingsService.js')).href);
  return { format, service, settings };
}

test('诊断脱敏：敏感键、绝对路径、密钥值全部剔除', async () => {
  const { format } = await load();
  const json = {
    generatedAt: '2026-10-31T09:41:55Z',
    app: { version: '0.2.0' },
    debug: { DEEPSEEK_API_KEY: 'sk-123456', accessToken: 'tok', password: 'p' },
    storage: { projectPath: 'C:\\Users\\leiji\\AppData', unixPath: '/home/user/x' },
    backend: { baseUrl: 'http://127.0.0.1:3000/api/v1', headers: { Authorization: 'Bearer x' } },
    list: [{ openId: 'demo-open-id' }],
  };
  const scrubbed = format.scrubDiagnosticJson(json);
  const text = JSON.stringify(scrubbed);
  assert.strictEqual(scrubbed.debug.DEEPSEEK_API_KEY, '[redacted]');
  assert.strictEqual(scrubbed.debug.accessToken, '[redacted]');
  assert.strictEqual(scrubbed.backend.headers.Authorization, '[redacted]');
  assert.strictEqual(scrubbed.storage.projectPath, '[path]');
  assert.strictEqual(scrubbed.storage.unixPath, '[path]');
  assert.strictEqual(scrubbed.list[0].openId, '[redacted]');
  assert.strictEqual(scrubbed.backend.baseUrl, 'http://127.0.0.1:3000/api/v1');
  assert.ok(!text.includes('sk-123456'));
  assert.ok(!text.includes('C:\\\\Users'));
  assert.ok(!text.includes('Bearer'));
});

test('复制文本包含结论且不包含绝对路径', async () => {
  const { format } = await load();
  const lines = [
    format.createDiagnosticLine({ id: 'runtime', title: '运行环境', result: 'pass', message: '桌面模式' }),
    format.createDiagnosticLine({ id: 'backend', title: '后端服务', result: 'fail', message: '服务未启动', action: '运行 npm run start:dev' }),
  ];
  const text = format.toCopyText(lines, format.scrubDiagnosticJson({ path: 'D:\\secret\\x' }));
  assert.ok(text.includes('运行环境'));
  assert.ok(text.includes('服务未启动'));
  assert.ok(text.includes('已脱敏'));
  assert.ok(!text.includes('D:\\secret'));
});

test('模型通道判定：mock 通过、http 端点非法失败、后端不可达失败', async () => {
  const { service, format } = await load();
  const mock = service.agentLine({ agentTransport: 'mock', agentEndpoint: '/api/v1/agent/turn' }, { reachable: false });
  assert.strictEqual(mock.result, 'pass');

  const badEndpoint = service.agentLine({ agentTransport: 'http', agentEndpoint: 'api/v1/agent/turn' }, { reachable: true });
  assert.strictEqual(badEndpoint.result, 'fail');

  const unreachable = service.agentLine({ agentTransport: 'http', agentEndpoint: '/api/v1/agent/turn' }, { reachable: false });
  assert.strictEqual(unreachable.result, 'fail');

  const ok = service.agentLine({ agentTransport: 'http', agentEndpoint: '/api/v1/agent/turn' }, { reachable: true });
  assert.strictEqual(ok.result, 'pass');
  assert.strictEqual(format.createDiagnosticLine(ok).id, 'agent');
});

test('设置默认值与主进程 config.json 契约一致', async () => {
  const { settings } = await load();
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    assert.ok(Object.prototype.hasOwnProperty.call(settings.DEFAULT_SETTINGS, key), '缺少默认字段 ' + key);
    assert.deepStrictEqual(settings.DEFAULT_SETTINGS[key], DEFAULT_CONFIG[key], '默认值不一致：' + key);
  }
});

test('浏览器模式下自检给出三条 warn 且不访问主进程', async () => {
  const { service } = await load();
  const result = await service.diagnosticsService.run({
    apiBaseUrl: 'http://127.0.0.1:1/api/v1',
    agentTransport: 'mock',
    agentEndpoint: '/api/v1/agent/turn',
  });
  assert.strictEqual(result.status, 'ok');
  assert.strictEqual(result.lines.length, 5);
  assert.deepStrictEqual(result.lines.map((line) => line.id), ['runtime', 'storage', 'composer', 'backend', 'agent']);
  assert.strictEqual(result.lines[0].result, 'warn');
  assert.strictEqual(result.lines[3].result, 'fail');
  assert.ok(result.copyText.includes('已脱敏'));
});