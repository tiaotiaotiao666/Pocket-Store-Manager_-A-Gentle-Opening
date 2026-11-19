import { useEffect, useRef } from 'react';
import { useSequentialReveal } from '../../hooks/useSequentialReveal.js';
import MessageBubble from './MessageBubble.jsx';
import TypingDots from './TypingDots.jsx';

const PROCESS_STEP_STATES = Object.freeze({
  done: '已完成',
  failed: '未成功',
  active: '进行中',
  pending: '等待中',
  partial: '不完整',
});

/**
 * P6：过程卡只消费领域层算好的安全视图（`buildFrontendProcessView`）。
 *
 * 这里刻意不读取消息正文、不序列化 trace、不拼 HTML；只展示受控标签、
 * 真实 runId/attempt/状态/耗时与步骤。没有真实 `process` 时不渲染任何卡片，
 * 避免用固定假进度冒充真实运行。
 */
function ProcessSummary({ process }) {
  if (!process || !process.title) return null;
  const steps = Array.isArray(process.steps) ? process.steps : [];
  const metaLines = Array.isArray(process.metaLines)
    ? process.metaLines.filter((line) => typeof line === 'string' && line)
    : [];

  return (
    <section
      className={`chat-process is-${process.tone || 'idle'}`}
      role="group"
      aria-label={`本轮处理过程：${process.title}`}
    >
      <header className="chat-process-head">
        <span className="chat-process-badge">{process.title}</span>
        {process.headline ? <span className="chat-process-headline">{process.headline}</span> : null}
      </header>
      {metaLines.length ? (
        <p className="chat-process-meta" aria-label="用时">
          {metaLines.join(' · ')}
        </p>
      ) : null}
      {steps.length ? (
        <ol className="chat-process-steps" aria-label="处理步骤">
          {steps.map((step) => (
            <li key={step.id} className={`chat-process-step is-${step.state}`}>
              <span className="chat-process-step-label">{step.label}</span>
              <span className="chat-process-step-state">{PROCESS_STEP_STATES[step.state] || ''}</span>
              {step.detail ? <span className="chat-process-step-detail">{step.detail}</span> : null}
            </li>
          ))}
        </ol>
      ) : null}
      {process.notice ? <p className="chat-process-notice" role="status">{process.notice}</p> : null}
    </section>
  );
}

export { ProcessSummary };

export default function ChatStream({
  messages = [],
  revealKey,
  flushKey = 0,
  revealAll = false,
  process = null,
  children,
}) {
  const { visible, typing } = useSequentialReveal(messages, { revealKey, flushKey, revealAll });
  const scrollRef = useRef(null);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' });
  }, [visible.length]);

  return (
    <section className="chat-stream" ref={scrollRef}>
      <div className="chat-stream-inner">
        <ProcessSummary process={process} />
        {visible.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}
        {typing ? <TypingDots label="轻启正在输入" /> : null}
        {children}
      </div>
    </section>
  );
}
