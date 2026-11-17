'use strict';

/**
 * P2-1：frontend-pack-draft.v1 安全 schema + 确定性 renderer。
 *
 * 事实来源（P2 repair-3“单一事实源”）：直接加载 P1 随包分发的
 * `server/src/agent/frontend-reconstruct/capabilities.snapshot.json`（含内嵌 pageFacts），
 * 不再从原始 WXML token 自建一套 dataPaths。测试只读仓库文件，临时目录都在 os.tmpdir()。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const BASE_ROOT = path.join(REPO, 'templates', 'base', 'ordering-base', '1.0.0');
const BASE_SRC = path.join(BASE_ROOT, 'src');
const CATALOG = path.join(REPO, 'templates', 'catalog');

const schema = require(path.join(REPO, 'desktop', 'frontend-reconstruct', 'schema.cjs'));
const render = require(path.join(REPO, 'desktop', 'frontend-reconstruct', 'render.cjs'));
const { loadPackagedFacts } = require(path.join(REPO, 'desktop', 'frontend-reconstruct', 'materialize.cjs'));
const { validateFrontendPackManifest, FRONTEND_PACK_PAGE_JSON_KEYS } = require(
  path.join(REPO, 'scripts', 'composer', 'schema.cjs'),
);

const BASE_MANIFEST = JSON.parse(fs.readFileSync(path.join(BASE_ROOT, 'manifest.json'), 'utf8'));

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function pageJson(pageId) {
  return readJson(path.join(BASE_SRC, 'pages', pageId, 'index.json'));
}

function pageSource(pageId) {
  return fs.readFileSync(path.join(BASE_SRC, 'pages', pageId, 'index.js'), 'utf8');
}

function componentCard(componentId) {
  return readJson(path.join(CATALOG, 'components', componentId + '.json'));
}

function controllerMethods(pageId) {
  const source = pageSource(pageId);
  return [...source.matchAll(/^ {2}([A-Za-z][A-Za-z0-9]*)\(/gm)].map((match) => match[1]);
}

/** 页面控制器 `Page({ data: {...} })` 的字段名：用于证明映射后的 WXML 表达式落在真实字段上。 */
function controllerDataKeys(pageId) {
  const source = pageSource(pageId);
  const match = /data:\s*\{([\s\S]*?)\n {2}\},/.exec(source);
  if (!match) return [];
  return [...match[1].matchAll(/^ {4}([A-Za-z][A-Za-z0-9]*):/gm)].map((item) => item[1]);
}

/** 单页最小 Draft（只含给定节点），用于映射/负向用例。 */
function onePageDraft(pageId, nodes) {
  return {
    schemaVersion: 'frontend-pack-draft.v1',
    displayName: '映射用例',
    pages: [{ pageId, nodes, styles: [], pageJson: {} }],
  };
}

const TARGET_PAGES = ['home', 'menu'];

/** 真实 P1 打包事实（单一事实源）；失败立刻暴露，避免测试用本地假事实掩盖集成缺陷。 */
const PACKAGED = loadPackagedFacts();
if (!PACKAGED.ok) {
  throw new Error('无法加载 P1 能力快照：' + JSON.stringify(PACKAGED));
}
const FACTS = PACKAGED.facts;
const PAGE_FACTS = PACKAGED.pageFacts;

/** 只出现在 home 页面事实里的数据路径（用于 home/menu 交叉绑定负向测试）。 */
const HOME_ONLY_DATA_PATH = PAGE_FACTS.home.dataPaths.find(
  (item) => !PAGE_FACTS.menu.dataPaths.includes(item),
);
/** 只出现在 menu 页面事实里的数据路径。 */
const MENU_ONLY_DATA_PATH = PAGE_FACTS.menu.dataPaths.find(
  (item) => !PAGE_FACTS.home.dataPaths.includes(item),
);

function buildDraft() {
  return {
    schemaVersion: 'frontend-pack-draft.v1',
    displayName: '参考图首页候选',
    pages: [
      {
        pageId: 'home',
        nodes: [
          {
            type: 'component',
            componentId: 'store-header',
            props: {
              storeName: { kind: 'data', dataPath: 'store.name' },
              businessHours: { kind: 'data', dataPath: 'store.businessHours' },
              compact: { kind: 'literal', value: false },
            },
            events: {},
          },
          { type: 'slot', slotId: 'home-hero' },
          { type: 'text', textToken: 'store.name', style: { size: 'lg', weight: 700, colorToken: 'textColor' } },
          {
            type: 'container',
            style: {
              direction: 'row',
              align: 'center',
              justify: 'between',
              gap: 'md',
              padding: 'sm',
              radius: 'lg',
              width: 'full',
              minHeight: 88,
              backgroundColorToken: 'pageBackground',
              borderColorToken: 'primaryColor',
            },
            children: [
              { type: 'text', textToken: 'store.address', style: { size: 'sm' } },
              { type: 'button', label: '开始点餐', action: 'home.goMenu', style: { size: 'md', weight: 600, colorToken: 'accentColor' } },
            ],
          },
        ],
        styles: [],
        pageJson: {
          navigationBarTitleText: '扫码点餐',
          enablePullDownRefresh: true,
          backgroundColor: '#F8F1E7',
        },
      },
    ],
  };
}

function renderDraft(draft) {
  const result = render.renderFrontendPack(draft, { facts: FACTS, pageFacts: PAGE_FACTS });
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  return result;
}

function clone(value) {
  return structuredClone(value);
}

function draftError(mutator, expectedCode) {
  const draft = buildDraft();
  mutator(draft);
  const result = schema.validateDraft(draft, FACTS, PAGE_FACTS);
  assert.strictEqual(result.ok, false, '期望被拒绝：' + JSON.stringify(draft).slice(0, 200));
  assert.strictEqual(result.code, expectedCode, JSON.stringify(result));
  assert.ok(typeof result.path === 'string' && result.path.startsWith('$'), '错误必须带 DSL path：' + result.path);
  return result;
}

// ---------------------------------------------------------------------------
// 事实与 schema 正例
// ---------------------------------------------------------------------------

test('注入事实自洽：P1 快照与真实 Base/Catalog 同源，且使用规范命名空间', () => {
  assert.strictEqual(schema.validateFacts(FACTS).ok, true);
  assert.deepStrictEqual(
    { facts: PACKAGED.source, pages: PACKAGED.pagesSource },
    { facts: 'capabilities.snapshot.json', pages: 'capabilities.snapshot.json#pages' },
  );

  // 组件 props/events 与 catalog 声明一致（catalog:check 负责实现同源）。
  for (const componentId of Object.keys(FACTS.components)) {
    assert.ok(pageJson('home').usingComponents[componentId] || pageJson('menu').usingComponents[componentId]);
    const card = componentCard(componentId);
    assert.deepStrictEqual(
      FACTS.components[componentId].props,
      (card.interface.props || []).map((prop) => prop.name).sort(),
      '组件 props 必须与 catalog 一致：' + componentId,
    );
    assert.deepStrictEqual(
      FACTS.components[componentId].events,
      (card.interface.events || []).map((event) => event.name).sort(),
      '组件 events 必须与 catalog 一致：' + componentId,
    );
  }
  // 动作必须在真实控制器方法中。
  for (const action of FACTS.actions) {
    const [pageId, method] = action.split('.');
    assert.ok(controllerMethods(pageId).includes(method), '动作必须真实存在于控制器：' + action);
  }
  assert.deepStrictEqual(FACTS.slots, ['home-hero', 'home-marketing', 'menu-aside', 'menu-hero']);

  // 规范命名空间（t18 finding 的核心）：cartSummary.*/products.length 等原始 token 不得出现，
  // 合法绑定必须是 cart.* / <pageId>.<key> / store.*。
  const canonical = ['home.mode', 'menu.products', 'menu.categories', 'cart.totalCents', 'cart.count', 'cart.items', 'store.name'];
  for (const dataPath of canonical) {
    assert.ok(FACTS.dataPaths.includes(dataPath), '全局事实缺少规范路径：' + dataPath);
  }
  assert.ok(PAGE_FACTS.home.dataPaths.includes('home.mode'));
  assert.ok(PAGE_FACTS.menu.dataPaths.includes('menu.products'));
  assert.ok(PAGE_FACTS.menu.dataPaths.includes('menu.categories'));
  assert.ok(PAGE_FACTS.menu.dataPaths.includes('cart.totalCents'));
  assert.ok(PAGE_FACTS.menu.dataPaths.includes('cart.count'));
  assert.ok(!PAGE_FACTS.home.dataPaths.includes('cart.totalCents'), 'cart.* 属于 menu 页');
  for (const rawToken of ['cartSummary.totalCents', 'cartSummary.items', 'cartSummary.totalQuantity', 'products.length', 'item.name']) {
    assert.ok(!FACTS.dataPaths.includes(rawToken), '原始 WXML token 不得进入事实：' + rawToken);
    for (const pageId of TARGET_PAGES) {
      assert.ok(!PAGE_FACTS[pageId].dataPaths.includes(rawToken), '原始 WXML token 不得进入页面事实：' + rawToken);
    }
  }
  // 页面事实与 Base 同源：组件 ⊆ usingComponents、插槽 == Base Manifest。
  for (const pageId of TARGET_PAGES) {
    const using = Object.keys(pageJson(pageId).usingComponents || {}).sort();
    for (const componentId of PAGE_FACTS[pageId].components) assert.ok(using.includes(componentId));
    assert.deepStrictEqual(
      PAGE_FACTS[pageId].slots,
      BASE_MANIFEST.slots.filter((slot) => slot.pageId === pageId).map((slot) => slot.slotId).sort(),
    );
  }
});

test('合法 Draft：5 类节点全部通过并归一化（键顺序无关）', () => {
  const draft = buildDraft();
  const result = schema.validateDraft(draft, FACTS, PAGE_FACTS);
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.deepStrictEqual(result.draft.pages[0].nodes.map((node) => node.type), [
    'component',
    'slot',
    'text',
    'container',
  ]);
  assert.deepStrictEqual(
    result.draft.pages[0].nodes[3].children.map((node) => node.type),
    ['text', 'button'],
  );
  assert.deepStrictEqual(result.draft.pages[0].styles, []);
});

test('menu 页 Draft 通过：组件与动作按页面限定', () => {
  const draft = {
    schemaVersion: 'frontend-pack-draft.v1',
    displayName: '参考图菜单候选',
    pages: [
      {
        pageId: 'menu',
        nodes: [
          { type: 'slot', slotId: 'menu-aside' },
          { type: 'component', componentId: 'category-nav', props: {}, events: { select: 'menu.onSelectCategory' } },
          { type: 'component', componentId: 'product-card', props: {}, events: { openDetail: 'menu.onOpenDetail' } },
          { type: 'text', textToken: 'store.name' },
          { type: 'button', label: '去结算', action: 'menu.onCheckout' },
        ],
        styles: [],
        pageJson: {},
      },
    ],
  };
  const result = schema.validateDraft(draft, FACTS, PAGE_FACTS);
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  const rendered = render.renderFrontendPack(draft, { facts: FACTS, pageFacts: PAGE_FACTS });
  assert.strictEqual(rendered.ok, true, JSON.stringify(rendered));
  assert.deepStrictEqual(rendered.manifest.pages, ['menu']);
  assert.deepStrictEqual(rendered.manifest.requiresSlots, ['menu-aside']);
  const wxml = rendered.files.get('src/pages/menu/index.wxml');
  assert.ok(wxml.includes('bind:select="onSelectCategory"'));
  assert.ok(wxml.includes('bind:openDetail="onOpenDetail"'));
  assert.ok(wxml.includes('bind:tap="onCheckout"'));
});

// ---------------------------------------------------------------------------
// schema 负例：未知节点/组件/事件/数据/样式/源码/URL/路径
// ---------------------------------------------------------------------------

test('拒绝未知节点类型与任意 WXML/WXSS/JS/WXS 原文', () => {
  draftError((draft) => {
    draft.pages[0].nodes[0] = { type: 'wxml', source: '<view>{{store.name}}</view>' };
  }, 'DRAFT_SCHEMA_INVALID');

  draftError((draft) => {
    draft.pages[0].nodes[2].wxml = '<view />';
  }, 'DRAFT_SCHEMA_INVALID');

  draftError((draft) => {
    draft.pages[0].nodes[2].wxss = '.x{color:red}';
  }, 'DRAFT_SCHEMA_INVALID');

  draftError((draft) => {
    draft.pages[0].nodes[2].script = 'function(){return 1}';
  }, 'DRAFT_SCHEMA_INVALID');

  draftError((draft) => {
    draft.pages[0].nodes[2].wxs = 'module.exports = {}';
  }, 'DRAFT_SCHEMA_INVALID');

  draftError((draft) => {
    draft.pages[0].nodes[2].import = '../../secret.wxml';
  }, 'DRAFT_SCHEMA_INVALID');

  draftError((draft) => {
    draft.pages[0].styles = ['.hack{display:none}'];
  }, 'DRAFT_SCHEMA_INVALID');

  draftError((draft) => {
    draft.schemaVersion = 'frontend-pack-draft.v2';
  }, 'DRAFT_SCHEMA_INVALID');

  draftError((draft) => {
    draft.extra = true;
  }, 'DRAFT_SCHEMA_INVALID');

  draftError((draft) => {
    draft.pages[0].pageId = 'checkout';
  }, 'DRAFT_SCHEMA_INVALID');

  draftError((draft) => {
    draft.pages[0].pageId = '../home';
  }, 'DRAFT_SCHEMA_INVALID');
});

test('拒绝未知组件、未在页面声明的组件、未知事件与跨页动作', () => {
  draftError((draft) => {
    draft.pages[0].nodes[0].componentId = 'not-a-component';
  }, 'DRAFT_UNKNOWN_COMPONENT');

  draftError((draft) => {
    draft.pages[0].nodes[0].componentId = 'category-nav';
  }, 'DRAFT_UNKNOWN_COMPONENT');

  draftError((draft) => {
    draft.pages[0].nodes[0].componentId = 'store-header';
    draft.pages[0].nodes[0].events = { tap: 'home.goMenu' };
  }, 'DRAFT_UNKNOWN_EVENT');

  draftError((draft) => {
    draft.pages[0].nodes[0].events = { change: 'home.notARealMethod' };
    draft.pages[0].nodes[0].componentId = 'fulfillment-switch';
    draft.pages[0].nodes[0].props = { value: { kind: 'data', dataPath: 'store.name' } };
  }, 'DRAFT_UNKNOWN_EVENT');

  draftError((draft) => {
    draft.pages[0].nodes[0].componentId = 'fulfillment-switch';
    draft.pages[0].nodes[0].props = {};
    draft.pages[0].nodes[0].events = { change: 'menu.onModeChange' };
  }, 'DRAFT_UNKNOWN_EVENT');

  draftError((draft) => {
    draft.pages[0].nodes[3].children[1].action = 'home.goMenu;process.exit(1)';
  }, 'DRAFT_UNKNOWN_EVENT');

  draftError((draft) => {
    draft.pages[0].nodes[3].children[1].action = 'home.goMenu()';
  }, 'DRAFT_UNKNOWN_EVENT');
});

test('拒绝未知 dataPath、模板表达式与外部数据串', () => {
  draftError((draft) => {
    draft.pages[0].nodes[2].textToken = 'store.notARealField';
  }, 'DRAFT_UNKNOWN_DATA_PATH');

  draftError((draft) => {
    draft.pages[0].nodes[2].textToken = 'tableName';
  }, 'DRAFT_UNKNOWN_DATA_PATH');

  draftError((draft) => {
    draft.pages[0].nodes[2].textToken = '{{store.name}}';
  }, 'DRAFT_UNKNOWN_DATA_PATH');

  draftError((draft) => {
    draft.pages[0].nodes[2].textToken = '../../etc/passwd';
  }, 'DRAFT_UNKNOWN_DATA_PATH');

  draftError((draft) => {
    draft.pages[0].nodes[0].props.storeName = { kind: 'data', dataPath: 'https://evil.example/x' };
  }, 'DRAFT_UNKNOWN_DATA_PATH');
});

test('拒绝未知 prop、URL/绝对路径/模板字的 literal prop', () => {
  draftError((draft) => {
    draft.pages[0].nodes[0].props.notAProp = { kind: 'literal', value: 1 };
  }, 'DRAFT_SCHEMA_INVALID');

  draftError((draft) => {
    draft.pages[0].nodes[0].props.storeName = { kind: 'literal', value: 'https://evil.example/store' };
  }, 'DRAFT_SCHEMA_INVALID');

  draftError((draft) => {
    draft.pages[0].nodes[0].props.storeName = { kind: 'literal', value: '/etc/passwd' };
  }, 'DRAFT_SCHEMA_INVALID');

  draftError((draft) => {
    draft.pages[0].nodes[0].props.storeName = { kind: 'literal', value: '..\\..\\secret' };
  }, 'DRAFT_SCHEMA_INVALID');

  draftError((draft) => {
    draft.pages[0].nodes[0].props.storeName = { kind: 'literal', value: '<script>alert(1)</script>' };
  }, 'DRAFT_SCHEMA_INVALID');

  draftError((draft) => {
    draft.pages[0].nodes[0].props.storeName = { kind: 'literal', value: '{{store.name}}' };
  }, 'DRAFT_SCHEMA_INVALID');

  draftError((draft) => {
    draft.pages[0].nodes[0].props.storeName = { kind: 'expression', value: 'process.env.SECRET' };
  }, 'DRAFT_SCHEMA_INVALID');
});

test('样式只允许白名单属性与档位', () => {
  draftError((draft) => {
    draft.pages[0].nodes[3].style.margin = '999px';
  }, 'DRAFT_STYLE_INVALID');

  draftError((draft) => {
    draft.pages[0].nodes[3].style.position = 'fixed';
  }, 'DRAFT_STYLE_INVALID');

  draftError((draft) => {
    draft.pages[0].nodes[3].style.width = 99999;
  }, 'DRAFT_STYLE_INVALID');

  draftError((draft) => {
    draft.pages[0].nodes[3].style.gap = '17rpx';
  }, 'DRAFT_STYLE_INVALID');

  draftError((draft) => {
    draft.pages[0].nodes[3].style = {};
  }, 'DRAFT_STYLE_INVALID');

  draftError((draft) => {
    draft.pages[0].nodes[2].style.size = 'xl';
  }, 'DRAFT_STYLE_INVALID');

  draftError((draft) => {
    draft.pages[0].nodes[2].style.weight = 900;
  }, 'DRAFT_STYLE_INVALID');

  draftError((draft) => {
    draft.pages[0].nodes[2].style.colorToken = 'brandColor';
  }, 'DRAFT_STYLE_INVALID');

  draftError((draft) => {
    draft.pages[0].nodes[3].style.backgroundColorToken = 'unknownToken';
  }, 'DRAFT_STYLE_INVALID');
});

test('pageJson 只允许白名单子集', () => {
  draftError((draft) => {
    draft.pages[0].pageJson.usingComponents = { evil: '/evil/index' };
  }, 'DRAFT_PAGE_JSON_INVALID');

  draftError((draft) => {
    draft.pages[0].pageJson.navigationBarTextStyle = 'gray';
  }, 'DRAFT_PAGE_JSON_INVALID');

  draftError((draft) => {
    draft.pages[0].pageJson.backgroundColor = 'red';
  }, 'DRAFT_PAGE_JSON_INVALID');

  draftError((draft) => {
    draft.pages[0].pageJson = [];
  }, 'DRAFT_PAGE_JSON_INVALID');
});

test('拒绝未知插槽、跨页插槽、空容器、过深嵌套与数量超限', () => {
  draftError((draft) => {
    draft.pages[0].nodes[1].slotId = 'custom-slot';
  }, 'DRAFT_SCHEMA_INVALID');

  draftError((draft) => {
    draft.pages[0].nodes[1].slotId = 'menu-aside';
  }, 'DRAFT_SCHEMA_INVALID');

  draftError((draft) => {
    draft.pages[0].nodes[3].children = [];
  }, 'DRAFT_SCHEMA_INVALID');

  draftError((draft) => {
    let node = { type: 'text', textToken: 'store.name' };
    for (let depth = 0; depth < 6; depth += 1) node = { type: 'container', children: [node] };
    draft.pages[0].nodes = [node];
  }, 'DRAFT_SCHEMA_INVALID');

  draftError((draft) => {
    draft.pages[0].nodes = new Array(49).fill({ type: 'text', textToken: 'store.name' });
  }, 'DRAFT_SCHEMA_INVALID');

  draftError((draft) => {
    draft.pages.push(clone(draft.pages[0]));
  }, 'DRAFT_SCHEMA_INVALID');
});

test('拒绝非法事实与页面事实（含缺失 dataPaths）', () => {
  const draft = buildDraft();
  const unknownKey = { ...FACTS, extra: true };
  assert.strictEqual(schema.validateDraft(draft, unknownKey, PAGE_FACTS).code, 'DRAFT_SCHEMA_INVALID');

  const wrongVersion = { ...FACTS, version: 'frontend-facts.v2' };
  assert.strictEqual(schema.validateDraft(draft, wrongVersion, PAGE_FACTS).code, 'DRAFT_SCHEMA_INVALID');

  const badToken = { ...FACTS, themeTokens: ['brandColor'] };
  assert.strictEqual(schema.validateDraft(draft, badToken, PAGE_FACTS).code, 'DRAFT_SCHEMA_INVALID');

  const badAction = { ...FACTS, actions: ['GO menu'] };
  assert.strictEqual(schema.validateDraft(draft, badAction, PAGE_FACTS).code, 'DRAFT_SCHEMA_INVALID');

  assert.strictEqual(
    schema.validateDraft(draft, FACTS, { home: { components: [], slots: [], dataPaths: [], extra: true } }).code,
    'DRAFT_SCHEMA_INVALID',
  );
  assert.strictEqual(
    schema.validateDraft(draft, FACTS, {
      home: { components: [], slots: [], dataPaths: [] },
      checkout: { components: [], slots: [], dataPaths: [] },
    }).code,
    'DRAFT_SCHEMA_INVALID',
  );
  // dataPaths 是页面事实的必填项：缺失即拒绝（不能悄悄回落到全局 dataPath）。
  assert.strictEqual(
    schema.validateDraft(draft, FACTS, {
      home: { components: Object.keys(pageJson('home').usingComponents).sort(), slots: ['home-hero'] },
    }).code,
    'DRAFT_SCHEMA_INVALID',
  );
  // 组件没有在页面 usingComponents 里声明 → 拒绝（不依赖渲染期运行时报错）。
  assert.strictEqual(
    schema.validateDraft(draft, FACTS, {
      home: {
        components: [],
        slots: ['home-hero'],
        dataPaths: PAGE_FACTS.home.dataPaths,
      },
    }).code,
    'DRAFT_UNKNOWN_COMPONENT',
  );
});

test('页面级 dataPaths：home/menu 交叉绑定必须拒绝（全局事实里有也不行）', () => {
  assert.ok(HOME_ONLY_DATA_PATH, 'home 页面应存在独占数据路径');
  assert.ok(MENU_ONLY_DATA_PATH, 'menu 页面应存在独占数据路径');
  assert.notStrictEqual(HOME_ONLY_DATA_PATH, MENU_ONLY_DATA_PATH);
  // 两条路径都存在于全局能力事实中，失败必须来自“页面事实”。
  assert.ok(FACTS.dataPaths.includes(HOME_ONLY_DATA_PATH));
  assert.ok(FACTS.dataPaths.includes(MENU_ONLY_DATA_PATH));

  const menuWithHomePath = {
    schemaVersion: 'frontend-pack-draft.v1',
    displayName: '错页绑定候选',
    pages: [
      {
        pageId: 'menu',
        nodes: [{ type: 'text', textToken: HOME_ONLY_DATA_PATH }],
        styles: [],
        pageJson: {},
      },
    ],
  };
  const textResult = schema.validateDraft(menuWithHomePath, FACTS, PAGE_FACTS);
  assert.strictEqual(textResult.ok, false);
  assert.strictEqual(textResult.code, 'DRAFT_UNKNOWN_DATA_PATH');
  assert.strictEqual(textResult.path, '$.pages[0].nodes[0].textToken');

  const menuWithHomeProp = {
    schemaVersion: 'frontend-pack-draft.v1',
    displayName: '错页 prop 候选',
    pages: [
      {
        pageId: 'menu',
        nodes: [
          {
            type: 'component',
            componentId: 'category-nav',
            props: { activeId: { kind: 'data', dataPath: HOME_ONLY_DATA_PATH } },
            events: {},
          },
        ],
        styles: [],
        pageJson: {},
      },
    ],
  };
  const propResult = schema.validateDraft(menuWithHomeProp, FACTS, PAGE_FACTS);
  assert.strictEqual(propResult.ok, false);
  assert.strictEqual(propResult.code, 'DRAFT_UNKNOWN_DATA_PATH');
  assert.strictEqual(propResult.path, '$.pages[0].nodes[0].props.activeId.dataPath');

  const homeWithMenuPath = {
    schemaVersion: 'frontend-pack-draft.v1',
    displayName: '错页绑定候选 2',
    pages: [
      {
        pageId: 'home',
        nodes: [{ type: 'text', textToken: MENU_ONLY_DATA_PATH }],
        styles: [],
        pageJson: {},
      },
    ],
  };
  const homeResult = schema.validateDraft(homeWithMenuPath, FACTS, PAGE_FACTS);
  assert.strictEqual(homeResult.ok, false);
  assert.strictEqual(homeResult.code, 'DRAFT_UNKNOWN_DATA_PATH');

  // 反过来：menu 页用 menu 自己的独占路径仍然合法（证明拒绝来自页面隔离，不是路径不存在）。
  const menuOwnPath = clone(menuWithHomePath);
  menuOwnPath.pages[0].nodes = [{ type: 'text', textToken: MENU_ONLY_DATA_PATH }];
  assert.strictEqual(schema.validateDraft(menuOwnPath, FACTS, PAGE_FACTS).ok, true);

  // 原始 WXML token（cartSummary.* / products.length）即使形式合法也不再被接受：
  // 唯一事实源是 P1 快照的规范命名空间。
  const rawTokenDraft = clone(menuWithHomePath);
  rawTokenDraft.pages[0].nodes = [{ type: 'text', textToken: 'cartSummary.totalCents' }];
  const rawResult = schema.validateDraft(rawTokenDraft, FACTS, PAGE_FACTS);
  assert.strictEqual(rawResult.ok, false);
  assert.strictEqual(rawResult.code, 'DRAFT_UNKNOWN_DATA_PATH');
});

// ---------------------------------------------------------------------------
// renderer 正例
// ---------------------------------------------------------------------------

test('renderer 输出合法 FrontendPack：manifest/页面三件套/预览四态', () => {
  const rendered = renderDraft(buildDraft());
  const manifestCheck = validateFrontendPackManifest(rendered.manifest);
  assert.strictEqual(manifestCheck.ok, true, JSON.stringify(manifestCheck));

  assert.deepStrictEqual(
    [...rendered.files.keys()].sort(),
    [
      'manifest.json',
      'preview/empty.json',
      'preview/error.json',
      'preview/long.json',
      'preview/normal.json',
      'src/pages/home/index.json',
      'src/pages/home/index.wxml',
      'src/pages/home/index.wxss',
    ],
  );
  assert.deepStrictEqual(rendered.manifest.pages, ['home']);
  assert.deepStrictEqual(rendered.manifest.requiresSlots, ['home-hero']);
  assert.deepStrictEqual(rendered.manifest.preview.kinds, ['normal', 'empty', 'error', 'long']);
  assert.strictEqual(rendered.manifest.release.stage, 'candidate');
  assert.deepStrictEqual(rendered.manifest.boundary, {
    allowNetwork: false,
    allowRoutes: false,
    allowGlobalState: false,
    allowServices: false,
  });
  assert.strictEqual(rendered.manifest.entry.files.length, 3);
  assert.match(rendered.candidateId, /^[a-z][a-z0-9-]{1,63}$/);
  assert.match(rendered.digest, /^sha256:[0-9a-f]{64}$/);

  for (const kind of render.PREVIEW_KINDS) {
    const preview = JSON.parse(rendered.files.get('preview/' + kind + '.json'));
    assert.strictEqual(preview.state, kind);
    assert.deepStrictEqual(preview.pages, [{ pageId: 'home', slotIds: ['home-hero'] }]);
  }
});

test('WXML：五类节点 + 完整 slot fallback 锚点 + 真实控制器事件', () => {
  const rendered = renderDraft(buildDraft());
  const wxml = rendered.files.get('src/pages/home/index.wxml');

  assert.ok(wxml.startsWith('<view class="page fp-cand-page fp-cand-page--home">'));
  assert.ok(wxml.includes('<store-header '));
  assert.ok(wxml.includes('store-name="{{store.name}}"'));
  assert.ok(wxml.includes('compact="{{false}}"'));
  assert.ok(wxml.includes('<text class="fp-cand__text-2">{{store.name}}</text>'));
  assert.ok(wxml.includes('<button class="fp-cand__button fp-cand__button-3-1" bind:tap="goMenu">开始点餐</button>'));

  for (const anchor of [
    '<!-- @slot:home-hero -->',
    '<!-- @slot-fallback:home-hero -->',
    '<!-- @slot-fallback:home-hero:end -->',
    '<!-- @slot:home-hero:end -->',
  ]) {
    assert.strictEqual(wxml.split(anchor).length - 1, 1, '锚点必须恰好出现一次：' + anchor);
  }

  for (const forbidden of ['<script', '<wxs', '<import', '<include', 'wxs ', 'eval(', 'Function(', 'http://', 'https://', '//', '..', '\\']) {
    assert.ok(!wxml.includes(forbidden), 'WXML 不得包含：' + forbidden);
  }
});

test('dataPath → WXML 映射：规范 token 不原样透传，且落在真实 Base 数据字段上', () => {
  const cases = [
    { pageId: 'home', token: 'home.mode', expression: 'mode' },
    { pageId: 'home', token: 'home.tableName', expression: 'tableName' },
    { pageId: 'menu', token: 'menu.products', expression: 'products' },
    { pageId: 'menu', token: 'menu.categories', expression: 'categories' },
    { pageId: 'menu', token: 'cart.items', expression: 'cartSummary.items' },
    { pageId: 'menu', token: 'cart.totalCents', expression: 'cartSummary.totalCents' },
    { pageId: 'menu', token: 'cart.count', expression: 'cartSummary.totalQuantity' },
  ];
  for (const item of cases) {
    const rendered = render.renderFrontendPack(
      onePageDraft(item.pageId, [{ type: 'text', textToken: item.token }]),
      { facts: FACTS, pageFacts: PAGE_FACTS },
    );
    assert.strictEqual(rendered.ok, true, item.token + ' ' + JSON.stringify(rendered));
    const wxml = rendered.files.get('src/pages/' + item.pageId + '/index.wxml');
    assert.ok(wxml.includes('{{' + item.expression + '}}'), item.token + ' → ' + item.expression);
    assert.ok(!wxml.includes('{{' + item.token + '}}'), '规范 token 不得原样出现在 WXML：' + item.token);
    // 映射落点必须是真实 Base 字段：<page>.<key> 的 key 在控制器 data 里；cart.* 落在 cartSummary。
    if (item.token.startsWith(item.pageId + '.')) {
      assert.ok(controllerDataKeys(item.pageId).includes(item.expression), '映射必须命中控制器 data：' + item.expression);
    }
    if (item.token.startsWith('cart.')) {
      assert.ok(controllerDataKeys(item.pageId).includes('cartSummary'));
    }
  }

  // store.* 原样保留（Base 的 store 就是嵌套对象）。
  const storeRendered = render.renderFrontendPack(
    onePageDraft('home', [{ type: 'text', textToken: 'store.fulfillment.dineIn' }]),
    { facts: FACTS, pageFacts: PAGE_FACTS },
  );
  assert.strictEqual(storeRendered.ok, true);
  const storeWxml = storeRendered.files.get('src/pages/home/index.wxml');
  assert.ok(storeWxml.includes('{{store.fulfillment.dineIn}}'));
  assert.ok(!storeWxml.includes('{{home.store'));

  // component prop 的 data 绑定同样映射。
  const propRendered = render.renderFrontendPack(
    onePageDraft('menu', [
      {
        type: 'component',
        componentId: 'category-nav',
        props: { categories: { kind: 'data', dataPath: 'menu.categories' } },
        events: {},
      },
    ]),
    { facts: FACTS, pageFacts: PAGE_FACTS },
  );
  assert.strictEqual(propRendered.ok, true, JSON.stringify(propRendered));
  assert.ok(
    propRendered.files.get('src/pages/menu/index.wxml').includes('categories="{{categories}}"'),
    'component prop 必须映射为 {{categories}}',
  );
});

test('页面事实里的每条 dataPath 都能映射到真实 Base 数据字段（快照 21 条全量覆盖）', () => {
  const CART_EXPECTED = {
    'cart.items': 'cartSummary.items',
    'cart.totalCents': 'cartSummary.totalCents',
    'cart.count': 'cartSummary.totalQuantity',
  };
  let checked = 0;
  for (const pageId of TARGET_PAGES) {
    const dataKeys = controllerDataKeys(pageId);
    for (const token of PAGE_FACTS[pageId].dataPaths) {
      const rendered = render.renderFrontendPack(
        onePageDraft(pageId, [{ type: 'text', textToken: token }]),
        { facts: FACTS, pageFacts: PAGE_FACTS },
      );
      assert.strictEqual(rendered.ok, true, token + ' ' + JSON.stringify(rendered));
      const wxml = rendered.files.get('src/pages/' + pageId + '/index.wxml');
      const root = token.split('.')[0];
      let expression;
      let expectedDataKey;
      if (root === pageId) {
        expression = token.slice(pageId.length + 1);
        expectedDataKey = expression.split('.')[0];
      } else if (root === 'store') {
        expression = token;
        expectedDataKey = 'store';
      } else if (root === 'cart') {
        expression = CART_EXPECTED[token];
        expectedDataKey = 'cartSummary';
        assert.ok(expression, 'cart 路径必须有映射：' + token);
      } else {
        assert.fail('快照出现未知规范根：' + token);
      }
      assert.ok(dataKeys.includes(expectedDataKey), token + ' 映射到不存在的 Base 字段：' + expectedDataKey);
      assert.ok(wxml.includes('{{' + expression + '}}'), token + ' → {{' + expression + '}}');
      assert.ok(!wxml.includes('{{' + token + '}}') || expression === token, '规范 token 不得原样透传：' + token);
      checked += 1;
    }
  }
  assert.ok(checked >= 20, '应覆盖快照全部页面 dataPaths，实际 ' + checked);
});

test('未知规范根 / 未知 cart key：渲染期 RENDER_DATA_PATH_UNSUPPORTED（不静默透传）', () => {
  // 未知根：即使事实里出现（模拟未来快照新增 visit.*），renderer 也必须显式失败。
  const factsWithVisit = clone(FACTS);
  factsWithVisit.dataPaths = [...factsWithVisit.dataPaths, 'visit.scene'];
  const pageFactsWithVisit = clone(PAGE_FACTS);
  pageFactsWithVisit.home.dataPaths = [...pageFactsWithVisit.home.dataPaths, 'visit.scene'];
  const visitDraft = onePageDraft('home', [{ type: 'text', textToken: 'visit.scene' }]);
  // schema 层允许（事实里有），renderer 层必须拒绝。
  assert.strictEqual(schema.validateDraft(visitDraft, factsWithVisit, pageFactsWithVisit).ok, true);
  const visitResult = render.renderFrontendPack(visitDraft, { facts: factsWithVisit, pageFacts: pageFactsWithVisit });
  assert.strictEqual(visitResult.ok, false);
  assert.strictEqual(visitResult.code, 'RENDER_DATA_PATH_UNSUPPORTED');
  assert.strictEqual(visitResult.path, '$.pages[0].nodes[0].textToken');

  // 未知 cart key：cart 只允许 items/totalCents/count。
  const factsWithCart = clone(FACTS);
  factsWithCart.dataPaths = [...factsWithCart.dataPaths, 'cart.notAKey'];
  const pageFactsWithCart = clone(PAGE_FACTS);
  pageFactsWithCart.menu.dataPaths = [...pageFactsWithCart.menu.dataPaths, 'cart.notAKey'];
  const cartDraft = onePageDraft('menu', [{ type: 'text', textToken: 'cart.notAKey' }]);
  assert.strictEqual(schema.validateDraft(cartDraft, factsWithCart, pageFactsWithCart).ok, true);
  const cartResult = render.renderFrontendPack(cartDraft, { facts: factsWithCart, pageFacts: pageFactsWithCart });
  assert.strictEqual(cartResult.ok, false);
  assert.strictEqual(cartResult.code, 'RENDER_DATA_PATH_UNSUPPORTED');
  assert.strictEqual(cartResult.path, '$.pages[0].nodes[0].textToken');

  // component prop 的未知根同样带精确 DSL path。
  const propDraft = onePageDraft('home', [
    {
      type: 'component',
      componentId: 'store-header',
      props: { storeName: { kind: 'data', dataPath: 'visit.storeId' } },
      events: {},
    },
  ]);
  pageFactsWithVisit.home.dataPaths = [...pageFactsWithVisit.home.dataPaths, 'visit.storeId'];
  factsWithVisit.dataPaths = [...factsWithVisit.dataPaths, 'visit.storeId'];
  const propResult = render.renderFrontendPack(propDraft, { facts: factsWithVisit, pageFacts: pageFactsWithVisit });
  assert.strictEqual(propResult.ok, false);
  assert.strictEqual(propResult.code, 'RENDER_DATA_PATH_UNSUPPORTED');
  assert.strictEqual(propResult.path, '$.pages[0].nodes[0].props.storeName.dataPath');
});

test('WXSS：只输出白名单属性与档位值，无 url()/import/position', () => {
  const rendered = renderDraft(buildDraft());
  const wxss = rendered.files.get('src/pages/home/index.wxss');
  const allowed = new Set([
    'display',
    'flex-direction',
    'align-items',
    'justify-content',
    'gap',
    'padding',
    'border-radius',
    'width',
    'min-height',
    'background',
    'border',
    'color',
    'font-size',
    'font-weight',
    'box-sizing',
  ]);
  const properties = [];
  for (const line of wxss.split('\n')) {
    const match = /^\s{2}([a-z-]+):\s*(.+);$/.exec(line);
    if (!match) continue;
    properties.push(match[1]);
    assert.ok(allowed.has(match[1]), '非白名单 CSS 属性：' + match[1]);
    assert.ok(!/[;{}<>]/.test(match[2]), 'CSS 值不得含结构字符：' + match[2]);
  }
  assert.ok(properties.length >= 8);
  for (const forbidden of ['url(', '@import', 'expression', '!important', 'position', 'transform', 'http']) {
    assert.ok(!wxss.includes(forbidden), 'WXSS 不得包含：' + forbidden);
  }
  assert.ok(wxss.includes('.fp-cand__box-3 {'));
  assert.ok(wxss.includes('gap: 16rpx;'));
  assert.ok(wxss.includes('border: 1rpx solid var(--store-primary-color);'));
  assert.ok(wxss.includes('font-size: 36rpx;'));
});

test('页面 JSON 只保留 Composer 允许的子集，被丢弃键进入 degradations', () => {
  const rendered = renderDraft(buildDraft());
  const pageJson = JSON.parse(rendered.files.get('src/pages/home/index.json'));
  for (const key of Object.keys(pageJson)) {
    assert.ok(FRONTEND_PACK_PAGE_JSON_KEYS.includes(key), '页面 JSON 键超出白名单：' + key);
  }
  assert.deepStrictEqual(pageJson, {
    navigationBarTitleText: '扫码点餐',
    enablePullDownRefresh: true,
    backgroundColor: '#F8F1E7',
  });

  const draft = buildDraft();
  draft.pages[0].pageJson.navigationBarBackgroundColor = '#123456';
  draft.pages[0].pageJson.navigationBarTextStyle = 'white';
  const withDropped = renderDraft(draft);
  const dropped = JSON.parse(withDropped.files.get('src/pages/home/index.json'));
  assert.strictEqual(dropped.navigationBarBackgroundColor, undefined);
  assert.strictEqual(dropped.navigationBarTextStyle, undefined);
  assert.deepStrictEqual(
    withDropped.degradations.map((item) => item.code + ':' + item.path),
    [
      'PAGE_JSON_KEY_UNSUPPORTED:$.home.pageJson.navigationBarBackgroundColor',
      'PAGE_JSON_KEY_UNSUPPORTED:$.home.pageJson.navigationBarTextStyle',
    ],
  );
});

test('确定性：同 DSL 重复渲染逐字节一致、摘要一致；键序无关', () => {
  const first = renderDraft(buildDraft());
  const second = renderDraft(buildDraft());
  assert.strictEqual(first.digest, second.digest);
  assert.deepStrictEqual([...first.files.keys()], [...second.files.keys()]);
  for (const [file, content] of first.files) assert.strictEqual(content, second.files.get(file), '文件必须逐字节一致：' + file);

  // props 的插入顺序不同，但语义相同 → 产物仍必须完全一致。
  const permuted = buildDraft();
  const props = permuted.pages[0].nodes[0].props;
  permuted.pages[0].nodes[0].props = {
    compact: props.compact,
    businessHours: props.businessHours,
    storeName: props.storeName,
  };
  const third = renderDraft(permuted);
  assert.strictEqual(third.digest, first.digest);

  // 任一有效改动都必须改变摘要。
  const changed = buildDraft();
  changed.pages[0].nodes[3].style.gap = 'lg';
  const fourth = renderDraft(changed);
  assert.notStrictEqual(fourth.digest, first.digest);
});

test('renderer 拒绝 facts 中未登记到 Base 插槽的 slot（提前失败，不靠 Composer 兜底）', () => {
  const facts = clone(FACTS);
  facts.slots.push('custom-slot');
  const pageFacts = clone(PAGE_FACTS);
  pageFacts.home.slots.push('custom-slot');
  const draft = buildDraft();
  draft.pages[0].nodes[1] = { type: 'slot', slotId: 'custom-slot' };
  // schema 层允许（事实里有），renderer 层必须拒绝（Base 无此插槽）。
  assert.strictEqual(schema.validateDraft(draft, facts, pageFacts).ok, true);
  const rendered = render.renderFrontendPack(draft, { facts, pageFacts });
  assert.strictEqual(rendered.ok, false);
  assert.strictEqual(rendered.code, 'RENDER_SLOT_UNSUPPORTED');
});

test('renderer 拒绝非法版本与非法候选 id', () => {
  const rendered = render.renderFrontendPack(buildDraft(), {
    facts: FACTS,
    pageFacts: PAGE_FACTS,
    version: '1.0',
  });
  assert.strictEqual(rendered.code, 'RENDER_VERSION_INVALID');

  const badId = render.renderFrontendPack(buildDraft(), {
    facts: FACTS,
    pageFacts: PAGE_FACTS,
    candidateId: '../escape',
  });
  assert.strictEqual(badId.ok, false);
  assert.strictEqual(badId.code, 'RENDER_CANDIDATE_ID_INVALID');
});
