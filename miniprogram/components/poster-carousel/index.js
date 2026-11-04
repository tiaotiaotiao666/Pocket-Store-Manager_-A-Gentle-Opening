const MIN_INTERVAL = 3000;
const MAX_INTERVAL = 8000;
const DEFAULT_INTERVAL = 4200;

Component({
  properties: {
    items: { type: Array, value: [] },
    autoplay: { type: Boolean, value: true },
    interval: { type: Number, value: DEFAULT_INTERVAL },
    showIndicator: { type: Boolean, value: true },
    size: { type: String, value: 'lg' },
  },
  data: { slides: [], safeInterval: DEFAULT_INTERVAL, failedIndex: -1 },
  observers: {
    'items, interval'(items, interval) {
      const safeInterval = Number.isFinite(interval) && interval >= MIN_INTERVAL && interval <= MAX_INTERVAL
        ? interval
        : DEFAULT_INTERVAL;
      this.setData({ slides: Array.isArray(items) ? items : [], safeInterval, failedIndex: -1 });
    },
  },
  methods: {
    onSelect(event) {
      const index = Number(event.currentTarget.dataset.index);
      const slide = this.data.slides[index];
      if (!Number.isInteger(index) || !slide) return;
      this.triggerEvent('select', {
        index,
        posterId: slide.id || '',
        productId: slide.productId || (slide.product && slide.product.id) || '',
      });
    },
    onImageError(event) {
      const index = Number(event.currentTarget.dataset.index);
      this.setData({ failedIndex: index });
      this.triggerEvent('error', { index });
    },
  },
});
