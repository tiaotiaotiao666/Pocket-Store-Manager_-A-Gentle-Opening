'use strict';

/**
 * 「对话修改当前模板」transport / service 契约测试（plan.md 2.2.8）。
 *
 * 覆盖：
 * 1. 请求体字段与 2.2.8 完全一致（含 planFeatures/basePatch/baseDraft）；
 * 2. 请求侧非法输入 → AGENT_REQUEST_INVALID；
 * 3. 响应缺字段 / 类型错误 → AGENT_RESPONSE_INVALID；
 * 4. 契约版本不一致 → AGENT_CONTRACT_MISMATCH；
 * 5. HTTP 非 2xx 错误码映射（503/504/502/413/422）；
 * 6. 错误文案映射（固定中文 + details 原因）；
 * 7. Mock 标记透传（meta.mock === true）；
 * 8. 服务层前端补丁复核；
 * 9. HTTP transport 的请求地址 / 头部 / 请求体。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

async function loadTransport() {
  return import('../src/services/agentTurn/templateReviseTransport.js');
}

async function loadService() {
  return import('../src/services/agentTurn/templateReviseService.js');
}

async function loadConfig() {
  return import('../src/services/agentTurn/agentServiceConfig.js');
}

const CONTRACT = 'agent-template-revise.v1';

const BASE_DRAFT = {
  storeName: '松月食堂',
  category: '社区餐馆',
  dishes: [
    { id: 'dish-1', name: '红烧肉', description: '慢炖两小时', priceCents: 3800 },
    { id: 'dish-2', name: '清炒时蔬', description: '当日现炒', priceCents: 1800 },
  ],
};

const BASE_PATCH = Object.freeze({ theme: Object.freeze({ primaryColor: '#6D5EFC' }) });

const PLAN_FEATURES = Object.freeze([
  Object.freeze({ featureId: 'poster-carousel', pageId: 'home', slotId: 'home-hero' }),
]);

function baseInput(overrides = {}) {
  return {
    utterance: '把主色改成暖橙色，首屏再大一点',
    candidate: { templateId: 'warm-bistro', layout: 'menu' },
    planFeatures: PLAN_FEATURES.map((item) => ({ ...item })),
    basePatch: JSON.parse(JSON.stringify(BASE_PATCH)),
    baseDraft: JSON.parse(JSON.stringify(BASE_DRAFT)),
    requestId: 'req-test-1',
    ...overrides,
  };
}

function validResponse(overrides = {}) {
  return {
    contractVersion: CONTRACT,
    turnId: 'turn-1',
    reply: '已更新 2 项展示。',
    patch: { theme: { primaryColor: '#E07A3F' } },
    changes: [
      { path: 'theme.primaryColor', label: '主色', before: '#6D5EFC', after: '#E07A3F' },
    ],
    meta: { transport: 'http', provider: 'deepseek', mock: false, model: 'deepseek-chat', latencyMs: 120 },
    ...overrides,
  };
}

test('R1 请求体字段与 2.2.8 完全一致：contractVersion/utterance/candidate/planFeatures/basePatch/baseDraft/client/projectId', async () => {
  const { buildTemplateReviseRequest } = await loadTransport();
  const request = buildTemplateReviseRequest(baseInput());

  assert.deepEqual(request, {
    contractVersion: CONTRACT,
    utterance: '把主色改成暖橙色，首屏再大一点',
    candidate: { templateId: 'warm-bistro', layout: 'menu' },
    planFeatures: [{ featureId: 'poster-carousel', pageId: 'home', slotId: 'home-hero' }],
    basePatch: { theme: { primaryColor: '#6D5EFC' } },
    baseDraft: BASE_DRAFT,
    client: { surface: 'desktop', phase: 'template-pick' },
    projectId: null,
  });

  // requestId 是前端单飞标识，绝不能混进契约请求体（2.2.8 无该字段）。
  assert.equal('requestId' in request, false);
  assert.deepEqual(Object.keys(request), [
    'contractVersion',
    'utterance',
    'candidate',
    'planFeatures',
    'basePatch',
    'baseDraft',
    'client',
    'projectId',
  ]);
});

test('R2 请求侧非法输入统一报 AGENT_REQUEST_INVALID（空描述 / 超长 / 未知模板 / 插槽错配 / 超量）', async () => {
  const { buildTemplateReviseRequest } = await loadTransport();

  const cases = [
    { input: baseInput({ utterance: '   ' }), path: 'utterance' },
    { input: baseInput({ utterance: '想'.repeat(501) }), path: 'utterance' },
    { input: baseInput({ candidate: { templateId: 'ghost-template', layout: 'menu' } }), path: 'candidate.templateId' },
    { input: baseInput({ candidate: { templateId: 'warm-bistro', layout: 'editorial' } }), path: 'candidate.layout' },
    {
      input: baseInput({ planFeatures: [{ featureId: 'poster-carousel', pageId: 'menu', slotId: 'home-hero' }] }),
      path: 'planFeatures[0].pageId',
    },
    {
      input: baseInput({ planFeatures: [{ featureId: 'unknown-feature', pageId: 'home', slotId: 'home-hero' }] }),
      path: 'planFeatures[0].featureId',
    },
    {
      input: baseInput({ images: [{ kind: 'menu', mediaType: 'image/jpeg', data: 'abc' }] }),
      path: 'images[0].kind',
    },
  ];

  for (const item of cases) {
    assert.throws(
      () => buildTemplateReviseRequest(item.input),
      (error) => {
        assert.equal(error.code, 'AGENT_REQUEST_INVALID');
        assert.equal(error.details?.[0]?.path, item.path, `路径应为 ${item.path}`);
        return true;
      },
    );
  }

  const tooManyFeatures = {
    planFeatures: [
      { featureId: 'poster-carousel', pageId: 'home', slotId: 'home-hero' },
      { featureId: 'poster-carousel', pageId: 'menu', slotId: 'menu-hero' },
      { featureId: 'poster-carousel', pageId: 'menu', slotId: 'menu-aside' },
      { featureId: 'poster-carousel', pageId: 'home', slotId: 'home-marketing' },
    ],
  };
  assert.throws(
    () => buildTemplateReviseRequest(baseInput(tooManyFeatures)),
    (error) => error.code === 'AGENT_REQUEST_INVALID',
  );
});

test('R3 响应缺字段与类型错误：缺 turnId / 缺 changes / meta.mock 非布尔 / before 类型错误 → AGENT_RESPONSE_INVALID', async () => {
  const { validateTemplateReviseResponse } = await loadTransport();

  const invalidBodies = [
    (() => { const body = validResponse(); delete body.turnId; return body; })(),
    (() => { const body = validResponse(); delete body.changes; return body; })(),
    validResponse({ meta: { transport: 'http', provider: 'deepseek', mock: 'false', model: null, latencyMs: 1 } }),
    validResponse({ changes: [{ path: 'theme.primaryColor', label: '主色', before: 123, after: '#FFFFFF' }] }),
    validResponse({ changes: [{ path: 'theme.primaryColor', label: '主色', before: null, after: 42 }] }),
    validResponse({ changes: [{ path: 'theme.primaryColor', before: null, after: '#FFFFFF' }] }),
    validResponse({ reply: '' }),
    validResponse({ patch: null }),
    validResponse({ meta: null }),
  ];

  for (const body of invalidBodies) {
    assert.throws(
      () => validateTemplateReviseResponse(body),
      (error) => error.code === 'AGENT_RESPONSE_INVALID',
    );
  }

  // 合法响应原样返回
  const ok = validResponse();
  assert.equal(validateTemplateReviseResponse(ok), ok);
});

test('R4 契约版本不一致 → AGENT_CONTRACT_MISMATCH，而不是响应字段错误', async () => {
  const { validateTemplateReviseResponse } = await loadTransport();
  assert.throws(
    () => validateTemplateReviseResponse(validResponse({ contractVersion: 'agent-template-revise.v0' })),
    (error) => error.code === 'AGENT_CONTRACT_MISMATCH',
  );
});

test('R5 HTTP 非 2xx 映射：503/504/502/413/422 都能保住服务端错误码', async () => {
  const { mapTemplateReviseHttpError } = await loadTransport();

  const configured = mapTemplateReviseHttpError(503, { code: 'DEEPSEEK_NOT_CONFIGURED', message: '未配置 Key', requestId: 'srv-1' });
  assert.equal(configured.code, 'DEEPSEEK_NOT_CONFIGURED');
  assert.equal(configured.httpStatus, 503);
  assert.equal(configured.serverCode, 'DEEPSEEK_NOT_CONFIGURED');
  assert.equal(configured.requestId, 'srv-1');

  assert.equal(mapTemplateReviseHttpError(504, { code: 'DEEPSEEK_TIMEOUT' }).code, 'DEEPSEEK_TIMEOUT');
  assert.equal(mapTemplateReviseHttpError(502, { code: 'DEEPSEEK_RESPONSE_INVALID' }).code, 'DEEPSEEK_RESPONSE_INVALID');
  assert.equal(mapTemplateReviseHttpError(422, { code: 'PRESENTATION_PATCH_INVALID' }).code, 'PRESENTATION_PATCH_INVALID');
  assert.equal(mapTemplateReviseHttpError(422, { code: 'PATCH_THEME_COLOR_INVALID' }).code, 'PATCH_THEME_COLOR_INVALID');

  const tooLarge = mapTemplateReviseHttpError(413, null);
  assert.equal(tooLarge.code, 'AGENT_BODY_TOO_LARGE');
  assert.equal(tooLarge.httpStatus, 413);

  // 未知 4xx 兜底
  assert.equal(mapTemplateReviseHttpError(400, { code: 'SOMETHING_NEW' }).code, 'AGENT_HTTP_4XX');
});

test('R6 错误码映射为固定中文文案，并把 details 的可读原因拼进去', async () => {
  const { mapTemplateReviseError } = await loadService();
  const { createAgentTurnError } = await import('../src/services/agentTurn/agentTurnError.js');

  const notConfigured = mapTemplateReviseError(createAgentTurnError('DEEPSEEK_NOT_CONFIGURED'));
  assert.equal(notConfigured.message, '模型未配置，请检查服务端。');

  const timeout = mapTemplateReviseError(createAgentTurnError('DEEPSEEK_TIMEOUT'));
  assert.equal(timeout.message, '模型超时，请重试。');

  const invalidResponse = mapTemplateReviseError(createAgentTurnError('DEEPSEEK_RESPONSE_INVALID'));
  assert.equal(invalidResponse.message, '模型返回无法解析，已保留上一版。');

  const patchInvalid = mapTemplateReviseError(createAgentTurnError('PRESENTATION_PATCH_INVALID', {
    details: [{ path: 'theme.primaryColor', code: 'PATCH_THEME_COLOR_INVALID', message: '颜色必须形如 #RRGGBB。' }],
  }));
  assert.equal(patchInvalid.code, 'PRESENTATION_PATCH_INVALID');
  assert.match(patchInvalid.message, /已保留上一版/);
  assert.match(patchInvalid.message, /颜色必须形如 #RRGGBB/);

  // 未知错误码保留原 message，不吞掉后端新增提示
  const unknown = mapTemplateReviseError(createAgentTurnError('BRAND_NEW_CODE', { message: '后端新增提示' }));
  assert.equal(unknown.code, 'BRAND_NEW_CODE');
  assert.equal(unknown.message, '后端新增提示');
});

test('R7 Mock 模式：meta.mock 透传为 true，补丁经校验且能算出可见 changes', async () => {
  const { createTemplateReviseMockTransport } = await loadTransport();
  const { requestTemplateRevise } = await loadService();

  const result = await requestTemplateRevise(baseInput({ requestId: 'mock-req-1' }), {
    transport: createTemplateReviseMockTransport({ delayMs: 0 }),
  });

  assert.equal(result.meta.mock, true);
  assert.equal(result.meta.transport, 'mock');
  assert.equal(result.requestId, 'mock-req-1');
  assert.equal(result.templateId, 'warm-bistro');
  assert.ok(result.patch.theme, 'Mock 应产出主题补丁');
  assert.ok(result.changes.length > 0, 'Mock 应产出可见变更');
  assert.ok(result.changes.some((item) => item.path === 'theme.primaryColor'));
  assert.equal(result.changes[0].label.length > 0, true);
  assert.equal(typeof result.reply, 'string');
  assert.ok(result.reply.length > 0);
});

test('R8 服务层成功路径：前端复核补丁、归一化颜色、透传 changes 与 requestId', async () => {
  const { requestTemplateRevise } = await loadService();

  const captured = { request: null, context: null };
  const transport = {
    name: 'stub',
    async send(request, context) {
      captured.request = request;
      captured.context = context;
      return validResponse({
        patch: { theme: { primaryColor: '#e07a3f' }, copy: { storeName: '松月小馆' } },
        changes: [
          { path: 'theme.primaryColor', label: '主色', before: '#6D5EFC', after: '#e07a3f' },
          { path: 'copy.storeName', label: '店名', before: '松月食堂', after: '松月小馆' },
        ],
      });
    },
  };

  const result = await requestTemplateRevise(baseInput({ requestId: 'req-ok-9' }), { transport });

  assert.equal(captured.context.requestId, 'req-ok-9');
  assert.equal(captured.request.contractVersion, CONTRACT);
  assert.equal(result.requestId, 'req-ok-9');
  assert.equal(result.turnId, 'turn-1');
  assert.equal(result.patch.theme.primaryColor, '#E07A3F', '写入 state 前颜色应统一大写');
  assert.equal(result.changes.length, 2);
  assert.ok(Array.isArray(result.appliedChanges));
  assert.ok(result.appliedChanges.some((item) => item.path === 'theme.primaryColor'));
});

test('R9 服务层前端复核：服务端返回非法补丁（theme.primaryColor=red）→ AGENT_RESPONSE_INVALID，不返回成功结果', async () => {
  const { requestTemplateRevise } = await loadService();

  const transport = {
    name: 'stub',
    async send() {
      return validResponse({
        patch: { theme: { primaryColor: 'red' } },
        changes: [{ path: 'theme.primaryColor', label: '主色', before: null, after: 'red' }],
      });
    },
  };

  await assert.rejects(
    () => requestTemplateRevise(baseInput(), { transport }),
    (error) => {
      assert.equal(error.code, 'AGENT_RESPONSE_INVALID');
      assert.match(error.message, /已保留上一版/);
      return true;
    },
  );
});

test('R10 服务层错误映射：transport 抛超时 / 网络错误 → 中文文案 + 稳定 code', async () => {
  const { requestTemplateRevise } = await loadService();
  const { createAgentTurnError } = await import('../src/services/agentTurn/agentTurnError.js');

  await assert.rejects(
    () => requestTemplateRevise(baseInput(), {
      transport: { name: 'stub', async send() { throw createAgentTurnError('AGENT_TIMEOUT'); } },
    }),
    (error) => {
      assert.equal(error.code, 'AGENT_TIMEOUT');
      assert.equal(error.message, '请求超时，请重试。');
      return true;
    },
  );

  await assert.rejects(
    () => requestTemplateRevise(baseInput(), {
      transport: { name: 'stub', async send() { throw new TypeError('fetch failed'); } },
    }),
    (error) => {
      assert.equal(error.code, 'AGENT_NETWORK');
      assert.equal(error.message, '网络不可用，请检查后重试。');
      return true;
    },
  );
});

test('R11 HTTP transport：POST 到模板修改端点，带上契约头与 requestId 头，请求体字段完整', async () => {
  const { createTemplateReviseHttpTransport } = await loadTransport();

  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify(validResponse());
      },
    };
  };

  const transport = createTemplateReviseHttpTransport({
    fetchImpl,
    baseUrl: 'http://127.0.0.1:3000/api/v1',
    endpoint: '/api/v1/agent/template-revise',
    timeoutMs: 5000,
  });

  const request = (await loadTransport()).buildTemplateReviseRequest(baseInput());
  const response = await transport.send(request, { requestId: 'req-http-1' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:3000/api/v1/agent/template-revise');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['X-Agent-Contract'], CONTRACT);
  assert.equal(calls[0].init.headers['X-Agent-Request-Id'], 'req-http-1');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json; charset=utf-8');
  assert.deepEqual(JSON.parse(calls[0].init.body), request);
  assert.equal(response.meta.mock, false);
});

test('R12 HTTP transport：422 + 补丁错误码直接抛业务错误，2xx 非法 JSON 报 AGENT_RESPONSE_INVALID', async () => {
  const { createTemplateReviseHttpTransport, buildTemplateReviseRequest } = await loadTransport();
  const request = buildTemplateReviseRequest(baseInput());

  const patchError = createTemplateReviseHttpTransport({
    fetchImpl: async () => ({
      ok: false,
      status: 422,
      async text() {
        return JSON.stringify({
          code: 'PATCH_THEME_COLOR_INVALID',
          message: '颜色必须形如 #RRGGBB。',
          requestId: 'srv-422',
          details: [{ path: 'theme.primaryColor', code: 'PATCH_THEME_COLOR_INVALID', message: '颜色必须形如 #RRGGBB。' }],
        });
      },
    }),
    baseUrl: 'http://127.0.0.1:3000/api/v1',
    endpoint: '/api/v1/agent/template-revise',
    timeoutMs: 5000,
  });

  await assert.rejects(
    () => patchError.send(request, { requestId: 'req-422' }),
    (error) => {
      assert.equal(error.code, 'PATCH_THEME_COLOR_INVALID');
      assert.equal(error.httpStatus, 422);
      assert.equal(error.requestId, 'srv-422');
      assert.equal(error.details?.[0]?.path, 'theme.primaryColor');
      return true;
    },
  );

  const brokenJson = createTemplateReviseHttpTransport({
    fetchImpl: async () => ({ ok: true, status: 200, async text() { return 'not-json'; } }),
    baseUrl: 'http://127.0.0.1:3000/api/v1',
    endpoint: '/api/v1/agent/template-revise',
    timeoutMs: 5000,
  });

  await assert.rejects(
    () => brokenJson.send(request, { requestId: 'req-json' }),
    (error) => error.code === 'AGENT_RESPONSE_INVALID',
  );
});

test('R13 配置：TEMPLATE_REVISE_ENDPOINT 默认值正确，且不改变既有 agent-turn 导出', async () => {
  const config = await loadConfig();
  assert.equal(config.TEMPLATE_REVISE_ENDPOINT, '/api/v1/agent/template-revise');
  assert.equal(config.TEMPLATE_REVISE_CONTRACT_VERSION, CONTRACT);
  assert.equal(config.AGENT_ENDPOINT, '/api/v1/agent/turn');
  assert.equal(config.AGENT_CONTRACT_VERSION, 'agent-turn.v1');
  assert.equal(config.AGENT_TRANSPORT, 'mock');
});