'use strict';

/**
 * T8 静态接线检查：动作执行只走显式映射与既有入口。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_PATH = path.join(__dirname, '..', 'src', 'App.jsx');
const CAP_PATH = path.join(__dirname, '..', 'src', 'domain', 'appCapabilities.mjs');

function read(file) {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

test('App 只通过 actionExecutor 执行动作，导航复用 PHASE_GOTO', () => {
  const app = read(APP_PATH);
  assert.match(app, /executeAppAssistantActions\(proposal\.actionRequests/, '只走显式映射');
  assert.match(app, /navigate: \(nextPhase\) => dispatch\(\{ type: 'PHASE_GOTO', phase: nextPhase \}\)/, '导航复用既有动作');
  assert.doesNotMatch(app, /dispatch\(\{ type: action\./, '禁止通用 dispatch(action.type)');
  assert.doesNotMatch(app, /ipcRenderer|window\.smartStore\.invoke\(['"]fs\./, '不得调用任意 IPC');
});

test('待确认动作只登记摘要，不自动执行导出/采用/AppID', () => {
  const app = read(APP_PATH);
  assert.match(app, /selectUnexecutedActions\(executeAppAssistantActions/, '未执行动作单独登记');
  assert.doesNotMatch(app, /export: \(\) => .*dispatch\(\{ type: 'DEPLOY_/, '不得绕过确认直接导出');
});

test('M3 字段已开放：功能勾选、定制要求与 AppID（确认）', () => {
  const cap = read(CAP_PATH);
  assert.match(cap, /fieldId: 'features.selected'[\s\S]{0,220}risk: 'auto'/, '功能勾选可自动');
  assert.match(cap, /fieldId: 'features.custom'[\s\S]{0,220}risk: 'auto'/, '定制要求可自动');
  assert.match(cap, /fieldId: 'project\.appid'[\s\S]{0,220}risk: 'confirm'/, 'AppID 必须确认');
  assert.match(cap, /不会从 Base 工程移除未勾选的内置能力/, '必须披露功能勾选不裁剪导出');
});