import { ArrowUp } from 'lucide-react';
import { analyzeComposerInput } from '../../domain/composerInput.mjs';

export default function Composer({
  value = '',
  placeholder,
  submitLabel = '发送',
  disabled = false,
  submitDisabled = disabled,
  maxChars,
  hint,
  actions = null,
  onChange,
  onSubmit,
}) {
  const analysis = analyzeComposerInput(value, Number.isInteger(maxChars) ? { maxChars } : {});
  // 空白、超限都不允许发送；处理中沿用外部传入的 submitDisabled。
  const blocked = submitDisabled || !analysis.canSubmit;

  const handleKeyDown = (event) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    if (blocked) return;
    onSubmit?.(analysis.text);
  };

  const handleSubmit = () => {
    if (blocked) return;
    onSubmit?.(analysis.text);
  };

  return (
    <div className="composer" role="group" aria-label="消息输入区">
      {hint ? <p className="composer-hint">{hint}</p> : null}
      <div className={`composer-box${disabled ? ' is-disabled' : ''}${analysis.overLimit ? ' is-over-limit' : ''}`}>
        {actions ? <span className="composer-tools">{actions}</span> : null}
        <textarea
          className="composer-input"
          rows={1}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          aria-label={placeholder || '输入消息'}
          aria-describedby={analysis.notice ? 'composer-notice' : undefined}
          aria-invalid={analysis.overLimit ? 'true' : undefined}
          onChange={(event) => onChange?.(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        {analysis.showCounter ? (
          <span
            className={`composer-counter${analysis.overLimit ? ' is-over' : ''}`}
            aria-label={`已输入 ${analysis.length} 字，上限 ${analysis.maxChars} 字`}
          >
            {analysis.length}/{analysis.maxChars}
          </span>
        ) : null}
        <button
          type="button"
          className="composer-send"
          disabled={blocked}
          onClick={handleSubmit}
          aria-label={submitLabel}
        >
          <span>{submitLabel}</span>
          <ArrowUp size={15} />
        </button>
      </div>
      {analysis.notice ? (
        <p className="composer-notice" id="composer-notice" role="status">{analysis.notice}</p>
      ) : null}
    </div>
  );
}
