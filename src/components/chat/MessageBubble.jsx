import { Sparkles } from 'lucide-react';

export default function MessageBubble({ message }) {
  const role = message?.role ?? 'agent';
  const text = message?.text ?? '';

  if (role === 'system') {
    return (
      <div className="bubble-system">
        <div className="bubble-system-head">会话交接</div>
        <pre className="bubble-system-text">{text}</pre>
      </div>
    );
  }

  if (role === 'user') {
    return (
      <div className="bubble-row bubble-row-user">
        <div className="bubble bubble-user">{text}</div>
      </div>
    );
  }

  return (
    <div className="bubble-row bubble-row-agent">
      <span className="bubble-avatar">
        <Sparkles size={15} />
      </span>
      <div className="bubble bubble-agent">{text}</div>
    </div>
  );
}