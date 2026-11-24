/**
 * SourceFacts v2 快照模块（8 页源码事实/组件/Plan/page-contract）。
 * 由 scripts/agent-source-facts.cjs 从 Base/Catalog 确定性生成；请勿手改。
 * 更新：node scripts/agent-source-facts.cjs；校验：node scripts/agent-source-facts.cjs --check
 * 查看完整 JSON：node scripts/agent-source-facts.cjs --print
 * 8 页 / 15 组件 / 4 Plan
 */
import { SOURCE_FACTS_PAGE_HOME } from './source-facts.pages.home';
import { SOURCE_FACTS_PAGE_MENU } from './source-facts.pages.menu';
import { SOURCE_FACTS_PAGE_CHECKOUT } from './source-facts.pages.checkout';
import { SOURCE_FACTS_PAGE_ORDERS } from './source-facts.pages.orders';
import { SOURCE_FACTS_PAGE_ORDER_DETAIL } from './source-facts.pages.order-detail';
import { SOURCE_FACTS_PAGE_PRODUCT_DETAIL } from './source-facts.pages.product-detail';
import { SOURCE_FACTS_PAGE_MINE } from './source-facts.pages.mine';
import { SOURCE_FACTS_PAGE_MERCHANT_ORDERS } from './source-facts.pages.merchant-orders';
import { SOURCE_FACTS_COMPONENTS } from './source-facts.components';

export const SOURCE_FACTS_SNAPSHOT: unknown = {
  version: "source-facts.v2",
  base: {"id":"ordering-base","version":"1.0.0","root":"templates/base/ordering-base/1.0.0/src","manifest":"templates/base/ordering-base/1.0.0/manifest.json","catalogVersion":"2026.11.0","catalogBaseDigest":"sha256:df05a2625d343acf6d9936e55a27d63dbb8941783fc087fb6c20c0a22247303a","entryFiles":["templates/base/ordering-base/1.0.0/src/app.js","templates/base/ordering-base/1.0.0/src/app.json","templates/base/ordering-base/1.0.0/src/app.wxss","templates/base/ordering-base/1.0.0/src/sitemap.json","templates/base/ordering-base/1.0.0/src/project.config.json","templates/base/ordering-base/1.0.0/src/theme.generated.wxss"],"services":["templates/base/ordering-base/1.0.0/src/services/platform.js","templates/base/ordering-base/1.0.0/src/services/request-core.js","templates/base/ordering-base/1.0.0/src/services/request.js","templates/base/ordering-base/1.0.0/src/services/api-error.js","templates/base/ordering-base/1.0.0/src/services/store.js","templates/base/ordering-base/1.0.0/src/services/order.js","templates/base/ordering-base/1.0.0/src/services/auth.js","templates/base/ordering-base/1.0.0/src/services/session.js","templates/base/ordering-base/1.0.0/src/services/merchant.js"],"builtinComponents":["cart-bar","cart-panel","category-nav","error-banner","fulfillment-switch","loading-block","order-card","order-status","pay-result","product-card","product-detail","state-view","status-timeline","store-header"]},
  themeTokens: [{"key":"accentColor","cssVar":"--store-accent-color","type":"color","required":true,"contrastWith":"pageBackground"},{"key":"pageBackground","cssVar":"--store-page-background","type":"color","required":true},{"key":"primaryColor","cssVar":"--store-primary-color","type":"color","required":true,"contrastWith":"pageBackground"},{"key":"tabBarBackground","cssVar":"--store-tab-bar-background","type":"color","required":true},{"key":"tabBarColor","cssVar":"--store-tab-bar-color","type":"color","required":true},{"key":"tabBarSelectedColor","cssVar":"--store-tab-bar-selected-color","type":"color","required":true},{"key":"textColor","cssVar":"--store-text-color","type":"color","required":true,"contrastWith":"pageBackground"}],
  localAssets: [{"id":"assets/tabbar/home-active.png","path":"templates/base/ordering-base/1.0.0/src/assets/tabbar/home-active.png","bytes":1553,"kind":"png","usedBy":["tabBar:pages/home/index:selected"],"wxmlUsages":[]},{"id":"assets/tabbar/home.png","path":"templates/base/ordering-base/1.0.0/src/assets/tabbar/home.png","bytes":2779,"kind":"png","usedBy":["tabBar:pages/home/index:normal"],"wxmlUsages":[]},{"id":"assets/tabbar/menu-active.png","path":"templates/base/ordering-base/1.0.0/src/assets/tabbar/menu-active.png","bytes":1146,"kind":"png","usedBy":["tabBar:pages/menu/index:selected"],"wxmlUsages":[]},{"id":"assets/tabbar/menu.png","path":"templates/base/ordering-base/1.0.0/src/assets/tabbar/menu.png","bytes":1473,"kind":"png","usedBy":["tabBar:pages/menu/index:normal"],"wxmlUsages":[]},{"id":"assets/tabbar/mine-active.png","path":"templates/base/ordering-base/1.0.0/src/assets/tabbar/mine-active.png","bytes":2228,"kind":"png","usedBy":["tabBar:pages/mine/index:selected"],"wxmlUsages":[]},{"id":"assets/tabbar/mine.png","path":"templates/base/ordering-base/1.0.0/src/assets/tabbar/mine.png","bytes":3335,"kind":"png","usedBy":["tabBar:pages/mine/index:normal"],"wxmlUsages":[]},{"id":"assets/tabbar/orders-active.png","path":"templates/base/ordering-base/1.0.0/src/assets/tabbar/orders-active.png","bytes":1631,"kind":"png","usedBy":["tabBar:pages/orders/index:selected"],"wxmlUsages":[]},{"id":"assets/tabbar/orders.png","path":"templates/base/ordering-base/1.0.0/src/assets/tabbar/orders.png","bytes":2221,"kind":"png","usedBy":["tabBar:pages/orders/index:normal"],"wxmlUsages":[]}],
  components: SOURCE_FACTS_COMPONENTS,
  plans: [{"id":"order-classic-candidate","version":"0.1.0","features":[],"themeTokens":["accentColor","pageBackground","primaryColor","textColor"]},{"id":"order-classic","version":"1.0.0","features":[],"themeTokens":["accentColor","pageBackground","primaryColor","textColor"]},{"id":"order-poster","version":"1.0.0","features":[{"featureId":"poster-carousel","version":"1.0.0","pageId":"home","slotId":"home-hero","dataKey":"homeHero","planId":"order-poster","planVersion":"1.0.0"}],"themeTokens":["accentColor","pageBackground","primaryColor","textColor"]},{"id":"order-warm-home","version":"1.0.0","features":[],"themeTokens":["accentColor","pageBackground","primaryColor","textColor"]}],
  checkIds: [{"id":"source.check","scope":"page","description":"WXML/WXSS/JS/JSON 共享静态检查（scripts/frontend-source）"},{"id":"mini.check","scope":"page","description":"小程序镜像/结构校验（scripts/validate-miniprogram.cjs）"},{"id":"composer.dry-run","scope":"page","description":"Composer dry-run 与导出一致性"},{"id":"output.consistency","scope":"page","description":"导出产物一致性校验"},{"id":"unit.targeted","scope":"project","description":"定向 Node 测试"},{"id":"unit.full","scope":"project","description":"全量 Node 测试"},{"id":"desktop.contract","scope":"project","description":"桌面契约测试"},{"id":"catalog.check","scope":"project","description":"Catalog 同源校验"},{"id":"registry.check","scope":"project","description":"Registry 同源校验"},{"id":"wechat.verify","scope":"page","description":"固定包装真实微信开发者工具（不可用 → BLOCKED）"}],
  metadataGaps: [{"code":"SLOT_METADATA_MISSING","pageId":"menu","detail":"menu-hero 只在 manifest/WXML 声明，slots.json 缺少条目"}],
  pages: {
    "home": SOURCE_FACTS_PAGE_HOME,
    "menu": SOURCE_FACTS_PAGE_MENU,
    "checkout": SOURCE_FACTS_PAGE_CHECKOUT,
    "orders": SOURCE_FACTS_PAGE_ORDERS,
    "order-detail": SOURCE_FACTS_PAGE_ORDER_DETAIL,
    "product-detail": SOURCE_FACTS_PAGE_PRODUCT_DETAIL,
    "mine": SOURCE_FACTS_PAGE_MINE,
    "merchant-orders": SOURCE_FACTS_PAGE_MERCHANT_ORDERS,
  },
  digest: "sha256:af14a36f069a6ee623e5d8575bd2c5944cc80e3b7472c7e69a2aac159ea0d22e",
};

export default SOURCE_FACTS_SNAPSHOT;
