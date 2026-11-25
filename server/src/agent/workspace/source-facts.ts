/**
 * 全项目 SourceFacts v2（只读）。
 *
 * 事实来源唯一：`source-facts.snapshot.ts` 及其页面/组件模块，由
 * `scripts/agent-source-facts.cjs` 从 Base/Catalog 确定性生成。
 *
 * 设计要点：
 * - 服务端只读且 fail closed：版本、8 页集合、组件/页面交叉引用、page-contract、
 *   路径安全与快照摘要任一不成立都抛 `SOURCE_FACTS_INVALID`，绝不降级成空事实继续；
 * - 事实包含「当前 WXML 未使用但 data/setData 里真实存在」的字段与 declared-only 组件，
 *   不把“旧 WXML 没用过”当成“数据不可用”；
 * - 不访问文件系统、不访问网络、不依赖 Nest；运行时只消费打包快照。
 */

import { createHash } from 'node:crypto';

import { SOURCE_FACTS_SNAPSHOT } from './source-facts.snapshot';

export const SOURCE_FACTS_VERSION = 'source-facts.v2' as const;

export const SOURCE_FACTS_PAGE_IDS = [
  'home',
  'menu',
  'checkout',
  'orders',
  'order-detail',
  'product-detail',
  'mine',
  'merchant-orders',
] as const;

export type SourceFactsPageId = (typeof SOURCE_FACTS_PAGE_IDS)[number];

export interface SourceFactsErrorDetails {
  path?: string;
  [key: string]: unknown;
}

export class SourceFactsError extends Error {
  readonly code: string;
  readonly details?: SourceFactsErrorDetails;

  constructor(code: string, message: string, details?: SourceFactsErrorDetails) {
    super(message);
    this.name = 'SourceFactsError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export interface SourceFactsDataValue {
  key: string;
  descriptor: string;
}

export interface SourceFactsUiState {
  key: string;
  kind: string;
  initial: string;
  usedInWxml: boolean;
  required: boolean;
}

export interface SourceFactsComponentRef {
  id: string;
  mode: string;
  usedInWxml: boolean;
}

export interface SourceFactsSlot {
  slotId: string;
  maxItems: number;
  accepts: string[];
  required: boolean;
  dataKey: string | null;
  declaredIn: string[];
  anchors: { begin: number; end: number; fallbackBegin: number; fallbackEnd: number };
}

export interface SourceFactsPlanAllocation {
  referencePlanId: string;
  referencePlanVersion: string;
  features: Array<{ featureId: string; version: string; slotId: string; planId: string; planVersion: string }>;
  availableFeaturePlacements: Array<{ featureId: string; version: string; slotId: string; planId: string; planVersion: string }>;
}

export interface SourceFactsPageContract {
  schemaVersion: 'page-contract.v1';
  pageId: string;
  coreFlows: string[];
  requiredHandlers: string[];
  requiredData: string[];
  requiredStates: string[];
  requiredComponentEvents: Array<{ component: string; event: string; handler: string }>;
  requiredRoutes: string[];
  availableCheckIds: string[];
}

export interface SourceFactsPage {
  pageId: string;
  path: string;
  audience: string;
  appRoute: string;
  title: string;
  summary: string;
  source: {
    root: string;
    wxml: string;
    wxss: string;
    js: string;
    json: string;
    extensions: string | null;
    requiredJs: string[];
  };
  pageJson: {
    navigationBarTitleText: string;
    enablePullDownRefresh: boolean;
    usingComponents: Record<string, string>;
  };
  data: {
    initial: Record<string, string>;
    setData: string[];
    dynamicSetData: Array<{ method: string; kind: string; line: number }>;
  };
  handlers: {
    methods: string[];
    lifecycle: string[];
    events: string[];
    reads: { detail: string[]; dataset: string[]; data: string[] };
  };
  uiStates: SourceFactsUiState[];
  components: SourceFactsComponentRef[];
  slots: SourceFactsSlot[];
  planAllocation: SourceFactsPlanAllocation;
  localAssets: string[];
  themeTokens: string[];
  routes: string[];
  pageContract: SourceFactsPageContract;
  metadataGaps: Array<{ code: string; pageId: string; detail: string }>;
}

export interface SourceFactsComponent {
  id: string;
  kind: string;
  root: string;
  files: string[];
  registry: [string, string, string, string] | null;
  props: Array<[string, string, boolean, unknown]>;
  events: Array<[string, string[]]>;
  example: string;
  limits: string[];
}

export interface SourceFactsPlan {
  id: string;
  version: string;
  features: Array<{ featureId: string; version: string; pageId: string; slotId: string; dataKey: string | null; planId: string; planVersion: string }>;
  themeTokens: string[];
}

export interface SourceFactsSnapshot {
  version: typeof SOURCE_FACTS_VERSION;
  base: {
    id: string;
    version: string;
    root: string;
    manifest: string;
    catalogVersion: string;
    catalogBaseDigest: string | null;
    entryFiles: string[];
    builtinComponents: string[];
  };
  themeTokens: Array<{ key: string; cssVar: string; type: string; required: boolean; contrastWith?: string }>;
  localAssets: Array<{ id: string; path: string; bytes: number; kind: string; usedBy: string[]; wxmlUsages: string[] }>;
  components: Record<string, SourceFactsComponent>;
  plans: SourceFactsPlan[];
  checkIds: Array<{ id: string; scope: 'page' | 'project'; description: string }>;
  metadataGaps: Array<{ code: string; pageId: string; detail: string }>;
  pages: Record<SourceFactsPageId, SourceFactsPage>;
  digest: string;
}

export interface SourceFactsTargetPage {
  id: SourceFactsPageId;
  enabled: boolean;
  reasons: string[];
}

export interface SourceFactsSummary {
  version: string;
  pageIds: SourceFactsPageId[];
  pageCount: number;
  componentCount: number;
  componentIds: string[];
  checkIds: string[];
  planIds: string[];
  enabledTargetPages: SourceFactsTargetPage[];
  digest: string;
}

const CHECK_ID_VALUES = new Set([
  'source.check',
  'mini.check',
  'composer.dry-run',
  'output.consistency',
  'unit.targeted',
  'unit.full',
  'desktop.contract',
  'catalog.check',
  'registry.check',
  'wechat.verify',
]);

function fail(path: string, detail: string): never {
  throw new SourceFactsError('SOURCE_FACTS_INVALID', 'SourceFacts 快照非法：' + detail, { path });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function expectObject(value: unknown, path: string): Record<string, unknown> {
  if (!isPlainObject(value)) fail(path, '必须是对象');
  return value;
}

function expectArray(value: unknown, path: string, min = 0): unknown[] {
  if (!Array.isArray(value) || value.length < min) fail(path, '必须是数组');
  return value;
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== 'string') fail(path, '必须是字符串');
  return value;
}

function expectStringArray(value: unknown, path: string, min = 0): string[] {
  const array = expectArray(value, path, min);
  for (let index = 0; index < array.length; index += 1) {
    if (typeof array[index] !== 'string') fail(`${path}[${index}]`, '必须是字符串');
  }
  return array as string[];
}

function expectSortedUniqueStrings(value: unknown, path: string, min = 0): string[] {
  const array = expectStringArray(value, path, min);
  const sorted = [...array].sort();
  if (JSON.stringify(sorted) !== JSON.stringify(array)) fail(path, '必须稳定排序');
  if (new Set(array).size !== array.length) fail(path, '不能含重复项');
  return array;
}

function expectEnum(value: unknown, allowed: readonly string[], path: string): string {
  const text = expectString(value, path);
  if (!allowed.includes(text)) fail(path, '枚举值非法：' + text);
  return text;
}

function assertSafeRelativePath(value: unknown, path: string): string {
  const text = expectString(value, path);
  if (text.length === 0 || text.startsWith('/') || text.includes('\\') || /^[A-Za-z]:/.test(text) || text.split('/').includes('..')) {
    fail(path, '必须是仓库相对 POSIX 路径');
  }
  return text;
}

function assertPathHasPrefix(value: unknown, prefix: string, path: string): string {
  const text = assertSafeRelativePath(value, path);
  if (!text.startsWith(prefix)) fail(path, '路径前缀必须是 ' + prefix);
  return text;
}

function sha256(text: string): string {
  return 'sha256:' + createHash('sha256').update(text, 'utf8').digest('hex');
}

function canonicalDigest(snapshot: Record<string, unknown>): string {
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(snapshot)) {
    if (key === 'digest') continue;
    copy[key] = snapshot[key];
  }
  return sha256(JSON.stringify(copy));
}

function validateComponent(componentId: string, raw: unknown, pageIds: readonly string[]): SourceFactsComponent {
  const path = `$.components.${componentId}`;
  const entry = expectObject(raw, path);
  if (entry.id !== componentId) fail(path + '.id', '与 map key 不一致');
  expectEnum(entry.kind, ['base-builtin', 'feature-pack'], path + '.kind');
  assertSafeRelativePath(entry.root, path + '.root');
  expectStringArray(entry.files, path + '.files', 1);
  if (entry.registry !== null) {
    const registry = expectArray(entry.registry, path + '.registry');
    if (registry.length !== 4) fail(path + '.registry', '必须是 4 元组');
    expectString(registry[0], path + '.registry[0]');
    expectString(registry[1], path + '.registry[1]');
    expectString(registry[2], path + '.registry[2]');
    assertSafeRelativePath(registry[3], path + '.registry[3]');
  }
  const props = expectArray(entry.props, path + '.props');
  for (let index = 0; index < props.length; index += 1) {
    const prop = expectArray(props[index], `${path}.props[${index}]`);
    if (prop.length !== 4) fail(`${path}.props[${index}]`, '必须是 4 元组');
    expectString(prop[0], `${path}.props[${index}][0]`);
    expectString(prop[1], `${path}.props[${index}][1]`);
    if (typeof prop[2] !== 'boolean') fail(`${path}.props[${index}][2]`, 'required 必须是布尔');
  }
  const events = expectArray(entry.events, path + '.events');
  for (let index = 0; index < events.length; index += 1) {
    const event = expectArray(events[index], `${path}.events[${index}]`);
    if (event.length !== 2) fail(`${path}.events[${index}]`, '必须是 2 元组');
    expectString(event[0], `${path}.events[${index}][0]`);
    expectStringArray(event[1], `${path}.events[${index}][1]`);
  }
  expectStringArray(entry.limits, path + '.limits');
  return {
    id: componentId,
    kind: entry.kind as string,
    root: entry.root as string,
    files: entry.files as string[],
    registry: entry.registry as [string, string, string, string] | null,
    props: props as Array<[string, string, boolean, unknown]>,
    events: events as Array<[string, string[]]>,
    example: expectString(entry.example, path + '.example'),
    limits: entry.limits as string[],
  };
}

function validatePage(rawPage: unknown, pageId: string, componentIds: ReadonlySet<string>, checkIds: ReadonlySet<string>, themeKeys: ReadonlySet<string>): SourceFactsPage {
  const path = `$.pages.${pageId}`;
  const page = expectObject(rawPage, path);
  if (page.pageId !== pageId) fail(path + '.pageId', '与 map key 不一致');
  if (page.path !== 'pages/' + pageId) fail(path + '.path', '必须是 pages/<id>');
  if (page.appRoute !== 'pages/' + pageId + '/index') fail(path + '.appRoute', '必须是 pages/<id>/index');
  expectEnum(page.audience, ['customer', 'merchant'], path + '.audience');
  expectString(page.title, path + '.title');
  expectString(page.summary, path + '.summary');

  const source = expectObject(page.source, path + '.source');
  const pageRoot = assertPathHasPrefix(source.root, 'templates/base/', path + '.source.root');
  for (const key of ['wxml', 'wxss', 'js', 'json']) {
    const filePath = assertPathHasPrefix(source[key], pageRoot + '/', path + '.source.' + key);
    if (!filePath.endsWith('index.' + key)) fail(path + '.source.' + key, '必须是页面 index 文件');
  }
  if (source.extensions !== null) assertPathHasPrefix(source.extensions, pageRoot + '/', path + '.source.extensions');
  expectStringArray(source.requiredJs, path + '.source.requiredJs').forEach((file, index) => {
    assertPathHasPrefix(file, 'templates/base/', `${path}.source.requiredJs[${index}]`);
  });

  const pageJson = expectObject(page.pageJson, path + '.pageJson');
  expectString(pageJson.navigationBarTitleText, path + '.pageJson.navigationBarTitleText');
  if (typeof pageJson.enablePullDownRefresh !== 'boolean') fail(path + '.pageJson.enablePullDownRefresh', '必须是布尔');
  const using = expectObject(pageJson.usingComponents, path + '.pageJson.usingComponents');
  for (const [tag, target] of Object.entries(using)) {
    expectString(tag, path + '.pageJson.usingComponents key');
    const text = expectString(target, path + '.pageJson.usingComponents.' + tag);
    if (!/^\/components\/[a-z0-9-]+\/index$/.test(text)) fail(path + '.pageJson.usingComponents.' + tag, '组件路径非法');
  }

  const data = expectObject(page.data, path + '.data');
  const initial = expectObject(data.initial, path + '.data.initial');
  for (const [key, descriptor] of Object.entries(initial)) {
    expectString(key, path + '.data.initial key');
    expectString(descriptor, path + '.data.initial.' + key);
  }
  const setData = expectSortedUniqueStrings(data.setData, path + '.data.setData', 1);
  expectArray(data.dynamicSetData, path + '.data.dynamicSetData');

  const handlers = expectObject(page.handlers, path + '.handlers');
  const methods = expectSortedUniqueStrings(handlers.methods, path + '.handlers.methods', 1);
  const lifecycle = expectSortedUniqueStrings(handlers.lifecycle, path + '.handlers.lifecycle');
  const events = expectArray(handlers.events, path + '.handlers.events');
  for (let index = 0; index < events.length; index += 1) {
    const event = expectString(events[index], `${path}.handlers.events[${index}]`);
    const match = event.match(/^([a-z0-9-]+):([A-Za-z][\w-]*)=([A-Za-z_$][\w$]*)$/);
    if (!match) fail(`${path}.handlers.events[${index}]`, '事件必须是 tag:event=handler');
    if (!methods.includes(match[3]) && !lifecycle.includes(match[3])) fail(`${path}.handlers.events[${index}]`, 'handler 不在 methods/lifecycle');
  }
  const reads = expectObject(handlers.reads, path + '.handlers.reads');
  expectStringArray(reads.detail, path + '.handlers.reads.detail');
  expectStringArray(reads.dataset, path + '.handlers.reads.dataset');
  expectStringArray(reads.data, path + '.handlers.reads.data');

  const uiStates = expectArray(page.uiStates, path + '.uiStates', 1);
  const stateKeys = new Set<string>();
  for (let index = 0; index < uiStates.length; index += 1) {
    const state = expectObject(uiStates[index], `${path}.uiStates[${index}]`);
    const key = expectString(state.key, `${path}.uiStates[${index}].key`);
    if (!Object.prototype.hasOwnProperty.call(initial, key)) fail(`${path}.uiStates[${index}].key`, 'state 不在 data.initial');
    if (stateKeys.has(key)) fail(`${path}.uiStates[${index}].key`, 'state 重复');
    stateKeys.add(key);
    expectString(state.kind, `${path}.uiStates[${index}].kind`);
    expectString(state.initial, `${path}.uiStates[${index}].initial`);
    if (typeof state.usedInWxml !== 'boolean') fail(`${path}.uiStates[${index}].usedInWxml`, '必须是布尔');
    if (typeof state.required !== 'boolean') fail(`${path}.uiStates[${index}].required`, '必须是布尔');
  }

  const components = expectArray(page.components, path + '.components');
  for (let index = 0; index < components.length; index += 1) {
    const component = expectObject(components[index], `${path}.components[${index}]`);
    const id = expectString(component.id, `${path}.components[${index}].id`);
    if (!componentIds.has(id)) fail(`${path}.components[${index}].id`, '组件不在 components 事实中');
    expectString(component.mode, `${path}.components[${index}].mode`);
    if (typeof component.usedInWxml !== 'boolean') fail(`${path}.components[${index}].usedInWxml`, '必须是布尔');
  }

  const slots = expectArray(page.slots, path + '.slots');
  const slotIds = new Set<string>();
  for (let index = 0; index < slots.length; index += 1) {
    const slot = expectObject(slots[index], `${path}.slots[${index}]`);
    const slotId = expectString(slot.slotId, `${path}.slots[${index}].slotId`);
    if (slotIds.has(slotId)) fail(`${path}.slots[${index}].slotId`, 'slot 重复');
    slotIds.add(slotId);
    if (typeof slot.maxItems !== 'number') fail(`${path}.slots[${index}].maxItems`, '必须是数字');
    expectStringArray(slot.accepts, `${path}.slots[${index}].accepts`, 1);
    if (typeof slot.required !== 'boolean') fail(`${path}.slots[${index}].required`, '必须是布尔');
    const anchors = expectObject(slot.anchors, `${path}.slots[${index}].anchors`);
    for (const anchorKey of ['begin', 'end', 'fallbackBegin', 'fallbackEnd']) {
      if (typeof anchors[anchorKey] !== 'number') fail(`${path}.slots[${index}].anchors.${anchorKey}`, '必须是数字');
    }
  }

  const plan = expectObject(page.planAllocation, path + '.planAllocation');
  if (typeof plan.referencePlanId !== 'string') fail(path + '.planAllocation.referencePlanId', '必须是字符串');
  for (const key of ['features', 'availableFeaturePlacements']) {
    const items = expectArray(plan[key], `${path}.planAllocation.${key}`);
    for (let index = 0; index < items.length; index += 1) {
      const item = expectObject(items[index], `${path}.planAllocation.${key}[${index}]`);
      if (!slotIds.has(expectString(item.slotId, `${path}.planAllocation.${key}[${index}].slotId`))) {
        fail(`${path}.planAllocation.${key}[${index}].slotId`, 'slot 不在本页');
      }
      expectString(item.featureId, `${path}.planAllocation.${key}[${index}].featureId`);
      expectString(item.planId, `${path}.planAllocation.${key}[${index}].planId`);
    }
  }

  expectStringArray(page.localAssets, path + '.localAssets');
  const pageThemes = expectStringArray(page.themeTokens, path + '.themeTokens', 1);
  for (const theme of pageThemes) {
    if (!themeKeys.has(theme)) fail(path + '.themeTokens', '未知主题 token：' + theme);
  }
  expectStringArray(page.routes, path + '.routes');

  const contract = expectObject(page.pageContract, path + '.pageContract');
  if (contract.schemaVersion !== 'page-contract.v1') fail(path + '.pageContract.schemaVersion', '必须是 page-contract.v1');
  if (contract.pageId !== pageId) fail(path + '.pageContract.pageId', '与 pageId 不一致');
  expectStringArray(contract.coreFlows, path + '.pageContract.coreFlows', 1);
  const requiredHandlers = expectStringArray(contract.requiredHandlers, path + '.pageContract.requiredHandlers', 1);
  for (const handler of requiredHandlers) {
    if (!methods.includes(handler) && !lifecycle.includes(handler)) fail(path + '.pageContract.requiredHandlers', 'handler 不存在：' + handler);
  }
  const requiredData = expectStringArray(contract.requiredData, path + '.pageContract.requiredData', 1);
  const roots = new Set([...Object.keys(initial), ...setData.map((item) => item.split(/[.[]/)[0])].filter(Boolean));
  for (const key of requiredData) {
    if (!roots.has(key)) fail(path + '.pageContract.requiredData', 'data 根不存在：' + key);
  }
  const requiredStates = expectStringArray(contract.requiredStates, path + '.pageContract.requiredStates', 1);
  for (const key of requiredStates) {
    if (!stateKeys.has(key)) fail(path + '.pageContract.requiredStates', 'state 不存在：' + key);
  }
  const contractEvents = expectArray(contract.requiredComponentEvents, path + '.pageContract.requiredComponentEvents');
  const wired = new Set(events as string[]);
  for (let index = 0; index < contractEvents.length; index += 1) {
    const item = expectObject(contractEvents[index], `${path}.pageContract.requiredComponentEvents[${index}]`);
    const componentId = expectString(item.component, `${path}.pageContract.requiredComponentEvents[${index}].component`);
    const event = expectString(item.event, `${path}.pageContract.requiredComponentEvents[${index}].event`);
    const handler = expectString(item.handler, `${path}.pageContract.requiredComponentEvents[${index}].handler`);
    if (!componentIds.has(componentId)) fail(`${path}.pageContract.requiredComponentEvents[${index}].component`, '组件不存在');
    if (!wired.has(componentId + ':' + event + '=' + handler)) fail(`${path}.pageContract.requiredComponentEvents[${index}]`, '事件未接线');
  }
  const requiredRoutes = expectStringArray(contract.requiredRoutes, path + '.pageContract.requiredRoutes');
  const routes = new Set(page.routes as string[]);
  for (const route of requiredRoutes) {
    if (!routes.has(route)) fail(path + '.pageContract.requiredRoutes', '路由出口不存在：' + route);
  }
  const available = expectStringArray(contract.availableCheckIds, path + '.pageContract.availableCheckIds', 1);
  for (const checkId of available) {
    if (!checkIds.has(checkId)) fail(path + '.pageContract.availableCheckIds', 'checkId 不在注册表：' + checkId);
  }

  const gaps = expectArray(page.metadataGaps, path + '.metadataGaps');
  for (let index = 0; index < gaps.length; index += 1) {
    const gap = expectObject(gaps[index], `${path}.metadataGaps[${index}]`);
    expectString(gap.code, `${path}.metadataGaps[${index}].code`);
    if (gap.pageId !== pageId) fail(`${path}.metadataGaps[${index}].pageId`, '与页面不一致');
    expectString(gap.detail, `${path}.metadataGaps[${index}].detail`);
  }

  return page as unknown as SourceFactsPage;
}

export function validateSourceFactsSnapshot(raw: unknown): SourceFactsSnapshot {
  const snapshot = expectObject(raw, '$');
  if (snapshot.version !== SOURCE_FACTS_VERSION) fail('$.version', '必须是 ' + SOURCE_FACTS_VERSION);

  const allowedTopKeys = ['version', 'base', 'themeTokens', 'localAssets', 'components', 'plans', 'checkIds', 'metadataGaps', 'pages', 'digest'];
  for (const key of Object.keys(snapshot)) {
    if (!allowedTopKeys.includes(key)) fail('$', '未知顶层字段：' + key);
  }

  const base = expectObject(snapshot.base, '$.base');
  if (base.id !== 'ordering-base' || base.version !== '1.0.0') fail('$.base', 'Base 身份必须是 ordering-base@1.0.0');
  assertPathHasPrefix(base.root, 'templates/base/', '$.base.root');
  assertPathHasPrefix(base.manifest, 'templates/base/', '$.base.manifest');
  expectString(base.catalogVersion, '$.base.catalogVersion');
  if (base.catalogBaseDigest !== null) expectString(base.catalogBaseDigest, '$.base.catalogBaseDigest');
  expectStringArray(base.entryFiles, '$.base.entryFiles', 1).forEach((file, index) => {
    assertPathHasPrefix(file, 'templates/base/', `$.base.entryFiles[${index}]`);
  });
  expectStringArray(base.builtinComponents, '$.base.builtinComponents', 1);

  const themes = expectArray(snapshot.themeTokens, '$.themeTokens', 1);
  const themeKeys = new Set<string>();
  for (let index = 0; index < themes.length; index += 1) {
    const token = expectObject(themes[index], `$.themeTokens[${index}]`);
    const key = expectString(token.key, `$.themeTokens[${index}].key`);
    if (themeKeys.has(key)) fail(`$.themeTokens[${index}].key`, '重复');
    themeKeys.add(key);
    expectString(token.cssVar, `$.themeTokens[${index}].cssVar`);
    expectString(token.type, `$.themeTokens[${index}].type`);
    if (typeof token.required !== 'boolean') fail(`$.themeTokens[${index}].required`, '必须是布尔');
  }

  const assets = expectArray(snapshot.localAssets, '$.localAssets');
  const assetIds = new Set<string>();
  for (let index = 0; index < assets.length; index += 1) {
    const asset = expectObject(assets[index], `$.localAssets[${index}]`);
    const id = expectString(asset.id, `$.localAssets[${index}].id`);
    if (assetIds.has(id)) fail(`$.localAssets[${index}].id`, '重复');
    assetIds.add(id);
    assertPathHasPrefix(asset.path, 'templates/base/', `$.localAssets[${index}].path`);
    if (typeof asset.bytes !== 'number') fail(`$.localAssets[${index}].bytes`, '必须是数字');
    expectString(asset.kind, `$.localAssets[${index}].kind`);
    expectStringArray(asset.usedBy, `$.localAssets[${index}].usedBy`);
    expectStringArray(asset.wxmlUsages, `$.localAssets[${index}].wxmlUsages`);
  }

  const components = expectObject(snapshot.components, '$.components');
  const componentIds = new Set(Object.keys(components));
  for (const componentId of Object.keys(components)) {
    validateComponent(componentId, components[componentId], SOURCE_FACTS_PAGE_IDS);
  }

  const checkIdsRaw = expectArray(snapshot.checkIds, '$.checkIds', 1);
  const checkIds = new Set<string>();
  for (let index = 0; index < checkIdsRaw.length; index += 1) {
    const check = expectObject(checkIdsRaw[index], `$.checkIds[${index}]`);
    const id = expectString(check.id, `$.checkIds[${index}].id`);
    if (!CHECK_ID_VALUES.has(id)) fail(`$.checkIds[${index}].id`, '未知 checkId：' + id);
    if (checkIds.has(id)) fail(`$.checkIds[${index}].id`, '重复');
    checkIds.add(id);
    expectEnum(check.scope, ['page', 'project'], `$.checkIds[${index}].scope`);
    expectString(check.description, `$.checkIds[${index}].description`);
  }

  const plans = expectArray(snapshot.plans, '$.plans', 1);
  for (let index = 0; index < plans.length; index += 1) {
    const plan = expectObject(plans[index], `$.plans[${index}]`);
    expectString(plan.id, `$.plans[${index}].id`);
    expectString(plan.version, `$.plans[${index}].version`);
    expectArray(plan.features, `$.plans[${index}].features`);
    expectStringArray(plan.themeTokens, `$.plans[${index}].themeTokens`);
  }

  const pagesRaw = expectObject(snapshot.pages, '$.pages');
  const pageKeys = Object.keys(pagesRaw).sort();
  if (JSON.stringify(pageKeys) !== JSON.stringify([...SOURCE_FACTS_PAGE_IDS].sort())) {
    fail('$.pages', '必须恰为 8 页：' + [...SOURCE_FACTS_PAGE_IDS].join(','));
  }
  const pages: Record<string, SourceFactsPage> = {};
  for (const pageId of SOURCE_FACTS_PAGE_IDS) {
    pages[pageId] = validatePage(pagesRaw[pageId], pageId, componentIds, checkIds, themeKeys);
  }

  const gaps = expectArray(snapshot.metadataGaps, '$.metadataGaps');
  for (let index = 0; index < gaps.length; index += 1) {
    const gap = expectObject(gaps[index], `$.metadataGaps[${index}]`);
    expectString(gap.code, `$.metadataGaps[${index}].code`);
    if (typeof gap.pageId !== 'string' || !(SOURCE_FACTS_PAGE_IDS as readonly string[]).includes(gap.pageId)) {
      fail(`$.metadataGaps[${index}].pageId`, '未知页面');
    }
    expectString(gap.detail, `$.metadataGaps[${index}].detail`);
  }

  const digest = expectString(snapshot.digest, '$.digest');
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) fail('$.digest', '摘要格式非法');
  const recomputed = canonicalDigest(snapshot);
  if (recomputed !== digest) fail('$.digest', '摘要与内容不一致');

  return {
    version: SOURCE_FACTS_VERSION,
    base: base as unknown as SourceFactsSnapshot['base'],
    themeTokens: themes as unknown as SourceFactsSnapshot['themeTokens'],
    localAssets: assets as unknown as SourceFactsSnapshot['localAssets'],
    components: components as unknown as Record<string, SourceFactsComponent>,
    plans: plans as unknown as SourceFactsPlan[],
    checkIds: checkIdsRaw as unknown as SourceFactsSnapshot['checkIds'],
    metadataGaps: gaps as unknown as SourceFactsSnapshot['metadataGaps'],
    pages: pages as unknown as Record<SourceFactsPageId, SourceFactsPage>,
    digest,
  };
}

let cachedSnapshot: SourceFactsSnapshot | null = null;

/** 加载并 fail-closed 校验打包快照；非法快照一律抛 SOURCE_FACTS_INVALID。 */
export function loadSourceFacts(): SourceFactsSnapshot {
  if (cachedSnapshot !== null) return cachedSnapshot;
  try {
    cachedSnapshot = validateSourceFactsSnapshot(SOURCE_FACTS_SNAPSHOT);
  } catch (error) {
    if (error instanceof SourceFactsError) throw error;
    throw new SourceFactsError('SOURCE_FACTS_INVALID', 'SourceFacts 快照无法加载', {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  return cachedSnapshot;
}

export function getPageSourceFacts(pageId: string): SourceFactsPage {
  const snapshot = loadSourceFacts();
  if (!(SOURCE_FACTS_PAGE_IDS as readonly string[]).includes(pageId)) {
    throw new SourceFactsError('SOURCE_FACTS_PAGE_UNKNOWN', '未知页面：' + pageId, { pageId });
  }
  return snapshot.pages[pageId as SourceFactsPageId];
}

/** 由 SourceFacts 推导的目标页可用性；C1 已覆盖 8 页，故全部 enabled。 */
export function listSourceFactsTargetPages(): SourceFactsTargetPage[] {
  const snapshot = loadSourceFacts();
  return SOURCE_FACTS_PAGE_IDS.map((id) => ({
    id,
    enabled: Boolean(snapshot.pages[id]),
    reasons: ['source-facts', 'page-contract'],
  }));
}

/** 有界摘要：只含 id/计数/checkId/digest，不含源码、路径细节或 prompt。 */
export function summarizeSourceFacts(): SourceFactsSummary {
  const snapshot = loadSourceFacts();
  return {
    version: snapshot.version,
    pageIds: [...SOURCE_FACTS_PAGE_IDS],
    pageCount: SOURCE_FACTS_PAGE_IDS.length,
    componentCount: Object.keys(snapshot.components).length,
    componentIds: Object.keys(snapshot.components).sort(),
    checkIds: snapshot.checkIds.map((check) => check.id),
    planIds: snapshot.plans.map((plan) => plan.id + '@' + plan.version),
    enabledTargetPages: listSourceFactsTargetPages(),
    digest: snapshot.digest,
  };
}

/** 只用于测试替换/清理（生产路径不调用）。 */
export function resetSourceFactsCacheForTests(): void {
  cachedSnapshot = null;
}

export { SOURCE_FACTS_SNAPSHOT };
