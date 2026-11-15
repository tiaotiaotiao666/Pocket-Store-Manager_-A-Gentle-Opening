'use strict';

/**
 * 部署页导出前体检的可访问性/提示回归。
 *
 * 背景：两个「我已了解」复选框同名，agent 按名称定位会 AMBIGUOUS_TARGET；
 * 目标目录同名（E-TARGET-EXISTS）时页面缺少「换目录」的解释。
 * 这里锁住渲染结构，防止后续改动把这两点退回去。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const PANEL = fs.readFileSync(
  path.join(REPO, 'src', 'components', 'deploy', 'PreflightPanel.jsx'),
  'utf8',
);

test('体检勾选是 ARIA 自绘复选框，名称带 ruleId 且状态可读', () => {
  assert.match(PANEL, /role="checkbox"/);
  assert.match(PANEL, /aria-checked=\{acknowledged\.includes\(rule\.ruleId\)\}/);
  assert.match(PANEL, /aria-label=\{`我已了解：\$\{rule\.ruleId\}`\}/);
  assert.match(PANEL, /className="preflight-ack-box"/);
  assert.doesNotMatch(PANEL, /<input\s+type="checkbox"/, '原生 input 在 Chromium/UIA 下不可见，不要退回');
});

test('E-TARGET-EXISTS 时给出换目录/改名的解释，而不是只说「有 1 项需要先修正」', () => {
  assert.match(PANEL, /ruleId === 'E-TARGET-EXISTS'/);
  assert.match(PANEL, /目标目录已有同名工程，不会覆盖/);
  assert.match(PANEL, /className="preflight-target-hint" role="note"/);
});

test('.phase-return-banner 样式存在，返回部署的入口有样式依托', () => {
  const css = fs.readFileSync(path.join(REPO, 'src', 'styles', 'flow.css'), 'utf8');
  assert.match(css, /\.phase-return-banner\s*\{/);
});
