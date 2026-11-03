'use strict';

/**
 * T14 静态接线检查（plan.md 3.1 T14 验收 1–6）。
 *
 * 只读 `src/App.jsx` 源码，不渲染 React：验证唯一入口确实把
 * T3/T4/T5/T6/T13 的组件、服务与状态机动作接了起来。
 * 真实的交互行为由 sessionMachine / 组件各自的测试覆盖。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_PATH = path.join(__dirname, '..', 'src', 'App.jsx');

function readApp() {
  return fs.readFileSync(APP_PATH, 'utf8');
}

test('模板页：TemplateGallery 接入展示状态、对比与对话修改回调', () => {
  const source = readApp();
  assert.match(
    source,
    /import\s+TemplateGallery\s+from\s+['"]\.\/components\/flow\/TemplateGallery\.jsx['"]/,
    'TemplateGallery 必须被导入',
  );
  assert.match(source, /<TemplateGallery[\s\S]*?presentation=\{presentationState\}/, '必须传入 presentation');
  assert.match(source, /<TemplateGallery[\s\S]*?onRevise=\{handleTemplateReviseSubmit\}/, '必须传入 onRevise');
  assert.match(
    source,
    /<TemplateGallery[\s\S]*?onClearReviseError=\{[^}]*TEMPLATE_REVISE_CLEAR[^}]*\}/,
    'onClearReviseError 必须派发 TEMPLATE_REVISE_CLEAR',
  );
  assert.match(source, /<TemplateGallery[\s\S]*?compareIds=\{compareIds\}/, '必须传入 compareIds');
  assert.match(source, /<TemplateGallery[\s\S]*?onCompareChange=\{setCompareIds\}/, '必须传入 onCompareChange');
  assert.match(
    source,
    /<TemplateGallery[\s\S]*?mockRevise=\{templateReviseTransport\.mock\}/,
    '必须按 transport 配置显式标注 Mock 演示',
  );
});

test('模板页：onRevise 走 REQUEST → 服务 → SUCCESS/FAILURE，且携带 requestId', () => {
  const source = readApp();
  assert.match(
    source,
    /import\s*\{[\s\S]*?requestTemplateRevise[\s\S]*?createReviseRequestId[\s\S]*?\}\s*from\s+['"]\.\/services\/agentTurn\/templateReviseService\.js['"]/,
    '必须导入 requestTemplateRevise 与 createReviseRequestId',
  );
  assert.match(
    source,
    /type:\s*'TEMPLATE_REVISE_REQUEST'[\s\S]{0,120}utterance:\s*text[\s\S]{0,120}requestId/,
    'REQUEST 必须携带 utterance 与 requestId',
  );
  assert.match(
    source,
    /await\s+requestTemplateRevise\(\{[\s\S]*?candidate:\s*\{\s*templateId,\s*layout:[\s\S]*?planFeatures[\s\S]*?basePatch:\s*presentationState\.patch[\s\S]*?baseDraft:\s*state\.agentDraft/,
    '请求必须带当前候选、planFeatures、basePatch 与 baseDraft',
  );
  assert.match(
    source,
    /type:\s*'TEMPLATE_REVISE_SUCCESS'[\s\S]{0,220}requestId[\s\S]{0,220}patch:\s*result\.patch[\s\S]{0,220}changes:\s*result\.changes/,
    'SUCCESS 必须回传同一个 requestId、patch 与 changes',
  );
  assert.match(
    source,
    /type:\s*'TEMPLATE_REVISE_FAILURE'[\s\S]{0,120}requestId[\s\S]{0,120}error/,
    'FAILURE 必须携带 requestId 与 error（晚响应由 reducer 丢弃）',
  );
});

test('handleComposerSubmit：TEMPLATE_PICK 走对话修改，STORE_INFO 仍走 agent turn', () => {
  const source = readApp();
  assert.match(
    source,
    /phase === PHASES\.STORE_INFO\s*\)\s*\{\s*handleAgentTurn\(text\);/,
    'STORE_INFO 必须保留 agent turn 行为',
  );
  assert.match(
    source,
    /phase === PHASES\.TEMPLATE_PICK\s*\)\s*\{[\s\S]{0,220}handleTemplateReviseSubmit\(text\)/,
    'TEMPLATE_PICK 必须走模板对话修改而不是静默落空',
  );
  assert.match(
    source,
    /COMPOSER_PHASES\s*=\s*\[[^\]]*PHASES\.TEMPLATE_PICK/,
    '模板页必须显示输入框，分支才可达',
  );
});

test('店铺资料页：渲染 VisionImageUploader，并以 AgentImageDraft 透传给 requestAgentTurn', () => {
  const source = readApp();
  assert.match(
    source,
    /import\s+VisionImageUploader\s+from\s+['"]\.\/components\/agent\/VisionImageUploader\.jsx['"]/,
    'VisionImageUploader 必须被导入',
  );
  assert.match(
    source,
    /<VisionImageUploader[\s\S]*?images=\{agentImages\}[\s\S]*?onAdd=\{handleVisionImagesAdd\}[\s\S]*?onRemove=\{handleVisionImageRemove\}/,
    '上传组件必须接 images/onAdd/onRemove',
  );
  assert.match(
    source,
    /const handleVisionImagesAdd = \(kind, drafts\)/,
    'onAdd 实际签名是 (kind, drafts)，不能按 FileList 处理',
  );
  assert.match(
    source,
    /requestAgentTurn\(\{[\s\S]{0,260}images/,
    'requestAgentTurn 必须透传 images（非空时服务层自动升级 v2）',
  );
  assert.match(
    source,
    /const images = \[\.\.\.agentImages\.menu, \.\.\.agentImages\.store\]/,
    '必须从本地图片状态汇总 menu + store drafts',
  );
});

test('店铺资料页：门店环境照同时写入现有 assets 通道', () => {
  const source = readApp();
  assert.match(
    source,
    /kind === 'store'[\s\S]{0,220}ADD_PROJECT_IMAGES/,
    '环境照必须通过 ADD_PROJECT_IMAGES 进入 state.assets.images',
  );
  assert.match(
    source,
    /function toVisionAsset\(draft\)[\s\S]*?assetId:\s*draft\.id[\s\S]*?mime:\s*draft\.mediaType/,
    'assets 条目必须符合 projectSnapshot.pickImages 的白名单字段',
  );
  assert.doesNotMatch(source, /dataBase64:\s*draft\.dataBase64/, '不得把 base64 写进持久化 assets');
});

test('导出完成视图：渲染 RealPreviewPanel 并接 preload 打开工程/选择截图', () => {
  const source = readApp();
  assert.match(
    source,
    /import\s+RealPreviewPanel\s+from\s+['"]\.\/components\/preview\/RealPreviewPanel\.jsx['"]/,
    'RealPreviewPanel 必须被导入',
  );
  assert.match(
    source,
    /<RealPreviewPanel[\s\S]*?projectPath=\{exportedProjectPath\}[\s\S]*?screenshot=\{realPreview\.screenshot\}[\s\S]*?onOpen=\{handleOpenPreviewProject\}[\s\S]*?onPickScreenshot=\{handlePickPreviewScreenshot\}[\s\S]*?onClear=\{handleClearPreviewScreenshot\}/,
    '面板必须接 projectPath/screenshot/onOpen/onPickScreenshot/onClear',
  );
  assert.match(
    source,
    /api\.openPreviewProject\(\{\s*projectPath:\s*exportedProjectPath\s*\}\)/,
    '打开工程必须调用 window.smartStore.openPreviewProject',
  );
  assert.match(
    source,
    /await api\.pickPreviewScreenshot\(\)/,
    '选择截图必须调用 window.smartStore.pickPreviewScreenshot',
  );
  assert.match(
    source,
    /typeof api\.openPreviewProject !== 'function'[\s\S]{0,260}PREVIEW_BRIDGE_UNAVAILABLE/,
    '浏览器模式必须优雅降级而不是抛错',
  );
  assert.match(
    source,
    /function readExportedProjectPath\(result\)[\s\S]*?result\.outputPath/,
    '工程目录必须来自导出结果 outputPath',
  );
});

test('提示词接线：composePrompt 带 layout，revisePrompt 兼容结构化返回', () => {
  const source = readApp();
  assert.match(
    source,
    /composePrompt\(\{[^}]*layout:\s*selectedLayout[^}]*\}\)/,
    'composePrompt 必须传当前选中候选的 layout',
  );
  assert.match(
    source,
    /typeof revised === 'string' \? revised : \(revised\?\.prompt \?\? state\.visual\.prompt\)/,
    'handlePromptFeedback 必须兼容字符串与 { prompt } 两种返回',
  );
});