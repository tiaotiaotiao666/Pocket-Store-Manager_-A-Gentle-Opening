'use strict';

/**
 * 「模型与 API」通道回归：设置契约 + Key 加密存储 + 直连 DeepSeek 的 agent-run 外壳。
 *
 * 边界（与仓库既有约束一致）：
 * - Key 只允许存在主进程，落盘必须加密，界面只显示「已保存」；
 * - 只支持 DeepSeek 官方协议（/chat/completions）；
 * - 直连通道返回的仍是 `agent-run.v1` 外壳，交给同一套校验，不另造契约。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const { createSettingsStore, DEFAULT_CONFIG, normalizeConfig } = require(path.join(ROOT, 'desktop', 'settings-store.cjs'));
const { createModelCredentials } = require(path.join(ROOT, 'desktop', 'model-credentials.cjs'));

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from(`enc:${Buffer.from(text, 'utf8').toString('base64')}`, 'utf8'),
    decryptString: (buffer) => {
      const raw = buffer.toString('utf8');
      if (!raw.startsWith('enc:')) throw new Error('not encrypted');
      return Buffer.from(raw.slice(4), 'base64').toString('utf8');
    },
  };
}

function emptyDraft() {
  return {
    storeName: '',
    category: '',
    businessHours: '',
    fulfillment: { dineIn: false, takeaway: false },
    dishes: [],
  };
}

test('设置默认值：直连 DeepSeek，transport 是派生值', () => {
  assert.equal(DEFAULT_CONFIG.modelChannel, 'deepseek');
  assert.equal(DEFAULT_CONFIG.modelApiBaseUrl, 'https://api.deepseek.com');
  assert.equal(DEFAULT_CONFIG.modelName, 'deepseek-chat');
  assert.equal(DEFAULT_CONFIG.modelTimeoutMs, 60000);
  assert.equal(DEFAULT_CONFIG.agentTransport, 'direct');
});

test('旧配置迁移：agentTransport=http 推断为本机服务，直连与本机服务各自派生 transport', () => {
  // 老版本 config.json 没有 modelChannel，只有 agentTransport。
  const legacyInput = { ...DEFAULT_CONFIG, agentTransport: 'http' };
  delete legacyInput.modelChannel;
  const legacy = normalizeConfig(legacyInput);
  assert.equal(legacy.modelChannel, 'server');
  assert.equal(legacy.agentTransport, 'http');

  const direct = normalizeConfig({ ...DEFAULT_CONFIG, modelChannel: 'deepseek' });
  assert.equal(direct.agentTransport, 'direct');

  assert.throws(
    () => normalizeConfig({ ...DEFAULT_CONFIG, agentTransport: 'ftp' }),
    (error) => error.code === 'SETTINGS_INVALID',
  );
});

test('模型字段校验：地址、模型名、超时非法都拒绝', () => {
  assert.throws(() => normalizeConfig({ ...DEFAULT_CONFIG, modelApiBaseUrl: 'ftp://x' }), /MODEL|不通过|未通过/i);
  assert.throws(() => normalizeConfig({ ...DEFAULT_CONFIG, modelName: 'with space' }), /不通过|未通过/i);
  assert.throws(() => normalizeConfig({ ...DEFAULT_CONFIG, modelTimeoutMs: 10 }), /不通过|未通过/i);
  const ok = normalizeConfig({ ...DEFAULT_CONFIG, modelTimeoutMs: 90000 });
  assert.equal(ok.modelTimeoutMs, 90000);
});

test('设置落盘：Key 不在 config.json 里，敏感键仍被拒绝', async () => {
  const dir = makeTempDir('model-channel-settings-');
  const store = createSettingsStore({ userDataDir: dir });
  await store.saveConfig({ ...DEFAULT_CONFIG, modelChannel: 'deepseek' });
  const text = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');
  assert.equal(text.toLowerCase().includes('api_key'), false);
  assert.equal(text.includes('sk-'), false);
  assert.equal(JSON.parse(text).modelChannel, 'deepseek');

  await assert.rejects(
    () => store.saveConfig({ ...DEFAULT_CONFIG, apiKey: 'sk-1234567890abcdef' }),
    (error) => error.code === 'SETTINGS_INVALID',
  );
});

test('Key 加密保存：明文不落盘，状态只回配置情况', async () => {
  const dir = makeTempDir('model-channel-key-');
  const credentials = createModelCredentials({ userDataDir: dir, safeStorage: fakeSafeStorage() });

  assert.deepEqual(await credentials.status(), { configured: false, updatedAt: null });
  await assert.rejects(() => credentials.setKey('short'), (error) => error.code === 'MODEL_KEY_INVALID');

  const saved = await credentials.setKey('sk-test-0123456789abcdef');
  assert.equal(saved.configured, true);
  const raw = fs.readFileSync(path.join(dir, 'model-key.bin'));
  assert.equal(raw.toString('utf8').includes('sk-test'), false, '磁盘上不得出现明文 Key');
  assert.equal((await credentials.status()).configured, true);

  const cleared = await credentials.clearKey();
  assert.equal(cleared.configured, false);
  assert.equal((await credentials.status()).configured, false);
});

test('调用 DeepSeek：地址拼接、鉴权只在主进程、401 映射为可读原因', async () => {
  const dir = makeTempDir('model-channel-chat-');
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        model: 'deepseek-chat',
        choices: [{ message: { content: '整理好了' } }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      }),
    };
  };
  const credentials = createModelCredentials({ userDataDir: dir, safeStorage: fakeSafeStorage(), fetchImpl });
  await credentials.setKey('sk-test-0123456789abcdef');

  const result = await credentials.chat({ messages: [{ role: 'user', content: '你好' }] });
  assert.equal(result.content, '整理好了');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(calls[0].headers.Authorization, 'Bearer sk-test-0123456789abcdef');
  assert.equal(calls[0].body.model, 'deepseek-chat');
  assert.equal(calls[0].body.stream, false);

  const failDir = makeTempDir('model-channel-401-');
  const failing = createModelCredentials({
    userDataDir: failDir,
    safeStorage: fakeSafeStorage(),
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }),
  });
  await failing.setKey('sk-test-0123456789abcdef');
  const failed = await failing.test({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'DEEPSEEK_AUTH_FAILED');
  assert.match(failed.message, /API Key/);
});

test('直连 transport：工具循环 + 同一套 agent-run.v1 外壳', async () => {
  const directUrl = pathToFileURL(path.join(ROOT, 'src', 'services', 'agentTurn', 'directAgentRunTransport.js')).href;
  const contractUrl = pathToFileURL(path.join(ROOT, 'src', 'services', 'agentTurn', 'agentRunTransport.js')).href;
  const { createDirectAgentRunTransport } = await import(directUrl);
  const { validateAgentRunResponse } = await import(contractUrl);

  let call = 0;
  const chat = async () => {
    call += 1;
    if (call === 1) {
      return { ok: true, data: { content: '', toolCalls: [{ id: 'c1', name: 'get_store_draft', arguments: '{}' }] } };
    }
    if (call === 2) {
      return {
        ok: true,
        data: {
          content: '',
          toolCalls: [{
            id: 'c2',
            name: 'update_store_draft',
            arguments: JSON.stringify({
              storeName: '松月食堂',
              category: '社区餐馆',
              businessHours: '10:00-21:00',
              fulfillment: { dineIn: true, takeaway: true },
              dishes: [{ name: '宫保鸡丁', priceCents: 2800 }],
            }),
          }],
        },
      };
    }
    return { ok: true, data: { content: '资料已整理，请检查右侧草稿。', toolCalls: [] } };
  };

  const transport = createDirectAgentRunTransport({
    chat,
    getModel: () => ({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', timeoutMs: 60000 }),
  });
  const response = await transport.send({
    contractVersion: 'agent-run.v1',
    utterance: '店叫松月食堂，社区餐馆，10:00-21:00，堂食和自取，宫保鸡丁 28 元',
    draft: emptyDraft(),
    client: { surface: 'desktop', phase: 'store-info' },
    projectId: null,
  });

  const validated = validateAgentRunResponse(response);
  assert.equal(validated.meta.mock, false);
  assert.equal(validated.trace.degraded, false);
  assert.equal(response.status, 'reviewing');
  assert.equal(response.draft.storeName, '松月食堂');
  assert.equal(response.draft.dishes[0].priceCents, 2800);
  assert.equal(response.trace.toolCalls.length, 2);
  assert.equal(response.trace.toolCalls.every((item) => item.ok === true), true);
  assert.match(response.reply, /草稿/);
});

test('直连 transport：模型不可用时给结构化错误，不伪造成功', async () => {
  const directUrl = pathToFileURL(path.join(ROOT, 'src', 'services', 'agentTurn', 'directAgentRunTransport.js')).href;
  const { createDirectAgentRunTransport } = await import(directUrl);
  const transport = createDirectAgentRunTransport({
    chat: async () => ({ ok: false, code: 'DEEPSEEK_NOT_CONFIGURED', message: '还没有填写 API Key' }),
    getModel: () => ({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', timeoutMs: 60000 }),
  });
  await assert.rejects(
    () => transport.send({
      contractVersion: 'agent-run.v1',
      utterance: '你好',
      draft: emptyDraft(),
      client: { surface: 'desktop', phase: 'store-info' },
      projectId: null,
    }),
    (error) => error.code === 'AGENT_HTTP_5XX' && /API Key/.test(error.message),
  );
});

test('设置页只暴露「模型与 API」，不再出现旧通道术语与临时界面', () => {
  const panel = fs.readFileSync(path.join(ROOT, 'src', 'components', 'settings', 'SettingsPanel.jsx'), 'utf8');
  const sidebar = fs.readFileSync(path.join(ROOT, 'src', 'components', 'layout', 'Sidebar.jsx'), 'utf8');
  const intake = fs.readFileSync(path.join(ROOT, 'src', 'components', 'agent', 'AgentIntakePanel.jsx'), 'utf8');

  for (const token of ['模型与 API', '直连 DeepSeek', 'API Key', '保存密钥', '测试连接', '本机服务']) {
    assert.ok(panel.includes(token), '设置页缺少：' + token);
  }
  for (const token of ['模型通道', '本地 Mock', 'Agent 端点', 'DeepSeek 后端（真实模型）']) {
    assert.equal(panel.includes(token), false, '设置页仍有过期术语：' + token);
  }
  assert.equal(intake.includes('模拟失败'), false, '模拟失败开关必须移除');
  assert.equal(intake.includes('本地 Mock'), false, 'Mock 标签必须移除');
  assert.equal(sidebar.includes('本地 Mock'), false, '侧栏不再展示 Mock 标签');
});
