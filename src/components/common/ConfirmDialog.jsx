import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';

/**
 * 输入式二次确认。要求用户手动输入 expectedText 才能继续，避免误删。
 * 组件只收 props 与发事件，不做任何 IO。
 */
export default function ConfirmDialog({
  open = false,
  title = '确认操作',
  description = '',
  expectedText = '',
  placeholder = '',
  confirmLabel = '确认',
  cancelLabel = '取消',
  busy = false,
  tone = 'danger',
  onConfirm,
  onCancel,
}) {
  const [value, setValue] = useState('');

  useEffect(() => {
    if (open) setValue('');
  }, [open, expectedText]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape' && !busy) onCancel?.();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, busy, onCancel]);

  if (!open) return null;
  const matched = value === expectedText;

  return (
    <div className="confirm-backdrop" role="presentation">
      <div className={`confirm-card is-${tone}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="confirm-head">
          <span className="confirm-icon">
            <AlertTriangle size={16} />
          </span>
          <h3>{title}</h3>
        </header>
        {description ? <p className="confirm-description">{description}</p> : null}
        {expectedText ? (
          <label className="confirm-field">
            <span>请输入项目名「{expectedText}」以确认</span>
            <input
              type="text"
              value={value}
              placeholder={placeholder || expectedText}
              onChange={(event) => setValue(event.target.value)}
              disabled={busy}
              autoFocus
            />
          </label>
        ) : null}
        <footer className="confirm-actions">
          <button type="button" className="ghost-button" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className="danger-button"
            onClick={onConfirm}
            disabled={busy || (expectedText ? !matched : false)}
          >
            {busy ? '处理中…' : confirmLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}