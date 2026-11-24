import { useRef, useState } from 'react';
import {
  STORE_NAME_LIMIT_NOTICE,
  STORE_NAME_MAX_LENGTH,
  STORE_NAME_TRUNCATED_NOTICE,
  countStoreNameChars,
  describeStoreNameLength,
  truncateStoreName,
} from '../../domain/storeName.mjs';

/**
 * 店名字段（R3 问题 7）：输入、粘贴、拖拽、AI 回填都受同一个 20 字上限约束。
 *
 * 为什么不用 `maxLength`：它按 UTF-16 码元数截断，会把 emoji / 代理对切半。
 * 这里一律按「用户可见字符」裁剪，并且在输入时就裁——绝不出现「先让你写 48 字、
 * 保存时再悄悄砍成 20」。
 *
 * 中文输入法：composing 期间原样放行（组合中的拼音不是最终文本），
 * compositionend 时才按上限收敛，不会在拼字中间把字吃掉。
 */
export default function StoreNameField({
  value = '',
  onChange,
  disabled = false,
  placeholder = '',
  inputId,
  inputClassName = 'agent-input',
  labelId,
  describedBy,
  invalid = false,
}) {
  const composingRef = useRef(false);
  const [notice, setNotice] = useState('');
  const { length, atLimit } = describeStoreNameLength(value);

  const commit = (raw, { fromPaste = false } = {}) => {
    const { value: next, truncated } = truncateStoreName(raw);
    if (next !== raw) {
      setNotice(fromPaste ? STORE_NAME_TRUNCATED_NOTICE : '');
    } else if (fromPaste) {
      setNotice('');
    }
    onChange?.(next);
  };

  const handleChange = (event) => {
    const raw = event.target.value;
    if (composingRef.current) {
      // 组合中：先原样交给受控 state，避免打断输入法；结束时会再收敛一次。
      onChange?.(raw);
      return;
    }
    commit(raw);
  };

  const handleCompositionStart = () => { composingRef.current = true; };
  const handleCompositionEnd = (event) => {
    composingRef.current = false;
    commit(event.currentTarget.value);
  };

  const handlePaste = (event) => {
    const text = event.clipboardData?.getData('text/plain');
    if (typeof text !== 'string') return; // 没有文本（例如纯图片）就走浏览器默认行为
    event.preventDefault();
    if (disabled) return;
    const node = event.currentTarget;
    const start = node.selectionStart ?? value.length;
    const end = node.selectionEnd ?? value.length;
    const combined = `${value.slice(0, start)}${text}${value.slice(end)}`;
    // 粘进来的内容本身就超长时按「粘贴内容优先」处理：直接取粘贴文本的前 20 字，
    // 否则用户会看到「已截断」却什么也没变（原内容把新内容挤掉了）。
    const next = countStoreNameChars(combined) > STORE_NAME_MAX_LENGTH && start === end
      ? text
      : combined;
    commit(next, { fromPaste: true });
  };

  const handleDrop = (event) => {
    const text = event.dataTransfer?.getData('text/plain');
    if (typeof text !== 'string' || !text) return;
    event.preventDefault();
    if (disabled) return;
    commit(`${value}${text}`, { fromPaste: true });
  };

  return (
    <div className="store-name-field">
      <div className="store-name-input-row">
        <input
          id={inputId}
          className={`${inputClassName}${invalid ? ' is-invalid' : ''}`}
          type="text"
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          aria-labelledby={labelId || undefined}
          aria-describedby={describedBy || undefined}
          onChange={handleChange}
          onPaste={handlePaste}
          onDrop={handleDrop}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
        />
        <span
          className={`store-name-counter${atLimit ? ' is-at-limit' : ''}`}
          aria-live="polite"
          aria-label={`店名当前 ${length} 个字，上限 ${STORE_NAME_MAX_LENGTH} 个字`}
        >
          {length}/{STORE_NAME_MAX_LENGTH}
        </span>
      </div>
      {notice ? (
        <p className="store-name-notice" role="status">
          {notice}
        </p>
      ) : atLimit ? (
        <p className="store-name-notice is-soft" role="status">
          {STORE_NAME_LIMIT_NOTICE}
        </p>
      ) : null}
    </div>
  );
}
