'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  MIN_ZOOM_FACTOR, MAX_ZOOM_FACTOR, DEFAULT_ZOOM_FACTOR, ZOOM_STEP,
  clampZoomFactor, nextZoomFactor, zoomFactorFromLevel, zoomLevelFromFactor,
  classifyZoomShortcut, readPersistedZoomFactor, formatPercent, createZoomMenu, registerWindowZoom,
} = require('../desktop/window-zoom.cjs');

function input(key, options = {}) {
  return { type: 'keyDown', key, control: true, alt: false, meta: false, isAutoRepeat: false, ...options };
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'window-zoom-'));
}

/** 造一份带 Chromium per_host_zoom_levels 的 Preferences。 */
function writePreferences(hostLevels, dir = tempDir()) {
  fs.writeFileSync(
    path.join(dir, 'Preferences'),
    JSON.stringify({ partition: { per_host_zoom_levels: hostLevels }, spellcheck: { use_spelling_service: false } }),
  );
  return dir;
}

function fakeWindow(initialFactor = DEFAULT_ZOOM_FACTOR) {
  const listeners = {};
  const windowListeners = {};
  const calls = [];
  const state = { factor: initialFactor };
  const webContents = {
    getZoomFactor: () => state.factor,
    setZoomFactor: (value) => { state.factor = value; calls.push(value); },
    on: (name, handler) => { listeners[name] = handler; },
    isDestroyed: () => false,
  };
  const window = {
    webContents,
    on: (name, handler) => { windowListeners[name] = handler; },
    isDestroyed: () => false,
  };
  return { window, listeners, windowListeners, calls, state };
}

test('三种放大键等价：主键盘 =、Shift+=、数字小键盘 Add；缩小与回到 100% 同样识别', () => {
  assert.strictEqual(classifyZoomShortcut(input('-')), 'out');
  assert.strictEqual(classifyZoomShortcut(input('=', { shift: false })), 'in');
  assert.strictEqual(classifyZoomShortcut(input('+', { shift: true })), 'in');
  assert.strictEqual(classifyZoomShortcut(input('Add', { code: 'NumpadAdd' })), 'in');
  assert.strictEqual(classifyZoomShortcut(input('+', { code: 'NumpadAdd' })), 'in');
  assert.strictEqual(classifyZoomShortcut(input('-', { code: 'NumpadSubtract' })), 'out');
  assert.strictEqual(classifyZoomShortcut(input('0')), 'reset');
  assert.strictEqual(classifyZoomShortcut(input('0', { code: 'Numpad0' })), 'reset');
});

test('缩放快捷键不抢普通输入和既有快捷键', () => {
  assert.strictEqual(classifyZoomShortcut(input('=', { control: false })), null);
  assert.strictEqual(classifyZoomShortcut(input('-', { control: false })), null);
  assert.strictEqual(classifyZoomShortcut(input('=', { alt: true })), null);
  assert.strictEqual(classifyZoomShortcut(input('=', { meta: true })), null);
  assert.strictEqual(classifyZoomShortcut(input('z')), null);
  assert.strictEqual(classifyZoomShortcut(input('c')), null);
  assert.strictEqual(classifyZoomShortcut(input('v')), null);
  assert.strictEqual(classifyZoomShortcut(input('=', { type: 'keyUp' })), null);
  assert.strictEqual(classifyZoomShortcut(input('=', { isAutoRepeat: true })), null);
  assert.strictEqual(classifyZoomShortcut(null), null);
});

test('步进上下对称，并限制在 50%–200%', () => {
  assert.strictEqual(nextZoomFactor(1, 1), 1 + ZOOM_STEP);
  assert.strictEqual(nextZoomFactor(1, -1), 1 - ZOOM_STEP);
  assert.strictEqual(nextZoomFactor(nextZoomFactor(1, 1), -1), 1);
  assert.strictEqual(nextZoomFactor(0.51, -1), MIN_ZOOM_FACTOR);
  assert.strictEqual(nextZoomFactor(1.96, 1), MAX_ZOOM_FACTOR);
  assert.strictEqual(nextZoomFactor(MIN_ZOOM_FACTOR, -1), MIN_ZOOM_FACTOR);
  assert.strictEqual(nextZoomFactor(MAX_ZOOM_FACTOR, 1), MAX_ZOOM_FACTOR);
  // 连续缩小到底后不会越界，连续放大到底后也不会越界。
  let factor = 1;
  for (let index = 0; index < 40; index += 1) factor = nextZoomFactor(factor, -1);
  assert.strictEqual(factor, MIN_ZOOM_FACTOR);
  for (let index = 0; index < 40; index += 1) factor = nextZoomFactor(factor, 1);
  assert.strictEqual(factor, MAX_ZOOM_FACTOR);
  assert.strictEqual(clampZoomFactor(-18), MIN_ZOOM_FACTOR);
  assert.strictEqual(clampZoomFactor(Infinity), DEFAULT_ZOOM_FACTOR);
  assert.strictEqual(clampZoomFactor(Number.NaN), DEFAULT_ZOOM_FACTOR);
  assert.strictEqual(formatPercent(0.83), '83%');
  assert.strictEqual(formatPercent(DEFAULT_ZOOM_FACTOR), '100%');
});

test('非法、损坏、越界的持久化值都不会把界面锁在极小比例', () => {
  assert.strictEqual(readPersistedZoomFactor(path.join(os.tmpdir(), `zoom-missing-${process.pid}`)), DEFAULT_ZOOM_FACTOR);
  const malformed = tempDir();
  fs.writeFileSync(path.join(malformed, 'Preferences'), '{bad');
  assert.strictEqual(readPersistedZoomFactor(malformed), DEFAULT_ZOOM_FACTOR);
  assert.strictEqual(readPersistedZoomFactor(writePreferences({ hash: { '127.0.0.1': -18 } })), MIN_ZOOM_FACTOR);
  assert.strictEqual(readPersistedZoomFactor(writePreferences({ hash: { '127.0.0.1': 100 } })), MAX_ZOOM_FACTOR);
  assert.strictEqual(readPersistedZoomFactor(writePreferences({ hash: { '127.0.0.1': 'bad' } })), DEFAULT_ZOOM_FACTOR);
  assert.strictEqual(readPersistedZoomFactor(writePreferences({})), DEFAULT_ZOOM_FACTOR);
});

test('合法用户缩放值按 zoomLevel 恢复，并限制在支持范围内', () => {
  const restored = readPersistedZoomFactor(writePreferences({ hash: { '127.0.0.1': zoomLevelFromFactor(1.3) } }));
  assert.ok(Math.abs(restored - 1.3) < 0.01, `期望约 1.3，实际 ${restored}`);
  const tiny = readPersistedZoomFactor(writePreferences({ hash: { '127.0.0.1': zoomLevelFromFactor(0.6) } }));
  assert.ok(tiny >= MIN_ZOOM_FACTOR && tiny <= MAX_ZOOM_FACTOR);
  assert.ok(Math.abs(zoomFactorFromLevel(zoomLevelFromFactor(0.8)) - 0.8) < 0.01);
});

test('快捷键处理真实调用 webContents.setZoomFactor，输入框文本与 Ctrl+C 不被拦截', () => {
  const dir = writePreferences({ hash: { '127.0.0.1': 0 } });
  const { window, listeners, state } = fakeWindow(0.9);
  const registered = registerWindowZoom(window, { userDataDir: dir, logger: { warn: () => {} } });
  assert.ok(registered.menuTemplate.some((item) => item.accelerator === 'CommandOrControl+0'));
  const statusOf = (items) => items.find((item) => item.id === 'zoom-status').label;
  assert.strictEqual(statusOf(registered.menuTemplate), '当前缩放：100%');
  assert.strictEqual(statusOf(registered.buildTemplate(1.3)), '当前缩放：130%', '菜单显示值必须跟随真实 zoomFactor');
  assert.strictEqual(statusOf(registered.buildTemplate(0.5)), '当前缩放：50%');

  listeners['did-finish-load']();
  assert.strictEqual(state.factor, DEFAULT_ZOOM_FACTOR, '启动时按持久化值（这里是 100%）设置真实 zoomFactor');

  // 三种放大键各按一次：1.0 → 1.1 → 1.2 → 1.3
  for (const shortcut of [input('='), input('+', { shift: true }), input('+', { code: 'NumpadAdd' })]) {
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    listeners['before-input-event'](event, shortcut);
    assert.strictEqual(event.prevented, true, '缩放快捷键必须阻止默认行为，避免叠加 Chromium 自己的缩放');
  }
  assert.strictEqual(state.factor, 1.3);

  // 连续缩小
  for (let index = 0; index < 3; index += 1) {
    listeners['before-input-event']({ preventDefault() {} }, input('-'));
  }
  assert.strictEqual(state.factor, DEFAULT_ZOOM_FACTOR);

  // Ctrl+0 立即回到 100%
  listeners['before-input-event']({ preventDefault() {} }, input('0'));
  assert.strictEqual(state.factor, DEFAULT_ZOOM_FACTOR);

  // 普通输入与复制粘贴完全不碰缩放，也不调用 preventDefault
  for (const shortcut of [input('a'), input('c'), input('v'), input('=', { control: false }), input('-', { control: false })]) {
    listeners['before-input-event']({ preventDefault: () => assert.fail('普通输入不得拦截') }, shortcut);
  }
  assert.strictEqual(state.factor, DEFAULT_ZOOM_FACTOR);
});

test('滚轮/手势缩放只会被拉回安全范围，不会叠加步进', () => {
  const dir = writePreferences({ hash: { '127.0.0.1': 0 } });
  const { window, listeners, state } = fakeWindow(0.2);
  registerWindowZoom(window, { userDataDir: dir, logger: { warn: () => {} } });
  listeners['zoom-changed']({}, 'out');
  assert.strictEqual(state.factor, MIN_ZOOM_FACTOR);
  state.factor = 3;
  listeners['zoom-changed']({}, 'in');
  assert.strictEqual(state.factor, MAX_ZOOM_FACTOR);
  state.factor = 1.25;
  listeners['zoom-changed']({}, 'in');
  assert.strictEqual(state.factor, 1.25, '合法值不被改写');
});

test('用户缩放值会写回偏好，重启后按同一比例恢复', () => {
  const dir = writePreferences({ hash: { '127.0.0.1': 0 } });
  const { window, listeners, windowListeners, state } = fakeWindow(1);
  registerWindowZoom(window, { userDataDir: dir, logger: { warn: () => {} } });
  listeners['did-finish-load']();
  listeners['before-input-event']({ preventDefault() {} }, input('='));
  assert.strictEqual(state.factor, 1.1);
  // 关闭窗口时立刻落盘（不等 250ms 定时器）。
  windowListeners['closed']();
  assert.strictEqual(readPersistedZoomFactor(dir), 1.1, '重启读取到的应当是刚才的比例');

  // 回到 100% 后清理 host 级缩放，避免下次启动又被旧值带偏。
  const second = fakeWindow(1);
  registerWindowZoom(second.window, { userDataDir: dir, logger: { warn: () => {} } });
  second.listeners['did-finish-load']();
  second.listeners['before-input-event']({ preventDefault() {} }, input('0'));
  second.windowListeners['closed']();
  assert.strictEqual(readPersistedZoomFactor(dir), DEFAULT_ZOOM_FACTOR);
});

test('应用自己的偏好文件优先于 Chromium 的历史缩放值，并会被钳制', () => {
  const dir = writePreferences({ hash: { '127.0.0.1': zoomLevelFromFactor(0.6) } });
  fs.writeFileSync(path.join(dir, 'zoom-preference.json'), JSON.stringify({ factor: 1.4 }));
  assert.strictEqual(readPersistedZoomFactor(dir), 1.4, '有自己的偏好时以它为准');
  fs.writeFileSync(path.join(dir, 'zoom-preference.json'), JSON.stringify({ factor: 99 }));
  assert.strictEqual(readPersistedZoomFactor(dir), MAX_ZOOM_FACTOR, '越界值必须钳制，且不回落到旧值');
  fs.writeFileSync(path.join(dir, 'zoom-preference.json'), JSON.stringify({ factor: -3 }));
  assert.strictEqual(readPersistedZoomFactor(dir), MIN_ZOOM_FACTOR);
});

test('菜单回调用真实 webContents 作为唯一缩放状态', () => {
  let factor = 1;
  const changes = [];
  const menu = createZoomMenu({
    webContents: { getZoomFactor: () => factor, setZoomFactor: (value) => { factor = value; } },
    onChange: (change) => changes.push(change),
  });
  const click = (label) => menu.template.find((item) => item.label === label).click();
  click('放大');
  assert.strictEqual(factor, 1.1);
  click('缩小');
  assert.strictEqual(factor, 1);
  click('放大');
  click('实际大小（100%）');
  assert.strictEqual(factor, 1);
  assert.strictEqual(changes.length, 4);
  assert.ok(!menu.template.some((item) => item.role === 'zoomIn' || item.role === 'resetZoom'));
});
