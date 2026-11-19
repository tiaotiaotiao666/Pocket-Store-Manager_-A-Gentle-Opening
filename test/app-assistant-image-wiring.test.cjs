'use strict';

/**
 * T7 静态接线检查：图片入口与专用链边界。
 *
 * 红线：
 * - 菜单图只有 `vision.analyzed === true` 才回写；
 * - 门店氛围图不自动变成素材（必须经确认 + attachImageData）；
 * - 参考图不绕过候选验证，不能由侧栏直接采用。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_PATH = path.join(__dirname, '..', 'src', 'App.jsx');

function readApp() {
  return fs.readFileSync(APP_PATH, 'utf8').replace(/\r\n/g, '\n');
}

function sliceBlock(source, startMarker, endMarker = '\n  };\n') {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `找不到起始标记：${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.ok(end > start, `找不到结束标记：${endMarker}`);
  return source.slice(start, end);
}

test('菜单识别只在真实 analyzed=true 时回写，否则整轮失败', () => {
  const app = readApp();
  const turn = sliceBlock(app, 'const handleAgentTurn = async (utterance, {');
  assert.match(turn, /allowAnyPhase = false/, '统一会话可跨阶段识别菜单');
  assert.match(turn, /requireVision && result\.vision\?\.analyzed !== true/, '菜单识别必须有硬校验');
  assert.match(turn, /AGENT_VISION_UNAVAILABLE/, '未真实识别时用稳定错误码拒绝回写');
  // 主输入框不带 allowAnyPhase，行为不变。
  assert.match(app, /handleAgentTurn\(text\);\s*\n\s*return;/, '主输入框仍只在资料阶段');
});

test('氛围图走 app-assistant，不会自动写素材文件', () => {
  const app = readApp();
  const start = app.indexOf('const runAppAssistantTurn = async ({');
  const turn = app.slice(start, app.indexOf('\n  };', start));
  assert.doesNotMatch(turn, /attachImageData|asset-store|ipcRenderer|window\.smartStore\.attach/, '统一入口不得自动落盘素材');
  assert.match(turn, /attachments: attachedImages\.map/, '图片只随请求发送');
  const router = sliceBlock(app, 'const dispatchAgentChatTurn = (text, images = []) => {');
  assert.match(router, /runAppAssistantTurn\(\{ text, images: list \}\)/, 'store/auto 图只做视觉理解');
});

test('参考图不绕过候选验证：侧栏只跳既有面板', () => {
  const app = readApp();
  const router = sliceBlock(app, 'const dispatchAgentChatTurn = (text, images = []) => {');
  assert.match(router, /handleAgentChatOpenCandidates\(\)/, '只定位候选面板');
  assert.doesNotMatch(router, /requestFrontendReconstruct|frontendReducer|adopt/i, '侧栏不得直接生成/采用候选');
  assert.match(app, /document\.getElementById\('frontend-reconstruct-panel'\)/, '候选入口仍是原面板');
});

test('附件正文不进入消息正文与项目快照', () => {
  const app = readApp();
  const turn = sliceBlock(app, 'const runAppAssistantTurn = async ({');
  assert.doesNotMatch(turn, /AGENT_CHAT_REQUEST_START[\s\S]{0,200}dataBase64/, '用户消息只存原话');
  assert.doesNotMatch(turn, /toDocument|pickAgentChat|localStorage/, '附件不写项目快照');
});

test('图片用途不明只追问，不产生字段写入', () => {
  const app = readApp();
  // 只发图时给内部指令（不是伪造用户文字），由模型判断用途并追问。
  assert.match(app, /请判断图片用途；不确定时先追问。/, '只发图时用内部指令');
  assert.match(app, /不确定时会先追问/, '界面文案如实说明会追问');
});