'use strict';

/**
 * T6 静态检查：统一会话的「本轮已写入」变更卡与撤销入口。
 *
 * 真实写入行为由 `test/app-assistant-reducer.test.cjs` 覆盖；
 * 这里守住 UI 层不该被破坏的契约：只展示桌面 before/after、
 * 待确认/ stale 分区、撤销按钮有唯一可访问名称。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PANEL_PATH = path.join(__dirname, '..', 'src', 'components', 'agent', 'AgentSidebarPanel.jsx');
const CARD_PATH = path.join(__dirname, '..', 'src', 'components', 'agent', 'AppAssistantChangeCard.jsx');
const APP_PATH = path.join(__dirname, '..', 'src', 'App.jsx');

function read(file) {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

test('面板渲染变更卡，并把 applied / pending / stale / 撤销回调传进去', () => {
  const panel = read(PANEL_PATH);
  assert.match(panel, /import AppAssistantChangeCard from '\.\/AppAssistantChangeCard\.jsx'/, '必须引用变更卡组件');
  assert.match(panel, /<AppAssistantChangeCard[\s\S]{0,220}applied=\{applied\}[\s\S]{0,120}pending=\{pending\}[\s\S]{0,120}stale=\{stale\}/, '三类结果分区传入');
  assert.match(panel, /canUndo=\{canUndoApplied\}/, '撤销可用性由内容版本一致性决定');
  assert.match(panel, /onUndo=\{onUndoApplied\}/, '撤销回调由 App 注入');
});

test('撤销可用条件：只允许撤销仍停在应用后版本的那一批', () => {
  const panel = read(PANEL_PATH);
  assert.match(
    panel,
    /const canUndoApplied = Boolean\(applied && contentRevision !== null && contentRevision === applied\.appliedRevision\)/,
    '版本不一致时不得提供「撤销本轮」',
  );
  const app = read(APP_PATH);
  assert.match(app, /const current = Number\.isInteger\(state\.project\.contentRevision\)/, 'App 撤销前复核当前版本');
  assert.match(app, /current !== applied\.appliedRevision/, '版本变化时改为提示使用全局撤销');
  assert.match(app, /dispatch\(\{ type: 'UNDO_APPLY' \}\)/, '撤销复用既有全局撤销入口');
});

test('变更卡只展示桌面 before/after，不采信模型「已修改」文案', () => {
  const card = read(CARD_PATH);
  assert.match(card, /entry\.before/, '必须展示 before');
  assert.match(card, /entry\.after/, '必须展示 after');
  assert.match(card, /entry\.label/, '必须展示字段中文名');
  assert.doesNotMatch(card, /reply|proposal\.reply/, '变更卡不得展示模型回复文案');
  assert.match(card, /尚未写入/, '待确认项必须明确说明未写入');
  assert.match(card, /项目在此期间已变化，这次结果没有写入/, 'stale 必须如实说明');
});

test('撤销按钮有唯一可访问名称，禁用时给可读说明', () => {
  const card = read(CARD_PATH);
  assert.match(card, /aria-label="撤销本轮修改"/, '撤销按钮必须有可读名称');
  assert.match(card, /disabled=\{!canUndo\}/, '不可撤销时必须禁用');
  assert.match(card, /只能用全局撤销/, '禁用原因要写出来');
});

test('面板仍是纯展示组件：不引服务、不发请求、不 dispatch', () => {
  const panel = read(PANEL_PATH);
  assert.doesNotMatch(panel, /from '\.\.\/\.\.\/services\//, '面板不得直接引用服务层');
  assert.doesNotMatch(panel, /fetch\(|requestAppAssistant|useReducer|dispatch\(/, '面板不得发请求或持有状态');
});

test('视图模型把撤销回调集中传给 RightPanel', () => {
  const app = read(APP_PATH);
  assert.match(app, /onUndoApplied: handleAgentChatUndoApplied,/, '视图模型必须暴露撤销回调');
});

test('变更卡样式落在 agent-sidebar.css', () => {
  const css = read(path.join(__dirname, '..', 'src', 'styles', 'agent-sidebar.css'));
  ['agent-chat-changes', 'agent-chat-pending', 'agent-chat-stale'].forEach((name) => {
    assert.ok(css.includes(`.${name}`), `缺少样式 .${name}`);
  });
});