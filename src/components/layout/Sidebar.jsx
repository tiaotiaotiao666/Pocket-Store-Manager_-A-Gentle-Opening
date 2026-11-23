import { Check, FolderKanban, Settings, Sparkles } from 'lucide-react';

const MODE_LABEL = {
  desktop: '桌面版 · 数据存在本机',
  browser: '浏览器预览 · 不保存',
};

export default function Sidebar({
  appName = '口袋店长·轻启',
  flow = null,
  currentStoreName,
  saveLabel = { tone: 'saved', text: '尚未保存' },
  mode = 'desktop',
  modelLabel = '',
  onStartOnboarding,
  onSelectStage,
  onOpenWorkbench,
  onOpenSettings,
  onReset,
}) {
  const steps = flow && Array.isArray(flow.steps) ? flow.steps : [];

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
        <span className="sidebar-section-label">开店步骤</span>
        {steps.length ? (
          <>
            <ol className="sidebar-stages" aria-label="开店步骤">
              {steps.map((step) => {
                const canVisit = step.canVisit === true;
                const stepNo = step.index + 1;
                const isCurrent = step.state === 'current';
                const goBack = step.index < (flow.currentIndex ?? 0);
                return (
                  <li key={step.key}>
                    <button
                      type="button"
                      className={`sidebar-stage is-${step.state}${canVisit ? ' can-visit' : ''}`}
                      onClick={canVisit ? () => onSelectStage?.(step.phase) : undefined}
                      disabled={!canVisit}
                      aria-current={isCurrent ? 'step' : undefined}
                      aria-label={canVisit
                        ? (goBack
                          ? `第 ${stepNo} 步 ${step.label}：返回这一步修改`
                          : `第 ${stepNo} 步 ${step.label}：回到这一步继续`)
                        : `第 ${stepNo} 步 ${step.label}`}
                      title={step.hint}
                    >
                      <span className="sidebar-stage-index" aria-hidden="true">
                        {step.visited && !isCurrent ? <Check size={11} /> : stepNo}
                      </span>
                      <span className="sidebar-stage-copy">
                        <span className="sidebar-stage-label">{step.label}</span>
                        <span className="sidebar-stage-hint">{step.hint}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
            <p className="sidebar-stages-note">退回去改完，点后面的步骤就能回到刚才那一步，已填内容会保留。</p>
          </>
        ) : (
          <p className="sidebar-stages-note">点「开始开店」后，这里会显示开店步骤。</p>
        )}
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
