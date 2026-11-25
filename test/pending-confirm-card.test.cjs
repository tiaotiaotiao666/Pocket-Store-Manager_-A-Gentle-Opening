'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('待确认项能落到真实确认入口：删菜 → 菜品区，字段类 → 门店资料表单', async () => {
  const { describePendingConfirmations } = await import('../src/domain/agentPendingConfirm.mjs');
  const items = describePendingConfirmations({
    fields: [
      { opId: 'op-1', fieldId: 'store.dishes', op: 'dish.remove' },
      { opId: 'op-2', fieldId: 'store.category', op: 'field.set' },
    ],
    actions: [],
  });
  assert.equal(items.length, 2);
  assert.equal(items[0].jumpId, 'store-dishes');
  assert.equal(items[0].title, '删除菜品');
  assert.match(items[0].detail, /还没执行/);
  assert.equal(items[1].jumpId, 'store-info-form');
  assert.match(items[1].title, /改动/);
});

test('动作类待确认项复用原业务面板的锚点，未知动作不编造按钮', async () => {
  const { describePendingConfirmations } = await import('../src/domain/agentPendingConfirm.mjs');
  const items = describePendingConfirmations({
    fields: [],
    actions: [
      { opId: 'a1', actionId: 'template.select', status: 'needs-confirmation', reason: '选择模板需要你在原业务面板确认后执行。' },
      { opId: 'a2', actionId: 'export.run', status: 'needs-confirmation' },
      { opId: 'a3', actionId: 'unknown.thing', status: 'unavailable', reason: '当前阶段做不到。' },
    ],
  });
  assert.deepEqual(items.map((item) => item.jumpId), ['template-apply', 'deploy-start', null]);
  assert.match(items[0].detail, /原业务面板/);
  assert.match(items[2].detail, /当前阶段做不到/);
});

test('每个可见确认入口都对应一个真实存在的 data-jump-id 锚点', async () => {
  const { describePendingConfirmations } = await import('../src/domain/agentPendingConfirm.mjs');
  const items = describePendingConfirmations({
    fields: [{ opId: 'f1', fieldId: 'store.dishes', op: 'dish.remove' }],
    actions: [
      { opId: 'a1', actionId: 'agentDraft.confirm' },
      { opId: 'a2', actionId: 'template.select' },
      { opId: 'a3', actionId: 'template.revise' },
      { opId: 'a4', actionId: 'export.preflight' },
      { opId: 'a5', actionId: 'export.run' },
      { opId: 'a6', actionId: 'asset.attach-store-image' },
    ],
  });
  const anchors = new Set();
  for (const rel of [
    'src/components/agent/DraftEditor.jsx',
    'src/components/agent/StoreInfoActionBar.jsx',
    'src/components/flow/TemplateGallery.jsx',
    'src/components/flow/TemplateRevisePanel.jsx',
    'src/components/deploy/PreflightPanel.jsx',
    'src/components/build/DeployStep.jsx',
    'src/components/screenRef/FrontendCandidatePanel.jsx',
  ]) {
    const source = read(rel);
    for (const match of source.matchAll(/data-jump-id="([^"]+)"/g)) anchors.add(match[1]);
    // 门店资料拆两栏后锚点改为按 mode 计算的变量，锚点表要跟着取变量里的字面量。
    for (const match of source.matchAll(/data-jump-id=\{([A-Za-z0-9_$]+)\}/g)) {
      const decl = new RegExp(`const ${match[1].replace(/\$/g, '\\$')} =[^;]*;`).exec(source);
      if (!decl) continue;
      for (const literal of decl[0].matchAll(/'([a-z]+(?:-[a-z]+)+)'/g)) anchors.add(literal[1]);
    }
  }
  for (const item of items) {
    if (!item.jumpId) continue;
    assert.ok(anchors.has(item.jumpId), `${item.jumpId} 必须是真实控件上的锚点，不能是死按钮`);
  }
});

test('门店资料拆两栏后锚点仍唯一：store-info-form 只挂在门店那一份编辑区', () => {
  const source = read('src/components/agent/DraftEditor.jsx');
  // 同一个组件按 mode 渲染两份，锚点必须按 mode 区分，否则「前往确认」可能滚到菜品那一栏。
  assert.match(source, /const rootJumpId = mode === 'dishes' \? undefined : 'store-info-form';/);
  assert.match(source, /data-jump-id=\{rootJumpId\}/);
  assert.doesNotMatch(source, /data-jump-id="store-info-form"/, '写死会让两栏都带同一个锚点');
  assert.match(source, /id="agent-field-dishes" data-jump-id="store-dishes"/);
});

test('卡片渲染可点的「前往确认」，过期时整块收起只剩「重新发一次」，且不提供第二个同名目标', () => {
  const card = read('src/components/agent/AppAssistantChangeCard.jsx');
  assert.match(card, /前往确认/);
  assert.match(card, /aria-label=\{`前往确认：\$\{item\.title\}`\}/, '同屏多条待确认要有可区分名称');
  assert.match(card, /disabled=\{item\.sameTargetAsHint === true\}/);
  assert.match(card, /PENDING_CONFIRM_NOTE/);
  assert.doesNotMatch(card, /\.click\(\)|dispatch\(/, '卡片只定位，不得自己触发写入');
  // 过期：不再渲染入口，也不再说「尚未写入」，避免和「已写入」同时出现。
  assert.match(card, /这一轮的提案已经过期/);
  assert.match(card, /请重新发一次再确认/);
  assert.match(card, /pendingExpired\s*\n?\s*\?/, '过期要走单独分支，而不是只把按钮置灰');
  assert.match(card, /当时需要确认，这一轮已经过期/, '过期文案不能再写「尚未写入」');
});

test('项目在响应之后又变了（含用户自己删完菜）时，旧待确认卡片立刻失效', () => {
  const machine = read('src/state/sessionMachine.mjs');
  assert.match(machine, /baselineRevision,/, 'lastPending 要记住这一轮的版本基线');
  assert.match(machine, /projectId: state\.project\?\.activeId \?\? null,/, 'lastPending 要记住所属项目');

  const app = read('src/App.jsx');
  const drift = app.slice(app.indexOf('const pendingDrift ='), app.indexOf('const pendingDrift =') + 1200);
  assert.match(drift, /pending\.baselineRevision/);
  assert.match(drift, /state\.project\?\.contentRevision/);
  assert.match(drift, /switchedProject/, '换项目也算过期');
  assert.match(app, /const agentChatView = pendingDrift \? \{ \.\.\.agentChatState, lastStale: pendingDrift \}/);
  assert.match(app, /chat: agentChatView,/, '面板必须拿到带过期标记的视图，否则按钮还能点');
});

test('App 接线：待确认项带 op、按阶段跳转、与等待提示去重', () => {
  const app = read('src/App.jsx');
  assert.match(app, /import \{ describePendingConfirmations \} from '\.\/domain\/agentPendingConfirm\.mjs'/);
  assert.match(app, /op: item\.op \?\? null/, '待确认项要带上 op 才能区分删菜与清空');
  assert.match(app, /pendingConfirm: \{ items: pendingConfirmItems, onGo: handlePendingConfirmGo \}/);
  const go = app.slice(app.indexOf('const handlePendingConfirmGo'), app.indexOf('const handlePendingConfirmGo') + 700);
  assert.match(go, /jumpToControl\(jumpId\)/, '复用同一套滚动高亮');
  assert.match(go, /PHASE_GOTO/, '确认入口在别的阶段时要先切阶段');
  assert.doesNotMatch(go, /\.click\(\)|APP_ASSISTANT_CHANGES_APPLY|auto: ?true/, '定位不等于确认');

  const hint = app.slice(app.indexOf('sameTargetAsHint:'), app.indexOf('sameTargetAsHint:') + 200);
  assert.match(hint, /agentWaitingHint\.jumpId === item\.jumpId/, '同一处不能出现两个确认入口');
});

test('跳转用 instant 滚动：否则会被聊天流的 smooth 自动滚到底吞掉', () => {
  const app = read('src/App.jsx');
  const jump = app.slice(app.indexOf('const jumpToControl'), app.indexOf('const jumpToControl') + 900);
  assert.match(jump, /behavior: 'instant'/);
});

test('侧栏把 pendingConfirm 一路传到卡片', () => {
  const panel = read('src/components/agent/AgentSidebarPanel.jsx');
  assert.match(panel, /pendingConfirm = null/);
  assert.match(panel, /pendingConfirm=\{item\.pending \? pendingConfirm : null\}/);
  assert.match(panel, /pendingExpired=\{Boolean\(item\.pending && item\.stale\)\}/);
});
