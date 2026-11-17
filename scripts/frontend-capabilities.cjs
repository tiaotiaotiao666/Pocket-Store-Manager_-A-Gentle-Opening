#!/usr/bin/env node
'use strict';

/**
 * 只读能力快照生成器（frontend-reconstruct.v1 的 FrontendFacts + 页面级事实）。
 *
 * 唯一真源（全部只读）：
 * - `templates/base/ordering-base/1.0.0/manifest.json`：页面、插槽、内置组件、主题 token；
 * - `templates/base/ordering-base/1.0.0/theme.tokens.json`：七类颜色 token；
 * - `templates/catalog/pages/<page>.json`：页面真实使用的组件与控制器方法；
 * - `templates/catalog/components/<component>.json`：组件 props / events 声明；
 * - Base 页面 `index.json` 的 usingComponents、`index.js` 的 data 字段、`index.wxml` 的
 *   事件处理器（`bind:*`）与真实 `{{a.b}}` 数据绑定。
 *
 * 输出（全部同源，`--check` 会一起校验）：
 * - `capabilities.snapshot.json` / `.ts`：全局能力事实（FrontendFacts）；
 * - `page-capabilities.snapshot.json` / `.ts`：页面级事实
 *   `{ [pageId]: { components, slots, dataPaths } }`，与服务端 P1 校验、桌面 P2
 *   `loadPageFacts` 使用同一口径（页面 usingComponents / 插槽 / 本页 WXML 数据路径）。
 *
 * 纪律：
 * - 不读环境变量、不写时间戳、不访问网络；相同输入必须产生逐字节相同的输出；
 * - 不读取模型/客户端提供的任何 id；所有能力都来自仓库真源；
 * - 任何无法解释的组件、事件、数据绑定一律报错退出（fail closed），不静默丢弃；
 * - 文本快照比较按 LF 归一化，避免 Windows core.autocrlf=true 的干净检出误报；
 *   非文本文件按字节比较。
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const BASE_ROOT = path.join(REPO_ROOT, 'templates', 'base', 'ordering-base', '1.0.0');
const BASE_SRC = path.join(BASE_ROOT, 'src');
const CATALOG_ROOT = path.join(REPO_ROOT, 'templates', 'catalog');
const SNAPSHOT_DIR = path.join(REPO_ROOT, 'server', 'src', 'agent', 'frontend-reconstruct');
const SNAPSHOT_JSON = path.join(SNAPSHOT_DIR, 'capabilities.snapshot.json');
const SNAPSHOT_TS = path.join(SNAPSHOT_DIR, 'capabilities.snapshot.ts');
const PAGE_SNAPSHOT_JSON = path.join(SNAPSHOT_DIR, 'page-capabilities.snapshot.json');
const PAGE_SNAPSHOT_TS = path.join(SNAPSHOT_DIR, 'page-capabilities.snapshot.ts');

/** 必须与 server/src/agent/frontend-reconstruct/types.ts 保持一致；测试会断言相等。 */
const TARGET_PAGES = Object.freeze(['home', 'menu']);
const THEME_TOKEN_KEYS = Object.freeze([
  'pageBackground',
  'primaryColor',
  'accentColor',
  'textColor',
  'tabBarBackground',
  'tabBarColor',
  'tabBarSelectedColor',
]);
const SIZE_KEYS = Object.freeze(['homeHero', 'productCard', 'carousel']);
const FACTS_VERSION = 'frontend-facts.v1';
const PAGE_FACTS_VERSION = 'frontend-page-facts.v1';

const LOWERCASE_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const PROP_ID_PATTERN = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
const EVENT_ID_PATTERN = /^[A-Za-z][A-Za-z0-9-]{0,31}$/;
const ACTION_PATTERN = /^[a-z][a-z0-9-]*\.[A-Za-z][A-Za-z0-9]{0,31}$/;
const DATA_PATH_PATTERN = /^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*){1,7}$/;

const MAX_FACTS_ENTRIES = 128;

/** WXML 条件/循环属性表达的是页面状态，不作为可绑定数据 token。 */
const STATE_ATTRIBUTE_PATTERN = /\s(?:wx:if|wx:elif|wx:else|wx:for|wx:for-item|wx:for-index|wx:key)\s*=\s*"[^"]*"/g;
const HANDLER_ATTRIBUTE_PATTERN = /\b(?:bind|catch)[:a-zA-Z]*\s*=\s*"([^"]+)"/g;
const MUSTACHE_PATTERN = /\{\{([^{}]*)\}\}/g;
const IDENTIFIER_CHAIN_PATTERN = /[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*/g;
const LOOP_LOCALS = new Set(['item', 'index', 'true', 'false', 'null', 'undefined', 'NaN', 'Infinity']);

/**
 * 规范化 dataPath 命名空间（P1/P2 单一事实源）：
 * - `store.*` 保持 WXML 原路径（store.name / store.fulfillment.dineIn）；
 * - `cartSummary.*` 归一为 `cart.count|cart.totalCents|cart.items`；
 * - 其他控制器 data 字段归一为 `<pageId>.<key>`（如 home.mode / menu.products）；
 * - 只暴露可展示数据，内部页面状态（loading/error/requestId 等）不进入 DSL。
 */
const INTERNAL_DATA_KEYS = Object.freeze([
  'activeCategoryId',
  'cartVisible',
  'demoMode',
  'detailVisible',
  'error',
  'errorAction',
  'loading',
  'merchantStoreId',
  'quantityMap',
  'requestId',
  'slotProps',
  'storeId',
  'tableOptions',
  'tablesError',
  'tablesLoading',
  'visit',
]);

const CART_SUMMARY_TOKENS = Object.freeze({
  items: 'cart.items',
  totalCents: 'cart.totalCents',
  totalQuantity: 'cart.count',
});

function fail(message) {
  throw new Error('[frontend-capabilities] ' + message);
}

function relative(file) {
  return path.relative(REPO_ROOT, file).replace(/\\/g, '/');
}

function readText(file) {
  if (!fs.existsSync(file)) fail('缺少真源文件：' + relative(file));
  return fs.readFileSync(file, 'utf8');
}

function readJson(file) {
  const text = readText(file);
  try {
    return JSON.parse(text);
  } catch (error) {
    fail('无法解析 ' + relative(file) + '：' + (error instanceof Error ? error.message : String(error)));
  }
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function assertPattern(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    fail(label + ' 非法：' + JSON.stringify(value));
  }
  return value;
}

function readManifest() {
  const manifest = readJson(path.join(BASE_ROOT, 'manifest.json'));
  if (!manifest || !Array.isArray(manifest.pages) || !Array.isArray(manifest.slots)) {
    fail('Base manifest 缺少 pages/slots');
  }
  return manifest;
}

function readThemeTokens(manifest) {
  const themeFile = readJson(path.join(BASE_ROOT, 'theme.tokens.json'));
  if (!themeFile || !Array.isArray(themeFile.tokens)) fail('theme.tokens.json 缺少 tokens');
  const declared = themeFile.tokens.map((token) => {
    if (!token || typeof token.key !== 'string') fail('theme token 缺少 key');
    return token.key;
  });
  for (const key of THEME_TOKEN_KEYS) {
    if (!declared.includes(key)) fail('Base theme 缺少契约 token：' + key);
  }
  const manifestTokens = (manifest.themeTokens || []).map((token) => token.key);
  for (const key of THEME_TOKEN_KEYS) {
    if (!manifestTokens.includes(key)) fail('Base manifest 缺少契约 token：' + key);
  }
  return [...THEME_TOKEN_KEYS];
}

function readPageCatalog(pageId) {
  const entry = readJson(path.join(CATALOG_ROOT, 'pages', pageId + '.json'));
  if (!entry || entry.pageId !== pageId) fail('页面目录条目与 pageId 不一致：' + pageId);
  if (!entry.controller || !Array.isArray(entry.controller.methods) || !Array.isArray(entry.controller.dataKeys)) {
    fail('页面目录缺少 controller.methods/dataKeys：' + pageId);
  }
  if (!Array.isArray(entry.components)) fail('页面目录缺少 components：' + pageId);
  return entry;
}

function readBasePageJson(pageId) {
  const entry = readJson(path.join(BASE_SRC, 'pages', pageId, 'index.json'));
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    fail('Base 页面配置非法：' + pageId);
  }
  return entry;
}

function readBasePageWxml(pageId) {
  return readText(path.join(BASE_SRC, 'pages', pageId, 'index.wxml'));
}

/**
 * 从页面真实 WXML/控制器派生**页面级规范化 dataPath**。
 * 与 P2 renderer 的 token→WXML 映射约定一起构成单一事实源：
 * home.mode -> {{mode}}、menu.categories -> {{categories}}、
 * cart.count -> {{cartSummary.totalQuantity}} 等。
 */
function canonicalPageDataPaths(pageCatalog, wxml) {
  const dataKeys = new Set(pageCatalog.controller.dataKeys);
  const internal = new Set(INTERNAL_DATA_KEYS);
  const paths = [];
  const source = String(wxml)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(STATE_ATTRIBUTE_PATTERN, ' ');

  MUSTACHE_PATTERN.lastIndex = 0;
  let mustache;
  while ((mustache = MUSTACHE_PATTERN.exec(source)) !== null) {
    const expression = mustache[1].replace(/'[^']*'/g, ' ').replace(/"[^"]*"/g, ' ');
    IDENTIFIER_CHAIN_PATTERN.lastIndex = 0;
    let token;
    while ((token = IDENTIFIER_CHAIN_PATTERN.exec(expression)) !== null) {
      const chain = token[0];
      const after = expression.slice(token.index + chain.length).trimStart();
      if (after.startsWith('(')) continue; // 函数调用不是数据绑定
      const segments = chain.split('.');
      const top = segments[0];
      if (LOOP_LOCALS.has(top)) continue;

      if (top === 'store') {
        if (segments.length < 2 || segments.length > 3) {
          fail('页面 ' + pageCatalog.pageId + ' 的 store 绑定深度非法：' + chain);
        }
        paths.push(assertPattern(chain, DATA_PATH_PATTERN, 'data path'));
        continue;
      }
      if (top === 'cartSummary') {
        if (segments.length < 2) continue;
        const mapped = CART_SUMMARY_TOKENS[segments[1]];
        if (mapped === undefined) {
          fail('页面 ' + pageCatalog.pageId + ' 出现未声明的 cartSummary 字段：' + chain);
        }
        paths.push(assertPattern(mapped, DATA_PATH_PATTERN, 'data path'));
        continue;
      }
      if (!dataKeys.has(top) || internal.has(top)) continue;
      if (segments.length === 1 || (segments.length === 2 && segments[1] === 'length')) {
        paths.push(assertPattern(pageCatalog.pageId + '.' + top, DATA_PATH_PATTERN, 'data path'));
      }
    }
  }
  return sortedUnique(paths).slice(0, MAX_FACTS_ENTRIES);
}

function readComponentCatalog(componentId, manifest) {
  assertPattern(componentId, LOWERCASE_ID_PATTERN, 'componentId');
  if (!(manifest.builtinComponents || []).includes(componentId)) {
    fail('页面使用了非 Base 内置组件：' + componentId);
  }
  const entry = readJson(path.join(CATALOG_ROOT, 'components', componentId + '.json'));
  if (!entry || entry.id !== componentId) fail('组件目录条目与 componentId 不一致：' + componentId);
  const iface = entry.interface || {};
  const props = (iface.props || []).map((prop) => {
    if (!prop || typeof prop.name !== 'string') fail('组件 ' + componentId + ' 的 prop 缺少 name');
    return assertPattern(prop.name, PROP_ID_PATTERN, 'component:' + componentId + ' prop');
  });
  const events = (iface.events || []).map((event) => {
    if (!event || typeof event.name !== 'string') fail('组件 ' + componentId + ' 的 event 缺少 name');
    return assertPattern(event.name, EVENT_ID_PATTERN, 'component:' + componentId + ' event');
  });
  return {
    props: sortedUnique(props),
    events: sortedUnique(events),
  };
}

function collectUsedComponents(pageCatalog) {
  const used = [];
  for (const component of pageCatalog.components) {
    if (!component || typeof component.componentId !== 'string') {
      fail('页面目录 components 条目缺少 componentId：' + pageCatalog.pageId);
    }
    // declared-only 只在 usingComponents 里声明、页面 WXML 未使用，不能当作可生成能力。
    if (component.mode === 'declared-only') continue;
    used.push(component.componentId);
  }
  return used;
}

function collectActions(pageCatalog, wxml) {
  const methods = new Set(pageCatalog.controller.methods);
  const actions = [];
  HANDLER_ATTRIBUTE_PATTERN.lastIndex = 0;
  let match;
  while ((match = HANDLER_ATTRIBUTE_PATTERN.exec(wxml)) !== null) {
    const handler = match[1].trim();
    if (!methods.has(handler)) {
      fail('页面 ' + pageCatalog.pageId + ' 的事件处理器不在控制器 methods 中：' + handler);
    }
    actions.push(assertPattern(pageCatalog.pageId + '.' + handler, ACTION_PATTERN, 'action'));
  }
  return actions;
}

/** 页面级事实：usingComponents / 插槽 / 本页规范化数据路径（P1/P2 共用的唯一来源）。 */
function buildPageFacts(manifest, pageIds) {
  const pages = {};
  for (const pageId of pageIds) {
    const pageConfig = readBasePageJson(pageId);
    const using = pageConfig.usingComponents && typeof pageConfig.usingComponents === 'object'
      ? pageConfig.usingComponents
      : {};
    const pageCatalog = readPageCatalog(pageId);
    const slots = (manifest.slots || [])
      .filter((slot) => slot && slot.pageId === pageId)
      .map((slot) => {
        if (typeof slot.slotId !== 'string') fail('Base manifest 插槽缺少 slotId');
        return assertPattern(slot.slotId, LOWERCASE_ID_PATTERN, 'slotId');
      })
      .sort();
    const dataPaths = canonicalPageDataPaths(pageCatalog, readBasePageWxml(pageId));
    for (const dataPath of dataPaths) assertPattern(dataPath, DATA_PATH_PATTERN, 'page data path');
    pages[pageId] = {
      components: sortedUnique(Object.keys(using).map((componentId) => assertPattern(componentId, LOWERCASE_ID_PATTERN, 'usingComponent'))),
      slots,
      dataPaths,
    };
  }
  return { version: PAGE_FACTS_VERSION, pages };
}

function buildSnapshot() {
  const manifest = readManifest();
  const pageIds = TARGET_PAGES.filter((pageId) => manifest.pages.some((page) => page.pageId === pageId));
  if (pageIds.length !== TARGET_PAGES.length) fail('Base manifest 缺少契约目标页：' + TARGET_PAGES.join('/'));

  const themeTokens = readThemeTokens(manifest);
  const pageFacts = buildPageFacts(manifest, pageIds);

  const componentIds = [];
  const actions = [];
  const dataPaths = [];
  const slots = [];
  for (const pageId of pageIds) {
    const pageCatalog = readPageCatalog(pageId);
    const wxml = readBasePageWxml(pageId);
    componentIds.push(...collectUsedComponents(pageCatalog));
    actions.push(...collectActions(pageCatalog, wxml));
    dataPaths.push(...pageFacts.pages[pageId].dataPaths);
    slots.push(...pageFacts.pages[pageId].slots);

    const catalogSlots = (pageCatalog.slots || [])
      .map((slot) => {
        if (!slot || typeof slot.slotId !== 'string') fail('页面目录插槽缺少 slotId');
        return slot.slotId;
      })
      .sort();
    if (pageFacts.pages[pageId].slots.join('|') !== catalogSlots.join('|')) {
      fail('页面 ' + pageId + ' 的插槽与 Base manifest 不同源：' + pageFacts.pages[pageId].slots.join(',') + ' ≠ ' + catalogSlots.join(','));
    }
  }

  const components = {};
  for (const componentId of sortedUnique(componentIds)) {
    components[componentId] = readComponentCatalog(componentId, manifest);
  }

  const snapshot = {
    version: FACTS_VERSION,
    pageIds,
    components,
    slots: sortedUnique(slots),
    actions: sortedUnique(actions),
    dataPaths: sortedUnique(dataPaths),
    themeTokens,
    sizeKeys: [...SIZE_KEYS],
  };

  validateSnapshotShape(snapshot);
  validatePageSnapshotShape(pageFacts);

  // 单文件规范源：全局事实 + 页面事实 + 每页关键动作，P2 直接消费这一份快照。
  const keyActions = {};
  for (const pageId of pageIds) {
    keyActions[pageId] = snapshot.actions
      .filter((action) => action.split('.')[0] === pageId)
      .sort();
    if (keyActions[pageId].length === 0) fail('页面缺少关键动作：' + pageId);
  }
  const canonical = { ...snapshot, pageFacts: pageFacts.pages, keyActions };
  validateCanonicalShape(canonical);
  return canonical;
}

/**
 * 单一事实源自检：页面事实与关键动作必须覆盖全部契约目标页，
 * 且 keyActions 必须等于 actions 中该页前缀的动作（不能两套真源）。
 */
function validateCanonicalShape(canonical) {
  if (canonical.pageFacts === null || typeof canonical.pageFacts !== 'object') {
    fail('snapshot.pageFacts 缺失');
  }
  if (canonical.keyActions === null || typeof canonical.keyActions !== 'object') {
    fail('snapshot.keyActions 缺失');
  }
  for (const pageId of TARGET_PAGES) {
    const page = canonical.pageFacts[pageId];
    if (!page) fail('snapshot.pageFacts 缺少页面：' + pageId);
    const expectedActions = canonical.actions.filter((action) => action.split('.')[0] === pageId).sort();
    const declared = canonical.keyActions[pageId];
    if (!Array.isArray(declared) || declared.join('|') !== expectedActions.join('|')) {
      fail('snapshot.keyActions 与 actions 不同源：' + pageId);
    }
    for (const action of declared) {
      assertPattern(action, ACTION_PATTERN, 'key action');
      if (!page.components) fail('pageFacts 缺少 components：' + pageId);
    }
  }
}

/** 本地 fail-closed 自检：与 server schema.ts 的硬边界保持一致。 */
function validateSnapshotShape(snapshot) {
  if (snapshot.version !== FACTS_VERSION) fail('snapshot.version 非法');
  if (!Array.isArray(snapshot.pageIds) || snapshot.pageIds.length !== TARGET_PAGES.length) {
    fail('snapshot.pageIds 数量非法');
  }
  const componentIds = Object.keys(snapshot.components);
  if (componentIds.length === 0 || componentIds.length > MAX_FACTS_ENTRIES) fail('snapshot.components 数量非法');
  for (const componentId of componentIds) {
    assertPattern(componentId, LOWERCASE_ID_PATTERN, 'component key');
    const component = snapshot.components[componentId];
    for (const prop of component.props) assertPattern(prop, PROP_ID_PATTERN, 'prop');
    for (const event of component.events) assertPattern(event, EVENT_ID_PATTERN, 'event');
  }
  if (snapshot.slots.length > MAX_FACTS_ENTRIES) fail('snapshot.slots 超过上限');
  for (const slot of snapshot.slots) assertPattern(slot, LOWERCASE_ID_PATTERN, 'slot');
  if (snapshot.actions.length === 0 || snapshot.actions.length > MAX_FACTS_ENTRIES) fail('snapshot.actions 数量非法');
  for (const action of snapshot.actions) assertPattern(action, ACTION_PATTERN, 'action');
  if (snapshot.dataPaths.length === 0 || snapshot.dataPaths.length > MAX_FACTS_ENTRIES) fail('snapshot.dataPaths 数量非法');
  for (const dataPath of snapshot.dataPaths) assertPattern(dataPath, DATA_PATH_PATTERN, 'data path');
  if (snapshot.themeTokens.length !== THEME_TOKEN_KEYS.length) fail('snapshot.themeTokens 数量非法');
  if (snapshot.sizeKeys.length !== SIZE_KEYS.length) fail('snapshot.sizeKeys 数量非法');
}

function validatePageSnapshotShape(pageSnapshot) {
  if (pageSnapshot.version !== PAGE_FACTS_VERSION) fail('page snapshot.version 非法');
  const pageIds = Object.keys(pageSnapshot.pages || {});
  if (pageIds.join('|') !== [...TARGET_PAGES].join('|')) fail('page snapshot 页面集合非法');
  for (const pageId of pageIds) {
    const entry = pageSnapshot.pages[pageId];
    for (const componentId of entry.components) assertPattern(componentId, LOWERCASE_ID_PATTERN, 'page component');
    for (const slot of entry.slots) assertPattern(slot, LOWERCASE_ID_PATTERN, 'page slot');
    for (const dataPath of entry.dataPaths) assertPattern(dataPath, DATA_PATH_PATTERN, 'page data path');
  }
}

function renderJson(value) {
  return JSON.stringify(value, null, 2) + '\n';
}

function renderTs(jsonText) {
  return [
    '/**',
    ' * 由 scripts/frontend-capabilities.cjs 从 Base Manifest、Base 页面配置/控制器与 templates/catalog 生成。',
    ' * 请勿手改；更新：node scripts/frontend-capabilities.cjs；校验：node scripts/frontend-capabilities.cjs --check',
    ' */',
    'export const FRONTEND_CAPABILITIES_SNAPSHOT = ' + jsonText.trimEnd() + ' as const;',
    '',
    'export default FRONTEND_CAPABILITIES_SNAPSHOT;',
    '',
  ].join('\n');
}

function renderPageTs(jsonText) {
  return [
    '/**',
    ' * 页面级能力事实由 scripts/frontend-capabilities.cjs 从 Base 页面 usingComponents、',
    ' * 插槽声明与 WXML 数据绑定生成；与桌面 P2 loadPageFacts 同源。请勿手改。',
    ' */',
    'export const FRONTEND_PAGE_CAPABILITIES_SNAPSHOT = ' + jsonText.trimEnd() + ' as const;',
    '',
    'export default FRONTEND_PAGE_CAPABILITIES_SNAPSHOT;',
    '',
  ].join('\n');
}

function snapshotFiles() {
  return { json: SNAPSHOT_JSON, ts: SNAPSHOT_TS };
}

/** 文本快照比较：统一 CRLF/CR → LF，避免 Windows autocrlf 的干净检出误报。 */
function normalizeSnapshotText(text) {
  return String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * 比较单个快照文件。
 * - 文本（.json/.ts）：LF 归一化后比较；
 * - 二进制：`{ binary: true }` 时按原始字节比较。
 */
function compareSnapshotFile(file, expected, options) {
  const opts = options || {};
  if (!fs.existsSync(file)) return { ok: false, error: 'missing' };
  const actual = fs.readFileSync(file);
  if (opts.binary === true) {
    const expectedBuffer = Buffer.isBuffer(expected) ? expected : Buffer.from(String(expected), 'utf8');
    return actual.equals(expectedBuffer) ? { ok: true } : { ok: false, error: 'binary-mismatch' };
  }
  const expectedText = Buffer.isBuffer(expected) ? expected.toString('utf8') : String(expected);
  return normalizeSnapshotText(actual.toString('utf8')) === normalizeSnapshotText(expectedText)
    ? { ok: true }
    : { ok: false, error: 'text-mismatch' };
}

/**
 * @param {{files?: {json:string, ts:string}}} [options]
 * @returns {{ok: boolean, errors: string[]}}
 */
function checkSnapshot(options) {
  const opts = options || {};
  const files = opts.files || snapshotFiles();
  const built = buildSnapshot();
  const expected = {
    json: renderJson(built),
    ts: renderTs(renderJson(built)),
  };
  const errors = [];
  for (const key of ['json', 'ts']) {
    const file = files[key];
    const result = compareSnapshotFile(file, expected[key]);
    if (!result.ok) {
      const label = result.error === 'missing' ? '缺少能力快照文件' : '能力快照与真源不一致';
      errors.push(label + '（' + key + '）：' + relative(file));
    }
  }
  return { ok: errors.length === 0, errors };
}

function writeSnapshot() {
  const built = buildSnapshot();
  const jsonText = renderJson(built);
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  fs.writeFileSync(SNAPSHOT_JSON, jsonText, 'utf8');
  fs.writeFileSync(SNAPSHOT_TS, renderTs(jsonText), 'utf8');
  return {
    json: SNAPSHOT_JSON,
    ts: SNAPSHOT_TS,
    snapshot: built,
  };
}

function main(argv) {
  const args = new Set(argv);
  if (args.has('--check')) {
    const result = checkSnapshot();
    if (!result.ok) {
      result.errors.forEach((error) => console.error('  ✗ ' + error));
      console.error('能力快照校验失败：请运行 node scripts/frontend-capabilities.cjs 重新生成。');
      process.exitCode = 1;
      return;
    }
    const built = buildSnapshot();
    console.log(
      '能力快照校验通过：' +
        built.pageIds.length +
        ' 页、' +
        Object.keys(built.components).length +
        ' 组件、' +
        built.actions.length +
        ' 动作、' +
        built.dataPaths.length +
        ' 数据路径、' +
        Object.keys(built.pageFacts).length +
        ' 页级事实、' +
        Object.keys(built.keyActions).length +
        ' 页关键动作',
    );
    return;
  }

  if (args.has('--print')) {
    process.stdout.write(renderJson(buildSnapshot()));
    return;
  }

  const written = writeSnapshot();
  console.log('能力快照已生成：' + relative(written.json) + '、' + relative(written.ts));
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = {
  TARGET_PAGES,
  THEME_TOKEN_KEYS,
  SIZE_KEYS,
  FACTS_VERSION,
  PAGE_FACTS_VERSION,
  buildSnapshot,
  buildPageFacts,
  checkSnapshot,
  compareSnapshotFile,
  normalizeSnapshotText,
  renderJson,
  renderTs,
  snapshotFiles,
  writeSnapshot,
};
