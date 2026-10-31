/**
 * 支付结果视图映射（纯函数，便于 Node 测试）。
 *
 * 规则：
 * - DEMO_PAID 且未取消 → success
 * - 其余（UNPAID / PENDING_PAYMENT）→ pending
 * - 已取消 → 不展示结果页（null）
 * - 调用方可用 overrides 覆盖 state/title/description（loading/error）
 */

const CANCELLED = 'CANCELLED';
const DEMO_PAID = 'DEMO_PAID';

function buildPayResult(view, overrides) {
  if (!view || view.status === CANCELLED) {
    return null;
  }
  const base = Object.assign({
    shortId: view.shortId || '',
    totalText: view.totalText || '',
    fulfillmentText: view.fulfillmentText || '',
    title: '',
    description: '',
    requestId: '',
  }, overrides || {});
  if (view.paymentStatus === DEMO_PAID) {
    return Object.assign(base, { state: 'success' }, overrides || {});
  }
  return Object.assign(base, { state: 'pending' }, overrides || {});
}

function loadingPayResult(view) {
  return buildPayResult(view, {
    state: 'loading',
    title: '正在确认支付结果…',
    description: '请稍候，不要关闭页面。',
  });
}

function errorPayResult(view, described) {
  const source = described || {};
  return buildPayResult(view, {
    state: 'error',
    title: '支付未完成',
    description: source.message || '支付失败，请重试。',
    requestId: source.requestId || '',
  });
}

module.exports = {
  buildPayResult,
  loadingPayResult,
  errorPayResult,
  CANCELLED,
  DEMO_PAID,
};