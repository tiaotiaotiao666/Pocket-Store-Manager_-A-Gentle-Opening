/**
 * E0-U1：utterance 输入（一句话说清想怎么改）。
 *
 * 边界：
 * - 受控组件，只吃 props；不读 `window.smartStore`、不调 IPC、不发模型请求；
 * - 长度上限来自 `e0UiContract.mjs`（与冻结的 utterance 上限同源，不在组件里写第二个数字）；
 * - `<label htmlFor>` + `aria-label` 双保险：UIA 树里 textarea 必须有可读名称；
 * - 空输入的提示用 `MISSING`，不把“没写需求”当作可以开始跑的理由。
 */

import { E0_LIMITS } from './e0UiContract.mjs';

export default function UtteranceInput({
  value = '',
  disabled = false,
  maxLength = E0_LIMITS.maxUtteranceChars,
  error = null,
  onChange,
}) {
  const text = typeof value === 'string' ? value : '';
  const trimmed = text.trim();
  const remaining = Math.max(0, maxLength - text.length);

  function handleChange(event) {
    const next = event && event.target ? event.target.value : '';
    if (typeof onChange === 'function') onChange(next.slice(0, maxLength));
  }

  return (
    <section className="e0-field" id="e0-utterance-field" role="group" aria-label="改造要求输入">
      <label className="e0-field-label" htmlFor="e0-utterance-input">用一句话说明想怎么改</label>
      <textarea
        id="e0-utterance-input"
        className="e0-textarea"
        aria-label="用一句话说明想怎么改"
        aria-describedby="e0-utterance-hint"
        rows={3}
        maxLength={maxLength}
        disabled={Boolean(disabled)}
        placeholder="例如：菜单页按分类横滑，菜品卡片更像这家店的实拍风格"
        value={text}
        onChange={handleChange}
      />
      <div className="e0-field-footer" id="e0-utterance-hint">
        <span className="e0-field-meta" role="note" aria-label="字数统计">
          已写 {text.length} / {maxLength} 字，还可写 {remaining} 字
        </span>
        {trimmed ? null : (
          <span className="e0-field-hint" role="note" aria-label="需求缺失提示">
            还没有写改造要求（MISSING）：至少要写一句话才能开始
          </span>
        )}
      </div>
      {error ? (
        <p className="e0-field-error" role="alert" aria-label="改造要求错误">
          {typeof error === 'string' ? error : (error.message || '改造要求不可用')}
        </p>
      ) : null}
    </section>
  );
}
