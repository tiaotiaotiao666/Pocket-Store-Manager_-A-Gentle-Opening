/**
 * 输入框校验与去重（W4）。
 *
 * - 纯空白（含全角空格、制表符、换行）不允许提交；
 * - 长度上限与 agent-run / agent-turn 的 utterance 上限一致，超限给出明确提示；
 * - 只裁掉首尾空白，中文、换行和正常标点原样保留；
 * - 连续点击/回车不得重复提交同一轮请求。
 */

export const COMPOSER_MAX_CHARS = 500;

/** 按码点计数：中文、emoji 都算一个字，避免把代理对拆开。 */
export function countChars(text) {
  return Array.from(String(text ?? '')).length;
}

export function analyzeComposerInput(value, options = {}) {
  const raw = String(value ?? '');
  const maxChars = Number.isInteger(options.maxChars) && options.maxChars > 0
    ? options.maxChars
    : COMPOSER_MAX_CHARS;
  const length = countChars(raw);
  // 只去掉首尾空白，中间的换行/缩进/标点保持原样。
  const text = raw.trim();
  const empty = text.length === 0;
  const overLimit = length > maxChars;

  let notice = '';
  if (empty) {
    notice = raw.length ? '只输入了空白字符，写点内容再发送。' : '';
  } else if (overLimit) {
    notice = `已输入 ${length} 字，超过上限 ${maxChars} 字，请精简后再发送。`;
  }

  return {
    raw,
    text,
    length,
    maxChars,
    remaining: Math.max(0, maxChars - length),
    empty,
    overLimit,
    canSubmit: !empty && !overLimit,
    // 长度条只在接近上限时打扰用户。
    showCounter: length >= Math.ceil(maxChars * 0.8),
    notice,
  };
}

/**
 * 提交去重：同一段文字在 `windowMs` 内只放行一次。
 * 用于兜住「连续点击发送 / 连按回车」造成的重复请求。
 */
export function createSubmitGuard(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const windowMs = Number.isInteger(options.windowMs) && options.windowMs >= 0 ? options.windowMs : 400;
  let lastText = '';
  let lastAt = 0;

  return {
    accept(value) {
      const text = String(value ?? '').trim();
      if (!text) return false;
      const at = now();
      if (text === lastText && at - lastAt < windowMs) return false;
      lastText = text;
      lastAt = at;
      return true;
    },
    reset() {
      lastText = '';
      lastAt = 0;
    },
    get lastAcceptedAt() {
      return lastAt;
    },
  };
}
