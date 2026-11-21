Component({
  properties: {
    message: {
      type: String,
      value: '',
    },
    action: {
      type: String,
      value: '',
    },
    requestId: {
      type: String,
      value: '',
    },
  },

  methods: {
    onRetry() {
      this.triggerEvent('retry', {});
    },

    onClose() {
      this.triggerEvent('close', {});
    },
  },
});