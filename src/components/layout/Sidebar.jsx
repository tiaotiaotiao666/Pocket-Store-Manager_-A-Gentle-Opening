import { Sparkles } from 'lucide-react';

export default function Sidebar({
  appName = '智能开店',
  sessions = [],
  activeSessionId,
  currentStoreName,
  onStartOnboarding,
  onSelectSession,
  onReset,
}) {
  return (
    <div className="sidebar">
      <div className="sidebar-brand">
        <span className="sidebar-brand-mark">
          <Sparkles size={16} />
        </span>
        <div className="sidebar-brand-text">
          <span className="sidebar-brand-name">{appName}</span>
          <span className="sidebar-brand-sub">轻启 · 会话式生成器</span>
        </div>
      </div>

      <div className="sidebar-cta">
        <button type="button" className="sidebar-primary" onClick={onStartOnboarding}>
          轻启
        </button>
        {currentStoreName ? null : (
          <button type="button" className="sidebar-subitem" onClick={onStartOnboarding}>
            待命名项目
          </button>
        )}
      </div>

      <div className="sidebar-section">
        <span className="sidebar-section-label">会话记录</span>
        <ul className="sidebar-sessions">
          {sessions.map((session) => {
            const step = session.kind === 'step';
            return (
              <li key={session.id}>
                <button
                  type="button"
                  className={`sidebar-session${step ? ' is-step' : ' is-main'}${session.id === activeSessionId ? ' is-active' : ''}`}
                  onClick={() => onSelectSession?.(session.id)}
                >
                  <span className="sidebar-session-dot" aria-hidden="true" />
                  <span className="sidebar-session-title">{session.title}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="sidebar-foot">
        <span className="sidebar-status">本地演示模式 · 未连接大模型</span>
        <button type="button" className="sidebar-reset" onClick={onReset}>
          重置
        </button>
      </div>
    </div>
  );
}