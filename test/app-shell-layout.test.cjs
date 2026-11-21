'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');

test('左右侧栏都支持鼠标拖动与键盘调整宽度', () => {
  const source = fs.readFileSync(
    path.join(REPO, 'src', 'components', 'layout', 'AppShell.jsx'),
    'utf8',
  );
  assert.match(source, /role: 'separator'/);
  assert.match(source, /调整项目导航宽度/);
  assert.match(source, /调整对话侧栏宽度/);
  assert.match(source, /onPointerDown/);
  assert.match(source, /ArrowLeft/);
  assert.match(source, /smartstore\.desktop\.layout\.v1/);

  const css = fs.readFileSync(path.join(REPO, 'src', 'styles', 'layout.css'), 'utf8');
  assert.match(css, /\.shell-resizer/);
  assert.match(css, /cursor: col-resize/);
});