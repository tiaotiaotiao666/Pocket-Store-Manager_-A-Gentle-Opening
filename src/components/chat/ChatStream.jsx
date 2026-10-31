import { useEffect, useRef } from 'react';
import { useSequentialReveal } from '../../hooks/useSequentialReveal.js';
import MessageBubble from './MessageBubble.jsx';
import TypingDots from './TypingDots.jsx';

export default function ChatStream({ messages = [], revealKey, flushKey = 0, children }) {
  const { visible, typing } = useSequentialReveal(messages, { revealKey, flushKey });
  const scrollRef = useRef(null);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' });
  }, [visible.length]);

  return (
    <section className="chat-stream" ref={scrollRef}>
      <div className="chat-stream-inner">
        {visible.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}
        {typing ? <TypingDots label="轻启正在输入" /> : null}
        {children}
      </div>
    </section>
  );
}