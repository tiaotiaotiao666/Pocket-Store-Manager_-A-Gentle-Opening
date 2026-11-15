import { ArrowUp } from 'lucide-react';

export default function Composer({
  value = '',
  placeholder,
  submitLabel = '发送',
  disabled = false,
  submitDisabled = disabled,
  hint,
  onChange,
  onSubmit,
}) {
  const handleKeyDown = (event) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    if (submitDisabled) return;
    onSubmit?.(value);
  };

  const handleSubmit = () => {
    if (submitDisabled) return;
    onSubmit?.(value);
  };

  return (
    <div className="composer" role="group" aria-label="消息输入区">
      {hint ? <p className="composer-hint">{hint}</p> : null}
      <div className={`composer-box${disabled ? ' is-disabled' : ''}`}>
        <textarea
          className="composer-input"
          rows={1}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          aria-label={placeholder || '输入消息'}
          onChange={(event) => onChange?.(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        <button
          type="button"
          className="composer-send"
          disabled={submitDisabled}
          onClick={handleSubmit}
          aria-label={submitLabel}
        >
          <span>{submitLabel}</span>
          <ArrowUp size={15} />
        </button>
      </div>
    </div>
  );
}