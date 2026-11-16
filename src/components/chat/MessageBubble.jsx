import { Sparkles } from 'lucide-react';
import { stageNoticeFor } from './stageNotice.mjs';

/**
 * UX0a-2：系统/交接消息只显示受控的阶段名称与固定提示。
 * 交接正文、payload、JSON、字段名一律不上屏（数据本身照旧持久化）。
 */
function StageNotice({ message }) {
  const notice = stageNoticeFor(message);
  return (
    <div className="bubble-stage" role="status">
      <span className="bubble-stage-eyebrow">当前阶段：{notice.label}</span>
      <span className="bubble-stage-next">{notice.hint}</span>
    </div>
  );
}

/** UX0-3：Agent 自我介绍合并成一张欢迎卡，不再逐句气泡弹出。 */
function WelcomeCard({ message }) {
  const items = Array.isArray(message?.meta?.items) && message.meta.items.length
    ? message.meta.items
    : [message?.text].filter(Boolean);
  return (
    <article className="welcome-card" aria-label="轻启介绍">
      <header className="welcome-card-head">
        <span className="welcome-card-icon" aria-hidden="true">
          <Sparkles size={15} />
        </span>
        <h3 className="welcome-card-title">{message?.meta?.title || '欢迎使用轻启'}</h3>
      </header>
      <ul className="welcome-card-list">
        {items.map((line, index) => (
          <li key={`welcome-${index}`}>{line}</li>
        ))}
      </ul>
    </article>
  );
}

export default function MessageBubble({ message }) {
  const role = message?.role ?? 'agent';
  const text = message?.text ?? '';

  if (role === 'system') {
    return <StageNotice message={message} />;
  }

  if (role === 'user') {
    return (
      <div className="bubble-row bubble-row-user">
        <div className="bubble bubble-user">{text}</div>
      </div>
    );
  }

  if (message?.meta?.kind === 'welcome') {
    return <WelcomeCard message={message} />;
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
