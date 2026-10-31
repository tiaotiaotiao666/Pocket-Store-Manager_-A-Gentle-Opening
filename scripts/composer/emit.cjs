#!/usr/bin/env node
'use strict';

/**
 * 确定性生成器。
 *
 * 输入 graph（解析结果）→ 输出完整小程序工程文件表（内存 Map）。
 * 磁盘写入由 atomic.cjs 负责，产物校验由 verify.cjs 负责。
 *
 * 确定性约定：
 * - JSON 2 空格 + LF，配置用 module.exports = <JSON>;\n
 * - 文本统一 LF，禁止时间戳/主机名/随机数/绝对路径
 * - store.generated.js 的 generatedAt 固定为 1970-01-01T00:00:00Z（真实时间只在报告里）
 */

const fs = require('node:fs');
const path = require('node:path');

const { fillThemeDefaults } = require('./resolve.cjs');
const { walk, relativePosix, fileSha256 } = require('./digest.cjs');
const { fail, ok, validateStoreConfig, detectForbiddenKeysWithCode } = require('./schema.cjs');
const { COMPOSER_VERSION, OUTPUT_SCHEMA_VERSION } = require('./version.cjs');
const { sanitizeProjectName } = require('./atomic.cjs');

const DETERMINISTIC_TIMESTAMP = '1970-01-01T00:00:00Z';
const DEFAULT_DISCLAIMER = '演示付款，不产生真实扣款';

function json(value) {
  return JSON.stringify(value, null, 2) + '\n';
}

function configModule(value) {
  return '// 由 Composer 生成，勿手改。\nmodule.exports = ' + JSON.stringify(value, null, 2) + ';\n';
}

function toKebab(name) {
  return name.replace(/[A-Z]/g, (char) => '-' + char.toLowerCase());
}

function text(buffer) {
  return buffer.toString('utf8').replace(/\r\n/g, '\n');
}

function readBaseFiles(graph, options) {
  const files = new Map();
  const baseSrc = graph.baseSrc;
  walk(baseSrc).forEach((file) => {
    const relative = relativePosix(baseSrc, file);
    if (relative === 'project.private.config.json') return;
    const raw = fs.readFileSync(file);
    files.set(relative, /\.(js|json|wxml|wxss|txt|md)$/i.test(file) ? Buffer.from(text(raw), 'utf8') : raw);
  });
  return files;
}

function buildAppJson(graph, options, theme, storeName) {
  const basePages = new Map(graph.base.manifest.pages.map((page) => [page.pageId, page]));
  const pages = graph.plan.pages
    .filter((page) => page.enabled !== false)
    .map((page) => {
      const declared = basePages.get(page.pageId);
      return (page.path || declared.path) + '/index';
    });
  const tabList = [
    { pageId: 'home', text: '首页' },
    { pageId: 'menu', text: '菜单' },
    { pageId: 'orders', text: '订单' },
    { pageId: 'mine', text: '我的' },
  ]
    .filter((tab) => graph.pageIds.includes(tab.pageId))
    .map((tab) => ({ pagePath: (basePages.get(tab.pageId).path) + '/index', text: tab.text }));

  return {
    pages,
    window: {
      navigationBarBackgroundColor: theme.pageBackground,
      navigationBarTextStyle: 'black',
      navigationBarTitleText: String(storeName || '我的餐馆').slice(0, 32),
      backgroundColor: theme.pageBackground,
      backgroundTextStyle: 'dark',
    },
    tabBar: {
      color: theme.tabBarColor,
      selectedColor: theme.tabBarSelectedColor,
      backgroundColor: theme.tabBarBackground,
      borderStyle: 'white',
      list: tabList,
    },
    style: 'v2',
    sitemapLocation: 'sitemap.json',
  };
}

function buildThemeWxss(theme) {
  return [
    '/* 由 Composer 生成，勿手改。主题唯一事实来自 CompositionPlan.themeTokens。 */',
    'page {',
    '  --store-page-background: ' + theme.pageBackground + ';',
    '  --store-primary-color: ' + theme.primaryColor + ';',
    '  --store-accent-color: ' + theme.accentColor + ';',
    '  --store-text-color: ' + theme.textColor + ';',
    '  --store-tab-bar-background: ' + theme.tabBarBackground + ';',
    '  --store-tab-bar-color: ' + theme.tabBarColor + ';',
    '  --store-tab-bar-selected-color: ' + theme.tabBarSelectedColor + ';',
    '',
    '  --color-bg: var(--store-page-background);',
    '  --color-surface: #FFFDF9;',
    '  --color-text: var(--store-text-color);',
    '  --color-muted: #8A8178;',
    '  --color-primary: var(--store-primary-color);',
    '  --color-primary-soft: #FDE9D8;',
    '  --color-accent: var(--store-accent-color);',
    '  --color-success: #2F7D4F;',
    '  --color-danger: #B23A2F;',
    '  --color-border: #E6DED2;',
    '}',
    '',
  ].join('\n');
}

function buildSlotsModule(graph) {
  const slots = {
    homeHero: [],
    homeMarketing: [],
    menuAside: [],
  };
  graph.assignments.forEach((items, key) => {
    const [, slotId] = key.split('#');
    const dataKey = slotId === 'home-hero' ? 'homeHero' : slotId === 'home-marketing' ? 'homeMarketing' : 'menuAside';
    items.forEach((item) => {
      slots[dataKey].push({
        assetId: item.asset.id,
        version: item.asset.version,
        component: componentTagOf(item.asset),
        props: item.slot.props || {},
      });
    });
  });
  return configModule(slots);
}

function componentTagOf(asset) {

  return asset.id;
}

function buildStoreConfig(graph, options) {
  const theme = options.theme;
  const store = graph.plan.storeProfile || {};
  const baseUrl = graph.plan.apiBinding.baseUrl || (options.mode === 'development' ? 'http://127.0.0.1:3000/api/v1' : '');
  const backendVersions = options.backendVersions || {};
  const versionGaps = {
    storeConfigVersion: backendVersions.storeConfigVersion === undefined ? null : backendVersions.storeConfigVersion,
    catalogVersion: backendVersions.catalogVersion === undefined ? null : backendVersions.catalogVersion,
  };
  return {
    schemaVersion: OUTPUT_SCHEMA_VERSION,
    meta: {
      configSchemaVersion: OUTPUT_SCHEMA_VERSION,
      storeConfigVersion: versionGaps.storeConfigVersion,
      catalogVersion: versionGaps.catalogVersion,
      apiContractVersion: graph.plan.apiBinding.contract,
      recipeId: graph.plan.planId,
      recipeVersion: graph.plan.planVersion,
      lockDigest: options.lockDigest || 'sha256:' + '0'.repeat(64),
      generatedAt: DETERMINISTIC_TIMESTAMP,
      generatorVersion: COMPOSER_VERSION,
      planDigest: options.planDigest || 'sha256:' + '0'.repeat(64),
      mode: options.mode,
      versionGaps,
    },
    store: {
      name: String(store.name || '').slice(0, 48),
      category: String(store.category || '').slice(0, 48),
      address: String(store.address || '').slice(0, 120),
      phone: String(store.phone || '').slice(0, 32),
      notes: String(store.notes || '').slice(0, 200),
      businessHours: Array.isArray(store.businessHours) ? store.businessHours : [],
    },
    api: {
      baseUrl,
      contract: graph.plan.apiBinding.contract,
      timeoutMs: 10000,
    },
    catalog: {
      mode: options.catalogMode || 'remote',
      version: versionGaps.catalogVersion,
      categories: [],
      products: [],
    },
    fulfillmentOptions: {
      dineIn: Boolean(store.fulfillment && store.fulfillment.dineIn !== false),
      takeaway: Boolean(store.fulfillment && store.fulfillment.takeaway !== false),
      delivery: false,
    },
    theme,
    capabilities: {
      onlineReady: graph.onlineReady,
      previewOnly: graph.previewOnly,
    },
    demoPaymentDisclaimer: DEFAULT_DISCLAIMER,
  };
}

function buildProjectConfig(graph, options) {
  const source = path.join(graph.baseSrc, 'project.config.json');
  let config = {};
  if (fs.existsSync(source)) {
    config = JSON.parse(fs.readFileSync(source, 'utf8'));
  }
  config.appid = 'touristappid';
  config.projectname = sanitizeProjectName(options.projectName || graph.plan.planId);
  config.description = '由智能开店生成的餐饮扫码点餐小程序（演示付款）';
  return json(config);
}

function buildReadme(graph, options) {
  const previewLines = graph.previewOnly.length === 0
    ? ['本轮不含仅预览资产，全部能力可在线使用。']
    : [
      '## 仅预览资产',
      '',
      ...graph.previewOnly.map((id) => '- `' + id + '`：仅可预览，未接入线上能力，请勿对外宣称已上线。'),
    ];
  const gaps = graph.updatesAvailable.map((item) => '- `' + item.id + '` 当前 ' + item.current + '，可用 ' + item.available + '（本工程按 Plan 精确版本生成，不自动升级）');
  return [
    '# ' + String((graph.plan.storeProfile && graph.plan.storeProfile.name) || '我的餐馆') + ' · 小程序工程',
    '',
    '本工程由 Composer 确定性生成，请勿手改生成文件（文件头均带“由 Composer 生成”标记）。',
    '',
    '- Plan：`' + graph.plan.planId + '@' + graph.plan.planVersion + '`',
    '- Base：`' + graph.base.manifest.identity.id + '@' + graph.base.manifest.identity.version + '`',
    '- 模式：`' + options.mode + '`',
    '- 生成时间：确定性快照（真实导出时间见 `generation-report.json`）',
    '',
    '## 导入微信开发者工具',
    '',
    '1. 打开微信开发者工具 → 导入项目 → 选择本目录。',
    '2. AppID 使用测试号（工程内为 `touristappid`）。',
    '3. 本地联调时在 `config/store.generated.js` 的 `api.baseUrl` 指向后端，或在开发模式使用默认 `http://127.0.0.1:3000/api/v1`。',
    '4. 生产导出必须使用 HTTPS 地址，否则生成会被拒绝。',
    '',
    '## 能力边界',
    '',
    '- 演示付款，不产生真实交易；不包含外送、公开店主注册与客户端授权。',
    '- 不包含任何密钥、AppSecret 或内部地址。',
    '',
    ...previewLines,
    '',
    '## 版本提示',
    '',
    ...(gaps.length ? gaps : ['未发现可用升级。']),
    '',
  ].join('\n');
}

function replaceSlotAnchors(wxml, items, dataKey) {
  const fallbackBegin = '<!-- @slot-fallback:' + items.slotId + ' -->';
  const fallbackEnd = '<!-- @slot-fallback:' + items.slotId + ':end -->';
  const start = wxml.indexOf(fallbackBegin);
  const end = wxml.indexOf(fallbackEnd);
  if (start < 0 || end < 0 || end < start) {
    return fail('SLOT_ANCHOR_MISSING', 'wxml', '插槽锚点缺失：' + items.slotId, { slotId: items.slotId });
  }
  const tags = items.items.map((item, index) => {
    const tag = componentTagOf(item.asset);
    const props = item.slot.props || {};
    const attrs = Object.keys(props).sort().map((prop) => {
      const binding = '{{slotProps.' + dataKey + '[' + index + '].props.' + prop + '}}';
      return '      ' + toKebab(prop) + '="' + binding + '"';
    });
    return '    <' + tag + '>\n' + attrs.map((line) => line + '\n').join('') + '    </' + tag + '>';
  });
  const replacement = fallbackBegin + '\n' + (tags.length ? tags.join('\n') + '\n' : '') + '    ' + fallbackEnd;
  return {
    ...ok(),
    content: wxml.slice(0, start) + replacement + wxml.slice(end + fallbackEnd.length),
  };
}

function collectUsedTags(wxml) {
  const tags = new Set();
  const pattern = /<([a-z][a-z0-9-]*)[\s/>]/g;
  let match = pattern.exec(wxml);
  while (match) {
    tags.add(match[1]);
    match = pattern.exec(wxml);
  }
  return tags;
}

function copyDirectoryToFiles(sourceDir, targetPrefix, files) {
  walk(sourceDir).forEach((file) => {
    const relative = relativePosix(sourceDir, file);
    const raw = fs.readFileSync(file);
    files.set(targetPrefix + '/' + relative, /\.(js|json|wxml|wxss|txt|md)$/i.test(file) ? Buffer.from(text(raw), 'utf8') : raw);
  });
}

function buildEnvModule(graph, options) {
  return [
    '// 由 Composer 生成，勿手改。导出工程不得读取宿主环境变量。',
    "const storeConfig = require('./store.generated.js');",
    '',
    'function readConfig(path) {',
    '  if (!storeConfig) return \'\';',
    '  return path.split(\'.\').reduce((value, key) => (value && typeof value === \'object\' ? value[key] : \'\'), storeConfig) || \'\';',
    '}',
    '',
    "const API_BASE_URL = readConfig('api.baseUrl') || 'http://127.0.0.1:3000/api/v1';",
    "const DEFAULT_STORE_ID = readConfig('store.id') || 'store-demo-001';",
    "const REQUEST_TIMEOUT_MS = Number(readConfig('api.timeoutMs')) || 10000;",
    "const STORAGE_PREFIX = 'smart_store_v1';",
    'const USE_WECHAT_CODE_LOGIN = false;',
    '',
    'const DEMO_IDENTITIES = {',
    "  customer: { key: 'customer', label: '演示顾客', demoOpenId: 'demo-customer-001', description: '浏览菜单、下单与模拟支付' },",
    "  owner: { key: 'owner', label: '演示店主', demoOpenId: 'demo-owner-001', description: '接单、推进状态与商品上下架' },",
    "  staff: { key: 'staff', label: '演示店员', demoOpenId: 'demo-staff-001', description: '与店主相同的门店操作权限' },",
    '};',
    '',
    "const DEFAULT_IDENTITY = 'customer';",
    '',
    'const DEMO_TABLES = [',
    "  { id: 'tbl_A01', name: 'A01' },",
    "  { id: 'tbl_A02', name: 'A02' },",
    '];',
    '',
    'const FULFILLMENT_TYPES = { DINE_IN: \'DINE_IN\', TAKEAWAY: \'TAKEAWAY\' };',
    'const FULFILLMENT_TEXT = { DINE_IN: \'堂食\', TAKEAWAY: \'到店自取\' };',
    '',
    'module.exports = {',
    '  API_BASE_URL,',
    '  DEFAULT_STORE_ID,',
    '  REQUEST_TIMEOUT_MS,',
    '  STORAGE_PREFIX,',
    '  USE_WECHAT_CODE_LOGIN,',
    '  DEMO_IDENTITIES,',
    '  DEFAULT_IDENTITY,',
    '  DEMO_TABLES,',
    '  FULFILLMENT_TYPES,',
    '  FULFILLMENT_TEXT,',
    '  STORE_CONFIG: storeConfig,',
    '};',
    '',
  ].join('\n');
}

function buildProjectFiles(graph, options) {
  const opts = { mode: 'development', ...options };
  const theme = fillThemeDefaults(opts.theme || graph.themeTokens);
  opts.theme = theme;
  const storeName = (graph.plan.storeProfile && graph.plan.storeProfile.name) || '我的餐馆';
  const files = readBaseFiles(graph, opts);

  files.set('app.json', Buffer.from(json(buildAppJson(graph, opts, theme, storeName)), 'utf8'));
  files.set('theme.generated.wxss', Buffer.from(buildThemeWxss(theme), 'utf8'));
  files.set('config/slots.generated.js', Buffer.from(buildSlotsModule(graph), 'utf8'));
  files.set('config/store.generated.js', Buffer.from(configModule(buildStoreConfig(graph, opts)), 'utf8'));
  files.set('config/env.js', Buffer.from(buildEnvModule(graph, opts), 'utf8'));
  files.set('project.config.json', Buffer.from(buildProjectConfig(graph, opts), 'utf8'));
  files.set('README.md', Buffer.from(buildReadme(graph, opts), 'utf8'));

  const copiedTags = new Map();
  graph.assignments.forEach((items, key) => {
    const [pageId, slotId] = key.split('#');
    const wxmlFile = 'pages/' + pageId + '/index.wxml';
    const wxml = files.get(wxmlFile);
    if (!wxml) return;
    const dataKey = slotId === 'home-hero' ? 'homeHero' : slotId === 'home-marketing' ? 'homeMarketing' : 'menuAside';
    const replaced = replaceSlotAnchors(wxml.toString('utf8'), { slotId, items }, dataKey);
    if (!replaced.ok) return replaced;
    files.set(wxmlFile, Buffer.from(replaced.content, 'utf8'));

    items.forEach((item) => {
      const tag = componentTagOf(item.asset);
      if (!copiedTags.has(tag)) {
        if (item.asset.kind === 'feature-pack') {
          const featureSrc = path.join(item.asset.dir, item.asset.manifest.entry.path);
          copyDirectoryToFiles(featureSrc, 'components/' + tag, files);
          (item.asset.manifest.entry.assets || []).forEach((assetFile) => {
            const source = path.join(featureSrc, assetFile);
            if (fs.existsSync(source)) {
              files.set('assets/' + item.asset.id + '/' + path.posix.basename(assetFile), fs.readFileSync(source));
            }
          });
        } else {
          copyDirectoryToFiles(
            path.join(item.asset.dir, item.asset.manifest.entry.path),
            'components/' + item.asset.id,
            files,
          );
        }
        copiedTags.set(tag, item.asset);
      }
    });
  });

  // 页面 usingComponents 只保留实际使用的组件 + 插槽标签
  graph.pageIds.forEach((pageId) => {
    const jsonFile = 'pages/' + pageId + '/index.json';
    const wxmlFile = 'pages/' + pageId + '/index.wxml';
    const jsonBuffer = files.get(jsonFile);
    const wxmlBuffer = files.get(wxmlFile);
    if (!jsonBuffer) return;
    const pageJson = JSON.parse(jsonBuffer.toString('utf8'));
    const used = wxmlBuffer ? collectUsedTags(wxmlBuffer.toString('utf8')) : new Set();
    const declared = pageJson.usingComponents || {};
    const filtered = {};
    Object.keys(declared).sort().forEach((tag) => {
      if (used.has(tag)) filtered[tag] = declared[tag];
    });
    copiedTags.forEach((asset, tag) => {
      if (used.has(tag)) filtered[tag] = '/components/' + tag + '/index';
    });
    pageJson.usingComponents = filtered;
    files.set(jsonFile, Buffer.from(json(pageJson), 'utf8'));
  });

  const storeConfig = buildStoreConfig(graph, opts);
  const storeValidation = validateStoreConfig(storeConfig, { mode: opts.mode });
  if (!storeValidation.ok) return storeValidation;
  if (opts.mode === 'production'
    && (storeConfig.meta.storeConfigVersion === null || storeConfig.meta.catalogVersion === null)) {
    return fail('VERSION_GAP_REQUIRED', 'meta', '生产导出必须提供服务端门店配置版本与目录版本');
  }

  const forbidden = detectForbiddenKeysWithCode(storeConfig, 'STORE_CONFIG_FIELD_FORBIDDEN');
  if (forbidden) return forbidden;

  return {
    ...ok(),
    files,
    stats: {
      pages: graph.pageIds.length,
      components: files.size > 0 ? new Set([...files.keys()].filter((file) => file.startsWith('components/')).map((file) => file.split('/')[1])).size : 0,
      assets: [...files.keys()].filter((file) => file.startsWith('assets/')).length,
      files: files.size,
    },
    theme,
    storeConfig,
  };
}

module.exports = {
  buildProjectFiles,
  buildAppJson,
  buildThemeWxss,
  buildSlotsModule,
  buildStoreConfig,
  buildReadme,
  buildProjectConfig,
  replaceSlotAnchors,
  collectUsedTags,
  componentTagOf,
  toKebab,
  DETERMINISTIC_TIMESTAMP,
  json,
  configModule,
  text,
};