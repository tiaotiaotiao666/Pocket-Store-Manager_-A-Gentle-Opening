import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { nextRevealCount } from './revealTransition.mjs';

export function useSequentialReveal(
  messages,
  { revealKey = 'default', flushKey = 0, revealAll = false, interval = 720 } = {},
) {
  const [visibleCount, setVisibleCount] = useState(() => (revealAll ? messages.length : 0));
  const tracker = useRef({ revealKey, flushKey });

  // 布局阶段同步，切回历史会话时不会先闪出上一条会话的可见条数。
  useLayoutEffect(() => {
    const count = nextRevealCount(tracker.current, {
      revealKey,
      flushKey,
      revealAll,
      messageCount: messages.length,
    });
    tracker.current = { revealKey, flushKey };
    if (count !== null) setVisibleCount(count);
  }, [revealKey, flushKey, revealAll, messages.length]);

  useEffect(() => {
    if (visibleCount >= messages.length) return undefined;
    const next = messages[visibleCount];
    const delay = next.instant ? 0 : (next.delay ?? interval);
    const timer = setTimeout(() => setVisibleCount((count) => count + 1), delay);
    return () => clearTimeout(timer);
  }, [visibleCount, messages, interval]);

  return {
    visible: messages.slice(0, visibleCount),
    typing: visibleCount < messages.length,
  };
}
