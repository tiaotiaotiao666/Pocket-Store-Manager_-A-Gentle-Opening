/**
 * 门店资料操作栏的摘要文案（唯一口径）。
 *
 * 抽到 domain 里是为了能被 node --test 直接覆盖：这句文案曾经在资料齐全时
 * 仍然显示「等待输入开店资料」，让用户以为还要继续输入，属于静默死路。
 */

export function storeInfoActionSummary(status, pendingCount = 0, canConfirm = false) {
  if (status === 'requesting') return '正在整理资料，请稍候';
  if (status === 'failed') return `请求失败，还有 ${pendingCount} 项待处理`;
  if (status === 'confirmed') return '资料已确认，正在写入门店信息';
  if (canConfirm) return '资料已齐全，可以继续';
  if (pendingCount > 0) return `还有 ${pendingCount} 项待补充`;
  return '等待输入开店资料';
}
