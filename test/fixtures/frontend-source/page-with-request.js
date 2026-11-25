Page({
  data: {
    products: [],
  },
  onProductAdd(event) {
    wx.request({
      url: 'https://example.com/api/cart',
      method: 'POST',
      data: { productId: event.detail.productId },
    });
    this.setData({ products: this.data.products });
  },
});
