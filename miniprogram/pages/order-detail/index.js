const orderStatus = require('../../domain/orderStatus.js');
const orderView = require('../../domain/orderView.js');
const errorText = require('../../domain/errorText.js');
const platform = require('../../services/platform.js');
const orderService = require('../../services/order.js');
const merchantService = require('../../services/merchant.js');
const auth = require('../../services/auth.js');
const session = require('../../services/session.js');

const CANCEL_REASONS = ['不想要了', '点错了', '等待太久', '其他原因'];

Page({
  data: {
    orderId: '',
    loading: true,
    error: '',
    errorAction: '',
    requestId: '',
    order: null,
    role: 'CUSTOMER',
    merchantActions: [],
    showPayHint: false,
    acting: false,
    actionLabel: '',
  },

  onLoad(options) {
    const input = options || {};
    this.setData({
      orderId: input.id || '',
      showPayHint: input.pay === '1',
    });
  },

  onShow() {
    if (this.data.orderId) {
      this.load();
    }
  },

  onPullDownRefresh() {
    this.load(() => {
      if (typeof wx !== 'undefined' && wx.stopPullDownRefresh) {
        wx.stopPullDownRefresh();
      }
    });
  },

  async load(done) {
    if (!this.data.orderId) {
      this.setData({ loading: false, error: '缺少订单编号', errorAction: '' });
      return;
    }
    this.setData({ loading: true, error: '' });
    try {
      await auth.ensureLogin();
      const order = await orderService.getOrder(this.data.orderId);
      const view = orderView.toOrderView(order);
      const isMerchant = session.isMerchantOf(order.storeId);
      this.setData({
        loading: false,
        order: view,
        role: isMerchant ? 'MERCHANT' : 'CUSTOMER',
        merchantActions: isMerchant ? orderStatus.merchantActions(order) : [],
        showPayHint: this.data.showPayHint && view.canPay,
      });
      if (typeof wx !== 'undefined' && wx.setNavigationBarTitle) {
        wx.setNavigationBarTitle({ title: '订单 #' + view.shortId });
      }
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

  async onPay() {
    if (this.data.acting || !this.data.order) {
      return;
    }
    this.setData({ acting: true, actionLabel: 'pay', error: '' });
    try {
      await orderService.demoPayment(this.data.order.id);
      platform.toast('演示模拟支付成功');
      this.setData({ showPayHint: false });
      await this.load();
    } catch (error) {
      this.showError(error);
    } finally {
      this.setData({ acting: false, actionLabel: '' });
    }
  },

  async onCancel() {
    if (this.data.acting || !this.data.order) {
      return;
    }
    const reason = await this.pickReason('选择取消原因');
    if (!reason) {
      return;
    }
    this.setData({ acting: true, actionLabel: 'cancel', error: '' });
    try {
      await orderService.cancelOrder(this.data.order.id, reason);
      platform.toast('订单已取消');
      await this.load();
    } catch (error) {
      this.showError(error);
    } finally {
      this.setData({ acting: false, actionLabel: '' });
    }
  },

  async onAdvance(event) {
    if (this.data.acting || !this.data.order) {
      return;
    }
    const toStatus = event.currentTarget.dataset.status;
    const action = this.data.merchantActions.filter((item) => item.toStatus === toStatus)[0];
    if (!action) {
      return;
    }
    let reason = '';
    if (action.requiresReason) {
      reason = await this.pickReason('请选择取消原因');
      if (!reason) {
        return;
      }
    }
    this.setData({ acting: true, actionLabel: toStatus, error: '' });
    try {
      await merchantService.updateOrderStatus(this.data.order.id, {
        toStatus,
        expectedStatus: this.data.order.status,
        reason,
      });
      platform.toast('订单状态已更新');
      await this.load();
    } catch (error) {
      this.showError(error);
      if (error && error.code === 'STATUS_CONFLICT') {
        await this.load();
      }
    } finally {
      this.setData({ acting: false, actionLabel: '' });
    }
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

  showError(error) {
    const described = errorText.describeError(error);
    this.setData({
      error: described.message,
      errorAction: described.action || '',
      requestId: described.requestId,
    });
  },

  onRetry() {
    if (this.data.errorAction === '重新登录') {
      auth.ensureLogin().then(() => this.load());
      return;
    }
    this.load();
  },

  onCloseError() {
    this.setData({ error: '', errorAction: '', requestId: '' });
  },

  goOrders() {
    if (typeof wx !== 'undefined' && wx.switchTab) {
      wx.switchTab({ url: '/pages/orders/index' });
    }
  },
});