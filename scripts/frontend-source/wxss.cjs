'use strict';

/**
 * WXSS 检查。
 * - 真实 block/declaration 解析（parse.cjs），检查括号/注释/字符串闭合；
 * - 允许任意合法布局属性，不做属性白名单；
 * - 禁止静态外链（http/https/协议相对）；允许 data:、本地相对路径与 `{{...}}` 动态值；
 * - `@import` 同样禁止外链；动态 import 拒绝（WXSS 不支持模板插值）。
 */

const { parseWxss, collectWxssUrls, SourceParseError } = require('./parse.cjs');

function isExternalUrl(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  if (text.includes('{{')) return false;
  return /^(?:https?:)?\/\//i.test(text);
}

function extractImportValue(prelude) {
  const match = /["']([^"']+)["']/.exec(prelude || '');
  return match ? match[1] : String(prelude || '').trim();
}

function validateWxss(source, options) {
  const opts = options || {};
  const file = opts.file || 'fixture.wxss';
  const issues = [];
  let stylesheet;
  try {
    stylesheet = parseWxss(source);
  } catch (error) {
    if (error instanceof SourceParseError) {
      issues.push({ file, line: error.line, column: error.column, code: error.code, message: error.message.slice(0, 180), source: 'wxss' });
      return { issues, stylesheet: null };
    }
    throw error;
  }
  const { urls, imports } = collectWxssUrls(stylesheet);
  for (const url of urls) {
    if (isExternalUrl(url.value)) {
      issues.push({ file, line: url.line, column: url.column, code: 'WXSS_EXTERNAL_URL', message: 'WXSS 禁止静态外链：' + String(url.value).slice(0, 100), source: 'wxss' });
    }
  }
  for (const at of imports) {
    const value = extractImportValue(at.prelude);
    if (value.includes('{{')) {
      issues.push({ file, line: at.line, column: at.column, code: 'WXSS_DYNAMIC_IMPORT', message: 'WXSS @import 不允许动态表达式', source: 'wxss' });
      continue;
    }
    if (isExternalUrl(value)) {
      issues.push({ file, line: at.line, column: at.column, code: 'WXSS_EXTERNAL_IMPORT', message: 'WXSS 禁止外部 @import：' + value.slice(0, 100), source: 'wxss' });
    }
  }
  return { issues, stylesheet };
}

module.exports = {
  isExternalUrl,
  extractImportValue,
  validateWxss,
};
