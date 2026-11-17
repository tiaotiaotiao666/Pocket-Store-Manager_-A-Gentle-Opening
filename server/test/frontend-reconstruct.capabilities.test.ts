import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildCapabilityCoverage,
  completeRequirementMustKeep,
  getFrontendKeyActions,
  loadFrontendFacts,
  projectFrontendCapabilities,
} from '../src/agent/frontend-reconstruct/capabilities';
import { FRONTEND_CAPABILITIES_SNAPSHOT } from '../src/agent/frontend-reconstruct/capabilities.snapshot';
import {
  loadFrontendFactsBundle,
  loadFrontendKeyActions,
  loadFrontendPageFacts,
} from '../src/agent/frontend-reconstruct/page-facts';
import { FRONTEND_RECONSTRUCT_SYSTEM_PROMPT } from '../src/agent/frontend-reconstruct/prompt';
import {
  assertFrontendPlannedConsistency,
  parseFrontendReconstructRequest,
  validateCapabilityCoverageReport,
  validateFrontendFacts,
  validateFrontendPackDraft,
  validateFrontendPackDraftForP1,
  validateFrontendReconstructResponse,
  validateFrontendReconstructResponseForP1,
  validateUiRequirement,
} from '../src/agent/frontend-reconstruct/schema';
import {
  adoptFrontendCandidate,
  createFrontendRunState,
  transitionFrontendRun,
  undoAdoptedFrontend,
} from '../src/agent/frontend-reconstruct/state';
import {
  CHECK_FRONTEND_COVERAGE_TOOL,
  GET_FRONTEND_CAPABILITIES_TOOL,
  PROPOSE_FRONTEND_DRAFT_TOOL,
  REPAIR_FRONTEND_DRAFT_TOOL,
  createFrontendReconstructSession,
  createFrontendReconstructTools,
} from '../src/agent/frontend-reconstruct/tools';
import { collectToolParametersSchemaProblems, NOOP_AGENT_LOGGER } from '../src/agent/runtime';
import {
  FRONTEND_LIMITS,
  FRONTEND_RECONSTRUCT_CONTRACT_VERSION,
  FRONTEND_SIZE_KEYS,
  FRONTEND_TARGET_PAGES,
  FRONTEND_THEME_TOKEN_KEYS,
  type FrontendFacts,
  type FrontendReconstructResponse,
  type UiRequirement,
} from '../src/agent/frontend-reconstruct/types';

/**
 * 能力快照与真实目录的同源测试（P1）。
 *
 * 只读 `templates/base`、`templates/catalog` 与页面 WXML/控制器声明，不启动 Nest、
 * 不访问网络；任何“快照里有、真源里没有”的能力都必须让测试失败。
 */

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BASE_ROOT = join(REPO_ROOT, 'templates', 'base', 'ordering-base', '1.0.0');

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

interface CatalogPage {
  pageId: string;
  components: Array<{ componentId: string; mode: string }>;
  slots: Array<{ slotId: string }>;
  controller: { methods: string[]; dataKeys: string[] };
}

interface CatalogComponent {
  id: string;
  interface: {
    props: Array<{ name: string }>;
    events: Array<{ name: string }>;
  };
}

interface BaseManifest {
  pages: Array<{ pageId: string }>;
  slots: Array<{ slotId: string; pageId: string }>;
  themeTokens: Array<{ key: string }>;
  builtinComponents: string[];
}

function pageCatalog(pageId: string): CatalogPage {
  return readJson<CatalogPage>(join(REPO_ROOT, 'templates', 'catalog', 'pages', pageId + '.json'));
}

function componentCatalog(componentId: string): CatalogComponent {
  return readJson<CatalogComponent>(
    join(REPO_ROOT, 'templates', 'catalog', 'components', componentId + '.json'),
  );
}

function pageWxml(pageId: string): string {
  return readText(join(BASE_ROOT, 'src', 'pages', pageId, 'index.wxml'));
}

function baseManifest(): BaseManifest {
  return readJson<BaseManifest>(join(BASE_ROOT, 'manifest.json'));
}

function baseRequirement(overrides: Partial<UiRequirement> = {}): Record<string, unknown> {
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
      { regionId: 'r-header', eventName: 'home.goMenu', status: 'bound' },
    ],
    unknownRegions: [],
    lowConfidence: [],
    inferredInteractions: [],
    unsupported: [],
    degradations: [],
    ...overrides,
  };
}

/** 与服务端单测同源的 home 合法草稿：只使用 home 页面事实，并绑定全部关键动作。 */
function homeDraft(options: { omitAction?: string; extraCartBar?: boolean } = {}): Record<string, unknown> {
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
      style: { direction: 'column', gap: 'md' },
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
    displayName: '参考图首页候选',
    pages: [{ pageId: 'home', nodes, styles: [], pageJson: {} }],
  };
}

/** menu 页合法草稿：cart-bar + menu.onCheckout 只能在 menu 页使用。 */
function menuDraft(): Record<string, unknown> {
  return {
    schemaVersion: 'frontend-pack-draft.v1',
    displayName: '参考图菜单候选',
    pages: [
      {
        pageId: 'menu',
        nodes: [
          { type: 'slot', slotId: 'menu-hero' },
          {
            type: 'component',
            componentId: 'cart-bar',
            props: {
              totalCents: { kind: 'data', dataPath: 'cart.totalCents' },
              totalQuantity: { kind: 'data', dataPath: 'cart.count' },
            },
            events: { checkout: 'menu.onCheckout' },
          },
        ],
        styles: [],
        pageJson: {},
      },
    ],
  };
}

const PAGE_FACTS = loadFrontendPageFacts();
const PAGE_KEY_ACTIONS = loadFrontendKeyActions();
const REQUIRE_FROM_TEST = createRequire(import.meta.url);
const P2_SCHEMA = REQUIRE_FROM_TEST(
  join(REPO_ROOT, 'desktop', 'frontend-reconstruct', 'schema.cjs'),
) as {
  validateDraft(
    draft: unknown,
    facts: unknown,
    pageFacts: unknown,
  ): { ok: true } | { ok: false; code: string; path: string; message: string };
};

const FACTS = loadFrontendFacts();
const PNG_BASE64 = readFileSync(
  join(REPO_ROOT, 'test', 'fixtures', 'frontend-reconstruct', 'reference-tiny.png'),
).toString('base64');

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect((error as { code?: string }).code).toBe(code);
    return;
  }
  throw new Error('期望抛出 ' + code + '，但函数正常返回');
}

describe('frontend-reconstruct 能力快照与真源同源', () => {
  it('A1 快照通过契约校验，页面/主题/尺寸与冻结契约一致', () => {
    const facts = validateFrontendFacts(FACTS);
    expect(facts.pageIds).toEqual([...FRONTEND_TARGET_PAGES]);
    expect(facts.themeTokens).toEqual([...FRONTEND_THEME_TOKEN_KEYS]);
    expect(facts.sizeKeys).toEqual([...FRONTEND_SIZE_KEYS]);
    expect(new Set(facts.pageIds)).toEqual(new Set(baseManifest().pages.map((page) => page.pageId).filter((pageId) => (FRONTEND_TARGET_PAGES as readonly string[]).includes(pageId))));
  });

  it('A2 组件集合 = home/menu 页面真实使用（排除 declared-only），props/events 均来自组件目录', () => {
    const expected = new Set<string>();
    for (const pageId of FRONTEND_TARGET_PAGES) {
      for (const component of pageCatalog(pageId).components) {
        if (component.mode === 'declared-only') continue;
        expected.add(component.componentId);
      }
    }
    expect(new Set(Object.keys(FACTS.components))).toEqual(expected);

    const manifest = baseManifest();
    for (const [componentId, facts] of Object.entries(FACTS.components)) {
      expect(manifest.builtinComponents).toContain(componentId);
      const catalog = componentCatalog(componentId);
      const catalogProps = catalog.interface.props.map((prop) => prop.name);
      const catalogEvents = catalog.interface.events.map((event) => event.name);
      for (const prop of facts.props) expect(catalogProps).toContain(prop);
      for (const event of facts.events) expect(catalogEvents).toContain(event);
    }
  });

  it('A3 插槽来自 Base manifest，且与页面目录逐页一致', () => {
    const manifest = baseManifest();
    const manifestSlots = manifest.slots
      .filter((slot) => (FRONTEND_TARGET_PAGES as readonly string[]).includes(slot.pageId))
      .map((slot) => slot.slotId)
      .sort();
    expect([...FACTS.slots].sort()).toEqual(manifestSlots);

    for (const pageId of FRONTEND_TARGET_PAGES) {
      const catalogSlots = pageCatalog(pageId).slots.map((slot) => slot.slotId).sort();
      const pageSlots = FACTS.slots.filter((slot) => slot.startsWith(pageId + '-')).sort();
      expect(pageSlots).toEqual(catalogSlots);
    }
  });

  it('A4 动作 = 页面 WXML 真实 bind/catch 且命中控制器 methods', () => {
    for (const action of FACTS.actions) {
      const [pageId, method] = action.split('.');
      expect(FRONTEND_TARGET_PAGES).toContain(pageId);
      const catalog = pageCatalog(pageId);
      expect(catalog.controller.methods).toContain(method);
      expect(pageWxml(pageId)).toContain('="' + method + '"');
    }
    // 关键动作由快照动态给出（不是硬编码），且必须等于本页 actions 前缀。
    for (const pageId of FRONTEND_TARGET_PAGES) {
      expect(PAGE_KEY_ACTIONS[pageId]).toEqual(getFrontendKeyActions(FACTS, pageId));
      for (const action of PAGE_KEY_ACTIONS[pageId]) {
        expect(action.startsWith(pageId + '.')).toBe(true);
        expect(FACTS.actions).toContain(action);
      }
    }
    expect(PAGE_KEY_ACTIONS.home).toEqual(
      expect.arrayContaining(['home.goOrders', 'home.goMine', 'home.goMerchant', 'home.onPickTable']),
    );
  });

  it('A5 单文件快照使用规范 dataPath 命名空间，且页面归属与 WXML 同源', () => {
    // 渲染器/桌面 P2 依赖的规范 token 必须存在（单一事实源）。
    expect(FACTS.dataPaths).toEqual(expect.arrayContaining([
      'home.mode',
      'menu.products',
      'menu.categories',
      'cart.items',
      'cart.totalCents',
      'cart.count',
      'store.name',
      'store.businessHours',
      'store.address',
    ]));
    // 不再暴露原始 WXML 别名/内部状态/循环变量。
    for (const legacy of ['cartSummary.totalCents', 'cartSummary.totalQuantity', 'products.length', 'item.name']) {
      expect(FACTS.dataPaths).not.toContain(legacy);
    }
    const wxml = FRONTEND_TARGET_PAGES.map((pageId) => pageWxml(pageId)).join('\n');
    for (const storePath of FACTS.dataPaths.filter((dataPath) => dataPath.startsWith('store.'))) {
      expect(wxml).toContain(storePath);
    }
    for (const dataPath of FACTS.dataPaths.filter((item) => item.startsWith('home.') || item.startsWith('menu.'))) {
      const [pageId, key] = dataPath.split('.');
      expect(pageCatalog(pageId).controller.dataKeys).toContain(key);
      expect(pageWxml(pageId)).toContain(key);
    }
    expect(wxml).toContain('cartSummary.totalQuantity');
    expect(wxml).toContain('cartSummary.totalCents');

    // 页面级 dataPaths 必须按页隔离，并与全局并集一致（loader 已 fail closed）。
    expect(PAGE_FACTS.home.dataPaths).toContain('home.mode');
    expect(PAGE_FACTS.home.dataPaths).not.toContain('menu.products');
    expect(PAGE_FACTS.home.dataPaths).not.toContain('cart.totalCents');
    expect(PAGE_FACTS.menu.dataPaths).toEqual(expect.arrayContaining(['menu.products', 'cart.totalCents']));
    const union = new Set([...PAGE_FACTS.home.dataPaths, ...PAGE_FACTS.menu.dataPaths]);
    expect([...union].sort()).toEqual([...FACTS.dataPaths].sort());
  });
});

describe('frontend-reconstruct 权威能力覆盖结论', () => {
  it('B1 已有能力 covered：required 来自 mustKeep/pages/bindings 且 coveredBy 自映射', () => {
    const requirement = validateUiRequirement(baseRequirement(), FACTS, { targetPages: ['home'] });
    const coverage = buildCapabilityCoverage(requirement, FACTS);
    expect(coverage.status).toBe('covered');
    expect(coverage.missingCapabilities).toEqual([]);
    expect(coverage.requiredCapabilities).toEqual(
      expect.arrayContaining(['page:home', 'action:home.goMenu', 'data:store.name']),
    );
    for (const capability of coverage.requiredCapabilities) {
      expect(coverage.coveredBy[capability]).toBe(capability);
    }
    expect(validateCapabilityCoverageReport(coverage, FACTS).status).toBe('covered');
  });

  it('B2 视觉降级 → partial，且降级项由服务端从 requirement 复制', () => {
    const requirement = validateUiRequirement(
      baseRequirement({
        degradations: [
          { regionId: 'r-header', label: '品牌主视觉', reason: '不复刻品牌图片，使用纯色占位', severity: 'warn' },
        ],
      }),
      FACTS,
      { targetPages: ['home'] },
    );
    const coverage = buildCapabilityCoverage(requirement, FACTS);
    expect(coverage.status).toBe('partial');
    expect(coverage.degradations).toHaveLength(1);
    expect(coverage.missingCapabilities).toEqual([]);
  });

  it('B3 模型声明 Base 不存在的必需能力 → rejected，缺失项与风险来自服务端事实', () => {
    const requirement = validateUiRequirement(baseRequirement(), FACTS, { targetPages: ['home'] });
    const coverage = buildCapabilityCoverage(requirement, FACTS, {
      additionalRequiredCapabilities: ['component:live-stream', 'action:home.startLive'],
    });
    expect(coverage.status).toBe('rejected');
    expect(coverage.missingCapabilities).toEqual(['action:home.startLive', 'component:live-stream']);
    expect(coverage.coveredBy['component:live-stream']).toBeUndefined();
    expect(coverage.risks.map((risk) => risk.capability)).toEqual(coverage.missingCapabilities);
    expect(validateCapabilityCoverageReport(coverage, FACTS).status).toBe('rejected');
  });

  it('B4 mustKeep 从 Base 目标页补全页面与关键动作；事实漂移时 fail closed', () => {
    const requirement = validateUiRequirement(
      baseRequirement({
        mustKeep: [{ kind: 'page', ref: 'page:home' }],
      }),
      FACTS,
      { targetPages: ['home'] },
    );
    const completed = completeRequirementMustKeep(requirement, FACTS, ['home']);
    const refs = completed.mustKeep.map((item) => item.ref);
    expect(refs).toContain('page:home');
    for (const action of PAGE_KEY_ACTIONS.home) {
      expect(refs).toContain('action:' + action);
    }
    expect(refs).toEqual(
      expect.arrayContaining([
        'action:home.goMenu',
        'action:home.goOrders',
        'action:home.goMine',
        'action:home.goMerchant',
        'action:home.onPickTable',
      ]),
    );

    // 事实漂移：Base 少了任一关键动作时补全必须 fail closed（不是静默漏掉）。
    const drifted = {
      ...FACTS,
      actions: FACTS.actions.filter((action) => action !== 'home.goOrders'),
    } as FrontendFacts;
    expectCode(() => completeRequirementMustKeep(requirement, drifted, ['home']), 'FRONTEND_FACTS_INVALID');
  });

  it('B5 能力投影按页面裁剪，不把另一页的动作/插槽/数据/组件暴露给模型', () => {
    const projection = projectFrontendCapabilities(FACTS, PAGE_FACTS, ['home']);
    expect(projection.pageIds).toEqual(['home']);
    expect(projection.actions.every((action) => action.startsWith('home.'))).toBe(true);
    expect(projection.slots.every((slot) => slot.startsWith('home-'))).toBe(true);
    expect(projection.dataPaths).toContain('store.name');
    expect(projection.dataPaths).toContain('home.mode');
    expect(projection.dataPaths).not.toContain('menu.products');
    expect(projection.dataPaths).not.toContain('cart.totalCents');
    expect(projection.keyActions).toEqual(
      PAGE_KEY_ACTIONS.home.map((action) => ({ pageId: 'home', action })),
    );
    expect(projection.pageFacts.home).toEqual(PAGE_FACTS.home);
    expect(projection.pageFacts.menu).toBeUndefined();
    // home 页面 usingComponents 中的 poster-carousel 不在全局事实，不能暴露给模型。
    expect(Object.keys(projection.components).sort()).toEqual([
      'error-banner',
      'fulfillment-switch',
      'order-card',
      'state-view',
      'store-header',
    ]);
  });

  it('B6 投影拒绝契约外的 pageId，且 required 数量不超过契约上限', () => {
    expectCode(
      () => projectFrontendCapabilities(FACTS, PAGE_FACTS, ['checkout']),
      'FRONTEND_TARGET_PAGES_UNSUPPORTED',
    );
    expect(FRONTEND_LIMITS.maxRequiredCapabilities).toBe(32);
  });
});

describe('t3 复核 findings 的 P1 硬化（契约行为）', () => {
  function validRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      contractVersion: 'frontend-reconstruct.v1',
      requestId: 'fr-hardening',
      utterance: '按图重构首页',
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

  it('H1 body / presentationPatch 上限按 UTF-8 字节计（中文 6000 字 = 18KB > 16KB）', () => {
    // 字符串长度 6000 < 16384，旧实现会放过；按 UTF-8 字节必须拒绝。
    expectCode(
      () => parseFrontendReconstructRequest(validRequest({
        current: {
          baseTemplate: { id: 'ordering-base', version: '1.0.0' },
          frontendPack: null,
          presentationPatch: { blob: '中'.repeat(6000) },
        },
      })),
      'FRONTEND_REQUEST_INVALID',
    );
  });

  it('H2 控制字符覆盖 C1（U+0080–U+009F），utterance 与 requirement 文本都拒绝', () => {
    expectCode(
      () => parseFrontendReconstructRequest(validRequest({ utterance: '正常\u0085文本' })),
      'FRONTEND_UTTERANCE_INVALID',
    );
    expectCode(
      () => validateUiRequirement(
        baseRequirement({ summary: '正常\u009F文本' }),
        FACTS,
        { targetPages: ['home'] },
      ),
      'FRONTEND_REQUIREMENT_INVALID',
    );
  });

  it('H3 inferredInteractions 不得携带动作/路由名（只描述可观察交互）', () => {
    expectCode(
      () => validateUiRequirement(
        baseRequirement({
          inferredInteractions: [
            { regionId: 'r-header', label: '点击后执行 home.goMenu', reason: '按钮可见但未推定路由' },
          ],
        }),
        FACTS,
        { targetPages: ['home'] },
      ),
      'FRONTEND_REQUIREMENT_INVALID',
    );
    expectCode(
      () => validateUiRequirement(
        baseRequirement({
          inferredInteractions: [
            { regionId: 'r-header', label: '点击跳转', reason: '可能进入 route:/pages/menu/index' },
          ],
        }),
        FACTS,
        { targetPages: ['home'] },
      ),
      'FRONTEND_REQUIREMENT_INVALID',
    );
  });

  it('H4 theme token 必须同时命中契约七类与注入事实（不能自造主题键）', () => {
    const restrictedFacts = {
      ...FACTS,
      themeTokens: ['pageBackground', 'primaryColor'],
    } as FrontendFacts;
    expectCode(
      () => validateUiRequirement(
        baseRequirement({
          visual: {
            theme: { accentColor: '#9C2E12' },
            sizes: { homeHero: 'lg' },
            density: 'comfortable',
          },
        }),
        restrictedFacts,
        { targetPages: ['home'] },
      ),
      'FRONTEND_REQUIREMENT_INVALID',
    );
  });

  it('H5 adopted → idle 只能走 undo 守卫；undo 仍可用', () => {
    let state = createFrontendRunState('frun-undo');
    for (const next of ['analyzing', 'planning', 'generating', 'validating', 'verifying-runtime', 'ready'] as const) {
      state = transitionFrontendRun(state, next);
    }
    state = adoptFrontendCandidate(state);
    expect(state.status).toBe('adopted');
    expectCode(() => transitionFrontendRun(state, 'idle'), 'FRONTEND_STATE_TRANSITION_INVALID');
    expect(undoAdoptedFrontend(state).status).toBe('idle');
  });
});

describe('frontend-reconstruct 四工具的本地权限与权威覆盖', () => {
  function createTools() {
    const session = createFrontendReconstructSession({
      runId: 'frun-tools',
      facts: FACTS,
      pageFacts: PAGE_FACTS,
      targetPages: ['home'],
    });
    return { session, tools: createFrontendReconstructTools(session) };
  }

  const toolContext = {
    runId: 'frun-tools',
    requestId: 'req_tools',
    step: 1,
    signal: new AbortController().signal,
    logger: NOOP_AGENT_LOGGER,
    metadata: {} as Record<string, string>,
  };

  it('T1 四工具具备 schema、权限标记、超时/重试与并发语义', () => {
    const { tools } = createTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      GET_FRONTEND_CAPABILITIES_TOOL,
      CHECK_FRONTEND_COVERAGE_TOOL,
      PROPOSE_FRONTEND_DRAFT_TOOL,
      REPAIR_FRONTEND_DRAFT_TOOL,
    ]);
    expect(tools.map((tool) => tool.sideEffect)).toEqual(['read', 'read', 'write', 'write']);
    expect(tools.map((tool) => tool.concurrencySafe)).toEqual([true, true, false, false]);
    expect(tools.map((tool) => tool.requiresApproval)).toEqual([false, false, false, false]);
    for (const tool of tools) {
      expect(tool.timeoutMs).toBe(5_000);
      expect(collectToolParametersSchemaProblems(tool.parameters)).toEqual([]);
    }
    expect(tools[0].retry).toEqual({ maxAttempts: 2, backoffMs: 100, retryOnTimeout: true });
    expect(tools[1].retry).toEqual({ maxAttempts: 2, backoffMs: 100, retryOnTimeout: true });
    expect(tools[2].retry).toBeUndefined();
    expect(tools[3].retry).toBeUndefined();
  });

  it('T2 check_frontend_coverage 只能由服务端事实决定 missing/covered；模型只能通过重新提交需求纠正误判', async () => {
    const { tools } = createTools();
    const check = tools[1];
    const covered = await check.execute({ requirement: baseRequirement() }, toolContext);
    expect(covered).toMatchObject({ status: 'covered', missingCapabilities: [] });

    const rejected = await check.execute(
      {
        requirement: baseRequirement(),
        requestedCapabilities: ['component:live-stream'],
      },
      toolContext,
    );
    expect(rejected).toMatchObject({
      status: 'rejected',
      missingCapabilities: ['component:live-stream'],
    });

    // 模型无法直接提供 covered 报告；但重新提交“不需要直播”的需求时，
    // 服务端按最新事实重新计算（而不是接受模型自述）。
    const corrected = await check.execute({ requirement: baseRequirement() }, toolContext);
    expect(corrected).toMatchObject({ status: 'covered', missingCapabilities: [] });
  });

  it('T3 未提交 requirement/draft 时 repair 被状态守卫拒绝（自由文本日志不进 repair 通道）', async () => {
    const { tools } = createTools();
    const repair = tools[3];
    // 未先提交 requirement/draft 时，repair 必须先被状态守卫拦住。
    await expect(
      repair.execute(
        {
          issues: [{ path: '$.displayName', code: 'DRAFT_SCHEMA_INVALID' }],
          patch: { '$.displayName': '新名字' },
        },
        toolContext,
      ),
    ).rejects.toMatchObject({ code: 'FRONTEND_STATE_TRANSITION_INVALID' });
  });
});

describe('R-F1/R-F2/R-F3/R-F6/R-F7 修复证据', () => {
  function createTools() {
    const events: Array<Record<string, unknown>> = [];
    const session = createFrontendReconstructSession({
      runId: 'frun-fixes',
      facts: FACTS,
      pageFacts: PAGE_FACTS,
      targetPages: ['home'],
    });
    return {
      session,
      events,
      tools: createFrontendReconstructTools(session),
      context: {
        runId: 'frun-fixes',
        requestId: 'req_fixes',
        step: 1,
        signal: new AbortController().signal,
        logger: { log: (event: Record<string, unknown>) => events.push(event) },
        metadata: {} as Record<string, string>,
      },
    };
  }

  async function checkRequirement(
    tools: ReturnType<typeof createTools>['tools'],
    context: ReturnType<typeof createTools>['context'],
    rawRequirement: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return (await tools[1].execute({ requirement: rawRequirement }, context)) as Record<string, unknown>;
  }

  async function propose(
    tools: ReturnType<typeof createTools>['tools'],
    context: ReturnType<typeof createTools>['context'],
    draft: Record<string, unknown>,
  ): Promise<unknown> {
    return tools[2].execute({ draft }, context);
  }

  it('F1 单文件快照是 P1/P2 唯一事实源：含 pageFacts/keyActions，JSON 与 TS 逐字节同源', () => {
    const snapshotJson = readJson<Record<string, unknown>>(
      join(REPO_ROOT, 'server', 'src', 'agent', 'frontend-reconstruct', 'capabilities.snapshot.json'),
    );
    expect(snapshotJson).toEqual(FRONTEND_CAPABILITIES_SNAPSHOT);
    expect(snapshotJson.pageFacts).toEqual(PAGE_FACTS);
    expect(snapshotJson.keyActions).toEqual(loadFrontendFactsBundle().keyActions);
    expect(snapshotJson.dataPaths).toEqual(
      expect.arrayContaining(['home.mode', 'menu.products', 'menu.categories', 'cart.items', 'cart.totalCents', 'cart.count']),
    );
    expect(Object.keys(PAGE_FACTS).sort()).toEqual(['home', 'menu']);
    for (const pageId of FRONTEND_TARGET_PAGES) {
      expect(PAGE_KEY_ACTIONS[pageId].length).toBeGreaterThan(0);
    }
  });

  it('F2 页面级成对校验：home 绑定 cart-bar/menu.onCheckout 被 P1 与 P2 同时拒绝；menu 同页绑定通过', () => {
    // 跨页：P1 拒绝，P2 也拒绝（组件未在 home usingComponents）。
    expectCode(
      () => validateFrontendPackDraft(homeDraft({ extraCartBar: true }), FACTS, PAGE_FACTS),
      'FRONTEND_DRAFT_INVALID',
    );
    const p2Cross = P2_SCHEMA.validateDraft(homeDraft({ extraCartBar: true }), FACTS, PAGE_FACTS);
    expect(p2Cross.ok).toBe(false);
    if (!p2Cross.ok) expect(p2Cross.code).toBe('DRAFT_UNKNOWN_COMPONENT');

    // 同页：menu 的 cart-bar + menu.onCheckout 在 P1 与 P2 都合法。
    const p1Menu = validateFrontendPackDraft(menuDraft(), FACTS, PAGE_FACTS);
    expect(p1Menu.pages[0].pageId).toBe('menu');
    expect(P2_SCHEMA.validateDraft(menuDraft(), FACTS, PAGE_FACTS).ok).toBe(true);

    // 正常 home planned 草稿可被 P2 schema 接受（端到端物化前置条件）。
    expect(validateFrontendPackDraft(homeDraft(), FACTS, PAGE_FACTS).pages[0].pageId).toBe('home');
    expect(P2_SCHEMA.validateDraft(homeDraft(), FACTS, PAGE_FACTS).ok).toBe(true);
  });

  it('F3 删除任一动态关键动作（goOrders/goMine/goMerchant/onPickTable）都会被 C1 拒绝', () => {
    const requirement = validateUiRequirement(
      baseRequirement({ mustKeep: [{ kind: 'page', ref: 'page:home' }] }),
      FACTS,
      { targetPages: ['home'] },
    );
    const completed = completeRequirementMustKeep(requirement, FACTS, ['home']);
    const coverage = buildCapabilityCoverage(completed, FACTS);
    for (const action of ['home.goOrders', 'home.goMine', 'home.goMerchant', 'home.onPickTable']) {
      const draft = validateFrontendPackDraft(homeDraft({ omitAction: action }), FACTS, PAGE_FACTS);
      expectCode(
        () => assertFrontendPlannedConsistency(completed, coverage, draft),
        'FRONTEND_RESPONSE_INVALID',
      );
    }

    // 完整草稿通过，证明上面的失败确实来自被删除的动作。
    const fullDraft = validateFrontendPackDraft(homeDraft(), FACTS, PAGE_FACTS);
    expect(() => assertFrontendPlannedConsistency(completed, coverage, fullDraft)).not.toThrow();
  });

  it('F4 repair 必须绑定上一次门禁 issues；伪造 issue 与无门禁 repair 都被拒绝', async () => {
    const { session, tools, context } = createTools();
    await checkRequirement(tools, context, baseRequirement());

    const invalidDraft = { ...homeDraft(), displayName: 'x'.repeat(41) };
    let gateError: { code?: string; details?: { issues?: Array<{ path: string; code: string }> } } | null = null;
    try {
      await propose(tools, context, invalidDraft);
    } catch (error) {
      gateError = error as typeof gateError;
    }
    expect(gateError?.code).toBe('FRONTEND_DRAFT_INVALID');
    expect(gateError?.details?.issues).toEqual([
      { path: '$.displayName', code: 'DRAFT_SCHEMA_INVALID' },
    ]);

    // 模型自报另一个 code（不在门禁结果里）必须拒绝。
    await expect(
      tools[3].execute(
        {
          issues: [{ path: '$.displayName', code: 'DRAFT_UNKNOWN_COMPONENT' }],
          patch: { '$.displayName': '候选一' },
        },
        context,
      ),
    ).rejects.toMatchObject({ code: 'FRONTEND_REPAIR_ISSUES_INVALID' });

    // 原样复制门禁 issue 后修复成功；随后没有新门禁，不得再次 repair。
    const repaired = await tools[3].execute(
      {
        issues: [{ path: '$.displayName', code: 'DRAFT_SCHEMA_INVALID' }],
        patch: { '$.displayName': '候选一' },
      },
      context,
    );
    expect(repaired).toMatchObject({ ok: true, code: 'FRONTEND_DRAFT_REPAIRED' });
    expect(session.draft?.displayName).toBe('候选一');
    expect(session.lastGateIssues).toEqual([]);
    await expect(
      tools[3].execute(
        {
          issues: [{ path: '$.displayName', code: 'DRAFT_SCHEMA_INVALID' }],
          patch: { '$.displayName': '候选二' },
        },
        context,
      ),
    ).rejects.toMatchObject({ code: 'FRONTEND_REPAIR_ISSUES_INVALID' });
  });

  it('F5 propose 后修改 requirement 再 checkCoverage：显式失败退出但不破坏旧一致状态（不卡死/不 502）', async () => {
    const { session, tools, context } = createTools();
    await checkRequirement(tools, context, baseRequirement());
    await propose(tools, context, homeDraft());
    expect(session.draft).not.toBeNull();
    expect(session.runState.status).toBe('validating');
    const oldRequirement = session.requirement;
    const oldDraft = session.draft;

    // 新增 mustKeep data（home demoHint 是合法事实，但现有 draft 没绑定）→ 不一致。
    const changed = baseRequirement({
      mustKeep: [
        { kind: 'page', ref: 'page:home' },
        { kind: 'action', ref: 'action:home.goMenu' },
        { kind: 'data', ref: 'data:home.demoHint' },
      ],
    });
    await expect(
      checkRequirement(tools, context, changed),
    ).rejects.toMatchObject({ code: 'FRONTEND_RESPONSE_INVALID' });

    // 旧状态完整保留：requirement/draft 未被半更新，仍可继续 check/repair，不会卡死。
    expect(session.requirement).toBe(oldRequirement);
    expect(session.draft).toBe(oldDraft);
    expect(session.runState.status).toBe('validating');
    const again = await checkRequirement(tools, context, baseRequirement());
    expect(again).toMatchObject({ status: 'covered', draftKept: true });
  });

  it('F6 日志 details.path 经白名单/限长清洗，不写入 base64 或未知超长字段名', async () => {
    const { tools, context, events } = createTools();
    const maliciousKey = 'A'.repeat(120) + 'iVBORw0KGgoAAAANSUhEUg';
    const malicious = { ...baseRequirement(), [maliciousKey]: 'x' };
    await expect(
      tools[1].execute({ requirement: malicious }, context),
    ).rejects.toMatchObject({ code: 'FRONTEND_REQUIREMENT_INVALID' });

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('iVBORw0KGgo');
    expect(serialized).not.toContain(maliciousKey);
    const rejected = events.find((event) => event.event === 'frontend_tool_rejected');
    expect(rejected?.path).toBe('<invalid-path>');
    expect(String(rejected?.path).length).toBeLessThanOrEqual(200);
  });

  it('F7 快照不包含内部状态/循环变量 dataPath（单一命名空间）', () => {
    for (const dataPath of FACTS.dataPaths) {
      expect(dataPath.startsWith('item.')).toBe(false);
      expect(dataPath.startsWith('cartSummary.')).toBe(false);
      for (const internal of ['loading', 'error', 'requestId', 'tableOptions', 'quantityMap']) {
        expect(dataPath).not.toContain(internal);
      }
    }
  });

  it('F8 prompt 示例只使用 canonical token，且逐项命中 snapshot pageFacts（T20-F1）', () => {
    const prompt = FRONTEND_RECONSTRUCT_SYSTEM_PROMPT;
    const homeStart = prompt.indexOf('{"schemaVersion"');
    const menuStart = prompt.indexOf('menu 页合法示例');
    expect(homeStart).toBeGreaterThan(0);
    expect(menuStart).toBeGreaterThan(homeStart);
    const menuEnd = prompt.indexOf('节点只允许五类键');
    expect(menuEnd).toBeGreaterThan(menuStart);
    const homeSection = prompt.slice(homeStart, menuStart);
    const menuSection = prompt.slice(menuStart, menuEnd);
    const tokensOf = (text: string): string[] =>
      [...text.matchAll(/"(?:dataPath|textToken)":"([^"]+)"/g)].map((match) => match[1]);

    const homeTokens = tokensOf(homeSection);
    const menuTokens = tokensOf(menuSection);
    expect(homeTokens.length).toBeGreaterThan(0);
    expect(menuTokens.length).toBeGreaterThan(0);
    // 示例里的每个 token 必须命中该页 snapshot pageFacts。
    for (const token of homeTokens) expect(PAGE_FACTS.home.dataPaths).toContain(token);
    for (const token of menuTokens) expect(PAGE_FACTS.menu.dataPaths).toContain(token);

    // 示例区不得出现原始 WXML token；prompt 里只能把它们列在“禁止”说明中。
    for (const section of [homeSection, menuSection]) {
      for (const raw of ['cartSummary.', 'products.length', 'item.', 'quantityMap']) {
        expect(section).not.toContain(raw);
      }
    }
    // canonical 覆盖：home.* / menu.* / cart.* / store.* 以及 renderer 运行时映射说明。
    for (const token of ['home.mode', 'menu.products', 'menu.categories', 'cart.totalCents', 'cart.count', 'store.name']) {
      expect(prompt).toContain(token);
    }
    expect(prompt).toContain('renderer');
    expect(prompt).toContain('canonical');
    expect(prompt).not.toContain('不能写成带页面前缀的别名');
  });

  it('F9 P1 执行入口强制 pageFacts：省略时 fail closed，提供后跨页草稿被拒（T20-F2）', () => {
    // 草稿入口：缺 pageFacts 不允许退回全局事实。
    expectCode(
      () => validateFrontendPackDraftForP1(homeDraft(), FACTS),
      'FRONTEND_FACTS_INVALID',
    );
    expectCode(
      () => validateFrontendPackDraftForP1(homeDraft({ extraCartBar: true }), FACTS, PAGE_FACTS),
      'FRONTEND_DRAFT_INVALID',
    );

    // 响应入口：缺 pageFacts fail closed；提供后合法 planned 通过。
    const requirement = completeRequirementMustKeep(
      validateUiRequirement(baseRequirement(), FACTS, { targetPages: ['home'] }),
      FACTS,
      ['home'],
    );
    const coverage = buildCapabilityCoverage(requirement, FACTS);
    const draft = validateFrontendPackDraftForP1(homeDraft(), FACTS, PAGE_FACTS);
    const response: FrontendReconstructResponse = {
      contractVersion: FRONTEND_RECONSTRUCT_CONTRACT_VERSION,
      runId: 'frun-p1-entry',
      status: 'planned',
      requirement,
      coverage,
      draft,
      questions: [],
      trace: { modelCalls: 1, toolCalls: [], stopReason: 'final_answer', degraded: false },
      meta: { provider: 'deepseek', model: 'deepseek-chat', mock: false, latencyMs: 1 },
    };
    expectCode(
      () => validateFrontendReconstructResponseForP1(response, FACTS, { targetPages: ['home'] }),
      'FRONTEND_FACTS_INVALID',
    );
    expect(
      validateFrontendReconstructResponseForP1(response, FACTS, {
        targetPages: ['home'],
        pageFacts: PAGE_FACTS,
      }).status,
    ).toBe('planned');
  });
});
