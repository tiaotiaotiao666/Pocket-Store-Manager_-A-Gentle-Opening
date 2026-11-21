const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function read(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

async function loadDomain() {
  return import('../src/domain/devtoolsPreview.mjs');
}

test('底部预览入口按阶段说明为什么还不能预览', async () => {
  const {
    describePreviewReadiness,
    PREVIEW_DOCK_LABELS,
  } = await loadDomain();

  assert.equal(describePreviewReadiness({ phase: 'home' }).hidden, true);
  assert.match(describePreviewReadiness({ phase: 'onboarding' }).reason, /命名/);
  assert.match(describePreviewReadiness({ phase: 'features' }).reason, /页面骨架/);
  assert.match(describePreviewReadiness({ phase: 'building' }).reason, /构建/);
  assert.equal(describePreviewReadiness({ phase: 'store-info', storeName: '松月食堂' }).blocked, false);
  assert.match(describePreviewReadiness({ phase: 'store-info', storeName: '' }).reason, /项目命名/);
  assert.equal(PREVIEW_DOCK_LABELS.idle, '使用微信开发者工具预览');
  assert.match(PREVIEW_DOCK_LABELS.generating, /正在准备/);
  assert.match(PREVIEW_DOCK_LABELS.launching, /正在启动/);
});

test('微信工具未就绪时区分未安装、未启动与未显示小程序页面', async () => {
  const { describeDevtoolsGate } = await loadDomain();

  assert.equal(describeDevtoolsGate({ found: false }).code, 'NOT_INSTALLED');
  assert.match(describeDevtoolsGate({ found: false }).reason, /未检测到微信开发者工具/);
  assert.equal(describeDevtoolsGate({ found: true, running: false }).code, 'NOT_RUNNING');
  assert.equal(describeDevtoolsGate({ found: true, running: true, projectOpen: false }).code, 'NO_PROJECT');
  assert.match(describeDevtoolsGate({ found: true, running: true, projectOpen: false }).reason, /还没有打开小程序页面/);
  assert.equal(describeDevtoolsGate({ found: true, running: true, projectOpen: true }).ready, true);
});

test('探测失败不能说成未安装：gate 走 PROBE_FAILED，预览前分支单独处理 failed', async () => {
  const { describeDevtoolsGate } = await loadDomain();
  const failed = describeDevtoolsGate({ status: 'failed', found: false, running: false });
  assert.equal(failed.ready, false);
  assert.equal(failed.code, 'PROBE_FAILED');
  assert.match(failed.reason, /检测/);
  assert.doesNotMatch(failed.reason, /未检测到微信开发者工具/);

  const app = read('src/App.jsx');
  assert.match(app, /probe\.status === 'failed'/);
  assert.match(app, /检测微信开发者工具状态失败/);
});

test('启动结果如实区分已显示页面、已启动与未确认窗口', async () => {
  const { describeProbeConfirmation } = await loadDomain();

  const visible = describeProbeConfirmation({ found: true, running: true, projectOpen: true });
  assert.equal(visible.visible, true);
  assert.equal(visible.tone, 'ok');
  assert.match(visible.text, /已打开/);

  const running = describeProbeConfirmation({ found: true, running: true, projectOpen: false });
  assert.equal(running.visible, false);
  assert.match(running.text, /已启动/);

  const unknown = describeProbeConfirmation({ found: true, running: false });
  assert.equal(unknown.visible, false);
  assert.match(unknown.text, /没有确认到微信开发者工具窗口/);
});

test('启动失败按错误码给出可读原因，并在缺 CLI 时提供配置入口', async () => {
  const { describeLaunchFailure, buildDevtoolsConfigGuide } = await loadDomain();

  const missing = describeLaunchFailure({ ok: false, code: 'DEVTOOLS_NOT_FOUND', message: 'raw' });
  assert.match(missing.text, /cli\.bat/);
  assert.equal(missing.needsConfig, true);

  const port = describeLaunchFailure({ ok: false, code: 'SERVICE_PORT_DISABLED' });
  assert.match(port.text, /服务端口/);
  assert.equal(port.needsConfig, false);

  const unlisted = describeLaunchFailure({ ok: false, code: 'SOMETHING_ELSE', message: '工具返回的原始原因' });
  assert.equal(unlisted.text, '工具返回的原始原因');

  const guide = buildDevtoolsConfigGuide();
  assert.match(guide, /WX_CLI_PATH/);
  assert.match(guide, /服务端口/);
  assert.match(guide, /不校验合法域名/);
});

test('底部输入区常驻预览入口且状态可反馈、可重新检测', () => {
  const app = read('src/App.jsx');
  assert.match(app, /import DevtoolsPreviewDock from '\.\/components\/preview\/DevtoolsPreviewDock\.jsx'/);
  assert.match(app, /const previewDockVisible = phase !== PHASES\.HOME/);
  assert.match(app, /<DevtoolsPreviewDock[\s\S]{0,260}onPrepareProject=\{handlePreparePreviewProject\}/);
  assert.match(app, /code: 'ENV_GUIDE_OPENED'/);
  assert.match(app, /openEnvGuide\('preview', async \(\) => \{/);
  assert.match(app, /workspace-preview-dock/);

  const component = read('src/components/preview/DevtoolsPreviewDock.jsx');
  assert.match(component, /PREVIEW_DOCK_LABELS/);
  assert.match(component, /onPrepareProject/);
  assert.match(component, /code === 'ENV_GUIDE_OPENED'/);
  assert.match(component, /aria-label="微信开发者工具预览入口"/);
  assert.match(component, /aria-live="polite"/);
  assert.match(component, /openPreviewDevtools/);
  assert.match(component, /devtoolsService\.probe/);
  assert.match(component, /重新检测/);
  assert.match(component, /复制安装与配置说明/);

  const css = read('src/styles/preview.css');
  assert.match(css, /\.workspace-preview-dock/);
  assert.match(css, /\.preview-dock-btn/);
  assert.match(css, /\.preview-dock-note\.is-ok/);
});