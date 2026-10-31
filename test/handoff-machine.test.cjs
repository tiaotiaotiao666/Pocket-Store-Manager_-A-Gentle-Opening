'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');

async function load() {
  const module = await import(require('node:url').pathToFileURL(path.join(REPO, 'src', 'domain', 'handoffMachine.mjs')).href);
  return module;
}

test('六步顺序固定，前进/回退边界安全', async () => {
  const handoff = await load();
  assert.deepStrictEqual(handoff.handoffStepIds(), ['prepare', 'import', 'appid', 'domain', 'preview', 'next']);
  assert.strictEqual(handoff.nextStepId('prepare'), 'import');
  assert.strictEqual(handoff.nextStepId('next'), 'next');
  assert.strictEqual(handoff.prevStepId('prepare'), 'prepare');
  assert.strictEqual(handoff.prevStepId('appid'), 'import');
});

test('完成步骤去重追加并自动前进', async () => {
  const handoff = await load();
  let state = handoff.createHandoffState(() => new Date('2026-10-31T09:00:00Z'));
  assert.strictEqual(state.stepId, 'prepare');
  state = handoff.completeStep(state, 'prepare', () => new Date('2026-10-31T09:01:00Z'));
  assert.deepStrictEqual(state.completedStepIds, ['prepare']);
  assert.strictEqual(state.stepId, 'import');
  state = handoff.completeStep(state, 'prepare');
  assert.deepStrictEqual(state.completedStepIds, ['prepare']);
});

test('非法 stepId 被拒绝且保持原状态', async () => {
  const handoff = await load();
  const state = handoff.createHandoffState();
  assert.strictEqual(handoff.setStep(state, 'not-a-step').stepId, 'prepare');
  assert.strictEqual(handoff.completeStep(state, 'hack').stepId, 'prepare');
});

test('恢复形状校验：去重、过滤非法值、补默认字段', async () => {
  const handoff = await load();
  const restored = handoff.validateHandoffShape({
    stepId: 'appid',
    completedStepIds: ['prepare', 'prepare', 'bad', 'import'],
    appidApplied: true,
    appidDigestBefore: 'sha256:1',
    appidDigestAfter: 2,
    devtoolsDetected: 'yes',
  });
  assert.deepStrictEqual(restored.completedStepIds, ['prepare', 'import']);
  assert.strictEqual(restored.appidApplied, true);
  assert.strictEqual(restored.appidDigestBefore, 'sha256:1');
  assert.strictEqual(restored.appidDigestAfter, null);
  assert.strictEqual(restored.devtoolsDetected, false);
  assert.strictEqual(typeof restored.updatedAt, 'string');
  assert.strictEqual(handoff.validateHandoffShape(null), null);
  assert.strictEqual(handoff.validateHandoffShape({ stepId: 'bad' }), null);
});

test('AppID 结果写入 handoff，进度按已完成数量计算', async () => {
  const handoff = await load();
  let state = handoff.createHandoffState();
  state = handoff.applyAppidResult(state, { applied: true, digestBefore: 'sha256:a', digestAfter: 'sha256:b' });
  assert.strictEqual(state.appidApplied, true);
  assert.strictEqual(state.appidDigestBefore, 'sha256:a');
  assert.strictEqual(state.appidDigestAfter, 'sha256:b');

  state = handoff.completeStep(state, 'prepare');
  state = handoff.completeStep(state, 'import');
  const progress = handoff.progressOf(state);
  assert.strictEqual(progress.total, 6);
  assert.strictEqual(progress.completedCount, 2);
  assert.strictEqual(progress.currentIndex, 2);
  assert.strictEqual(progress.percent, 33);
});

test('完成最后一步才标记为结束', async () => {
  const handoff = await load();
  let state = handoff.createHandoffState();
  assert.strictEqual(handoff.isFinished(state), false);
  state = handoff.completeStep(state, 'next');
  assert.strictEqual(state.stepId, 'next');
  assert.strictEqual(handoff.isFinished(state), true);
});