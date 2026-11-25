'use strict';

/**
 * 门店资料表单文案回归：
 * 1) 餐饮品类输入框已有 placeholder 示例，下面不再重复一行黄色缺项提示；
 * 2) 门店环境图片标题必须按真实上传状态显示，空列表不能说成「已上传图片」。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

test('门店资料：餐饮品类不再重复显示黄色缺项提示，但保留真实错误提示', () => {
  const editor = read('src/components/agent/DraftEditor.jsx');

  assert.doesNotMatch(
    editor,
    /<FieldMessage error=\{categoryError\} missing=\{fieldMissing\(validation, 'category'\)\} \/>/,
    '品类下方的缺项示例与输入框 placeholder 重复，应删除',
  );
  assert.match(editor, /<FieldMessage error=\{categoryError\} \/>/, '品类校验错误仍要能显示');
  assert.match(editor, /placeholder="例如：社区餐馆、咖啡茶饮"/, '输入框里的示例提示要保留');
});

test('门店环境图片：标题按真实上传状态显示', () => {
  const storeInfo = read('src/components/build/StoreInfoStep.jsx');

  assert.match(
    storeInfo,
    /<h4>\{imageList\.length > 0 \? '已上传图片' : '还没有上传图片'\}<\/h4>/,
    '空列表不能显示「已上传图片」',
  );
  assert.match(storeInfo, /还没有门店环境图片/, '空态说明要保留');
});
