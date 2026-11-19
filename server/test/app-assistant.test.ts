import { HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { ChatCompletionRequest, ChatCompletionResult, ChatModel } from '../src/agent/runtime';
import { AGENT_TOOL_ERROR_CODES } from '../src/agent/runtime';
import { APP_CATALOG } from '../src/agent/app-assistant/capabilities';
import { AppAssistantController } from '../src/agent/app-assistant/controller';
import { AppAssistantService } from '../src/agent/app-assistant/service';
import {
  APP_ASSISTANT_CATALOG_VERSION,
  APP_ASSISTANT_CONTRACT_VERSION,
} from '../src/agent/app-assistant/types';


interface ScriptedModel {
  model: ChatModel;
  requests: ChatCompletionRequest[];
}

function scriptedModel(results: ChatCompletionResult[]): ScriptedModel {
  const queue = [...results];
  const requests: ChatCompletionRequest[] = [];
  return {
    requests,
    model: {
      name: 'scripted-model',
      complete: async (request) => {
        requests.push(request);
        const next = queue.shift();
        if (next === undefined) throw new Error('模型脚本已用尽。');
        return next;
      },
    },
  };
}

function toolResult(name: string, args: unknown, id = `call_${Math.random().toString(16).slice(2)}`): ChatCompletionResult {
  return {
    message: {
      role: 'assistant',
      content: null,
      toolCalls: [{ id, name, argumentsText: JSON.stringify(args) }],
    },
    finishReason: 'tool_calls',
    model: 'deepseek-chat',
    latencyMs: 5,
    usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
  };
}

function textResult(text: string, overrides: Partial<ChatCompletionResult> = {}): ChatCompletionResult {
  return {
    message: { role: 'assistant', content: text },
    finishReason: 'stop',
    model: 'deepseek-chat',
    latencyMs: 4,
    usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
    ...overrides,
  };
}

const CONTEXT = {
  contextVersion: 'project-agent-context.v1',
  capabilitiesVersion: APP_ASSISTANT_CATALOG_VERSION,
  projectId: 'p_demo',
  contentRevision: 3,
  phase: 'template-pick',
  fields: {
    'store.name': '',
    'store.category': '',
    'store.businessHours': '',
    'store.fulfillment': { dineIn: false, takeaway: false },
    'store.dishes': [],
    'store.address': '',
    'store.phone': '',
    'store.notes': '',
    'store.imageAssetIds': [],
    'visual.styleId': 'warm',
    'visual.prompt': '',
    'visual.imageAssetId': null,
    'features.selected': ['scan-order', 'product-catalog', 'cart-checkout', 'order-tracking'],
    'features.custom': '',
    'project.appid': '',
  },
  validation: { missingFields: [], errors: [], readyForReview: false, nextQuestion: null },
  build: { candidates: [], selectedId: null },
  assets: { images: [] },
  screenRef: { status: 'idle', hasImage: false, adopted: false },
  frontendCandidate: { status: 'none', adopted: false, templateId: null },
  deploy: { status: 'idle', appidFilled: false, preflightReady: false },
};

const TINY_PNG_BASE64 = 'iVBORw0KGgo=';

function createRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: APP_ASSISTANT_CONTRACT_VERSION,
    requestId: 'chat_req_test_1',
    catalogVersion: APP_ASSISTANT_CATALOG_VERSION,
    contextRevision: 3,
    utterance: '店名改为松月食堂，10点到21点营业，支持堂食和自取，加牛肉面28元',
    history: [],
    client: { surface: 'desktop', phase: 'template-pick' },
    project: { projectId: 'p_demo', context: CONTEXT },
    attachments: [],
    ...overrides,
  };
}

function createService(model: ChatModel, configOverrides: Record<string, unknown> = {}): AppAssistantService {
  const config = new ConfigService({
    AGENT_RUN_MAX_STEPS: 6,
    AGENT_RUN_MAX_TOOL_CALLS: 12,
    AGENT_RUN_TIMEOUT_MS: 60_000,
    ...configOverrides,
  });
  return new AppAssistantService(model, config);
}

async function captureHttpError(promise: Promise<unknown>): Promise<HttpException> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpException) return error;
    throw error;
  }
  throw new Error('预期抛出 HttpException，但调用成功了。');
}

function errorCodeOf(error: HttpException): string {
  const payload = error.getResponse();
  if (payload && typeof payload === 'object' && typeof (payload as Record<string, unknown>).code === 'string') {
    return String((payload as Record<string, unknown>).code);
  }
  return '';
}

describe('AppAssistantService：五工具与会话边界', () => {
  it('覆盖五个工具并把结果组装成 proposal 外壳', async () => {
    const { model, requests } = scriptedModel([
      toolResult('get_project_capabilities', { domain: 'all' }, 'call_cap'),
      toolResult('get_project_context', {}, 'call_ctx'),
      toolResult(
        'propose_project_changes',
        {
          changes: [
            {
              opId: 'op_1',
              op: 'field.set',
              fieldId: 'store.name',
              value: '松月食堂',
              evidence: { source: 'utterance', excerpt: '店名改为松月食堂' },
            },
            {
              opId: 'op_2',
              op: 'dish.upsert',
              name: '牛肉面',
              priceCents: 2800,
              evidence: { source: 'utterance', excerpt: '加牛肉面28元' },
            },
          ],
        },
        'call_changes',
      ),
      toolResult(
        'request_business_action',
        {
          actionId: 'navigate.phase',
          params: { phase: 'visual-style' },
          evidence: { source: 'utterance', excerpt: '切到视觉风格' },
        },
        'call_action',
      ),
      toolResult('ask_follow_up', { questions: [{ text: '营业时间是每天 10:00-21:00 吗？' }] }, 'call_ask'),
      textResult('已把店名、营业时间和菜品整理成提案，请核对。'),
    ]);
    const service = createService(model);

    const response = await service.run(createRequest(), { requestId: 'chat_req_test_1' });

    expect(response.contractVersion).toBe(APP_ASSISTANT_CONTRACT_VERSION);
    expect(response.requestId).toBe('chat_req_test_1');
    expect(response.status).toBe('proposal');
    expect(response.changes).toHaveLength(2);
    expect(response.changes[0]).toMatchObject({ op: 'field.set', fieldId: 'store.name', value: '松月食堂' });
    expect(response.changes[1]).toMatchObject({ op: 'dish.upsert', name: '牛肉面', priceCents: 2800 });
    expect(response.actionRequests).toHaveLength(1);
    expect(response.actionRequests[0].actionId).toBe('navigate.phase');
    expect(response.questions).toHaveLength(1);
    expect(response.trace.toolCalls).toHaveLength(5);
    expect(response.trace.toolCalls.every((call) => call.ok)).toBe(true);
    expect(response.trace.degraded).toBe(false);
    expect(response.meta).toMatchObject({ transport: 'http', provider: 'deepseek', mock: false });
    expect(response).not.toHaveProperty('applied');

    // trace 只含计数与调用元数据，不回传用户原文/参数/结果。
    const traceText = JSON.stringify(response.trace);
    expect(traceText).not.toContain('松月食堂');
    expect(traceText).not.toContain('店名改为松月食堂');

    // 系统提示词包含能力目录，且不包含用户上下文正文。
    const systemPrompt = requests[0].messages[0].content;
    expect(typeof systemPrompt).toBe('string');
    expect(systemPrompt as string).toContain('store.name');
    expect(systemPrompt as string).not.toContain('肉夹馍');
  });

  it('只有附件时使用内部指令，图片以 data URL 进入多模态消息；歧义只追问', async () => {
    const { model, requests } = scriptedModel([
      toolResult('ask_follow_up', {
        questions: [
          { text: '识别菜单、提取门店氛围，还是参考界面重构？' },
        ],
      }),
      textResult('这张图可以作为菜单、门店氛围或界面参考，请选择用途。'),
    ]);
    const service = createService(model);

    const response = await service.run(
      createRequest({
        utterance: '',
        attachments: [
          {
            id: 'att_1',
            kind: 'auto',
            mediaType: 'image/png',
            dataBase64: TINY_PNG_BASE64,
            name: 'shot.png',
          },
        ],
      }),
      { requestId: 'chat_req_test_1' },
    );

    expect(response.status).toBe('needs-input');
    expect(response.changes).toEqual([]);
    expect(response.questions).toHaveLength(1);
    expect(response.trace.degraded).toBe(false);

    const content = requests[0].messages[1].content;
    expect(Array.isArray(content)).toBe(true);
    const parts = content as Array<{ type: string; text?: string; imageUrl?: { url: string } }>;
    expect(parts[0].type).toBe('text');
    expect(parts[0].text).toContain('请判断这些图片的用途');
    expect(parts[0].text).toContain('att_1');
    expect(parts[1].type).toBe('image_url');
    expect(parts[1].imageUrl?.url).toBe(`data:image/png;base64,${TINY_PNG_BASE64}`);
    // 图片正文不进入响应。
    expect(JSON.stringify(response)).not.toContain(TINY_PNG_BASE64);
  });

  it('越界字段与危险动作被工具拒绝，整轮标为 rejected 且不产生任何变更', async () => {
    const { model } = scriptedModel([
      toolResult('propose_project_changes', {
        changes: [
          {
            opId: 'op_1',
            op: 'field.set',
            fieldId: 'settings.apiKey',
            value: 'sk-test',
            evidence: { source: 'utterance', excerpt: '改 Key' },
          },
        ],
      }),
      toolResult('request_business_action', {
        actionId: 'fs.write',
        params: { path: 'C:\\Windows\\evil.txt' },
        evidence: { source: 'utterance', excerpt: '写文件' },
      }),
      textResult('这些操作不在项目助手的范围内。'),
    ]);
    const service = createService(model);

    const response = await service.run(createRequest(), { requestId: 'chat_req_test_1' });

    expect(response.status).toBe('rejected');
    expect(response.changes).toEqual([]);
    expect(response.actionRequests).toEqual([]);
    expect(response.trace.degraded).toBe(true);
    const failed = response.trace.toolCalls.filter((call) => !call.ok);
    expect(failed).toHaveLength(2);
  });

  it('触碰 Runtime 上限时返回降级结果而不是抛错', async () => {
    const domains = ['store', 'visual', 'features', 'project', 'actions', 'all'];
    const { model } = scriptedModel(
      domains.map((domain, index) => toolResult('get_project_capabilities', { domain }, `call_${index}`)),
    );
    const service = createService(model);

    const response = await service.run(createRequest(), { requestId: 'chat_req_test_1' });

    expect(response.trace.modelCalls).toBe(6);
    expect(response.trace.stopReason).toBe('max_model_calls');
    expect(response.trace.degraded).toBe(true);
    expect(response.reply.length).toBeGreaterThan(0);
    expect(response.changes).toEqual([]);
  });

  it('模型输出截断时拒绝解析残片', async () => {
    const { model } = scriptedModel([
      textResult('这家店的风格是', { finishReason: 'length', truncated: true }),
    ]);
    const service = createService(model);

    const error = await captureHttpError(
      service.run(createRequest(), { requestId: 'chat_req_test_1' }),
    );

    expect(error.getStatus()).toBe(502);
    expect(errorCodeOf(error)).toBe('APP_ASSISTANT_RESPONSE_INVALID');
  });

  it('reply 超过 500 字时被裁剪，响应外壳仍合法', async () => {
    const { model } = scriptedModel([textResult('好'.repeat(600))]);
    const service = createService(model);

    const response = await service.run(createRequest(), { requestId: 'chat_req_test_1' });

    expect(Array.from(response.reply)).toHaveLength(500);
  });
});

describe('AppAssistantService：请求契约与上下文 fail closed', () => {
  const badRequests: Array<{ name: string; request: Record<string, unknown>; code: string }> = [
    {
      name: '未知顶层键',
      request: createRequest({ settings: { apiKey: 'x' } }),
      code: 'APP_ASSISTANT_REQUEST_INVALID',
    },
    {
      name: 'contractVersion 不一致',
      request: createRequest({ contractVersion: 'app-assistant.v2' }),
      code: 'APP_ASSISTANT_CONTRACT_MISMATCH',
    },
    {
      name: 'catalogVersion 不一致',
      request: createRequest({ catalogVersion: 'app-capabilities.v2' }),
      code: 'APP_ASSISTANT_CATALOG_MISMATCH',
    },
    {
      name: 'history 超限',
      request: createRequest({
        history: Array.from({ length: 13 }, () => ({ role: 'user', text: 'x' })),
      }),
      code: 'APP_ASSISTANT_REQUEST_INVALID',
    },
    {
      name: '没有任何输入',
      request: createRequest({ utterance: '' }),
      code: 'APP_ASSISTANT_REQUEST_INVALID',
    },
    {
      name: '附件超过 3 张',
      request: createRequest({
        attachments: Array.from({ length: 4 }, (_, index) => ({
          id: `att_${index}`,
          kind: 'store',
          mediaType: 'image/png',
          dataBase64: TINY_PNG_BASE64,
        })),
      }),
      code: 'APP_ASSISTANT_REQUEST_INVALID',
    },
    {
      name: '附件 MIME 非法',
      request: createRequest({
        attachments: [
          { id: 'att_1', kind: 'store', mediaType: 'image/gif', dataBase64: TINY_PNG_BASE64 },
        ],
      }),
      code: 'APP_ASSISTANT_REQUEST_INVALID',
    },
    {
      name: 'contextRevision 不一致',
      request: createRequest({
        project: { projectId: 'p_demo', context: { ...CONTEXT, contentRevision: 9 } },
      }),
      code: 'APP_ASSISTANT_CONTEXT_INVALID',
    },
    {
      name: 'context 含 deploy.directory',
      request: createRequest({
        project: {
          projectId: 'p_demo',
          context: { ...CONTEXT, deploy: { status: 'idle', directory: 'C:\\out' } },
        },
      }),
      code: 'APP_ASSISTANT_CONTEXT_INVALID',
    },
    {
      name: 'context 字段越界',
      request: createRequest({
        project: {
          projectId: 'p_demo',
          context: { ...CONTEXT, fields: { ...CONTEXT.fields, 'settings.apiKey': 'x' } },
        },
      }),
      code: 'APP_ASSISTANT_CONTEXT_INVALID',
    },
    {
      name: 'context 含 base64',
      request: createRequest({
        project: {
          projectId: 'p_demo',
          context: {
            ...CONTEXT,
            fields: { ...CONTEXT.fields, 'store.notes': 'data:image/png;base64,AAAA' },
          },
        },
      }),
      code: 'APP_ASSISTANT_CONTEXT_INVALID',
    },
    {
      name: 'projectId 不一致',
      request: createRequest({
        project: { projectId: 'p_other', context: CONTEXT },
      }),
      code: 'APP_ASSISTANT_CONTEXT_INVALID',
    },
  ];

  for (const testCase of badRequests) {
    it(`拒绝非法请求：${testCase.name}`, async () => {
      const { model } = scriptedModel([textResult('不应执行')]);
      const service = createService(model);

      const error = await captureHttpError(
        service.run(testCase.request, { requestId: 'chat_req_test_1' }),
      );

      expect(errorCodeOf(error)).toBe(testCase.code);
      expect(error.getStatus()).toBe(400);
    });
  }

  it('X-Agent-Request-Id 与 body.requestId 不一致时拒绝', async () => {
    const { model } = scriptedModel([textResult('不应执行')]);
    const service = createService(model);

    const error = await captureHttpError(
      service.run(createRequest(), {
        requestId: 'chat_req_test_1',
        agentRequestIdHeader: 'chat_req_other_1',
      }),
    );

    expect(errorCodeOf(error)).toBe('APP_ASSISTANT_REQUEST_INVALID');
  });

  it('X-Agent-Contract 与契约不一致时拒绝', async () => {
    const { model } = scriptedModel([textResult('不应执行')]);
    const service = createService(model);

    const error = await captureHttpError(
      service.run(createRequest(), {
        requestId: 'chat_req_test_1',
        agentContractHeader: 'agent-turn.v1',
      }),
    );

    expect(errorCodeOf(error)).toBe('APP_ASSISTANT_CONTRACT_MISMATCH');
  });
});

describe('AppAssistantService：提案校验与工具错误码', () => {

  const cases: Array<{ name: string; tool: string; args: unknown; expectedCode: string }> = [
    {
      name: '只读字段 field.set',
      tool: 'propose_project_changes',
      args: {
        changes: [
          {
            opId: 'op_1',
            op: 'field.set',
            fieldId: 'store.dishes',
            value: [],
            evidence: { source: 'utterance', excerpt: '改菜品' },
          },
        ],
      },
      expectedCode: 'APP_ASSISTANT_FIELD_READ_ONLY',
    },
    {
      name: '未知字段',
      tool: 'propose_project_changes',
      args: {
        changes: [
          {
            opId: 'op_1',
            op: 'field.set',
            fieldId: 'settings.apiKey',
            value: 'x',
            evidence: { source: 'utterance', excerpt: 'x' },
          },
        ],
      },
      expectedCode: 'APP_ASSISTANT_FIELD_UNKNOWN',
    },
    {
      name: '值类型错误',
      tool: 'propose_project_changes',
      args: {
        changes: [
          {
            opId: 'op_1',
            op: 'field.set',
            fieldId: 'store.name',
            value: 123,
            evidence: { source: 'utterance', excerpt: '店名' },
          },
        ],
      },
      expectedCode: 'APP_ASSISTANT_VALUE_INVALID',
    },
    {
      name: '营业时间越界',
      tool: 'propose_project_changes',
      args: {
        changes: [
          {
            opId: 'op_1',
            op: 'field.set',
            fieldId: 'store.businessHours',
            value: '25:00-26:00',
            evidence: { source: 'utterance', excerpt: '营业时间' },
          },
        ],
      },
      expectedCode: 'APP_ASSISTANT_VALUE_INVALID',
    },
    {
      name: '路径注入',
      tool: 'propose_project_changes',
      args: {
        changes: [
          {
            opId: 'op_1',
            op: 'field.set',
            fieldId: 'store.name',
            value: '../../app.json',
            evidence: { source: 'utterance', excerpt: '../../app.json' },
          },
        ],
      },
      expectedCode: 'APP_ASSISTANT_OPERATION_DENIED',
    },
    {
      name: '重复 opId',
      tool: 'propose_project_changes',
      args: {
        changes: [
          {
            opId: 'op_1',
            op: 'field.set',
            fieldId: 'store.name',
            value: '松月食堂',
            evidence: { source: 'utterance', excerpt: '店名' },
          },
          {
            opId: 'op_1',
            op: 'field.set',
            fieldId: 'store.category',
            value: '社区餐馆',
            evidence: { source: 'utterance', excerpt: '品类' },
          },
        ],
      },
      expectedCode: 'APP_ASSISTANT_PROPOSAL_DUPLICATE',
    },
    {
      name: '菜品缺少 dishId',
      tool: 'propose_project_changes',
      args: {
        changes: [
          { opId: 'op_1', op: 'dish.remove', evidence: { source: 'utterance', excerpt: '删菜' } },
        ],
      },
      expectedCode: 'APP_ASSISTANT_VALUE_INVALID',
    },
    {
      name: '目录之外的动作',
      tool: 'request_business_action',
      args: {
        actionId: 'ipc.invoke',
        evidence: { source: 'utterance', excerpt: '调用 IPC' },
      },
      expectedCode: 'APP_ASSISTANT_OPERATION_DENIED',
    },
    {
      name: '动作缺少必需参数',
      tool: 'request_business_action',
      args: {
        actionId: 'asset.attach-store-image',
        evidence: { source: 'utterance', excerpt: '保存门店图' },
      },
      expectedCode: 'APP_ASSISTANT_VALUE_INVALID',
    },
  ];

  for (const testCase of cases) {
    it(`拒绝非法提案：${testCase.name}`, async () => {
      const { model } = scriptedModel([toolResult(testCase.tool, testCase.args), textResult('收到。')]);
      const service = createService(model);

      const response = await service.run(createRequest(), { requestId: 'chat_req_test_1' });

      const failed = response.trace.toolCalls.find((call) => !call.ok);
      expect(failed).toBeDefined();
      expect(response.changes).toEqual([]);
      expect(response.actionRequests).toEqual([]);
      // 工具错误码在 runtime 内部保留；响应 trace 刻意只暴露 name/ok/latencyMs。
      expect(response.trace.degraded).toBe(true);
    });
  }

  it('菜品价格必须是整数分或 null', async () => {
    const { model } = scriptedModel([
      toolResult('propose_project_changes', {
        changes: [
          {
            opId: 'op_1',
            op: 'dish.upsert',
            name: '牛肉面',
            priceCents: 28.5,
            evidence: { source: 'utterance', excerpt: '牛肉面28.5元' },
          },
        ],
      }),
      textResult('价格格式不对。'),
    ]);
    const service = createService(model);

    const response = await service.run(createRequest(), { requestId: 'chat_req_test_1' });

    expect(response.changes).toEqual([]);
    expect(response.trace.toolCalls).toHaveLength(1);
    expect(response.trace.toolCalls[0].ok).toBe(false);
    expect(AGENT_TOOL_ERROR_CODES.argumentsInvalid.length).toBeGreaterThan(0);
  });

  it('单轮变更数超过 24 条时拒绝整次工具调用', async () => {
    const changes = Array.from({ length: 25 }, (_, index) => ({
      opId: `op_${index}`,
      op: 'field.set',
      fieldId: 'store.name',
      value: `店${index}`,
      evidence: { source: 'utterance', excerpt: '店名' },
    }));
    const { model } = scriptedModel([
      toolResult('propose_project_changes', { changes }),
      textResult('一次改太多了。'),
    ]);
    const service = createService(model);

    const response = await service.run(createRequest(), { requestId: 'chat_req_test_1' });

    expect(response.changes).toEqual([]);
    expect(response.trace.toolCalls[0].ok).toBe(false);
  });

  it('能力目录快照与契约同源', () => {
    expect(APP_CATALOG.catalogVersion).toBe(APP_ASSISTANT_CATALOG_VERSION);
    expect(APP_CATALOG.fields.find((field) => field.fieldId === 'store.name')?.writable).toBe(true);
    expect(APP_CATALOG.fields.find((field) => field.fieldId === 'store.dishes')?.writeMode).toBe('ops');
    expect(APP_CATALOG.actions.some((action) => action.actionId === 'export.run')).toBe(true);
  });
});

describe('AppAssistantController：请求头与响应头', () => {
  function createResponseStub(): {
    setHeader: ReturnType<typeof vi.fn>;
    once: ReturnType<typeof vi.fn>;
    removeListener: ReturnType<typeof vi.fn>;
    writableEnded: boolean;
  } {
    return {
      setHeader: vi.fn(),
      once: vi.fn(),
      removeListener: vi.fn(),
      writableEnded: false,
    };
  }

  it('透传 requestId 并回写 X-Request-Id', async () => {
    const { model } = scriptedModel([textResult('你好。')]);
    const controller = new AppAssistantController(createService(model));
    const response = createResponseStub();

    const result = await controller.run(
      createRequest(),
      {
        headers: { 'x-agent-request-id': 'chat_req_test_1' },
      } as never,
      response as never,
    );

    expect(result.requestId).toBe('chat_req_test_1');
    expect(response.setHeader).toHaveBeenCalledWith('X-Request-Id', 'chat_req_test_1');
    expect(response.once).toHaveBeenCalledWith('close', expect.any(Function));
  });

  it('请求头与 body.requestId 不一致时由服务层拒绝', async () => {
    const { model } = scriptedModel([textResult('不应执行')]);
    const controller = new AppAssistantController(createService(model));
    const response = createResponseStub();

    const error = await captureHttpError(
      controller.run(
        createRequest(),
        { headers: { 'x-agent-request-id': 'chat_req_other_1' } } as never,
        response as never,
      ),
    );

    expect(errorCodeOf(error)).toBe('APP_ASSISTANT_REQUEST_INVALID');
  });
});
