'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(REPO, relativePath), 'utf8'));
}

function loadRecipeCatalog() {
  return import('../src/domain/recipeCatalog.mjs');
}

test('recipeCatalog 的 features 与 templates/recipes/*/plan.json 逐字段一致', async () => {
  const { RECIPES, RECIPE_VERSION } = await loadRecipeCatalog();

  for (const recipeId of ['order-classic', 'order-poster']) {
    const plan = readJson(`templates/recipes/${recipeId}/1.0.0/plan.json`);
    const entry = RECIPES[recipeId];
    assert.ok(entry, `RECIPES 缺少 ${recipeId}`);
    assert.strictEqual(entry.id, recipeId);
    assert.strictEqual(entry.version, plan.planVersion);
    assert.strictEqual(entry.version, RECIPE_VERSION);
    assert.deepStrictEqual(
      entry.features,
      plan.features,
      `${recipeId} 的 features 与 plan.json 漂移：预览/导出将不再同源`,
    );
  }
});

test('recipeCatalog 的 displayName 与 recipe.json 一致', async () => {
  const { RECIPES } = await loadRecipeCatalog();

  for (const recipeId of ['order-classic', 'order-poster']) {
    const recipeDoc = readJson(`templates/recipes/${recipeId}/1.0.0/recipe.json`);
    assert.strictEqual(RECIPES[recipeId].displayName, recipeDoc.displayName);
    assert.strictEqual(RECIPES[recipeId].description, recipeDoc.description);
  }
});

test('TEMPLATE_TO_RECIPE 的每个目标都是已登记 Recipe', async () => {
  const { RECIPES, TEMPLATE_TO_RECIPE, DEFAULT_RECIPE_ID } = await loadRecipeCatalog();

  assert.ok(RECIPES[DEFAULT_RECIPE_ID]);
  for (const [templateId, recipeId] of Object.entries(TEMPLATE_TO_RECIPE)) {
    assert.ok(RECIPES[recipeId], `${templateId} 映射到未登记的 ${recipeId}`);
  }
  assert.deepStrictEqual(Object.keys(TEMPLATE_TO_RECIPE).sort(), [
    'modern-coffee',
    'signature-kitchen',
    'warm-bistro',
  ]);
});

test('resolveRecipe 返回深拷贝，调用方修改不会污染冻结的配方常量', async () => {
  const { resolveRecipe, RECIPES } = await loadRecipeCatalog();

  const first = resolveRecipe('signature-kitchen');
  assert.strictEqual(first.recipe.id, 'order-poster');
  first.recipe.features[0].slots[0].props.items[0].title = '被篡改';
  first.recipe.features[0].slots[0].props.items.push({ id: 'x', title: '多余', subtitle: '', tone: 'warm' });

  const second = resolveRecipe('signature-kitchen');
  assert.strictEqual(second.recipe.features[0].slots[0].props.items.length, 3);
  assert.strictEqual(second.recipe.features[0].slots[0].props.items[0].title, '秋日暖锅上新');
  assert.strictEqual(RECIPES['order-poster'].features[0].slots[0].props.items.length, 3);
});

test('未知模板与缺失模板都回落到 order-classic，且只有未知模板触发 fallback', async () => {
  const { resolveRecipe } = await loadRecipeCatalog();

  assert.deepStrictEqual(resolveRecipe(null).recipe.id, 'order-classic');
  assert.strictEqual(resolveRecipe(null).fallback, false);
  assert.strictEqual(resolveRecipe(undefined).fallback, false);
  assert.strictEqual(resolveRecipe('warm-bistro').fallback, false);
  assert.strictEqual(resolveRecipe('not-a-template').fallback, true);
  assert.strictEqual(resolveRecipe('not-a-template').recipe.id, 'order-classic');
});

test('describeRecipe 对未知值回落 order-classic 且只暴露三个展示字段', async () => {
  const { describeRecipe } = await loadRecipeCatalog();

  assert.deepStrictEqual(describeRecipe('order-poster'), {
    id: 'order-poster',
    displayName: '海报点餐',
    version: '1.0.0',
  });
  assert.deepStrictEqual(describeRecipe('__proto__'), {
    id: 'order-classic',
    displayName: '经典点餐',
    version: '1.0.0',
  });
});