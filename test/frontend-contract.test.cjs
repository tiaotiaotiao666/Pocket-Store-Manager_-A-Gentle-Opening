'use strict';

/**
 * B6-3：frontend-reconstruct 契约的单一源、生成物与桌面侧判定。
 *
 * 覆盖三件事：
 * 1. `contracts/frontend-reconstruct.v1.json` 是唯一事实源，且生成模块与其逐字节一致（漂移检查）；
 * 2. server / desktop / scripts 三处不再各自维护同义常量（只做「不再有本地副本」的结构断言）；
 * 3. 同一组 fixture 在桌面侧跑出 `expect` 记录的结论（服务端侧由
 *    `server/test/frontend-reconstruct.parity.test.ts` 双跑比对，两侧必须一致）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const contractTool = require('../scripts/frontend-contract.cjs');
const { loadCases } = require('../scripts/frontend-contract-cases.cjs');
const { validateDraft } = require('../desktop/frontend-reconstruct/schema.cjs');

const REPO = path.resolve(__dirname, '..');

function read(relative) {
  return fs.readFileSync(path.join(REPO, relative), 'utf8');
}

test('契约源存在且结构自洽（版本/枚举/上限/正则/键白名单）', () => {
  const { contract } = contractTool.loadContract();
  assert.strictEqual(contract.contractVersion, 'frontend-reconstruct.v1');
  assert.strictEqual(contract.draftSchemaVersion, 'frontend-pack-draft.v1');
  assert.strictEqual(contract.factsVersion, 'frontend-facts.v1');
  assert.strictEqual(contract.pageFactsVersion, 'frontend-page-facts.v1');
  // 三个消费面都必须能拿到的共享枚举/白名单。
  for (const key of ['targetPages', 'themeTokenKeys', 'sizeSteps', 'sizeKeys', 'regionTypes',
    'layoutKinds', 'draftNodeTypes', 'toolNames', 'stopReasons', 'responseStatuses', 'states',
    'repairIssueCodes', 'draftErrorCodes']) {
    assert.ok(contract.enums[key], 'enums 缺少：' + key);
  }
  for (const key of ['draft', 'draftPage', 'component', 'slot', 'container', 'text', 'button',
    'dataProp', 'literalProp', 'layoutStyle', 'textStyle', 'draftPageJson', 'packPageJson',
    'packPageJsonEmitted']) {
    assert.ok(Array.isArray(contract.keys[key]) && contract.keys[key].length > 0, 'keys 缺少：' + key);
  }
});

test('生成模块与契约源零漂移（改契约必须重新生成）', () => {
  const result = contractTool.checkGenerated();
  assert.strictEqual(result.ok, true, '生成物已漂移：' + JSON.stringify(result.drifted));
  assert.deepStrictEqual(result.drifted, []);
  const desktopModule = require('../desktop/frontend-reconstruct/contract.generated.cjs');
  assert.strictEqual(desktopModule.CONTRACT_HASH, 'sha256:' + result.hash);
  assert.strictEqual(result.hash, contractTool.contractHash(read(contractTool.CONTRACT_RELATIVE)));
});

test('三处消费面都从同一份生成契约取值，不再保留本地副本', () => {
  const desktopSchema = read(path.join('desktop', 'frontend-reconstruct', 'schema.cjs'));
  assert.match(desktopSchema, /require\('\.\/contract\.generated\.cjs'\)/);
  for (const local of [
    'const THEME_TOKEN_KEYS =',
    'const SIZE_STEPS =',
    'const REPAIR_ISSUE_CODES =',
    'const TARGET_PAGES =',
    'const COMPONENT_KEYS =',
  ]) {
    assert.ok(!desktopSchema.includes(local), 'schema.cjs 仍保留本地常量：' + local);
  }

  const desktopRender = read(path.join('desktop', 'frontend-reconstruct', 'render.cjs'));
  assert.match(desktopRender, /require\('\.\/contract\.generated\.cjs'\)/);

  const desktopWorkspace = read(path.join('desktop', 'frontend-reconstruct', 'workspace.cjs'));
  assert.match(desktopWorkspace, /require\('\.\/contract\.generated\.cjs'\)/);
  assert.ok(!desktopWorkspace.includes('const RUN_ID_PATTERN = /^frun-'), 'workspace.cjs 仍本地声明 RUN_ID_PATTERN');

  const ipc = read('desktop/frontend-reconstruct-ipc.cjs');
  assert.match(ipc, /require\('\.\/frontend-reconstruct\/contract\.generated\.cjs'\)/);
  assert.ok(!ipc.includes("const CONTRACT_VERSION = 'frontend-reconstruct.v1'"), 'ipc 仍本地声明契约版本');

  const scriptCapabilities = read(path.join('scripts', 'frontend-capabilities.cjs'));
  assert.match(scriptCapabilities, /contract\.generated\.cjs/);

  const composerSchema = read(path.join('scripts', 'composer', 'schema.cjs'));
  assert.match(composerSchema, /contract\.generated\.cjs/);

  const serverTypes = read(path.join('server', 'src', 'agent', 'frontend-reconstruct', 'types.ts'));
  assert.match(serverTypes, /from '\.\/contract\.generated'/);
  assert.ok(!serverTypes.includes('maxBodyBytes: 2 * 1024 * 1024'), 'types.ts 仍本地声明 FRONTEND_LIMITS');

  const serverSchema = read(path.join('server', 'src', 'agent', 'frontend-reconstruct', 'schema.ts'));
  assert.match(serverSchema, /from '\.\/contract\.generated'/);

  const serverTools = read(path.join('server', 'src', 'agent', 'frontend-reconstruct', 'tools.ts'));
  assert.match(serverTools, /from '\.\/contract\.generated'/);
  assert.ok(!serverTools.includes("'^(page|component|slot|action|data):"), 'tools.ts 仍本地声明能力 id 正则');
});

test('桌面侧：全部 fixture 结论与 expect 一致（服务端侧见 parity 测试）', () => {
  const { facts, pageFacts, cases } = loadCases();
  assert.ok(cases.length >= 30, 'fixture 用例过少：' + cases.length);
  const accepted = cases.filter((entry) => entry.expect.ok).length;
  assert.ok(accepted >= 6, '缺少合法样本：' + accepted);
  const seen = new Set();
  for (const entry of cases) {
    assert.ok(!seen.has(entry.name), '用例重名：' + entry.name);
    seen.add(entry.name);
    const result = validateDraft(entry.draft, facts, pageFacts);
    if (entry.expect.ok) {
      assert.strictEqual(result.ok, true, entry.name + ' 应被接受：' + JSON.stringify(result));
    } else {
      assert.strictEqual(result.ok, false, entry.name + ' 应被拒绝');
      if (entry.expect.path !== undefined) {
        assert.strictEqual(result.path, entry.expect.path, entry.name + ' 拒绝路径不符');
      }
    }
  }
});

test('契约版本变化必须同时改版本号（防静默漂移）', () => {
  const { contract, text } = contractTool.loadContract();
  const desktopModule = require('../desktop/frontend-reconstruct/contract.generated.cjs');
  assert.strictEqual(desktopModule.CONTRACT_VERSION, contract.contractVersion);
  assert.strictEqual(desktopModule.DRAFT_SCHEMA_VERSION, contract.draftSchemaVersion);
  assert.strictEqual(desktopModule.FACTS_VERSION, contract.factsVersion);
  assert.strictEqual(desktopModule.PAGE_FACTS_VERSION, contract.pageFactsVersion);
  // 版本号同时出现在服务端类型投影里，避免只有一侧升级。
  const serverTypes = read(path.join('server', 'src', 'agent', 'frontend-reconstruct', 'types.ts'));
  assert.match(serverTypes, /FRONTEND_RECONSTRUCT_CONTRACT_VERSION/);
  assert.ok(text.includes('contractVersion'));
});
