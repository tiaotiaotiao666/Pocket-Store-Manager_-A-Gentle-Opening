'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const FILES = {
  main: 'src/components/preview/MiniProgramPreview.jsx',
  shared: 'src/components/preview/PreviewShared.jsx',
  tabs: 'src/components/preview/PreviewTabs.jsx',
  poster: 'src/components/preview/PosterCarouselBlock.jsx',
};

function readSource(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

const source = Object.fromEntries(
  Object.entries(FILES).map(([name, file]) => [name, readSource(file)]),
);
const combined = Object.values(source).join('\n');

function importPaths(text) {
  return [...text.matchAll(/import\s+[\s\S]*?\s+from\s+['"]([^'"]+)['"]/g)]
    .map((match) => match[1]);
}

test('组件公共 props 冻结为 viewModel 与 size，未知 size 走 full 分支', () => {
  assert.match(
    source.main,
    /export default function MiniProgramPreview\(\{ viewModel, size = 'full' \}\)/,
  );
  assert.match(source.main, /const compact = size === 'compact'/);
  assert.doesNotMatch(source.main, /\{\s*template\s*[,}]/);
  assert.doesNotMatch(source.main, /\bstoreName\s*=\s*'我的餐馆'/);
  assert.doesNotMatch(source.main, /\bfeatures\s*=\s*\[\]/);
});

test('预览组件只依赖 React、固定图标和本地展示组件', () => {
  assert.deepEqual(importPaths(source.main).sort(), [
    './PosterCarouselBlock.jsx',
    './PreviewShared.jsx',
    './PreviewTabs.jsx',
    'react',
  ]);
  assert.deepEqual(importPaths(source.shared), ['lucide-react']);
  assert.deepEqual(importPaths(source.tabs).sort(), [
    './PosterCarouselBlock.jsx',
    './PreviewShared.jsx',
    'lucide-react',
  ]);
  // 尺寸档位来自本地 domain 纯逻辑模块（preview-size-tokens.v1），不引入第三方依赖。
  assert.deepEqual(importPaths(source.poster).sort(), ['../../domain/previewSizeTokens.mjs', 'react']);
  assert.doesNotMatch(combined, /\bbuildPreviewViewModel\b/);
  assert.doesNotMatch(combined, /\bfetch\s*\(/);
  assert.doesNotMatch(combined, /\b(?:localStorage|sessionStorage)\b/);
});

test('商品、营业时间、订单和能力展示均来自同一个 ViewModel', () => {
  assert.match(source.main, /<CompactPreview viewModel=\{viewModel\} \/>/);
  assert.match(source.main, /<FullPreview\s+viewModel=\{viewModel\}/);
  assert.match(source.main, /<PreviewTabContent tab=\{activeTab\} viewModel=\{viewModel\} \/>/);
  assert.doesNotMatch(combined, /\b(?:PRODUCTS|ORDER_STEPS|TABS)\s*=/);
  assert.doesNotMatch(combined, /门店招牌饭|时令小食拼盘|自选鲜泡茶|今日限定/);
  assert.doesNotMatch(combined, /10:00\s*-\s*22:00|订单 #20261031|预计 20 分钟/);
  assert.match(source.shared, /product\.priceDisplay/);
  assert.match(source.tabs, /store\.businessHoursText/);
  assert.match(source.tabs, /order\.(?:number|context|status|estimate)/);
  assert.match(source.tabs, /capability\.label/);
  assert.match(source.tabs, /menuCountText/);
});

test('compact 直接渲染 VM 营业时间文本及其待完善回落', () => {
  const compactSource = source.main.slice(
    source.main.indexOf('function CompactPreview'),
    source.main.indexOf('function FullPreview'),
  );
  assert.match(
    compactSource,
    /<div className="mini-compact-head">\s*<small>\{store\.businessHoursText\}<\/small>\s*<\/div>/,
  );
});

test('商品、tab、订单步骤和能力使用契约稳定 key', () => {
  assert.match(source.main, /key=\{product\.key\}/);
  assert.match(source.main, /key=\{tab\.id\}/);
  assert.match(source.tabs, /key=\{product\.key\}/);
  assert.match(source.tabs, /key=\{step\.key\}/);
  assert.match(source.tabs, /key=\{capability\.key\}/);
  assert.doesNotMatch(combined, /key=\{(?:index|product\.name|step\.label|capability\.label)\}/);
});

test('full 保留四种可切换 tab，compact 只展示同一组 tab 不发出切换事件', () => {
  const compactSource = source.main.slice(
    source.main.indexOf('function CompactPreview'),
    source.main.indexOf('function FullPreview'),
  );
  assert.match(source.main, /useState\('home'\)/);
  assert.match(source.main, /onTabChange=\{setActiveTab\}/);
  assert.match(source.main, /onClick=\{\(\) => onTabChange\(tab\.id\)\}/);
  assert.doesNotMatch(compactSource, /onClick=|<button/);
  assert.equal((source.main.match(/tabs\.map\(\(tab\)/g) || []).length, 2);
  for (const tab of ['home', 'menu', 'orders', 'mine']) {
    assert.match(source.tabs, new RegExp(`case '${tab}':`));
  }
});

test('tab 图标只通过固定白名单从 tab.icon 映射', () => {
  for (const icon of ['home', 'menu', 'orders', 'mine']) {
    assert.match(source.shared, new RegExp(`\\b${icon}: (?:House|Utensils|ClipboardList|Store)`));
  }
  assert.match(source.shared, /const Icon = TAB_ICONS\[icon\]/);
  assert.equal((source.main.match(/icon=\{tab\.icon\}/g) || []).length, 2);
});

test('三种布局继续复用原有商品网格 class，尺寸仅控制展示数量', () => {
  assert.match(source.main, /mini-compact-products is-\$\{layout\}/);
  assert.match(source.tabs, /mini-products is-\$\{layout\}/);
  assert.match(source.main, /layout === 'catalog' \? 3 : 2/);
  assert.match(source.tabs, /layout === 'catalog' \? 3 : 4/);
  assert.match(source.tabs, /layout === 'catalog' \? 'catalog' : 'menu'/);
  for (const className of [
    'mini-preview-compact',
    'mini-preview-full',
    'mini-phone-body',
    'mini-product',
    'mini-compact-product',
    'mini-order-steps',
    'mini-mine-card',
  ]) {
    assert.ok(combined.includes(className), `缺少既有预览 class：${className}`);
  }
});

test('null 或 undefined ViewModel 渲染静态占位且不构造补全数据', () => {
  assert.match(source.main, /if \(viewModel == null\)/);
  assert.match(source.main, /role="status"/);
  assert.match(source.main, /预览暂不可用/);
  const placeholder = source.main.slice(
    source.main.indexOf('if (viewModel == null)'),
    source.main.indexOf('if (compact) {', source.main.indexOf('if (viewModel == null)')),
  );
  assert.doesNotMatch(placeholder, /build|fetch|storage|products|businessHours/i);
});