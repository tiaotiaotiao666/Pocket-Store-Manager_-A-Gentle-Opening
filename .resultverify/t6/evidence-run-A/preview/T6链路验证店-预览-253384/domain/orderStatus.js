const ORDER_STATUS = {
  PENDING_PAYMENT: 'PENDING_PAYMENT',
  PENDING_ACCEPT: 'PENDING_ACCEPT',
  PREPARING: 'PREPARING',
  READY: 'READY',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
};

const PAYMENT_STATUS = {
  UNPAID: 'UNPAID',
  DEMO_PAID: 'DEMO_PAID',
};

const STATUS_TEXT = {
  PENDING_PAYMENT: '待付款',
  PENDING_ACCEPT: '待接单',
  PREPARING: '制作中',
  READY: '可取餐',
  COMPLETED: '已完成',
  CANCELLED: '已取消',
};

const STATUS_TONE = {
  PENDING_PAYMENT: 'warning',
  PENDING_ACCEPT: 'info',
  PREPARING: 'primary',
  READY: 'success',
  COMPLETED: 'neutral',
  CANCELLED: 'muted',
};

const CUSTOMER_HINT = {
  PENDING_PAYMENT: '订单已创建，请完成演示模拟支付',
  PENDING_ACCEPT: '已模拟支付，等待店家接单',
  PREPARING: '店家正在制作，请稍候',
  READY: '餐品已准备好，请前往取餐',
  COMPLETED: '订单已完成，感谢惠顾',
  CANCELLED: '订单已取消',
};

const ACTIVE_STATUSES = [
  ORDER_STATUS.PENDING_PAYMENT,
  ORDER_STATUS.PENDING_ACCEPT,
  ORDER_STATUS.PREPARING,
  ORDER_STATUS.READY,
];

const PROGRESS_STEPS = [
  ORDER_STATUS.PENDING_PAYMENT,
  ORDER_STATUS.PENDING_ACCEPT,
  ORDER_STATUS.PREPARING,
  ORDER_STATUS.READY,
  ORDER_STATUS.COMPLETED,
];

const PAYMENT_TEXT = {
  UNPAID: '未支付',
  DEMO_PAID: '演示已支付',
};

function statusText(status) {
  return STATUS_TEXT[status] || '状态未知';
}

function statusTone(status) {
  return STATUS_TONE[status] || 'neutral';
}

function customerHint(status) {
  return CUSTOMER_HINT[status] || '正在获取最新状态';
}

function paymentText(paymentStatus) {
  return PAYMENT_TEXT[paymentStatus] || '支付状态未知';
}

function isActiveStatus(status) {
  return ACTIVE_STATUSES.indexOf(status) >= 0;
}

function isTerminalStatus(status) {
  return status === ORDER_STATUS.COMPLETED || status === ORDER_STATUS.CANCELLED;
}

function canCustomerPay(order) {
  return Boolean(order) && order.status === ORDER_STATUS.PENDING_PAYMENT && order.paymentStatus !== PAYMENT_STATUS.DEMO_PAID;
}

function canCustomerCancel(order) {
  return Boolean(order) && order.status === ORDER_STATUS.PENDING_PAYMENT;
}

function customerActions(order) {
  return {
    canPay: canCustomerPay(order),
    canCancel: canCustomerCancel(order),
  };
}

function merchantActions(order) {
  if (!order || !order.status) {
    return [];
  }
  if (order.status === ORDER_STATUS.PENDING_PAYMENT) {
    return [];
  }
  if (order.status === ORDER_STATUS.PENDING_ACCEPT) {
    return [
      { toStatus: ORDER_STATUS.PREPARING, label: '接单制作', tone: 'primary', requiresReason: false },
      { toStatus: ORDER_STATUS.CANCELLED, label: '拒单取消', tone: 'danger', requiresReason: true },
    ];
  }
  if (order.status === ORDER_STATUS.PREPARING) {
    return [
      { toStatus: ORDER_STATUS.READY, label: '制作完成', tone: 'primary', requiresReason: false },
      { toStatus: ORDER_STATUS.CANCELLED, label: '取消订单', tone: 'danger', requiresReason: true },
    ];
  }
  if (order.status === ORDER_STATUS.READY) {
    return [
      { toStatus: ORDER_STATUS.COMPLETED, label: '顾客已取餐', tone: 'success', requiresReason: false },
      { toStatus: ORDER_STATUS.CANCELLED, label: '取消订单', tone: 'danger', requiresReason: true },
    ];
  }
  return [];
}

function buildProgressSteps(status) {
  const cancelled = status === ORDER_STATUS.CANCELLED;
  const currentIndex = PROGRESS_STEPS.indexOf(status);
  return PROGRESS_STEPS.map((step, index) => {
    let state = 'pending';
    if (cancelled) {
      state = 'pending';
    } else if (index < currentIndex) {
      state = 'done';
    } else if (index === currentIndex) {
      state = 'current';
    }
    return {
      status: step,
      text: STATUS_TEXT[step],
      state,
    };
  });
}

function filterStatusOptions(key) {
  if (key === 'active') {
    return ACTIVE_STATUSES.join(',');
  }
  if (key === 'history') {
    return ORDER_STATUS.COMPLETED + ',' + ORDER_STATUS.CANCELLED;
  }
  return '';
}

module.exports = {
  ORDER_STATUS,
  PAYMENT_STATUS,
  STATUS_TEXT,
  STATUS_TONE,
  ACTIVE_STATUSES,
  PROGRESS_STEPS,
  statusText,
  statusTone,
  customerHint,
  paymentText,
  isActiveStatus,
  isTerminalStatus,
  canCustomerPay,
  canCustomerCancel,
  customerActions,
  merchantActions,
  buildProgressSteps,
  filterStatusOptions,
};