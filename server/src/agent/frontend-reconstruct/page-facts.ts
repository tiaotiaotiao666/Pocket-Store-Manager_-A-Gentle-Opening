/**
 * 页面级只读能力事实（frontend-page-facts.v1）。
 *
 * 与全局 `FrontendFacts` 的分工：
 * - 全局事实回答“Base 里有哪些能力”；
 * - 页面事实回答“这个页面真的能用哪些组件/插槽/数据路径”，
 *   与桌面 P2 `materialize.loadPageFacts` 完全同源（Base 页面 `usingComponents`、
 *   Base Manifest 插槽、页面 WXML 中真实的 `{{a.b}}` 数据路径）。
 *
 * 服务端在 validateFrontendPackDraft / planned 响应校验中必须同时检查两者：
 * 仅命中全局事实、但组件未在本页 `usingComponents` 声明（例如 home 用 cart-bar）
 * 的草稿，P2 物化会拒绝，P1 必须提前给出同样的失败。
 *
 * 快照由 `scripts/frontend-capabilities.cjs` 生成；本文件只读、fail closed。
 */

import { FrontendReconstructError, frontendError } from './errors';
import { FRONTEND_CAPABILITIES_SNAPSHOT } from './capabilities.snapshot';
import { ACTION_PATTERN, DATA_PATH_PATTERN, FRONTEND_PAGE_FACTS_VERSION, LOWERCASE_ID_PATTERN } from './contract.generated';
import { FRONTEND_LIMITS, FRONTEND_TARGET_PAGES } from './types';

export { FRONTEND_PAGE_FACTS_VERSION };

export interface FrontendPageFacts {
  components: string[];
  slots: string[];
  dataPaths: string[];
}

export type FrontendPageFactsMap = Record<string, FrontendPageFacts>;

/** 每页关键动作：与快照 `keyActions` 同源，completeRequirementMustKeep / prompt 共用。 */
export type FrontendKeyActionsMap = Record<string, string[]>;

export interface FrontendFactsBundle {
  pages: FrontendPageFactsMap;
  keyActions: FrontendKeyActionsMap;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function fail(): never {
  throw frontendError('FRONTEND_FACTS_INVALID');
}

function readStringArray(
  value: unknown,
  pattern: RegExp,
  options: { min: number; max: number },
): string[] {
  if (!Array.isArray(value) || value.length < options.min || value.length > options.max) fail();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !pattern.test(item) || out.includes(item)) fail();
    out.push(item);
  }
  return out;
}

/**
 * 校验页面级事实 map（`{ home: {...}, menu: {...} }`）。
 * 必须同时包含全部契约目标页，且每页只有 components/slots/dataPaths 三个键
 * （与 P2 parsePageFacts 对齐）。
 */
export function validateFrontendPageFactsMap(raw: unknown): FrontendPageFactsMap {
  if (!isPlainObject(raw)) fail();
  const pageIds = Object.keys(raw);
  if (pageIds.length !== FRONTEND_TARGET_PAGES.length) fail();
  for (const pageId of FRONTEND_TARGET_PAGES) {
    if (!pageIds.includes(pageId)) fail();
  }

  const pages: FrontendPageFactsMap = {};
  for (const pageId of FRONTEND_TARGET_PAGES) {
    const entry = raw[pageId];
    if (!isPlainObject(entry)) fail();
    for (const key of Object.keys(entry)) {
      if (key !== 'components' && key !== 'slots' && key !== 'dataPaths') fail();
    }
    pages[pageId] = {
      components: readStringArray(entry.components, LOWERCASE_ID_PATTERN, {
        min: 0,
        max: FRONTEND_LIMITS.maxFactsEntries,
      }),
      slots: readStringArray(entry.slots, LOWERCASE_ID_PATTERN, {
        min: 0,
        max: FRONTEND_LIMITS.maxFactsEntries,
      }),
      dataPaths: readStringArray(entry.dataPaths, DATA_PATH_PATTERN, {
        min: 0,
        max: FRONTEND_LIMITS.maxFactsEntries,
      }),
    };
  }
  return pages;
}

/**
 * 校验独立页面事实快照文档 `{version, pages}`（脚本 `--check`/future split 用）。
 * 服务端运行时直接消费 capabilities.snapshot.json 的 `pageFacts` 字段，见 loadFrontendFactsBundle。
 */
export function validateFrontendPageFacts(raw: unknown): FrontendPageFactsMap {
  if (!isPlainObject(raw)) fail();
  for (const key of Object.keys(raw)) {
    if (key !== 'version' && key !== 'pages') fail();
  }
  if (raw.version !== FRONTEND_PAGE_FACTS_VERSION) fail();
  return validateFrontendPageFactsMap(raw.pages);
}

/** 校验 keyActions：必须覆盖全部目标页、动作前缀属于本页，且与全局 actions 同源。 */
export function validateFrontendKeyActions(
  raw: unknown,
  globalActions: readonly string[],
): FrontendKeyActionsMap {
  if (!isPlainObject(raw)) fail();
  const pageIds = Object.keys(raw);
  if (pageIds.length !== FRONTEND_TARGET_PAGES.length) fail();
  const out: FrontendKeyActionsMap = {};
  for (const pageId of FRONTEND_TARGET_PAGES) {
    if (!pageIds.includes(pageId)) fail();
    const actions = readStringArray(raw[pageId], ACTION_PATTERN, { min: 1, max: FRONTEND_LIMITS.maxFactsEntries });
    for (const action of actions) {
      if (action.split('.')[0] !== pageId) fail();
      if (!globalActions.includes(action)) fail();
    }
    const expected = globalActions.filter((action) => action.split('.')[0] === pageId).sort();
    if ([...actions].sort().join('|') !== expected.join('|')) fail();
    out[pageId] = actions;
  }
  return out;
}

function assertPageFactsConsistentWithGlobal(pages: FrontendPageFactsMap): void {
  const globalDataPaths = new Set<string>(FRONTEND_CAPABILITIES_SNAPSHOT.dataPaths);
  const globalSlots = new Set<string>(FRONTEND_CAPABILITIES_SNAPSHOT.slots);
  const union = new Set<string>();
  for (const pageId of FRONTEND_TARGET_PAGES) {
    const page = pages[pageId];
    for (const dataPath of page.dataPaths) {
      if (!globalDataPaths.has(dataPath)) fail();
      union.add(dataPath);
    }
    for (const slot of page.slots) {
      if (!globalSlots.has(slot)) fail();
    }
  }
  // 全局 dataPaths 必须恰好等于页面 dataPaths 的并集，避免两套命名空间并存。
  if (union.size !== globalDataPaths.size) fail();
  for (const dataPath of globalDataPaths) {
    if (!union.has(dataPath)) fail();
  }
}

let cachedBundle: FrontendFactsBundle | null = null;

/**
 * 加载**单一快照文件**里的页面事实与关键动作。
 * 快照非法（缺页/命名空间不一致/keyActions 与 actions 不同源）一律 fail closed。
 */
export function loadFrontendFactsBundle(): FrontendFactsBundle {
  if (cachedBundle !== null) return cachedBundle;
  try {
    const pages = validateFrontendPageFacts({
      version: FRONTEND_PAGE_FACTS_VERSION,
      pages: FRONTEND_CAPABILITIES_SNAPSHOT.pageFacts,
    });
    assertPageFactsConsistentWithGlobal(pages);
    const keyActions = validateFrontendKeyActions(
      FRONTEND_CAPABILITIES_SNAPSHOT.keyActions,
      FRONTEND_CAPABILITIES_SNAPSHOT.actions,
    );
    cachedBundle = { pages, keyActions };
  } catch (error) {
    if (error instanceof FrontendReconstructError) throw error;
    throw frontendError('FRONTEND_FACTS_INVALID');
  }
  return cachedBundle;
}

/** 加载打包的页面级事实；非法快照一律 FRONTEND_FACTS_INVALID（fail closed）。 */
export function loadFrontendPageFacts(): FrontendPageFactsMap {
  return loadFrontendFactsBundle().pages;
}

/** 加载每页关键动作（与快照 keyActions 同源）。 */
export function loadFrontendKeyActions(): FrontendKeyActionsMap {
  return loadFrontendFactsBundle().keyActions;
}

/** 只用于测试替换/清理（生产路径不调用）。 */
export function resetFrontendPageFactsCacheForTests(): void {
  cachedBundle = null;
}
