const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const contract = require('../contracts/app-assistant.v1.json');
const fixture = require('./fixtures/app-assistant/contract/cases.json');

const REQUIRED_COVERAGE = [
  '合法文字',
  '附件-only',
  '未知键',
  '错误 contractVersion',
  '错误 catalogVersion',
  'history 超限',
  '未知 field',
  '只读 field',
  '错误值类型',
  '菜品非法价格',
  '缺失证据',
  '危险 action',
  'path 注入',
  'data URL 滥用',
  '重复 opId',
];

test('app-assistant.v1 契约冻结版本、端点与状态', () => {
  assert.equal(contract.contractVersion, 'app-assistant.v1');
  assert.equal(contract.catalogVersion, 'app-capabilities.v1');
  assert.equal(contract.endpoint, '/api/v1/agent/app-assistant');
  assert.deepEqual(contract.statuses, ['proposal', 'needs-input', 'rejected']);
  assert.deepEqual(contract.applyStatuses, ['applied', 'awaiting-confirmation', 'stale', 'rejected', 'failed']);
});

test('请求/响应白名单严格拒绝未知键', () => {
  assert.equal(contract.request.allowedKeys.includes('settings'), false);
  assert.equal(contract.request.allowedKeys.includes('apiKey'), false);
  assert.equal(contract.response.allowedKeys.includes('applied'), false);
  assert.equal(contract.response.allowedKeys.includes('dataUrl'), false);
  assert.ok(contract.request.allowedKeys.includes('project'));
  assert.ok(contract.response.allowedKeys.includes('changes'));
});

test('操作白名单只有四种，且动作禁止 reducer/IPC/路径', () => {
  assert.deepEqual(Object.keys(contract.operations).sort(), [
    'action.request',
    'dish.remove',
    'dish.upsert',
    'field.set',
  ]);
  const actionForbidden = contract.operations['action.request'].forbiddenKeys;
  ['actionType', 'reducer', 'ipc', 'path'].forEach((key) => {
    assert.ok(actionForbidden.includes(key), `action.request 必须禁止 ${key}`);
  });
});

test('拒绝项覆盖 settings / 绝对路径 / 任意 action / 外部 URL / base64 持久化', () => {
  const denied = contract.denied;
  assert.ok(denied.forbiddenFieldIdPrefixes.includes('settings.'));
  assert.ok(denied.forbiddenRequestKeys.includes('settings'));
  assert.ok(denied.forbiddenRequestKeys.includes('absolutePath'));
  assert.ok(denied.forbiddenValuePatterns.includes('data:'));
  assert.ok(denied.forbiddenValuePatterns.includes('http://'));
  assert.ok(denied.forbiddenValuePatterns.includes('https://'));
  assert.ok(denied.forbiddenValuePatterns.includes('../'));
  assert.ok(denied.forbiddenActionIds.includes('fs.write'));
  assert.ok(denied.forbiddenActionIds.includes('ipc.invoke'));
});

test('风险由桌面能力目录决定，模型不能自行降级确认', () => {
  assert.equal(contract.risk.confirmationIsDecidedBy, 'desktop-catalog');
  assert.deepEqual(contract.risk.levels, ['auto', 'confirm']);
});

test('错误码清单完整且无重复', () => {
  const codes = contract.errorCodes;
  assert.equal(new Set(codes).size, codes.length);
  [
    'APP_ASSISTANT_REQUEST_INVALID',
    'APP_ASSISTANT_CONTRACT_MISMATCH',
    'APP_ASSISTANT_CATALOG_MISMATCH',
    'APP_ASSISTANT_CONTEXT_INVALID',
    'APP_ASSISTANT_CONTEXT_STALE',
    'APP_ASSISTANT_RESPONSE_INVALID',
    'APP_ASSISTANT_FIELD_UNKNOWN',
    'APP_ASSISTANT_FIELD_READ_ONLY',
    'APP_ASSISTANT_VALUE_INVALID',
    'APP_ASSISTANT_OPERATION_DENIED',
    'APP_ASSISTANT_CONFIRMATION_REQUIRED',
    'APP_ASSISTANT_ACTION_UNAVAILABLE',
    'APP_ASSISTANT_ATTACHMENT_PURPOSE_UNKNOWN',
    'APP_ASSISTANT_PROPOSAL_DUPLICATE',
  ].forEach((code) => assert.ok(codes.includes(code), `缺少错误码 ${code}`));
});

test('夹具覆盖契约要求的全部非法与合法场景', () => {
  const covers = new Set(fixture.cases.map((item) => item.covers));
  REQUIRED_COVERAGE.forEach((item) => assert.ok(covers.has(item), `夹具缺少场景「${item}」`));
});

test('夹具的拒绝码都在契约错误码清单内', () => {
  const codes = new Set(contract.errorCodes);
  for (const item of fixture.cases) {
    assert.ok(['request', 'response'].includes(item.kind), `${item.id} kind 非法`);
    assert.ok(['accept', 'reject'].includes(item.expect), `${item.id} expect 非法`);
    if (item.expect === 'reject') {
      assert.ok(codes.has(item.code), `${item.id} 使用了未登记错误码 ${item.code}`);
    } else {
      assert.equal(item.code, undefined, `${item.id} 接受场景不应带错误码`);
    }
  }
});

test('夹具不含真实图片正文与本机路径', () => {
  const text = JSON.stringify(fixture.cases);
  assert.equal(text.includes('E:\\\\智能开店app'), false);
  // 夹具里的 base64 只是 4 字符占位，不允许夹带真实图片正文。
  for (const item of fixture.cases) {
    for (const attachment of item.payload.attachments || []) {
      assert.ok(String(attachment.dataBase64).length <= 8, `${item.id} 夹带过长图片正文`);
    }
  }
});

test('契约文档说明「服务端 proposal ≠ 桌面 applied」', () => {
  const fs = require('node:fs');
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'app-assistant-contract.md'), 'utf8');
  assert.ok(doc.includes('proposal'));
  assert.ok(doc.includes('applied'));
  assert.ok(doc.includes('桌面'));
});