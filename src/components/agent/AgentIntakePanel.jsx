import { AlertCircle, RotateCcw, Sparkles } from 'lucide-react';

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

      {status === 'requesting' ? (
        <div className="agent-progress" role="status" aria-live="polite">
          <span className="agent-progress-dots" aria-hidden="true"><i /><i /><i /></span>
          <span>正在整理资料，不会保存或发布任何内容。</span>
        </div>
      ) : null}

      {lastError ? (
        <div className="agent-failure" role="alert">
          <div className="agent-failure-head">
            <AlertCircle size={15} />
            <strong>{lastError.message}</strong>
          </div>
          <p className="agent-failure-note">
            本次不会保存或发布任何资料
            {attempts ? ` · 第 ${attempts} 次尝试` : ''}
          </p>
          {nextQuestion?.text ? (
            <p className="agent-failure-hint">可以继续补充：{nextQuestion.text}</p>
          ) : null}
          <div className="agent-failure-actions">
            {lastError.retryable !== false ? (
              <button type="button" className="agent-btn agent-btn-primary" onClick={() => onRetry?.()}>
                <RotateCcw size={14} />
                重试这次请求
              </button>
            ) : null}
            <span className="agent-failure-tip">也可以直接修改右侧草稿或继续输入。</span>
          </div>
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