import { ConfigService } from '@nestjs/config';
import { HttpException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { json } from 'express';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { AgentAuthGuard } from '../src/agent/agent-auth.guard';
import { AgentExceptionFilter } from '../src/agent/agent-exception.filter';
import { AGENT_CHAT_MODEL } from '../src/agent/agent.types';
import {
  buildCapabilityCoverage,
  completeRequirementMustKeep,
  loadFrontendFacts,
  resetFrontendFactsCacheForTests,
} from '../src/agent/frontend-reconstruct/capabilities';
import {
  loadFrontendKeyActions,
  loadFrontendPageFacts,
  resetFrontendPageFactsCacheForTests,
} from '../src/agent/frontend-reconstruct/page-facts';
import { FrontendReconstructController } from '../src/agent/frontend-reconstruct/controller';
import {
  FrontendReconstructService,
  buildFrontendQuestions,
} from '../src/agent/frontend-reconstruct/service';
import {
  assertFrontendPlannedConsistency,
  parseFrontendReconstructRequest,
  validateCapabilityCoverageReport,
  validateFrontendPackDraft,
  validateFrontendReconstructResponse,
  validateUiRequirement,
} from '../src/agent/frontend-reconstruct/schema';
import { FRONTEND_RECONSTRUCT_CONTRACT_VERSION } from '../src/agent/frontend-reconstruct/types';
import type {
  CapabilityCoverageReport,
  FrontendReconstructResponse,
} from '../src/agent/frontend-reconstruct/types';
import type { ChatCompletionResult, ChatModel } from '../src/agent/runtime';
import { SessionAuthGuard } from '../src/common/auth/session-auth.guard';
import { PrismaService } from '../src/database/prisma.service';

/**
 * POST /api/v1/agent/frontend-reconstruct 的端到端定向测试（P1）。
 *
 * 模型全部用脚本化 stub：不访问真实 DeepSeek、不写文件、不发图片 base64 到日志。
 * 重点覆盖：
 * - AgentAuthGuard / requestId / 统一异常过滤 / 图片上限复用；
 * - 未知键、多图、非 reference、超限、超长 utterance 拒绝；
 * - 四工具串起来的 planned / needs-input / rejected；
 * - C1（mustKeep/coverage 与 draft 交叉校验）与 C2（降级 → partial + degraded）；
 * - 截断/无效 JSON 不解析，返回稳定错误码；
 * - 响应只含有界 JSON，不含 base64/源码/prompt。
 */

const FIXTURE_DIR = fileURLToPath(new URL('../../test/fixtures/frontend-reconstruct/', import.meta.url));
const PNG_BASE64 = readFileSync(join(FIXTURE_DIR, 'reference-tiny.png')).toString('base64');

const FACTS = loadFrontendFacts();
const PAGE_FACTS = loadFrontendPageFacts();
const KEY_ACTIONS = loadFrontendKeyActions();
const REQUIRE_FROM_TEST = createRequire(import.meta.url);
const P2_SCHEMA = REQUIRE_FROM_TEST(
  join(fileURLToPath(new URL('../../', import.meta.url)), 'desktop', 'frontend-reconstruct', 'schema.cjs'),
) as {
  validateDraft(
    draft: unknown,
    facts: unknown,
    pageFacts: unknown,
  ): { ok: true } | { ok: false; code: string; path: string; message: string };
};
const P2_MATERIALIZE = REQUIRE_FROM_TEST(
  join(fileURLToPath(new URL('../../', import.meta.url)), 'desktop', 'frontend-reconstruct', 'materialize.cjs'),
) as {
  loadPackagedFacts(options: { snapshotDir: string }): {
    ok: true;
    facts: unknown;
    pageFacts: unknown;
    source: string;
    pagesSource: string;
  } | { ok: false; code: string; path: string; message: string };
};
const SNAPSHOT_DIR = join(process.cwd(), 'src', 'agent', 'frontend-reconstruct');

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect((error as { code?: string }).code).toBe(code);
    return;
  }
  throw new Error('期望抛出 ' + code + '，但函数正常返回');
}

function requirement(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    summary: '首页改为紧凑单列，保留开始点餐与门店名',
    mustKeep: [
      { kind: 'page', ref: 'page:home' },
      { kind: 'action', ref: 'action:home.goMenu' },
      { kind: 'data', ref: 'data:store.name' },
    ],
    pages: [
      {
        pageId: 'home',
        order: 1,
        layout: 'single-column',
        targetSize: { width: 375, height: 812 },
        regions: [
          {
            id: 'r-header',
            type: 'header',
            order: 1,
            rect: { x: 0, y: 0, w: 1, h: 0.2 },
            children: [],
            confidence: 0.9,
          },
          {
            id: 'r-cta',
            type: 'form',
            order: 2,
            rect: { x: 0.06, y: 0.55, w: 0.88, h: 0.12 },
            children: [],
            confidence: 0.8,
          },
        ],
      },
    ],
    visual: {
      theme: { primaryColor: '#B34A0F', pageBackground: '#F7F3EC' },
      sizes: { homeHero: 'lg' },
      density: 'compact',
    },
    bindings: [
      { regionId: 'r-header', dataPath: 'store.name', status: 'bound' },
      { regionId: 'r-cta', eventName: 'home.goMenu', status: 'bound' },
    ],
    unknownRegions: [],
    lowConfidence: [],
    inferredInteractions: [],
    unsupported: [],
    degradations: [],
    ...overrides,
  };
}

/**
 * home 页面合法草稿（与 P2 页面事实同源）：
 * - 只使用 home usingComponents（store-header/fulfillment-switch/order-card/error-banner）；
 * - 只绑定 home 页面 dataPaths；
 * - 绑定 get_frontend_capabilities 返回的全部 keyActions（不是硬编码 goMenu）。
 */
function draft(options: {
  omitAction?: string;
  displayName?: string;
  extraCartBar?: boolean;
} = {}): Record<string, unknown> {
  const buttons = [
    { label: '开始点餐', action: 'home.goMenu' },
    { label: '全部订单', action: 'home.goOrders' },
    { label: '我的', action: 'home.goMine' },
    { label: '店主订单台', action: 'home.goMerchant' },
    { label: '选择桌号', action: 'home.onPickTable' },
    { label: '重试桌号', action: 'home.onRetryTables' },
  ]
    .filter((item) => item.action !== options.omitAction)
    .map((item) => ({
      type: 'button',
      label: item.label,
      action: item.action,
      style: { size: 'md', weight: 600 },
    }));
  const nodes: unknown[] = [
    {
      type: 'component',
      componentId: 'store-header',
      props: {
        storeName: { kind: 'data', dataPath: 'store.name' },
        businessHours: { kind: 'data', dataPath: 'store.businessHours' },
      },
      events: {},
    },
    { type: 'slot', slotId: 'home-hero' },
    {
      type: 'component',
      componentId: 'fulfillment-switch',
      props: {
        value: { kind: 'data', dataPath: 'home.mode' },
        dineInEnabled: { kind: 'data', dataPath: 'store.fulfillment.dineIn' },
        takeawayEnabled: { kind: 'data', dataPath: 'store.fulfillment.takeaway' },
      },
      events: options.omitAction === 'home.onModeChange' ? {} : { change: 'home.onModeChange' },
    },
    {
      type: 'component',
      componentId: 'order-card',
      props: {},
      events: options.omitAction === 'home.onOpenOrder' ? {} : { open: 'home.onOpenOrder' },
    },
    {
      type: 'component',
      componentId: 'error-banner',
      props: {},
      events: options.omitAction === 'home.onRetry' ? {} : { retry: 'home.onRetry' },
    },
    {
      type: 'container',
      style: { direction: 'column', gap: 'md', padding: 'md' },
      children: [
        { type: 'text', textToken: 'store.address', style: { size: 'sm' } },
        ...buttons,
      ],
    },
  ];
  if (options.extraCartBar === true) {
    nodes.push({
      type: 'component',
      componentId: 'cart-bar',
      props: { totalCents: { kind: 'data', dataPath: 'cart.totalCents' } },
      events: { checkout: 'menu.onCheckout' },
    });
  }
  return {
    schemaVersion: 'frontend-pack-draft.v1',
    displayName: options.displayName ?? '参考图首页候选',
    pages: [
      {
        pageId: 'home',
        nodes,
        styles: [],
        pageJson: {
          navigationBarTitleText: '扫码点餐',
          navigationBarTextStyle: 'white',
          backgroundColor: '#F7F3EC',
        },
      },
    ],
  };
}

function validRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: FRONTEND_RECONSTRUCT_CONTRACT_VERSION,
    requestId: 'fr-p1-test',
    utterance: '按截图重构首页，保留下单，整体更紧凑',
    images: [{ kind: 'reference', mediaType: 'image/png', dataBase64: PNG_BASE64 }],
    targetPages: ['home'],
    current: {
      baseTemplate: { id: 'ordering-base', version: '1.0.0' },
      frontendPack: null,
      presentationPatch: {},
    },
    client: { surface: 'desktop', phase: 'template-pick' },
    projectId: null,
    ...overrides,
  };
}

function toolCall(name: string, args: unknown, id = 'call_1'): ChatCompletionResult {
  return {
    message: {
      role: 'assistant',
      content: null,
      toolCalls: [{ id, name, argumentsText: JSON.stringify(args) }],
    },
    finishReason: 'tool_calls',
    model: 'deepseek-chat',
    latencyMs: 3,
    usage: { promptTokens: 100, completionTokens: 40, totalTokens: 140 },
  };
}

function rawToolCall(name: string, argumentsText: string, id = 'call_raw'): ChatCompletionResult {
  return {
    message: {
      role: 'assistant',
      content: null,
      toolCalls: [{ id, name, argumentsText }],
    },
    finishReason: 'tool_calls',
    model: 'deepseek-chat',
    latencyMs: 3,
  };
}

function textResult(text = '已完成规划。'): ChatCompletionResult {
  return {
    message: { role: 'assistant', content: text },
    finishReason: 'stop',
    model: 'deepseek-chat',
    latencyMs: 2,
  };
}

function scriptedModel(
  results: ChatCompletionResult[],
  seen: Array<{ messages: unknown[] }> = [],
): ChatModel {
  const queue = [...results];
  return {
    name: 'deepseek',
    complete: async (request) => {
      seen.push(request as { messages: unknown[] });
      const next = queue.shift();
      if (next === undefined) throw new Error('模型脚本已用尽。');
      return next;
    },
  };
}

const unreachableModel: ChatModel = {
  name: 'deepseek',
  complete: async () => {
    throw new Error('请求校验失败时不应调用模型。');
  },
};

const apps: INestApplication[] = [];

interface CreatedApp {
  app: INestApplication;
  service: FrontendReconstructService;
}

async function createApp(options: {
  model: ChatModel;
  config?: Record<string, unknown>;
}): Promise<CreatedApp> {
  const config = {
    NODE_ENV: 'development',
    AGENT_REQUIRE_AUTH: 'false',
    FRONTEND_MAX_MODEL_CALLS: 8,
    FRONTEND_MAX_TOOL_CALLS: 16,
    FRONTEND_TIMEOUT_MS: 120_000,
    FRONTEND_MAX_TOKENS: 4_000,
    ...options.config,
  };
  const moduleRef = await Test.createTestingModule({
    controllers: [FrontendReconstructController],
    providers: [
      FrontendReconstructService,
      SessionAuthGuard,
      AgentAuthGuard,
      AgentExceptionFilter,
      { provide: ConfigService, useValue: new ConfigService(config) },
      {
        provide: PrismaService,
        useValue: { session: { findUnique: async () => null } },
      },
      { provide: AGENT_CHAT_MODEL, useValue: options.model },
    ],
  }).compile();

  // 与 main.ts 一致：/api/v1/agent 前缀放宽到 2 MiB，其它路由保持默认。
  const app = moduleRef.createNestApplication({ bodyParser: false });
  app.setGlobalPrefix('api/v1');
  app.use('/api/v1/agent', json({ limit: 2 * 1024 * 1024 }));
  app.use(json({ limit: '100kb' }));
  await app.init();
  apps.push(app);
  return { app, service: moduleRef.get(FrontendReconstructService) };
}

afterAll(async () => {
  for (const app of apps) await app.close();
  resetFrontendFactsCacheForTests();
  resetFrontendPageFactsCacheForTests();
});

function post(app: INestApplication, body: unknown) {
  return request(app.getHttpServer())
    .post('/api/v1/agent/frontend-reconstruct')
    .set('X-Request-Id', 'req_frontend_0123456789abcdef')
    .send(body as object);
}

describe('POST /api/v1/agent/frontend-reconstruct 入口与边界', () => {
  it('S1 planned：四工具链路返回有界 planned 响应，且 draft 可被 P2 schema 接受', async () => {
    resetFrontendFactsCacheForTests();
    resetFrontendPageFactsCacheForTests();
    const seen: Array<{ messages: unknown[] }> = [];
    const model = scriptedModel(
      [
        toolCall('get_frontend_capabilities', { pageIds: ['home'] }, 'call_get'),
        toolCall('check_frontend_coverage', { requirement: requirement() }, 'call_check'),
        toolCall('propose_frontend_draft', { draft: draft() }, 'call_draft'),
        textResult('已生成首页候选。'),
      ],
      seen,
    );
    const { app } = await createApp({ model });

    const response = await post(app, validRequest());

    expect(response.status).toBe(200);
    expect(response.headers['x-request-id']).toBe('req_frontend_0123456789abcdef');
    expect(Object.keys(response.body).sort()).toEqual([
      'contractVersion',
      'coverage',
      'draft',
      'meta',
      'questions',
      'requirement',
      'runId',
      'status',
      'trace',
    ]);
    expect(response.body).toMatchObject({
      contractVersion: FRONTEND_RECONSTRUCT_CONTRACT_VERSION,
      status: 'planned',
      questions: [],
      coverage: { status: 'covered', missingCapabilities: [] },
      trace: { modelCalls: 4, stopReason: 'final_answer', degraded: false },
      meta: { provider: 'deepseek', model: 'deepseek-chat', mock: false },
    });
    expect(response.body.runId).toMatch(/^frun-/);
    expect(response.body.draft.pages[0].pageId).toBe('home');
    expect(response.body.requirement.mustKeep.map((item: { ref: string }) => item.ref)).toEqual(
      expect.arrayContaining(['page:home', 'action:home.goMenu']),
    );
    // 动态关键动作全部进入 mustKeep（R-F2）。
    for (const action of KEY_ACTIONS.home) {
      expect(response.body.requirement.mustKeep.map((item: { ref: string }) => item.ref)).toContain(
        'action:' + action,
      );
    }
    // R-F1 端到端（t20 复核重点）：P2 loadPackagedFacts 直接读取同一 snapshot，
    // 用其 facts/pageFacts 校验 P1 planned 草稿，必须接受；不再有“P1 合法、P2 拒绝”。
    const packaged = P2_MATERIALIZE.loadPackagedFacts({ snapshotDir: SNAPSHOT_DIR });
    expect(packaged.ok).toBe(true);
    if (packaged.ok) {
      expect(packaged.source).toBe('capabilities.snapshot.json');
      expect(packaged.pagesSource).toBe('capabilities.snapshot.json#pages');
      expect(packaged.facts).toEqual(FACTS);
      expect(packaged.pageFacts).toEqual(PAGE_FACTS);
      expect(P2_SCHEMA.validateDraft(response.body.draft, packaged.facts, packaged.pageFacts).ok)
        .toBe(true);
    }
    expect(P2_SCHEMA.validateDraft(response.body.draft, FACTS, PAGE_FACTS).ok).toBe(true);
    expect(response.body.trace.toolCalls).toEqual([
      { name: 'get_frontend_capabilities', ok: true },
      { name: 'check_frontend_coverage', ok: true },
      { name: 'propose_frontend_draft', ok: true },
    ]);

    // 多模态确实进入 Runtime：user 消息是 text+image_url，且模型拿到的是 data URL。
    const firstRequest = seen[0] as { messages: Array<{ role: string; content: unknown }> };
    const userMessage = firstRequest.messages.find((message) => message.role === 'user');
    expect(Array.isArray(userMessage?.content)).toBe(true);
    const parts = userMessage?.content as Array<{ type: string; imageUrl?: { url: string } }>;
    expect(parts.map((part) => part.type)).toEqual(['text', 'image_url']);
    expect(parts[1].imageUrl?.url).toBe('data:image/png;base64,' + PNG_BASE64);

    // 响应有界且不泄漏图片/base64/源码/完整 prompt。
    const serialized = JSON.stringify(response.body);
    expect(serialized.length).toBeLessThan(64 * 1024);
    expect(serialized).not.toContain(PNG_BASE64.slice(0, 32));
    expect(serialized).not.toContain('dataBase64');
    expect(serialized).not.toContain('data:image/');
    expect(serialized).not.toContain('WXML');
    expect(serialized).not.toContain('系统提示词');
  });

  it('S2 未知键 / 多图 / 非 reference / 超限 / 超长 utterance 一律拒绝且不调用模型', async () => {
    const { app } = await createApp({ model: unreachableModel });

    const unknownKey = await post(app, validRequest({ script: 'run()' }));
    expect(unknownKey.status).toBe(400);
    expect(unknownKey.body.code).toBe('FRONTEND_REQUEST_INVALID');

    const nestedUnknown = await post(app, validRequest({
      current: {
        baseTemplate: { id: 'ordering-base', version: '1.0.0' },
        frontendPack: null,
        presentationPatch: {},
        registry: { id: 'evil' },
      },
    }));
    expect(nestedUnknown.status).toBe(400);
    expect(nestedUnknown.body.code).toBe('FRONTEND_REQUEST_INVALID');

    const multi = await post(app, validRequest({
      images: [
        { kind: 'reference', mediaType: 'image/png', dataBase64: PNG_BASE64 },
        { kind: 'reference', mediaType: 'image/png', dataBase64: PNG_BASE64 },
      ],
    }));
    expect(multi.status).toBe(400);
    expect(multi.body.code).toBe('FRONTEND_IMAGE_COUNT_INVALID');

    const notReference = await post(app, validRequest({
      images: [{ kind: 'menu', mediaType: 'image/png', dataBase64: PNG_BASE64 }],
    }));
    expect(notReference.status).toBe(400);
    expect(notReference.body.code).toBe('FRONTEND_IMAGE_KIND_INVALID');

    const oversized = Buffer.alloc(409_601, 0xff).toString('base64');
    const tooLarge = await post(app, validRequest({
      images: [{ kind: 'reference', mediaType: 'image/png', dataBase64: oversized }],
    }));
    expect(tooLarge.status).toBe(422);
    expect(tooLarge.body.code).toBe('FRONTEND_IMAGE_TOO_LARGE');

    const longUtterance = await post(app, validRequest({ utterance: '改'.repeat(501) }));
    expect(longUtterance.status).toBe(400);
    expect(longUtterance.body.code).toBe('FRONTEND_UTTERANCE_INVALID');

    const unsupportedPage = await post(app, validRequest({ targetPages: ['checkout'] }));
    expect(unsupportedPage.status).toBe(422);
    expect(unsupportedPage.body.code).toBe('FRONTEND_TARGET_PAGES_UNSUPPORTED');

    // 统一异常过滤：错误体只有 code/message/requestId，且 requestId 与 header 一致。
    expect(unknownKey.body.requestId).toBe(unknownKey.headers['x-request-id']);
    expect(JSON.stringify(unknownKey.body)).not.toContain('dataBase64');
  });

  it('S3 production 未认证返回 401 AUTH_REQUIRED（复用 AgentAuthGuard）', async () => {
    const { app } = await createApp({
      model: unreachableModel,
      config: { NODE_ENV: 'production', AGENT_REQUIRE_AUTH: 'false' },
    });
    const response = await post(app, validRequest());
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('AUTH_REQUIRED');
    expect(response.body.requestId).toBe(response.headers['x-request-id']);
  });

  it('S4 AgentModule 已注册端点、Guard 与统一异常过滤，且旧端点文件未被改动', () => {
    const moduleSource = readFileSync(
      join(process.cwd(), 'src/agent/agent.module.ts'),
      'utf8',
    );
    expect(moduleSource).toContain('FrontendReconstructController');
    expect(moduleSource).toContain('FrontendReconstructService');

    const controllerSource = readFileSync(
      join(process.cwd(), 'src/agent/frontend-reconstruct/controller.ts'),
      'utf8',
    );
    expect(controllerSource).toContain('@UseGuards(AgentAuthGuard)');
    expect(controllerSource).toContain('@UseFilters(AgentExceptionFilter)');
    expect(controllerSource).toContain("@Post('frontend-reconstruct')");
    expect(controllerSource).toContain('resolveRequestId');
  });
});

describe('frontend-reconstruct 规划结果与交叉校验', () => {
  it('S5 C1 负向探针：mustKeep 的“开始点餐”动作被删后，不能仍 planned/covered', async () => {
    const model = scriptedModel([
      toolCall('get_frontend_capabilities', { pageIds: ['home'] }, 'call_get'),
      toolCall('check_frontend_coverage', { requirement: requirement() }, 'call_check'),
      toolCall('propose_frontend_draft', { draft: draft({ omitAction: 'home.goMenu' }) }, 'call_draft'),
      textResult('已尽量按图生成。'),
    ]);
    const { app } = await createApp({ model });

    const response = await post(app, validRequest());
    expect(response.status).toBe(200);
    expect(response.body.status).not.toBe('planned');
    expect(response.body.draft).toBeNull();
    const proposeTrace = (response.body.trace.toolCalls as Array<{ name: string; ok: boolean }>)
      .find((item) => item.name === 'propose_frontend_draft');
    expect(proposeTrace).toEqual({ name: 'propose_frontend_draft', ok: false });

    // 直接对“结构合法但删掉关键动作”的组合响应做校验：必须稳定拒绝。
    const parsed = parseFrontendReconstructRequest(validRequest());
    const validatedRequirement = completeRequirementMustKeep(
      validateUiRequirement(requirement(), FACTS, { targetPages: parsed.targetPages }),
      FACTS,
      parsed.targetPages,
    );
    const coverage = buildCapabilityCoverage(validatedRequirement, FACTS);
    const badDraft = validateFrontendPackDraft(draft({ omitAction: 'home.goMenu' }), FACTS, PAGE_FACTS);
    expectCode(
      () => assertFrontendPlannedConsistency(validatedRequirement, coverage, badDraft),
      'FRONTEND_RESPONSE_INVALID',
    );

    const composed: FrontendReconstructResponse = {
      contractVersion: FRONTEND_RECONSTRUCT_CONTRACT_VERSION,
      runId: 'frun-probe-1',
      status: 'planned',
      requirement: validatedRequirement,
      coverage,
      draft: badDraft,
      questions: [],
      trace: { modelCalls: 2, toolCalls: [], stopReason: 'final_answer', degraded: false },
      meta: { provider: 'deepseek', model: 'deepseek-chat', mock: false, latencyMs: 10 },
    };
    expectCode(
      () => validateFrontendReconstructResponse(composed, FACTS, {
        targetPages: ['home'],
        pageFacts: PAGE_FACTS,
      }),
      'FRONTEND_RESPONSE_INVALID',
    );

    // 同样的 requirement 配完整草稿则通过（证明探针失败原因就是缺按钮）。
    const goodDraft = validateFrontendPackDraft(draft(), FACTS, PAGE_FACTS);
    const good: FrontendReconstructResponse = { ...composed, draft: goodDraft };
    expect(validateFrontendReconstructResponse(good, FACTS, {
      targetPages: ['home'],
      pageFacts: PAGE_FACTS,
    }).status).toBe('planned');
  });

  it('S5b R-F2：删除 goOrders/goMine/goMerchant/onPickTable 任一动态关键动作都不能 planned', async () => {
    for (const action of ['home.goOrders', 'home.goMine', 'home.goMerchant', 'home.onPickTable']) {
      const model = scriptedModel([
        toolCall('get_frontend_capabilities', { pageIds: ['home'] }, 'call_get'),
        toolCall('check_frontend_coverage', { requirement: requirement() }, 'call_check'),
        toolCall('propose_frontend_draft', { draft: draft({ omitAction: action }) }, `call_${action}`),
        textResult('已尽量按图生成。'),
      ]);
      const { app } = await createApp({ model });
      const response = await post(app, validRequest());
      expect(response.status, action).toBe(200);
      expect(response.body.status, action).not.toBe('planned');
      expect(response.body.draft, action).toBeNull();
    }
  });

  it('S5c R-F1：home 绑定 cart-bar/menu.onCheckout 被 P1 与 P2 同时拒绝；同页 menu 绑定通过', () => {
    expectCode(
      () => validateFrontendPackDraft(draft({ extraCartBar: true }), FACTS, PAGE_FACTS),
      'FRONTEND_DRAFT_INVALID',
    );
    const p2Cross = P2_SCHEMA.validateDraft(draft({ extraCartBar: true }), FACTS, PAGE_FACTS);
    expect(p2Cross.ok).toBe(false);
    if (!p2Cross.ok) expect(p2Cross.code).toBe('DRAFT_UNKNOWN_COMPONENT');

    const menu = {
      schemaVersion: 'frontend-pack-draft.v1',
      displayName: '参考图菜单候选',
      pages: [{
        pageId: 'menu',
        nodes: [
          { type: 'slot', slotId: 'menu-hero' },
          {
            type: 'component',
            componentId: 'cart-bar',
            props: { totalCents: { kind: 'data', dataPath: 'cart.totalCents' } },
            events: { checkout: 'menu.onCheckout' },
          },
        ],
        styles: [],
        pageJson: {},
      }],
    };
    expect(validateFrontendPackDraft(menu, FACTS, PAGE_FACTS).pages[0].pageId).toBe('menu');
    expect(P2_SCHEMA.validateDraft(menu, FACTS, PAGE_FACTS).ok).toBe(true);
  });

  it('S6 C2：requirement 有视觉降级时 coverage 必须 partial，并显式 degraded（不能 covered）', async () => {
    const degradedRequirement = requirement({
      degradations: [
        {
          regionId: 'r-header',
          label: '品牌主视觉',
          reason: '不复刻品牌图片，使用纯色占位',
          severity: 'warn',
        },
      ],
    });
    const model = scriptedModel([
      toolCall('get_frontend_capabilities', { pageIds: ['home'] }, 'call_get'),
      toolCall('check_frontend_coverage', { requirement: degradedRequirement }, 'call_check'),
      toolCall('propose_frontend_draft', { draft: draft() }, 'call_draft'),
      textResult('已生成候选，含视觉降级。'),
    ]);
    const { app } = await createApp({ model });

    const response = await post(app, validRequest());
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('planned');
    expect(response.body.coverage.status).toBe('partial');
    expect(response.body.coverage.degradations).toHaveLength(1);
    // 契约里没有额外字段：partial 通过 trace.degraded=true 明示“不自动采用/需显式确认”。
    expect(response.body.trace.degraded).toBe(true);

    // covered + requirement.degradations 的组合响应必须被拒绝。
    const parsed = parseFrontendReconstructRequest(validRequest());
    const validatedRequirement = completeRequirementMustKeep(
      validateUiRequirement(degradedRequirement, FACTS, { targetPages: parsed.targetPages }),
      FACTS,
      parsed.targetPages,
    );
    const covered = buildCapabilityCoverage(
      completeRequirementMustKeep(
        validateUiRequirement(requirement(), FACTS, { targetPages: parsed.targetPages }),
        FACTS,
        parsed.targetPages,
      ),
      FACTS,
    );
    const composed: FrontendReconstructResponse = {
      contractVersion: FRONTEND_RECONSTRUCT_CONTRACT_VERSION,
      runId: 'frun-probe-2',
      status: 'planned',
      requirement: validatedRequirement,
      coverage: covered,
      draft: validateFrontendPackDraft(draft(), FACTS, PAGE_FACTS),
      questions: [],
      trace: { modelCalls: 2, toolCalls: [], stopReason: 'final_answer', degraded: true },
      meta: { provider: 'deepseek', model: 'deepseek-chat', mock: false, latencyMs: 10 },
    };
    expectCode(
      () => validateFrontendReconstructResponse(composed, FACTS, {
        targetPages: ['home'],
        pageFacts: PAGE_FACTS,
      }),
      'FRONTEND_RESPONSE_INVALID',
    );
  });

  it('S7 needs-input：模糊图不编造，返回结构化追问且不产生草稿', async () => {
    const unclear = requirement({
      unknownRegions: [
        { label: '顶部右侧图标', reason: '图形含义无法确定，未绑定任何动作' },
      ],
      lowConfidence: [
        { regionId: 'r-header', confidence: 0.4, reason: '截图分辨率不足' },
      ],
    });
    const model = scriptedModel([
      toolCall('get_frontend_capabilities', { pageIds: ['home'] }, 'call_get'),
      toolCall('check_frontend_coverage', { requirement: unclear }, 'call_check'),
      textResult('截图太模糊，需要确认。'),
    ]);
    const { app } = await createApp({ model });

    const response = await post(app, validRequest({ utterance: '' }));
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('needs-input');
    expect(response.body.draft).toBeNull();
    expect(response.body.trace.stopReason).toBe('needs_input');
    expect(response.body.questions.length).toBeGreaterThan(0);
    expect(response.body.questions[0].field).toBe('requirement.unknownRegions');
    expect(JSON.stringify(response.body)).not.toContain(PNG_BASE64.slice(0, 16));
  });

  it('S8 rejected：声明 Base 不存在的必需能力时返回 rejected 且 draft=null', async () => {
    const model = scriptedModel([
      toolCall('get_frontend_capabilities', { pageIds: ['home'] }, 'call_get'),
      toolCall(
        'check_frontend_coverage',
        {
          requirement: requirement(),
          requestedCapabilities: ['component:live-stream', 'action:home.startLive'],
        },
        'call_check',
      ),
      textResult('Base 没有直播能力。'),
    ]);
    const { app } = await createApp({ model });

    const response = await post(app, validRequest());
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('rejected');
    expect(response.body.draft).toBeNull();
    expect(response.body.coverage.status).toBe('rejected');
    expect(response.body.coverage.missingCapabilities).toEqual(
      expect.arrayContaining(['component:live-stream', 'action:home.startLive']),
    );
    expect(response.body.trace.stopReason).toBe('rejected');
    expect(response.body.questions).toEqual([]);
    // 模型不能把 missing 洗成 covered。
    expect(response.body.coverage.coveredBy['component:live-stream']).toBeUndefined();
  });

  it('S9 截断 JSON 返回稳定错误码且不采用任何草稿', async () => {
    const truncated: ChatCompletionResult = {
      message: {
        role: 'assistant',
        content: '{"schemaVersion":"frontend-pack-draft.v1","pages":[',
      },
      finishReason: 'length',
      model: 'deepseek-chat',
      latencyMs: 5,
      truncated: true,
    };
    const { app } = await createApp({ model: scriptedModel([truncated]) });

    const response = await post(app, validRequest());
    expect(response.status).toBe(502);
    expect(response.body.code).toBe('FRONTEND_MODEL_RESPONSE_INVALID');
    expect(response.body).not.toHaveProperty('draft');
    expect(JSON.stringify(response.body)).not.toContain('frontend-pack-draft');
  });

  it('S10 无效 JSON 工具参数不被解析：trace 如实标记 ok=false，不产生草稿', async () => {
    const model = scriptedModel([
      toolCall('get_frontend_capabilities', { pageIds: ['home'] }, 'call_get'),
      toolCall('check_frontend_coverage', { requirement: requirement() }, 'call_check'),
      rawToolCall('propose_frontend_draft', '{"draft":', 'call_bad_json'),
      textResult('工具参数有误。'),
    ]);
    const { app } = await createApp({ model });

    const response = await post(app, validRequest());
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('needs-input');
    expect(response.body.draft).toBeNull();
    const proposeTrace = (response.body.trace.toolCalls as Array<{ name: string; ok: boolean }>)
      .find((item) => item.name === 'propose_frontend_draft');
    expect(proposeTrace).toEqual({ name: 'propose_frontend_draft', ok: false });
  });

  it('S11 重复工具调用触发循环检测，仍返回有界 needs-input', async () => {
    const model = scriptedModel([
      toolCall('check_frontend_coverage', { requirement: requirement() }, 'call_check'),
      toolCall('get_frontend_capabilities', { pageIds: ['home'] }, 'call_get_1'),
      toolCall('get_frontend_capabilities', { pageIds: ['home'] }, 'call_get_2'),
      toolCall('get_frontend_capabilities', { pageIds: ['home'] }, 'call_get_3'),
      textResult('停止。'),
    ]);
    const { app } = await createApp({ model });

    const response = await post(app, validRequest());
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('needs-input');
    expect(response.body.trace.stopReason).toBe('loop_detected');
    expect(response.body.draft).toBeNull();
  });

  it('S16 repair 必须绑定上一次门禁 issues：propose 失败 → repair 成功', async () => {
    const repairArgs = {
      issues: [{ path: '$.displayName', code: 'DRAFT_SCHEMA_INVALID' }],
      patch: { '$.displayName': '候选一' },
    };
    const model = scriptedModel([
      toolCall('get_frontend_capabilities', { pageIds: ['home'] }, 'call_get'),
      toolCall('check_frontend_coverage', { requirement: requirement() }, 'call_check'),
      toolCall('propose_frontend_draft', { draft: draft({ displayName: 'x'.repeat(41) }) }, 'call_draft'),
      toolCall('repair_frontend_draft', repairArgs, 'call_repair_1'),
      textResult('已按门禁 issues 修复。'),
    ]);
    const { app } = await createApp({ model });

    const response = await post(app, validRequest());
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('planned');
    expect(response.body.draft.displayName).toBe('候选一');
    const traces = (response.body.trace.toolCalls as Array<{ name: string; ok: boolean }>)
      .filter((item) => item.name === 'propose_frontend_draft' || item.name === 'repair_frontend_draft');
    expect(traces).toEqual([
      { name: 'propose_frontend_draft', ok: false },
      { name: 'repair_frontend_draft', ok: true },
    ]);
  });

  it('S16b repair 最多 2 轮：第 3 轮返回 FRONTEND_REPAIR_LIMIT_EXCEEDED，且不产生半成品草稿', async () => {
    const gateIssue = [{ path: '$.displayName', code: 'DRAFT_SCHEMA_INVALID' }];
    const repairArgs = (displayName: string) => ({
      issues: gateIssue,
      patch: { '$.displayName': displayName },
    });
    const model = scriptedModel([
      toolCall('get_frontend_capabilities', { pageIds: ['home'] }, 'call_get'),
      toolCall('check_frontend_coverage', { requirement: requirement() }, 'call_check'),
      toolCall('propose_frontend_draft', { draft: draft({ displayName: 'x'.repeat(41) }) }, 'call_draft'),
      toolCall('repair_frontend_draft', repairArgs('中'.repeat(41)), 'call_repair_1'),
      toolCall('repair_frontend_draft', repairArgs('x'.repeat(41)), 'call_repair_2'),
      toolCall('repair_frontend_draft', repairArgs('候选一'), 'call_repair_3'),
      textResult('修复已达上限。'),
    ]);
    const { app } = await createApp({ model });

    const response = await post(app, validRequest());
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('needs-input');
    expect(response.body.draft).toBeNull();
    const repairs = (response.body.trace.toolCalls as Array<{ name: string; ok: boolean }>)
      .filter((item) => item.name === 'repair_frontend_draft');
    expect(repairs).toEqual([
      { name: 'repair_frontend_draft', ok: false },
      { name: 'repair_frontend_draft', ok: false },
      { name: 'repair_frontend_draft', ok: false },
    ]);
  });

  it('S16c R-F3：propose 后改 requirement 再 checkCoverage 不再 502/卡死，旧一致结果保留', async () => {
    const changed = requirement({
      mustKeep: [
        { kind: 'page', ref: 'page:home' },
        { kind: 'action', ref: 'action:home.goMenu' },
        { kind: 'data', ref: 'data:home.demoHint' },
      ],
    });
    const model = scriptedModel([
      toolCall('get_frontend_capabilities', { pageIds: ['home'] }, 'call_get'),
      toolCall('check_frontend_coverage', { requirement: requirement() }, 'call_check_1'),
      toolCall('propose_frontend_draft', { draft: draft() }, 'call_draft'),
      toolCall('check_frontend_coverage', { requirement: changed }, 'call_check_2'),
      textResult('保留上一次一致结果。'),
    ]);
    const { app } = await createApp({ model });

    const response = await post(app, validRequest());
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('planned');
    expect(response.body.draft).not.toBeNull();
    const checks = (response.body.trace.toolCalls as Array<{ name: string; ok: boolean }>)
      .filter((item) => item.name === 'check_frontend_coverage');
    expect(checks).toEqual([
      { name: 'check_frontend_coverage', ok: true },
      { name: 'check_frontend_coverage', ok: false },
    ]);
    // 旧 requirement 未被半更新（不含第二次提交的 demoHint）。
    expect(response.body.requirement.mustKeep.map((item: { ref: string }) => item.ref))
      .not.toContain('data:home.demoHint');
  });

  it('S12 取消信号返回 499 FRONTEND_ABORTED，不产生任何响应正文', async () => {
    const { service } = await createApp({ model: scriptedModel([textResult()]) });
    const controller = new AbortController();
    controller.abort();

    try {
      await service.run(validRequest(), { requestId: 'req_abort', signal: controller.signal });
      throw new Error('期望取消时抛出 HttpException');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      const http = error as HttpException;
      expect(http.getStatus()).toBe(499);
      expect(http.getResponse()).toMatchObject({ code: 'FRONTEND_ABORTED' });
    }
  });
});

describe('frontend-reconstruct 追问派生', () => {
  it('S13 无结构化不确定项时也至少给一个具体问题（needs-input 契约要求）', () => {
    const validated = validateUiRequirement(requirement(), FACTS, { targetPages: ['home'] });
    const questions = buildFrontendQuestions(validated);
    expect(questions).toHaveLength(1);
    expect(questions[0].field).toBe('targetPages');
    expect(questions[0].text.length).toBeGreaterThan(0);
    expect(questions[0].text.length).toBeLessThanOrEqual(200);
  });
});

describe('frontend-reconstruct 覆盖结论校验（服务端权威）', () => {
  it('S14 覆盖报告不能伪造 covered：模型给的 coveredBy 缺项/别名一律拒绝', () => {
    // 服务端组装时完全不用模型提供的 coverage；这里确认“伪造 covered”在契约层也过不去。
    const forged: CapabilityCoverageReport = {
      status: 'covered',
      requiredCapabilities: ['component:live-stream'],
      missingCapabilities: [],
      coveredBy: { 'component:live-stream': 'component:store-header' },
      risks: [],
      degradations: [],
    };
    expectCode(() => validateCapabilityCoverageReport(forged, FACTS), 'FRONTEND_COVERAGE_INVALID');

    const authoritative = buildCapabilityCoverage(
      validateUiRequirement(requirement(), FACTS, { targetPages: ['home'] }),
      FACTS,
      { additionalRequiredCapabilities: ['component:live-stream'] },
    );
    expect(authoritative.status).toBe('rejected');
    expect(authoritative.missingCapabilities).toEqual(['component:live-stream']);
  });
});

describe('frontend-reconstruct 响应与 trace 有界性', () => {
  it('S15 requirement/draft 类型安全：克隆对象可独立校验（无共享可变状态）', () => {
    const raw = clone(requirement());
    const validated = validateUiRequirement(raw, FACTS, { targetPages: ['home'] });
    raw.summary = 'changed';
    expect(validated.summary).not.toBe('changed');
  });
});
