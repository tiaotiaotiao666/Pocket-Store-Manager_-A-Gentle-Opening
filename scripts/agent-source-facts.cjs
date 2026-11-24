#!/usr/bin/env node
'use strict';

/**
 * 全项目 SourceFacts 生成器（source-facts.v2）。
 *
 * 真源（只读）：
 * - `templates/base/ordering-base/1.0.0/manifest.json` / `theme.tokens.json` / `slots.json`
 * - `templates/base/ordering-base/1.0.0/src/**`（8 页三件套 + 必要 JS + Base 组件）
 * - `templates/catalog/pages/*.json` / `components/*.json`（props/events/示例/限制）
 * - `templates/recipes/<recipe>/<version>/plan.json`（当前参考 Plan 与可用 Feature 落位）
 * - `templates/registry/registry.v1.json`（只作为组件登记副本；不复制语义）
 *
 * 输出：
 * - `server/src/agent/workspace/source-facts.snapshot.json`
 * - `server/src/agent/workspace/source-facts.snapshot.ts`
 *
 * 纪律：
 * - 不写时间戳、不读环境变量、不访问网络；相同输入逐字节相同输出；
 * - fail closed：缺文件、解析失败、组件/handler/slot/契约引用不闭合一律报错，不写半套快照；
 * - data 根/字段来自页面 JS 的 `data` 对象与 `this.setData` 静态分析，**不以 WXML 是否使用为可用性前提**；
 * - 只输出相对路径、file sha256 与结构；不输出密钥、prompt、模型正文或用户隐私。
 *
 * 用法：
 *   node scripts/agent-source-facts.cjs            # 生成快照
 *   node scripts/agent-source-facts.cjs --check    # 与真源重算结果逐字节比对（0/1）
 *   node scripts/agent-source-facts.cjs --print    # 只打印 JSON
 *
 * JS AST 使用仓库已有的 TypeScript 编译 API（server devDependency），不新增 npm 依赖。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_BASE_ROOT = path.join(REPO_ROOT, 'templates', 'base', 'ordering-base', '1.0.0');
const DEFAULT_CATALOG_ROOT = path.join(REPO_ROOT, 'templates', 'catalog');
const DEFAULT_RECIPES_ROOT = path.join(REPO_ROOT, 'templates', 'recipes');
const DEFAULT_REGISTRY_ROOT = path.join(REPO_ROOT, 'templates', 'registry');
const DEFAULT_OUT_DIR = path.join(REPO_ROOT, 'server', 'src', 'agent', 'workspace');

const SNAPSHOT_VERSION = 'source-facts.v2';
const PAGE_IDS = Object.freeze([
  'home',
  'menu',
  'checkout',
  'orders',
  'order-detail',
  'product-detail',
  'mine',
  'merchant-orders',
]);
const REFERENCE_PLAN_ID = 'order-classic';

const CHECK_IDS = Object.freeze([
  { id: 'source.check', scope: 'page', description: 'WXML/WXSS/JS/JSON 共享静态检查（scripts/frontend-source）' },
  { id: 'mini.check', scope: 'page', description: '小程序镜像/结构校验（scripts/validate-miniprogram.cjs）' },
  { id: 'composer.dry-run', scope: 'page', description: 'Composer dry-run 与导出一致性' },
  { id: 'output.consistency', scope: 'page', description: '导出产物一致性校验' },
  { id: 'unit.targeted', scope: 'project', description: '定向 Node 测试' },
  { id: 'unit.full', scope: 'project', description: '全量 Node 测试' },
  { id: 'desktop.contract', scope: 'project', description: '桌面契约测试' },
  { id: 'catalog.check', scope: 'project', description: 'Catalog 同源校验' },
  { id: 'registry.check', scope: 'project', description: 'Registry 同源校验' },
  { id: 'wechat.verify', scope: 'page', description: '固定包装真实微信开发者工具（不可用 → BLOCKED）' },
]);

/**
 * 每页 page-contract：来自 `图片驱动前端重构-raw生成方案.md` §9 的首版关键集合。
 * 生成时逐项回查真实 handler/data/state/component event/route；任一不成立即 fail closed。
 */
const PAGE_CONTRACTS = Object.freeze({
  home: {
    coreFlows: ['进入菜单', '查看门店与履约信息', '查看进行中订单'],
    requiredHandlers: ['goMenu', 'onModeChange', 'onPickTable', 'onOpenOrder', 'goOrders', 'onRetry'],
    requiredData: ['store', 'mode', 'tableName', 'activeOrders', 'pendingPaymentCount'],
    requiredStates: ['loading', 'error', 'tablesLoading', 'tablesError'],
    requiredComponentEvents: [
      { component: 'fulfillment-switch', event: 'change', handler: 'onModeChange' },
      { component: 'order-card', event: 'open', handler: 'onOpenOrder' },
      { component: 'error-banner', event: 'retry', handler: 'onRetry' },
    ],
    requiredRoutes: ['/pages/menu/index', '/pages/orders/index', '/pages/order-detail/index'],
  },
  menu: {
    coreFlows: ['分类切换', '打开菜品详情', '加购/减购', '购物车', '桌号', '结算'],
    requiredHandlers: ['onSelectCategory', 'onOpenDetail', 'onProductAdd', 'onProductRemove', 'onExpandCart', 'onCheckout', 'onPickTable', 'onModeChange'],
    requiredData: ['categories', 'products', 'cartSummary', 'quantityMap', 'mode', 'tableName', 'store'],
    requiredStates: ['loading', 'error', 'cartVisible', 'detailVisible', 'tablesLoading', 'tablesError'],
    requiredComponentEvents: [
      { component: 'category-nav', event: 'select', handler: 'onSelectCategory' },
      { component: 'product-card', event: 'add', handler: 'onProductAdd' },
      { component: 'product-card', event: 'remove', handler: 'onProductRemove' },
      { component: 'product-card', event: 'openDetail', handler: 'onOpenDetail' },
      { component: 'cart-bar', event: 'checkout', handler: 'onCheckout' },
    ],
    requiredRoutes: ['/pages/checkout/index'],
  },
  checkout: {
    coreFlows: ['商品明细', '桌号', '备注', '提交订单', '重复提交保护', '错误重试'],
    requiredHandlers: ['onSubmit', 'onNoteInput', 'onPickTable', 'onRetry', 'goMenu', 'onCloseError'],
    requiredData: ['items', 'totalCents', 'totalQuantity', 'note', 'tableName', 'mode'],
    requiredStates: ['loading', 'error', 'submitting', 'emptyCart', 'tablesLoading', 'tablesError'],
    requiredComponentEvents: [
      { component: 'error-banner', event: 'retry', handler: 'onRetry' },
      { component: 'error-banner', event: 'close', handler: 'onCloseError' },
    ],
    requiredRoutes: ['/pages/order-detail/index', '/pages/menu/index'],
  },
  orders: {
    coreFlows: ['订单列表', '筛选', '分页/加载更多', '打开订单', '支付/取消'],
    requiredHandlers: ['onChangeFilter', 'onOpen', 'onPay', 'onCancel', 'onLoadMore', 'onRetry'],
    requiredData: ['orders', 'filter', 'filters', 'total', 'hasMore'],
    requiredStates: ['loading', 'error', 'loadingMore', 'loggedIn'],
    requiredComponentEvents: [
      { component: 'order-card', event: 'open', handler: 'onOpen' },
      { component: 'order-card', event: 'pay', handler: 'onPay' },
      { component: 'order-card', event: 'cancel', handler: 'onCancel' },
    ],
    requiredRoutes: ['/pages/order-detail/index'],
  },
  'order-detail': {
    coreFlows: ['状态/时间线', '演示支付', '订单推进/取消'],
    requiredHandlers: ['onAdvance', 'onCancel', 'onPay', 'onResultRetry'],
    requiredData: ['order', 'orderId', 'role', 'merchantActions', 'showPayHint'],
    requiredStates: ['loading', 'error', 'acting', 'showPayHint'],
    requiredComponentEvents: [
      { component: 'pay-result', event: 'retry', handler: 'onResultRetry' },
    ],
    requiredRoutes: ['/pages/orders/index'],
  },
  'product-detail': {
    coreFlows: ['详情展示', '加/减购', '购物车', '结算入口'],
    requiredHandlers: ['onAdd', 'onRemove', 'onCheckout', 'onCartAdd', 'onCartRemove'],
    requiredData: ['product', 'quantity', 'amount', 'cartSummary', 'cartVisible'],
    requiredStates: ['loading', 'error', 'cartVisible'],
    requiredComponentEvents: [
      { component: 'cart-bar', event: 'checkout', handler: 'onCheckout' },
      { component: 'cart-panel', event: 'add', handler: 'onCartAdd' },
      { component: 'cart-panel', event: 'remove', handler: 'onCartRemove' },
    ],
    requiredRoutes: ['/pages/checkout/index'],
  },
  mine: {
    coreFlows: ['身份与门店资料', '身份切换', '订单入口', '店主入口'],
    requiredHandlers: ['onSwitchIdentity', 'onOpenMerchant', 'goOrders', 'goHome', 'onRefreshMe'],
    requiredData: ['identity', 'identityOptions', 'memberships', 'merchantEntries', 'loggedIn'],
    requiredStates: ['loading', 'error', 'switching', 'loggedIn'],
    requiredComponentEvents: [
      { component: 'error-banner', event: 'retry', handler: 'onRefreshMe' },
    ],
    requiredRoutes: ['/pages/merchant-orders/index', '/pages/orders/index'],
  },
  'merchant-orders': {
    coreFlows: ['订单列表/筛选', '接单/推进状态', '商品管理既有动作', '海报既有动作'],
    requiredHandlers: ['onChangeTab', 'onChangeSegment', 'onOpenOrder', 'onAdvance', 'onLoadMore', 'onOpenProductForm', 'onCreateProduct'],
    requiredData: ['orders', 'segments', 'tab', 'segment', 'hasMore', 'productsFlat', 'availableProducts', 'posters'],
    requiredStates: ['loading', 'error', 'ordersLoading', 'productsLoading', 'postersLoading', 'checking', 'polling', 'actingId'],
    requiredComponentEvents: [
      { component: 'order-card', event: 'open', handler: 'onOpenOrder' },
      { component: 'order-card', event: 'advance', handler: 'onAdvance' },
      { component: 'error-banner', event: 'retry', handler: 'onRetry' },
    ],
    requiredRoutes: ['/pages/order-detail/index'],
  },
});

const BUILTIN_TAGS = new Set(Object.freeze([
  'view', 'text', 'image', 'button', 'block', 'scroll-view', 'swiper', 'swiper-item', 'input',
  'textarea', 'label', 'form', 'picker', 'checkbox', 'checkbox-group', 'radio', 'radio-group',
  'switch', 'slider', 'progress', 'icon', 'rich-text', 'navigator', 'map', 'canvas', 'video',
  'audio', 'camera', 'cover-view', 'cover-image', 'movable-area', 'movable-view', 'slot',
  'template', 'import', 'include', 'wxs', 'web-view', 'open-data', 'ad', 'official-account',
  'functional-page-navigator', 'page-meta', 'navigation-bar', 'match-media', 'root-portal',
  'keyboard-accessory', 'grid-view', 'list-view', 'sticky-header', 'sticky-section', 'share-element',
]));

const GLOBAL_IDENTIFIERS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity', 'item', 'index']);

const MAX_EXPRESSION_CHARS = 120;

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function fail(message) {
  throw new Error('[agent-source-facts] ' + message);
}

function repoPath(file) {
  return path.relative(REPO_ROOT, file).split(path.sep).join('/');
}

function normalizeSlashes(value) {
  return String(value).replace(/\\/g, '/');
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function sha256(buffer) {
  return 'sha256:' + crypto.createHash('sha256').update(buffer).digest('hex');
}

function fileMeta(file) {
  const buffer = fs.readFileSync(file);
  return { path: repoPath(file), bytes: buffer.length, sha256: sha256(buffer) };
}

function readText(file) {
  if (!fs.existsSync(file)) fail('缺少真源文件：' + repoPath(file));
  return fs.readFileSync(file, 'utf8');
}

function readJson(file) {
  const text = readText(file);
  try {
    return JSON.parse(text);
  } catch (error) {
    fail('无法解析 ' + repoPath(file) + '：' + (error instanceof Error ? error.message : String(error)));
  }
}

function walkFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(absolute);
      else if (entry.isFile()) out.push(absolute);
      else fail('不支持的文件类型（symlink/其它）：' + repoPath(absolute));
    }
  }
  return out.sort((a, b) => repoPath(a).localeCompare(repoPath(b)));
}

function assertPlainRelative(value, label) {
  if (typeof value !== 'string' || value.length === 0) fail(label + ' 必须是非空字符串');
  if (value.startsWith('/') || value.includes('\\') || /^[A-Za-z]:/.test(value) || value.split('/').includes('..')) {
    fail(label + ' 必须是仓库相对 POSIX 路径：' + JSON.stringify(value));
  }
  return value;
}

function loadTypeScript() {
  const candidates = [
    path.join(REPO_ROOT, 'server', 'node_modules', 'typescript'),
    path.join(REPO_ROOT, 'node_modules', 'typescript'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'package.json'))) return require(candidate);
  }
  fail('缺少 TypeScript 编译 API（仓库已有 server devDependency）；本脚本不新增依赖。');
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

function truncateText(text, max) {
  const value = String(text);
  return value.length <= max ? value : value.slice(0, max) + '…';
}

// ---------------------------------------------------------------------------
// 页面 JS 静态分析（TypeScript AST）
// ---------------------------------------------------------------------------

function analyzePageScript(ts, file, text) {
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const pageObjects = [];
  const requires = [];
  const dynamicRequires = [];
  const routes = [];
  const routeLiterals = new Set();
  const wxApis = new Set();

  function walk(node, cb) {
    cb(node);
    node.forEachChild((child) => walk(child, cb));
  }

  function propName(node) {
    if (!node) return null;
    if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text;
    return null;
  }

  function fullChain(node) {
    if (ts.isIdentifier(node)) return node.text;
    if (ts.isPropertyAccessExpression(node)) {
      const left = fullChain(node.expression);
      return left ? left + '.' + node.name.text : null;
    }
    if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) {
      const left = fullChain(node.expression);
      return left ? left + '.' + node.argumentExpression.text : null;
    }
    return null;
  }

  function describeValue(node, depth) {
    if (!node) return { kind: 'unknown' };
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      return { kind: 'string', value: node.text };
    }
    if (ts.isNumericLiteral(node)) return { kind: 'number', value: Number(node.text) };
    if (node.kind === ts.SyntaxKind.TrueKeyword) return { kind: 'boolean', value: true };
    if (node.kind === ts.SyntaxKind.FalseKeyword) return { kind: 'boolean', value: false };
    if (node.kind === ts.SyntaxKind.NullKeyword) return { kind: 'null', value: null };
    if (ts.isIdentifier(node) && node.text === 'undefined') return { kind: 'undefined' };
    if (ts.isArrayLiteralExpression(node)) {
      const first = node.elements.length > 0 ? node.elements[0] : null;
      if (first && ts.isObjectLiteralExpression(first)) {
        const fields = [];
        for (const prop of first.properties) {
          const name = propName(prop.name);
          if (name) fields.push(name);
        }
        return { kind: 'array', itemKind: 'object', itemFields: sortedUnique(fields) };
      }
      return { kind: 'array', itemKind: first ? describeValue(first, depth + 1).kind : 'empty' };
    }
    if (ts.isObjectLiteralExpression(node)) {
      const fields = [];
      for (const prop of node.properties) {
        const name = propName(prop.name);
        if (name) fields.push(name);
      }
      return { kind: 'object', fields: sortedUnique(fields) };
    }
    if (ts.isShorthandPropertyAssignment(node)) return { kind: 'reference', reference: node.name.text };
    if (ts.isPropertyAccessExpression(node) || ts.isIdentifier(node) || ts.isPrefixUnaryExpression(node) || ts.isCallExpression(node) || ts.isElementAccessExpression(node)) {
      return { kind: 'expression', expression: truncateText(node.getText(sourceFile).replace(/\s+/g, ' '), MAX_EXPRESSION_CHARS) };
    }
    return { kind: 'expression', expression: truncateText(node.getText(sourceFile).replace(/\s+/g, ' '), MAX_EXPRESSION_CHARS) };
  }

  function addRequire(call) {
    const arg = call.arguments[0];
    if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
      requires.push(arg.text);
    } else {
      dynamicRequires.push({ line: lineOf(text, call.getStart(sourceFile)) });
    }
  }

  function addRoute(call, api) {
    const arg = call.arguments[0];
    let urlKind = 'dynamic';
    let url = '';
    if (arg && ts.isObjectLiteralExpression(arg)) {
      for (const prop of arg.properties) {
        if (!ts.isPropertyAssignment(prop) || propName(prop.name) !== 'url') continue;
        if (ts.isStringLiteral(prop.initializer) || ts.isNoSubstitutionTemplateLiteral(prop.initializer)) {
          urlKind = 'literal';
          url = prop.initializer.text;
        }
      }
    }
    routes.push({ api, urlKind, ...(url ? { url } : {}) });
  }

  function scanStringRoutes(node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const match = node.text.match(/(?:^|\/)(pages\/[a-z0-9-]+\/index)/);
      if (match) routeLiterals.add('/' + match[1]);
    }
  }

  walk(sourceFile, (node) => {
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text === 'Page') {
        pageObjects.push(node.arguments[0] || null);
      }
      if (ts.isIdentifier(node.expression) && node.expression.text === 'require') addRequire(node);
      if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'wx') {
        const api = node.expression.name.text;
        wxApis.add(api);
        if (['navigateTo', 'redirectTo', 'reLaunch', 'switchTab'].includes(api)) addRoute(node, api);
      }
    }
  });

  if (pageObjects.length !== 1 || !pageObjects[0] || !ts.isObjectLiteralExpression(pageObjects[0])) {
    fail('页面入口必须恰好一个 Page({...}) 对象：' + repoPath(file));
  }
  walk(sourceFile, scanStringRoutes);

  const pageObject = pageObjects[0];
  let dataInitial = null;
  const methods = [];
  const lifecycle = [];
  const setDataPaths = new Set();
  const setDataWriters = new Map();
  const dynamicSetData = [];
  const reads = {};
  const LIFECYCLE = new Set(['onLoad', 'onShow', 'onReady', 'onHide', 'onUnload', 'onPullDownRefresh', 'onReachBottom', 'onShareAppMessage', 'onShareTimeline']);

  function addWriter(key, method) {
    if (!key) return;
    if (!setDataWriters.has(key)) setDataWriters.set(key, new Set());
    setDataWriters.get(key).add(method);
  }

  for (const prop of pageObject.properties) {
    const name = propName(prop.name);
    if (!name) continue;
    if (name === 'data') {
      if (!ts.isPropertyAssignment(prop) || !ts.isObjectLiteralExpression(prop.initializer)) {
        fail('页面 data 必须是对象字面量：' + repoPath(file));
      }
      dataInitial = {};
      for (const field of prop.initializer.properties) {
        const fieldName = propName(field.name);
        if (!fieldName) continue;
        if (ts.isSpreadAssignment(field)) fail('页面 data 不允许 spread（无法静态确认字段）：' + repoPath(file));
        dataInitial[fieldName] = ts.isPropertyAssignment(field)
          ? describeValue(field.initializer, 0)
          : ts.isShorthandPropertyAssignment(field)
            ? { kind: 'reference', reference: fieldName }
            : { kind: 'unknown' };
      }
      continue;
    }
    const isFunction = ts.isMethodDeclaration(prop)
      || (ts.isPropertyAssignment(prop) && (ts.isFunctionExpression(prop.initializer) || ts.isArrowFunction(prop.initializer)));
    if (!isFunction) continue;
    (LIFECYCLE.has(name) ? lifecycle : methods).push(name);
    const body = ts.isMethodDeclaration(prop) ? prop.body : prop.initializer.body;
    if (!body) continue;
    const firstParam = prop.parameters && prop.parameters[0] ? prop.parameters[0].name : null;
    const eventNames = new Set(['event', 'e', 'evt']);
    if (firstParam && ts.isIdentifier(firstParam)) eventNames.add(firstParam.text);
    const detail = new Set();
    const dataset = new Set();
    const data = new Set();
    const destructuredDetail = new Set();
    const destructuredDataset = new Set();

    function scanChain(chain) {
      if (!chain) return;
      for (const eventName of eventNames) {
        if (chain === eventName + '.detail' || chain.startsWith(eventName + '.detail.')) detail.add(chain);
        if (chain === eventName + '.currentTarget.dataset' || chain.startsWith(eventName + '.currentTarget.dataset.')) dataset.add(chain);
        if (chain === eventName + '.target.dataset' || chain.startsWith(eventName + '.target.dataset.')) dataset.add(chain);
      }
      if (chain.startsWith('this.data.')) data.add(chain);
    }

    walk(body, (inner) => {
      if (ts.isCallExpression(inner) && ts.isPropertyAccessExpression(inner.expression) && inner.expression.name.text === 'setData') {
        const arg = inner.arguments[0];
        if (!arg || !ts.isObjectLiteralExpression(arg)) {
          dynamicSetData.push({ method: name, kind: 'non-object', line: lineOf(text, inner.getStart(sourceFile)) });
        } else {
          for (const entry of arg.properties) {
            if (ts.isSpreadAssignment(entry)) {
              dynamicSetData.push({ method: name, kind: 'spread', line: lineOf(text, entry.getStart(sourceFile)) });
              continue;
            }
            const key = propName(entry.name);
            if (!key) {
              dynamicSetData.push({ method: name, kind: 'computed', line: lineOf(text, entry.getStart(sourceFile)) });
              continue;
            }
            setDataPaths.add(key);
            addWriter(key, name);
          }
        }
      }
      if (ts.isPropertyAccessExpression(inner)) scanChain(fullChain(inner));
      if (ts.isVariableDeclaration(inner) && ts.isObjectBindingPattern(inner.name) && inner.initializer) {
        const chain = fullChain(inner.initializer);
        for (const eventName of eventNames) {
          if (chain === eventName + '.detail') {
            for (const element of inner.name.elements) {
              if (ts.isBindingElement(element) && ts.isIdentifier(element.name)) destructuredDetail.add(element.name.text);
            }
          }
          if (chain === eventName + '.currentTarget.dataset') {
            for (const element of inner.name.elements) {
              if (ts.isBindingElement(element) && ts.isIdentifier(element.name)) destructuredDataset.add(element.name.text);
            }
          }
        }
      }
    });

    reads[name] = {
      detail: sortedUnique([...detail]),
      dataset: sortedUnique([...dataset]),
      data: sortedUnique([...data]),
      ...(destructuredDetail.size > 0 ? { detailKeys: sortedUnique([...destructuredDetail]) } : {}),
      ...(destructuredDataset.size > 0 ? { datasetKeys: sortedUnique([...destructuredDataset]) } : {}),
    };
  }

  if (!dataInitial) fail('页面缺少 data 对象字面量：' + repoPath(file));
  if (methods.length === 0) fail('页面缺少方法：' + repoPath(file));

  return {
    dataInitial,
    methods: sortedUnique(methods),
    lifecycle: sortedUnique(lifecycle),
    setData: {
      paths: sortedUnique([...setDataPaths]),
      writers: Object.fromEntries([...setDataWriters.keys()].sort().map((key) => [key, sortedUnique([...setDataWriters.get(key)])])),
      dynamic: dynamicSetData.sort((a, b) => a.line - b.line || String(a.method).localeCompare(String(b.method))),
    },
    reads,
    requires: sortedUnique(requires),
    dynamicRequires,
    routes: {
      calls: routes.sort((a, b) => (a.api + a.urlKind + (a.url || '')).localeCompare(b.api + b.urlKind + (b.url || ''))),
      literals: sortedUnique([...routeLiterals]),
    },
    wxApis: sortedUnique([...wxApis]),
  };
}

// ---------------------------------------------------------------------------
// WXML 静态分析
// ---------------------------------------------------------------------------

function analyzeWxml(wxml, pageId) {
  const attrRe = /([\w:.-]+)(?:\s*=\s*"([^"]*)"|\s*=\s*'([^']*)')?/g;
  const tagRe = /<([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  const slotCounts = new Map();
  const commentRe = /<!--([\s\S]*?)-->/g;
  let comment;
  while ((comment = commentRe.exec(wxml)) !== null) {
    const body = comment[1];
    const anchors = body.match(/@slot(?:-fallback)?:([a-z0-9-]+)(?::end)?/g) || [];
    for (const anchor of anchors) {
      const match = anchor.match(/@slot(-fallback)?:([a-z0-9-]+)(:end)?/);
      if (!match) continue;
      const kind = match[1] ? 'fallback' : 'begin';
      const slotId = match[2];
      const end = Boolean(match[3]);
      if (!slotCounts.has(slotId)) slotCounts.set(slotId, { begin: 0, end: 0, fallbackBegin: 0, fallbackEnd: 0 });
      const counts = slotCounts.get(slotId);
      if (kind === 'begin') counts[end ? 'end' : 'begin'] += 1;
      else counts[end ? 'fallbackEnd' : 'fallbackBegin'] += 1;
    }
  }

  const clean = wxml.replace(commentRe, ' ');
  const events = [];
  const customTags = new Set();
  const declaredOrder = new Set();
  const loopLocals = new Set();
  const staticImages = new Set();
  const attributes = [];
  let match;
  while ((match = tagRe.exec(clean)) !== null) {
    const tag = match[1];
    const rawAttrs = match[2];
    if (!BUILTIN_TAGS.has(tag)) customTags.add(tag);
    const line = lineOf(clean, match.index);
    const tagAttrs = {};
    attrRe.lastIndex = 0;
    let attr;
    while ((attr = attrRe.exec(rawAttrs)) !== null) {
      const name = attr[1];
      const value = attr[2] !== undefined ? attr[2] : attr[3] !== undefined ? attr[3] : '';
      tagAttrs[name] = value;
      attributes.push({ tag, name, value, line });
      const eventMatch = name.match(/^(?:bind|catch|capture-bind|capture-catch)(?::)?([A-Za-z][\w-]*)$/);
      if (eventMatch) {
        if (value.includes('{{')) fail('页面 ' + pageId + ' 的事件 handler 不能是动态表达式：' + tag + ' ' + name + '=' + value);
        events.push({ tag, event: eventMatch[1], handler: value.trim(), line });
      }
      if (name === 'wx:for-item' && value) loopLocals.add(value.trim());
      if (name === 'wx:for-index' && value) loopLocals.add(value.trim());
      if (tag === 'image' && name === 'src' && !value.includes('{{')) {
        staticImages.add(value.trim());
      }
    }
    if (Object.prototype.hasOwnProperty.call(tagAttrs, 'wx:for')) {
      // 默认 item/index 已在 GLOBAL_IDENTIFIERS 中处理。
    }
    declaredOrder.add(tag);
  }

  const mustacheRoots = new Set();
  const expressionRe = /\{\{([^{}]*)\}\}/g;
  let expression;
  while ((expression = expressionRe.exec(clean)) !== null) {
    const body = expression[1]
      .replace(/'[^']*'/g, ' ')
      .replace(/"[^"]*"/g, ' ')
      .replace(/\.[A-Za-z_$][A-Za-z0-9_$]*/g, ' ');
    const identifierRe = /[A-Za-z_$][A-Za-z0-9_$]*/g;
    let identifier;
    while ((identifier = identifierRe.exec(body)) !== null) {
      const root = identifier[0];
      if (!GLOBAL_IDENTIFIERS.has(root) && !loopLocals.has(root)) mustacheRoots.add(root);
    }
  }

  return {
    events: events.sort((a, b) => a.line - b.line || a.tag.localeCompare(b.tag) || a.event.localeCompare(b.event)),
    customTags: sortedUnique([...customTags]),
    allTags: sortedUnique([...declaredOrder]),
    loopLocals: sortedUnique([...loopLocals]),
    staticImages: sortedUnique([...staticImages]),
    slots: Object.fromEntries([...slotCounts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, counts]) => [id, counts])),
    mustacheRoots: sortedUnique([...mustacheRoots]),
    attributes,
  };
}

// ---------------------------------------------------------------------------
// 事实组装
// ---------------------------------------------------------------------------

function resolveOptions(options) {
  const opts = options || {};
  const baseRoot = path.resolve(opts.baseRoot || DEFAULT_BASE_ROOT);
  const catalogRoot = path.resolve(opts.catalogRoot || DEFAULT_CATALOG_ROOT);
  const recipesRoot = path.resolve(opts.recipesRoot || DEFAULT_RECIPES_ROOT);
  const registryRoot = path.resolve(opts.registryRoot || DEFAULT_REGISTRY_ROOT);
  const outDir = path.resolve(opts.outDir || DEFAULT_OUT_DIR);
  if (!fs.existsSync(baseRoot)) fail('缺少 Base 根目录：' + repoPath(baseRoot));
  if (!fs.existsSync(catalogRoot)) fail('缺少 Catalog 根目录：' + repoPath(catalogRoot));
  if (!fs.existsSync(recipesRoot)) fail('缺少 Recipes 根目录：' + repoPath(recipesRoot));
  return {
    baseRoot,
    baseSrc: path.join(baseRoot, 'src'),
    catalogRoot,
    recipesRoot,
    registryRoot,
    outDir,
  };
}

function loadContext(options) {
  const ts = loadTypeScript();
  const roots = resolveOptions(options);
  const manifestPath = path.join(roots.baseRoot, 'manifest.json');
  const themePath = path.join(roots.baseRoot, 'theme.tokens.json');
  const slotsPath = path.join(roots.baseRoot, 'slots.json');
  const manifest = readJson(manifestPath);
  const theme = readJson(themePath);
  const slotsFile = readJson(slotsPath);
  const appJson = readJson(path.join(roots.baseSrc, 'app.json'));
  const catalogIndex = readJson(path.join(roots.catalogRoot, 'index.json'));
  const registry = readJson(path.join(roots.registryRoot, 'registry.v1.json'));

  if (!manifest || !manifest.identity || !Array.isArray(manifest.pages)) fail('Base manifest 缺少 identity/pages');
  const manifestPageIds = manifest.pages.map((page) => page && page.pageId);
  const expected = [...PAGE_IDS].sort();
  if (JSON.stringify([...manifestPageIds].sort()) !== JSON.stringify(expected)) {
    fail('Base manifest 页面集合必须恰为 8 页：' + expected.join('/'));
  }
  for (const page of manifest.pages) {
    if (!page || typeof page.path !== 'string') fail('Base manifest 页面缺少 path');
    const expectedPath = 'pages/' + page.pageId;
    if (page.path !== expectedPath) fail('Base manifest 页面 path 非规范：' + page.pageId + ' -> ' + page.path);
  }

  const appPages = Array.isArray(appJson.pages) ? appJson.pages : [];
  for (const pageId of PAGE_IDS) {
    const expectedRoute = 'pages/' + pageId + '/index';
    if (!appPages.includes(expectedRoute)) fail('app.json 未注册页面路由：' + expectedRoute);
  }

  const themeTokens = Array.isArray(theme.tokens) ? theme.tokens : [];
  const themeKeys = themeTokens.map((token) => token && token.key);
  if (themeKeys.length !== 7) fail('theme.tokens.json 必须声明 7 个 token');
  const manifestThemeKeys = (manifest.themeTokens || []).map((token) => token.key);
  for (const key of themeKeys) {
    if (!manifestThemeKeys.includes(key)) fail('manifest 缺少 theme token：' + key);
  }
  for (const key of manifestThemeKeys) {
    if (!themeKeys.includes(key)) fail('theme.tokens.json 缺少 manifest token：' + key);
  }

  const slotsFileEntries = Array.isArray(slotsFile.slots) ? slotsFile.slots : [];
  const slotsFileMap = new Map(slotsFileEntries.map((slot) => [slot.slotId, slot]));
  const manifestBuiltins = Array.isArray(manifest.builtinComponents) ? manifest.builtinComponents : [];

  return {
    ts,
    roots,
    manifest,
    theme,
    slotsFile,
    slotsFileMap,
    appJson,
    catalogIndex,
    registry,
    manifestBuiltins,
    themeTokens: themeTokens
      .map((token) => ({
        key: token.key,
        cssVar: token.cssVar,
        type: token.type,
        required: token.required === true,
        ...(token.contrastWith ? { contrastWith: token.contrastWith } : {}),
      }))
      .sort((a, b) => a.key.localeCompare(b.key)),
    themeKeys: sortedUnique(themeKeys),
  };
}

function buildLocalAssets(context) {
  const assetsRoot = path.join(context.roots.baseSrc, 'assets');
  const assets = new Map();
  if (fs.existsSync(assetsRoot)) {
    for (const file of walkFiles(assetsRoot)) {
      const meta = fileMeta(file);
      const sourcePrefix = repoPath(context.roots.baseSrc) + '/';
      const id = meta.path.slice(sourcePrefix.length);
      const extension = path.extname(file).slice(1).toLowerCase();
      assets.set(id, {
        id,
        path: meta.path,
        bytes: meta.bytes,
        kind: extension === 'png' ? 'png' : extension,
        usedBy: new Set(),
        wxmlUsages: new Set(),
      });
    }
  }

  const tabBar = context.appJson.tabBar && Array.isArray(context.appJson.tabBar.list) ? context.appJson.tabBar.list : [];
  for (const entry of tabBar) {
    if (!entry || typeof entry.pagePath !== 'string') fail('app.json tabBar 条目缺少 pagePath');
    for (const key of ['iconPath', 'selectedIconPath']) {
      if (typeof entry[key] !== 'string' || !entry[key]) continue;
      const id = normalizeSlashes(entry[key]);
      const asset = assets.get(id);
      if (!asset) fail('app.json tabBar 引用了不存在的本地资产：' + id);
      asset.usedBy.add('tabBar:' + entry.pagePath + (key === 'selectedIconPath' ? ':selected' : ':normal'));
    }
  }

  return [...assets.values()]
    .map((asset) => ({
      id: asset.id,
      path: asset.path,
      bytes: asset.bytes,
      kind: asset.kind,
      usedBy: sortedUnique([...asset.usedBy]),
      wxmlUsages: sortedUnique([...asset.wxmlUsages]),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function buildComponents(context) {
  const { catalogRoot, baseSrc, registry } = context.roots;
  const componentsDir = path.join(catalogRoot, 'components');
  if (!fs.existsSync(componentsDir)) fail('缺少 Catalog components 目录');
  const catalogFiles = fs.readdirSync(componentsDir).filter((file) => file.endsWith('.json')).sort();
  const componentCatalog = new Map();
  for (const file of catalogFiles) {
    const entry = readJson(path.join(componentsDir, file));
    if (!entry || typeof entry.id !== 'string') fail('组件 Catalog 条目缺少 id：' + file);
    if (entry.id + '.json' !== file) fail('组件 Catalog 文件名与 id 不一致：' + file);
    componentCatalog.set(entry.id, entry);
  }

  const registryAssets = new Map();
  for (const asset of (context.registry.assets || [])) {
    if (asset && typeof asset.id === 'string') registryAssets.set(asset.id + '@' + asset.version, asset);
  }

  function buildOne(componentId, reason) {
    const entry = componentCatalog.get(componentId);
    if (!entry) fail(reason + ' 引用了 Catalog 中不存在的组件：' + componentId);
    if (!entry.source || typeof entry.source.root !== 'string') fail('组件缺少 source.root：' + componentId);
    const sourceRoot = path.resolve(REPO_ROOT, entry.source.root);
    if (!fs.existsSync(sourceRoot)) fail('组件源目录不存在：' + componentId + ' -> ' + entry.source.root);
    const files = Array.isArray(entry.source.files) ? [...entry.source.files].sort() : null;
    if (!files || files.length === 0) fail('组件 source.files 为空：' + componentId);
    const actualFiles = walkFiles(sourceRoot).map((file) => path.basename(file)).sort();
    if (JSON.stringify(actualFiles) !== JSON.stringify(files)) {
      fail('组件文件与 Catalog 不一致：' + componentId + ' 实际=' + actualFiles.join(',') + ' Catalog=' + files.join(','));
    }
    const fileRefs = files.map((file) => {
      const buffer = fs.readFileSync(path.join(sourceRoot, file));
      return { file, sha256: sha256(buffer) };
    });
    const treeDigest = sha256(fileRefs.map((file) => file.file + '\0' + file.sha256).join('\n'));
    const iface = entry.interface || {};
    const props = (iface.props || []).map((prop) => [
      prop.name,
      prop.type,
      prop.required === true,
      prop.defaultValue === undefined ? null : prop.defaultValue,
      prop.description || '',
    ]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    const events = (iface.events || []).map((event) => [
      event.name,
      Array.isArray(event.payload) ? [...event.payload].sort() : [],
      event.description || '',
    ]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    for (const prop of props) {
      if (typeof prop[0] !== 'string' || !/^[A-Za-z][A-Za-z0-9]*$/.test(prop[0])) fail('组件 prop 名非法：' + componentId + '.' + prop[0]);
    }
    for (const event of events) {
      if (typeof event[0] !== 'string' || !/^[A-Za-z][A-Za-z0-9]*$/.test(event[0])) fail('组件 event 名非法：' + componentId + '.' + event[0]);
    }
    const registryAsset = entry.source.registryAsset && typeof entry.source.registryAsset === 'object'
      ? {
        id: entry.source.registryAsset.id,
        version: entry.source.registryAsset.version,
        kind: entry.source.registryAsset.kind,
        path: entry.source.registryAsset.path,
      }
      : null;
    if (registryAsset) {
      const registryEntry = registryAssets.get(registryAsset.id + '@' + registryAsset.version);
      if (!registryEntry) fail('组件登记资产不在 Registry：' + registryAsset.id + '@' + registryAsset.version);
      if (registryEntry.path !== registryAsset.path) fail('组件 Registry 路径不一致：' + componentId);
      if (registryEntry.kind !== registryAsset.kind) fail('组件 Registry kind 不一致：' + componentId);
    }
    let registryMirror = null;
    if (entry.source.registryMirror && typeof entry.source.registryMirror === 'object') {
      const mirror = entry.source.registryMirror;
      registryMirror = { assetPath: mirror.assetPath, sameImplementation: mirror.sameImplementation === true };
      if (mirror.sameImplementation === true) {
        for (const file of files) {
          const mirrorFile = path.join(REPO_ROOT, mirror.assetPath, 'src', file);
          if (!fs.existsSync(mirrorFile)) fail('组件 Registry 副本缺少文件：' + repoPath(mirrorFile));
          if (sha256(fs.readFileSync(mirrorFile)) !== sha256(fs.readFileSync(path.join(sourceRoot, file)))) {
            fail('组件 Registry 副本与 Base 不一致：' + componentId + '/' + file);
          }
        }
      }
    }
    return {
      id: componentId,
      kind: entry.sourceKind || 'base-builtin',
      root: entry.source.root,
      files,
      registry: registryAsset ? [registryAsset.id, registryAsset.version, registryAsset.kind, registryAsset.path] : null,
      props: props.map((prop) => [prop[0], prop[1], prop[2], prop[3]]),
      events: events.map((event) => [event[0], event[1]]),
      example: entry.usage && typeof entry.usage.wxmlExample === 'string' ? entry.usage.wxmlExample : '',
      limits: [
        ...(Array.isArray(entry.constraints) ? entry.constraints : []),
        ...(Array.isArray(entry.knownLimits) ? entry.knownLimits : []),
      ],
    };
  }

  const components = {};
  for (const componentId of context.manifestBuiltins) components[componentId] = buildOne(componentId, 'Base manifest builtinComponents');
  // 被页面 JSON 声明但不在 builtinComponents 的 slot-injection 组件（如 poster-carousel）也必须进入事实。
  for (const pageId of PAGE_IDS) {
    const pageJson = readJson(path.join(baseSrc, 'pages', pageId, 'index.json'));
    const using = pageJson.usingComponents && typeof pageJson.usingComponents === 'object' ? pageJson.usingComponents : {};
    for (const componentId of Object.keys(using)) {
      if (components[componentId]) continue;
      const entry = componentCatalog.get(componentId);
      if (!entry) fail('页面 ' + pageId + ' 声明了 Catalog 不存在的组件：' + componentId);
      if (entry.sourceKind !== 'feature-pack') fail('页面 ' + pageId + ' 声明了非 Base 内置组件：' + componentId);
      components[componentId] = buildOne(componentId, '页面 usingComponents');
    }
  }
  return { components, componentCatalog };
}

function buildPlans(context, pageSlotsByPage) {
  const recipeDirs = fs.readdirSync(context.roots.recipesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const plans = [];
  for (const recipeId of recipeDirs) {
    const versions = fs.readdirSync(path.join(context.roots.recipesRoot, recipeId), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const version of versions) {
      const dir = path.join(context.roots.recipesRoot, recipeId, version);
      const planPath = path.join(dir, 'plan.json');
      if (!fs.existsSync(planPath)) continue;
      const plan = readJson(planPath);
      if (!plan || plan.planId !== recipeId) fail('Plan id 与目录不一致：' + repoPath(planPath));
      if (!plan.baseTemplate || plan.baseTemplate.id !== context.manifest.identity.id || plan.baseTemplate.version !== context.manifest.identity.version) {
        fail('Plan Base 版本不一致：' + recipeId);
      }
      const planPageIds = (plan.pages || []).map((page) => page && page.pageId);
      if (JSON.stringify([...planPageIds].sort()) !== JSON.stringify([...PAGE_IDS].sort())) {
        fail('Plan 页面集合必须恰为 8 页：' + recipeId);
      }
      const features = [];
      for (const feature of (plan.features || [])) {
        if (!feature || typeof feature.id !== 'string' || !Array.isArray(feature.slots)) fail('Plan feature 形状非法：' + recipeId);
        for (const slot of feature.slots) {
          if (!slot || typeof slot.slotId !== 'string' || typeof slot.pageId !== 'string') fail('Plan feature slot 形状非法：' + recipeId);
          const pageSlots = pageSlotsByPage.get(slot.pageId);
          if (!pageSlots) fail('Plan feature 指向不存在页面：' + slot.pageId);
          const declared = pageSlots.find((item) => item.slotId === slot.slotId);
          if (!declared) fail('Plan feature 指向页面不存在的插槽：' + slot.pageId + '/' + slot.slotId);
          if (!declared.accepts.includes('feature-pack')) fail('Plan feature 插槽不接受 feature-pack：' + slot.slotId);
          features.push({
            featureId: feature.id,
            version: typeof feature.version === 'string' ? feature.version : '',
            pageId: slot.pageId,
            slotId: slot.slotId,
            dataKey: typeof slot.dataKey === 'string' ? slot.dataKey : null,
            planId: recipeId,
            planVersion: plan.planVersion || version,
          });
        }
      }
      const themeTokenKeys = plan.themeTokens && typeof plan.themeTokens === 'object'
        ? Object.keys(plan.themeTokens).sort()
        : [];
      for (const key of themeTokenKeys) {
        if (!context.themeKeys.includes(key)) fail('Plan 主题 token 不在 Base：' + recipeId + '/' + key);
      }
      plans.push({
        id: plan.planId,
        version: plan.planVersion || version,
        features: features.sort((a, b) => (a.pageId + a.slotId + a.featureId).localeCompare(b.pageId + b.slotId + b.featureId)),
        themeTokens: themeTokenKeys,
      });
    }
  }
  plans.sort((a, b) => (a.id + '@' + a.version).localeCompare(b.id + '@' + b.version));
  const reference = plans.find((plan) => plan.id === REFERENCE_PLAN_ID) || plans[0];
  if (!reference) fail('未找到任何 Plan');
  return { plans, referencePlanId: reference.id, referencePlanVersion: reference.version };
}

function buildPage(context, pageId, assets, plansInfo, componentsInfo) {
  const { ts, roots, manifest } = context;
  const pageCatalogPath = path.join(roots.catalogRoot, 'pages', pageId + '.json');
  const pageCatalog = readJson(pageCatalogPath);
  if (pageCatalog.pageId !== pageId) fail('页面 Catalog pageId 不一致：' + pageId);
  if (!pageCatalog.source || typeof pageCatalog.source.root !== 'string') fail('页面 Catalog 缺少 source.root：' + pageId);
  const pageDir = path.join(roots.baseSrc, 'pages', pageId);
  if (repoPath(pageDir) !== pageCatalog.source.root) fail('页面 Catalog source.root 与 Base 不一致：' + pageId);
  if (!fs.existsSync(pageDir)) fail('缺少页面目录：' + pageId);
  const catalogFiles = Array.isArray(pageCatalog.source.files) ? [...pageCatalog.source.files].sort() : [];
  const actualFiles = fs.readdirSync(pageDir, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(catalogFiles)) {
    fail('页面文件与 Catalog 不一致：' + pageId + ' 实际=' + actualFiles.join(',') + ' Catalog=' + catalogFiles.join(','));
  }
  const fileHashes = {};
  for (const file of actualFiles) fileHashes[file] = fileMeta(path.join(pageDir, file));
  const pageTreeDigest = sha256(actualFiles.map((file) => file + '\0' + fileHashes[file].sha256).join('\n'));

  const wxml = readText(path.join(pageDir, 'index.wxml'));
  const jsText = readText(path.join(pageDir, 'index.js'));
  const pageJson = readJson(path.join(pageDir, 'index.json'));
  const script = analyzePageScript(ts, path.join(pageDir, 'index.js'), jsText);
  const wxmlFacts = analyzeWxml(wxml, pageId);

  // --- data 根：data 对象 ∪ setData 顶层路径（不以 WXML 使用为前提） ---
  const dataRoots = sortedUnique([
    ...Object.keys(script.dataInitial),
    ...script.setData.paths.map((item) => item.split(/[.[]/)[0]).filter(Boolean),
  ]);
  const knownRoots = new Set(dataRoots);
  const unknownWxmlRoots = wxmlFacts.mustacheRoots.filter((root) => !knownRoots.has(root));
  if (unknownWxmlRoots.length > 0) {
    fail('页面 ' + pageId + ' WXML 引用了 data/setData 之外的数据根：' + unknownWxmlRoots.join(','));
  }

  // --- 事件接线 ---
  const methodSet = new Set(script.methods);
  const lifecycleSet = new Set(script.lifecycle);
  for (const event of wxmlFacts.events) {
    if (!methodSet.has(event.handler) && !lifecycleSet.has(event.handler)) {
      fail('页面 ' + pageId + ' 事件 handler 不存在：' + event.tag + ' ' + event.event + '=' + event.handler);
    }
  }

  // --- 组件解析 ---
  const usingComponents = pageJson.usingComponents && typeof pageJson.usingComponents === 'object' ? pageJson.usingComponents : {};
  const pageCatalogComponents = new Map((pageCatalog.components || []).map((entry) => [entry.componentId, entry]));
  const pageComponentIds = Object.keys(usingComponents).sort();
  for (const componentId of pageComponentIds) {
    const target = usingComponents[componentId];
    if (typeof target !== 'string' || !/^\/components\/[a-z0-9-]+\/index$/.test(target)) {
      fail('页面 ' + pageId + ' usingComponents 路径非法：' + componentId + '=' + target);
    }
    if (!componentsInfo.components[componentId]) fail('页面 ' + pageId + ' 组件事实缺失：' + componentId);
  }
  for (const tag of wxmlFacts.customTags) {
    if (!usingComponents[tag]) fail('页面 ' + pageId + ' WXML 使用了未声明组件：' + tag);
  }
  const usedTags = new Set(wxmlFacts.allTags);
  const componentEntries = pageComponentIds.map((componentId) => {
    const catalogEntry = pageCatalogComponents.get(componentId);
    const wiring = wxmlFacts.events.filter((event) => event.tag === componentId).map((event) => ({ event: event.event, handler: event.handler }));
    for (const event of wiring) {
      const componentFacts = componentsInfo.components[componentId];
      if (!componentFacts.events.some((item) => item[0] === event.event)) {
        fail('页面 ' + pageId + ' 给组件 ' + componentId + ' 接了未声明事件：' + event.event);
      }
    }
    const usedInWxml = usedTags.has(componentId);
    const mode = catalogEntry && typeof catalogEntry.mode === 'string'
      ? catalogEntry.mode
      : usedInWxml ? 'always' : 'declared-only';
    if (!usedInWxml && mode !== 'declared-only') fail('页面 ' + pageId + ' 组件 ' + componentId + ' 未使用但 mode=' + mode);
    if (usedInWxml && mode === 'declared-only') fail('页面 ' + pageId + ' 组件 ' + componentId + ' 已使用但 Catalog 标为 declared-only');
    const sourceKind = componentsInfo.components[componentId].sourceKind;
    return {
      id: componentId,
      usedInWxml,
      mode,
      availableVia: sourceKind === 'feature-pack' ? 'slot-injection' : 'base',
      wiring: wiring.sort((a, b) => (a.event + a.handler).localeCompare(b.event + b.handler)),
    };
  }).sort((a, b) => a.id.localeCompare(b.id));

  // --- 插槽 ---
  const manifestSlots = (manifest.slots || []).filter((slot) => slot.pageId === pageId).sort((a, b) => a.slotId.localeCompare(b.slotId));
  const catalogSlots = new Map((pageCatalog.slots || []).map((slot) => [slot.slotId, slot]));
  const slots = [];
  const metadataGaps = [];
  for (const slot of manifestSlots) {
    const anchors = wxmlFacts.slots[slot.slotId] || { begin: 0, end: 0, fallbackBegin: 0, fallbackEnd: 0 };
    const builderSlot = context.slotsFileMap.get(slot.slotId);
    const catalogSlot = catalogSlots.get(slot.slotId);
    if (anchors.begin < 1 || anchors.end < 1) fail('页面 ' + pageId + ' 插槽缺少 WXML 锚点：' + slot.slotId);
    const declaredIn = ['manifest'];
    if (builderSlot) declaredIn.push('slots.json');
    else metadataGaps.push({ code: 'SLOT_METADATA_MISSING', pageId, detail: slot.slotId + ' 只在 manifest/WXML 声明，slots.json 缺少条目' });
    if (catalogSlot) declaredIn.push('catalog');
    else metadataGaps.push({ code: 'SLOT_CATALOG_MISSING', pageId, detail: slot.slotId + ' 在 Catalog 页面条目中缺失' });
    for (const source of [builderSlot, catalogSlot]) {
      if (!source) continue;
      if (typeof source.maxItems === 'number' && source.maxItems !== slot.maxItems) fail('插槽 maxItems 不一致：' + slot.slotId);
      if (Array.isArray(source.accepts) && JSON.stringify(source.accepts) !== JSON.stringify(slot.accepts)) fail('插槽 accepts 不一致：' + slot.slotId);
      if (typeof source.required === 'boolean' && source.required !== slot.required) fail('插槽 required 不一致：' + slot.slotId);
    }
    slots.push({
      slotId: slot.slotId,
      maxItems: slot.maxItems,
      accepts: [...slot.accepts],
      required: slot.required === true,
      dataKey: builderSlot && builderSlot.dataKey ? builderSlot.dataKey : catalogSlot && catalogSlot.dataKey ? catalogSlot.dataKey : null,
      declaredIn,
      anchors,
    });
  }
  for (const slotId of [...catalogSlots.keys()].sort()) {
    if (!manifestSlots.some((slot) => slot.slotId === slotId)) fail('页面 ' + pageId + ' Catalog 插槽不在 manifest：' + slotId);
  }

  // --- UI 状态（含 WXML 未使用但 data 存在的状态） ---
  const contract = PAGE_CONTRACTS[pageId];
  if (!contract) fail('缺少 page-contract 定义：' + pageId);
  const uiStates = buildUiStates(script.dataInitial, script.setData.writers, wxmlFacts, contract.requiredStates);

  // --- 本地资产与主题 ---
  const pageAssets = [];
  for (const asset of assets) {
    if (asset.usedBy.some((usage) => usage.startsWith('tabBar:pages/' + pageId + '/index'))) pageAssets.push(asset.id);
  }
  for (const staticImage of wxmlFacts.staticImages) {
    const normalized = normalizeSlashes(staticImage).replace(/^\/+/, '');
    const asset = assets.find((item) => item.id === normalized);
    if (!asset) fail('页面 ' + pageId + ' WXML 引用了不存在的本地资产：' + staticImage);
    if (!asset.wxmlUsages.includes(pageId)) asset.wxmlUsages.push(pageId);
    pageAssets.push(asset.id);
  }

  // --- Plan 分配 ---
  const availableFeaturePlacements = [];
  for (const plan of plansInfo.plans) {
    for (const feature of plan.features) {
      if (feature.pageId !== pageId) continue;
      if (!slots.some((slot) => slot.slotId === feature.slotId)) fail('Plan feature 插槽不在页面事实：' + pageId + '/' + feature.slotId);
      availableFeaturePlacements.push({
        featureId: feature.featureId,
        version: feature.version,
        slotId: feature.slotId,
        planId: feature.planId,
        planVersion: feature.planVersion,
      });
    }
  }
  const referenceFeatures = availableFeaturePlacements.filter((item) => item.planId === plansInfo.referencePlanId);
  const planAllocation = {
    referencePlanId: plansInfo.referencePlanId,
    referencePlanVersion: plansInfo.referencePlanVersion,
    features: referenceFeatures.sort((a, b) => (a.featureId + a.slotId).localeCompare(b.featureId + b.slotId)),
    availableFeaturePlacements: availableFeaturePlacements.sort((a, b) => (a.planId + a.slotId + a.featureId).localeCompare(b.planId + b.slotId + b.featureId)),
  };

  // --- 必要 JS ---
  const requiredJs = [];
  for (const request of script.requires) {
    let target = path.resolve(pageDir, request);
    if (!fs.existsSync(target) && !path.extname(target)) target += '.js';
    if (!fs.existsSync(target)) fail('页面 ' + pageId + ' require 无法解析：' + request);
    if (!repoPath(target).startsWith(repoPath(roots.baseSrc) + '/')) fail('页面 ' + pageId + ' require 越出 Base src：' + request);
    requiredJs.push(repoPath(target));
  }
  if (script.dynamicRequires.length > 0) fail('页面 ' + pageId + ' 存在动态 require，无法静态确认依赖');

  // --- page-contract 回查 ---
  const handlerSet = new Set([...script.methods, ...script.lifecycle]);
  for (const handler of contract.requiredHandlers) {
    if (!handlerSet.has(handler)) fail('page-contract handler 不存在：' + pageId + '.' + handler);
  }
  for (const key of contract.requiredData) {
    if (!dataRoots.includes(key)) fail('page-contract data 不存在：' + pageId + '.' + key);
  }
  for (const stateKey of contract.requiredStates) {
    if (!uiStates.some((state) => state.key === stateKey)) fail('page-contract state 不存在：' + pageId + '.' + stateKey);
  }
  const wiringKeys = new Set(wxmlFacts.events.map((event) => event.tag + ':' + event.event + ':' + event.handler));
  for (const required of contract.requiredComponentEvents) {
    const key = required.component + ':' + required.event + ':' + required.handler;
    if (!wiringKeys.has(key)) fail('page-contract 组件事件未接线：' + pageId + ' ' + key);
    if (!componentsInfo.components[required.component].events.some((event) => event[0] === required.event)) {
      fail('page-contract 组件事件不在 Catalog：' + required.component + '.' + required.event);
    }
  }
  const normalizedRoutes = new Set(script.routes.literals);
  for (const route of contract.requiredRoutes) {
    if (!normalizedRoutes.has(route)) fail('page-contract 路由出口不存在：' + pageId + ' ' + route);
  }

  const pageContract = {
    schemaVersion: 'page-contract.v1',
    pageId,
    coreFlows: [...contract.coreFlows],
    requiredHandlers: [...contract.requiredHandlers].sort(),
    requiredData: [...contract.requiredData].sort(),
    requiredStates: [...contract.requiredStates].sort(),
    requiredComponentEvents: contract.requiredComponentEvents.map((item) => ({ ...item })).sort((a, b) => (a.component + a.event + a.handler).localeCompare(b.component + b.event + b.handler)),
    requiredRoutes: [...contract.requiredRoutes].sort(),
    availableCheckIds: CHECK_IDS.filter((check) => check.scope === 'page').map((check) => check.id),
  };

  const manifestPage = manifest.pages.find((page) => page.pageId === pageId);
  const wiredHandlers = new Set(wxmlFacts.events.map((event) => event.handler));
  const readUnion = { detail: new Set(), dataset: new Set(), data: new Set() };
  for (const handler of wiredHandlers) {
    const reads = script.reads[handler];
    if (!reads) continue;
    for (const chain of reads.detail) readUnion.detail.add(graphSuffix(chain, 'event.detail'));
    for (const chain of reads.dataset) readUnion.dataset.add(graphSuffix(chain, 'event.currentTarget.dataset'));
    for (const chain of reads.data) readUnion.data.add(chain.replace(/^this\.data\./, ''));
  }
  return {
    pageId,
    path: manifestPage.path,
    audience: manifestPage.audience,
    appRoute: 'pages/' + pageId + '/index',
    title: pageCatalog.title || '',
    summary: pageCatalog.summary || '',
    source: {
      root: pageCatalog.source.root,
      wxml: repoPath(path.join(pageDir, 'index.wxml')),
      wxss: repoPath(path.join(pageDir, 'index.wxss')),
      js: repoPath(path.join(pageDir, 'index.js')),
      json: repoPath(path.join(pageDir, 'index.json')),
      extensions: fs.existsSync(path.join(pageDir, 'extensions.generated.js')) ? repoPath(path.join(pageDir, 'extensions.generated.js')) : null,
      requiredJs: sortedUnique(requiredJs),
    },
    pageJson: {
      navigationBarTitleText: pageJson.navigationBarTitleText || '',
      enablePullDownRefresh: pageJson.enablePullDownRefresh === true,
      usingComponents: Object.fromEntries(Object.keys(usingComponents).sort().map((key) => [key, usingComponents[key]])),
    },
    data: {
      initial: Object.fromEntries(Object.keys(script.dataInitial).sort().map((key) => [key, encodeDataValue(script.dataInitial[key])])),
      setData: script.setData.paths,
      dynamicSetData: script.setData.dynamic,
    },
    handlers: {
      methods: script.methods,
      lifecycle: script.lifecycle,
      events: wxmlFacts.events.map((event) => event.tag + ':' + event.event + '=' + event.handler),
      reads: {
        detail: sortedUnique([...readUnion.detail]),
        dataset: sortedUnique([...readUnion.dataset]),
        data: sortedUnique([...readUnion.data]),
      },
    },
    uiStates: uiStates.map((state) => ({
      key: state.key,
      kind: state.kind,
      initial: state.initial,
      usedInWxml: state.usedInWxml,
      required: state.required,
    })),
    components: componentEntries.map((entry) => ({ id: entry.id, mode: entry.mode, usedInWxml: entry.usedInWxml })),
    slots,
    planAllocation,
    localAssets: sortedUnique(pageAssets),
    themeTokens: [...context.themeKeys],
    routes: script.routes.literals,
    pageContract,
    metadataGaps: metadataGaps.sort((a, b) => (a.code + (a.detail || '')).localeCompare(b.code + (b.detail || ''))),
  };
}

function encodeDataValue(value) {
  if (!value || typeof value !== 'object') return 'unknown';
  switch (value.kind) {
    case 'boolean':
      return 'boolean:' + (value.value === true ? 'true' : 'false');
    case 'number':
      return 'number:' + String(value.value);
    case 'string':
      return 'string:' + String(value.value);
    case 'null':
      return 'null';
    case 'undefined':
      return 'undefined';
    case 'reference':
      return 'reference:' + String(value.reference || '');
    case 'expression':
      return 'expression:' + String(value.expression || '');
    case 'object':
      return 'object{' + (value.fields || []).join(',') + '}';
    case 'array':
      if (value.itemKind === 'object') return 'array<object{' + (value.itemFields || []).join(',') + '}>';
      return 'array<' + String(value.itemKind || 'unknown') + '>';
    default:
      return String(value.kind);
  }
}

function graphSuffix(chain, prefix) {
  if (chain === prefix) return '.';
  if (chain.startsWith(prefix + '.')) return chain.slice(prefix.length + 1);
  return chain;
}

function encodeReads(reads) {
  const out = {};
  const detail = (reads.detail || []).map((chain) => graphSuffix(chain, 'event.detail'));
  if (detail.length > 0) out.detail = sortedUnique(detail);
  const dataset = (reads.dataset || []).map((chain) => graphSuffix(chain, 'event.currentTarget.dataset'));
  if (dataset.length > 0) out.dataset = sortedUnique(dataset);
  const data = (reads.data || []).map((chain) => chain.replace(/^this\.data\./, ''));
  if (data.length > 0) out.data = sortedUnique(data);
  if (reads.detailKeys) out.detailKeys = [...reads.detailKeys];
  if (reads.datasetKeys) out.datasetKeys = [...reads.datasetKeys];
  return out;
}
function buildUiStates(dataInitial, writers, wxmlFacts, requiredStates) {
  const states = [];
  for (const key of Object.keys(dataInitial).sort()) {
    const initial = dataInitial[key];
    const kind = classifyStateKind(key, initial);
    if (!kind) continue;
    const usedInWxml = wxmlFacts.attributes.some((attribute) => attribute.value.includes('{{')
      && new RegExp('(^|[^A-Za-z0-9_$])' + escapeRegExp(key) + '([^A-Za-z0-9_$]|$)').test(attribute.value));
    states.push({
      key,
      kind,
      initial: encodeDataValue(initial),
      usedInWxml,
      writers: writers[key] ? [...writers[key]] : [],
      required: requiredStates.includes(key),
    });
  }
  for (const required of requiredStates) {
    if (!states.some((state) => state.key === required)) {
      fail('UI state 未从 data 识别：' + required);
    }
  }
  return states;
}

function classifyStateKind(key, initial) {
  if (/loading|checking|polling|submitting|switching|acting|writing/i.test(key)) return 'loading';
  if (/error/i.test(key) || key === 'requestId') return 'error';
  if (/^empty/i.test(key)) return 'empty';
  if (key === 'loggedIn' || key === 'allowed' || key === 'isOwner') return 'auth';
  if (/visible$/i.test(key) || /^show.*form$/i.test(key) || /editorid$/i.test(key)) return 'visibility';
  if (['tab', 'segment', 'filter', 'activeCategoryId', 'page', 'hasMore', 'role', 'actionOrderId', 'mode'].includes(key)) return 'selection';
  if (key === 'payResult' || key === 'payHint') return 'result';
  if (initial && initial.kind === 'boolean') return 'state';
  return null;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildSnapshot(options) {
  const context = loadContext(options);
  const assets = buildLocalAssets(context);
  const componentsInfo = buildComponents(context);
  const pageSlotsByPage = new Map();
  for (const pageId of PAGE_IDS) {
    const pageCatalog = readJson(path.join(context.roots.catalogRoot, 'pages', pageId + '.json'));
    pageSlotsByPage.set(pageId, (pageCatalog.slots || []).map((slot) => ({
      slotId: slot.slotId,
      accepts: Array.isArray(slot.accepts) ? slot.accepts : [],
    })));
    for (const slot of (context.manifest.slots || []).filter((item) => item.pageId === pageId)) {
      if (!pageSlotsByPage.get(pageId).some((item) => item.slotId === slot.slotId)) {
        pageSlotsByPage.get(pageId).push({ slotId: slot.slotId, accepts: slot.accepts });
      }
    }
  }
  const plansInfo = buildPlans(context, pageSlotsByPage);
  const pages = {};
  const gaps = [];
  for (const pageId of PAGE_IDS) {
    const page = buildPage(context, pageId, assets, plansInfo, componentsInfo);
    pages[pageId] = page;
    for (const gap of page.metadataGaps) gaps.push(gap);
  }
  for (const asset of assets) asset.wxmlUsages = sortedUnique(asset.wxmlUsages);
  // Base 入口/服务路径（页面级三件套与必要 JS 在 pages[*].source 中）。
  const baseServices = (context.manifest.services || []).map((item) => {
    const target = path.join(context.roots.baseSrc, item);
    if (!fs.existsSync(target)) fail('Base manifest services 引用了不存在文件：' + item);
    return repoPath(target);
  });
  const entryFiles = (context.manifest.entry && context.manifest.entry.files || []).map((item) => {
    const target = path.join(context.roots.baseSrc, item);
    if (!fs.existsSync(target)) fail('Base manifest entry.files 引用了不存在文件：' + item);
    return repoPath(target);
  });

  const payload = {
    version: SNAPSHOT_VERSION,
    base: {
      id: context.manifest.identity.id,
      version: context.manifest.identity.version,
      root: repoPath(context.roots.baseSrc),
      manifest: repoPath(path.join(context.roots.baseRoot, 'manifest.json')),
      catalogVersion: context.catalogIndex.catalogVersion || '',
      catalogBaseDigest: context.catalogIndex.generatedFrom && context.catalogIndex.generatedFrom.base
        ? context.catalogIndex.generatedFrom.base.digest || null
        : null,
      entryFiles,
      services: baseServices,
      builtinComponents: [...context.manifestBuiltins].sort(),
    },
    themeTokens: context.themeTokens,
    localAssets: assets,
    components: Object.fromEntries(Object.keys(componentsInfo.components).sort().map((key) => [key, componentsInfo.components[key]])),
    plans: plansInfo.plans,
    checkIds: CHECK_IDS.map((item) => ({ ...item })),
    metadataGaps: gaps.sort((a, b) => (a.code + a.pageId + a.detail).localeCompare(b.code + b.pageId + b.detail)),
    pages,
  };
  const digest = sha256(JSON.stringify(payload));
  return { ...payload, digest };
}

// ---------------------------------------------------------------------------
// 输出与 CLI
// ---------------------------------------------------------------------------

function renderJson(value) {
  return JSON.stringify(value, null, 2) + '\n';
}

function pageConstName(pageId) {
  return 'SOURCE_FACTS_PAGE_' + pageId.toUpperCase().replace(/-/g, '_');
}

function pageModuleBase(pageId) {
  return 'source-facts.pages.' + pageId;
}

function generatedHeader(summary) {
  return [
    '/**',
    ' * SourceFacts v2 快照模块（8 页源码事实/组件/Plan/page-contract）。',
    ' * 由 scripts/agent-source-facts.cjs 从 Base/Catalog 确定性生成；请勿手改。',
    ' * 更新：node scripts/agent-source-facts.cjs；校验：node scripts/agent-source-facts.cjs --check',
    ' * 查看完整 JSON：node scripts/agent-source-facts.cjs --print',
    ' * ' + summary,
    ' */',
  ].join('\n');
}

function moduleFiles(snapshot, options) {
  const roots = resolveOptions(options);
  const files = new Map();
  const imports = [];
  const summary = Object.keys(snapshot.pages).length + ' 页 / ' + Object.keys(snapshot.components).length + ' 组件 / ' + snapshot.plans.length + ' Plan';
  const pageSummary = '页面：' + Object.keys(snapshot.pages).join(', ');

  for (const pageId of PAGE_IDS) {
    const constName = pageConstName(pageId);
    const base = pageModuleBase(pageId);
    files.set(path.join(roots.outDir, base + '.ts'), [
      generatedHeader(pageSummary),
      'export const ' + constName + ': unknown = ' + JSON.stringify(snapshot.pages[pageId]) + ';',
      '',
    ].join('\n'));
    imports.push('import { ' + constName + " } from './" + base + "';");
  }

  const componentsConst = 'SOURCE_FACTS_COMPONENTS';
  files.set(path.join(roots.outDir, 'source-facts.components.ts'), [
    generatedHeader(summary),
    'export const ' + componentsConst + ': unknown = ' + JSON.stringify(snapshot.components) + ';',
    '',
  ].join('\n'));
  imports.push('import { ' + componentsConst + " } from './source-facts.components';");

  const coreLines = [
    generatedHeader(summary),
    ...imports,
    '',
    'export const SOURCE_FACTS_SNAPSHOT: unknown = {',
    '  version: ' + JSON.stringify(snapshot.version) + ',',
    '  base: ' + JSON.stringify(snapshot.base) + ',',
    '  themeTokens: ' + JSON.stringify(snapshot.themeTokens) + ',',
    '  localAssets: ' + JSON.stringify(snapshot.localAssets) + ',',
    '  components: ' + componentsConst + ',',
    '  plans: ' + JSON.stringify(snapshot.plans) + ',',
    '  checkIds: ' + JSON.stringify(snapshot.checkIds) + ',',
    '  metadataGaps: ' + JSON.stringify(snapshot.metadataGaps) + ',',
    '  pages: {',
    ...PAGE_IDS.map((pageId) => '    ' + JSON.stringify(pageId) + ': ' + pageConstName(pageId) + ','),
    '  },',
    '  digest: ' + JSON.stringify(snapshot.digest) + ',',
    '};',
    '',
    'export default SOURCE_FACTS_SNAPSHOT;',
    '',
  ];
  files.set(path.join(roots.outDir, 'source-facts.snapshot.ts'), coreLines.join('\n'));
  return files;
}

function normalizeText(text) {
  return String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function checkSnapshot(options) {
  const built = buildSnapshot(options);
  const files = moduleFiles(built, options);
  const errors = [];
  for (const [file, expected] of files) {
    if (!fs.existsSync(file)) {
      errors.push('缺少 SourceFacts 快照模块：' + repoPath(file));
      continue;
    }
    if (normalizeText(fs.readFileSync(file, 'utf8')) !== normalizeText(expected)) {
      errors.push('SourceFacts 快照模块与真源不一致：' + repoPath(file));
    }
  }
  return { ok: errors.length === 0, errors, snapshot: built, files: [...files.keys()] };
}

function writeSnapshot(options) {
  const built = buildSnapshot(options);
  const files = moduleFiles(built, options);
  let bytes = 0;
  for (const [file, text] of files) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
    bytes += Buffer.byteLength(text, 'utf8');
  }
  return { snapshot: built, files: [...files.keys()], bytes };
}

function main(argv) {
  const args = new Set(argv);
  const options = {};
  const outIndex = argv.indexOf('--out-dir');
  if (outIndex >= 0 && argv[outIndex + 1]) options.outDir = argv[outIndex + 1];
  try {
    if (args.has('--check')) {
      const result = checkSnapshot(options);
      if (!result.ok) {
        for (const error of result.errors) console.error('  x ' + error);
        console.error('SourceFacts 校验失败：请运行 node scripts/agent-source-facts.cjs 重新生成。');
        process.exitCode = 1;
        return;
      }
      const snapshot = result.snapshot;
      const pageCount = Object.keys(snapshot.pages).length;
      const stateCount = Object.values(snapshot.pages).reduce((sum, page) => sum + page.uiStates.length, 0);
      console.log(
        'SourceFacts 校验通过：' + pageCount + ' 页、' + Object.keys(snapshot.components).length + ' 组件、' +
        snapshot.plans.length + ' Plan、' + stateCount + ' UI 状态、' + snapshot.localAssets.length + ' 本地资产（' +
        result.files.length + ' 个模块）',
      );
      return;
    }
    if (args.has('--print')) {
      process.stdout.write(renderJson(buildSnapshot(options)));
      return;
    }
    const written = writeSnapshot(options);
    console.log('SourceFacts 已生成：' + written.files.length + ' 个模块，共 ' + written.bytes + ' B，目录 ' + repoPath(path.dirname(written.files[0])));
    const pageCount = Object.keys(written.snapshot.pages).length;
    const stateCount = Object.values(written.snapshot.pages).reduce((sum, page) => sum + page.uiStates.length, 0);
    console.log(
      '  ' + pageCount + ' 页、' + Object.keys(written.snapshot.components).length + ' 组件、' +
      written.snapshot.plans.length + ' Plan、' + stateCount + ' UI 状态、' + written.snapshot.localAssets.length + ' 本地资产',
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (require.main === module) main(process.argv.slice(2));

module.exports = {
  SNAPSHOT_VERSION,
  PAGE_IDS,
  CHECK_IDS,
  PAGE_CONTRACTS,
  analyzePageScript,
  analyzeWxml,
  buildSnapshot,
  checkSnapshot,
  writeSnapshot,
  renderJson,
  moduleFiles,
  pageConstName,
  normalizeText,
};
