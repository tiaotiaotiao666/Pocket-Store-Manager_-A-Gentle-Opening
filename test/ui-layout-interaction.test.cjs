/**
 * 本轮 UI 修复的回归测试（布局 + 等待引导 + 图片入口）。
 *
 * 只断言「能被浏览器真实验收的因果」：
 * - 等待提示的条件由 `domain/agentWaiting.mjs` 一处推导，状态一变就消失；
 * - 提示只做定位，绝不代替用户确认/应用/生成/导出；
 * - 模板页两条能力（改当前页面、重新匹配候选）都还在，且只有一个输入入口；
 * - 布局规则不允许把中文挤成竖排（换行 + 最小宽度 + 不压缩按钮）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const REPO = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

async function loadWaiting() {
  const mod = await import(pathToFileURL(path.join(REPO, 'src', 'domain', 'agentWaiting.mjs')).href);
  return mod.selectAgentWaitingHint;
}

test('等待提示：门店资料齐全且待确认时，给出「等什么 / 在哪 / 点哪个」和跳转锚点', async () => {
  const selectAgentWaitingHint = await loadWaiting();
  const hint = selectAgentWaitingHint({
    phase: 'store-info',
    agent: { status: 'reviewing', missingFields: [], errors: [] },
    build: { candidates: [], selectedId: '' },
  });
  assert.ok(hint, '资料齐全时必须给出等待提示');
  assert.match(hint.title, /等你确认门店资料/);
  assert.match(hint.detail, /资料无误，继续/, '必须点名要点的按钮');
  assert.equal(hint.jumpId, 'store-info-confirm', '必须给可定位的锚点');
  assert.equal(hint.actionLabel, '前往处理');
});

test('等待提示：资料没齐 / 已确认 / 请求中 / 失败都不提示（不在等用户）', async () => {
  const selectAgentWaitingHint = await loadWaiting();
  const base = { build: { candidates: [], selectedId: '' } };
  assert.equal(selectAgentWaitingHint({ phase: 'store-info', ...base, agent: { status: 'reviewing', missingFields: ['address'], errors: [] } }), null);
  assert.equal(selectAgentWaitingHint({ phase: 'store-info', ...base, agent: { status: 'reviewing', missingFields: [], errors: [{ code: 'X' }] } }), null);
  assert.equal(selectAgentWaitingHint({ phase: 'store-info', ...base, agent: { status: 'confirmed', missingFields: [], errors: [] } }), null);
  assert.equal(selectAgentWaitingHint({ phase: 'store-info', ...base, agent: { status: 'requesting', missingFields: [], errors: [] } }), null);
  assert.equal(selectAgentWaitingHint({ phase: 'store-info', ...base, agent: { status: 'failed', missingFields: [], errors: [] } }), null);
  assert.equal(selectAgentWaitingHint({ phase: 'store-info', ...base, agent: null }), null);
});

test('等待提示：模板阶段只有「还没采用候选」才提示，采用后 / 修订中 / 无候选都不提示', async () => {
  const selectAgentWaitingHint = await loadWaiting();
  const candidates = [{ id: 't1' }, { id: 't2' }];
  const hint = selectAgentWaitingHint({
    phase: 'template-pick',
    agent: { status: 'confirmed' },
    build: { candidates, selectedId: '' },
    presentation: { status: 'idle' },
  });
  assert.ok(hint);
  assert.match(hint.detail, /就用这套/);
  assert.equal(hint.jumpId, 'template-apply');

  assert.equal(selectAgentWaitingHint({ phase: 'template-pick', build: { candidates, selectedId: 't1' }, presentation: { status: 'idle' } }), null);
  assert.equal(selectAgentWaitingHint({ phase: 'template-pick', build: { candidates, selectedId: '' }, presentation: { status: 'revising' } }), null);
  assert.equal(selectAgentWaitingHint({ phase: 'template-pick', build: { candidates: [], selectedId: '' }, presentation: { status: 'idle' } }), null);
});

test('等待提示：其它阶段一律不提示，不做无依据的入口暗示', async () => {
  const selectAgentWaitingHint = await loadWaiting();
  for (const phase of ['onboarding', 'features', 'image-review', 'deploy', 'workbench']) {
    assert.equal(selectAgentWaitingHint({ phase, agent: { status: 'reviewing', missingFields: [], errors: [] }, build: { candidates: [{ id: 'a' }], selectedId: '' } }), null);
  }
});

test('等待提示条：有可读名称、只做定位，不带确认类动作', () => {
  const source = read('src/components/agent/AgentWaitingHint.jsx');
  assert.match(source, /aria-label="等待你操作"/);
  assert.match(source, /前往处理/);
  assert.match(source, /data-waiting-jump=\{jumpId\}/);
  assert.match(source, /只是帮你定位/, '必须写明不会代替用户点确认');
  assert.doesNotMatch(source, /dispatch\(|confirm\(|apply\(|export\(/i, '提示条不允许自己触发写操作');
});

test('等待提示已接入右侧 Agent 栏，并且 App 的跳转只滚到控件 + 高亮', () => {
  const panel = read('src/components/agent/AgentSidebarPanel.jsx');
  assert.match(panel, /import AgentWaitingHint from '\.\/AgentWaitingHint\.jsx'/);
  assert.match(panel, /<AgentWaitingHint hint=\{waitingHint\} busy=\{busy\} onGo=\{onWaitingGo\} \/>/);

  const app = read('src/App.jsx');
  assert.match(app, /import \{ selectAgentWaitingHint \} from '\.\/domain\/agentWaiting\.mjs'/, '口径只能来自 domain');
  assert.match(app, /selectAgentWaitingHint\(\{/);
  assert.match(app, /onWaitingGo: handleWaitingGo/);
  // 跳转实现收敛在 jumpToControl 里（等待提示与待确认卡片共用同一套滚动+高亮）
  const jump = app.slice(app.indexOf('const jumpToControl'), app.indexOf('const jumpToControl') + 900);
  assert.match(jump, /scrollIntoView/, '跳转要滚到控件');
  assert.match(jump, /classList\.add\('is-jump-flash'\)/, '到达后要有高亮反馈');
  assert.doesNotMatch(jump, /dispatch\(|\.click\(\)/, '跳转不得代替用户点击');
  const handler = app.slice(app.indexOf('const handleWaitingGo'), app.indexOf('const handleWaitingGo') + 200);
  assert.match(handler, /jumpToControl\(jumpId\)/, '等待提示只能走同一条跳转');
});

test('跳转锚点在真实控件上：门店资料确认按钮 + 模板「就用这套」', () => {
  assert.match(read('src/components/agent/StoreInfoActionBar.jsx'), /data-jump-id="store-info-confirm"/);
  assert.match(read('src/components/flow/TemplateGallery.jsx'), /data-jump-id="template-apply"/);
});

test('模板页仍然只有一个模板修改入口（能力没被删掉，也没多出第二个浮层）', () => {
  const gallery = read('src/components/flow/TemplateGallery.jsx');
  const mounts = gallery.match(/<TemplateRevisePanel/g) || [];
  assert.equal(mounts.length, 1, '模板修改入口只能有一个');
  assert.match(gallery, /onRevise=\{onRevise\}/);
  assert.match(gallery, /onRefine=\{onRefine\}/, '重新匹配候选入口必须保留');
  assert.match(gallery, /aria-label=\{`就用这套：\$\{selected\.name\}`\}/);
});

test('布局：模板详情两栏按容器宽度换行，文字不会被挤成竖排', () => {
  const preview = read('src/styles/preview.css');
  assert.match(preview, /\.template-gallery \.template-detail \{[^}]*display: flex;/);
  assert.match(preview, /\.template-gallery \.template-detail \{[^}]*flex-wrap: wrap;/);
  assert.match(preview, /\.template-gallery \.template-detail-info \{[^}]*min-width: 300px;/);

  const flow = read('src/styles/flow.css');
  assert.match(flow, /\.template-gallery \.satisfy-prompt \{[^}]*flex-wrap: wrap;/);
  assert.match(flow, /\.template-gallery \.satisfy-prompt-action \{[^}]*white-space: nowrap;/);
  assert.match(flow, /\.template-gallery \.template-revise \{[^}]*box-shadow: none;/, '修改入口不再用浮层式投影');
  assert.match(flow, /\[data-jump-id\]\.is-jump-flash/);
});

test('本轮图片：0 张时是紧凑入口，选图后才展开；保留用途选择与逐张删除', () => {
  const source = read('src/components/agent/AgentChatAttachments.jsx');
  assert.match(source, /list\.length === 0 \? ' is-compact' : ''/, '0 张时走紧凑样式');
  assert.match(source, /aria-label="添加图片"/);
  assert.match(source, /title=\{KIND_CONFIG\[item\]\.hint\}/, '用途说明必须可发现');
  assert.match(source, /aria-label=\{`移除\$\{item\.name \|\| '已选图片'\}`\}/, '逐张删除必须保留');
  assert.match(source, /AGENT_IMAGE_LIMITS\.maxTotalImages/, '数量上限仍复用同一份限制');

  const css = read('src/styles/agent-sidebar.css');
  assert.match(css, /\.agent-chat-attachments\.is-compact \.agent-chat-attachments-hint \{[^}]*-webkit-line-clamp: 1;/);
  assert.match(css, /\.agent-chat-attachments\.is-compact \.agent-chat-attachments-add \{[^}]*width: 30px;/);
});

test('本轮图片：有图态标题单行、标签换行，中文不被挤成竖排，说明最多两行', () => {
  const css = read('src/styles/agent-sidebar.css');
  assert.match(css, /\.agent-chat-attachments-title \{[^}]*white-space: nowrap;/, '标题必须单行，不得一字一行');
  assert.match(css, /\.agent-chat-attachments-title \{[^}]*flex: 0 0 auto;/, '标题不得被标签挤压缩窄');
  assert.match(css, /\.agent-chat-attachments-kinds \{[^}]*flex-wrap: wrap;/, '用途标签整体换行而不是压缩标题');
  assert.match(css, /\.agent-chat-attachments-kind \{[^}]*white-space: nowrap;/, '单个用途标签不得断行');
  assert.match(css, /\.agent-chat-attachments-hint \{[^}]*-webkit-line-clamp: 2;/, '有图态说明最多两行');
  assert.match(css, /\.agent-chat-attachment-name \{[^}]*text-overflow: ellipsis;/, '文件名超长省略而不是撑破面板');
});
