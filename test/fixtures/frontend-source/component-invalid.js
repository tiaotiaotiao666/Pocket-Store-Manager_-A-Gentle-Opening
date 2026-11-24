const store = require('../../services/store');

Component({
  properties: {
    product: { type: Object, value: {} },
  },
  methods: {
    onTap() {
      wx.request({ url: 'https://example.com/api' });
      wx.navigateTo({ url: '/pages/menu/index' });
      getApp().globalData.cart = {};
      this.triggerEvent('add', { productId: this.data.product.id });
    },
  },
});
