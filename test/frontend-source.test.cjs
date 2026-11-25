'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const parse = require('../scripts/frontend-source/parse.cjs');
const bindings = require('../scripts/frontend-source/bindings.cjs');
const events = require('../scripts/frontend-source/events.cjs');
const components = require('../scripts/frontend-source/components.cjs');
const wxss = require('../scripts/frontend-source/wxss.cjs');
const jsPolicy = require('../scripts/frontend-source/js-policy.cjs');
const check = require('../scripts/frontend-source/check.cjs');

const FIXTURES = path.join(__dirname, 'fixtures', 'frontend-source');
const BASE = path.join(__dirname, '..', 'templates', 'base', 'ordering-base', '1.0.0', 'src');

function fixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

function makeFacts() {
  const componentRoot = 'templates/base/ordering-base/1.0.0/src/components';
  return {
    version: 'source-facts.v2',
    digest: 'sha256:' + 'a'.repeat(64),
    components: {
      'product-card': {
        id: 'product-card',
        kind: 'base-builtin',
        root: componentRoot + '/product-card',
        files: ['index.js', 'index.json', 'index.wxml', 'index.wxss'],
        registry: null,
        props: [['product', 'object', true, {}], ['quantity', 'number', false, 0], ['disabled', 'boolean', false, false]],
        events: [['add', ['productId']], ['openDetail', ['productId']], ['remove', ['productId']]],
        example: '<product-card product="{{product}}" />',
        limits: ['金额只读 priceCents'],
      },
      'error-banner': {
        id: 'error-banner',
        kind: 'base-builtin',
        root: componentRoot + '/error-banner',
        files: ['index.js', 'index.json', 'index.wxml', 'index.wxss'],
        registry: null,
        props: [['action', 'string', false, ''], ['message', 'string', false, ''], ['requestId', 'string', false, '']],
        events: [['close', []], ['retry', []]],
        example: '<error-banner message="{{error}}" />',
        limits: [],
      },
    },
    pages: {
      menu: {
        pageId: 'menu',
        path: 'pages/menu',
        pageJson: {
          navigationBarTitleText: '菜单',
          enablePullDownRefresh: true,
          usingComponents: {
            'product-card': '/components/product-card/index',
            'error-banner': '/components/error-banner/index',
          },
        },
        data: {
          initial: {
            loading: 'boolean:true',
            error: 'string:',
            products: 'array<empty>',
            categories: 'array<object{name,products}>',
            cartSummary: 'object{items,totalCents,totalQuantity}',
            quantityMap: 'object{}',
            store: 'null',
          },
          setData: ['loading', 'products'],
        },
        handlers: {
          methods: ['onRetry', 'onProductAdd', 'onProductRemove', 'onOpenDetail'],
          lifecycle: [],
        },
        pageContract: {
          schemaVersion: 'page-contract.v1',
          pageId: 'menu',
          requiredHandlers: ['onProductAdd'],
          requiredData: ['products'],
          requiredStates: ['loading'],
          requiredComponentEvents: [{ component: 'product-card', event: 'add', handler: 'onProductAdd' }],
          requiredRoutes: [],
          availableCheckIds: ['source.check'],
        },
      },
    },
  };
}

function projectFiles(wxml, extra) {
  return [
    { path: 'pages/menu/index.wxml', content: wxml },
    { path: 'pages/menu/index.json', content: JSON.stringify({ navigationBarTitleText: '菜单', usingComponents: { 'product-card': '/components/product-card/index', 'error-banner': '/components/error-banner/index' } }) },
  ].concat(extra || []);
}

test('parse：WXML 真实 AST、未闭合标签与属性定位', () => {
  const ast = parse.parseWxml(fixture('page-valid.wxml'));
  assert.equal(ast.type, 'root');
  const elements = [];
  (function walk(node) {
    if (node.type === 'element') elements.push(node.name);
    (node.children || []).forEach(walk);
  })(ast);
  assert.ok(elements.includes('product-card'));
  assert.ok(elements.includes('image'));
  assert.throws(() => parse.parseWxml('<view><text>x</view>'), (error) => error.code === 'WXML_PARSE_ERROR' && error.line === 1);
  assert.throws(() => parse.parseWxml('<view class="x"'), (error) => error.code === 'WXML_PARSE_ERROR');
});

test('parse：表达式子集（三元/成员/索引）与拒绝函数调用', () => {
  const expression = parse.parseExpression("cartSummary.totalQuantity > 0 ? store.name : '菜单'");
  assert.equal(expression.type, 'ConditionalExpression');
  const call = parse.parseExpression('item.price.toFixed(2)');
  assert.equal(call.type, 'CallExpression');
  assert.throws(() => parse.parseExpression('a = 1'), (error) => error.code === 'EXPRESSION_PARSE_ERROR');
  assert.throws(() => parse.parseExpression('a +'), (error) => error.code === 'EXPRESSION_PARSE_ERROR');
  assert.deepEqual(parse.extractBindingsFromExpression(expression).roots.sort(), ['cartSummary', 'store']);
});

test('bindings：嵌套 wx:for 局部作用域、已知字段与未知形状不误杀', () => {
  const ast = parse.parseWxml(fixture('page-valid.wxml'));
  const result = bindings.validatePageBindings(ast, { pageId: 'menu', file: 'pages/menu/index.wxml', facts: makeFacts() });
  assert.deepEqual(result.issues, []);
  const invalid = bindings.validatePageBindings(parse.parseWxml(fixture('page-invalid.wxml')), { pageId: 'menu', file: 'pages/menu/index.wxml', facts: makeFacts() });
  const codes = invalid.issues.map((issue) => issue.code);
  assert.ok(codes.includes('DATA_ROOT_UNKNOWN'));
  assert.ok(codes.includes('DATA_FIELD_UNKNOWN'));
  assert.ok(codes.includes('EXPRESSION_FUNCTION_CALL'));
  const unknownShape = bindings.validatePageBindings(parse.parseWxml('<view>{{store.name}} {{visit.fromScene}}</view>'), { pageId: 'menu', file: 'pages/menu/index.wxml', facts: makeFacts() });
  assert.ok(!unknownShape.issues.some((issue) => issue.code === 'DATA_FIELD_UNKNOWN'), 'store/visit 未知形状不得误杀');
});

test('events：handler 存在性、组件事件声明与 page-contract 接线', () => {
  const ast = parse.parseWxml(fixture('page-valid.wxml'));
  const valid = events.validatePageEvents(ast, { pageId: 'menu', file: 'pages/menu/index.wxml', facts: makeFacts() });
  assert.deepEqual(valid.issues, []);
  const invalidAst = parse.parseWxml('<view><product-card product="{{store}}" bind:add="missing" bind:unknown="onRetry" /></view>');
  const invalid = events.validatePageEvents(invalidAst, { pageId: 'menu', file: 'pages/menu/index.wxml', facts: makeFacts() });
  const codes = invalid.issues.map((issue) => issue.code);
  assert.ok(codes.includes('EVENT_HANDLER_MISSING'));
  assert.ok(codes.includes('COMPONENT_EVENT_UNKNOWN'));
});

test('components：未声明标签、未知 prop、必填 prop、四件套路径', () => {
  const ast = parse.parseWxml('<view><not-declared /><product-card unknown-prop="{{1}}" /><product-card /></view>');
  const issues = components.validateComponentTags(ast, { pageId: 'menu', file: 'pages/menu/index.wxml', facts: makeFacts(), usingComponents: { 'product-card': '/components/product-card/index' } });
  const codes = issues.map((issue) => issue.code);
  assert.ok(codes.includes('COMPONENT_UNDECLARED'));
  assert.ok(codes.includes('COMPONENT_PROP_UNKNOWN'));
  assert.ok(codes.includes('COMPONENT_PROP_REQUIRED'));
  const using = components.validateUsingComponents('menu', { bad: 'https://example.com/c' }, makeFacts(), { file: 'index.json' });
  assert.ok(using.some((issue) => issue.code === 'COMPONENT_PATH_INVALID'));
});

test('WXSS：真实解析、外部 URL/@import 拒绝、本地/data/动态引用不误杀', () => {
  assert.deepEqual(wxss.validateWxss(fixture('page-valid.wxss'), { file: 'index.wxss' }).issues, []);
  const external = wxss.validateWxss(fixture('page-external.wxss'), { file: 'index.wxss' });
  assert.ok(external.issues.some((issue) => issue.code === 'WXSS_EXTERNAL_URL'));
  assert.ok(external.issues.some((issue) => issue.code === 'WXSS_EXTERNAL_IMPORT'));
  const broken = wxss.validateWxss(fixture('page-invalid.wxss'), { file: 'index.wxss' });
  assert.ok(broken.issues.some((issue) => issue.code === 'WXSS_PARSE_ERROR'));
  const dynamic = wxss.validateWxss('.x { background-image: url("{{product.imageUrl}}"); }', { file: 'index.wxss' });
  assert.deepEqual(dynamic.issues, []);
});

test('JS：UI 组件禁网络/路由/globalData/服务 require；页面 wx.request 允许', () => {
  const validComponent = jsPolicy.validateJs(fixture('component-valid.js'), { file: 'components/product-card/index.js', facts: makeFacts() });
  assert.deepEqual(validComponent.issues, []);
  const invalidComponent = jsPolicy.validateJs(fixture('component-invalid.js'), { file: 'components/product-card/index.js', facts: makeFacts() });
  const componentCodes = invalidComponent.issues.map((issue) => issue.code);
  assert.ok(componentCodes.includes('JS_COMPONENT_WX_FORBIDDEN'));
  assert.ok(componentCodes.includes('JS_COMPONENT_REQUIRE_FORBIDDEN'));
  assert.ok(componentCodes.includes('JS_COMPONENT_GLOBAL_DATA'));
  assert.ok(componentCodes.includes('COMPONENT_PROP_CONTRACT_MISSING'));
  const page = jsPolicy.validateJs(fixture('page-with-request.js'), { file: 'pages/menu/index.js', facts: makeFacts() });
  assert.ok(!page.issues.some((issue) => issue.code === 'JS_COMPONENT_WX_FORBIDDEN'), '页面 JS 不应被“看到 wx.request 就拒绝”');
  assert.deepEqual(page.issues, []);
  const invalidPage = jsPolicy.validateJs(fixture('page-invalid.js'), { file: 'pages/menu/index.js', facts: makeFacts() });
  assert.ok(invalidPage.issues.some((issue) => issue.code === 'JS_EVAL_FORBIDDEN'));
  const service = jsPolicy.validateJs(fixture('service-invalid.js'), { file: 'services/store.js', facts: makeFacts() });
  assert.ok(service.issues.some((issue) => issue.code === 'JS_SERVICE_PAGE_DEFINITION'));
});

test('JSON：app 路由/tabBar/网络配置必须有契约；页面 JSON 禁 app 级键', () => {
  const app = check.validateJson(fixture('app-changed.json'), { file: 'app.json' });
  const appCodes = app.issues.map((issue) => issue.code);
  assert.ok(appCodes.includes('APP_CONFIG_FORBIDDEN'));
  const allowed = check.validateJson(fixture('app-changed.json'), { file: 'app.json', contracts: { routes: true, tabBar: true } });
  assert.ok(!allowed.issues.some((issue) => issue.code === 'APP_CONFIG_FORBIDDEN'));
  const page = check.validateJson(fixture('page-invalid.json'), { file: 'pages/menu/index.json' });
  const pageCodes = page.issues.map((issue) => issue.code);
  assert.ok(pageCodes.includes('PAGE_CONFIG_FORBIDDEN'));
  assert.ok(pageCodes.includes('JSON_UNKNOWN_KEY'));
  const baseline = check.validateJson(fixture('page-invalid.json'), { file: 'pages/menu/index.json', baselineSource: fixture('page-invalid.json') });
  assert.ok(!baseline.issues.some((issue) => issue.code === 'PAGE_CONFIG_FORBIDDEN'), '未修改的基线 JSON 不应被当作越权改动');
});

test('checkProject：valid 页面通过；invalid 页面有界 issues 且无绝对路径/源码全文', () => {
  const valid = check.checkProject({ facts: makeFacts(), files: projectFiles(fixture('page-valid.wxml')) });
  assert.equal(valid.ok, true, valid.issues.map((issue) => issue.code + ':' + issue.message).join('\n'));
  const invalid = check.checkProject({ facts: makeFacts(), files: projectFiles(fixture('page-invalid.wxml')) });
  assert.equal(invalid.ok, false);
  assert.ok(invalid.issues.length <= check.MAX_ISSUES);
  for (const issue of invalid.issues) {
    assert.ok(!/^[A-Za-z]:[\\/]/.test(issue.file));
    assert.ok(!issue.message.includes('E:\\'));
    assert.ok(issue.message.length <= 180);
  }
  const many = Array.from({ length: 260 }, (_, index) => '<view>{{unknown' + index + '}}</view>').join('');
  const bounded = check.checkProject({ facts: makeFacts(), files: projectFiles(many) });
  assert.ok(bounded.issues.length <= check.MAX_ISSUES);
  assert.equal(bounded.truncated, true);
});

test('Base 8 页真实源码全量 check：0 issues（含组件/事件/数据/样式/JSON）', () => {
  const result = check.checkBase();
  assert.equal(result.files > 0, true);
  assert.equal(result.ok, true, result.issues.slice(0, 20).map((issue) => issue.file + ':' + issue.line + ' ' + issue.code + ' ' + issue.message).join('\n'));
  assert.deepEqual(Object.keys(result.pageMatrix), check.PAGE_IDS);
  assert.ok(Object.values(result.pageMatrix).every((count) => count === 0));
  assert.equal(result.failClosed, false);
});
