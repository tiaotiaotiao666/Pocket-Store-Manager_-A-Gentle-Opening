const money = require('../../domain/money');

Component({
  properties: {
    product: { type: Object, value: {} },
    quantity: { type: Number, value: 0 },
    disabled: { type: Boolean, value: false },
  },
  observers: {
    'product, quantity': function onChanged() {
      this.setData({ text: money.formatCents(this.data.product.priceCents || 0) });
    },
  },
  methods: {
    onAdd() {
      this.triggerEvent('add', { productId: this.data.product.id });
    },
    onRemove() {
      this.triggerEvent('remove', { productId: this.data.product.id });
    },
    onOpenDetail() {
      this.triggerEvent('openDetail', { productId: this.data.product.id });
    },
  },
});
