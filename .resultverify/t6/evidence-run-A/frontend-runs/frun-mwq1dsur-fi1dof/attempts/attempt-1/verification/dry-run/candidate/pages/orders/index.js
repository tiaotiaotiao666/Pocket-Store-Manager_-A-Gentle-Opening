const config = require('../../config/env.js');
const orderStatus = require('../../domain/orderStatus.js');
const orderView = require('../../domain/orderView.js');
const errorText = require('../../domain/errorText.js');
const platform = require('../../services/platform.js');
const storeService = require('../../services/store.js');
const orderService = require('../../services/order.js');
const auth = require('../../services/auth.js');
const session = require('../../services/session.js');
const visitStore = require('../../state/visit-store.js');

const CANCEL_REASONS = ['不想要了', '点错了', '等待太久', '其他原因'];

Page({
  data: {
    loading: true,
    error: '',
    errorAction: '',
    requestId: '',
    filter: 'active',
    filters: [
      { key: 'active', label: '进行中' },
      { key: 'history', label: '已完成' },
      { key: 'all', label: '全部' },
    ],
    orders: [],
    page: 1,
    pageSize: 20,
    total: 0,
    hasMore: false,
    storeId: '',
    storeName: '',
    identityLabel: '未登录',
    loggedIn: false,
    pendingPaymentCount: 0,
    emptyTitle: '',
    emptyDescription: '',
    loadingMore: false,
    actionOrderId: '',
  },

  onShow() {
    this.reload();
  },

  onPullDownRefresh() {
    this.reload(() => {
      if (typeof wx !== 'undefined' && wx.stopPullDownRefresh) {
        wx.stopPullDownRefresh();
      }
    });
  },

  async reload(done) {
    const visit = visitStore.load();
    this.setData({ loading: true, error: '', storeId: visit.storeId });
    try {
      await auth.ensureLogin();
      const user = session.getUser();
      this.setData({
        loggedIn: true,
        identityLabel: auth.currentIdentity().label,
        storeName: visit.storeName || '',
      });
      if (user && Array.isArray(user.memberships) && !visit.storeName) {
        this.setData({ storeName: '' });
      }
      this.loadStoreName(visit.storeId);
      await this.loadPage(1);
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

  async loadStoreName(storeId) {
    try {
      const store = await storeService.getStore(storeId);
      this.setData({ storeName: store.name });
    } catch (error) {
      this.setData({ storeName: '' });
    }
  },

  async loadPage(page) {
    const query = { storeId: this.data.storeId, page, pageSize: this.data.pageSize };
    if (this.data.filter === 'active') {
      query.active = true;
    } else if (this.data.filter === 'history') {
      query.status = orderStatus.filterStatusOptions('history');
    }

    const payload = await orderService.listOrders(query);
    const list = orderView.toOrderListView(payload);
    const orders = page === 1 ? list.items : this.data.orders.concat(list.items);
    const pendingPaymentCount = orders.filter(
      (order) => order.status === orderStatus.ORDER_STATUS.PENDING_PAYMENT,
    ).length;

    this.setData({
      loading: false,
      orders,
      page: list.page,
      total: list.total,
      hasMore: orders.length < list.total,
      pendingPaymentCount,
      emptyTitle: this.emptyTitle(),
      emptyDescription: this.emptyDescription(),
    });
  },

  emptyTitle() {
    if (this.data.filter === 'active') {
      return '当前没有进行中的订单';
    }
    if (this.data.filter === 'history') {
      return '还没有已完成或已取消的订单';
    }
    return '还没有订单';
  },

  emptyDescription() {
    if (this.data.filter === 'active') {
      return '点几道菜，下单后可以在这里查看进度';
    }
    return '订单会按时间倒序显示在这里';
  },

  onChangeFilter(event) {
    const filter = event.currentTarget.dataset.key;
    if (!filter || filter === this.data.filter) {
      return;
    }
    this.setData({ filter, orders: [], page: 1 });
    this.loadPage(1).catch((error) => {
      const described = errorText.describeError(error);
      this.setData({
        loading: false,
        error: described.message,
        errorAction: described.action || '重新加载',
        requestId: described.requestId,
      });
    });
  },

  async onLoadMore() {
    if (this.data.loadingMore || !this.data.hasMore) {
      return;
    }
    this.setData({ loadingMore: true });
    try {
      await this.loadPage(this.data.page + 1);
    } catch (error) {
      const described = errorText.describeError(error);
      platform.toast(described.message);
    } finally {
      this.setData({ loadingMore: false });
    }
  },

  onOpen(event) {
    const orderId = event.detail.orderId;
    if (!orderId || typeof wx === 'undefined' || !wx.navigateTo) {
      return;
    }
    wx.navigateTo({ url: '/pages/order-detail/index?id=' + encodeURIComponent(orderId) });
  },

  async onPay(event) {
    const orderId = event.detail.orderId;
    if (!orderId || this.data.actionOrderId) {
      return;
    }
    this.setData({ actionOrderId: orderId, error: '' });
    try {
      await orderService.demoPayment(orderId);
      platform.toast('演示模拟支付成功');
      await this.loadPage(1);
    } catch (error) {
      const described = errorText.describeError(error);
      this.setData({ error: described.message, errorAction: described.action || '', requestId: described.requestId });
    } finally {
      this.setData({ actionOrderId: '' });
    }
  },

  async onCancel(event) {
    const orderId = event.detail.orderId;
    if (!orderId || this.data.actionOrderId) {
      return;
    }
    const picked = await this.pickCancelReason();
    if (!picked) {
      return;
    }
    this.setData({ actionOrderId: orderId, error: '' });
    try {
      await orderService.cancelOrder(orderId, picked);
      platform.toast('订单已取消');
      await this.loadPage(1);
    } catch (error) {
      const described = errorText.describeError(error);
      this.setData({ error: described.message, errorAction: described.action || '', requestId: described.requestId });
    } finally {
      this.setData({ actionOrderId: '' });
    }
  },

  pickCancelReason() {
    return new Promise((resolve) => {
      if (typeof wx === 'undefined' || !wx.showActionSheet) {
        resolve('顾客取消');
        return;
      }
      wx.showActionSheet({
        itemList: CANCEL_REASONS,
        success(result) {
          const index = Number(result.tapIndex);
          resolve(CANCEL_REASONS[index] || '顾客取消');
        },
        fail() {
          resolve('');
        },
      });
    });
  },

  goMenu() {
    if (typeof wx !== 'undefined' && wx.switchTab) {
      wx.switchTab({ url: '/pages/menu/index' });
    }
  },

  onRetry() {
    this.reload();
  },
});