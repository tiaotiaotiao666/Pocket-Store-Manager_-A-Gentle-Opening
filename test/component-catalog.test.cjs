'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const CATALOG = path.join(REPO, 'templates', 'catalog');
const BASE_DIR = path.join(REPO, 'templates', 'base', 'ordering-base', '1.0.0');
const BASE_SRC = path.join(BASE_DIR, 'src');
const SCHEMA_FILE = path.join(REPO, 'templates', 'registry', 'schema', 'component-catalog.v1.json');

const { treeSha256, walk } = require(path.join(REPO, 'scripts', 'composer', 'digest.cjs'));
const { collectComponentDefinition, normalizePropertyType } = require(path.join(REPO, 'scripts', 'composer', 'manifest-impl-check.cjs'));

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readCatalog(relative) {
  return readJson(path.join(CATALOG, relative));
}

function assertInsideRepo(relative) {
  const resolved = path.resolve(REPO, relative);
  assert.ok(resolved === REPO || resolved.startsWith(REPO + path.sep), 'catalog 路径逃逸：' + relative);
  return resolved;
}

function jsonFilesUnder(dir) {
  return walk(dir).filter((file) => file.endsWith('.json'));
}

test('组件目录必须与源码同源：--check 退出码为 0', () => {
  assert.doesNotThrow(() => {
    execFileSync(process.execPath, ['scripts/component-catalog.cjs', '--check'], {
      cwd: REPO,
      encoding: 'utf8',
    });
  });
});

test('目录索引：15 个组件、8 个页面、1 个布局，且覆盖 5 个分类', () => {
  const index = readCatalog('index.json');
  assert.equal(index.schemaVersion, 'component-catalog.v1');
  assert.equal(index.catalogVersion, '2026.11.0');
  assert.deepEqual(index.counts, {
    components: 15,
    baseBuiltins: 14,
    registryUiBlocks: 3,
    featureComponents: 1,
    pages: 8,
    layouts: 1,
    sections: 61,
    errors: 0,
    warnings: 1,
  });
  assert.equal(index.categories.length, 5);
  assert.equal(index.components.length, 15);
  assert.equal(index.pages.length, 8);
  assert.equal(index.layouts.length, 1);
  assert.deepEqual(
    index.sections.map((page) => [page.layout.id, page.pageId, page.count]),
    [
      ['warm-home-menu', 'home', 12],
      ['warm-home-menu', 'menu', 11],
      ['ordering-base', 'checkout', 6],
      ['ordering-base', 'merchant-orders', 10],
      ['ordering-base', 'mine', 6],
      ['ordering-base', 'order-detail', 7],
      ['ordering-base', 'orders', 4],
      ['ordering-base', 'product-detail', 5],
    ],
  );
  assert.ok(index.readOrder.some((line) => line.includes('--check')));
  assert.deepEqual(index.gaps.map((gap) => gap.code), ['BASE_SLOTS_DOC_GAP']);
  assert.equal(index.gaps[0].severity, 'warning');
});

test('每个组件卡与源码双向一致：props、events、类型、payload、摘要', () => {
  const index = readCatalog('index.json');
  const schema = readJson(SCHEMA_FILE);
  index.components.forEach((entry) => {
    const card = readCatalog(entry.card);
    schema.componentRequired.forEach((key) => {
      assert.ok(Object.prototype.hasOwnProperty.call(card, key), entry.id + ' 缺少字段 ' + key);
    });
    assert.equal(card.schemaVersion, 'component-catalog-entry.v1');
    assert.equal(card.id, entry.id);
    assert.equal(card.version, entry.version);
    assert.ok(card.summary.length > 0, entry.id + ' 缺少 summary');
    assert.ok(['base-builtin', 'registry-ui-block', 'feature-pack'].includes(card.sourceKind));
    assert.ok(['base-page-fixed', 'registry-validation', 'slot-injection'].includes(card.runtime.mode));

    const sourceRoot = assertInsideRepo(card.source.root);
    card.source.files.forEach((file) => {
      assert.ok(fs.existsSync(path.join(sourceRoot, file)), entry.id + ' 入口缺失：' + file);
    });
    assert.equal(card.source.digest, treeSha256(sourceRoot), entry.id + ' 摘要漂移');

    const collected = collectComponentDefinition(path.join(sourceRoot, 'index.js'));
    assert.ok(collected.definition, entry.id + ' 未注册 Component');
    assert.equal(collected.sideEffects.length, 0, entry.id + ' 存在顶层副作用');

    const actualProps = Object.keys(collected.definition.properties || {}).sort();
    const cardProps = card.interface.props.map((prop) => prop.name).sort();
    assert.deepEqual(cardProps, actualProps, entry.id + ' props 不一致');

    const actualEvents = [...collected.events].sort();
    const cardEvents = card.interface.events.map((event) => event.name).sort();
    assert.deepEqual(cardEvents, actualEvents, entry.id + ' events 不一致');

    card.interface.props.forEach((prop) => {
      assert.ok(prop.type !== 'unknown', entry.id + '.' + prop.name + ' 类型无法识别');
      assert.equal(
        normalizePropertyType(collected.definition.properties[prop.name]),
        prop.type,
        entry.id + '.' + prop.name + ' 类型不一致',
      );
      assert.ok(Object.prototype.hasOwnProperty.call(prop, 'defaultValue'));
    });
    card.interface.events.forEach((event) => {
      assert.ok(Array.isArray(event.payload), entry.id + '.' + event.name + ' payload 必须是数组');
      assert.ok(event.description.length > 0, entry.id + '.' + event.name + ' 缺少描述');
    });
  });
});

test('关键事件 payload 与实现一致：product-card.add / poster-carousel.select', () => {
  const productCard = readCatalog('components/product-card.json');
  const add = productCard.interface.events.find((event) => event.name === 'add');
  assert.deepEqual(add.payload, ['productId']);

  const poster = readCatalog('components/poster-carousel.json');
  const select = poster.interface.events.find((event) => event.name === 'select');
  assert.deepEqual(select.payload, ['index', 'title', 'posterId', 'productId']);
  assert.equal(poster.runtime.mode, 'slot-injection');
  assert.deepEqual(poster.slots, ['home-hero']);
});

test('页面装配卡：8 页组件引用闭合、插槽锚点完整、控制器方法可读', () => {
  const index = readCatalog('index.json');
  const known = new Set(index.components.map((component) => component.id));
  index.pages.forEach((entry) => {
    const card = readCatalog(entry.card);
    assert.equal(card.schemaVersion, 'page-catalog-entry.v1');
    assert.equal(card.pageId, entry.pageId);
    card.components.forEach((component) => {
      assert.ok(known.has(component.componentId), card.pageId + ' 引用了未知组件：' + component.componentId);
      assert.ok(['always', 'conditional', 'modal', 'declared-only'].includes(component.mode));
    });
    card.slots.forEach((slot) => {
      assert.equal(slot.anchorsPresent, true, card.pageId + ' 插槽锚点不完整：' + slot.slotId);
      assert.deepEqual(slot.anchorCounts, [1, 1, 1, 1]);
    });
    assert.ok(Array.isArray(card.controller.methods));
    assert.ok(Array.isArray(card.controller.lifecycle));
    assert.ok(card.controller.dataKeys.length > 0, card.pageId + ' 缺少页面数据键');
    assert.deepEqual(
      Object.keys(card.pageJson.usingComponents).sort(),
      card.components.map((component) => component.tag).sort(),
    );
  });

  const menu = readCatalog('pages/menu.json');
  ['onCheckout', 'onModeChange', 'onOpenDetail', 'onProductAdd'].forEach((method) => {
    assert.ok(menu.controller.methods.includes(method), 'menu 缺少控制器方法 ' + method);
  });
  ['onLoad', 'onShow', 'onPullDownRefresh'].forEach((method) => {
    assert.ok(menu.controller.lifecycle.includes(method), 'menu 缺少生命周期 ' + method);
  });
  const loading = menu.components.find((component) => component.componentId === 'loading-block');
  assert.equal(loading.mode, 'declared-only');
  assert.ok(menu.notes.some((note) => note.includes('Composer 导出时会过滤')));
  assert.equal(menu.slots.find((slot) => slot.slotId === 'menu-hero').dataKey, 'menuHero');
});

test('视图包布局卡：首页/菜单页区块层级、组件归属与插槽归属正确', () => {
  const card = readCatalog('layouts/warm-home-menu@1.0.0.json');
  assert.equal(card.schemaVersion, 'layout-catalog-entry.v1');
  assert.deepEqual(card.pages.map((page) => page.pageId), ['home', 'menu']);
  assert.deepEqual(card.requiresSlots, ['home-hero', 'home-marketing', 'menu-hero', 'menu-aside']);
  assert.equal(new Set(card.constraints).size, card.constraints.length, 'constraints 不应重复');

  const home = card.pages[0];
  const hero = home.blocks.find((block) => block.className === 'fp-home__hero');
  assert.ok(hero);
  assert.equal(hero.depth, 2);
  assert.equal(hero.parentClass, 'fp-home');
  assert.deepEqual(hero.components, ['store-header']);
  assert.deepEqual(hero.slots, ['home-hero']);
  const marketing = home.blocks.find((block) => block.className === 'fp-home__marketing');
  assert.deepEqual(marketing.slots, ['home-marketing']);
  const section = home.blocks.find((block) => block.className === 'fp-home__section');
  assert.ok(section.components.includes('fulfillment-switch'));

  const menu = card.pages[1];
  const top = menu.blocks.find((block) => block.className === 'fp-menu__top');
  assert.ok(top.components.includes('store-header'));
  const product = menu.blocks.find((block) => block.className === 'fp-menu__product');
  assert.ok(product.components.includes('product-card'));
  const body = menu.blocks.find((block) => block.className === 'fp-menu__body');
  assert.deepEqual(body.slots, ['menu-hero', 'menu-aside']);
  card.pages.forEach((page) => {
    page.slots.forEach((slot) => assert.equal(slot.anchorsPresent, true));
  });
});

test('区块目录：61 个可复用区块，定位、片段、组件与控制器闭合', () => {
  const index = readCatalog('index.json');
  const known = new Set(index.components.map((component) => component.id));
  const allowedSlots = new Set(['home-hero', 'home-marketing', 'menu-hero', 'menu-aside']);
  const allowedLevels = new Set(['direct-wxml', 'base-component-use', 'slot-only', 'promote-to-ui-block']);
  let total = 0;

  index.sections.forEach((pageEntry) => {
    const pageIndex = readCatalog(pageEntry.index);
    assert.equal(pageIndex.schemaVersion, 'section-page-index.v1');
    assert.equal(pageIndex.counts.sections, pageEntry.count);
    assert.equal(pageIndex.sections.length, pageEntry.count);
    pageIndex.sections.forEach((entry) => {
      const card = readCatalog(
        'sections/' + pageEntry.layout.id + '@' + pageEntry.layout.version + '/' + pageEntry.pageId + '/' + entry.card,
      );
      total += 1;
      assert.equal(card.schemaVersion, 'section-catalog-entry.v1');
      assert.equal(card.id, entry.id);
      assert.equal(card.layout.id, pageEntry.layout.id);
      assert.equal(card.layout.version, pageEntry.layout.version);
      assert.equal(card.pageId, pageEntry.pageId);
      assert.ok(card.summary.length > 0, card.id + ' 缺少 summary');
      assert.ok(card.locator.selector || card.locator.componentTag || card.locator.slotId, card.id + ' 缺少定位信息');
      assert.ok(card.template.snippets.length >= 1, card.id + ' 缺少 WXML 片段');
      card.template.snippets.forEach((snippet) => {
        assert.ok(snippet.code.trim().length > 0, card.id + ' 片段为空');
        assert.ok(snippet.lineStart >= 1 && snippet.lineEnd >= snippet.lineStart);
      });
      card.components.forEach((component) => {
        assert.ok(known.has(component.tag), card.id + ' 引用未知组件：' + component.tag);
      });
      card.slots.forEach((slotId) => assert.ok(allowedSlots.has(slotId), card.id + ' 引用未知插槽：' + slotId));
      assert.ok(allowedLevels.has(card.reuse.level), card.id + ' reuse.level 非法');
      if (card.reuse.level === 'promote-to-ui-block') {
        assert.ok(card.reuse.uiBlockBlueprint, card.id + ' 缺少 uiBlockBlueprint');
      }
      assert.equal(card.controller.verified, true, card.id + ' 控制器处理函数未验证');
      assert.deepEqual(card.controller.missing, []);
      assert.equal(card.source.digest, card.verify.digest);
      assert.equal(card.styles.selectorCount, card.styles.selectors.length);
    });
  });
  assert.equal(total, 61);

  const hero = readCatalog('sections/warm-home-menu@1.0.0/home/home-hero.json');
  assert.deepEqual(hero.slots, ['home-hero']);
  assert.deepEqual(hero.components.map((component) => component.tag), ['store-header']);
  assert.equal(hero.reuse.level, 'slot-only');

  const brand = readCatalog('sections/warm-home-menu@1.0.0/home/home-brand-head.json');
  assert.equal(brand.reuse.level, 'promote-to-ui-block');
  assert.equal(brand.reuse.uiBlockBlueprint.suggestedId, 'brand-head');
  assert.ok(brand.reuse.uiBlockBlueprint.promotionSteps.length > 0);

  const products = readCatalog('sections/warm-home-menu@1.0.0/menu/menu-products.json');
  assert.ok(products.components.some((component) => component.tag === 'product-card'));
  assert.ok(products.controller.handlers.includes('onProductAdd'));

  // 回归：属性值里的 `>` 不能被当成标签结束。曾因此截断 WXML，漏掉 fp-home__notice 与 fp-home__orders 两个区块。
  const pending = readCatalog('sections/warm-home-menu@1.0.0/home/home-pending-notice.json');
  assert.ok(pending.template.snippets[0].code.includes('pendingPaymentCount > 0'));
  assert.deepEqual(pending.bindings.handlers, [{ type: 'tap', handler: 'goOrders' }]);
  assert.equal(pending.controller.verified, true);

  const activeOrders = readCatalog('sections/warm-home-menu@1.0.0/home/home-active-orders.json');
  assert.ok(activeOrders.components.some((component) => component.tag === 'order-card'));
  assert.ok(activeOrders.locator.selector === 'fp-home__orders');

  // Base 页区块（pageSource=base-page）：产品页购物车条按 componentTag 定位，控制器来自 Base 页面
  const cartBar = readCatalog('sections/ordering-base@1.0.0/product-detail/product-cart-bar.json');
  assert.equal(cartBar.pageSource, 'base-page');
  assert.equal(cartBar.locator.componentTag, 'cart-bar');
  assert.equal(cartBar.locator.occurrence, 1);
  assert.deepEqual(cartBar.controller.handlers, ['onCheckout', 'onExpandCart']);

  // 多 occurrence 的 selector 必须单点定位：checkout__card 三张卡分别落到不同区块
  const meal = readCatalog('sections/ordering-base@1.0.0/checkout/checkout-meal-card.json');
  const items = readCatalog('sections/ordering-base@1.0.0/checkout/checkout-items-card.json');
  const note = readCatalog('sections/ordering-base@1.0.0/checkout/checkout-note-card.json');
  assert.deepEqual([meal.locator.occurrence, items.locator.occurrence, note.locator.occurrence], [1, 2, 3]);
  assert.ok(items.source.lineStart > meal.source.lineEnd && note.source.lineStart > items.source.lineEnd);

  // promote 级 Base 区块必须给出提升蓝图（曾因把 blueprint 写成 reuse 的兄弟字段而为 null）
  assert.equal(items.reuse.level, 'promote-to-ui-block');
  assert.equal(items.reuse.uiBlockBlueprint.suggestedId, 'checkout-items');
  const quickLinks = readCatalog('sections/ordering-base@1.0.0/mine/mine-quick-links.json');
  assert.equal(quickLinks.reuse.uiBlockBlueprint.suggestedId, 'quick-links');

  // Base 区块共 38 个
  assert.equal(
    index.sections
      .filter((page) => page.layout.id === 'ordering-base')
      .reduce((sum, page) => sum + page.count, 0),
    38,
  );
});

test('人工知识层覆盖全部组件、页面与布局', () => {
  const curation = readCatalog('curation.v1.json');
  const index = readCatalog('index.json');
  assert.equal(curation.schemaVersion, 'component-curation.v1');
  index.components.forEach((component) => {
    const item = curation.components[component.id];
    assert.ok(item, 'curation 缺少组件：' + component.id);
    assert.equal(item.displayName, component.displayName);
    assert.ok(item.summary.length > 0);
    assert.ok(item.whenToUse.length > 0);
  });
  index.pages.forEach((page) => {
    assert.ok(curation.pages[page.pageId], 'curation 缺少页面：' + page.pageId);
    assert.ok(curation.pages[page.pageId].summary.length > 0);
  });
  index.layouts.forEach((layout) => {
    assert.ok(curation.layouts[layout.id + '@' + layout.version], 'curation 缺少布局：' + layout.id);
  });
});

test('Base Manifest 组件清单与磁盘一致，pay-result 已补齐', () => {
  const manifest = readJson(path.join(BASE_DIR, 'manifest.json'));
  const disk = fs.readdirSync(path.join(BASE_SRC, 'components'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual([...manifest.builtinComponents].sort(), disk);
  assert.equal(disk.length, 14);
  assert.ok(manifest.builtinComponents.includes('pay-result'));
});

test('已登记 UI Block 与 Base 同名组件逐字节一致', () => {
  const index = readCatalog('index.json');
  ['store-header', 'product-card', 'cart-bar'].forEach((id) => {
    const card = readCatalog('components/' + id + '.json');
    assert.ok(card.source.registryAsset, id + ' 缺少 registryAsset');
    assert.equal(card.source.registryAsset.id, id);
    assert.ok(card.source.registryMirror, id + ' 缺少镜像信息');
    assert.equal(card.source.registryMirror.sameImplementation, true, id + ' 与 Base 实现不一致');
    card.source.registryMirror.comparisons.forEach((item) => assert.equal(item.same, true, id + '/' + item.file));
  });
  assert.ok(index.counts.registryUiBlocks === 3);
});

test('目录生成物不得包含绝对路径、外链或密钥', () => {
  const files = jsonFilesUnder(CATALOG);
  assert.ok(files.length >= 25);
  files.forEach((file) => {
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(!/[A-Za-z]:\\\\/.test(text), file + ' 含盘符路径');
    assert.ok(!/https?:\/\//i.test(text), file + ' 含外部 URL');
    assert.ok(!/sk-[A-Za-z0-9]{10,}/.test(text), file + ' 含疑似密钥');
  });
});