const money = require('./money.js');
const orderStatus = require('./orderStatus.js');

const SHANGHAI_OFFSET_MINUTES = 8 * 60;
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function toShanghaiDate(value) {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return new Date(date.getTime() + SHANGHAI_OFFSET_MINUTES * 60 * 1000);
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatShiftedDate(date, withYear) {
  const monthDay = pad(date.getUTCMonth() + 1) + '-' + pad(date.getUTCDate());
  const clock = pad(date.getUTCHours()) + ':' + pad(date.getUTCMinutes());
  if (!withYear) {
    return monthDay + ' ' + clock;
  }
  return date.getUTCFullYear() + '-' + monthDay + ' ' + clock;
}

function formatDateTime(value) {
  const date = toShanghaiDate(value);
  if (!date) {
    return '';
  }
  return formatShiftedDate(date, false);
}

function formatFullDateTime(value) {
  const date = toShanghaiDate(value);
  if (!date) {
    return '';
  }
  return formatShiftedDate(date, true);
}

function formatTime(value) {
  const date = toShanghaiDate(value);
  if (!date) {
    return '';
  }
  return pad(date.getUTCHours()) + ':' + pad(date.getUTCMinutes());
}

function formatRelative(value, now) {
  const date = toShanghaiDate(value);
  if (!date) {
    return '';
  }
  const current = toShanghaiDate(now || Date.now());
  const diffMinutes = Math.floor((current.getTime() - date.getTime()) / 60000);
  if (diffMinutes < 1) {
    return '刚刚';
  }
  if (diffMinutes < 60) {
    return diffMinutes + ' 分钟前';
  }
  if (diffMinutes < 24 * 60) {
    return Math.floor(diffMinutes / 60) + ' 小时前';
  }
  return formatShiftedDate(date, false);
}

function fulfillmentText(order) {
  if (!order) {
    return '';
  }
  if (order.fulfillmentType === 'DINE_IN') {
    return order.tableName ? '堂食 · ' + order.tableName + ' 桌' : '堂食';
  }
  return '到店自取';
}

function itemSummary(items, limit) {
  const list = Array.isArray(items) ? items : [];
  const max = Number.isFinite(limit) ? limit : 3;
  const names = list.slice(0, max).map((item) => item.name + ' ×' + item.quantity);
  const rest = list.length - names.length;
  const text = names.join('、');
  return rest > 0 ? text + ' 等 ' + list.length + ' 项' : text;
}

function toOrderItemViews(items) {
  const list = Array.isArray(items) ? items : [];
  return list.map((item) => ({
    productId: item.productId,
    name: item.name,
    quantity: item.quantity,
    unitPriceText: money.formatCents(item.unitPriceCents),
    lineTotalText: money.formatCents(item.lineTotalCents),
  }));
}

function buildTimeline(statusHistory) {
  const logs = Array.isArray(statusHistory) ? statusHistory : [];
  return logs.map((log) => ({
    id: log.id,
    title: orderStatus.statusText(log.toStatus),
    timeText: formatFullDateTime(log.createdAt),
    actorText: log.actorType === 'MERCHANT' ? '店主' : log.actorType === 'SYSTEM' ? '系统' : '顾客',
    reason: log.reason || '',
    tone: orderStatus.statusTone(log.toStatus),
  }));
}

function toOrderView(order, now) {
  if (!order || !order.id) {
    return null;
  }
  const actions = orderStatus.customerActions(order);
  return Object.assign({}, order, {
    shortId: String(order.id).slice(-6).toUpperCase(),
    statusText: orderStatus.statusText(order.status),
    statusTone: orderStatus.statusTone(order.status),
    paymentText: orderStatus.paymentText(order.paymentStatus),
    hint: orderStatus.customerHint(order.status),
    totalText: money.formatCents(order.totalCents),
    createdAtText: formatDateTime(order.createdAt),
    createdAtFullText: formatFullDateTime(order.createdAt),
    updatedAtText: formatDateTime(order.updatedAt),
    relativeTime: formatRelative(order.createdAt, now),
    fulfillmentText: fulfillmentText(order),
    itemSummary: itemSummary(order.items),
    itemViews: toOrderItemViews(order.items),
    canPay: actions.canPay,
    canCancel: actions.canCancel,
    progressSteps: orderStatus.buildProgressSteps(order.status),
    timeline: buildTimeline(order.statusHistory),
    noteText: order.note || '',
  });
}

function toOrderListView(payload, now) {
  const data = payload && typeof payload === 'object' ? payload : {};
  const items = Array.isArray(data.items) ? data.items : [];
  return {
    items: items.map((order) => toOrderView(order, now)).filter(Boolean),
    page: data.page || 1,
    pageSize: data.pageSize || 20,
    total: data.total || items.length,
  };
}

function toMerchantOrderView(order, now) {
  const view = toOrderView(order, now);
  if (!view) {
    return null;
  }
  return Object.assign(view, {
    actions: orderStatus.merchantActions(order),
    waitText: order.createdAt ? '下单 ' + formatRelative(order.createdAt, now) : '',
    unpaid: order.status === orderStatus.ORDER_STATUS.PENDING_PAYMENT,
  });
}

module.exports = {
  SHANGHAI_OFFSET_MINUTES,
  WEEKDAYS,
  toShanghaiDate,
  formatDateTime,
  formatFullDateTime,
  formatTime,
  formatRelative,
  fulfillmentText,
  itemSummary,
  toOrderItemViews,
  buildTimeline,
  toOrderView,
  toOrderListView,
  toMerchantOrderView,
};