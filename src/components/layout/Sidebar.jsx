import { FolderKanban, Settings, Sparkles } from 'lucide-react';

const MODE_LABEL = {
  desktop: '桌面模式 · 本机落盘',
  browser: '浏览器预览 · 不落盘',
};

export default function Sidebar({
  appName = '智能开店',
  sessions = [],
  activeSessionId,
  currentStoreName,
  saveLabel = { tone: 'saved', text: '尚未保存' },
  mode = 'desktop',
  agentLabel = '本地 Mock（未接入真实模型）',
  onStartOnboarding,
  onSelectSession,
  onOpenWorkbench,
  onOpenSettings,
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

      <div className="sidebar-nav">
        <button type="button" className="sidebar-nav-item" onClick={onOpenWorkbench}>
          <FolderKanban size={15} />
          我的项目
        </button>
        <button type="button" className="sidebar-nav-item" onClick={onOpenSettings}>
          <Settings size={15} />
          设置与自检
        </button>
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
        <div className="sidebar-status-block">
          <span className="sidebar-status">{MODE_LABEL[mode] || MODE_LABEL.desktop}</span>
          <span className={`sidebar-status-line is-${saveLabel.tone}`}>
            <i aria-hidden="true" />
            {saveLabel.text}
          </span>
          <span className="sidebar-status-line is-agent">{agentLabel}</span>
        </div>
        <button type="button" className="sidebar-reset" onClick={onReset}>
          重置项目
        </button>
      </div>
    </div>
  );
}