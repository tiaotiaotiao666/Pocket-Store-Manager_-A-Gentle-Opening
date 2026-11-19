const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function read(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

test('环境引导弹窗存在且包含首次准备与详细步骤', () => {
  const component = read('src/components/onboarding/EnvGuideDialog.jsx');
  assert.match(component, /开始前，先把环境准备好/);
  assert.match(component, /到这一步了，先检查这几项/);
  assert.match(component, /详细步骤/);
  assert.match(component, /微信开发者工具/);
  assert.match(component, /服务端口/);
  assert.match(component, /不使用代理/);
  assert.match(component, /不校验合法域名/);
  assert.match(component, /已准备就绪/);
  assert.match(component, /稍后再做/);
  assert.match(component, /!isPreviewMode \? \(/);
});

test('环境引导区分本机与云端运行形态', () => {
  const app = read('src/App.jsx');
  assert.match(app, /detectDeploymentMode/);
  assert.match(app, /云端后端不可达/);
  assert.match(app, /本地无需启动数据库/);
  assert.match(app, /isCloud/);

  const component = read('src/components/onboarding/EnvGuideDialog.jsx');
  assert.match(component, /deploymentMode/);
  assert.match(component, /服务端就绪/);
  assert.match(component, /本机工具就绪/);
  assert.match(component, /云端服务由部署方维护/);

  const css = read('src/styles/env-guide.css');
  assert.match(css, /\.env-guide-group/);
});

test('预览前使用微信工具勾选清单，全部勾选后才能继续', () => {
  const component = read('src/components/onboarding/EnvGuideDialog.jsx');
  assert.match(component, /PREVIEW_CHECKS/);
  assert.match(component, /预览前，逐条确认微信工具/);
  assert.match(component, /type="checkbox"/);
  assert.match(component, /allChecked/);
  assert.match(component, /全部勾选后才能继续/);
  assert.match(component, /已开启服务端口/);
  assert.match(component, /代理设为不使用代理/);
  assert.match(component, /已勾选不校验合法域名/);

  const app = read('src/App.jsx');
  assert.match(app, /if \(mode !== 'preview'\) void runEnvChecks\(\)/);
  assert.match(app, /probe\.running === false/);
  assert.match(app, /probe\.projectOpen === false/);
  assert.match(app, /还没有打开小程序页面/);
  assert.match(app, /return runPreviewExport\(\)/);

  const probe = read('desktop/devtools-probe.cjs');
  assert.match(probe, /getDevtoolsWindowTitle/);
  assert.match(probe, /readDevtoolsWindowState/);
  assert.match(probe, /projectOpen/);

  const service = read('src/services/devtoolsService.js');
  assert.match(service, /projectOpen/);

  const css = read('src/styles/env-guide.css');
  assert.match(css, /\.env-guide-checklist/);
  assert.match(css, /\.env-guide-check-item/);
});

test('首次创建项目与预览前都会触发环境引导', () => {
  const app = read('src/App.jsx');
  assert.match(app, /import EnvGuideDialog from '\.\/components\/onboarding\/EnvGuideDialog\.jsx'/);
  assert.match(app, /const openEnvGuide = useCallback/);
  assert.match(app, /runEnvChecks/);
  assert.match(app, /fetch\('\/api\/v1\/readyz'/);
  assert.match(app, /openEnvGuide\('first-run'/);
  assert.match(app, /openEnvGuide\('preview'/);
  assert.match(app, /continuePreviewExport/);
  assert.match(app, /handleEnvGuideSkip/);
  assert.match(app, /<EnvGuideDialog[\s\S]{0,400}onRefresh=\{runEnvChecks\}/);
});

test('环境引导样式已接入全局样式且使用统一卡片风格', () => {
  const indexCss = read('src/styles/index.css');
  assert.match(indexCss, /@import '\.\/env-guide\.css'/);

  const css = read('src/styles/env-guide.css');
  assert.match(css, /\.env-guide-backdrop/);
  assert.match(css, /\.env-guide-card/);
  assert.match(css, /background: var\(--bg-elev\)/);
  assert.match(css, /border-radius: 20px/);
});