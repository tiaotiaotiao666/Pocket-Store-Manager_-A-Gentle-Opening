const orderStatus = require('../../domain/orderStatus.js');
const orderView = require('../../domain/orderView.js');
const errorText = require('../../domain/errorText.js');
const platform = require('../../services/platform.js');
const orderService = require('../../services/order.js');
const merchantService = require('../../services/merchant.js');
const auth = require('../../services/auth.js');
const session = require('../../services/session.js');
const payResultView = require('../../domain/payResult.js');

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
    payResult: null,
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

      // 店主通过 ?pay=1 进入时不展示顾客支付结果页，直接回到接单列表。
      if (isMerchant && this.data.showPayHint) {
        platform.toast('店主身份不进行顾客支付');
        if (typeof wx !== 'undefined' && wx.redirectTo) {
          wx.redirectTo({ url: '/pages/merchant-orders/index' });
        }
        return;
      }

      const next = {
        loading: false,
        order: view,
        role: isMerchant ? 'MERCHANT' : 'CUSTOMER',
        merchantActions: isMerchant ? orderStatus.merchantActions(order) : [],
        showPayHint: this.data.showPayHint && view.canPay,
      };
      if (this.data.payResult) {
        next.payResult = this.resolvePayResult(view, this.data.payResult);
      }
      this.setData(next);

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

  /** 刷新时以服务端订单状态为准：DEMO_PAID → success，否则 pending。 */
  resolvePayResult(view, current) {
    if (!view || view.status === 'CANCELLED') {
      return null;
    }
    if (!current || current.state === 'error' || current.state === 'loading') {
      return current;
    }
    return payResultView.buildPayResult(view, {
      title: current.title,
      description: current.description,
      requestId: current.requestId,
    });
  },

  async onPay() {
    if (this.data.acting || !this.data.order) {
      return;
    }
    const current = this.data.order;
    this.setData({
      acting: true,
      actionLabel: 'pay',
      error: '',
      payResult: payResultView.loadingPayResult(current),
    });
    try {
      await orderService.demoPayment(current.id);
      const latest = await orderService.getOrder(current.id);
      const view = orderView.toOrderView(latest);
      const result = payResultView.buildPayResult(view);
      this.setData({
        order: view,
        showPayHint: false,
        payResult: result,
      });
      if (result && result.state === 'success') {
        platform.toast('演示模拟支付成功');
      }
    } catch (error) {
      const described = errorText.describeError(error);
      this.setData({
        payResult: payResultView.errorPayResult(current, described),
      });
    } finally {
      this.setData({ acting: false, actionLabel: '' });
    }
  },

  async onResultPrimary() {
    const result = this.data.payResult;
    if (!result) {
      return;
    }
    if (result.state === 'success') {
      this.setData({ payResult: null });
      if (typeof wx !== 'undefined' && wx.pageScrollTo) {
        wx.pageScrollTo({ selector: '.detail__card', duration: 260 });
      }
      return;
    }
    if (result.state === 'pending') {
      await this.load();
      const latest = this.data.order;
      if (latest) {
        this.setData({ payResult: this.resolvePayResult(latest, result) });
      }
      return;
    }
    if (result.state === 'error') {
      await this.onPay();
    }
  },

  onResultSecondary() {
    this.goOrders();
  },

  async onResultRetry() {
    await this.onPay();
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
      this.setData({ payResult: null });
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