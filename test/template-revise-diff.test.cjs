'use strict';

/**
 * 「对话式改模板」字段级前后对比的回归。
 *
 * 背景：走查曾误判「只显示自然语言回复、没有字段级清单」。
 * 实际 `diffPresentationPatch` 会产出 { path, label, before, after }，
 * `TemplateRevisePanel` 逐项渲染并展示 path（如 theme.primaryColor）。
 * 这里锁住数据形状与渲染结构，防止后续把 path 或 before→after 去掉。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');

test('diffPresentationPatch 产出带 path/label 的字段级差异', async () => {
  const { diffPresentationPatch } = await import('../src/domain/presentationPatch.mjs');
  const changes = diffPresentationPatch(
    { theme: { primaryColor: '#111111' }, sizes: { productCard: 'md' } },
    { theme: { primaryColor: '#1F5C4A' }, sizes: { productCard: 'lg' } },
  );
  const theme = changes.find((item) => item.path === 'theme.primaryColor');
  const size = changes.find((item) => item.path === 'sizes.productCard');
  assert.ok(theme, '应包含 theme.primaryColor');
  assert.equal(theme.before, '#111111');
  assert.equal(theme.after, '#1F5C4A');
  assert.ok(theme.label, '应带可读 label');
  assert.ok(size, '应包含 sizes.productCard');
  assert.equal(size.after, 'lg');
});

test('TemplateRevisePanel 渲染 path 与 before → after', () => {
  const panel = fs.readFileSync(
    path.join(REPO, 'src', 'components', 'flow', 'TemplateRevisePanel.jsx'),
    'utf8',
  );
  assert.match(panel, /className="template-revise-change-path"/);
  assert.match(panel, /\{item\.path\}/);
  assert.match(panel, /本轮已应用 \$\{changes\.length\} 项/);
  assert.match(panel, /describeValue\(item\?\.before\)/);
  assert.match(panel, /describeValue\(item\?\.after\)/);
});

test('.template-revise-change-path 有样式依托', () => {
  const css = fs.readFileSync(path.join(REPO, 'src', 'styles', 'flow.css'), 'utf8');
  assert.match(css, /\.template-revise-change-path\s*\{/);
});
