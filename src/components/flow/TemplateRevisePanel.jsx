/**
 * 「对话修改当前模板」面板（`C-TEMPLATE-GALLERY@1`，plan.md 2.2.5）。
 *
 * 与「重新描述候选」是两个独立入口，本面板只做三件事：
 * 1. 收集一句话并交给 `onRevise`（父组件负责调服务、派发状态机动作）；
 * 2. 按 `presentation.status` 展示忙碌态 / 失败态；
 * 3. 逐条展示 `presentation.changes` 的 before → after。
 *
 * 关键约束：失败时**不得显示成功文案**；`changes` 若仍在，明确标注为「上一轮已生效」。
 * Mock 模式下显示「本地 Mock 演示」徽标，不得伪装成真实模型成功。
 */

import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  FlaskConical,
  Loader2,
  Sparkles,
  Wand2,
  X,
} from 'lucide-react';

const DEFAULT_MAX_LENGTH = 500;

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
  onRevise,
  onClearError,
  onClose,
  maxLength = DEFAULT_MAX_LENGTH,
}) {
  const [text, setText] = useState('');
  const [dismissedErrorKey, setDismissedErrorKey] = useState('');
  const status = readStatus(presentation);
  const changes = readChanges(presentation);
  const error = readError(presentation);
  const errorKey = error ? `${error.code}|${error.message}` : '';
  // 即使父组件没接 onClearError，错误也必须能被用户关掉：先本地隐藏，再回调父组件清状态。
  const visibleError = error && dismissedErrorKey !== errorKey ? error : null;
  const failed = status === 'failed';
  const busy = status === 'revising';
  const isMock = mock === true || presentation?.mock === true;
  const lastUtterance = typeof presentation?.lastUtterance === 'string' ? presentation.lastUtterance : '';
  const submittedRef = useRef('');

  const trimmed = text.trim();
  const canSubmit = canRevise
    && !disabled
    && !busy
    && trimmed.length > 0
    && typeof onRevise === 'function';

  // 成功（idle 且无错误）后清空输入；失败时保留原文，方便用户直接改一句再试。
  useEffect(() => {
    if (!submittedRef.current) return;
    if (busy) return;
    if (failed) return;
    if (lastUtterance && lastUtterance === submittedRef.current) {
      setText('');
      submittedRef.current = '';
    }
  }, [busy, failed, lastUtterance]);

  // 父组件清空 error 后，重置本地“已关闭”标记，让下一次错误能正常显示。
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
    onRevise(trimmed);
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    submit();
  };

  const handleKeyDown = (event) => {
    // Enter 提交；Shift+Enter 换行，避免中文输入法里误触发送。
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent?.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <section className={`template-revise${failed ? ' is-failed' : ''}${busy ? ' is-busy' : ''}`}>
      <header className="template-revise-head">
        <div className="template-revise-heading">
          <span className="template-revise-kicker">
            <Sparkles size={13} />
            对话修改
          </span>
          <h4>用一句话修改当前模板</h4>
          <p>
            只调整
            {templateName ? `「${templateName}」的` : '当前模板的'}
            配色、尺寸、区块位置和文案，不会替换模板。
          </p>
        </div>
        <div className="template-revise-tools">
          {isMock ? (
            <span className="template-revise-mock" title="当前没有真实模型，补丁由本地规则生成">
              <FlaskConical size={12} />
              本地 Mock 演示
            </span>
          ) : null}
          {typeof onClose === 'function' ? (
            <button
              type="button"
              className="template-revise-close"
              onClick={onClose}
              aria-label="关闭对话修改面板"
            >
              <X size={14} />
            </button>
          ) : null}
        </div>
      </header>

      <form className="template-revise-form" onSubmit={handleSubmit}>
        <input
          className="template-revise-input"
          type="text"
          value={text}
          maxLength={maxLength}
          disabled={disabled || busy}
          placeholder="例如：主色换成暖橙，首屏再大气一点"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={handleKeyDown}
          aria-label="输入一句模板修改描述"
        />
        <button
          type="submit"
          className="template-revise-button"
          disabled={!canSubmit}
        >
          {busy ? <Loader2 className="spin" size={15} /> : <Wand2 size={15} />}
          {busy ? '修改中…' : '应用修改'}
        </button>
      </form>

      {!canRevise ? (
        <p className="template-revise-hint">当前阶段还不可修改模板，先确认模板后再来。</p>
      ) : null}

      {busy ? (
        <div className="template-revise-busy" role="status">
          <Loader2 className="spin" size={14} />
          正在按你的描述修改展示，请稍候…
        </div>
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

      {changes.length ? (
        <div className={`template-revise-changes${failed ? ' is-stale' : ''}`}>
          <div className="template-revise-changes-head">
            {failed
              ? `上一轮已经生效的修改（本次没有生效，共 ${changes.length} 项）`
              : `本轮已应用 ${changes.length} 项`}
          </div>
          <ul className="template-revise-change-list">
            {changes.map((item, index) => (
              <li className="template-revise-change" key={`${item?.path || 'change'}-${index}`}>
                <span className="template-revise-change-label">{item?.label || item?.path || '展示项'}</span>
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

      {!changes.length && !busy && !failed && !visibleError ? (
        <p className="template-revise-hint">输入一句话后，这里会列出每一项的前后变化。</p>
      ) : null}
    </section>
  );
}