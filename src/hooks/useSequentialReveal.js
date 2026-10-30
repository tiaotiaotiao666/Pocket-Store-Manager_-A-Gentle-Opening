import { useEffect, useRef, useState } from 'react';

export function useSequentialReveal(messages, { revealKey = 'default', interval = 720 } = {}) {
  const [visibleCount, setVisibleCount] = useState(0);
  const lastKey = useRef(revealKey);

  useEffect(() => {
    if (lastKey.current !== revealKey) {
      lastKey.current = revealKey;
      setVisibleCount(0);
    }
  }, [revealKey]);

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