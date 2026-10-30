import { HttpException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { AgentService } from '../src/agent/agent.service';
import { AGENT_TURN_CONTRACT_VERSION } from '../src/agent/agent.types';
import type { ContractDraft } from '../src/agent/agent.types';
import type {
  AgentProvider,
  AgentProviderExtractResult,
} from '../src/agent/provider/agent-provider.interface';

function emptyDraft(): ContractDraft {
  return {
    storeName: '',
    category: '',
    businessHours: '',
    fulfillment: { dineIn: false, takeaway: false },
    dishes: [],
  };
}

function makeRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: AGENT_TURN_CONTRACT_VERSION,
    utterance: '店名叫松月食堂',
    draft: emptyDraft(),
    client: { surface: 'desktop', phase: 'store-info' },
    projectId: null,
    ...overrides,
  };
}

function stubProvider(result: Partial<AgentProviderExtractResult>): AgentProvider {
  return {
    name: 'deepseek',
    async extractTurn() {
      return {
        reply: result.reply ?? '已记录。',
        draftPatch: result.draftPatch ?? {},
        model: result.model ?? 'deepseek-chat',
        latencyMs: result.latencyMs ?? 1,
      };
    },
  };
}

function completePatch(): Record<string, unknown> {
  return {
    storeName: '松月食堂',
    category: '社区餐馆',
    businessHours: '10:00-21:00',
    fulfillment: { dineIn: true, takeaway: true },
    dishes: [
      { id: 'dish-1', name: '宫保鸡丁', priceCents: 2800, description: '' },
      { id: 'dish-2', name: '番茄炒蛋', priceCents: 1600, description: '' },
      { id: 'dish-3', name: '米饭', priceCents: 300, description: '' },
    ],
  };
}

async function expectRejection(
  promise: Promise<unknown>,
  status: number,
  code: string,
): Promise<void> {
  let caught: unknown = null;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(HttpException);
  const httpError = caught as HttpException;
  expect(httpError.getStatus()).toBe(status);
  expect((httpError.getResponse() as Record<string, unknown>).code).toBe(code);
}

describe('AgentService 单轮编排', () => {
  it('T1 正常模型补丁被转换为完整的 agent-turn.v1 响应', async () => {
    const service = new AgentService(stubProvider({ reply: '资料齐了', draftPatch: completePatch() }));
    const response = await service.handleTurn(makeRequest(), { requestId: 'req_test_0001' });

    expect(response.contractVersion).toBe(AGENT_TURN_CONTRACT_VERSION);
    expect(response.turnId).toMatch(/^turn-[0-9a-f-]{36}$/);
    expect(response.status).toBe('reviewing');
    expect(response.reply).toBe('资料齐了');
    expect(response.missingFields).toEqual([]);
    expect(response.errors).toEqual([]);
    expect(response.nextQuestion).toBeNull();
    expect(response.meta).toMatchObject({
      transport: 'http',
      provider: 'deepseek',
      mock: false,
      model: 'deepseek-chat',
    });
    expect(response.meta.mock).toBe(false);
    expect(response.meta.latencyMs).toBeGreaterThanOrEqual(0);
    expect(response.draft).toEqual(completePatch());
  });

  it('T4 模型返回的未知字段被丢弃，只保留白名单字段', async () => {
    const patch = {
      ...completePatch(),
      evil: 'rm -rf /',
      status: 'reviewing',
      missingFields: [],
      readyForReview: true,
      dishes: completePatch().dishes,
    };
    const service = new AgentService(stubProvider({ reply: '好的', draftPatch: patch }));
    const response = await service.handleTurn(makeRequest(), { requestId: 'req_test_0002' });

    expect(Object.keys(response.draft).sort()).toEqual(
      ['businessHours', 'category', 'dishes', 'fulfillment', 'storeName'].sort(),
    );
    expect(response.draft).not.toHaveProperty('evil');
    const firstDish = response.draft.dishes[0] as unknown as Record<string, unknown>;
    expect(Object.keys(firstDish).sort()).toEqual(['description', 'id', 'name', 'priceCents'].sort());
    expect(response.status).toBe('reviewing');
  });

  it('T5 模型返回非法价格时报告 PRICE_INVALID，响应中投影为 null', async () => {
    const patch = completePatch();
    (patch.dishes as Array<Record<string, unknown>>)[0].priceCents = 28.5;
    const service = new AgentService(stubProvider({ reply: '好的', draftPatch: patch }));
    const response = await service.handleTurn(makeRequest(), { requestId: 'req_test_0003' });

    expect(response.status).toBe('collecting');
    expect(response.errors.map((error) => error.code)).toContain('PRICE_INVALID');
    expect(response.draft.dishes[0].priceCents).toBeNull();
    expect(response.nextQuestion?.field).toBe('dishes[0].priceCents');
  });

  it('T11 缺营业时间时返回 collecting 与营业时间追问', async () => {
    const patch = completePatch();
    patch.businessHours = '';
    const service = new AgentService(stubProvider({ reply: '还差营业时间', draftPatch: patch }));
    const response = await service.handleTurn(makeRequest(), { requestId: 'req_test_0004' });

    expect(response.status).toBe('collecting');
    expect(response.missingFields.map((item) => item.field)).toContain('businessHours');
    expect(response.nextQuestion).toMatchObject({ field: 'businessHours' });
    expect(response.errors).toEqual([]);
  });

  it('T12 资料完整时返回 reviewing，nextQuestion 为 null', async () => {
    const service = new AgentService(stubProvider({ reply: '资料齐了', draftPatch: completePatch() }));
    const response = await service.handleTurn(
      makeRequest({ draft: completePatch() }),
      { requestId: 'req_test_0005' },
    );
    expect(response.status).toBe('reviewing');
    expect(response.nextQuestion).toBeNull();
    expect(response.meta.mock).toBe(false);
  });

  it('服务端不信任请求里的 status / missingFields / errors / readyForReview', async () => {
    const service = new AgentService(stubProvider({ reply: '好的', draftPatch: {} }));
    const response = await service.handleTurn(
      makeRequest({
        status: 'reviewing',
        missingFields: [],
        errors: [],
        readyForReview: true,
      }),
      { requestId: 'req_test_0006' },
    );
    // 空草稿 + 空补丁 → 必须 collecting，且缺项由服务端重新计算。
    expect(response.status).toBe('collecting');
    expect(response.missingFields.length).toBeGreaterThanOrEqual(4);
    expect(response.nextQuestion).not.toBeNull();
  });

  it('模型没有给可用回复时使用后端兜底文案', async () => {
    const service = new AgentService(stubProvider({ reply: '   ', draftPatch: {} }));
    const response = await service.handleTurn(makeRequest(), { requestId: 'req_test_0007' });
    expect(response.reply.length).toBeGreaterThan(0);
    expect(response.reply).toContain('草稿');
  });
});

describe('AgentService 请求校验', () => {
  it('contractVersion 不匹配返回 400 AGENT_CONTRACT_MISMATCH', async () => {
    const service = new AgentService(stubProvider({}));
    await expectRejection(
      service.handleTurn(makeRequest({ contractVersion: 'agent-turn.v0' }), { requestId: 'req_x' }),
      400,
      'AGENT_CONTRACT_MISMATCH',
    );
  });

  it('utterance 为空或超过 500 字返回 400', async () => {
    const service = new AgentService(stubProvider({}));
    await expectRejection(
      service.handleTurn(makeRequest({ utterance: '   ' }), { requestId: 'req_x' }),
      400,
      'UTTERANCE_INVALID',
    );
    await expectRejection(
      service.handleTurn(makeRequest({ utterance: '店'.repeat(501) }), { requestId: 'req_x' }),
      400,
      'UTTERANCE_INVALID',
    );
  });

  it('draft 非对象返回 400 DRAFT_INVALID', async () => {
    const service = new AgentService(stubProvider({}));
    await expectRejection(
      service.handleTurn(makeRequest({ draft: 'not-an-object' }), { requestId: 'req_x' }),
      400,
      'DRAFT_INVALID',
    );
  });

  it('client 不合法返回 400 CLIENT_INVALID', async () => {
    const service = new AgentService(stubProvider({}));
    await expectRejection(
      service.handleTurn(makeRequest({ client: { surface: 'mini-program', phase: 'store-info' } }), { requestId: 'req_x' }),
      400,
      'CLIENT_INVALID',
    );
  });

  it('本轮 projectId 非 null 返回 400 PROJECT_ID_INVALID', async () => {
    const service = new AgentService(stubProvider({}));
    await expectRejection(
      service.handleTurn(makeRequest({ projectId: 'project-1' }), { requestId: 'req_x' }),
      400,
      'PROJECT_ID_INVALID',
    );
  });
});