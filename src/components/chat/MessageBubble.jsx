import { Sparkles } from 'lucide-react';

/**
 * UX0-1：系统/交接消息只向用户呈现「当前阶段 + 下一步」。
 * 完整交接正文、payload、JSON 与内部功能 ID 仍然保存在状态与项目文件里，
 * 只是不再渲染到聊天区。
 */
function summarize(text) {
  const raw = String(text ?? '');
  if (!raw) return '';
  const withoutBlocks = raw
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\{[\s\S]*?\}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return withoutBlocks.length > 60 ? `${withoutBlocks.slice(0, 60)}…` : withoutBlocks;
}

function StageNotice({ message }) {
  const to = message?.meta?.to ?? message?.meta?.title ?? '';
  const next = message?.meta?.next ?? summarize(message?.text);
  return (
    <div className="bubble-stage" role="status">
      <span className="bubble-stage-eyebrow">{to ? `当前阶段 · ${to}` : '阶段更新'}</span>
      {next ? <span className="bubble-stage-next">下一步：{next}</span> : null}
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
