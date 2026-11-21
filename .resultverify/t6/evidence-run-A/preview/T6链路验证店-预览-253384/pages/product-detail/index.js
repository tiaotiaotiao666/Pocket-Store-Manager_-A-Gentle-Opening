const config = require('../../config/env.js');
const money = require('../../domain/money.js');
const errorText = require('../../domain/errorText.js');
const platform = require('../../services/platform.js');
const storeService = require('../../services/store.js');
const visitStore = require('../../state/visit-store.js');
const cartStore = require('../../state/cart-store.js');

Page({
  data: {
    loading: true,
    error: '',
    errorAction: '',
    requestId: '',
    storeId: '',
    productId: '',
    product: null,
    amount: '',
    quantity: 0,
    cartSummary: { items: [], totalCents: 0, totalQuantity: 0 },
    cartVisible: false,
  },

  onLoad(options) {
    const input = options || {};
    const visit = visitStore.load();
    const storeId = input.storeId ? decodeURIComponent(input.storeId) : visit.storeId;
    const productId = input.productId ? decodeURIComponent(input.productId) : '';
    if (storeId !== visit.storeId) {
      visitStore.save(Object.assign({}, visit, { storeId, tableId: '', tableName: '' }));
    }
    this.setData({ storeId, productId });
    this.loadProduct();
  },

  onShow() {
    this.refreshCart();
  },

  onPullDownRefresh() {
    this.loadProduct(() => {
      if (typeof wx !== 'undefined' && wx.stopPullDownRefresh) wx.stopPullDownRefresh();
    });
  },

  async loadProduct(done) {
    this.setData({ loading: true, error: '' });
    try {
      const catalog = await storeService.getCatalog(this.data.storeId);
      let found = null;
      (catalog.categories || []).some((category) => {
        found = (category.products || []).find((product) => product.id === this.data.productId) || null;
        return Boolean(found);
      });
      if (!found) {
        this.setData({ loading: false, product: null, error: '这个商品目前不可见或已下架', errorAction: '重新加载' });
        return;
      }
      const product = Object.assign({}, found, {
        amount: money.formatAmount(found.priceCents),
        initial: (found.name || '好').slice(0, 1),
      });
      this.setData({ product, amount: product.amount, loading: false, error: '' });
      if (typeof wx !== 'undefined' && wx.setNavigationBarTitle) {
        wx.setNavigationBarTitle({ title: product.name || '商品详情' });
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
      if (typeof done === 'function') done();
    }
  },

  refreshCart() {
    if (!this.data.storeId) return;
    const cartSummary = cartStore.summary(this.data.storeId);
    this.setData({
      cartSummary,
      quantity: cartStore.quantityOf(this.data.storeId, this.data.productId),
    });
  },

  onAdd() {
    const product = this.data.product;
    if (!product) return;
    const result = cartStore.add(this.data.storeId, product);
    if (result.limited) platform.toast('每道菜最多 99 份');
    if (result.reason === 'UNAVAILABLE') platform.toast('该商品已停售');
    this.refreshCart();
  },

  onRemove() {
    cartStore.decrease(this.data.storeId, this.data.productId);
    this.refreshCart();
  },

  onExpandCart() {
    this.setData({ cartVisible: true });
  },

  onCloseCart() {
    this.setData({ cartVisible: false });
  },

  onCartAdd(event) {
    const product = this.data.cartSummary.items.find((item) => item.productId === event.detail.productId);
    if (product) cartStore.add(this.data.storeId, product);
    this.refreshCart();
  },

  onCartRemove(event) {
    cartStore.decrease(this.data.storeId, event.detail.productId);
    this.refreshCart();
  },

  onCheckout() {
    if (this.data.cartSummary.totalQuantity <= 0) {
      platform.toast('还没有选择菜品');
      return;
    }
    const visit = visitStore.load();
    if (visit.fulfillmentType === config.FULFILLMENT_TYPES.DINE_IN && !visit.tableId) {
      platform.toast('堂食需要桌号，请先选择桌号');
      return;
    }
    const url = '/pages/checkout/index?mode=' + encodeURIComponent(visit.fulfillmentType) +
      (visit.tableId ? '&tableId=' + encodeURIComponent(visit.tableId) : '');
    if (typeof wx !== 'undefined' && wx.navigateTo) wx.navigateTo({ url });
  },

  onRetry() {
    this.loadProduct();
  },
});
