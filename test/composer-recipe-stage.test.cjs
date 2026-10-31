'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const { validateRecipeStage, listSelectableRecipes } = require(path.join(REPO, 'scripts', 'registry-check.cjs'));

function recipe(stage, overrides = {}) {
  return {
    schemaVersion: 'recipe.v1',
    identity: { id: 'order-classic', version: '1.0.0' },
    planRef: 'plan.json',
    displayName: '测试',
    description: '测试',
    recipe: {
      stage,
      verifiedAt: null,
      wechatCompile: 'not-run',
      regression: 'not-run',
      secretScan: 'pass',
      approvals: [],
      knownLimits: [],
      ...overrides,
    },
  };
}

test('candidate 不要求晋升证据', () => {
  assert.deepStrictEqual(validateRecipeStage(recipe('candidate'), 'order-classic'), []);
});

test('direct 必须四类证据齐全', () => {
  const missing = validateRecipeStage(recipe('direct'), 'order-classic');
  assert.strictEqual(missing.length, 1);
  assert.strictEqual(missing[0].code, 'RECIPE_EVIDENCE_MISSING');
  assert.deepStrictEqual(missing[0].details.missing, ['wechatCompile', 'regression', 'approvals']);

  const complete = validateRecipeStage(recipe('direct', {
    wechatCompile: 'pass',
    regression: 'pass',
    secretScan: 'pass',
    approvals: [{ reviewer: 'release-review', reviewedAt: '2026-11-01T00:00:00Z' }],
  }), 'order-classic');
  assert.deepStrictEqual(complete, []);
});

test('身份与 stage 非法被拒绝', () => {
  const wrongId = validateRecipeStage(recipe('candidate'), 'order-poster');
  assert.strictEqual(wrongId[0].code, 'RECIPE_SCHEMA_INVALID');

  const badStage = validateRecipeStage(recipe('published'), 'order-classic');
  assert.strictEqual(badStage[0].code, 'RECIPE_STAGE_INVALID');
});

test('店主可选列表只包含 direct Recipe，候选与过期不进列表', () => {
  const registry = {
    assets: [
      { kind: 'recipe', id: 'order-classic', version: '1.0.0', recipe: recipe('direct', { wechatCompile: 'pass', regression: 'pass', approvals: [{}] }) },
      { kind: 'recipe', id: 'order-poster', version: '1.0.0', recipe: recipe('candidate') },
      { kind: 'recipe', id: 'old-recipe', version: '1.0.0', recipe: recipe('expired') },
      { kind: 'ui-block', id: 'store-header', version: '1.0.0' },
    ],
  };
  assert.deepStrictEqual(listSelectableRecipes(registry), [{ id: 'order-classic', version: '1.0.0' }]);
});

test('preview-only 资产不能进入 direct Recipe（规则由 resolve 守卫）', () => {
  const resolveSource = require('node:fs').readFileSync(path.join(REPO, 'scripts', 'composer', 'resolve.cjs'), 'utf8');
  assert.match(resolveSource, /PREVIEW_ONLY_IN_ONLINE_RECIPE/);
  assert.match(resolveSource, /PREVIEW_ONLY_NOT_ACKNOWLEDGED/);
});