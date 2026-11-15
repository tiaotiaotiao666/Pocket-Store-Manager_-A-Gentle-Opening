'use strict';

/**
 * 部署页 ⇄ 能力勾选 的回路。
 *
 * 背景：部署页的 W-BASE-FEATURE-UNCHECKED 提示带「去确认能力勾选」入口，
 * 跳到功能页后整条流程被重置、已确认的提示与导出记录都白做。这里固定
 * PHASE_GOTO / PHASE_RETURN 的退回语义。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

async function atDeploy() {
  const machine = await import('../src/state/sessionMachine.mjs');
  const { PHASES } = await import('../src/state/constants.mjs');
  let state = machine.createInitialState();
  state = machine.reducer(state, { type: 'PHASE_GOTO', phase: PHASES.DEPLOY });
  return { machine, PHASES, state };
}

test('从部署页跳去功能页：留下回路，活跃会话不变', async () => {
  const { machine, PHASES, state } = await atDeploy();
  const beforeSession = state.activeSessionId;

  const features = machine.reducer(state, { type: 'PHASE_GOTO', phase: PHASES.FEATURES });

  assert.equal(features.phase, PHASES.FEATURES);
  assert.deepEqual(features.phaseReturn, { phase: PHASES.DEPLOY, sessionId: beforeSession });
  assert.equal(features.activeSessionId, beforeSession, '功能页没有独立会话，不应把活跃会话切走');
});

test('PHASE_RETURN 回到部署页并清空回路', async () => {
  const { machine, PHASES, state } = await atDeploy();
  const features = machine.reducer(state, { type: 'PHASE_GOTO', phase: PHASES.FEATURES });

  const back = machine.reducer(features, { type: 'PHASE_RETURN' });

  assert.equal(back.phase, PHASES.DEPLOY);
  assert.equal(back.phaseReturn, null);
  assert.equal(back.view, 'flow');
});

test('回到部署页后 preflight 的确认状态仍在', async () => {
  const { machine, PHASES, state } = await atDeploy();
  const checked = {
    ...state,
    deploy: {
      ...state.deploy,
      preflight: {
        status: 'done',
        errors: [],
        warns: [{ ruleId: 'W-NO-APPID' }],
        acknowledged: ['W-NO-APPID'],
        checkedAt: 1,
      },
    },
  };

  const features = machine.reducer(checked, { type: 'PHASE_GOTO', phase: PHASES.FEATURES });
  const back = machine.reducer(features, { type: 'PHASE_RETURN' });

  assert.deepEqual(back.deploy.preflight.acknowledged, ['W-NO-APPID']);
  assert.equal(back.deploy.preflight.status, 'done');
});

test('跳回部署页本身不产生回路；没有回路时 PHASE_RETURN 原样返回', async () => {
  const { machine, PHASES, state } = await atDeploy();

  const goto = machine.reducer(state, { type: 'PHASE_GOTO', phase: PHASES.DEPLOY });
  assert.equal(goto.phaseReturn, null);

  const noop = machine.reducer(goto, { type: 'PHASE_RETURN' });
  assert.equal(noop, goto, '没有回路时返回同一个 state 引用');
});

test('功能页往下走（SUBMIT_CUSTOMIZE）会清掉回路，避免回退到旧部署', async () => {
  const { machine, PHASES, state } = await atDeploy();
  const features = machine.reducer(state, { type: 'PHASE_GOTO', phase: PHASES.FEATURES });

  const building = machine.reducer(features, { type: 'SUBMIT_CUSTOMIZE', value: '' });

  assert.equal(building.phase, PHASES.BUILDING);
  assert.equal(building.phaseReturn, null);
});
