export function nextRevealCount(previous, { revealKey, flushKey, messageCount }) {
  if (previous.revealKey !== revealKey) return 0;
  if (previous.flushKey !== flushKey) return messageCount;
  return null;
}