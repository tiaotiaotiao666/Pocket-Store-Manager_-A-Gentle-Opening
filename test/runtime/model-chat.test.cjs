'use strict';

/**
 * E0-R1：modelChat / requestChat 对等（X8）+ maxTokens 预算契约。
 *
 * 契约：rev15 §14.7 ——
 * - `requestChat` 返回体必须有 `finishReason` 与 `truncated`（既有字段不变）；
 *   空正文 + `finish_reason=length` 必须是 truncated，**不得**当“无响应”；
 * - direct 源码编辑 `maxTokens` 默认 6000、硬上限 8000，**禁止**回退 1200，超限明确报错；
 * - `settings:model:chat`（modelChat）同样带这两个字段。
 *
 * 全部用 fake fetch 捕获真实请求体（A34 的“请求体断言”），真实上游调用 0 次。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const credentialsMod = require(path.join(ROOT, 'desktop', 'model-credentials.cjs'));
const { createModelCredentials, normalizeChatPayload, resolveMaxTokens, DIRECT_EDIT_MAX_TOKENS, CHAT_MAX_TOKENS } = credentialsMod;
const { createModelIpc, normalizeChatResult } = require(path.join(ROOT, 'desktop', 'model-ipc.cjs'));
const { createModelChat, normalizeCompletion } = require(path.join(ROOT, 'desktop', 'agent-runtime'));

const API_KEY = 'sk-test-0123456789abcdef';
const BASE_URL = 'https://api.deepseek.com';

/**
 * 跨进程令牌目录：**全文件只建一次**并在最后清理。
 * 原因：`model-credentials` 的调度器是模块级单例，令牌目录一旦被删，
 * 后续实例会拿到 ENOTDIR/ENOENT（真实语义就是「令牌目录不可用」）。
 * 每个用例前重置单例，保证互不影响。
 */
const TOKEN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-runtime-slots-'));

test.after(() => {
  try {
    credentialsMod.resetSharedModelCallScheduler();
  } catch (error) {
    /* 清理失败不掩盖断言结果 */
  }
  fs.rmSync(TOKEN_DIR, { recursive: true, force: true });
});

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from('enc:' + Buffer.from(text, 'utf8').toString('base64'), 'utf8'),
    decryptString: (buffer) => {
      const raw = buffer.toString('utf8');
      if (!raw.startsWith('enc:')) throw new Error('not encrypted');
      return Buffer.from(raw.slice(4), 'base64').toString('utf8');
    },
  };
}

/** fake 上游：记录请求体，按脚本返回（默认 finish_reason=stop）。 */
function makeUpstream(script) {
  const bodies = [];
  let index = 0;
  return {
    bodies,
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      const step = (script && script[index]) || {};
      index += 1;
      const status = Number.isInteger(step.status) ? step.status : 200;
      const payload = step.payload === undefined
        ? {
          model: 'deepseek-flash',
          choices: [{ message: { content: 'pong' }, finish_reason: step.finishReason === undefined ? 'stop' : step.finishReason }],
        }
        : step.payload;
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => payload,
      };
    },
  };
}

async function makeCredentials(upstream) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-runtime-model-'));
  // 每个用例一个干净的调度器单例，但共用同一个真实令牌目录（进程内 3 槽语义不变）。
  credentialsMod.resetSharedModelCallScheduler();
  const credentials = createModelCredentials({
    userDataDir: dir,
    safeStorage: fakeSafeStorage(),
    fetchImpl: upstream.fetchImpl,
    env: { MODEL_UPSTREAM_TOKEN_DIR: TOKEN_DIR },
  });
  await credentials.setKey(API_KEY);
  return { credentials, dir };
}

const MESSAGES = [{ role: 'user', content: 'ping' }];

/* ------------------------- 1. finishReason / truncated ------------------------- */

test('requestChat 返回 finishReason 与 truncated（既有字段不变）', async () => {
  const upstream = makeUpstream([{ finishReason: 'stop' }]);
  const { credentials, dir } = await makeCredentials(upstream);
  try {
    const result = await credentials.chat({ baseUrl: BASE_URL, model: 'deepseek-flash', messages: MESSAGES });
    assert.equal(result.finishReason, 'stop');
    assert.equal(result.truncated, false);
    // 既有字段保持原位，不因新增字段而改名
    assert.equal(result.content, 'pong');
    assert.equal(result.model, 'deepseek-flash');
    assert.deepEqual(result.toolCalls, []);
    assert.ok('usage' in result);
  } finally {
    credentials?.schedulerStats && credentials.schedulerStats();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('空正文 + finish_reason=length → truncated=true（不得当“无响应”）', async () => {
  const upstream = makeUpstream([{ payload: { model: 'deepseek-flash', choices: [{ message: { content: '' }, finish_reason: 'length' }] } }]);
  const { credentials, dir } = await makeCredentials(upstream);
  try {
    const result = await credentials.chat({ baseUrl: BASE_URL, model: 'deepseek-flash', messages: MESSAGES });
    assert.equal(result.content, '');
    assert.equal(result.finishReason, 'length');
    assert.equal(result.truncated, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('finish_reason=tool_calls 原样回传，且 truncated=false', async () => {
  const upstream = makeUpstream([{
    payload: {
      model: 'deepseek-flash',
      choices: [{
        message: { content: '', tool_calls: [{ id: 'c1', function: { name: 'get_context', arguments: '{}' } }] },
        finish_reason: 'tool_calls',
      }],
    },
  }]);
  const { credentials, dir } = await makeCredentials(upstream);
  try {
    const result = await credentials.chat({ baseUrl: BASE_URL, model: 'deepseek-flash', messages: MESSAGES, tools: [{ type: 'function', function: { name: 'get_context', description: 'x', parameters: { type: 'object', properties: {} } } }] });
    assert.equal(result.finishReason, 'tool_calls');
    assert.equal(result.truncated, false);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].name, 'get_context');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('上游完全没给 finish_reason → 字段仍存在，并标记 finishReasonMissing', () => {
  const normalized = normalizeCompletion({ content: 'x', toolCalls: [] });
  assert.equal(normalized.finishReason, '');
  assert.equal(normalized.truncated, false);
  assert.equal(normalized.finishReasonMissing, true);
  // modelChat 层同样保留字段
  const chat = createModelChat({ chat: async () => ({ content: 'x', finishReason: undefined }) });
  return chat.chat({ messages: MESSAGES }).then((result) => {
    assert.equal(result.finishReason, '');
    assert.equal(result.finishReasonMissing, true);
    assert.equal(result.truncated, false);
  });
});

/* ------------------------------ 2. maxTokens ------------------------------ */

test('工具循环：assistant 只带 tool_calls 时 content 允许 null（真实上游回包可回填）', () => {
  const normalized = normalizeChatPayload({
    messages: [
      { role: 'user', content: '读页面' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call-1',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"pages/menu/index.wxml"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call-1', content: '{"ok":true}' },
    ],
  });
  assert.strictEqual(normalized.body.messages[1].content, null);
  assert.strictEqual(normalized.body.messages[1].tool_calls[0].function.name, 'read_file');
});

test('maxTokens：direct-edit 默认 6000、上限 8000，绝不出现 1200', () => {
  assert.deepEqual(DIRECT_EDIT_MAX_TOKENS, { default: 6000, max: 8000 });
  assert.deepEqual(CHAT_MAX_TOKENS, { default: 1200, max: 4096 });

  // 省略 → 6000
  assert.equal(normalizeChatPayload({ profile: 'direct-edit', messages: MESSAGES }).body.max_tokens, 6000);
  // 显式 8000 允许；8001 明确报错
  assert.equal(normalizeChatPayload({ profile: 'direct-edit', messages: MESSAGES, maxTokens: 8000 }).body.max_tokens, 8000);
  assert.throws(
    () => normalizeChatPayload({ profile: 'direct-edit', messages: MESSAGES, maxTokens: 8001 }),
    (error) => error.code === 'MODEL_REQUEST_INVALID' && /8000/.test(error.message),
  );
  // 显式 1200（旧回退值）→ 抬到 6000 并标记，绝不静默用 1200
  const raised = normalizeChatPayload({ profile: 'direct-edit', messages: MESSAGES, maxTokens: 1200 });
  assert.equal(raised.body.max_tokens, 6000);
  assert.equal(raised.maxTokensRaised, true);
});

test('maxTokens 非法值一律显式报错（不再静默回退 1200）', () => {
  for (const bad of ['abc', 0, -5, 1.5, Number.NaN, {}, []]) {
    assert.throws(
      () => normalizeChatPayload({ profile: 'direct-edit', messages: MESSAGES, maxTokens: bad }),
      (error) => error.code === 'MODEL_REQUEST_INVALID',
      'direct-edit 应拒绝 maxTokens=' + JSON.stringify(bad),
    );
    assert.throws(
      () => normalizeChatPayload({ messages: MESSAGES, maxTokens: bad }),
      (error) => error.code === 'MODEL_REQUEST_INVALID',
      'chat 应拒绝 maxTokens=' + JSON.stringify(bad),
    );
  }
  // 普通对话：省略仍是 1200（显式默认，不是“非法回退”），上限 4096
  assert.equal(normalizeChatPayload({ messages: MESSAGES }).body.max_tokens, 1200);
  assert.throws(
    () => normalizeChatPayload({ messages: MESSAGES, maxTokens: 4097 }),
    (error) => error.code === 'MODEL_REQUEST_INVALID',
  );
  // resolveMaxTokens 直读
  assert.equal(resolveMaxTokens({ profile: 'direct-edit' }).maxTokens, 6000);
  assert.equal(resolveMaxTokens({ profile: 'direct-edit', maxTokens: 6000 }).raised, false);
});

test('请求体断言：direct-edit 走 6000，普通对话走 1200（fake 上游捕获）', async () => {
  const upstream = makeUpstream([{}, {}]);
  const { credentials, dir } = await makeCredentials(upstream);
  try {
    await credentials.chat({ baseUrl: BASE_URL, model: 'deepseek-flash', messages: MESSAGES, profile: 'direct-edit' });
    await credentials.chat({ baseUrl: BASE_URL, model: 'deepseek-flash', messages: MESSAGES });
    assert.equal(upstream.bodies[0].max_tokens, 6000);
    assert.equal(upstream.bodies[1].max_tokens, 1200);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* --------------------------- 3. modelChat 对等 --------------------------- */

test('settings:model:chat（modelChat）返回体带 finishReason 与 truncated', async () => {
  const upstream = makeUpstream([{ finishReason: 'length', payload: { model: 'deepseek-flash', choices: [{ message: { content: '' }, finish_reason: 'length' }] } }]);
  const { credentials, dir } = await makeCredentials(upstream);
  try {
    const ipc = createModelIpc({ credentials, settings: { loadConfig: async () => ({ config: {} }) } });
    const response = await ipc.handlers['settings:model:chat'](null, {
      baseUrl: BASE_URL,
      model: 'deepseek-flash',
      messages: MESSAGES,
      profile: 'direct-edit',
    });
    assert.equal(response.ok, true);
    assert.equal(response.data.finishReason, 'length');
    assert.equal(response.data.truncated, true);
    assert.equal(response.data.profile, 'direct-edit');
    assert.equal(upstream.bodies[0].max_tokens, 6000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('modelChat 归一层：缺字段也不丢 finishReason/truncated', () => {
  const normalized = normalizeChatResult({ content: 'x', finishReason: 'length' });
  assert.equal(normalized.finishReason, 'length');
  assert.equal(normalized.truncated, true);
  const fallback = normalizeChatResult({ content: 'x' });
  assert.equal(fallback.finishReason, '');
  assert.equal(fallback.truncated, false);
});

test('modelChat 包装 model-credentials：一次 chat 只产生一次上游请求（并发仍由调度器管）', async () => {
  const upstream = makeUpstream([{}]);
  const { credentials, dir } = await makeCredentials(upstream);
  try {
    const chat = createModelChat({ credentials });
    const result = await chat.chat({ baseUrl: BASE_URL, model: 'deepseek-flash', messages: MESSAGES, profile: 'direct-edit' });
    assert.equal(result.finishReason, 'stop');
    assert.equal(upstream.bodies.length, 1);
    assert.equal(result.maxTokens, 6000);
    assert.equal(result.profile, 'direct-edit');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
