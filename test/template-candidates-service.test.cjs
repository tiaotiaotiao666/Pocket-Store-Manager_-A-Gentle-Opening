'use strict';

/**
 * 模板候选推荐服务测试（契约 `agent-template-candidates.v1`，plan.md 2.2.9 / T13）。
 *
 * 覆盖：
 * 1. 请求体字段 / 上限 / 去重；
 * 2. 响应校验：恰好 3 个已知 ID、不重复、理由 ≤80 码点、meta.mock 必须 false；
 * 3. HTTP 成功路径：顺序与理由来自服务端，score 仍由前端确定性计算；
 * 4. 非法响应 / 超时 / 后端不可达：降级为本地排序，`meta.degraded=true` + 中文原因；
 * 5. 无假延时（计时断言 <1s）；
 * 6. score 可解释（scoreBasis 与功能覆盖一致，不存在 topScore - index*9）；
 * 7. 错误码到中文文案的映射。
 *
 * 说明：HTTP 模式通过 `applyAgentRuntimeConfig` 切换，测试结束一律 `resetAgentRuntimeConfig`。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const CONTRACT = 'agent-template-candidates.v1';
const FEATURES = ['scan-order', 'product-catalog', 'cart-checkout', 'order-tracking', 'takeaway'];

async function loadCandidatesService() {
  return import('../src/services/agentTurn/templateCandidatesService.js');
}

async function loadAgentService() {
  return import('../src/services/agentService.js');
}

async function loadConfig() {
  return import('../src/services/agentTurn/agentServiceConfig.js');
}

async function withHttpMode(run) {
  const config = await loadConfig();
  config.applyAgentRuntimeConfig({ transport: 'http', baseUrl: 'http://127.0.0.1:3000', timeoutMs: 40 });
  try {
    return await run(config);
  } finally {
    config.resetAgentRuntimeConfig();
  }
}

function validResponse(overrides = {}) {
  return {
    contractVersion: CONTRACT,
    turnId: 'turn-1',
    orderedTemplateIds: ['signature-kitchen', 'warm-bistro', 'modern-coffee'],
    reasons: {
      'signature-kitchen': '有招牌菜与门店故事，适合大幅主图。',
      'warm-bistro': '家常菜与社区门店的功能最贴合。',
      'modern-coffee': '轻量清单，可作为备选。',
    },
    meta: { transport: 'http', provider: 'deepseek', mock: false, model: 'deepseek-chat', latencyMs: 42 },
    ...overrides,
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

function failingFetch(status, body) {
  return async () => jsonResponse(body, status);
}

test('C1 请求体严格符合契约：字段、去重、client、projectId', async () => {
  const { buildTemplateCandidatesRequest } = await loadCandidatesService();
  const request = buildTemplateCandidatesRequest({
    selectedFeatures: ['scan-order', 'scan-order', 'takeaway'],
    brief: '  想做一个自取为主的咖啡店  ',
  });

  assert.deepEqual(request, {
    contractVersion: CONTRACT,
    selectedFeatures: ['scan-order', 'takeaway'],
    brief: '想做一个自取为主的咖啡店',
    client: { surface: 'desktop', phase: 'template-pick' },
    projectId: null,
  });
  assert.deepEqual(buildTemplateCandidatesRequest({}).selectedFeatures, []);
});

test('C2 请求侧非法输入 → AGENT_REQUEST_INVALID（超 11 项 / brief 超 500 码点 / 非数组）', async () => {
  const { buildTemplateCandidatesRequest, TEMPLATE_CANDIDATES_LIMITS } = await loadCandidatesService();

  assert.throws(
    () => buildTemplateCandidatesRequest({ selectedFeatures: 'scan-order' }),
    (error) => error.code === 'AGENT_REQUEST_INVALID',
  );
  assert.throws(
    () => buildTemplateCandidatesRequest({ selectedFeatures: Array.from({ length: 12 }, (_, index) => `f-${index}`) }),
    (error) => error.code === 'AGENT_REQUEST_INVALID',
  );
  assert.throws(
    () => buildTemplateCandidatesRequest({ brief: '想'.repeat(TEMPLATE_CANDIDATES_LIMITS.maxBrief + 1) }),
    (error) => error.code === 'AGENT_REQUEST_INVALID',
  );
});

test('C3 合法响应通过校验并保留顺序与理由', async () => {
  const { validateTemplateCandidatesResponse } = await loadCandidatesService();
  const body = validResponse();
  const validated = validateTemplateCandidatesResponse(body);
  assert.deepEqual(validated.orderedTemplateIds, body.orderedTemplateIds);
  assert.equal(validated.reasons['warm-bistro'], body.reasons['warm-bistro']);
});

test('C4 响应只有 2 个 ID / 未知 ID / 重复 ID / 理由超 80 码点 → AGENT_RESPONSE_INVALID', async () => {
  const { validateTemplateCandidatesResponse } = await loadCandidatesService();

  const cases = [
    validResponse({ orderedTemplateIds: ['warm-bistro', 'modern-coffee'] }),
    validResponse({
      orderedTemplateIds: ['warm-bistro', 'modern-coffee', 'not-a-template'],
      reasons: { 'warm-bistro': '甲', 'modern-coffee': '乙', 'not-a-template': '丙' },
    }),
    validResponse({ orderedTemplateIds: ['warm-bistro', 'warm-bistro', 'modern-coffee'] }),
    validResponse({
      reasons: {
        'signature-kitchen': '很'.repeat(81),
        'warm-bistro': '乙',
        'modern-coffee': '丙',
      },
    }),
  ];

  for (const body of cases) {
    assert.throws(
      () => validateTemplateCandidatesResponse(body),
      (error) => error.code === 'AGENT_RESPONSE_INVALID',
      `应拒绝非法响应：${JSON.stringify(body.orderedTemplateIds)}`,
    );
  }
});

test('C5 meta.mock 为 true 的响应被拒绝（Mock 不得冒充模型结果）；契约版本不一致单独报错', async () => {
  const { validateTemplateCandidatesResponse } = await loadCandidatesService();

  assert.throws(
    () => validateTemplateCandidatesResponse(validResponse({
      meta: { transport: 'http', provider: 'local-mock', mock: true, model: null, latencyMs: 5 },
    })),
    (error) => error.code === 'AGENT_RESPONSE_INVALID',
  );
  assert.throws(
    () => validateTemplateCandidatesResponse(validResponse({ contractVersion: 'agent-template-candidates.v2' })),
    (error) => error.code === 'AGENT_CONTRACT_MISMATCH',
  );
});

test('C6 HTTP 成功路径：顺序与 note 来自服务端，score 由前端功能覆盖计算，meta.degraded=false', async () => {
  const { buildTemplateCandidates } = await loadAgentService();

  await withHttpMode(async () => {
    const candidates = await buildTemplateCandidates({
      selectedFeatures: FEATURES,
      customPrompt: '想要招牌菜和门店故事',
      transport: { send: async () => validResponse() },
    });

    assert.ok(Array.isArray(candidates));
    assert.deepEqual(candidates.map((item) => item.id), ['signature-kitchen', 'warm-bistro', 'modern-coffee']);
    assert.equal(candidates[0].note, '有招牌菜与门店故事，适合大幅主图。', 'note 必须来自服务端理由');
    assert.equal(candidates.meta.degraded, false);
    assert.equal(candidates.meta.transport, 'http');
    assert.equal(candidates.meta.provider, 'deepseek');
    assert.equal(candidates.meta.turnId, 'turn-1');
    assert.match(candidates[0].source, /模型推荐/);

    // score 不来自模型，且每一项都能用 scoreBasis 解释。
    for (const candidate of candidates) {
      assert.equal(typeof candidate.score, 'number');
      assert.ok(candidate.score >= 0 && candidate.score <= 100);
      assert.match(candidate.scoreBasis, /功能覆盖 \d+\/\d+（\d+ 分）/);
    }
  });
});

test('C7 非法响应（2 个 ID）→ 降级：3 项本地排序、source 标注、meta.degraded=true + 中文原因', async () => {
  const { buildTemplateCandidates } = await loadAgentService();

  await withHttpMode(async () => {
    const candidates = await buildTemplateCandidates({
      selectedFeatures: FEATURES,
      customPrompt: '想要大图招牌菜',
      transport: { send: async () => validResponse({ orderedTemplateIds: ['warm-bistro', 'modern-coffee'] }) },
    });

    assert.equal(candidates.length, 3, '降级也必须给出 3 个候选');
    assert.equal(candidates.meta.degraded, true);
    assert.equal(typeof candidates.meta.degradedReason, 'string');
    assert.match(candidates.meta.degradedReason, /降级|本地规则|不合法/);
    assert.equal(candidates.meta.errorCode, 'AGENT_RESPONSE_INVALID');
    for (const candidate of candidates) {
      assert.equal(candidate.source, '本地规则（模型不可用）');
      assert.equal(candidate.sourceLabel, '本地规则（模型不可用）');
    }
    assert.deepEqual(
      candidates.map((item) => item.id),
      ['signature-kitchen', 'warm-bistro', 'modern-coffee'],
      '降级顺序应由本地关键词命中决定',
    );
  });
});

test('C8 HTTP 503（模型未配置）→ 降级且原因中文可读', async () => {
  const { buildTemplateCandidates } = await loadAgentService();
  const { createTemplateCandidatesTransport } = await loadCandidatesService();

  await withHttpMode(async () => {
    const transport = createTemplateCandidatesTransport({
      fetchImpl: failingFetch(503, { code: 'DEEPSEEK_NOT_CONFIGURED', message: '模型未配置' }),
    });
    const candidates = await buildTemplateCandidates({
      selectedFeatures: FEATURES,
      customPrompt: '',
      transport,
    });

    assert.equal(candidates.meta.degraded, true);
    assert.match(candidates.meta.degradedReason, /未配置模型服务|本地规则/);
    assert.equal(candidates.meta.errorCode, 'DEEPSEEK_NOT_CONFIGURED');
    assert.equal(candidates[0].source, '本地规则（模型不可用）');
  });
});

test('C9 真实 transport 超时（40ms）→ AGENT_TIMEOUT 降级，返回仍是 3 项', async () => {
  const { buildTemplateCandidates } = await loadAgentService();
  const { createTemplateCandidatesTransport } = await loadCandidatesService();

  await withHttpMode(async () => {
    const transport = createTemplateCandidatesTransport({
      timeoutMs: 40,
      fetchImpl: (url, init) => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      }),
    });

    const startedAt = Date.now();
    const candidates = await buildTemplateCandidates({
      selectedFeatures: FEATURES,
      customPrompt: '',
      transport,
    });
    const elapsed = Date.now() - startedAt;

    assert.equal(candidates.length, 3);
    assert.equal(candidates.meta.degraded, true);
    assert.equal(candidates.meta.errorCode, 'AGENT_TIMEOUT');
    assert.match(candidates.meta.degradedReason, /超时/);
    assert.ok(elapsed < 1000, `超时降级应快速返回，实际 ${elapsed}ms`);
  });
});

test('C10 无假延时：Mock 模式默认 0 延时，计时断言 <1s（移除旧 1.6s）', async () => {
  const { buildTemplateCandidates } = await loadAgentService();

  const startedAt = Date.now();
  const candidates = await buildTemplateCandidates({ selectedFeatures: FEATURES, customPrompt: '' });
  const elapsed = Date.now() - startedAt;

  assert.ok(elapsed < 1000, `不应再等待 1.6 秒，实际 ${elapsed}ms`);
  assert.equal(candidates.length, 3);
  assert.equal(candidates.meta.degraded, false);
  assert.equal(candidates.meta.transport, 'mock');
  assert.equal(candidates.meta.mock, true);
  assert.equal(candidates.meta.source, '本地规则（Mock）');
});

test('C11 score 可解释：与功能覆盖率一致，且不出现 topScore - index*9 的递减套路', async () => {
  const { buildTemplateCandidates } = await loadAgentService();

  const candidates = await buildTemplateCandidates({ selectedFeatures: FEATURES, customPrompt: '' });

  for (const candidate of candidates) {
    const matched = candidate.scoreBasis.match(/功能覆盖 (\d+)\/(\d+)（(\d+) 分）/);
    assert.ok(matched, `缺少可解释依据：${candidate.scoreBasis}`);
    const coverage = Math.round((Number(matched[1]) / Number(matched[2])) * 100);
    assert.equal(coverage, Number(matched[3]), 'scoreBasis 里的覆盖率应自洽');
    assert.ok(candidate.score >= coverage, '总分不低于功能覆盖分');
    assert.ok(candidate.score - coverage <= 15, '描述加分最多 15 分');
  }

  // 旧实现是 topScore、topScore-9、topScore-18，这里至少要有两项不满足该等差。
  const scores = candidates.map((item) => item.score);
  const isFakeArithmetic = scores.every((value, index) => index === 0 || scores[index - 1] - value === 9);
  assert.equal(isFakeArithmetic, false, `score 不应是编造的递减序列：${scores.join(',')}`);
});

test('C12 错误码 → 中文可读原因映射（超时 / 未配置 / 响应非法 / 契约不一致 / 网络）', async () => {
  const { describeTemplateCandidatesError } = await loadCandidatesService();
  const { createAgentTurnError } = await import('../src/services/agentTurn/agentTurnError.js');

  const timeout = describeTemplateCandidatesError(createAgentTurnError('AGENT_TIMEOUT'));
  assert.match(timeout, /超时/);
  assert.match(timeout, /本地规则排序/);

  assert.match(describeTemplateCandidatesError(createAgentTurnError('DEEPSEEK_NOT_CONFIGURED')), /未配置模型服务/);
  assert.match(describeTemplateCandidatesError(createAgentTurnError('AGENT_RESPONSE_INVALID')), /候选不合法/);
  assert.match(describeTemplateCandidatesError(createAgentTurnError('AGENT_CONTRACT_MISMATCH')), /契约版本不一致/);
  assert.match(describeTemplateCandidatesError(createAgentTurnError('AGENT_NETWORK')), /无法连接/);
  assert.match(describeTemplateCandidatesError(createAgentTurnError('AGENT_HTTP_5XX', { httpStatus: 503 })), /HTTP 503/);

  const unknown = describeTemplateCandidatesError(new Error('boom'));
  assert.match(unknown, /boom/);
});

test('C13 HTTP transport 发到 /api/v1/agent/template-candidates，带契约头，请求体即契约体', async () => {
  const { createTemplateCandidatesTransport, buildTemplateCandidatesRequest } = await loadCandidatesService();

  let captured = null;
  const transport = createTemplateCandidatesTransport({
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return jsonResponse(validResponse());
    },
  });

  const request = buildTemplateCandidatesRequest({ selectedFeatures: ['scan-order'], brief: '咖啡' });
  const body = await transport.send(request, { requestId: 'req-1' });

  assert.equal(captured.url, 'http://127.0.0.1:3000/api/v1/agent/template-candidates');
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers['X-Agent-Contract'], CONTRACT);
  assert.equal(captured.init.headers['X-Agent-Request-Id'], 'req-1');
  assert.deepEqual(JSON.parse(captured.init.body), request);
  assert.deepEqual(body.orderedTemplateIds, validResponse().orderedTemplateIds);
});

test('C14 后端不可达（TypeError）→ 降级并给出中文原因，不改写候选数量', async () => {
  const { buildTemplateCandidates } = await loadAgentService();
  const { createTemplateCandidatesTransport } = await loadCandidatesService();

  await withHttpMode(async () => {
    const transport = createTemplateCandidatesTransport({
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    });
    const candidates = await buildTemplateCandidates({
      selectedFeatures: FEATURES,
      customPrompt: '随便',
      transport,
    });

    assert.equal(candidates.length, 3);
    assert.equal(candidates.meta.degraded, true);
    assert.equal(candidates.meta.errorCode, 'AGENT_NETWORK');
    assert.match(candidates.meta.degradedReason, /无法连接/);
  });
});