const money = require('../../domain/money.js');

Component({
  properties: {
    product: {
      type: Object,
      value: {},
    },
    quantity: {
      type: Number,
      value: 0,
    },
    disabled: {
      type: Boolean,
      value: false,
    },
  },

  data: {
    display: {
      initial: '菜',
      amount: '0.00',
    },
  },

  observers: {
    product(product) {
      const source = product && typeof product === 'object' ? product : {};
      const name = typeof source.name === 'string' && source.name ? source.name : '';
      this.setData({
        display: {
          initial: name ? name.slice(0, 1) : '菜',
          amount: money.formatAmount(source.priceCents),
        },
      });
    },
  },

  methods: {
    onOpen() {
      this.triggerEvent('openDetail', { productId: this.data.product.id || '' });
    },

    onAdd() {
      const productId = this.data.product.id || '';
      if (!productId || this.data.disabled) {
        return;
      }
      this.triggerEvent('add', { productId });
    },

    onRemove() {
      const productId = this.data.product.id || '';
      if (!productId || this.data.quantity <= 0) {
        return;
      }
      this.triggerEvent('remove', { productId });
    },
  },
});