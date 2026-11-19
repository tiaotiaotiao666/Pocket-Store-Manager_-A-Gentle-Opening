import { FolderKanban, Settings, Sparkles } from 'lucide-react';

const MODE_LABEL = {
  desktop: '桌面版 · 数据存在本机',
  browser: '浏览器预览 · 不保存',
};

export default function Sidebar({
  appName = '口袋店长·轻启',
  sessions = [],
  activeSessionId,
  currentStoreName,
  saveLabel = { tone: 'saved', text: '尚未保存' },
  mode = 'desktop',
  modelLabel = '',
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
          <span className="sidebar-brand-sub">会说话的店长，帮你把店开起来</span>
        </div>
      </div>

      <div className="sidebar-nav" role="navigation" aria-label="主导航">
        <button type="button" className="sidebar-nav-item" onClick={onOpenWorkbench} aria-label="我的项目：打开工作台">
          <FolderKanban size={15} />
          我的项目
        </button>
        <button type="button" className="sidebar-nav-item" onClick={onOpenSettings} aria-label="设置与自检：打开设置面板">
          <Settings size={15} />
          设置与自检
        </button>
      </div>

      <div className="sidebar-cta">
        <button type="button" className="sidebar-primary" onClick={onStartOnboarding} aria-label="开始开店：进入开店流程">
          开始开店
        </button>
        {currentStoreName ? null : (
          <button type="button" className="sidebar-subitem" onClick={onStartOnboarding} aria-label="待命名项目：开始命名">
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
                  aria-label={`会话：${session.title}`}
                  aria-current={session.id === activeSessionId ? 'true' : undefined}
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
          {modelLabel ? <span className="sidebar-status-line is-agent">{modelLabel}</span> : null}
        </div>
        <button type="button" className="sidebar-reset" onClick={onReset} aria-label="重置项目：清空当前会话">
          重置项目
        </button>
      </div>
    </div>
  );
}
