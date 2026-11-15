import { HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { AGENT_TOOL_ERROR_CODES, AgentModelError } from '../src/agent/runtime';
import type {
  ChatCompletionRequest,
  ChatCompletionResult,
  ChatModel,
} from '../src/agent/runtime';
import type { ContractDraft } from '../src/agent/agent.types';
import { StoreSetupAgentService } from '../src/agent/store-setup/store-setup.service';
import { AGENT_RUN_CONTRACT_VERSION } from '../src/agent/store-setup/store-setup.types';

const EMPTY_DRAFT: ContractDraft = {
  storeName: '',
  category: '',
  businessHours: '',
  fulfillment: { dineIn: false, takeaway: false },
  dishes: [],
};

const COMPLETE_DRAFT = {
  storeName: '孙记面馆',
  category: '面馆',
  businessHours: '10:00-21:00',
  fulfillment: { dineIn: true, takeaway: false },
  dishes: [
    { name: '牛肉面', priceCents: 2800 },
    { name: '凉皮', priceCents: 1200 },
    { name: '酸梅汤', priceCents: 800 },
  ],
};

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
      name: 'scripted',
      complete: async (request) => {
        requests.push(request);
        const next = queue.shift();
        if (next === undefined) throw new Error('模型脚本已用尽。');
        return next;
      },
    },
  };
}

function toolResult(name: string, args: unknown, id = 'call_1'): ChatCompletionResult {
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

function textResult(text: string): ChatCompletionResult {
  return {
    message: { role: 'assistant', content: text },
    finishReason: 'stop',
    model: 'deepseek-chat',
    latencyMs: 4,
    usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
  };
}

function createRequest(overrides: Record<string, unknown> = {}): unknown {
  return {
    contractVersion: AGENT_RUN_CONTRACT_VERSION,
    utterance: '帮我开一家面馆，卖牛肉面、凉皮和酸梅汤。',
    draft: EMPTY_DRAFT,
    client: { surface: 'desktop', phase: 'store-info' },
    projectId: null,
    ...overrides,
  };
}

function createService(model: ChatModel): StoreSetupAgentService {
  const config = new ConfigService({
    AGENT_RUN_MAX_STEPS: 6,
    AGENT_RUN_MAX_TOOL_CALLS: 12,
    AGENT_RUN_TIMEOUT_MS: 60_000,
  });
  return new StoreSetupAgentService(model, config);
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

describe('StoreSetupAgentService：function calling 全流程', () => {
  it('通过 update_store_draft 写入草稿，再由服务端重新校验', async () => {
    const { model, requests } = scriptedModel([
      toolResult('update_store_draft', COMPLETE_DRAFT),
      textResult('资料已经齐了，请检查草稿后确认。'),
    ]);
    const service = createService(model);

    const response = await service.run(createRequest(), { requestId: 'req_store_1' });

    expect(response.contractVersion).toBe(AGENT_RUN_CONTRACT_VERSION);
    expect(response.status).toBe('reviewing');
    expect(response.reply).toBe('资料已经齐了，请检查草稿后确认。');
    expect(response.draft.storeName).toBe('孙记面馆');
    expect(response.draft.dishes).toHaveLength(3);
    expect(response.missingFields).toEqual([]);
    expect(response.errors).toEqual([]);
    expect(response.nextQuestion).toBeNull();
    expect(response.trace.modelCalls).toBe(2);
    expect(response.trace.toolCalls).toHaveLength(1);
    expect(response.trace.toolCalls[0]?.ok).toBe(true);
    expect(response.trace.degraded).toBe(false);
    expect(response.meta.provider).toBe('deepseek');
    expect(response.meta.runId).toBe(response.runId);
    expect(response.runId.startsWith('run_')).toBe(true);

    expect(requests[0]?.tools?.map((tool) => tool.name)).toEqual([
      'get_store_draft',
      'update_store_draft',
    ]);
    expect(requests[0]?.messages[0]?.role).toBe('system');
  });

  it('模型传入非法工具参数时，工具失败但循环继续，响应标记 degraded', async () => {
    const { model } = scriptedModel([
      toolResult('update_store_draft', { dishes: [{ priceCents: 100 }] }),
      textResult('还缺菜名，请补充一下。'),
    ]);
    const service = createService(model);

    const response = await service.run(createRequest(), { requestId: 'req_store_2' });

    expect(response.status).toBe('collecting');
    expect(response.trace.toolCalls[0]?.ok).toBe(false);
    expect(response.trace.toolCalls[0]?.errorCode).toBe(
      AGENT_TOOL_ERROR_CODES.argumentsInvalid,
    );
    expect(response.trace.degraded).toBe(true);
    expect(response.draft.dishes).toEqual([]);
    expect(response.reply).toBe('还缺菜名，请补充一下。');
  });

  it('模型返回空回复时由服务端兜底，仍返回可用下一步问题', async () => {
    const { model } = scriptedModel([textResult(''), textResult('')]);
    const service = createService(model);

    const response = await service.run(createRequest(), { requestId: 'req_store_3' });

    expect(response.status).toBe('collecting');
    expect(response.trace.degraded).toBe(true);
    expect(response.reply).toContain('已更新草稿');
    expect(response.nextQuestion).not.toBeNull();
    expect(response.draft.storeName).toBe('');
  });
});

describe('StoreSetupAgentService：契约与错误映射', () => {
  it.each([
    ['contractVersion', { contractVersion: 'agent-run.v2' }, 'AGENT_CONTRACT_MISMATCH'],
    ['未知字段', { extra: true }, 'AGENT_REQUEST_INVALID'],
    ['空 utterance', { utterance: '   ' }, 'UTTERANCE_INVALID'],
    ['错误 client', { client: { surface: 'web', phase: 'store-info' } }, 'CLIENT_INVALID'],
    ['非空 projectId', { projectId: 'proj_1' }, 'PROJECT_ID_INVALID'],
  ])('拒绝无效请求：%s', async (_name, overrides, code) => {
    const { model } = scriptedModel([]);
    const service = createService(model);

    const error = await captureHttpError(
      service.run(createRequest(overrides), { requestId: 'req_bad' }),
    );

    expect(error.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect(error.getResponse()).toMatchObject({ code });
  });

  it('把模型错误映射为稳定的 HTTP 状态，不泄露上游细节', async () => {
    const model: ChatModel = {
      name: 'failing',
      complete: async () => {
        throw new AgentModelError('DEEPSEEK_TIMEOUT', '上游超时。', { retryable: false });
      },
    };
    const service = createService(model);

    const error = await captureHttpError(service.run(createRequest(), { requestId: 'req_timeout' }));

    expect(error.getStatus()).toBe(HttpStatus.GATEWAY_TIMEOUT);
    expect(error.getResponse()).toMatchObject({ code: 'DEEPSEEK_TIMEOUT' });
  });

  it('未配置模型时返回 503 DEEPSEEK_NOT_CONFIGURED', async () => {
    const model: ChatModel = {
      name: 'unconfigured',
      complete: async () => {
        throw new AgentModelError('DEEPSEEK_NOT_CONFIGURED', '未配置 API Key。', {
          retryable: false,
        });
      },
    };
    const service = createService(model);

    const error = await captureHttpError(service.run(createRequest(), { requestId: 'req_503' }));

    expect(error.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(error.getResponse()).toMatchObject({ code: 'DEEPSEEK_NOT_CONFIGURED' });
  });
});
