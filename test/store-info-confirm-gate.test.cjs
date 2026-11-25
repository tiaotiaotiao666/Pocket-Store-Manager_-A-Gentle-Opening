'use strict';

/**
 * 「资料无误，继续」判定口径的回归测试（问题：AI 写入后按钮死禁）。
 *
 * 真实缺陷：轻启一次写入多字段后 agent.status 可能滞后在 collecting/idle，
 * 资料其实已经齐全，但按钮按 status === 'reviewing' 判定 → 一直禁用，
 * 文案还写「等待输入开店资料」，用户只能随便改一个字才解冻。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const repoRoot = path.resolve(__dirname, '..');

async function loadAgentDraft() {
  return import(pathToFileURL(path.join(repoRoot, 'src/domain/agentDraft.mjs')).href);
}

async function loadActionText() {
  return import(pathToFileURL(path.join(repoRoot, 'src/domain/storeInfoActionText.mjs')).href);
}

test('资料齐全且状态滞后（collecting/idle）：仍可继续，不再死禁', async () => {
  const { canConfirmStoreInfo } = await loadAgentDraft();
  assert.equal(canConfirmStoreInfo('collecting', 0, 0), true, 'AI 写入后状态滞后不应卡住确认');
  assert.equal(canConfirmStoreInfo('idle', 0, 0), true);
  assert.equal(canConfirmStoreInfo('reviewing', 0, 0), true);
});

test('资料不齐或有错误：一律不可继续', async () => {
  const { canConfirmStoreInfo } = await loadAgentDraft();
  assert.equal(canConfirmStoreInfo('collecting', 2, 0), false);
  assert.equal(canConfirmStoreInfo('reviewing', 0, 1), false);
  assert.equal(canConfirmStoreInfo('reviewing', 1, 1), false);
});

test('进行中与已确认：不可重复点继续', async () => {
  const { canConfirmStoreInfo } = await loadAgentDraft();
  assert.equal(canConfirmStoreInfo('requesting', 0, 0), false);
  assert.equal(canConfirmStoreInfo('confirmed', 0, 0), false);
});

test('缺省入参按 0 项处理，不抛异常', async () => {
  const { canConfirmStoreInfo } = await loadAgentDraft();
  assert.equal(canConfirmStoreInfo('collecting'), true);
  assert.equal(canConfirmStoreInfo(undefined, undefined, undefined), true);
});

test('空草稿（真实缺字段）仍然被挡住：validate + 判定一致', async () => {
  const { canConfirmStoreInfo, createEmptyAgentDraft, validateAgentDraft } = await loadAgentDraft();
  const validation = validateAgentDraft(createEmptyAgentDraft());
  assert.ok(validation.missingFields.length > 0, '空草稿应当缺字段');
  assert.equal(canConfirmStoreInfo('collecting', validation.missingFields.length, validation.errors.length), false);
});

test('操作栏文案：缺字段要说清楚缺几项，不得静默或无意义', async () => {
  const { storeInfoActionSummary } = await loadActionText();
  assert.equal(storeInfoActionSummary('collecting', 4, false), '还有 4 项待补充');
  assert.equal(storeInfoActionSummary('collecting', 1, false), '还有 1 项待补充');
  assert.equal(storeInfoActionSummary('requesting', 0, false), '正在整理资料，请稍候');
  assert.equal(storeInfoActionSummary('failed', 2, false), '请求失败，还有 2 项待处理');
});

test('操作栏文案：资料齐全时不再显示「等待输入开店资料」', async () => {
  const { storeInfoActionSummary } = await loadActionText();
  assert.equal(storeInfoActionSummary('collecting', 0, true), '资料已齐全，可以继续');
  assert.equal(storeInfoActionSummary('reviewing', 0, true), '资料已齐全，可以继续');
  assert.equal(storeInfoActionSummary('confirmed', 0, false), '资料已确认，正在写入门店信息');
  assert.notEqual(storeInfoActionSummary('collecting', 0, true), '等待输入开店资料');
});
