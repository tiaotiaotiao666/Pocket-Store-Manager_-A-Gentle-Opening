const config = require('../../config/env.js');
const idempotency = require('../../domain/idempotency.js');
const money = require('../../domain/money.js');
const errorText = require('../../domain/errorText.js');
const platform = require('../../services/platform.js');
const storeService = require('../../services/store.js');
const orderService = require('../../services/order.js');
const auth = require('../../services/auth.js');
const session = require('../../services/session.js');
const visitStore = require('../../state/visit-store.js');
const cartStore = require('../../state/cart-store.js');

Page({
  data: {
    loading: true,
    store: null,
    visit: null,
    mode: config.FULFILLMENT_TYPES.TAKEAWAY,
    modeText: '到店自取',
    tableName: '',
    tableOptions: config.DEMO_TABLES,
    items: [],
    totalCents: 0,
    totalQuantity: 0,
    totalText: '¥0.00',
    note: '',
    noteLength: 0,
    submitting: false,
    emptyCart: false,
    loggedIn: false,
    identityLabel: '未登录',
    error: '',
    errorAction: '',
    requestId: '',
    payHint: '提交后进入订单详情，再点击「演示模拟支付」，本流程不产生真实支付。',
  },

  onLoad(options) {
    this.idempotencyKey = '';
    this.lastSubmittedSignature = '';
    const visit = visitStore.load();
    const input = options || {};
    const mode = input.mode === config.FULFILLMENT_TYPES.DINE_IN ? config.FULFILLMENT_TYPES.DINE_IN : visit.fulfillmentType;
    const tableId = input.tableId || visit.tableId;
    this.setData({
      visit: Object.assign({}, visit, { tableId, fulfillmentType: mode }),
      mode,
      modeText: config.FULFILLMENT_TEXT[mode] || '到店自取',
      tableName: visit.tableId === tableId ? visit.tableName : visitStore.resolveTableName(tableId),
    });
    this.loadStore();
    this.refreshCart();
    this.ensureLogin();
  },

  onShow() {
    this.refreshCart();
  },

  async loadStore() {
    const visit = visitStore.load();
    try {
      const store = await storeService.getStore(visit.storeId);
      const nextVisit = visitStore.applyStore(store);
      this.setData({ store, visit: Object.assign({}, nextVisit, { tableId: this.data.visit.tableId }) });
    } catch (error) {
      this.setData({ store: { name: '门店' } });
    }
  },

  async ensureLogin() {
    try {
      const user = await auth.ensureLogin();
      this.setData({
        loggedIn: Boolean(user && user.id),
        identityLabel: auth.currentIdentity().label,
      });
    } catch (error) {
      const described = errorText.describeError(error);
      this.setData({
        loggedIn: false,
        identityLabel: '未登录',
        error: described.message,
        errorAction: '重新登录',
        requestId: described.requestId,
      });
    } finally {
      this.setData({ loading: false });
    }
  },

  refreshCart() {
    const visit = this.data.visit || visitStore.load();
    const summary = cartStore.summary(visit.storeId);
    const items = summary.items.map((item) => ({
      productId: item.productId,
      name: item.name,
      quantity: item.quantity,
      unitPriceText: money.formatCents(item.unitPriceCents),
      lineTotalText: money.formatCents(item.lineTotalCents),
    }));
    this.setData({
      items,
      totalCents: summary.totalCents,
      totalQuantity: summary.totalQuantity,
      totalText: money.formatCents(summary.totalCents),
      emptyCart: items.length === 0,
    });
  },

  onNoteInput(event) {
    const note = String(event.detail.value || '').slice(0, 50);
    this.setData({ note, noteLength: note.length });
  },

  onPickTable(event) {
    const next = visitStore.setTable(event.currentTarget.dataset.id, event.currentTarget.dataset.name);
    this.setData({
      visit: next,
      mode: next.fulfillmentType,
      modeText: config.FULFILLMENT_TEXT[next.fulfillmentType] || '',
      tableName: next.tableName,
    });
  },

  onSubmit() {
    this.submitOrder();
  },

  async submitOrder() {
    if (this.data.submitting) {
      return;
    }
    const visit = this.data.visit || visitStore.load();
    if (this.data.emptyCart || this.data.items.length === 0) {
      platform.toast('购物车是空的，请先选择菜品');
      return;
    }
    if (this.data.mode === config.FULFILLMENT_TYPES.DINE_IN && !visit.tableId) {
      this.setData({ error: '堂食订单需要桌号，请扫描桌码或选择演示桌号', errorAction: '选择桌号', requestId: '' });
      return;
    }

    this.setData({ submitting: true, error: '', errorAction: '', requestId: '' });

    try {
      if (!this.data.loggedIn) {
        await this.ensureLogin();
      }
      const payload = {
        storeId: visit.storeId,
        fulfillmentType: this.data.mode,
        tableId: this.data.mode === config.FULFILLMENT_TYPES.DINE_IN ? visit.tableId : '',
        items: this.data.items.map((item) => ({ productId: item.productId, quantity: item.quantity })),
        note: this.data.note,
      };
      const signature = JSON.stringify(payload);
      if (!this.idempotencyKey || signature !== this.lastSubmittedSignature) {
        this.idempotencyKey = idempotency.createIdempotencyKey(Date.now(), Math.random);
        this.lastSubmittedSignature = signature;
      }

      const order = await orderService.createOrder(payload, this.idempotencyKey);
      cartStore.clear(visit.storeId);
      this.idempotencyKey = '';
      this.lastSubmittedSignature = '';
      this.setData({ submitting: false });
      if (typeof wx !== 'undefined' && wx.redirectTo) {
        wx.redirectTo({ url: '/pages/order-detail/index?id=' + encodeURIComponent(order.id) + '&pay=1' });
      }
    } catch (error) {
      await this.handleSubmitError(error);
    }
  },

  async handleSubmitError(error) {
    const described = errorText.describeError(error);
    const patch = {
      submitting: false,
      error: described.message,
      errorAction: described.action || '',
      requestId: described.requestId,
    };

    if (errorText.isCatalogError(described.code)) {
      try {
        const visit = this.data.visit || visitStore.load();
        const catalog = await storeService.getCatalog(visit.storeId);
        const merged = cartStore.applyCatalog(visit.storeId, catalog);
        patch.error = merged.removed.length
          ? '有 ' + merged.removed.length + ' 个商品已停售并被移除，请确认后重新提交'
          : described.message;
        patch.errorAction = '刷新菜单';
      } catch (refreshError) {
        patch.error = described.message;
      }
      this.refreshCart();
    }

    if (errorText.isAuthError(described.code)) {
      patch.loggedIn = false;
      patch.identityLabel = '未登录';
      patch.errorAction = '重新登录';
    }

    this.setData(patch);
  },

  onRetry() {
    const action = this.data.errorAction;
    if (action === '重新登录') {
      this.ensureLogin();
      return;
    }
    if (action === '刷新菜单' || action === '选择桌号') {
      this.refreshCart();
      this.setData({ error: '' });
      return;
    }
    this.submitOrder();
  },

  onCloseError() {
    this.setData({ error: '', errorAction: '', requestId: '' });
  },

  goMenu() {
    if (typeof wx !== 'undefined' && wx.switchTab) {
      wx.switchTab({ url: '/pages/menu/index' });
    }
  },
});