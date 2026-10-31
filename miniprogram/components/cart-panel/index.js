const money = require('../../domain/money.js');

Component({
  properties: {
    visible: {
      type: Boolean,
      value: false,
    },
    items: {
      type: Array,
      value: [],
    },
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
    rows: [],
    totalText: '¥0.00',
  },

  observers: {
    'items, totalCents': function onDataChange(items, totalCents) {
      const list = Array.isArray(items) ? items : [];
      this.setData({
        totalText: money.formatCents(totalCents),
        rows: list.map((item) => ({
          productId: item.productId,
          name: item.name,
          quantity: item.quantity,
          unitPriceText: money.formatCents(item.unitPriceCents),
          lineTotalText: money.formatCents(item.lineTotalCents),
        })),
      });
    },
  },

  methods: {
    onClose() {
      this.triggerEvent('close', {});
    },

    onAdd(event) {
      this.triggerEvent('add', { productId: event.currentTarget.dataset.id });
    },

    onRemove(event) {
      this.triggerEvent('remove', { productId: event.currentTarget.dataset.id });
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