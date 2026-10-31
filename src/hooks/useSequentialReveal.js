import { useEffect, useRef, useState } from 'react';
import { nextRevealCount } from './revealTransition.mjs';

export function useSequentialReveal(
  messages,
  { revealKey = 'default', flushKey = 0, interval = 720 } = {},
) {
  const [visibleCount, setVisibleCount] = useState(0);
  const tracker = useRef({ revealKey, flushKey });

  useEffect(() => {
    const count = nextRevealCount(tracker.current, {
      revealKey,
      flushKey,
      messageCount: messages.length,
    });
    tracker.current = { revealKey, flushKey };
    if (count !== null) setVisibleCount(count);
  }, [revealKey, flushKey, messages.length]);

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