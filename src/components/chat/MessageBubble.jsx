import { Sparkles } from 'lucide-react';

function HandoffCard({ message }) {
  const fields = message?.meta?.fields ?? [];
  const to = message?.meta?.to;

  return (
    <div className="handoff-card">
      <div className="handoff-card-head">
        <span className="handoff-card-eyebrow">会话交接</span>
        {to ? <span className="handoff-card-to">{to}</span> : null}
      </div>
      <dl className="handoff-card-facts">
        {fields.map((field) => (
          <div className="handoff-card-fact" key={field.label}>
            <dt>{field.label}</dt>
            <dd>
              <span className="handoff-card-value">{field.value}</span>
              {field.note ? <span className="handoff-card-note">{field.note}</span> : null}
            </dd>
          </div>
        ))}
      </dl>
      <details className="handoff-card-more">
        <summary>查看完整交接</summary>
        <pre className="bubble-system-text">{message.text}</pre>
      </details>
    </div>
  );
}

export default function MessageBubble({ message }) {
  const role = message?.role ?? 'agent';
  const text = message?.text ?? '';
  const handoffFields = message?.meta?.kind === 'handoff' ? message.meta.fields : null;

  if (role === 'system') {
    if (Array.isArray(handoffFields) && handoffFields.length > 0) {
      return <HandoffCard message={message} />;
    }
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