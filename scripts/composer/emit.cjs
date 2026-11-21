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
const {
  fail,
  ok,
  validateStoreConfig,
  detectForbiddenKeysWithCode,
  normalizePresentationTokens,
  presentationSlotDataKey,
  FRONTEND_PACK_PAGE_JSON_KEYS,
} = require('./schema.cjs');
const { COMPOSER_VERSION, OUTPUT_SCHEMA_VERSION } = require('./version.cjs');
const { sanitizeProjectName } = require('./atomic.cjs');
const { MEDIA_IDS, MEDIA_OUTPUTS, validateMedia, buildMediaManifest } = require('./media.cjs');

const DETERMINISTIC_TIMESTAMP = '1970-01-01T00:00:00Z';
const DEFAULT_DISCLAIMER = '演示付款，不产生真实扣款';

/** 尺寸唯一事实：`preview-size-tokens.v1`（px 只给 React 预览，rpx 只给小程序导出）。 */
const SIZE_TOKENS_PATH = path.join(__dirname, '..', '..', 'templates', 'presentation', 'size-tokens.v1.json');
/** 尺寸表缺失时的内置基线，与 `size-tokens.v1.json` 的 md 档完全一致。 */
const SIZE_TOKEN_FALLBACK = Object.freeze({
  homeHero: Object.freeze({ sm: 150, md: 190, lg: 250 }),
  productCard: Object.freeze({ sm: 110, md: 140, lg: 180 }),
});
const SIZE_TOKEN_DEFAULT_STEP = 'md';

/** 导出侧配置键的固定顺序；顺序即产物字节顺序，必须保持稳定。 */
const SLOT_DATA_KEYS = Object.freeze(['homeHero', 'homeMarketing', 'menuAside', 'menuHero']);

let cachedSizeTokens;
function loadSizeTokens() {
  if (cachedSizeTokens !== undefined) return cachedSizeTokens;
  try {
    const doc = JSON.parse(fs.readFileSync(SIZE_TOKENS_PATH, 'utf8'));
    cachedSizeTokens = {
      sizes: doc && typeof doc.sizes === 'object' && doc.sizes ? doc.sizes : null,
      defaults: doc && typeof doc.defaults === 'object' && doc.defaults ? doc.defaults : null,
    };
  } catch (error) {
    cachedSizeTokens = null;
  }
  return cachedSizeTokens;
}

/**
 * 取尺寸档位的 rpx 值。
 *
 * 优先级：合法档位 → 尺寸表 defaults → `md`；尺寸表不可用时回落到内置 md 基线，
 * 保证尺寸表缺失不会中断导出。
 */
function sizeTokenRpx(group, size) {
  const fallback = SIZE_TOKEN_FALLBACK[group];
  if (!fallback) return 0;
  const tokens = loadSizeTokens();
  const sizes = tokens && tokens.sizes && tokens.sizes[group];
  const defaultStep = (tokens && tokens.defaults && tokens.defaults[group]) || SIZE_TOKEN_DEFAULT_STEP;
  const safeDefaultStep = fallback[defaultStep] === undefined ? SIZE_TOKEN_DEFAULT_STEP : defaultStep;
  const requested = typeof size === 'string' && fallback[size] !== undefined ? size : safeDefaultStep;
  if (sizes && sizes[requested] && typeof sizes[requested].rpx === 'number') {
    return sizes[requested].rpx;
  }
  return fallback[requested];
}

/** 取（可能来自 slotOrder 覆盖的）插槽配置键；缺失时回落到固定映射，再回落到 slotId。 */
function slotDataKeyOf(item) {
  if (item && typeof item.dataKey === 'string' && item.dataKey) return item.dataKey;
  const mapped = presentationSlotDataKey(item && item.slotId);
  return mapped || (item && item.slotId) || '';
}

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

  const appJson = {
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
  if (options && options.role === 'merchant') delete appJson.tabBar;
  return appJson;
}

/**
 * 生成主题样式表。
 *
 * `presentationTokens` 为可选（C-PLAN-PRESENTATION@1）：缺省时按 `md` 输出，
 * 旧 Plan 因此得到与尺寸表基线一致的结果。尺寸值一律取 `size-tokens.v1.json` 的 rpx。
 */
function buildThemeWxss(theme, presentationTokens) {
  const sizes = normalizePresentationTokens(presentationTokens);
  const homeHeroRpx = sizeTokenRpx('homeHero', sizes.homeHeroSize);
  const productCardRpx = sizeTokenRpx('productCard', sizes.productCardSize);
  return [
    '/* 由 Composer 生成，勿手改。主题唯一事实来自 CompositionPlan.themeTokens。 */',
    '/* 尺寸唯一事实来自 templates/presentation/size-tokens.v1.json（导出只使用 rpx）。 */',
    'page {',
    '  --store-page-background: ' + theme.pageBackground + ';',
    '  --store-primary-color: ' + theme.primaryColor + ';',
    '  --store-accent-color: ' + theme.accentColor + ';',
    '  --store-text-color: ' + theme.textColor + ';',
    '  --store-tab-bar-background: ' + theme.tabBarBackground + ';',
    '  --store-tab-bar-color: ' + theme.tabBarColor + ';',
    '  --store-tab-bar-selected-color: ' + theme.tabBarSelectedColor + ';',
    '  --store-home-hero-min-height: ' + homeHeroRpx + 'rpx;',
    '  --store-product-card-min-height: ' + productCardRpx + 'rpx;',
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

/**
 * 生成插槽配置模块。
 *
 * 配置键一律取 `assignment.dataKey`（resolve 已把 `slotOrder` 目标插槽映射成固定键，
 * 例如 `menu-hero` → `menuHero`），不得再用 slotId 三元表达式。
 * Feature 声明的 props（含 `size`）原样透传，emit 不做任何解释或改写。
 */
function buildSlotsModule(graph) {
  const slots = {};
  SLOT_DATA_KEYS.forEach((key) => {
    slots[key] = [];
  });
  graph.assignments.forEach((items) => {
    items.forEach((item) => {
      const dataKey = slotDataKeyOf(item);
      if (!Object.prototype.hasOwnProperty.call(slots, dataKey)) slots[dataKey] = [];
      slots[dataKey].push({
        assetId: item.asset.id,
        version: item.asset.version,
        component: componentTagOf(item.asset),
        props: item.slot.props || {},
      });
    });
  });
  // 固定键先输出并保持声明顺序，未知键按字典序追加，确保重复导出字节一致。
  const ordered = {};
  SLOT_DATA_KEYS.forEach((key) => {
    ordered[key] = slots[key];
  });
  Object.keys(slots).sort().forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(ordered, key)) ordered[key] = slots[key];
  });
  return configModule(ordered);
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
  const config = {
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
  const storeId = typeof options.storeId === 'string' ? options.storeId.trim() : '';
  if (storeId) config.store.id = storeId;
  if (graph.frontendPack) {
    config.meta.frontendPackId = graph.frontendPack.asset.id;
    config.meta.frontendPackVersion = graph.frontendPack.asset.version;
  }
  return config;
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

function buildMediaReadmeLines(media) {
  if (!media) return [];
  const lines = [
    '## 首页媒体来源',
    '',
    '以下来源按导出时 media.json 的声明记录，不代表 Composer 发起了模型调用。',
    '',
  ];
  MEDIA_IDS.forEach((id) => {
    if (!media[id]) return;
    const item = media[id];
    const model = item.source.model ? '；模型 `' + item.source.model + '`' : '';
    lines.push('- `' + id + '`：声明来源 `' + item.source.kind + '`；提供方 `' + item.source.provider + '`' + model + '；本地文件 `' + MEDIA_OUTPUTS[id].path + '`；摘要 `' + item.sha256 + '`。');
  });
  lines.push('');
  return lines;
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
  const connectionLines = options.mode === 'production'
    ? ['3. 生产工程使用 `config/store.generated.js` 中的 HTTPS API 与真实 storeId，并通过微信 code 登录。']
    : [
      '3. 本地联调时在 `config/store.generated.js` 的 `api.baseUrl` 指向后端，或在开发模式使用默认 `http://127.0.0.1:3000/api/v1`。',
      '4. 生产导出必须使用 HTTPS 地址，否则生成会被拒绝。',
    ];
  return [
    '# ' + String((graph.plan.storeProfile && graph.plan.storeProfile.name) || '我的餐馆') + ' · 小程序工程',
    '',
    '本工程由 Composer 确定性生成，请勿手改生成文件（文件头均带“由 Composer 生成”标记）。',
    '',
    '- Plan：`' + graph.plan.planId + '@' + graph.plan.planVersion + '`',
    '- Base：`' + graph.base.manifest.identity.id + '@' + graph.base.manifest.identity.version + '`',
    ...(graph.frontendPack
      ? ['- FrontendPack：`' + graph.frontendPack.asset.id + '@' + graph.frontendPack.asset.version + '`（仅覆盖 ' + graph.frontendPack.pages.join('、') + ' 的视图层；页面 JS 仍来自 Base）']
      : []),
    '- 模式：`' + options.mode + '`',
    '- 生成时间：确定性快照（真实导出时间见 `generation-report.json`）',
    '',
    '## 导入微信开发者工具',
    '',
    '1. 打开微信开发者工具 → 导入项目 → 选择本目录。',
    '2. AppID 使用测试号（工程内为 `touristappid`）。',
    ...connectionLines,
    '',
    '## 能力边界',
    '',
    '- 演示付款，不产生真实交易；不包含外送、公开店主注册与客户端授权。',
    '- 不包含任何密钥、AppSecret 或内部地址。',
    '',
    ...previewLines,
    '',
    ...buildMediaReadmeLines(options.media),
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
    // 属性必须写在标签内部。自闭合标签对空组件与只有 props 的 Feature Pack 组件都合法，
    // 且不会被微信 WXML 解析器当成裸文本。
    const open = attrs.length
      ? '    <' + tag + '\n' + attrs.join('\n') + '\n    '
      : '    <' + tag + ' ';
    return open + '/>';
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
  const production = options.mode === 'production';
  return [
    '// 由 Composer 生成，勿手改。导出工程不得读取宿主环境变量。',
    "const storeConfig = require('./store.generated.js');",
    '',
    'function readConfig(path) {',
    '  if (!storeConfig) return \'\';',
    '  return path.split(\'.\').reduce((value, key) => (value && typeof value === \'object\' ? value[key] : \'\'), storeConfig) || \'\';',
    '}',
    '',
    production
      ? "const API_BASE_URL = readConfig('api.baseUrl');"
      : "const API_BASE_URL = readConfig('api.baseUrl') || 'http://127.0.0.1:3000/api/v1';",
    production
      ? "const DEFAULT_STORE_ID = readConfig('store.id');"
      : "const DEFAULT_STORE_ID = readConfig('store.id') || 'store-demo-001';",
    "const REQUEST_TIMEOUT_MS = Number(readConfig('api.timeoutMs')) || 10000;",
    "const STORAGE_PREFIX = 'smart_store_v1';",
    'const USE_WECHAT_CODE_LOGIN = ' + production + ';',
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

function applyRoleOutput(files, graph, role) {
  if (role !== 'customer' && role !== 'merchant') return;
  const selectedPages = new Set(graph.pageIds);
  [...files.keys()].forEach((file) => {
    const match = /^pages\/([^/]+)\//.exec(file);
    if (match && !selectedPages.has(match[1])) files.delete(file);
  });

  if (role === 'merchant') {
    const file = 'pages/merchant-orders/index.js';
    const buffer = files.get(file);
    if (!buffer) return;
    const openOrder = [
      '  onOpenOrder(event) {',
      '    const orderId = event.detail.orderId;',
      "    if (!orderId || typeof wx === 'undefined' || !wx.navigateTo) {",
      '      return;',
      '    }',
      "    wx.navigateTo({ url: '/pages/order-detail/index?id=' + encodeURIComponent(orderId) });",
      '  },',
    ].join('\n');
    const modalOrder = [
      '  onOpenOrder(event) {',
      '    const orderId = event.detail.orderId;',
      '    const order = this.data.orders.filter((item) => item.id === orderId)[0];',
      '    if (!order) {',
      '      return;',
      '    }',
      "    const items = (order.itemViews || []).map((item) => item.name + ' ×' + item.quantity + ' ' + item.lineTotalText).join('\\n');",
      '    const content = [',
      '      order.statusText,',
      '      order.fulfillmentText,',
      "      items || order.itemSummary || '暂无菜品明细',",
      "      '合计 ' + order.totalText,",
      "    ].join('\\n');",
      '    platform.modal({',
      "      title: '订单 #' + order.shortId,",
      '      content,',
      "      confirmText: '关闭',",
      '    });',
      '  },',
    ].join('\n');
    const retry = [
      "    if (this.data.errorAction === '切换身份') {",
      "      if (typeof wx !== 'undefined' && wx.switchTab) {",
      "        wx.switchTab({ url: '/pages/mine/index' });",
      '      }',
      '      return;',
      '    }',
    ].join('\n');
    const bootstrapRetry = [
      "    if (this.data.errorAction === '切换身份') {",
      '      this.bootstrap();',
      '      return;',
      '    }',
    ].join('\n');
    const source = buffer.toString('utf8').replace(openOrder, modalOrder).replace(retry, bootstrapRetry);
    files.set(file, Buffer.from(source, 'utf8'));
    return;
  }

  const file = 'pages/mine/index.wxml';
  const buffer = files.get(file);
  if (!buffer) return;
  const source = buffer.toString('utf8');
  const start = source.indexOf('    <view wx:if="{{memberships.length > 0}}" class="page__section">');
  const end = source.indexOf('    <view wx:if="{{demoMode}}" class="page__section">', start);
  if (start >= 0 && end > start) {
    files.set(file, Buffer.from(source.slice(0, start) + source.slice(end), 'utf8'));
  }
}

function applyMediaOutput(files, media) {
  if (!media) return ok();
  MEDIA_IDS.forEach((id) => {
    if (media[id]) files.set(MEDIA_OUTPUTS[id].path, media[id].data);
  });
  files.set('assets/media/manifest.json', Buffer.from(json(buildMediaManifest(media)), 'utf8'));
  const homeFile = 'pages/home/index.wxml';
  if (!files.has(homeFile)) return ok();
  const home = files.get(homeFile).toString('utf8');
  const rootStart = home.indexOf('<view class="page home">');
  if (rootStart < 0) return fail('MEDIA_HOME_ANCHOR_MISSING', homeFile, '首页缺少媒体注入位置');
  const insertAt = rootStart + '<view class="page home">'.length;
  const lines = ['  <view class="home-media">'];
  if (media.homeBackground) {
    lines.push('    <image class="home-media__background" src="/assets/media/home-background.png" mode="aspectFill" />');
  }
  lines.push('    <view class="home-media__content">');
  if (media.homeMark) {
    lines.push('      <image class="home-media__mark" src="/assets/media/home-mark.svg" mode="aspectFit" />');
  }
  lines.push(
    '      <view class="home-media__copy">',
    '        <text class="home-media__title">{{store.name}}</text>',
    '        <text class="home-media__subtitle">欢迎到店，扫码点餐</text>',
    '      </view>',
    '    </view>',
    '  </view>',
  );
  files.set(homeFile, Buffer.from(home.slice(0, insertAt) + '\n' + lines.join('\n') + home.slice(insertAt), 'utf8'));
  const style = [
    '',
    '.home-media {',
    '  position: relative;',
    '  min-height: 260rpx;',
    '  margin-bottom: 28rpx;',
    '  overflow: hidden;',
    '  border-radius: 24rpx;',
    '  background: var(--color-primary-soft);',
    '}',
    '',
    '.home-media__background {',
    '  position: absolute;',
    '  top: 0;',
    '  right: 0;',
    '  bottom: 0;',
    '  left: 0;',
    '  width: 100%;',
    '  height: 100%;',
    '}',
    '',
    '.home-media__content {',
    '  position: relative;',
    '  display: flex;',
    '  align-items: center;',
    '  min-height: 260rpx;',
    '  padding: 32rpx;',
    '  box-sizing: border-box;',
    '  background: rgba(255, 253, 249, 0.38);',
    '}',
    '',
    '.home-media__mark {',
    '  flex: none;',
    '  width: 144rpx;',
    '  height: 144rpx;',
    '  margin-right: 28rpx;',
    '}',
    '',
    '.home-media__copy {',
    '  display: flex;',
    '  flex-direction: column;',
    '  padding: 20rpx 24rpx;',
    '  border-radius: 18rpx;',
    '  background: rgba(255, 253, 249, 0.88);',
    '}',
    '',
    '.home-media__title {',
    '  font-size: 38rpx;',
    '  font-weight: 700;',
    '  color: var(--color-text);',
    '}',
    '',
    '.home-media__subtitle {',
    '  margin-top: 10rpx;',
    '  font-size: 24rpx;',
    '  color: var(--color-muted);',
    '}',
    '',
  ].join('\n');
  const wxssFile = 'pages/home/index.wxss';
  const currentStyle = files.has(wxssFile) ? files.get(wxssFile).toString('utf8') : '';
  files.set(wxssFile, Buffer.from(currentStyle + style, 'utf8'));
  return ok();
}


function validateFrontendPackWxml(wxml, pageId, requiredSlots, controllerSource) {
  if (/<(script|wxs|import|include)[\s>]/i.test(wxml)) {
    return fail('FRONTEND_PACK_SCRIPT_FORBIDDEN', 'frontendPack', 'FrontendPack WXML 不允许 script/wxs/import/include', { pageId });
  }
  if (/\b(eval|Function)\s*\(/.test(wxml)) {
    return fail('FRONTEND_PACK_SCRIPT_FORBIDDEN', 'frontendPack', 'FrontendPack WXML 不允许动态执行', { pageId });
  }
  if (/url\(\s*['"]?(?:https?:)?\/\//i.test(wxml) || /\bsrc\s*=\s*["'](?:https?:)?\/\//i.test(wxml)) {
    return fail('FRONTEND_PACK_EXTERNAL_URL', 'frontendPack', 'FrontendPack 禁止引用外部 URL', { pageId });
  }
  for (const slotId of requiredSlots || []) {
    for (const anchor of [
      '<!-- @slot:' + slotId + ' -->',
      '<!-- @slot-fallback:' + slotId + ' -->',
      '<!-- @slot-fallback:' + slotId + ':end -->',
      '<!-- @slot:' + slotId + ':end -->',
    ]) {
      if (wxml.split(anchor).length - 1 !== 1) {
        return fail('FRONTEND_PACK_SLOT_ANCHOR_MISSING', 'frontendPack', 'FrontendPack 页面缺少或重复插槽锚点：' + slotId, { pageId, slotId, anchor });
      }
    }
  }

  const handlerPattern = /\b((?:bind|catch|capture-bind|capture-catch)[:a-zA-Z0-9-]*)\s*=\s*(["'])(.*?)\2/g;
  let match = handlerPattern.exec(wxml);
  while (match) {
    const handler = match[3].trim();
    if (handler && !handler.includes('{{')) {
      const pattern = new RegExp('(^|[^a-zA-Z0-9_$])' + handler.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\(');
      if (!pattern.test(controllerSource)) {
        return fail('FRONTEND_PACK_EVENT_UNKNOWN', 'frontendPack', 'FrontendPack 绑定了控制器不存在的方法：' + handler, {
          pageId,
          handler,
          event: match[1],
        });
      }
    }
    match = handlerPattern.exec(wxml);
  }
  return ok();
}

function overlayFrontendPack(files, graph) {
  const pack = graph.frontendPack;
  if (!pack) return ok();
  for (const pageId of pack.pages) {
    const pagePrefix = 'pages/' + pageId + '/index';
    const packRoot = path.join(pack.root, 'pages', pageId);
    const wxmlFile = path.join(packRoot, 'index.wxml');
    const wxssFile = path.join(packRoot, 'index.wxss');
    const jsonFile = path.join(packRoot, 'index.json');
    for (const [kind, file] of [['wxml', wxmlFile], ['wxss', wxssFile], ['json', jsonFile]]) {
      if (!fs.existsSync(file)) {
        return fail('FRONTEND_PACK_PAGE_FILE_MISSING', 'frontendPack', 'FrontendPack 页面缺少文件：' + pageId + '/index.' + kind, { pageId, kind });
      }
    }

    const controller = files.get(pagePrefix + '.js');
    if (!controller) {
      return fail('FRONTEND_PACK_CONTROLLER_MISSING', 'frontendPack', 'Base 页面控制器不存在：' + pageId, { pageId });
    }
    const wxml = text(fs.readFileSync(wxmlFile));
    const pageSlots = (pack.manifest.requiresSlots || []).filter((slotId) => {
      const slot = (graph.base.manifest.slots || []).filter((item) => item.slotId === slotId)[0];
      return slot && slot.pageId === pageId;
    });
    const wxmlCheck = validateFrontendPackWxml(wxml, pageId, pageSlots, controller.toString('utf8'));
    if (!wxmlCheck.ok) return wxmlCheck;
    files.set(pagePrefix + '.wxml', Buffer.from(wxml, 'utf8'));

    const packWxss = text(fs.readFileSync(wxssFile));
    if (/url\(\s*['"]?(?:https?:)?\/\//i.test(packWxss)) {
      return fail('FRONTEND_PACK_EXTERNAL_URL', 'frontendPack', 'FrontendPack WXSS 禁止引用外部 URL', { pageId });
    }
    const baseWxss = files.get(pagePrefix + '.wxss');
    const marker = '/* FrontendPack ' + pack.asset.id + '@' + pack.asset.version + '：在 Base 页面样式之后追加。 */';
    files.set(
      pagePrefix + '.wxss',
      Buffer.from((baseWxss ? text(baseWxss) : '') + '\n' + marker + '\n' + packWxss + '\n', 'utf8'),
    );

    let packJson;
    try {
      packJson = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
    } catch (error) {
      return fail('FRONTEND_PACK_PAGE_JSON_INVALID', 'frontendPack', 'FrontendPack 页面 JSON 无法解析：' + pageId, { pageId, error: error.message });
    }
    for (const key of Object.keys(packJson)) {
      if (!FRONTEND_PACK_PAGE_JSON_KEYS.includes(key)) {
        return fail('FRONTEND_PACK_JSON_FIELD_FORBIDDEN', 'frontendPack', 'FrontendPack 页面 JSON 不允许字段：' + key, { pageId, key });
      }
    }
    const baseJsonBuffer = files.get(pagePrefix + '.json');
    let baseJson = {};
    try {
      baseJson = baseJsonBuffer ? JSON.parse(baseJsonBuffer.toString('utf8')) : {};
    } catch (error) {
      return fail('FRONTEND_PACK_BASE_PAGE_UNREADABLE', 'frontendPack', 'Base 页面配置无法读取：' + pageId, { pageId, error: error.message });
    }
    const baseUsing = baseJson.usingComponents || {};
    const packUsing = packJson.usingComponents || {};
    for (const [tag, target] of Object.entries(packUsing)) {
      if (!Object.prototype.hasOwnProperty.call(baseUsing, tag)) {
        return fail('FRONTEND_PACK_COMPONENT_UNKNOWN', 'frontendPack', 'FrontendPack 不得新增 Base 未声明的组件：' + tag, { pageId, tag });
      }
      if (baseUsing[tag] !== target) {
        return fail('FRONTEND_PACK_COMPONENT_REMAP', 'frontendPack', 'FrontendPack 不得改绑 Base 组件路径：' + tag, { pageId, tag, base: baseUsing[tag], pack: target });
      }
    }
    const merged = {
      ...baseJson,
      ...packJson,
      usingComponents: { ...baseUsing, ...packUsing },
    };
    files.set(pagePrefix + '.json', Buffer.from(json(merged), 'utf8'));
  }
  return ok();
}

function buildProjectFiles(graph, options) {
  const opts = { mode: 'development', ...options };
  if (opts.media !== undefined) {
    const mediaValidation = validateMedia(opts.media);
    if (!mediaValidation.ok) return mediaValidation;
    opts.media = mediaValidation.media;
  }
  const theme = fillThemeDefaults(opts.theme || graph.themeTokens);
  opts.theme = theme;
  // 尺寸来源优先级：显式 options → resolve 归一化结果；两者都缺省时 buildThemeWxss 按 md 兜底。
  const presentationTokens = opts.presentationTokens === undefined ? graph.presentationTokens : opts.presentationTokens;
  const storeName = (graph.plan.storeProfile && graph.plan.storeProfile.name) || '我的餐馆';
  const files = readBaseFiles(graph, opts);
  applyRoleOutput(files, graph, opts.role);

  // FrontendPack 只覆盖视图层：WXML 替换、WXSS 追加、JSON 受限合并；控制器 JS 始终来自 Base。
  const overlay = overlayFrontendPack(files, graph);
  if (!overlay.ok) return overlay;

  files.set('app.json', Buffer.from(json(buildAppJson(graph, opts, theme, storeName)), 'utf8'));
  files.set('theme.generated.wxss', Buffer.from(buildThemeWxss(theme, presentationTokens), 'utf8'));
  files.set('config/slots.generated.js', Buffer.from(buildSlotsModule(graph), 'utf8'));
  files.set('config/store.generated.js', Buffer.from(configModule(buildStoreConfig(graph, opts)), 'utf8'));
  files.set('config/env.js', Buffer.from(buildEnvModule(graph, opts), 'utf8'));
  files.set('project.config.json', Buffer.from(buildProjectConfig(graph, opts), 'utf8'));
  files.set('README.md', Buffer.from(buildReadme(graph, opts), 'utf8'));
  const mediaOutput = applyMediaOutput(files, opts.media);
  if (!mediaOutput.ok) return mediaOutput;

  const copiedTags = new Map();
  graph.assignments.forEach((items, key) => {
    const [pageId, slotId] = key.split('#');
    const wxmlFile = 'pages/' + pageId + '/index.wxml';
    const wxml = files.get(wxmlFile);
    if (!wxml) return;
    // 配置键跟随 assignment.dataKey（slotOrder 覆盖后可能是 menuHero），与 slots.generated.js 保持一致。
    const dataKey = items.length > 0 ? slotDataKeyOf(items[0]) : (presentationSlotDataKey(slotId) || slotId);
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
      frontendPackPages: graph.frontendPack ? graph.frontendPack.pages.length : 0,
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