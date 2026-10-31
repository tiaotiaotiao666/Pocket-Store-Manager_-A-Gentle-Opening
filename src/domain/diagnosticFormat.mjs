/**
 * 诊断格式（纯函数）。
 *
 * - 统一的 DiagnosticLine 结构；
 * - 复制文本组装；
 * - 递归脱敏：键名命中敏感词替换为 [redacted]，绝对路径替换为 [path]。
 *
 * 契约：docs/2026-10-31-P0工作台与交接-实现方案.md 6.2.2。
 */

export const DIAGNOSTIC_RESULTS = Object.freeze({
  PASS: 'pass',
  WARN: 'warn',
  FAIL: 'fail',
});

export const RESULT_LABELS = Object.freeze({
  pass: '通过',
  warn: '提醒',
  fail: '未通过',
});

const SENSITIVE_KEY_RE = /(key|secret|token|password|authorization|openid|cookie)/i;
const ABSOLUTE_PATH_RE = /^([A-Za-z]:[\\/]|\/|file:\/\/|\\\\[^\\])/;

export function createDiagnosticLine(input) {
  const source = input || {};
  const result = Object.prototype.hasOwnProperty.call(RESULT_LABELS, source.result) ? source.result : DIAGNOSTIC_RESULTS.FAIL;
  return {
    id: String(source.id || 'unknown'),
    title: String(source.title || '未命名检查'),
    result,
    message: String(source.message || ''),
    action: source.action ? String(source.action) : null,
    latencyMs: Number.isFinite(source.latencyMs) ? Math.max(0, Math.round(source.latencyMs)) : null,
  };
}

export function toCopyText(lines, json) {
  const list = Array.isArray(lines) ? lines.map(createDiagnosticLine) : [];
  const header = list
    .map((line) => `[${RESULT_LABELS[line.result]}] ${line.title}：${line.message}${line.action ? `（建议：${line.action}）` : ''}`)
    .join('\n');
  return [
    '# 智能开店诊断',
    '',
    header || '（没有检查结果）',
    '',
    '## 诊断 JSON（已脱敏：不含密钥、绝对路径与门店业务数据）',
    JSON.stringify(json || {}, null, 2),
  ].join('\n');
}

function scrubValue(value) {
  if (Array.isArray(value)) return value.map(scrubValue);
  if (value && typeof value === 'object') return scrubObject(value);
  if (typeof value === 'string' && ABSOLUTE_PATH_RE.test(value)) return '[path]';
  return value;
}

export function scrubObject(input) {
  if (!input || typeof input !== 'object') return input;
  if (Array.isArray(input)) return input.map(scrubValue);
  const output = {};
  for (const key of Object.keys(input)) {
    if (SENSITIVE_KEY_RE.test(key)) {
      output[key] = '[redacted]';
      continue;
    }
    output[key] = scrubValue(input[key]);
  }
  return output;
}

export function scrubDiagnosticJson(json) {
  return scrubObject(json || {});
}

export function countDiagnostics(lines) {
  const list = Array.isArray(lines) ? lines : [];
  return {
    passed: list.filter((line) => line.result === DIAGNOSTIC_RESULTS.PASS).length,
    warned: list.filter((line) => line.result === DIAGNOSTIC_RESULTS.WARN).length,
    failed: list.filter((line) => line.result === DIAGNOSTIC_RESULTS.FAIL).length,
  };
}