Component({
  properties: {
    order: {
      type: Object,
      value: {},
    },
    role: {
      type: String,
      value: 'CUSTOMER',
    },
    actionable: {
      type: Boolean,
      value: false,
    },
    actingId: {
      type: String,
      value: '',
    },
    actingStatus: {
      type: String,
      value: '',
    },
  },

  methods: {
    orderId() {
      return this.data.order && this.data.order.id ? this.data.order.id : '';
    },

    onOpen() {
      const orderId = this.orderId();
      if (!orderId) {
        return;
      }
      this.triggerEvent('open', { orderId });
    },

    onPay() {
      const orderId = this.orderId();
      if (!orderId) {
        return;
      }
      this.triggerEvent('pay', { orderId });
    },

    onCancel() {
      const orderId = this.orderId();
      if (!orderId) {
        return;
      }
      this.triggerEvent('cancel', { orderId, reason: '' });
    },

    onAdvance(event) {
      const orderId = this.orderId();
      const toStatus = event.currentTarget.dataset.status;
      if (!orderId || !toStatus || this.data.actingId) {
        return;
      }
      this.triggerEvent('advance', { orderId, toStatus });
    },
  },
});