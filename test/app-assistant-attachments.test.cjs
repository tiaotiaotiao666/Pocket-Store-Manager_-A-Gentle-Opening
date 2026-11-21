'use strict';

/**
 * T7 行为测试：统一会话的附件用途校验与分流规则。
 *
 * 只测纯函数/静态接线；真实图片识别仍由 agent-turn.v2 的
 * `vision.analyzed` 硬校验负责，这里不伪造识别结果。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { APP_ATTACHMENT_PURPOSES } = require('../src/domain/appCapabilities.mjs');
const { APP_ASSISTANT_REQUEST_LIMITS } = require('../src/services/appAssistant/appAssistantRequest.mjs');

const ATTACHMENTS_PATH = path.join(__dirname, '..', 'src', 'components', 'agent', 'AgentChatAttachments.jsx');
const APP_PATH = path.join(__dirname, '..', 'src', 'App.jsx');

function read(file) {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

test('附件用途冻结为 auto / menu / store / reference', () => {
  assert.deepEqual(APP_ATTACHMENT_PURPOSES, ['auto', 'menu', 'store', 'reference']);
  assert.deepEqual(
    ['id', 'kind', 'mediaType', 'dataBase64', 'previewDataUrl', 'name', 'bytes'].sort(),
    ['id', 'kind', 'mediaType', 'dataBase64', 'name', 'bytes', 'previewDataUrl'].sort(),
  );
  assert.equal(APP_ASSISTANT_REQUEST_LIMITS.maxAttachments, 3);
});

test('附件组件支持四种用途，且参考图上限 1 张', () => {
  const source = read(ATTACHMENTS_PATH);
  ['auto', 'reference', 'menu', 'store'].forEach((kind) => {
    assert.ok(source.includes(`${kind}: {`), `缺少附件用途 ${kind}`);
  });
  assert.match(source, /reference: \{[\s\S]{0,200}limit: 1,/);
  assert.match(source, /auto: \{[\s\S]{0,220}limit: AGENT_IMAGE_LIMITS\.maxTotalImages/);
});

test('全阶段开放附件入口，包含 auto 与 reference', () => {
  const app = read(APP_PATH);
  assert.match(
    app,
    /const agentChatImageKinds = \(\(\) => \{[\s\S]{0,160}return \['auto', 'menu', 'store', 'reference'\]/,
    '有项目即提供全部四种用途',
  );
});

test('菜单图走 agent-turn.v2 并要求真实识别，参考图进入自动构建与验证链', () => {
  const app = read(APP_PATH);
  const start = app.indexOf('const dispatchAgentChatTurn = (text, images = [],');
  assert.ok(start > 0, '缺少附件分流函数');
  const block = app.slice(start, app.indexOf('\n  };', start));
  assert.match(block, /kind === 'menu'/, '菜单图单独识别');
  assert.match(block, /requireVision: true/, '菜单识别必须要求真实 analyzed=true');
  assert.match(block, /allowAnyPhase: true/, '统一会话在任意阶段都能识别菜单');
  assert.match(block, /kind === 'reference'/, '参考图单独处理');
  assert.match(app, /resolveFrontendGenerationIntent\(\{[\s\S]{0,160}text,[\s\S]{0,160}images/, '参考图与 implicit 自动意图必须进入统一生成意图判断');
  assert.match(app, /type:\s*'FRONTEND_AUTO_REQUEST'/, '一次发送必须原子创建自动分析 run');
  assert.match(app, /prepareProjectPreview\(\{/, '候选构建前必须准备项目私有预览数据');
  assert.match(app, /frontendService\.buildCandidate\(\{[\s\S]{0,900}\bplan,[\s\S]{0,300}\bstoreId,[\s\S]{0,300}\bbackendVersions,/, '候选必须收到写回后的 Plan、storeId 与数据版本');
  assert.match(app, /frontendService\.verifyCandidate\(/, '构建后必须继续执行同一候选链的微信验证');
  assert.match(block, /runAppAssistantTurn\(\{ text, images: list, retry \}\)/, 'auto/store 走统一视觉判断，并支持重试透传');
});

test('附件上限：菜单 2 / 环境 1 / 参考 1 / 合计 3', () => {
  const app = read(APP_PATH);
  assert.match(
    app,
    /kind === 'menu'[\s\S]{0,120}maxMenuImages[\s\S]{0,120}kind === 'store'[\s\S]{0,60}maxStoreImages[\s\S]{0,80}kind === 'reference'[\s\S]{0,40}1/,
    '各用途上限必须显式区分',
  );
});
test('压缩标签与业务用途分离：reference / auto 也能真正进入附件列表', () => {
  const source = read(ATTACHMENTS_PATH);
  // prepareImageFile 只认 menu/store 两种压缩标签；直接用业务 kind 会把参考图/自动判断
  // 判成 AGENT_IMAGE_INVALID，表现就是“选了参考界面图却上传不了”。
  assert.match(source, /const COMPRESS_KIND = Object\.freeze\(\{/, '必须显式声明压缩标签映射');
  assert.match(source, /reference: 'menu',/, '参考图复用菜单照的压缩参数');
  assert.match(source, /auto: 'menu',/, '自动判断复用菜单照的压缩参数');
  assert.match(
    source,
    /prepareImageFile\(file, \{ kind: COMPRESS_KIND\[activeKind\] \|\| 'menu' \}\)/,
    '压缩时必须传压缩标签，不能传业务用途',
  );
  assert.match(source, /drafts\.push\(\{ \.\.\.draft, kind: activeKind \}\)/, 'draft 上必须回写真实业务用途');
});