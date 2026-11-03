const MIN_INTERVAL = 3000;
const MAX_INTERVAL = 8000;
const DEFAULT_INTERVAL = 4000;
/** 尺寸档位与 `preview-size-tokens.v1` 的 carousel 组一致；未知值按 md 处理。 */
const SIZE_STEPS = ['sm', 'md', 'lg'];
const DEFAULT_SIZE = 'md';

Component({
  properties: {
    items: {
      type: Array,
      value: [],
    },
    autoplay: {
      type: Boolean,
      value: true,
    },
    interval: {
      type: Number,
      value: DEFAULT_INTERVAL,
    },
    showIndicator: {
      type: Boolean,
      value: true,
    },
    size: {
      type: String,
      value: DEFAULT_SIZE,
    },
  },

  data: {
    slides: [],
    safeInterval: DEFAULT_INTERVAL,

    failedIndex: -1,
  },

  observers: {
    'items, interval'(items, interval) {
      const slides = Array.isArray(items) ? items : [];
      const nextInterval = Number.isFinite(interval) && interval >= MIN_INTERVAL && interval <= MAX_INTERVAL
        ? interval
        : DEFAULT_INTERVAL;
      this.setData({
        slides,
        safeInterval: nextInterval,
        failedIndex: -1,
      });
    },
  },

  methods: {
    onSelect(event) {
      const index = Number(event.currentTarget.dataset.index);
      if (!Number.isInteger(index)) return;
      const slide = this.data.slides[index];
      if (!slide) return;
      this.triggerEvent('select', { index, title: slide.title || '' });
    },

    onImageError(event) {
      const index = Number(event.currentTarget.dataset.index);
      this.setData({ failedIndex: index });
      this.triggerEvent('error', { index });
    },
  },
});