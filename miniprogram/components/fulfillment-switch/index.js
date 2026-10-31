Component({
  properties: {
    value: {
      type: String,
      value: 'TAKEAWAY',
    },
    dineInEnabled: {
      type: Boolean,
      value: true,
    },
    takeawayEnabled: {
      type: Boolean,
      value: true,
    },
    tableName: {
      type: String,
      value: '',
    },
    tableRequired: {
      type: Boolean,
      value: false,
    },
  },

  methods: {
    onSelect(event) {
      const value = event.currentTarget.dataset.value;
      if (!value || value === this.data.value) {
        return;
      }
      if (value === 'DINE_IN' && !this.data.dineInEnabled) {
        return;
      }
      if (value === 'TAKEAWAY' && !this.data.takeawayEnabled) {
        return;
      }
      this.triggerEvent('change', { value });
    },
  },
});