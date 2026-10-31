const config = require('../../config/env.js');
const money = require('../../domain/money.js');
const orderView = require('../../domain/orderView.js');
const errorText = require('../../domain/errorText.js');
const platform = require('../../services/platform.js');
const storeService = require('../../services/store.js');
const merchantService = require('../../services/merchant.js');
const auth = require('../../services/auth.js');
const session = require('../../services/session.js');

const CANCEL_REASONS = ['原料售罄', '顾客要求取消', '门店临时打烊', '其他原因'];
const POLL_INTERVAL_MS = 10000;

const SEGMENTS = [
  { key: 'pending', label: '待处理', status: 'PENDING_PAYMENT,PENDING_ACCEPT' },
  { key: 'working', label: '进行中', status: 'PREPARING,READY' },
];

Page({
  data: {
    storeId: '',
    storeName: '',
    roleLabel: '',
    checking: true,
    allowed: false,
    loading: false,
    ordersLoading: false,
    productsLoading: false,
    error: '',
    errorAction: '',
    requestId: '',
    tab: 'orders',
    segment: 'pending',
    segments: SEGMENTS.map((item) => ({ key: item.key, label: item.label })),
    orders: [],
    total: 0,
    categories: [],
    productCount: 0,
    availableCount: 0,
    lastUpdated: '',
    polling: true,
    actingId: '',
    actingStatus: '',
    demoMode: !config.USE_WECHAT_CODE_LOGIN,
  },

  onLoad(options) {
    const input = options || {};
    this.timer = null;
    this.setData({ storeId: input.storeId ? decodeURIComponent(input.storeId) : '' });
    this.bootstrap();
  },

  onShow() {
    if (!this.data.allowed) {
      return;
    }
    if (this.data.tab === 'orders') {
      this.loadOrders(true);
      if (this.data.polling) {
        this.startPolling();
      }
    }
  },

  onHide() {
    this.stopPolling();
  },

  onUnload() {
    this.stopPolling();
  },

  onPullDownRefresh() {
    const done = () => {
      if (typeof wx !== 'undefined' && wx.stopPullDownRefresh) {
        wx.stopPullDownRefresh();
      }
    };
    if (this.data.tab === 'products') {
      this.loadProducts(done);
    } else {
      this.loadOrders(false, done);
    }
  },

  async bootstrap() {
    this.setData({ checking: true, error: '' });
    try {
      await auth.ensureLogin();
      const memberships = session.memberships().filter(
        (item) => item && (item.role === 'OWNER' || item.role === 'STAFF'),
      );
      let storeId = this.data.storeId;
      if (!storeId) {
        storeId = memberships.length > 0 ? memberships[0].storeId : '';
      }
      const membership = memberships.filter((item) => item.storeId === storeId)[0];
      if (!storeId || !membership) {
        this.setData({
          checking: false,
          allowed: false,
          storeId,
          error: '当前身份没有该门店的操作权限',
          errorAction: '切换身份',
        });
        return;
      }
      this.setData({
        checking: false,
        allowed: true,
        storeId,
        roleLabel: membership.role === 'OWNER' ? '店主' : '店员',
        error: '',
      });
      this.loadStoreName(storeId);
      await this.loadOrders(false);
      if (this.data.polling) {
        this.startPolling();
      }
    } catch (error) {
      const described = errorText.describeError(error);
      this.setData({
        checking: false,
        allowed: false,
        error: described.message,
        errorAction: described.action || '重试',
        requestId: described.requestId,
      });
    }
  },

  async loadStoreName(storeId) {
    try {
      const store = await storeService.getStore(storeId);
      this.setData({ storeName: store.name });
    } catch (error) {
      this.setData({ storeName: '' });
    }
  },

  startPolling() {
    this.stopPolling();
    if (!this.data.polling || this.data.tab !== 'orders') {
      return;
    }
    this.timer = setInterval(() => {
      this.loadOrders(true);
    }, POLL_INTERVAL_MS);
  },

  stopPolling() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  },

  async loadOrders(silent, done) {
    if (!this.data.allowed) {
      if (typeof done === 'function') {
        done();
      }
      return;
    }
    if (!silent) {
      this.setData({ ordersLoading: true });
    }
    try {
      const segment = SEGMENTS.filter((item) => item.key === this.data.segment)[0] || SEGMENTS[0];
      const payload = await merchantService.listOrders(this.data.storeId, {
        status: segment.status,
        pageSize: 50,
      });
      const list = orderView.toOrderListView(payload);
      const orders = list.items.map((order) => orderView.toMerchantOrderView(order));
      const now = new Date();
      this.setData({
        orders,
        total: list.total,
        ordersLoading: false,
        error: '',
        lastUpdated: orderView.formatTime(now) + ' 更新',
      });
    } catch (error) {
      const described = errorText.describeError(error);
      this.setData({
        ordersLoading: false,
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

  async loadProducts(done) {
    if (!this.data.allowed) {
      if (typeof done === 'function') {
        done();
      }
      return;
    }
    this.setData({ productsLoading: true, error: '' });
    try {
      const catalog = await merchantService.listProducts(this.data.storeId);
      let productCount = 0;
      let availableCount = 0;
      const categories = (catalog.categories || []).map((category) => ({
        id: category.id,
        name: category.name,
        products: (category.products || []).map((product) => {
          productCount += 1;
          if (product.available) {
            availableCount += 1;
          }
          return {
            id: product.id,
            name: product.name,
            description: product.description || '',
            priceText: money.formatCents(product.priceCents),
            available: product.available,
          };
        }),
      }));
      this.setData({
        categories,
        productCount,
        availableCount,
        productsLoading: false,
      });
    } catch (error) {
      const described = errorText.describeError(error);
      this.setData({
        productsLoading: false,
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

  onChangeTab(event) {
    const tab = event.currentTarget.dataset.tab;
    if (!tab || tab === this.data.tab) {
      return;
    }
    this.setData({ tab, error: '' });
    if (tab === 'products') {
      this.stopPolling();
      this.loadProducts();
    } else {
      this.loadOrders(false);
      if (this.data.polling) {
        this.startPolling();
      }
    }
  },

  onChangeSegment(event) {
    const segment = event.currentTarget.dataset.key;
    if (!segment || segment === this.data.segment) {
      return;
    }
    this.setData({ segment, orders: [] });
    this.loadOrders(false);
  },

  onTogglePolling(event) {
    const enabled = Boolean(event.detail.value);
    this.setData({ polling: enabled });
    if (enabled) {
      platform.toast('已开启 10 秒自动刷新');
      this.startPolling();
    } else {
      platform.toast('已暂停自动刷新');
      this.stopPolling();
    }
  },

  onRefresh() {
    if (this.data.tab === 'products') {
      this.loadProducts();
      return;
    }
    this.loadOrders(false);
  },

  async onAdvance(event) {
    const orderId = event.detail.orderId;
    const toStatus = event.detail.toStatus;
    if (!orderId || !toStatus || this.data.actingId) {
      return;
    }
    const order = this.data.orders.filter((item) => item.id === orderId)[0];
    const action = order
      ? order.actions.filter((item) => item.toStatus === toStatus)[0]
      : null;
    if (!order || !action) {
      return;
    }
    let reason = '';
    if (action.requiresReason) {
      reason = await this.pickReason('请选择取消原因');
      if (!reason) {
        return;
      }
    }
    this.setData({ actingId: orderId, actingStatus: toStatus, error: '' });
    try {
      await merchantService.updateOrderStatus(orderId, {
        toStatus,
        expectedStatus: order.status,
        reason,
      });
      platform.toast('状态已更新');
      await this.loadOrders(true);
    } catch (error) {
      const described = errorText.describeError(error);
      this.setData({
        error: described.message,
        errorAction: described.action || '刷新订单',
        requestId: described.requestId,
      });
      if (error && (error.code === 'STATUS_CONFLICT' || error.code === 'INVALID_STATUS_TRANSITION')) {
        await this.loadOrders(true);
      }
    } finally {
      this.setData({ actingId: '', actingStatus: '' });
    }
  },

  async onToggleProduct(event) {
    const productId = event.currentTarget.dataset.id;
    const productName = event.currentTarget.dataset.name;
    const available = Boolean(event.detail.value);
    if (!productId) {
      return;
    }
    this.setData({ actingId: productId });
    try {
      await merchantService.updateAvailability(productId, available);
      platform.toast((available ? '已上架 ' : '已下架 ') + (productName || '商品'));
      await this.loadProducts();
    } catch (error) {
      const described = errorText.describeError(error);
      this.setData({
        error: described.message,
        errorAction: described.action || '重新加载',
        requestId: described.requestId,
      });
      await this.loadProducts();
    } finally {
      this.setData({ actingId: '' });
    }
  },

  onOpenOrder(event) {
    const orderId = event.detail.orderId;
    if (!orderId || typeof wx === 'undefined' || !wx.navigateTo) {
      return;
    }
    wx.navigateTo({ url: '/pages/order-detail/index?id=' + encodeURIComponent(orderId) });
  },

  pickReason(title) {
    return new Promise((resolve) => {
      if (typeof wx === 'undefined' || !wx.showActionSheet) {
        resolve('门店取消');
        return;
      }
      wx.showActionSheet({
        alertText: title,
        itemList: CANCEL_REASONS,
        success(result) {
          resolve(CANCEL_REASONS[Number(result.tapIndex)] || '门店取消');
        },
        fail() {
          resolve('');
        },
      });
    });
  },

  onRetry() {
    if (this.data.errorAction === '切换身份') {
      if (typeof wx !== 'undefined' && wx.switchTab) {
        wx.switchTab({ url: '/pages/mine/index' });
      }
      return;
    }
    this.bootstrap();
  },

  onCloseError() {
    this.setData({ error: '', errorAction: '', requestId: '' });
  },
});