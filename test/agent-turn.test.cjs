const test = require('node:test');
const assert = require('node:assert/strict');

const CONTRACT = 'agent-turn.v1';

function emptyContractDraft() {
  return {
    storeName: '',
    category: '',
    businessHours: '',
    fulfillment: { dineIn: false, takeaway: false },
    dishes: [],
  };
}

function validResponse(overrides = {}) {
  return {
    contractVersion: CONTRACT,
    turnId: 'turn-http-1',
    status: 'collecting',
    reply: '已记录。',
    draft: {
      ...emptyContractDraft(),
      storeName: '松月食堂',
    },
    missingFields: [{ field: 'category', label: '品类', detail: '例如：社区餐馆' }],
    errors: [],
    nextQuestion: { field: 'category', label: '品类', text: '主要做什么品类？' },
    meta: {
      transport: 'http',
      provider: 'future-provider',
      mock: false,
      model: 'future-model',
      latencyMs: 12,
    },
    ...overrides,
  };
}

function responseStub(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

async function loadModule(path) {
  return import(path);
}

test('T17 传输配置固定为 mock，并给出可辨识的未接入文案', async () => {
  const config = await loadModule('../src/services/agentTurn/agentServiceConfig.js');
  assert.equal(config.AGENT_TRANSPORT, 'mock');
  assert.equal(config.AGENT_ENDPOINT, '/api/v1/agent/turn');
  assert.equal(config.AGENT_TIMEOUT_MS, 12000);
  assert.equal(config.AGENT_CONTRACT_VERSION, CONTRACT);
  assert.deepEqual(config.describeAgentTransport(), {
    mode: 'mock',
    label: '本地 Mock（未接入真实模型）',
  });
});

test('T17b AgentTurnError 可辨识、可序列化且不含敏感字段', async () => {
  const errors = await loadModule('../src/services/agentTurn/agentTurnError.js');
  const error = errors.createAgentTurnError('AGENT_MOCK_FAILURE');
  assert.equal(error.name, 'AgentTurnError');
  assert.equal(error.code, 'AGENT_MOCK_FAILURE');
  assert.equal(error.retryable, true);
  assert.equal(errors.isAgentTurnError(error), true);
  assert.equal(errors.isAgentTurnError(new Error('plain')), false);

  const serialized = JSON.stringify(error).toLowerCase();
  for (const forbidden of ['stack', 'token', 'secret', 'password', 'authorization']) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }

  assert.equal(errors.normalizeAgentTurnError(new TypeError('network down')).code, 'AGENT_NETWORK');
  const aborted = new Error('aborted');
  aborted.name = 'AbortError';
  assert.equal(errors.normalizeAgentTurnError(aborted).code, 'AGENT_ABORTED');
  assert.equal(errors.normalizeAgentTurnError(new Error('boom')).retryable, true);
});

test('T1 Mock 从一段完整描述解析出店名、品类、营业时间、取餐方式与菜品', async () => {
  const mock = await loadModule('../src/services/agentTurn/mockAgentTransport.js');
  const draft = await loadModule('../src/domain/agentDraft.mjs');
  const parsed = mock.parseMockUtterance(
    '店名叫松月食堂，做社区家常菜，每天 10:00-21:00，堂食和自取都做。招牌是宫保鸡丁 28 元、番茄炒蛋 16 元、米饭 3 元。',
    {},
  );
  assert.equal(parsed.draft.storeName, '松月食堂');
  assert.equal(parsed.draft.category, '社区餐馆');
  assert.equal(parsed.draft.businessHours, '10:00-21:00');
  assert.deepEqual(parsed.draft.fulfillment, { dineIn: true, takeaway: true });
  assert.deepEqual(
    parsed.draft.dishes.map((dish) => [dish.name, dish.priceCents]),
    [['宫保鸡丁', 2800], ['番茄炒蛋', 1600], ['米饭', 300]],
  );
  assert.equal(draft.validateAgentDraft(parsed.draft).readyForReview, true);

  const transport = mock.createMockTransport();
  const response = await transport.send({
    contractVersion: CONTRACT,
    utterance: '店名叫松月食堂，做社区家常菜，每天 10:00-21:00，堂食和自取都做。招牌是宫保鸡丁 28 元、番茄炒蛋 16 元、米饭 3 元。',
    draft: draft.toContractDraft(parsed.draft),
  });
  assert.equal(response.status, 'reviewing');
  assert.equal(response.meta.mock, true);
});

test('T2 Mock 不会为只有菜名、没有价格的描述臆造价格', async () => {
  const mock = await loadModule('../src/services/agentTurn/mockAgentTransport.js');
  const parsed = mock.parseMockUtterance('招牌是宫保鸡丁、番茄炒蛋', {});
  assert.equal(parsed.draft.dishes.length, 0);
  assert.equal(parsed.recognized.includes('dishes'), false);
});

test('T3 Mock 纯时间句只更新营业时间，不产生菜品或店名', async () => {
  const mock = await loadModule('../src/services/agentTurn/mockAgentTransport.js');
  const parsed = mock.parseMockUtterance('每天 10:00-21:00', {});
  assert.equal(parsed.draft.businessHours, '10:00-21:00');
  assert.equal(parsed.draft.dishes.length, 0);
  assert.equal(parsed.draft.storeName, '');
});

test('T4 Mock 超过 5 道只保留前 5 道，同名菜保留第一次价格', async () => {
  const mock = await loadModule('../src/services/agentTurn/mockAgentTransport.js');
  const parsed = mock.parseMockUtterance(
    '招牌是甲 1 元、乙 2 元、丙 3 元、丁 4 元、戊 5 元、己 6 元、甲 9 元',
    {},
  );
  assert.equal(parsed.draft.dishes.length, 5);
  assert.equal(parsed.draft.dishes[0].name, '甲');
  assert.equal(parsed.draft.dishes[0].priceCents, 100);
  assert.equal(parsed.notes.extraDishes, true);
});

test('T5 Mock 元信息固定可辨识：mock=true、provider=local-mock、model=null', async () => {
  const mock = await loadModule('../src/services/agentTurn/mockAgentTransport.js');
  const transport = mock.createMockTransport();
  const response = await transport.send({
    contractVersion: CONTRACT,
    utterance: '店名叫松月食堂',
    draft: emptyContractDraft(),
  });
  assert.deepEqual(response.meta, {
    transport: 'mock',
    provider: 'local-mock',
    mock: true,
    model: null,
    latencyMs: 0,
  });
  assert.equal(response.turnId.startsWith('turn-mock-'), true);
});

test('T6 simulateFailureOnce 抛出 AGENT_MOCK_FAILURE 且可重试', async () => {
  const serviceModule = await loadModule('../src/services/agentTurn/agentTurnService.js');
  const service = serviceModule.createAgentTurnService();
  await assert.rejects(
    service.requestAgentTurn({ utterance: '店名叫松月食堂', draft: {}, simulateFailureOnce: true }),
    (error) => error.code === 'AGENT_MOCK_FAILURE' && error.retryable === true,
  );
});

test('T7 一次性失败开关在请求结束后复位，第二次请求成功', async () => {
  const serviceModule = await loadModule('../src/services/agentTurn/agentTurnService.js');
  const service = serviceModule.createAgentTurnService();
  await assert.rejects(
    service.requestAgentTurn({ utterance: '店名叫松月食堂', draft: {}, simulateFailureOnce: true }),
    (error) => error.code === 'AGENT_MOCK_FAILURE',
  );
  const result = await service.requestAgentTurn({ utterance: '店名叫松月食堂', draft: {} });
  assert.equal(result.draft.storeName, '松月食堂');
  assert.equal(result.meta.mock, true);
});

test('T8 HTTP transport 按契约发送绝对 URL、method、headers 与请求体', async () => {
  const http = await loadModule('../src/services/agentTurn/httpAgentTransport.js');
  let captured = null;
  const transport = http.createHttpTransport({
    endpoint: '/api/v1/agent/turn',
    timeoutMs: 500,
    getAuthorization: () => 'Bearer local-test-token',
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return responseStub(validResponse());
    },
  });
  const request = {
    contractVersion: CONTRACT,
    utterance: '店名叫松月食堂',
    draft: emptyContractDraft(),
    client: { surface: 'desktop', phase: 'store-info' },
    projectId: null,
  };
  await transport.send(request);
  assert.equal(captured.url, 'http://127.0.0.1:3000/api/v1/agent/turn');
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers['Content-Type'], 'application/json; charset=utf-8');
  assert.equal(captured.init.headers.Accept, 'application/json');
  assert.equal(captured.init.headers['X-Agent-Contract'], CONTRACT);
  assert.equal(captured.init.headers.Authorization, 'Bearer local-test-token');
  const body = JSON.parse(captured.init.body);
  assert.equal(body.contractVersion, CONTRACT);
  assert.equal(body.projectId, null);
  assert.deepEqual(body.draft, emptyContractDraft());
});

test('T8b HTTP transport 不重复拼接已经是绝对地址的 endpoint', async () => {
  const http = await loadModule('../src/services/agentTurn/httpAgentTransport.js');
  const endpoint = 'https://agent.example.com/api/v1/agent/turn';
  let capturedUrl = null;
  const transport = http.createHttpTransport({
    endpoint,
    fetchImpl: async (url) => {
      capturedUrl = url;
      return responseStub(validResponse());
    },
  });

  await transport.send({
    contractVersion: CONTRACT,
    utterance: '店名叫松月食堂',
    draft: emptyContractDraft(),
  });
  assert.equal(capturedUrl, endpoint);
});

test('T9 HTTP transport 返回合法响应并只调用一次 fetch', async () => {
  const http = await loadModule('../src/services/agentTurn/httpAgentTransport.js');
  let calls = 0;
  const body = validResponse();
  const transport = http.createHttpTransport({
    fetchImpl: async () => {
      calls += 1;
      return responseStub(body);
    },
  });
  const result = await transport.send({
    contractVersion: CONTRACT,
    utterance: 'x',
    draft: emptyContractDraft(),
  });
  assert.deepEqual(result, body);
  assert.equal(calls, 1);
});

test('T10 HTTP 超时归一化为 AGENT_TIMEOUT 且可重试', async () => {
  const http = await loadModule('../src/services/agentTurn/httpAgentTransport.js');
  const transport = http.createHttpTransport({
    timeoutMs: 10,
    fetchImpl: (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    }),
  });
  await assert.rejects(
    transport.send({ contractVersion: CONTRACT, utterance: 'x', draft: emptyContractDraft() }),
    (error) => error.code === 'AGENT_TIMEOUT' && error.retryable === true,
  );
});

test('T11 HTTP 422 归一化为 AGENT_HTTP_4XX，保留 serverCode 与 requestId', async () => {
  const http = await loadModule('../src/services/agentTurn/httpAgentTransport.js');
  const transport = http.createHttpTransport({
    fetchImpl: async () => responseStub(
      { code: 'VALIDATION_ERROR', message: 'bad', requestId: 'req-1' },
      422,
    ),
  });
  await assert.rejects(
    transport.send({ contractVersion: CONTRACT, utterance: 'x', draft: emptyContractDraft() }),
    (error) => error.code === 'AGENT_HTTP_4XX'
      && error.retryable === false
      && error.httpStatus === 422
      && error.serverCode === 'VALIDATION_ERROR'
      && error.requestId === 'req-1',
  );
});

test('T12 HTTP 429 归一化为 AGENT_RATE_LIMITED 且可重试', async () => {
  const http = await loadModule('../src/services/agentTurn/httpAgentTransport.js');
  const transport = http.createHttpTransport({
    fetchImpl: async () => responseStub({ code: 'RATE_LIMITED' }, 429),
  });
  await assert.rejects(
    transport.send({ contractVersion: CONTRACT, utterance: 'x', draft: emptyContractDraft() }),
    (error) => error.code === 'AGENT_RATE_LIMITED' && error.retryable === true,
  );
});

test('T13 HTTP 503 归一化为 AGENT_HTTP_5XX 且可重试', async () => {
  const http = await loadModule('../src/services/agentTurn/httpAgentTransport.js');
  const transport = http.createHttpTransport({
    fetchImpl: async () => responseStub('service unavailable', 503),
  });
  await assert.rejects(
    transport.send({ contractVersion: CONTRACT, utterance: 'x', draft: emptyContractDraft() }),
    (error) => error.code === 'AGENT_HTTP_5XX' && error.retryable === true,
  );
});

test('T14 HTTP 非 JSON 响应归一化为 AGENT_RESPONSE_INVALID', async () => {
  const http = await loadModule('../src/services/agentTurn/httpAgentTransport.js');
  const transport = http.createHttpTransport({
    fetchImpl: async () => responseStub('<html>not json</html>', 200),
  });
  await assert.rejects(
    transport.send({ contractVersion: CONTRACT, utterance: 'x', draft: emptyContractDraft() }),
    (error) => error.code === 'AGENT_RESPONSE_INVALID' && error.retryable === false,
  );
});

test('T15 HTTP 响应缺 draft 或 meta 归一化为 AGENT_RESPONSE_INVALID', async () => {
  const http = await loadModule('../src/services/agentTurn/httpAgentTransport.js');
  for (const broken of [
    validResponse({ draft: undefined }),
    validResponse({ meta: undefined }),
    validResponse({ status: 'confirmed' }),
    validResponse({ draft: { ...emptyContractDraft(), dishes: new Array(6).fill({ id: 'dish-1', name: '菜', priceCents: 100, description: '' }) } }),
  ]) {
    const transport = http.createHttpTransport({ fetchImpl: async () => responseStub(broken) });
    await assert.rejects(
      transport.send({ contractVersion: CONTRACT, utterance: 'x', draft: emptyContractDraft() }),
      (error) => error.code === 'AGENT_RESPONSE_INVALID',
      JSON.stringify(broken.status),
    );
  }
});

test('T16 HTTP 契约版本不匹配归一化为 AGENT_CONTRACT_MISMATCH', async () => {
  const http = await loadModule('../src/services/agentTurn/httpAgentTransport.js');
  const transport = http.createHttpTransport({
    fetchImpl: async () => responseStub(validResponse({ contractVersion: 'agent-turn.v0' })),
  });
  await assert.rejects(
    transport.send({ contractVersion: CONTRACT, utterance: 'x', draft: emptyContractDraft() }),
    (error) => error.code === 'AGENT_CONTRACT_MISMATCH' && error.retryable === false,
  );
});

test('T18 service 不信任服务端 status：草稿缺营业时间时返回 collecting', async () => {
  const serviceModule = await loadModule('../src/services/agentTurn/agentTurnService.js');
  const transport = {
    name: 'stub',
    async send() {
      return {
        contractVersion: CONTRACT,
        turnId: 'turn-stub-1',
        status: 'reviewing',
        reply: '服务端认为可以确认',
        draft: {
          storeName: '松月食堂',
          category: '社区餐馆',
          businessHours: '',
          fulfillment: { dineIn: true, takeaway: false },
          dishes: [
            { id: 'dish-1', name: '宫保鸡丁', priceCents: 2800, description: '' },
            { id: 'dish-2', name: '番茄炒蛋', priceCents: 1600, description: '' },
            { id: 'dish-3', name: '米饭', priceCents: 300, description: '' },
          ],
        },
        missingFields: [],
        errors: [],
        nextQuestion: null,
        meta: { transport: 'stub', provider: 'test', mock: true, model: null, latencyMs: 0 },
      };
    },
  };
  const service = serviceModule.createAgentTurnService({ transport });
  const result = await service.requestAgentTurn({ utterance: '随便说一句', draft: {} });
  assert.equal(result.status, 'collecting');
  assert.equal(result.validation.readyForReview, false);
  assert.equal(result.nextQuestion.field, 'businessHours');
});

test('T19 service 拒绝空 utterance 与超过 500 字的输入', async () => {
  const serviceModule = await loadModule('../src/services/agentTurn/agentTurnService.js');
  const service = serviceModule.createAgentTurnService();
  await assert.rejects(
    service.requestAgentTurn({ utterance: '   ', draft: {} }),
    (error) => error.code === 'AGENT_REQUEST_INVALID' && error.retryable === false,
  );
  await assert.rejects(
    service.requestAgentTurn({ utterance: '店'.repeat(501), draft: {} }),
    (error) => error.code === 'AGENT_REQUEST_INVALID',
  );
});

test('T20 service 将未知异常归一化为 AgentTurnError', async () => {
  const serviceModule = await loadModule('../src/services/agentTurn/agentTurnService.js');
  const transport = {
    name: 'stub',
    async send() {
      throw new Error('unexpected');
    },
  };
  const service = serviceModule.createAgentTurnService({ transport });
  await assert.rejects(
    service.requestAgentTurn({ utterance: '店名叫松月食堂', draft: {} }),
    (error) => error.name === 'AgentTurnError'
      && error.code === 'AGENT_NETWORK'
      && error.retryable === true
      && JSON.stringify(error).includes('stack') === false,
  );
});