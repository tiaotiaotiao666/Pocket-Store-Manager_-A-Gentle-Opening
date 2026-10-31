Component({
  properties: {
    rows: {
      type: Number,
      value: 3,
    },
    text: {
      type: String,
      value: '',
    },
  },

  data: {
    bars: [0, 1, 2],
  },

  observers: {
    rows(rows) {
      const count = Math.max(1, Math.min(Number(rows) || 3, 8));
      const bars = [];
      for (let index = 0; index < count; index += 1) {
        bars.push(index);
      }
      this.setData({ bars });
    },
  },
});