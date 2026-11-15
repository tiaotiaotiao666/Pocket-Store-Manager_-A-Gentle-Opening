'use strict';

/**
 * 「E-TARGET-EXISTS 时能否换目录」的门禁回归。
 *
 * 背景：走查一度判定这里会死锁。实际上 `selectCanChooseDirectory` 对
 * 同名冲突单独放行：只要有冲突、没有其他 error、且 warn 都已确认，就允许换目录。
 * 这里锁住这条规则，避免以后被误改成 blocked。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');

function stateWithPreflight(preflight) {
  return {
    project: { mode: 'desktop' },
    deploy: { preflight },
  };
}

test('E-TARGET-EXISTS + warn 已确认：允许换目录', async () => {
  const { selectCanChooseDirectory } = await import('../src/state/sessionMachine.mjs');
  const gate = selectCanChooseDirectory(stateWithPreflight({
    status: 'done',
    errors: [{ ruleId: 'E-TARGET-EXISTS', message: '目标目录已有同名工程' }],
    warns: [{ ruleId: 'W-NO-APPID' }],
    acknowledged: ['W-NO-APPID'],
  }));
  assert.equal(gate.can, true);
  assert.match(gate.reason, /更换导出位置/);
});

test('E-TARGET-EXISTS + warn 未确认：仍阻断，并说明还差几项', async () => {
  const { selectCanChooseDirectory } = await import('../src/state/sessionMachine.mjs');
  const gate = selectCanChooseDirectory(stateWithPreflight({
    status: 'done',
    errors: [{ ruleId: 'E-TARGET-EXISTS' }],
    warns: [{ ruleId: 'W-NO-APPID' }],
    acknowledged: [],
  }));
  assert.equal(gate.can, false);
  assert.match(gate.reason, /还有 1 项提示需要确认/);
});

test('其他 error 与未完成体检仍阻断换目录', async () => {
  const { selectCanChooseDirectory } = await import('../src/state/sessionMachine.mjs');
  const other = selectCanChooseDirectory(stateWithPreflight({
    status: 'done',
    errors: [{ ruleId: 'E-PLAN-CONTRACT' }],
    warns: [],
    acknowledged: [],
  }));
  assert.equal(other.can, false);
  assert.match(other.reason, /需要先修正/);

  const checking = selectCanChooseDirectory(stateWithPreflight({ status: 'checking' }));
  assert.equal(checking.can, false);
});

test('导出成功后仍保留「换一个目录重新导出」入口', () => {
  const step = fs.readFileSync(
    path.join(REPO, 'src', 'components', 'build', 'DeployStep.jsx'),
    'utf8',
  );
  assert.match(step, /status === 'done'[\s\S]{0,40}'换一个目录重新导出'/);
  assert.match(step, /重新导出会生成到新目录，不会覆盖已完成工程/);
});
