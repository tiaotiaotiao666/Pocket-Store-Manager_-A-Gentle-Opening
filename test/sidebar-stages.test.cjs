const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 左侧栏步骤块：不要「会话记录」，用可回跳的步骤块让用户回头修改。
 *
 * S1 步骤投影带可回跳目标与门禁（构建中 / 模型请求中不可跳）
 * S2 左栏组件：只渲染步骤块，不再渲染会话列表
 * S3 接线：点击步骤走 PHASE_GOTO，且不再传 onSelectSession
 */

const REPO = path.join(__dirname, '..');

function readSource(relative) {
  return fs.readFileSync(path.join(REPO, relative), 'utf8');
}

async function loadFlow() {
  return import('../src/domain/flowStages.mjs');
}

async function loadPhases() {
  return import('../src/state/constants.mjs');
}

test('S1 步骤投影带 phase 与 canVisit：到过的步骤双向可跳', async () => {
  const { describeFlow } = await loadFlow();
  const { PHASES } = await loadPhases();

  const deploy = describeFlow(PHASES.DEPLOY);
  const phases = deploy.steps.map((step) => step.phase);
  assert.deepEqual(phases, [
    PHASES.STORE_INFO,
    PHASES.FEATURES,
    PHASES.TEMPLATE_PICK,
    PHASES.PROMPT_STUDIO,
    PHASES.DEPLOY,
  ]);
  assert.deepEqual(deploy.steps.map((step) => step.canVisit), [true, true, true, true, false]);
  assert.equal(deploy.steps.at(-1).state, 'current', '当前步不提供跳转');

  const material = describeFlow(PHASES.IMAGE_REVIEW);
  assert.deepEqual(material.steps.map((step) => step.canVisit), [true, true, true, false, false]);

  const store = describeFlow(PHASES.STORE_INFO);
  assert.deepEqual(store.steps.map((step) => step.canVisit), [false, false, false, false, false]);
  assert.deepEqual(store.steps.map((step) => step.visited), [true, false, false, false, false], '没到过的步骤不可点');

  // 关键：从导出退回到门店资料后，后面已经到过的步骤仍能点回去，不必一步步重走。
  const backToStore = describeFlow(PHASES.STORE_INFO, { reachedIndex: 4 });
  assert.deepEqual(backToStore.steps.map((step) => step.canVisit), [false, true, true, true, true]);
  assert.deepEqual(backToStore.steps.map((step) => step.visited), [true, true, true, true, true]);

  const backToFeatures = describeFlow(PHASES.FEATURES, { reachedIndex: 4 });
  assert.deepEqual(backToFeatures.steps.map((step) => step.canVisit), [true, false, true, true, true]);

  const building = describeFlow(PHASES.BUILDING, { busy: true, reachedIndex: 4 });
  assert.deepEqual(building.steps.map((step) => step.canVisit), [false, false, false, false, false], '构建中不给跳转');
});

test('S2 左栏只渲染步骤块，不再渲染会话记录', () => {
  const sidebar = readSource('src/components/layout/Sidebar.jsx');

  assert.doesNotMatch(sidebar, /会话记录/);
  assert.doesNotMatch(sidebar, /sidebar-session/);
  assert.doesNotMatch(sidebar, /onSelectSession/);
  assert.doesNotMatch(sidebar, /state\.sessions/);

  assert.match(sidebar, /sidebar-stages/);
  assert.match(sidebar, /sidebar-stage is-\$\{step\.state\}/);
  assert.match(sidebar, /onSelectStage\?\.\(step\.phase\)/);
  assert.match(sidebar, /disabled=\{!canVisit\}/);
  assert.match(sidebar, /aria-current=\{isCurrent \? 'step' : undefined\}/);
  assert.match(sidebar, /返回这一步修改/);
  assert.match(sidebar, /回到这一步继续/);
  assert.match(sidebar, /step\.visited && !isCurrent/, '到过的步骤用对勾标出来');
});

test('S3 接线：步骤块点击走 PHASE_GOTO，已填数据由 reducer 保留', () => {
  const app = readSource('src/App.jsx');
  const machine = readSource('src/state/sessionMachine.mjs');

  assert.match(app, /const goToStage = \(targetPhase\) => dispatch\(\{ type: 'PHASE_GOTO', phase: targetPhase \}\)/);
  assert.match(app, /<Sidebar[\s\S]{0,400}flow=\{flowDescriptor\}[\s\S]{0,400}onSelectStage=\{goToStage\}/);
  assert.doesNotMatch(app, /onSelectSession=/);

  // 双向导航：App 记录本次项目走到过的最远一步，并交给 describeFlow 决定 "可以点回来"。
  assert.match(app, /reachedStageIndex/);
  assert.match(app, /reachedIndex: reachedStageIndex/);
  assert.match(app, /setReachedStage/);

  // PHASE_GOTO 只切视图/相位/会话，不回滚门店、能力等业务 slice。
  assert.match(machine, /case 'PHASE_GOTO': \{[\s\S]{0,900}view: 'flow'/);
  assert.doesNotMatch(machine, /case 'PHASE_GOTO': \{[\s\S]{0,900}store: \{\s*\.\.\.initialState/);
});

test('S4 步骤块样式：白底卡片、当前步高亮、未完成为弱化态', () => {
  const css = readSource('src/styles/layout.css');

  assert.match(css, /\.sidebar-stages\s*\{[\s\S]{0,200}overflow-y:\s*auto/);
  assert.match(css, /\.sidebar-stage\s*\{[\s\S]{0,300}background:\s*var\(--bg-elev\)/);
  assert.match(css, /\.sidebar-stage\.is-current\s*\{[\s\S]{0,160}background:\s*var\(--accent-soft\)/);
  assert.match(css, /\.sidebar-stage\.is-todo\s*\{/);
  assert.match(css, /\.sidebar-stage\.can-visit:hover\s*\{/);
  // 退回去之后，后面已经到过的块要保持白卡可读，而不是继续灰成不可用。
  assert.match(css, /\.sidebar-stage\.is-todo\.can-visit\s*\{/);
  assert.match(css, /\.sidebar-stage\.is-todo\.can-visit \.sidebar-stage-index\s*\{/);
});