/**
 * UX0a-1：统一对话流。
 *
 * 全部阶段会话的消息按顺序合并成一条流，并且使用**稳定的展示语义**：
 *   - revealKey 恒为常量：新增/切换会话不会让它变化；
 *   - revealAll 恒为 true：历史整段可见、新消息立即出现、不重播入场动画。
 *
 * 这样 useSequentialReveal 的 nextRevealCount 永远不会因为"换了个会话"而把
 * visibleCount 重置成 0 —— 那正是 UX0a 要修的消息消失问题。
 */

export const CONVERSATION_REVEAL_KEY = 'conversation';

export function buildConversationStream(sessions) {
  const list = Array.isArray(sessions) ? sessions : [];
  const messages = [];
  for (const session of list) {
    if (session && Array.isArray(session.messages)) messages.push(...session.messages);
  }
  return {
    messages,
    revealKey: CONVERSATION_REVEAL_KEY,
    revealAll: true,
  };
}
