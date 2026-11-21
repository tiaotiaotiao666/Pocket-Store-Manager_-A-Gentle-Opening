const orderStatus = require('../../domain/orderStatus.js');

Component({
  properties: {
    status: {
      type: String,
      value: '',
    },
    paymentStatus: {
      type: String,
      value: '',
    },
    compact: {
      type: Boolean,
      value: false,
    },
  },

  data: {
    label: '状态未知',
    tone: 'neutral',
    paymentLabel: '',
    hint: '',
  },

  observers: {
    'status, paymentStatus': function onStatusChange(status, paymentStatus) {
      this.setData({
        label: orderStatus.statusText(status),
        tone: orderStatus.statusTone(status),
        paymentLabel: paymentStatus ? orderStatus.paymentText(paymentStatus) : '',
        hint: orderStatus.customerHint(status),
      });
    },
  },
});