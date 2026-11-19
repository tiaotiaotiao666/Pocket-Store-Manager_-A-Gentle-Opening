'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  APP_ASSISTANT_ACTION_HANDLERS,
  describeAppAssistantAction,
  executeAppAssistantAction,
  executeAppAssistantActions,
  selectUnexecutedActions,
} = require('../src/services/appAssistant/actionExecutor.js');

function action(actionId, params = {}) {
  return {
    opId: `op_${actionId}`,
    op: 'action.request',
    actionId,
    params,
    risk: 'auto',
    evidence: { source: 'utterance', excerpt: '测试' },
  };
}

test('navigate.phase 可自动执行且只调用一次导航入口', () => {
  const calls = [];
  const deps = { state: { phase: 'store-info' }, navigate: (phase) => calls.push(phase) };
  const result = executeAppAssistantAction(action('navigate.phase', { phase: 'template-pick' }), deps);
  assert.equal(result.status, 'executed');
  assert.deepEqual(calls, ['template-pick']);
});

test('非法/相同阶段与缺少入口都判 unavailable，不调用任何东西', () => {
  const calls = [];
  const navigate = (phase) => calls.push(phase);
  assert.equal(executeAppAssistantAction(action('navigate.phase', { phase: 'not-a-phase' }), { state: { phase: 'home' }, navigate }).status, 'unavailable');
  assert.equal(executeAppAssistantAction(action('navigate.phase', { phase: 'home' }), { state: { phase: 'home' }, navigate }).status, 'unavailable');
  assert.equal(executeAppAssistantAction(action('navigate.phase', { phase: 'deploy' }), { state: { phase: 'home' } }).status, 'unavailable');
  assert.deepEqual(calls, []);
});

test('所有高风险动作都只能待确认，不存在绕确认路径', () => {
  const dangerous = [
    'template.select',
    'template.revise',
    'frontend.reconstruct',
    'frontend.adopt',
    'frontend.discard',
    'agentDraft.confirm',
    'export.preflight',
    'export.choose-directory',
    'export.run',
    'asset.attach-store-image',
  ];
  for (const id of dangerous) {
    assert.equal(APP_ASSISTANT_ACTION_HANDLERS[id].auto, false, `${id} 不得自动执行`);
    const result = executeAppAssistantAction(action(id), {
      state: { phase: 'home' },
      navigate: () => { throw new Error('不应导航'); },
    });
    assert.equal(result.status, 'needs-confirmation', `${id} 必须要求确认`);
    assert.ok(result.reason.includes('确认'));
  }
});

test('未知动作与伪造的 reducer/action type 都被拒绝', () => {
  assert.equal(executeAppAssistantAction(action('fs.write'), {}).status, 'unavailable');
  assert.equal(executeAppAssistantAction(action('dispatch'), {}).status, 'unavailable');
  const forged = { op: 'action.request', actionId: 'navigate.phase', params: { phase: 'home' }, actionType: 'RESET' };
  const result = executeAppAssistantAction(forged, { state: { phase: 'home' }, navigate: () => {} });
  assert.equal(result.status, 'unavailable');
});

test('批量执行顺序稳定，每条动作最多一次，结果区分已执行/待确认', () => {
  const calls = [];
  const results = executeAppAssistantActions([
    action('navigate.phase', { phase: 'template-pick' }),
    action('export.run'),
    action('navigate.phase', { phase: 'deploy' }),
  ], {
    state: { phase: 'store-info' },
    navigate: (phase) => calls.push(phase),
  });
  assert.deepEqual(calls, ['template-pick', 'deploy']);
  assert.deepEqual(results.map((item) => item.status), ['executed', 'needs-confirmation', 'executed']);
  const pending = selectUnexecutedActions(results);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].actionId, 'export.run');
});