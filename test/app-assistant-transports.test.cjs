const test = require('node:test');
const assert = require('node:assert/strict');

const { createInitialState } = require('../src/state/sessionMachine.mjs');
const { validateAppAssistantResponse } = require('../src/domain/appAssistantProposal.mjs');

const CONTRACT = 'app-assistant.v1';

async function load(modulePath) {
  return import(modulePath);
}

function requestPayload(overrides = {}) {
  return {
    contractVersion: CONTRACT,
    requestId: 'chat_req_transport_1',
    catalogVersion: 'app-capabilities.v1',
    contextRevision: 0,
    utterance: '店名改为松月食堂',
    history: [],
    client: { surface: 'desktop', phase: 'home' },
    project: { projectId: null, context: { capabilitiesVersion: 'app-capabilities.v1', fields: { 'store.dishes': [] } } },
    attachments: [],
    ...overrides,
  };
}

async function buildRequest(overrides = {}) {
  const { buildAppAssistantRequest } = await load('../src/services/appAssistant/appAssistantRequest.mjs');
  return buildAppAssistantRequest({
    utterance: '店名改为松月食堂',
    state: createInitialState(),
    requestId: 'chat_req_transport_1',
    ...overrides,
  });
}

function okJson(payload) {
  return async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(payload),
  });
}

function abortableFetch(onRequest) {
  return (url, init) => new Promise((resolve, reject) => {
    const fail = () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    };
    if (init.signal && init.signal.aborted) {
      fail();
      return;
    }
    if (init.signal && typeof init.signal.addEventListener === 'function') {
      init.signal.addEventListener('abort', fail, { once: true });
    }
    if (typeof onRequest === 'function') onRequest(url, init);
  });
}

function validBody(request, overrides = {}) {
  return {
    contractVersion: CONTRACT,
    requestId: request.requestId,
    runId: 'run_transport_1',
    catalogVersion: 'app-capabilities.v1',
    contextRevision: request.contextRevision,
    status: 'proposal',
    reply: '已整理这些资料，请核对。',
    proposalId: 'proposal_transport_1',
    changes: [{
      opId: 'op_1',
      op: 'field.set',
      fieldId: 'store.name',
      value: '松月食堂',
      evidence: { source: 'utterance', excerpt: '店名改为松月食堂' },
    }],
    questions: [],
    actionRequests: [],
    trace: { modelCalls: 1, toolCalls: [], stopReason: 'final_answer', degraded: false },
    meta: { transport: 'http', provider: 'deepseek', mock: false, model: 'deepseek-chat', latencyMs: 5, runId: 'run_transport_1' },
    ...overrides,
  };
}

function expectCode(code) {
  return (error) => {
    assert.equal(error.code, code, `期望错误码 ${code}，实际 ${error.code}：${error.message}`);
    return true;
  };
}

test('H1 HTTP 请求地址、头、请求体与 Authorization 注入', async () => {
  const { createHttpAppAssistantTransport } = await load('../src/services/appAssistant/httpAppAssistantTransport.js');
  const request = await buildRequest();
  let captured = null;
  const transport = createHttpAppAssistantTransport({
    endpoint: 'http://127.0.0.1:3000/api/v1/agent/app-assistant',
    timeoutMs: 5000,
    getAuthorization: async () => 'Bearer test-token',
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(validBody(request)),
      };
    },
  });

  const body = await transport.send(request);

  assert.equal(captured.url, 'http://127.0.0.1:3000/api/v1/agent/app-assistant');
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers['X-Agent-Request-Id'], 'chat_req_transport_1');
  assert.equal(captured.init.headers['X-Agent-Contract'], CONTRACT);
  assert.equal(captured.init.headers.Authorization, 'Bearer test-token');
  assert.equal(captured.init.headers['Content-Type'], 'application/json; charset=utf-8');
  assert.deepEqual(JSON.parse(captured.init.body), request);
  assert.equal(body.contractVersion, CONTRACT);
});

test('H2 未注入 Authorization 时请求头不携带 Authorization', async () => {
  const { createHttpAppAssistantTransport } = await load('../src/services/appAssistant/httpAppAssistantTransport.js');
  const request = await buildRequest();
  let headers = null;
  const transport = createHttpAppAssistantTransport({
    endpoint: 'http://127.0.0.1:3000/api/v1/agent/app-assistant',
    fetchImpl: async (url, init) => {
      headers = init.headers;
      return { ok: true, status: 200, text: async () => JSON.stringify(validBody(request)) };
    },
  });

  await transport.send(request);
  assert.equal(Object.prototype.hasOwnProperty.call(headers, 'Authorization'), false);
});

test('H3 超时 → AGENT_TIMEOUT；外部取消 → AGENT_ABORTED', async () => {
  const { createHttpAppAssistantTransport } = await load('../src/services/appAssistant/httpAppAssistantTransport.js');
  const request = await buildRequest();

  const slow = createHttpAppAssistantTransport({
    endpoint: 'http://127.0.0.1:3000/api/v1/agent/app-assistant',
    timeoutMs: 1000,
    fetchImpl: abortableFetch(),
  });
  await assert.rejects(slow.send(request), expectCode('AGENT_TIMEOUT'));

  const controller = new AbortController();
  const cancellable = createHttpAppAssistantTransport({
    endpoint: 'http://127.0.0.1:3000/api/v1/agent/app-assistant',
    timeoutMs: 5000,
    fetchImpl: abortableFetch(),
  });
  const pending = cancellable.send(request, { signal: controller.signal });
  setImmediate(() => controller.abort());
  await assert.rejects(pending, expectCode('AGENT_ABORTED'));
});

test('H4 非 2xx 映射：500 → AGENT_HTTP_5XX，429 → AGENT_RATE_LIMITED', async () => {
  const { createHttpAppAssistantTransport } = await load('../src/services/appAssistant/httpAppAssistantTransport.js');
  const request = await buildRequest();

  const serverError = createHttpAppAssistantTransport({
    endpoint: 'http://127.0.0.1:3000/api/v1/agent/app-assistant',
    fetchImpl: async () => ({
      ok: false,
      status: 500,
      text: async () => JSON.stringify({ code: 'INTERNAL', message: 'boom' }),
    }),
  });
  await assert.rejects(serverError.send(request), expectCode('AGENT_HTTP_5XX'));

  const limited = createHttpAppAssistantTransport({
    endpoint: 'http://127.0.0.1:3000/api/v1/agent/app-assistant',
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      text: async () => JSON.stringify({ code: 'RATE_LIMIT' }),
    }),
  });
  await assert.rejects(limited.send(request), expectCode('AGENT_RATE_LIMITED'));
});

test('H5 非 JSON / 契约版本不符 → APP_ASSISTANT_RESPONSE_INVALID / APP_ASSISTANT_CONTRACT_MISMATCH', async () => {
  const { createHttpAppAssistantTransport } = await load('../src/services/appAssistant/httpAppAssistantTransport.js');
  const request = await buildRequest();

  const notJson = createHttpAppAssistantTransport({
    endpoint: 'http://127.0.0.1:3000/api/v1/agent/app-assistant',
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<html>502</html>' }),
  });
  await assert.rejects(notJson.send(request), expectCode('APP_ASSISTANT_RESPONSE_INVALID'));

  const wrongContract = createHttpAppAssistantTransport({
    endpoint: 'http://127.0.0.1:3000/api/v1/agent/app-assistant',
    fetchImpl: okJson(validBody(request, { contractVersion: 'app-assistant.v2' })),
  });
  await assert.rejects(wrongContract.send(request), expectCode('APP_ASSISTANT_CONTRACT_MISMATCH'));
});

test('H6 HTTP 失败时不在错误对象或控制台泄露 Authorization', async () => {
  const { createHttpAppAssistantTransport } = await load('../src/services/appAssistant/httpAppAssistantTransport.js');
  const request = await buildRequest();
  const logs = [];
  const originals = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  console.log = (...args) => logs.push(args.join(' '));
  console.warn = (...args) => logs.push(args.join(' '));
  console.error = (...args) => logs.push(args.join(' '));
  console.info = (...args) => logs.push(args.join(' '));

  const transport = createHttpAppAssistantTransport({
    endpoint: 'http://127.0.0.1:3000/api/v1/agent/app-assistant',
    getAuthorization: async () => 'Bearer sk-secret-value',
    fetchImpl: async () => ({
      ok: false,
      status: 500,
      text: async () => JSON.stringify({ code: 'INTERNAL' }),
    }),
  });

  try {
    await assert.rejects(transport.send(request), (error) => {
      assert.equal(error.code, 'AGENT_HTTP_5XX');
      const serialized = JSON.stringify(error.toJSON ? error.toJSON() : { message: error.message });
      assert.equal(serialized.includes('sk-secret-value'), false);
      return true;
    });
    assert.equal(logs.join('\n').includes('sk-secret-value'), false);
  } finally {
    Object.assign(console, originals);
  }
});

test('D1 direct 无主进程桥 → AGENT_TRANSPORT_UNKNOWN', async () => {
  const { createDirectAppAssistantTransport } = await load('../src/services/appAssistant/directAppAssistantTransport.js');
  const transport = createDirectAppAssistantTransport();
  await assert.rejects(transport.send(requestPayload()), expectCode('AGENT_TRANSPORT_UNKNOWN'));
});

test('D2 direct 带图：图片进入最后一条 user 消息，不做静默丢弃', async () => {
  const { createDirectAppAssistantTransport } = await load('../src/services/appAssistant/directAppAssistantTransport.js');
  const request = await buildRequest({
    utterance: '这张是门店环境照',
    attachments: [{
      id: 'att_1',
      kind: 'store',
      mediaType: 'image/png',
      dataBase64: 'AAAA',
      name: 'shop.png',
      bytes: 4,
    }],
  });
  const seen = [];
  const transport = createDirectAppAssistantTransport({
    chat: async (payload) => {
      seen.push(payload);
      return { ok: true, data: { content: '看到门店照片了。', toolCalls: [] } };
    },
    getModel: () => ({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', timeoutMs: 60000 }),
  });

  await transport.send(request);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].thinking, { type: 'disabled' });
  const lastUser = seen[0].messages[seen[0].messages.length - 1];
  assert.equal(lastUser.role, 'user');
  assert.equal(Array.isArray(lastUser.content), true);
  assert.deepEqual(lastUser.content[0], { type: 'text', text: '这张是门店环境照' });
  assert.equal(lastUser.content[1].type, 'image_url');
  assert.equal(lastUser.content[1].image_url.url, 'data:image/png;base64,AAAA');
});

test('D2b direct 带图：非法图片整轮拒绝，不静默少发一张', async () => {
  const { createDirectAppAssistantTransport } = await load('../src/services/appAssistant/directAppAssistantTransport.js');
  const request = await buildRequest({
    utterance: '',
    attachments: [{
      id: 'att_bad',
      kind: 'store',
      mediaType: 'image/gif',
      dataBase64: 'AAAA',
      name: 'x.gif',
      bytes: 4,
    }],
  });
  let called = false;
  const transport = createDirectAppAssistantTransport({
    chat: async () => {
      called = true;
      return { ok: true, data: { content: '不该被调用', toolCalls: [] } };
    },
  });

  await assert.rejects(transport.send(request), (error) => {
    assert.equal(error.code, 'AGENT_REQUEST_INVALID');
    assert.equal(error.details.reason, 'DIRECT_ATTACHMENT_TYPE');
    return true;
  });
  assert.equal(called, false);
});

test('D2c direct 带图 + 不支持看图的模型 → 可执行提示，不发起调用', async () => {
  const { createDirectAppAssistantTransport } = await load('../src/services/appAssistant/directAppAssistantTransport.js');
  const request = await buildRequest({
    utterance: '看看这张店照',
    attachments: [{
      id: 'att_1',
      kind: 'store',
      mediaType: 'image/png',
      dataBase64: 'AAAA',
      name: 'shop.png',
      bytes: 4,
    }],
  });
  let called = false;
  const transport = createDirectAppAssistantTransport({
    chat: async () => {
      called = true;
      return { ok: true, data: { content: '', toolCalls: [] } };
    },
    getModel: () => ({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-pro', timeoutMs: 60000 }),
  });

  await assert.rejects(transport.send(request), (error) => {
    assert.equal(error.code, 'AGENT_REQUEST_INVALID');
    assert.equal(error.details.reason, 'DIRECT_MODEL_NO_VISION');
    assert.match(error.message, /deepseek-flash/);
    return true;
  });
  assert.equal(called, false);
});

test('D3 direct 五工具白名单：未知工具记为失败并如实降级', async () => {
  const { createDirectAppAssistantTransport } = await load('../src/services/appAssistant/directAppAssistantTransport.js');
  let round = 0;
  const transport = createDirectAppAssistantTransport({
    chat: async () => {
      round += 1;
      if (round === 1) {
        return {
          ok: true,
          data: {
            content: '',
            toolCalls: [{ id: 'c1', name: 'delete_project', arguments: '{"projectId":"p1"}' }],
          },
        };
      }
      return { ok: true, data: { content: '这个操作不在我能做的范围内。', toolCalls: [] } };
    },
  });

  const response = await transport.send(requestPayload());
  assert.equal(response.trace.toolCalls.length, 1);
  assert.equal(response.trace.toolCalls[0].ok, false);
  assert.equal(response.trace.toolCalls[0].errorCode, 'UNKNOWN_TOOL');
  assert.equal(response.trace.degraded, true);
  assert.equal(response.status, 'needs-input');
  assert.equal(response.changes.length, 0);
  assert.ok(response.questions.length > 0);

  const checked = validateAppAssistantResponse(response, {
    requestId: response.requestId,
    catalogVersion: response.catalogVersion,
    contextRevision: response.contextRevision,
  });
  assert.equal(checked.ok, true);
});

test('D4 direct 循环检测：重复相同调用被拦截', async () => {
  const { createDirectAppAssistantTransport } = await load('../src/services/appAssistant/directAppAssistantTransport.js');
  const sameArguments = JSON.stringify({
    changes: [{
      op: 'field.set',
      fieldId: 'store.name',
      value: '松月食堂',
      evidence: { source: 'utterance', excerpt: '店名改为松月食堂' },
    }],
  });
  let round = 0;
  const transport = createDirectAppAssistantTransport({
    chat: async () => {
      round += 1;
      if (round >= 4) return { ok: true, data: { content: '先这样，请核对。', toolCalls: [] } };
      return {
        ok: true,
        data: {
          content: '',
          toolCalls: [{ id: 'c1', name: 'propose_project_changes', arguments: sameArguments }],
        },
      };
    },
  });

  const response = await transport.send(requestPayload());
  assert.equal(response.trace.stopReason, 'loop_detected');
  assert.equal(response.trace.degraded, true);
  assert.ok(response.trace.toolCalls.some((item) => item.errorCode === 'DUPLICATE_CALL'));
  assert.equal(response.changes.length, 1);
});

test('D5 direct 工具调用上限 → max_tool_calls', async () => {
  const { createDirectAppAssistantTransport } = await load('../src/services/appAssistant/directAppAssistantTransport.js');
  let counter = 0;
  const transport = createDirectAppAssistantTransport({
    chat: async () => {
      const toolCalls = [0, 1, 2, 3].map(() => {
        counter += 1;
        return {
          id: `c_${counter}`,
          name: 'propose_project_changes',
          arguments: JSON.stringify({
            changes: [{
              op: 'field.set',
              fieldId: 'store.name',
              value: `店名${counter}`,
              evidence: { source: 'utterance', excerpt: '改店名' },
            }],
          }),
        };
      });
      return { ok: true, data: { content: '', toolCalls } };
    },
  });

  const response = await transport.send(requestPayload());
  assert.equal(response.trace.stopReason, 'max_tool_calls');
  assert.equal(response.trace.toolCalls.length, 12);
  assert.equal(response.trace.degraded, true);
});

test('D6 direct 正常两轮：提案 + 回复，meta 标明 direct 非 mock', async () => {
  const { createDirectAppAssistantTransport } = await load('../src/services/appAssistant/directAppAssistantTransport.js');
  let round = 0;
  const transport = createDirectAppAssistantTransport({
    getModel: () => ({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', timeoutMs: 60000 }),
    chat: async () => {
      round += 1;
      if (round === 1) {
        return {
          ok: true,
          data: {
            content: '',
            toolCalls: [{
              id: 'c1',
              name: 'propose_project_changes',
              arguments: JSON.stringify({
                changes: [{
                  op: 'field.set',
                  fieldId: 'store.name',
                  value: '松月食堂',
                  evidence: { source: 'utterance', excerpt: '店名改为松月食堂' },
                }],
              }),
            }],
          },
        };
      }
      return { ok: true, data: { content: '已整理这些资料，请核对。', toolCalls: [] } };
    },
  });

  const response = await transport.send(requestPayload());
  assert.equal(response.status, 'proposal');
  assert.equal(response.changes.length, 1);
  assert.equal(response.changes[0].fieldId, 'store.name');
  assert.equal(response.changes[0].value, '松月食堂');
  assert.equal(response.actionRequests.length, 0);
  assert.equal(response.meta.transport, 'direct');
  assert.equal(response.meta.mock, false);
  assert.equal(response.trace.modelCalls, 2);
  assert.equal(response.trace.stopReason, 'final_answer');

  const checked = validateAppAssistantResponse(response, {
    requestId: response.requestId,
    catalogVersion: response.catalogVersion,
    contextRevision: response.contextRevision,
  });
  assert.equal(checked.ok, true);
});

test('M1 mock 确定性：同输入两次得到同一提案，且价格换算为整数分', async () => {
  const { createMockAppAssistantTransport } = await load('../src/services/appAssistant/mockAppAssistantTransport.js');
  const transport = createMockAppAssistantTransport();
  const request = await buildRequest({ utterance: '店名改为松月食堂，品类是社区餐馆，加牛肉面28元' });

  const first = await transport.send(request);
  const second = await transport.send(request);

  assert.deepEqual(first, second);
  assert.equal(first.status, 'proposal');
  assert.equal(first.meta.mock, true);
  assert.equal(first.changes.length, 3);
  const dish = first.changes.find((item) => item.op === 'dish.upsert');
  assert.equal(dish.name, '牛肉面');
  assert.equal(dish.priceCents, 2800);
  assert.equal(first.changes.find((item) => item.fieldId === 'store.name').value, '松月食堂');
});

test('M2 mock 带图时只追问用途，不伪造 vision 或识别结果', async () => {
  const { createMockAppAssistantTransport } = await load('../src/services/appAssistant/mockAppAssistantTransport.js');
  const transport = createMockAppAssistantTransport();
  const request = await buildRequest({
    utterance: '',
    attachments: [{ id: 'att_2', kind: 'auto', mediaType: 'image/jpeg', dataBase64: 'AAAA', name: 'menu.jpg', bytes: 4 }],
  });

  const response = await transport.send(request);
  assert.equal(response.status, 'needs-input');
  assert.equal(response.changes.length, 0);
  assert.equal(response.questions.length, 1);
  assert.equal(response.trace.degraded, true);
  assert.equal(Object.prototype.hasOwnProperty.call(response, 'vision'), false);
  assert.equal(JSON.stringify(response).includes('analyzed'), false);

  const checked = validateAppAssistantResponse(response, {
    requestId: response.requestId,
    catalogVersion: response.catalogVersion,
    contextRevision: response.contextRevision,
  });
  assert.equal(checked.ok, true);
});