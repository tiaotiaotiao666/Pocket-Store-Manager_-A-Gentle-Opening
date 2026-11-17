/**
 * 只读能力事实（FrontendFacts）的服务端入口。
 *
 * 事实来源唯一：`capabilities.snapshot.ts`（由 `scripts/frontend-capabilities.cjs`
 * 从 Base Manifest、`templates/catalog` 与页面控制器确定性生成）。
 * 服务端在进程内**只读**使用；客户端或模型提供的任何能力 id 都不被信任。
 *
 * 设计要点：
 * - `loadFrontendFacts()` 对快照做一次 fail-closed 校验并缓存；快照非法一律
 *   `FRONTEND_FACTS_INVALID`（500），绝不降级成“空能力目录”继续生成；
 * - `completeRequirementMustKeep()` 从 Base 目标页补全“页面 + 关键动作”，
 *   避免模型因为截图没画按钮就静默删掉 Base 既有功能；
 * - `buildCapabilityCoverage()` 是覆盖结论的唯一来源：模型只能提出需求，
 *   不能把 missing 写成 covered。
 */

import { FrontendReconstructError, frontendError } from './errors';
import { FRONTEND_CAPABILITIES_SNAPSHOT } from './capabilities.snapshot';
import { buildFrontendCapabilityIds, validateFrontendFacts } from './schema';
import { FRONTEND_LIMITS, FRONTEND_TARGET_PAGES } from './types';
import { loadFrontendKeyActions } from './page-facts';
import type { FrontendPageFactsMap } from './page-facts';
import type {
  CapabilityCoverageReport,
  CoverageRisk,
  FrontendFacts,
  FrontendTargetPageId,
  MustKeep,
  UiRequirement,
} from './types';

let cachedFacts: FrontendFacts | null = null;

/**
 * 加载并校验打包的只读能力快照。
 * 快照缺失/形状非法时 fail closed（`FRONTEND_FACTS_INVALID`），不返回空能力集。
 */
export function loadFrontendFacts(): FrontendFacts {
  if (cachedFacts !== null) return cachedFacts;
  try {
    // 单一快照文件同时携带 pageFacts/keyActions；全局事实只取 frontend-facts.v1 字段，
    // 剥离后的对象必须严格通过契约校验（多余/缺失字段都 fail closed）。
    const snapshot = FRONTEND_CAPABILITIES_SNAPSHOT as unknown as Record<string, unknown>;
    cachedFacts = validateFrontendFacts({
      version: snapshot.version,
      pageIds: snapshot.pageIds,
      components: snapshot.components,
      slots: snapshot.slots,
      actions: snapshot.actions,
      dataPaths: snapshot.dataPaths,
      themeTokens: snapshot.themeTokens,
      sizeKeys: snapshot.sizeKeys,
    });
  } catch (error) {
    if (error instanceof FrontendReconstructError) throw error;
    throw frontendError('FRONTEND_FACTS_INVALID');
  }
  return cachedFacts;
}

/** 只用于测试替换/清理（生产路径不调用）。 */
export function resetFrontendFactsCacheForTests(): void {
  cachedFacts = null;
}

function assertTargetPageIds(pageIds: readonly string[]): FrontendTargetPageId[] {
  const out: FrontendTargetPageId[] = [];
  for (const pageId of pageIds) {
    if (!(FRONTEND_TARGET_PAGES as readonly string[]).includes(pageId)) {
      throw frontendError('FRONTEND_TARGET_PAGES_UNSUPPORTED', { path: '$.pageIds' });
    }
    if (!out.includes(pageId as FrontendTargetPageId)) {
      out.push(pageId as FrontendTargetPageId);
    }
  }
  return out;
}

/**
 * 每页关键动作：由单一快照的 `keyActions` 给出（脚本从 Base 页面 WXML 真实绑定动态推导），
 * 并校验这些动作仍存在于注入事实。不再硬编码 goMenu/onCheckout，避免
 * goOrders/goMine/goMerchant/onPickTable 等用户可见入口被静默删除。
 */
export function getFrontendKeyActions(facts: FrontendFacts, pageId: FrontendTargetPageId): string[] {
  const declared = loadFrontendKeyActions()[pageId];
  if (declared === undefined || declared.length === 0) {
    throw frontendError('FRONTEND_FACTS_INVALID');
  }
  for (const action of declared) {
    if (!facts.actions.includes(action)) throw frontendError('FRONTEND_FACTS_INVALID');
  }
  return [...declared];
}

/**
 * 模型可见的最小能力投影：请求页相关的插槽/动作/数据路径 + 页面级组件白名单，
 * 组件只暴露仓库真源里声明的 props/events。绝不返回源码、文件路径或注册表内容。
 */
export interface FrontendCapabilityProjection {
  pageIds: string[];
  keyActions: Array<{ pageId: string; action: string }>;
  components: Record<string, { props: string[]; events: string[] }>;
  pageFacts: Record<string, { components: string[]; slots: string[]; dataPaths: string[] }>;
  slots: string[];
  actions: string[];
  dataPaths: string[];
  themeTokens: string[];
  sizeKeys: string[];
}

export function projectFrontendCapabilities(
  facts: FrontendFacts,
  pageFacts: FrontendPageFactsMap,
  requestedPageIds: readonly string[],
): FrontendCapabilityProjection {
  const pageIds = assertTargetPageIds(requestedPageIds);
  if (pageIds.length === 0) {
    throw frontendError('FRONTEND_REQUEST_INVALID', { path: '$.pageIds' });
  }

  const allowedComponentIds = new Set<string>();
  for (const pageId of pageIds) {
    const entry = pageFacts[pageId];
    if (entry === undefined) throw frontendError('FRONTEND_FACTS_INVALID');
    for (const componentId of entry.components) allowedComponentIds.add(componentId);
  }

  const components: Record<string, { props: string[]; events: string[] }> = {};
  const pageFactsProjection: FrontendCapabilityProjection['pageFacts'] = {};
  for (const pageId of pageIds) {
    pageFactsProjection[pageId] = {
      components: [...pageFacts[pageId].components],
      slots: [...pageFacts[pageId].slots],
      dataPaths: [...pageFacts[pageId].dataPaths],
    };
  }
  for (const componentId of Object.keys(facts.components).sort()) {
    if (!allowedComponentIds.has(componentId)) continue;
    const component = facts.components[componentId];
    components[componentId] = { props: [...component.props], events: [...component.events] };
  }

  const slots = facts.slots.filter((slotId) => pageIds.some((pageId) => pageFacts[pageId].slots.includes(slotId)));
  const actions = facts.actions.filter((action) => pageIds.includes(action.split('.')[0] as FrontendTargetPageId));
  const dataPaths = facts.dataPaths.filter((dataPath) => pageIds.some((pageId) => pageFacts[pageId].dataPaths.includes(dataPath)));

  const keyActions: Array<{ pageId: string; action: string }> = [];
  for (const pageId of pageIds) {
    for (const action of getFrontendKeyActions(facts, pageId)) {
      keyActions.push({ pageId, action });
    }
  }

  return {
    pageIds,
    keyActions,
    components,
    pageFacts: pageFactsProjection,
    slots,
    actions,
    dataPaths,
    themeTokens: [...facts.themeTokens],
    sizeKeys: [...facts.sizeKeys],
  };
}

/**
 * 从 Base 目标页补全 `mustKeep`：每个目标页的 `page:<id>` 与关键动作必须保留。
 * 补全项本身必须命中注入事实，否则视为事实快照漂移（fail closed）。
 */
export function completeRequirementMustKeep(
  requirement: UiRequirement,
  facts: FrontendFacts,
  targetPages: readonly FrontendTargetPageId[],
): UiRequirement {
  const factIds = new Set(buildFrontendCapabilityIds(facts));
  const existing = new Set(requirement.mustKeep.map((item) => item.ref));
  const additions: MustKeep[] = [];

  for (const pageId of targetPages) {
    const refs = [
      `page:${pageId}`,
      ...getFrontendKeyActions(facts, pageId).map((action) => `action:${action}`),
    ];
    for (const ref of refs) {
      if (existing.has(ref)) continue;
      if (!factIds.has(ref)) throw frontendError('FRONTEND_FACTS_INVALID');
      const kind: MustKeep['kind'] = ref.startsWith('page:') ? 'page' : 'action';
      additions.push({ kind, ref });
      existing.add(ref);
    }
  }

  if (additions.length === 0) return requirement;
  const mustKeep = [...requirement.mustKeep, ...additions];
  if (mustKeep.length > FRONTEND_LIMITS.maxMustKeep) {
    throw frontendError('FRONTEND_REQUIREMENT_INVALID', { path: '$.mustKeep' });
  }
  return { ...requirement, mustKeep };
}

function missingCapabilityReason(capability: string): string {
  const prefix = capability.split(':', 1)[0];
  switch (prefix) {
    case 'page':
      return 'Base 没有该页面。';
    case 'component':
      return 'Base 没有该组件。';
    case 'slot':
      return 'Base 页面没有该插槽锚点。';
    case 'action':
      return 'Base 控制器没有该动作。';
    case 'data':
      return 'Base 页面没有该数据绑定。';
    default:
      return 'Base 没有该能力。';
  }
}

/**
 * 服务端权威覆盖结论。
 *
 * required 来源：mustKeep、requirement.pages、bindings，以及调用方显式声明的
 * `additionalRequiredCapabilities`（模型认为必需、但可能不存在的能力 id）。
 * - missing 非空 → rejected（即便草稿结构合法也不生成）；
 * - 有视觉降级 → partial（可生成但默认展示、不自动采用）；
 * - 否则 covered。
 */
export function buildCapabilityCoverage(
  requirement: UiRequirement,
  facts: FrontendFacts,
  options: { additionalRequiredCapabilities?: readonly string[] } = {},
): CapabilityCoverageReport {
  const required = new Set<string>();
  for (const keep of requirement.mustKeep) required.add(keep.ref);
  for (const page of requirement.pages) required.add(`page:${page.pageId}`);
  for (const binding of requirement.bindings) {
    if (binding.dataPath !== undefined) required.add(`data:${binding.dataPath}`);
    if (binding.eventName !== undefined) required.add(`action:${binding.eventName}`);
  }
  for (const capability of options.additionalRequiredCapabilities ?? []) {
    required.add(capability);
  }

  const requiredCapabilities = [...required].sort();
  if (
    requiredCapabilities.length === 0
    || requiredCapabilities.length > FRONTEND_LIMITS.maxRequiredCapabilities
  ) {
    throw frontendError('FRONTEND_COVERAGE_INVALID', { path: '$.requiredCapabilities' });
  }

  const factIds = new Set(buildFrontendCapabilityIds(facts));
  const coveredBy: Record<string, string> = {};
  const missingCapabilities: string[] = [];
  const risks: CoverageRisk[] = [];

  for (const capability of requiredCapabilities) {
    if (factIds.has(capability)) {
      coveredBy[capability] = capability;
      continue;
    }
    missingCapabilities.push(capability);
    if (risks.length < FRONTEND_LIMITS.maxCoverageRisks) {
      risks.push({ capability, reason: missingCapabilityReason(capability) });
    }
  }

  const degradations = requirement.degradations.map((degradation) => ({
    label: degradation.label,
    reason: degradation.reason,
    severity: degradation.severity,
  }));
  if (degradations.length > FRONTEND_LIMITS.maxDegradations) {
    throw frontendError('FRONTEND_COVERAGE_INVALID', { path: '$.degradations' });
  }

  const status = missingCapabilities.length > 0
    ? 'rejected'
    : degradations.length > 0
      ? 'partial'
      : 'covered';

  return {
    status,
    requiredCapabilities,
    missingCapabilities,
    coveredBy,
    risks,
    degradations,
  };
}
