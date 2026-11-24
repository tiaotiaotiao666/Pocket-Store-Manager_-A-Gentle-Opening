'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const loadRule = () => import('../src/domain/storeName.mjs');

test('店名上限只有一份：19/20/21 边界与可见字符计数', async () => {
  const rule = await loadRule();
  assert.equal(rule.STORE_NAME_MAX_LENGTH, 20);
  assert.equal(rule.countStoreNameChars('店'.repeat(19)), 19);
  assert.equal(rule.countStoreNameChars('店'.repeat(20)), 20);
  assert.equal(rule.countStoreNameChars('店'.repeat(21)), 21);

  const at20 = rule.describeStoreNameLength('店'.repeat(20));
  assert.deepEqual(at20, { length: 20, max: 20, atLimit: true, overLimit: false });
  assert.equal(rule.validateStoreName('店'.repeat(20)).ok, true);
  assert.equal(rule.validateStoreName('店'.repeat(21)).ok, false);
  assert.match(rule.validateStoreName('店'.repeat(21)).reason, /20/);
});

test('中英数混排与 emoji 都按可见字符计数，截断不切半', async () => {
  const rule = await loadRule();
  const mixed = '面香小馆Abc123'.repeat(2) + '!'; // 每组 10 个可见字符，共 21
  assert.equal(rule.countStoreNameChars(mixed), 21);
  assert.equal(rule.countStoreNameChars('面香小馆Abc123'.repeat(2)), 20);

  const emoji = '😀'.repeat(25);
  assert.equal(rule.countStoreNameChars(emoji), 25);
  const cut = rule.truncateStoreName(emoji);
  assert.equal(cut.truncated, true);
  assert.equal(rule.countStoreNameChars(cut.value), 20);
  assert.equal(Array.from(cut.value).length, 20, '不能留下半个代理对');
  assert.ok(!/[\uD800-\uDBFF]$/.test(cut.value), '结尾不能是孤立的高位代理');

  // ZWJ 组合（家庭 emoji）算 1 个整体，不会被拆成几段
  const family = '👨‍👩‍👧‍👦';
  assert.equal(rule.countStoreNameChars(family), 1);
  assert.equal(rule.countStoreNameChars(`店${family}店`), 3);
  const zwjCut = rule.truncateStoreName('店'.repeat(20) + family);
  assert.equal(zwjCut.truncated, true);
  assert.equal(zwjCut.value, '店'.repeat(20), '组合 emoji 整体被截掉，不留残片');

  // 变体选择符（❤️）也挂在前一个字符上
  assert.equal(rule.countStoreNameChars('❤️'), 1);
});

test('截断与到限提示语只有一份，且提示语写明 20 字', async () => {
  const rule = await loadRule();
  assert.match(rule.STORE_NAME_TRUNCATED_NOTICE, /已按 20 字上限截断/);
  assert.match(rule.STORE_NAME_LIMIT_NOTICE, /20 字上限/);
});

test('同一规则收敛：草稿校验/能力目录/展示文案都用 20，导出与老数据用 48 兼容上限', async () => {
  const rule = await loadRule();
  assert.equal(rule.STORE_NAME_LEGACY_MAX_LENGTH, 48);

  const draft = await import('../src/domain/agentDraft.mjs');
  assert.equal(draft.AGENT_DRAFT_LIMITS.maxStoreName, rule.STORE_NAME_MAX_LENGTH);

  const caps = await import('../src/domain/appCapabilities.mjs');
  const field = caps.findAppCapabilityField('store.name');
  assert.equal(field.limits.maxChars, 20, 'AI 提案与领域校验上限必须同源');

  const snapshot = JSON.parse(read('server/src/agent/app-assistant/capabilities.snapshot.json'));
  const storeNameField = JSON.stringify(snapshot).includes('"maxChars":20');
  assert.ok(storeNameField, '服务端快照必须重新生成成 20');

  // 导出体检仍走 48：历史项目里超过 20 字的店名不能因为体检而被判失败
  const preflight = await import('../src/domain/preflightRules.mjs');
  const long = preflight.evaluateLocal({
    store: { name: '店'.repeat(30) },
    agentDraft: {
      storeName: '店'.repeat(30),
      category: '社区餐馆',
      businessHours: '10:00-21:00',
      fulfillment: { dineIn: true, pickup: false, delivery: false },
      dishes: [{ id: 'd1', name: '牛肉面', priceCents: 2600, description: '' }],
    },
  });
  assert.ok(!(long.errors || []).some((item) => item.field === 'store.name'), '30 字老数据不该被导出体检拦下');
});

test('输入层真的接上了 20 字规则：门店资料店名输入走 StoreNameField（带字数与截断提示）', () => {
  const editor = read('src/components/agent/DraftEditor.jsx');
  assert.match(editor, /import StoreNameField from '\.\.\/common\/StoreNameField\.jsx'/);
  assert.match(editor, /<StoreNameField[\s\S]{0,400}onChange=\{\(next\) => onChangeField\?\.\('storeName', next\)\}/);
  assert.doesNotMatch(editor, /onChange=\{\(event\) => onChangeField\?\.\('storeName', event\.target\.value\)\}/, '店名不能再走裸 input 的原始输入');

  const field = read('src/components/common/StoreNameField.jsx');
  assert.match(field, /truncateStoreName/, '输入时就按上限收敛，不能留到下游截断');
  assert.match(field, /onCompositionStart/, '输入法组合中不能被打断');
  assert.match(field, /onPaste/, '粘贴必须同一口径');
  assert.match(field, /onDrop/, '拖拽也必须同一口径');
  assert.doesNotMatch(field, /maxLength=/, 'maxLength 按 UTF-16 截断会切坏 emoji');
  assert.match(field, /\{length\}\/\{STORE_NAME_MAX_LENGTH\}/, '要显示「当前字数/20」');
});

test('服务端与桌面域的店名上限不再各写一个 48', () => {
  assert.match(read('src/domain/agentDraft.mjs'), /STORE_NAME_MAX_LENGTH/);
  assert.match(read('src/domain/preflightRules.mjs'), /STORE_NAME_LEGACY_MAX_LENGTH/);
  assert.match(read('server/src/agent/agent-draft.validator.ts'), /const MAX_STORE_NAME = 20;/);
});
