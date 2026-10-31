const config = require('../../config/env.js');
const scene = require('../../domain/scene.js');
const orderStatus = require('../../domain/orderStatus.js');
const orderView = require('../../domain/orderView.js');
const errorText = require('../../domain/errorText.js');
const platform = require('../../services/platform.js');
const storeService = require('../../services/store.js');
const orderService = require('../../services/order.js');
const auth = require('../../services/auth.js');
const session = require('../../services/session.js');
const visitStore = require('../../state/visit-store.js');
const versionGuard = require('../../domain/versionGuard.js');
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
    tableOptions: config.DEMO_TABLES,
    activeOrders: [],
    pendingPaymentCount: 0,
    identityLabel: '未登录',
    merchantStoreId: '',
    demoMode: !config.USE_WECHAT_CODE_LOGIN,
    demoHint: '',
    versionNotice: '',
    slotProps,
  },

  onLoad(options) {
    const entry = scene.resolveEntry(options || {}, config.DEFAULT_STORE_ID);
    const visit = visitStore.applyEntry(entry);
    this.setData({
      visit,
      mode: visit.fulfillmentType,
      tableName: visit.tableName,
      demoHint: entry.fromScene ? '已识别扫码进入的门店' : '',
    });
    if (extensions && typeof extensions.onLoad === 'function') {
      extensions.onLoad(this);
    }
    this.loadOverview();
  },

  onShow() {
    const visit = visitStore.load();
    const current = this.data.visit;
    if (current && current.storeId !== visit.storeId) {
      this.setData({ visit, mode: visit.fulfillmentType, tableName: visit.tableName });
      this.loadOverview();
      return;
    }
    this.setData({ visit, mode: visit.fulfillmentType, tableName: visit.tableName });
    this.loadProfile();
    if (this.data.store) {
      this.loadActiveOrders();
    }
  },

  onPullDownRefresh() {
    this.loadOverview(() => {
      if (typeof wx !== 'undefined' && wx.stopPullDownRefresh) {
        wx.stopPullDownRefresh();
      }
    });
  },

  async loadOverview(done) {
    const visit = this.data.visit || visitStore.load();
    this.setData({ loading: true, error: '' });
    try {
      const store = await storeService.getStore(visit.storeId);
      const nextVisit = visitStore.applyStore(store);
      const localVersion = config.STORE_CONFIG && config.STORE_CONFIG.meta
        ? config.STORE_CONFIG.meta.catalogVersion
        : null;
      const guard = versionGuard.compareVersions(localVersion, store.catalogVersion);
      this.setData({
        store,
        visit: nextVisit,
        mode: nextVisit.fulfillmentType,
        tableName: nextVisit.tableName,
        versionNotice: guard.stale ? guard.message : '',
        loading: false,
      });
      if (typeof wx !== 'undefined' && wx.setNavigationBarTitle) {
        wx.setNavigationBarTitle({ title: store.name });
      }
      await this.loadTables(visit.storeId);
      await this.loadProfile();
      await this.loadActiveOrders();
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

  async loadTables(storeId) {
    try {
      const payload = await storeService.getTables(storeId);
      const resolved = versionGuard.resolveTables(payload.tables, config.DEMO_TABLES);
      this.setData({ tableOptions: resolved.tables });
    } catch (error) {
      this.setData({ tableOptions: config.DEMO_TABLES });
    }
  },

  async loadProfile() {
    try {
      await auth.ensureLogin();
      const merchant = session.memberships().filter(
        (item) => item && (item.role === 'OWNER' || item.role === 'STAFF'),
      )[0];
      this.setData({
        identityLabel: auth.currentIdentity().label,
        merchantStoreId: merchant ? merchant.storeId : '',
      });
    } catch (error) {
      this.setData({ identityLabel: '未登录', merchantStoreId: '' });
    }
  },

  async loadActiveOrders() {
    if (!session.isLoggedIn()) {
      this.setData({ activeOrders: [], pendingPaymentCount: 0 });
      return;
    }
    const visit = this.data.visit || visitStore.load();
    try {
      const payload = await orderService.listOrders({ storeId: visit.storeId, active: true, pageSize: 3 });
      const list = orderView.toOrderListView(payload);
      const highlighted = list.items.filter(
        (order) =>
          order.paymentStatus === orderStatus.PAYMENT_STATUS.DEMO_PAID &&
          orderStatus.isActiveStatus(order.status) &&
          order.status !== orderStatus.ORDER_STATUS.PENDING_PAYMENT,
      );
      const pendingPaymentCount = list.items.filter(
        (order) => order.status === orderStatus.ORDER_STATUS.PENDING_PAYMENT,
      ).length;
      this.setData({ activeOrders: highlighted, pendingPaymentCount });
    } catch (error) {
      this.setData({ activeOrders: [], pendingPaymentCount: 0 });
    }
  },

  onModeChange(event) {
    const next = visitStore.setFulfillment(event.detail.value);
    this.setData({ visit: next, mode: next.fulfillmentType });
    if (next.fulfillmentType === config.FULFILLMENT_TYPES.DINE_IN && !next.tableId) {
      platform.toast('请选择演示桌号，或扫描桌上的二维码');
    }
  },

  onPickTable(event) {
    const tableId = event.currentTarget.dataset.id;
    const tableName = event.currentTarget.dataset.name;
    const next = visitStore.setTable(tableId, tableName);
    this.setData({ visit: next, mode: next.fulfillmentType, tableName: next.tableName });
    platform.toast('已选择 ' + next.tableName + ' 桌（演示）');
  },

  goMenu() {
    const visit = this.data.visit || visitStore.load();
    if (visit.fulfillmentType === config.FULFILLMENT_TYPES.DINE_IN && !visit.tableId) {
      platform.toast('堂食需要桌号，请先选择演示桌号');
      return;
    }
    if (typeof wx !== 'undefined' && wx.switchTab) {
      wx.switchTab({ url: '/pages/menu/index' });
    }
  },

  goOrders() {
    if (typeof wx !== 'undefined' && wx.switchTab) {
      wx.switchTab({ url: '/pages/orders/index' });
    }
  },

  goMine() {
    if (typeof wx !== 'undefined' && wx.switchTab) {
      wx.switchTab({ url: '/pages/mine/index' });
    }
  },

  goMerchant() {
    if (!this.data.merchantStoreId) {
      return;
    }
    if (typeof wx !== 'undefined' && wx.navigateTo) {
      wx.navigateTo({ url: '/pages/merchant-orders/index?storeId=' + encodeURIComponent(this.data.merchantStoreId) });
    }
  },

  onOpenOrder(event) {
    const orderId = event.detail.orderId;
    if (!orderId || typeof wx === 'undefined' || !wx.navigateTo) {
      return;
    }
    wx.navigateTo({ url: '/pages/order-detail/index?id=' + encodeURIComponent(orderId) });
  },

  onRetry() {
    this.loadOverview();
  },
});