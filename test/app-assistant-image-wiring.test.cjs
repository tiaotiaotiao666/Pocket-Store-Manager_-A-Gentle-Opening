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
  const router = sliceBlock(app, 'const dispatchAgentChatTurn = (text, images = [],');
  assert.match(router, /runAppAssistantTurn\(\{ text, images: list, retry \}\)/, 'store/auto 图只做视觉理解，并支持重试透传');
});

test('参考图不绕过候选验证：一次发送自动构建，但侧栏不得直接采用', () => {
  const app = readApp();
  const router = sliceBlock(app, 'const dispatchAgentChatTurn = (text, images = [],');
  assert.match(router, /kind === 'reference'/, '参考图必须进入独立自动链，不能作为 app-assistant 图片');
  assert.match(app, /resolveFrontendGenerationIntent\(\{[\s\S]{0,160}text,[\s\S]{0,160}images/, '单张 reference 图必须触发 explicit 生成意图');
  const autoRequestAt = app.indexOf("type: 'FRONTEND_AUTO_REQUEST'");
  assert.ok(autoRequestAt >= 0, '同一发送必须以独立 runId 开始自动分析');
  const commitImageAt = app.indexOf('await commitScreenRefImage(image)', autoRequestAt);
  assert.ok(commitImageAt > autoRequestAt, 'FRONTEND_AUTO_REQUEST 必须先于共享图片提交，避免同步 effect 多推进 revision');
  assert.match(app, /prepareProjectPreview\(\{[\s\S]{0,300}bindingKey:/, '自动链必须先准备当前 run 的独立预览门店');
  assert.match(app, /frontendService\.buildCandidate\(\{/, '分析为 planned 后必须自动构建候选');
  assert.match(app, /frontendService\.verifyCandidate\(/, '候选构建后必须执行微信验证');
  assert.doesNotMatch(
    router,
    /FRONTEND_ADOPT|adoptCandidate|frontendReducer/i,
    '自动发送不得绕过结果卡直接采用候选',
  );
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