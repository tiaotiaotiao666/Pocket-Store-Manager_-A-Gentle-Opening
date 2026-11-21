Component({
  properties: {
    categories: {
      type: Array,
      value: [],
    },
    activeId: {
      type: String,
      value: '',
    },
  },

  methods: {
    onSelect(event) {
      const id = event.currentTarget.dataset.id;
      if (!id || id === this.data.activeId) {
        return;
      }
      this.triggerEvent('select', { id });
    },
  },
});