const money = require('../../domain/money.js');

Component({
  properties: {
    totalCents: {
      type: Number,
      value: 0,
    },
    totalQuantity: {
      type: Number,
      value: 0,
    },
    submitting: {
      type: Boolean,
      value: false,
    },
  },

  data: {
    totalText: '¥0.00',
  },

  observers: {
    totalCents(totalCents) {
      this.setData({ totalText: money.formatCents(totalCents) });
    },
  },

  methods: {
    onExpand() {
      if (this.data.totalQuantity <= 0) {
        return;
      }
      this.triggerEvent('expand', {});
    },

    onCheckout() {
      if (this.data.totalQuantity <= 0 || this.data.submitting) {
        return;
      }
      this.triggerEvent('checkout', {
        totalCents: this.data.totalCents,
        totalQuantity: this.data.totalQuantity,
      });
    },
  },
});