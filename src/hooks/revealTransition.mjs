// 会话切换时不应重播历史消息：
// - revealAll 表示「这个会话已经展示过」，进入时直接显示全部历史；
// - flushKey 只在同一个会话内生效（跳过开场动画）。
export function nextRevealCount(previous, { revealKey, flushKey, messageCount, revealAll = false }) {
  if (previous.revealKey !== revealKey) return revealAll ? messageCount : 0;
  if (previous.flushKey !== flushKey) return messageCount;
  return null;
}
