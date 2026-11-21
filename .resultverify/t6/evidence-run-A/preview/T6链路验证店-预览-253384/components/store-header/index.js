Component({
  properties: {
    storeName: {
      type: String,
      value: '',
    },
    tableName: {
      type: String,
      value: '',
    },
    businessHours: {
      type: String,
      value: '',
    },
    mode: {
      type: String,
      value: 'TAKEAWAY',
    },
    address: {
      type: String,
      value: '',
    },
    compact: {
      type: Boolean,
      value: false,
    },
  },
});