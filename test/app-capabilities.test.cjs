const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const { AGENT_DRAFT_LIMITS } = require('../src/domain/agentDraft.mjs');
const {
  APP_CAPABILITIES_VERSION,
  buildAppCapabilityCatalog,
  buildAppCapabilitySnapshot,
  classifyFieldId,
  findAppCapabilityField,
  validateCapabilityFieldValue,
  APP_CAPABILITY_LIMITS,
} = require('../src/domain/appCapabilities.mjs');

const ROOT = path.join(__dirname, '..');

test('能力目录版本与字段清单稳定', () => {
  const catalog = buildAppCapabilityCatalog();
  assert.equal(catalog.catalogVersion, APP_CAPABILITIES_VERSION);
  assert.ok(catalog.fields.length >= 15);
  assert.deepEqual(
    catalog.fields.map((field) => field.fieldId),
    [
      'store.name',
      'store.category',
      'store.businessHours',
      'store.fulfillment',
      'store.dishes',
      'store.address',
      'store.phone',
      'store.notes',
      'visual.styleId',
      'visual.prompt',
      'store.imageAssetIds',
      'visual.imageAssetId',
      'features.selected',
      'features.custom',
      'project.appid',
    ],
  );
  for (const field of catalog.fields) {
    assert.equal(typeof field.fieldId, 'string');
    assert.equal(typeof field.label, 'string');
    assert.ok(['auto', 'confirm'].includes(field.risk), `${field.fieldId} risk 非法`);
  }
});

test('字段限制与现有领域常量绑定，不复制数值', () => {
  const name = findAppCapabilityField('store.name');
  assert.equal(name.limits.maxChars, AGENT_DRAFT_LIMITS.maxStoreName);
  const category = findAppCapabilityField('store.category');
  assert.equal(category.limits.maxChars, AGENT_DRAFT_LIMITS.maxCategory);
  const dishes = findAppCapabilityField('store.dishes');
  assert.equal(dishes.limits.maxDishes, AGENT_DRAFT_LIMITS.maxDishes);
  assert.equal(dishes.limits.minPriceCents, AGENT_DRAFT_LIMITS.minPriceCents);
  assert.equal(dishes.limits.maxDescriptionChars, AGENT_DRAFT_LIMITS.maxDescription);
  const hours = findAppCapabilityField('store.businessHours');
  assert.equal(hours.limits.maxSegments, AGENT_DRAFT_LIMITS.maxHoursSegments);
});

test('目录是纯 JSON，不含函数与绝对路径', () => {
  const catalog = buildAppCapabilityCatalog();
  const text = JSON.stringify(catalog);
  assert.deepEqual(JSON.parse(text), catalog);
  for (const field of catalog.fields) {
    for (const value of Object.values(field)) {
      assert.notEqual(typeof value, 'function');
    }
  }
  assert.equal(text.includes('E:\\\\'), false);
  assert.equal(text.includes('C:\\\\'), false);
});

test('fieldId 分类：可写 / 只读 / 禁止 / 未知', () => {
  assert.equal(classifyFieldId('store.name'), 'writable');
  assert.equal(classifyFieldId('store.dishes'), 'writable');
  assert.equal(classifyFieldId('build.candidates'), 'readonly');
  assert.equal(classifyFieldId('settings.apiKey'), 'denied');
  assert.equal(classifyFieldId('deploy.directory'), 'denied');
  assert.equal(classifyFieldId('store.unknown'), 'unknown');
});

test('字段值校验与表单规则一致', () => {
  assert.equal(validateCapabilityFieldValue('store.name', '松月食堂').ok, true);
  // 清空是合法提案，但必须走桌面确认；见 buildProposalApplyPlan 的 confirmWhenEmpty。
  const cleared = validateCapabilityFieldValue('store.name', '');
  assert.equal(cleared.ok, true);
  assert.equal(cleared.value, '');
  assert.equal(
    validateCapabilityFieldValue('store.name', 'x'.repeat(AGENT_DRAFT_LIMITS.maxStoreName + 1)).ok,
    false,
  );
  const hours = validateCapabilityFieldValue('store.businessHours', '10点到21点');
  assert.equal(hours.ok, true);
  assert.equal(hours.value, '10:00-21:00');
  const overnight = validateCapabilityFieldValue('store.businessHours', '22:00-02:00');
  assert.equal(overnight.ok, true);
  assert.equal(validateCapabilityFieldValue('store.businessHours', '10:00-25:00').ok, false);
  assert.equal(validateCapabilityFieldValue('visual.styleId', 'fresh').ok, true);
  assert.equal(validateCapabilityFieldValue('visual.styleId', 'neon').ok, false);
  const features = validateCapabilityFieldValue('features.selected', ['scan-order', 'product-catalog', 'cart-checkout', 'order-tracking']);
  assert.equal(features.ok, true);
  assert.equal(validateCapabilityFieldValue('features.selected', ['scan-order']).ok, false);
  assert.equal(validateCapabilityFieldValue('project.appid', 'wx' + 'a'.repeat(16)).ok, true);
  assert.equal(validateCapabilityFieldValue('project.appid', 'wx123').ok, false);
  // 菜品不能走 field.set
  assert.equal(validateCapabilityFieldValue('store.dishes', []).ok, false);
  // 未知字段
  assert.equal(validateCapabilityFieldValue('store.unknown', 'x').ok, false);
});

test('快照摘要确定且可重复生成', () => {
  const first = buildAppCapabilitySnapshot();
  const second = buildAppCapabilitySnapshot();
  assert.equal(first.digest, second.digest);
  assert.equal(first.catalogVersion, APP_CAPABILITIES_VERSION);
  assert.deepEqual(first.catalog, second.catalog);
});

test('服务端只读快照与源文件一致（--check exit 0）', () => {
  const target = path.join(ROOT, 'server', 'src', 'agent', 'app-assistant', 'capabilities.snapshot.json');
  assert.ok(fs.existsSync(target), '缺少服务端快照，先运行 npm run app:capabilities');
  let output = '';
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'app-capabilities.cjs'), '--check'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  // execFileSync 失败会抛错；到这里即 exit 0。
  assert.ok(true);
});

test('附件用途与动作白名单已冻结', () => {
  const catalog = buildAppCapabilityCatalog();
  assert.deepEqual(catalog.attachmentPurposes, ['auto', 'menu', 'store', 'reference']);
  const actionIds = catalog.actions.map((action) => action.actionId);
  [
    'navigate.phase',
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
  ].forEach((id) => assert.ok(actionIds.includes(id), `缺少动作 ${id}`));
  assert.equal(actionIds.includes('fs.write'), false);
  assert.equal(APP_CAPABILITY_LIMITS.requiredFeatureIds.includes('scan-order'), true);
});