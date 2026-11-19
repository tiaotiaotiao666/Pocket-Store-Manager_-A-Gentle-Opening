/**
 * 模板页「一句话修改」面板（B3 收口版）。
 *
 * 只保留**一个主输入框**，先用模式开关说清这次要做什么，避免把两件事混成一件事：
 * - `revise`     修改当前页面：只改配色/尺寸/区块位置/文案，不换模板；
 * - `candidates` 重新匹配候选：按描述重新匹配整套骨架（会换模板）。
 *
 * 提交后就地给出：你刚才要求的原话、处理状态、成功/失败/不支持的原因、
 * 每一项 before → after，以及「撤销这次修改」。失败时保留原文可直接重试，
 * 不追加重复消息；失败也不改动当前预览（补丁只在 SUCCESS 时落地）。
 */

import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  FlaskConical,
  Loader2,
  RotateCcw,
  Sparkles,
  Undo2,
  Wand2,
  X,
} from 'lucide-react';

const DEFAULT_MAX_LENGTH = 500;

const MODES = Object.freeze({
  REVISE: 'revise',
  CANDIDATES: 'candidates',
});

const MODE_META = Object.freeze({
  [MODES.REVISE]: {
    label: '修改当前页面',
    action: '应用修改',
    busy: '修改中…',
    hint: '只调整当前模板的配色、尺寸、区块位置和文案，不会换模板。',
    placeholder: '例如：主色换成暖橙，首屏再大气一点',
  },
  [MODES.CANDIDATES]: {
    label: '重新匹配候选',
    action: '重新匹配',
    busy: '重新匹配中…',
    hint: '按这句话重新匹配整套骨架，可能会换成别的模板。',
    placeholder: '例如：想要更清爽的咖啡店风格，菜单放前面',
  },
});

function readStatus(presentation) {
  const status = presentation && typeof presentation === 'object' ? presentation.status : 'idle';
  if (status === 'revising' || status === 'failed') return status;
  return 'idle';
}

function readChanges(presentation) {
  return presentation && Array.isArray(presentation.changes) ? presentation.changes : [];
}

function readError(presentation) {
  const error = presentation && typeof presentation === 'object' ? presentation.error : null;
  if (!error) return null;
  if (typeof error === 'string') return { code: '', message: error };
  if (typeof error === 'object') {
    return {
      code: typeof error.code === 'string' ? error.code : '',
      message: typeof error.message === 'string' ? error.message : '',
    };
  }
  return null;
}

function describeValue(value) {
  if (value === null || value === undefined || value === '') return '未设置';
  return String(value);
}

export default function TemplateRevisePanel({
  presentation = null,
  templateName = '',
  canRevise = true,
  disabled = false,
  mock = false,
  refining = false,
  refineError = null,
  canUndo = false,
  onRevise,
  onRefine,
  onUndo,
  onClearError,
  onClose,
  maxLength = DEFAULT_MAX_LENGTH,
}) {
  const [mode, setMode] = useState(MODES.REVISE);
  const [text, setText] = useState('');
  const [dismissedErrorKey, setDismissedErrorKey] = useState('');
  // 「你刚才要求」：提交即记下原话，成功/失败都留在输入框旁边，不用回翻历史。
  const [lastRequest, setLastRequest] = useState(null);
  const status = readStatus(presentation);
  const changes = readChanges(presentation);
  const error = readError(presentation);
  const errorKey = error ? `${error.code}|${error.message}` : '';
  const visibleError = error && dismissedErrorKey !== errorKey ? error : null;
  const failed = status === 'failed';
  const busy = status === 'revising' || refining === true;
  const isMock = mock === true || presentation?.mock === true;
  const submittedRef = useRef('');

  const meta = MODE_META[mode];
  const trimmed = text.trim();
  const canSubmitThisMode = mode === MODES.REVISE
    ? (canRevise && typeof onRevise === 'function')
    : typeof onRefine === 'function';
  const canSubmit = canSubmitThisMode && !disabled && !busy && trimmed.length > 0;
  const modeDisabled = busy || disabled;

  const presentationUtterance = typeof presentation?.lastUtterance === 'string' ? presentation.lastUtterance : '';

  // 成功（idle 且无错误）后清空输入；失败时保留原文，方便直接改一句再试。
  useEffect(() => {
    if (!submittedRef.current) return;
    if (busy || failed || visibleError) return;
    if (mode === MODES.REVISE && presentationUtterance === submittedRef.current) {
      setText('');
      submittedRef.current = '';
    }
    if (mode === MODES.CANDIDATES && !refining && lastRequest?.mode === MODES.CANDIDATES) {
      setText('');
      submittedRef.current = '';
    }
  }, [busy, failed, visibleError, presentationUtterance, refining, mode, lastRequest]);

  useEffect(() => {
    if (!errorKey) setDismissedErrorKey('');
  }, [errorKey]);

  const dismissError = () => {
    if (errorKey) setDismissedErrorKey(errorKey);
    onClearError?.();
  };

  const submit = () => {
    if (!canSubmit) return;
    submittedRef.current = trimmed;
    setLastRequest({ mode, text: trimmed });
    if (mode === MODES.REVISE) onRevise?.(trimmed);
    else onRefine?.(trimmed);
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    submit();
  };

  const handleKeyDown = (event) => {
    // Enter 提交；Shift+Enter 换行，避免中文输入法里误触发。
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent?.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  const switchMode = (nextMode) => {
    if (modeDisabled || nextMode === mode) return;
    setMode(nextMode);
  };

  const statusText = busy
    ? (mode === MODES.CANDIDATES ? '正在按你的描述重新匹配候选…' : '正在按你的描述修改展示，请稍候…')
    : failed || visibleError
      ? '这次没有成功，下面写了原因；输入框里的话还在，可以直接改一句再试。'
      : changes.length
        ? `修改已应用，共 ${changes.length} 项（可撤销）。`
        : '';

  const unsupportedReason = !canSubmitThisMode
    ? (mode === MODES.REVISE
      ? '当前阶段不能修改页面展示，先确认模板后再来。'
      : '当前阶段不能重新匹配候选。')
    : '';

  return (
    <section
      className={`template-revise${failed ? ' is-failed' : ''}${busy ? ' is-busy' : ''}`}
      aria-label="模板修改"
    >
      <header className="template-revise-head">
        <div className="template-revise-heading">
          <span className="template-revise-kicker">
            <Sparkles size={13} />
            模板修改
          </span>
          <h4>一句话修改，先选这次要做什么</h4>
          <p>{meta.hint}</p>
        </div>
        <div className="template-revise-tools">
          {isMock ? (
            <span className="template-revise-mock" title="当前没有连接模型，改动由本地规则生成">
              <FlaskConical size={12} />
              本地演示
            </span>
          ) : null}
          {typeof onClose === 'function' ? (
            <button
              type="button"
              className="template-revise-close"
              onClick={onClose}
              aria-label="关闭模板修改面板"
            >
              <X size={14} />
            </button>
          ) : null}
        </div>
      </header>

      <div className="template-revise-modes" role="group" aria-label="选择修改方式">
        {Object.entries(MODE_META).map(([value, item]) => (
          <button
            key={value}
            type="button"
            className={`template-revise-mode${mode === value ? ' is-active' : ''}`}
            aria-pressed={mode === value}
            disabled={modeDisabled}
            onClick={() => switchMode(value)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <form className="template-revise-form" onSubmit={handleSubmit}>
        <input
          className="template-revise-input"
          type="text"
          value={text}
          maxLength={maxLength}
          disabled={modeDisabled}
          placeholder={meta.placeholder}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={handleKeyDown}
          aria-label={mode === MODES.CANDIDATES ? '输入一句重新匹配候选的描述' : '输入一句模板修改描述'}
        />
        <button type="submit" className="template-revise-button" disabled={!canSubmit}>
          {busy ? <Loader2 className="spin" size={15} /> : (mode === MODES.CANDIDATES ? <RotateCcw size={15} /> : <Wand2 size={15} />)}
          {busy ? meta.busy : meta.action}
        </button>
      </form>

      {unsupportedReason ? <p className="template-revise-hint">{unsupportedReason}</p> : null}

      {lastRequest ? (
        <p className="template-revise-echo" role="status">
          <b>你刚才要求：</b>
          <span>「{lastRequest.text}」</span>
          <em>{lastRequest.mode === MODES.CANDIDATES ? '重新匹配候选' : '修改当前页面'}</em>
        </p>
      ) : presentationUtterance ? (
        <p className="template-revise-echo" role="status">
          <b>你刚才要求：</b>
          <span>「{presentationUtterance}」</span>
          <em>修改当前页面</em>
        </p>
      ) : null}

      {statusText ? (
        <p className={`template-revise-status${busy ? ' is-busy' : ''}${failed || visibleError ? ' is-failed' : ''}`} role="status">
          {statusText}
        </p>
      ) : null}

      {visibleError ? (
        <div className="template-revise-error" role="alert">
          <AlertTriangle size={16} />
          <div className="template-revise-error-body">
            {visibleError.code ? <b>{visibleError.code}</b> : null}
            <p>{visibleError.message || '模板修改没有成功，请稍后再试。'}</p>
          </div>
          <button
            type="button"
            className="template-revise-error-close"
            onClick={dismissError}
            aria-label="关闭错误提示"
          >
            <X size={14} />
          </button>
        </div>
      ) : null}

      {refineError ? (
        <p className="template-revise-error-text" role="alert">
          {refineError.message || refineError}
        </p>
      ) : null}

      {changes.length ? (
        <div className={`template-revise-changes${failed ? ' is-stale' : ''}`}>
          <div className="template-revise-changes-head">
            <span>
              {failed
                ? `上一轮已经生效的修改（本次没有生效，共 ${changes.length} 项）`
                : `本轮已应用 ${changes.length} 项`}
            </span>
            {canUndo && !busy ? (
              <button type="button" className="template-revise-undo" onClick={() => onUndo?.()}>
                <Undo2 size={13} />
                撤销这次修改
              </button>
            ) : null}
          </div>
          <ul className="template-revise-change-list">
            {changes.map((item, index) => (
              <li className="template-revise-change" key={`${item?.path || 'change'}-${index}`}>
                <span className="template-revise-change-label">
                  {item?.label || item?.path || '展示项'}
                  {item?.path ? <code className="template-revise-change-path">{item.path}</code> : null}
                </span>
                <div className="template-revise-change-values">
                  <del>{describeValue(item?.before)}</del>
                  <ArrowRight size={12} />
                  <ins>{describeValue(item?.after)}</ins>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {!changes.length && !busy && !failed && !visibleError && !refineError ? (
        <p className="template-revise-hint">
          {mode === MODES.CANDIDATES
            ? `输入一句话后，会重新匹配候选${templateName ? `（当前是「${templateName}」）` : ''}。`
            : '输入一句话后，这里会列出每一项的前后变化。'}
        </p>
      ) : null}
    </section>
  );
}
