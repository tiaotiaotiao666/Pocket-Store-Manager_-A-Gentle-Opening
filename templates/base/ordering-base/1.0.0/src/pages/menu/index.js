const config = require('../../config/env.js');
const errorText = require('../../domain/errorText.js');
const platform = require('../../services/platform.js');
const storeService = require('../../services/store.js');
const visitStore = require('../../state/visit-store.js');
const cartStore = require('../../state/cart-store.js');
const slotProps = require('../../config/slots.generated.js');
const extensions = require('./extensions.generated.js');

Page({
  data: {
    loading: true,
    error: '',
    errorAction: '',
    requestId: '',
    store: null,
    visit: null,
    mode: config.FULFILLMENT_TYPES.TAKEAWAY,
    tableName: '',
    storeId: '',
    categories: [],
    activeCategoryId: '',
    activeCategoryName: '',
    products: [],
    cartSummary: {
      items: [],
      totalCents: 0,
      totalQuantity: 0,
    },
    quantityMap: {},
    cartVisible: false,
    detailVisible: false,
    detailProduct: {},
    detailQuantity: 0,
    tableOptions: config.DEMO_TABLES,
    slotProps,
  },

  onLoad() {
    this.catalog = null;
    this.productsById = {};
    if (extensions && typeof extensions.onLoad === 'function') {
      extensions.onLoad(this);
    }
    this.loadCatalog();
  },

  onShow() {
    const visit = visitStore.load();
    if (this.data.storeId && visit.storeId !== this.data.storeId) {
      this.setData({ visit });
      this.loadCatalog();
      return;
    }
    this.setData({
      visit,
      mode: visit.fulfillmentType,
      tableName: visit.tableName,
      storeId: visit.storeId,
    });
    this.refreshCart();
  },

  onPullDownRefresh() {
    this.loadCatalog(() => {
      if (typeof wx !== 'undefined' && wx.stopPullDownRefresh) {
        wx.stopPullDownRefresh();
      }
    });
  },

  async loadCatalog(done) {
    const visit = visitStore.load();
    this.setData({ loading: true, error: '', storeId: visit.storeId, visit });
    try {
      const store = await storeService.getStore(visit.storeId);
      const catalog = await storeService.getCatalog(visit.storeId);
      const nextVisit = visitStore.applyStore(store);

      this.catalog = catalog;
      this.productsById = {};
      catalog.categories.forEach((category) => {
        (category.products || []).forEach((product) => {
          this.productsById[product.id] = product;
        });
      });

      cartStore.applyCatalog(visit.storeId, catalog);

      const categories = catalog.categories
        .filter((category) => Array.isArray(category.products) && category.products.length > 0)
        .map((category) => ({ id: category.id, name: category.name }));

      let activeCategoryId = this.data.activeCategoryId;
      if (!categories.some((category) => category.id === activeCategoryId)) {
        activeCategoryId = categories.length > 0 ? categories[0].id : '';
      }

      this.setData({
        store,
        visit: nextVisit,
        mode: nextVisit.fulfillmentType,
        tableName: nextVisit.tableName,
        categories,
        activeCategoryId,
        activeCategoryName: this.findCategoryName(categories, activeCategoryId),
        products: this.collectProducts(activeCategoryId),
        loading: false,
      });

      if (typeof wx !== 'undefined' && wx.setNavigationBarTitle) {
        wx.setNavigationBarTitle({ title: store.name });
      }
      this.refreshCart();
    } catch (error) {
      const described = errorText.describeError(error);
      this.setData({
        loading: false,
        error: described.message,
        errorAction: described.action || '重新加载',
        requestId: described.requestId,
      });
    } finally {
      if (typeof done === 'function') {
        done();
      }
    }
  },

  findCategoryName(categories, categoryId) {
    const matched = categories.filter((category) => category.id === categoryId)[0];
    return matched ? matched.name : '';
  },

  collectProducts(categoryId) {
    if (!this.catalog) {
      return [];
    }
    const matched = this.catalog.categories.filter((category) => category.id === categoryId)[0];
    return matched && Array.isArray(matched.products) ? matched.products : [];
  },

  refreshCart() {
    const storeId = this.data.storeId || visitStore.load().storeId;
    const summary = cartStore.summary(storeId);
    const quantityMap = {};
    summary.items.forEach((item) => {
      quantityMap[item.productId] = item.quantity;
    });
    this.setData({ cartSummary: summary, quantityMap });
    if (this.data.detailProduct && this.data.detailProduct.id) {
      this.setData({ detailQuantity: quantityMap[this.data.detailProduct.id] || 0 });
    }
  },

  onModeChange(event) {
    const next = visitStore.setFulfillment(event.detail.value);
    this.setData({ visit: next, mode: next.fulfillmentType });
    if (next.fulfillmentType === config.FULFILLMENT_TYPES.DINE_IN && !next.tableId) {
      platform.toast('堂食需要桌号，请选择下方演示桌号');
    }
  },

  onPickTable(event) {
    const next = visitStore.setTable(event.currentTarget.dataset.id, event.currentTarget.dataset.name);
    this.setData({ visit: next, mode: next.fulfillmentType, tableName: next.tableName });
    platform.toast('已选择 ' + next.tableName + ' 桌（演示）');
  },

  onSelectCategory(event) {
    const categoryId = event.detail.id;
    const products = this.collectProducts(categoryId);
    this.setData({
      activeCategoryId: categoryId,
      activeCategoryName: this.findCategoryName(this.data.categories, categoryId),
      products,
    });
  },

  onProductAdd(event) {
    const productId = event.detail.productId;
    this.addProduct(productId);
  },

  onProductRemove(event) {
    const productId = event.detail.productId;
    this.removeProduct(productId);
  },

  onOpenDetail(event) {
    const productId = event.detail.productId;
    const product = this.productsById[productId];
    if (!product) {
      return;
    }
    this.setData({
      detailVisible: true,
      detailProduct: product,
      detailQuantity: this.data.quantityMap[productId] || 0,
    });
  },

  onDetailAdd(event) {
    this.addProduct(event.detail.productId);
  },

  onDetailRemove(event) {
    this.removeProduct(event.detail.productId);
  },

  onDetailClose() {
    this.setData({ detailVisible: false });
  },

  onPanelAdd(event) {
    this.addProduct(event.detail.productId);
  },

  onPanelRemove(event) {
    this.removeProduct(event.detail.productId);
  },

  onPanelClose() {
    this.setData({ cartVisible: false });
  },

  addProduct(productId) {
    const product = this.productsById[productId];
    if (!product) {
      platform.toast('商品已下架，请刷新菜单');
      return;
    }
    const result = cartStore.add(this.data.storeId, product);
    if (result.limited) {
      platform.toast('每道菜最多 99 份');
    }
    if (result.reason === 'UNAVAILABLE') {
      platform.toast('该商品已停售');
    }
    this.refreshCart();
  },

  removeProduct(productId) {
    cartStore.decrease(this.data.storeId, productId);
    this.refreshCart();
  },

  onExpandCart() {
    this.setData({ cartVisible: true });
  },

  onCheckout() {
    const visit = this.data.visit || visitStore.load();
    if (this.data.cartSummary.totalQuantity <= 0) {
      platform.toast('还没有选择菜品');
      return;
    }
    if (visit.fulfillmentType === config.FULFILLMENT_TYPES.DINE_IN && !visit.tableId) {
      platform.toast('堂食需要桌号，请先选择演示桌号');
      return;
    }
    const url =
      '/pages/checkout/index?mode=' +
      encodeURIComponent(visit.fulfillmentType) +
      (visit.tableId ? '&tableId=' + encodeURIComponent(visit.tableId) : '');
    if (typeof wx !== 'undefined' && wx.navigateTo) {
      wx.navigateTo({ url });
    }
  },

  onRetry() {
    this.loadCatalog();
  },
});