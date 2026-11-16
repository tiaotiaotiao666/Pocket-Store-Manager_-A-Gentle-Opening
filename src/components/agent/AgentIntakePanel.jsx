import {
  AlertCircle,
  Check,
  CircleDashed,
  Loader,
  RotateCcw,
  Sparkles,
  TriangleAlert,
  X,
} from 'lucide-react';

const STATUS_LABELS = {
  idle: '等待输入',
  requesting: '正在整理',
  reviewing: '可以确认',
  confirmed: '已确认',
  failed: '请求失败',
};

function statusLabel(status, missingCount) {
  if (status === 'collecting') return `还差 ${missingCount} 项`;
  return STATUS_LABELS[status] ?? '等待输入';
}

function uniqueFieldErrors(errors) {
  const seen = new Map();
  for (const error of errors) {
    if (!seen.has(error.field)) seen.set(error.field, error);
  }
  return [...seen.values()];
}

/** 步骤状态必须同时有文字说明：只靠颜色/图标对读屏和色弱用户不友好。 */
const STEP_STATE_TEXT = {
  done: '已完成',
  failed: '未成功',
  active: '进行中',
  pending: '等待中',
  partial: '不完整',
};

const STEP_STATE_ICONS = {
  done: Check,
  failed: X,
  active: Loader,
  pending: CircleDashed,
  partial: TriangleAlert,
};

const TONE_ICONS = {
  running: Loader,
  partial: TriangleAlert,
  done: Check,
  failed: AlertCircle,
  idle: CircleDashed,
};

function ProcessCard({ process, processHistory = [], attempts = 0, onRetry }) {
  const ToneIcon = TONE_ICONS[process.tone] ?? CircleDashed;
  const history = Array.isArray(processHistory) ? processHistory : [];

  return (
    <section
      className={`agent-process is-${process.tone}`}
      role="group"
      aria-label={`本轮处理过程：${process.title}`}
    >
      <header className="agent-process-head">
        <span className="agent-process-badge">
          <ToneIcon size={14} aria-hidden="true" />
          {process.title}
        </span>
        {process.headline ? <span className="agent-process-headline">{process.headline}</span> : null}
      </header>

      {process.steps.length ? (
        <ol className="agent-process-steps" aria-label="处理步骤">
          {process.steps.map((step) => {
            const Icon = STEP_STATE_ICONS[step.state] ?? CircleDashed;
            return (
              <li key={step.id} className={`agent-process-step is-${step.state}`}>
                <Icon size={14} className="agent-process-step-icon" aria-hidden="true" />
                <span className="agent-process-step-label">{step.label}</span>
                <span className="agent-process-step-state">{STEP_STATE_TEXT[step.state] ?? ''}</span>
                {step.detail ? <span className="agent-process-step-detail">{step.detail}</span> : null}
              </li>
            );
          })}
        </ol>
      ) : null}

      {process.notice ? (
        <p className="agent-process-notice" role="status">{process.notice}</p>
      ) : null}

      {process.summary.length ? (
        <div className="agent-process-changes">
          <p className="agent-process-changes-title">本轮改动</p>
          <ul aria-label="本轮修改摘要">
            {process.summary.map((item) => (
              <li key={item} className="agent-process-change-item">{item}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {process.retryable ? (
        <div className="agent-process-actions">
          <button type="button" className="agent-btn agent-btn-primary" onClick={() => onRetry?.()}>
            <RotateCcw size={14} />
            重试这次请求
          </button>
          <span className="agent-process-tip">
            也可以直接修改右侧草稿或继续输入{attempts ? ` · 第 ${attempts} 次尝试` : ''}。
          </span>
        </div>
      ) : null}

      {history.length ? (
        <details className="agent-process-history">
          <summary>查看历史轮次（{history.length}）</summary>
          <ul aria-label="历史轮次摘要">
            {history.map((round) => (
              <li key={round.roundId} className={`agent-process-history-item is-${round.tone}`}>
                <span className="agent-process-history-title">{round.title}</span>
                <span className="agent-process-history-text">{round.headline}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

export default function AgentIntakePanel({
  status = 'idle',
  transportLabel = '本地 Mock（未接入真实模型）',
  transportMode = 'mock',
  reply = '',
  missingFields = [],
  errors = [],
  nextQuestion = null,
  lastError = null,
  attempts = 0,
  simulateFailure = false,
  process = null,
  processHistory = [],
  staleDraftNotice = null,
  hint = null,
  onRetry,
  onToggleSimulateFailure,
}) {
  const fieldErrors = uniqueFieldErrors(errors);
  const shownErrors = fieldErrors.slice(0, 3);
  const hiddenErrorCount = Math.max(0, fieldErrors.length - shownErrors.length);
  const message = reply || nextQuestion?.text || '';

  return (
    <section className="agent-panel" aria-label="开店资料助手">
      <header className="agent-panel-head">
        <div className={`agent-status agent-status-${status}`}>
          <span className="agent-status-dot" aria-hidden="true" />
          <span>{statusLabel(status, missingFields.length)}</span>
        </div>
        <span
          className="agent-transport-badge"
          data-transport={transportMode}
          title="当前为本地规则解析，未调用任何真实模型"
        >
          <Sparkles size={13} />
          {transportLabel}
        </span>
      </header>

      {message ? (
        <div className="agent-reply" aria-live="polite">
          <span className="agent-reply-icon" aria-hidden="true"><Sparkles size={15} /></span>
          <p>{message}</p>
        </div>
      ) : null}

      {/* 唯一主过程卡：处理中 / 部分完成 / 完成 / 失败可重试都在这一张卡里表达。 */}
      {process ? (
        <ProcessCard
          process={process}
          processHistory={processHistory}
          attempts={attempts}
          onRetry={onRetry}
        />
      ) : lastError ? (
        <div className="agent-notice" role="alert">
          <AlertCircle size={14} aria-hidden="true" />
          <span>{lastError.message}</span>
        </div>
      ) : null}

      {missingFields.length ? (
        <div className="agent-missing-list" aria-label="还缺的资料">
          {missingFields.map((item) => (
            <a
              key={item.field}
              className="agent-missing-chip"
              href={`#agent-field-${item.field}`}
            >
              <span className="agent-missing-label">{item.label}</span>
              <span className="agent-missing-detail">{item.detail}</span>
            </a>
          ))}
        </div>
      ) : null}

      {shownErrors.length ? (
        <ul className="agent-error-list" aria-label="字段错误">
          {shownErrors.map((error) => (
            <li key={`${error.field}-${error.code}`} className="agent-error-item">
              <AlertCircle size={14} />
              <span>{error.message}</span>
            </li>
          ))}
          {hiddenErrorCount ? (
            <li className="agent-error-more">另有 {hiddenErrorCount} 项需要修正</li>
          ) : null}
        </ul>
      ) : null}

      {staleDraftNotice ? (
        <div className="agent-notice" role="status">
          <Sparkles size={14} aria-hidden="true" />
          <span>{staleDraftNotice.message}</span>
        </div>
      ) : null}

      {hint ? (
        <div className="agent-notice" role="status">
          <Sparkles size={14} aria-hidden="true" />
          <span>{hint.message}</span>
        </div>
      ) : null}

      {transportMode === 'mock' ? (
        <label className="agent-simulate-switch">
          <input
            type="checkbox"
            checked={Boolean(simulateFailure)}
            onChange={(event) => onToggleSimulateFailure?.(event.target.checked)}
          />
          <span className="agent-simulate-track" aria-hidden="true"><span /></span>
          <span className="agent-simulate-text">
            下一次请求模拟失败
            {simulateFailure ? <em className="agent-armed">已武装</em> : null}
          </span>
        </label>
      ) : null}

    </section>
  );
}
