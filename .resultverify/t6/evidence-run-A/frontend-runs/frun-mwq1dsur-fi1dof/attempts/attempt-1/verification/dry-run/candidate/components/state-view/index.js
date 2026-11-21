Component({
  properties: {
    state: {
      type: String,
      value: 'loading',
    },
    title: {
      type: String,
      value: '',
    },
    description: {
      type: String,
      value: '',
    },
    actionText: {
      type: String,
      value: '',
    },
  },

  methods: {
    onAction() {
      this.triggerEvent('retry', {});
    },
  },
});