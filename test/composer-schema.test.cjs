'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const FIXTURES = path.join(REPO, 'templates', 'registry', 'schema', 'fixtures');
const schema = require(path.join(REPO, 'scripts', 'composer', 'schema.cjs'));
const digest = require(path.join(REPO, 'scripts', 'composer', 'digest.cjs'));
const registryModule = require(path.join(REPO, 'scripts', 'composer', 'registry.cjs'));
const implCheck = require(path.join(REPO, 'scripts', 'composer', 'manifest-impl-check.cjs'));

function readFixture(kind, file) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, kind, file), 'utf8'));
}

function validateByContract(contract, value) {
  if (contract === 'plan') return schema.validatePlan(value);
  if (contract === 'manifest') return schema.validateManifest(value);
  if (contract === 'base') return schema.validateBaseManifest(value);
  if (contract === 'slots') return schema.validateSlots(value);
  if (contract === 'lock') return schema.validateLock(value);
  if (contract === 'store') return schema.validateStoreConfig(value);
  throw new Error('unknown contract ' + contract);
}

test('七份契约 Schema 文档可解析且携带冻结标记', () => {
  const files = ['base.manifest.v1', 'manifest.v1', 'frontend-pack.v1', 'slots.v1', 'composition.v1', 'lock.v1', 'store.generated.v2'];
  files.forEach((name) => {
    const doc = JSON.parse(fs.readFileSync(path.join(REPO, 'templates', 'registry', 'schema', name + '.json'), 'utf8'));
    assert.strictEqual(doc.status, 'frozen');
    assert.ok(doc.description.length > 20);
    assert.ok(Array.isArray(doc.rules) && doc.rules.length > 0);
  });
});

test('合法样例全部通过', () => {
  const expectations = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'expectations.json'), 'utf8'));
  expectations.valid.forEach((entry) => {
    const result = validateByContract(entry.contract, readFixture('valid', entry.file));
    assert.strictEqual(result.ok, true, entry.file + ' 应通过：' + JSON.stringify(result));
  });
});

test('非法样例逐条返回指定错误码与路径', () => {
  const expectations = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'expectations.json'), 'utf8'));
  expectations.invalid.forEach((entry) => {
    const result = validateByContract(entry.contract, readFixture('invalid', entry.file));
    assert.strictEqual(result.ok, false, entry.file + ' 应失败');
    assert.strictEqual(result.code, entry.code, entry.file + ' 错误码');
    assert.strictEqual(result.path, entry.path, entry.file + ' 错误路径');
  });
});

test('Plan 禁止源码字段与浮点金额', () => {
  const plan = readFixture('valid', 'composition.json');
  const poisoned = structuredClone(plan);
  poisoned.storeProfile.dishes = [{ name: '招牌面', priceCents: 18.5 }];
  const result = schema.validatePlan(poisoned);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'PRICE_NOT_INTEGER');
  assert.strictEqual(result.path, 'storeProfile.dishes[0].priceCents');

  const withUrl = structuredClone(plan);
  withUrl.apiBinding.url = 'https://evil.example.com';
  assert.strictEqual(schema.validatePlan(withUrl).code, 'PLAN_FIELD_FORBIDDEN');
});

test('路径校验拒绝绝对路径、逃逸、UNC 与协议', () => {
  assert.strictEqual(schema.validatePath('pages/home'), null);
  assert.strictEqual(schema.validatePath('/etc/passwd').code, 'ENTRY_PATH_INVALID');
  assert.strictEqual(schema.validatePath('C:\\Users\\me').code, 'ENTRY_PATH_INVALID');
  assert.strictEqual(schema.validatePath('../../outside').code, 'ENTRY_PATH_INVALID');
  assert.strictEqual(schema.validatePath('\\\\server\\share').code, 'ENTRY_PATH_INVALID');
  assert.strictEqual(schema.validatePath('https://example.com/a').code, 'ENTRY_PATH_INVALID');
});

test('canonical JSON 键有序、无空白、拒绝浮点', () => {
  assert.strictEqual(digest.canonical({ b: 1, a: [2, 1] }), '{"a":[2,1],"b":1}');
  assert.throws(() => digest.canonical({ price: 1.5 }), /NON_INTEGER_NUMBER/);
  assert.throws(() => digest.canonical({ bad: NaN }), /NON_FINITE_NUMBER/);
});

test('Lock 摘要排除 generatedAt 且逐字段稳定', () => {
  const lock = readFixture('valid', 'lock.json');
  const first = digest.lockDigest(lock);
  const changed = { ...structuredClone(lock), generatedAt: '2026-11-21T00:00:00Z' };
  assert.strictEqual(digest.lockDigest(changed), first);
  const mutated = structuredClone(lock);
  mutated.composerVersion = '0.2.0';
  assert.notStrictEqual(digest.lockDigest(mutated), first);
});

test('注册表冻结校验通过，篡改后返回 REGISTRY_DRIFT', () => {
  const loaded = registryModule.loadRegistry();
  assert.strictEqual(loaded.ok, true, JSON.stringify(loaded));

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-drift-'));
  const registry = JSON.parse(fs.readFileSync(path.join(REPO, 'templates', 'registry', 'registry.v1.json'), 'utf8'));
  fs.writeFileSync(path.join(tempRoot, 'registry.v1.json'), JSON.stringify(registry, null, 2));
  fs.writeFileSync(path.join(tempRoot, 'registry.lock.json'), JSON.stringify({
    lockVersion: 'lock.v1',
    registryVersion: registry.registryVersion,
    contentDigest: 'sha256:' + '0'.repeat(64),
  }, null, 2));

  const drift = registryModule.loadRegistry({ registryRoot: tempRoot });
  assert.strictEqual(drift.ok, false);
  assert.strictEqual(drift.code, 'REGISTRY_DRIFT');
  assert.strictEqual(drift.details.registryVersion, registry.registryVersion);
});

test('注册表未登记资产给出 ASSET_NOT_REGISTERED 与可用版本', () => {
  const loaded = registryModule.loadRegistry();
  const missing = registryModule.getAsset(loaded, 'not-exists', '1.0.0');
  assert.strictEqual(missing.code, 'ASSET_NOT_REGISTERED');
  const baseRegistered = loaded.assets.some((asset) => asset.id === 'ordering-base');
  const versionMissing = registryModule.getAsset(loaded, 'ordering-base', '9.9.9');
  assert.strictEqual(versionMissing.code, baseRegistered ? 'ASSET_VERSION_NOT_FOUND' : 'ASSET_NOT_REGISTERED');
});

test('Manifest 声明与组件实现双向一致', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'impl-check-'));
  fs.writeFileSync(path.join(temp, 'index.js'), `
Component({
  properties: {
    storeName: { type: String, value: '' },
    mode: { type: String, value: 'customer' }
  },
  methods: {
    onTap() { this.triggerEvent('select', { index: 0 }); }
  }
});
`);
  const manifest = {
    interface: {
      props: [
        { name: 'storeName', type: 'string', required: true },
        { name: 'mode', type: 'string', required: false },
      ],
      events: [{ name: 'select', description: '选择' }],
    },
  };
  const result = implCheck.checkComponentImplementation(manifest, temp);
  assert.strictEqual(result.ok, true, JSON.stringify(result));

  const extraProp = structuredClone(manifest);
  extraProp.interface.props.push({ name: 'extra', type: 'string', required: false });
  const extraResult = implCheck.checkComponentImplementation(extraProp, temp);
  assert.strictEqual(extraResult.code, 'INTERFACE_MISMATCH');
  assert.deepStrictEqual(extraResult.details.missing, ['extra']);

  const sideEffectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'impl-side-'));
  fs.writeFileSync(path.join(sideEffectDir, 'index.js'), `
wx.request({ url: 'https://evil.example.com' });
Component({ properties: { storeName: String, mode: String }, methods: { onTap() { this.triggerEvent('select', {}); } } });
`);
  const sideEffect = implCheck.checkComponentImplementation(manifest, sideEffectDir);
  assert.strictEqual(sideEffect.code, 'COMPONENT_SIDE_EFFECT');
});

test('Manifest 缺失 release 时列出字段名', () => {
  const manifest = readFixture('valid', 'ui-block-manifest.json');
  delete manifest.release;
  const result = schema.validateManifest(manifest);
  assert.strictEqual(result.code, 'FIELD_MISSING');
  assert.strictEqual(result.details.field, 'release');
});