Component({
  properties: {
    state: { type: String, value: 'loading' },
    shortId: { type: String, value: '' },
    totalText: { type: String, value: '' },
    fulfillmentText: { type: String, value: '' },
    title: { type: String, value: '' },
    description: { type: String, value: '' },
    primaryText: { type: String, value: '' },
    secondaryText: { type: String, value: '' },
    requestId: { type: String, value: '' },
    demoNotice: {
      type: String,
      value: '本页为演示付款，未发生真实扣款，取餐号仅用于演示。',
    },
  },

  data: {
    headline: '正在确认支付结果…',
    caption: '请稍候，不要关闭页面。',
    primary: '',
    secondary: '返回订单列表',
    showNumber: false,
    hasError: false,
  },

  observers: {
    'state, title, description, primaryText, secondaryText': function onStateChange(state, title, description, primaryText, secondaryText) {
      const defaults = {
        loading: { headline: '正在确认支付结果…', caption: '请稍候，不要关闭页面。', primary: '' },
        success: { headline: '支付成功 · 请凭号取餐', caption: '取餐号已生成，可在订单进度里继续查看。', primary: '查看订单进度' },
        pending: { headline: '支付已提交，正在等待门店确认', caption: '门店确认后会进入制作流程，可下拉刷新。', primary: '刷新状态' },
        error: { headline: '支付未完成', caption: '可以重试；若持续失败，请返回订单列表稍后再试。', primary: '重试支付' },
      };
      const fallback = defaults[state] || defaults.loading;
      this.setData({
        headline: title || fallback.headline,
        caption: description || fallback.caption,
        primary: primaryText || fallback.primary,
        secondary: secondaryText || '返回订单列表',
        showNumber: state === 'success' || state === 'pending',
        hasError: state === 'error',
      });
    },
  },

  methods: {
    onPrimary() {
      this.triggerEvent('primary', { state: this.data.state });
    },
    onSecondary() {
      this.triggerEvent('secondary', { state: this.data.state });
    },
    onRetry() {
      this.triggerEvent('retry', { state: this.data.state });
    },
  },
});