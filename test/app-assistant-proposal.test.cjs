const test = require('node:test');
const assert = require('node:assert/strict');

const fixture = require('./fixtures/app-assistant/contract/cases.json');
const { createInitialState } = require('../src/state/sessionMachine.mjs');
const {
  APP_ASSISTANT_CONTRACT_VERSION,
  buildProposalApplyPlan,
  validateAppAssistantResponse,
} = require('../src/domain/appAssistantProposal.mjs');

function baseState() {
  return createInitialState();
}

function legalProposal(overrides = {}) {
  return {
    contractVersion: APP_ASSISTANT_CONTRACT_VERSION,
    requestId: 'chat_req_ok',
    runId: 'run_ok',
    catalogVersion: 'app-capabilities.v1',
    contextRevision: 0,
    status: 'proposal',
    reply: '已整理这些资料，请核对。',
    proposalId: 'proposal_ok',
    changes: [],
    questions: [],
    actionRequests: [],
    trace: { modelCalls: 1, toolCalls: [], stopReason: 'final_answer', degraded: false },
    ...overrides,
  };
}

test('契约夹具里的每条响应都得到稳定的接受/拒绝结论', () => {
  const state = baseState();
  const responseCases = fixture.cases.filter((item) => item.kind === 'response');
  assert.ok(responseCases.length >= 9);
  for (const item of responseCases) {
    const result = validateAppAssistantResponse(item.payload, {
      state,
      contextRevision: item.payload.contextRevision,
      requestId: item.payload.requestId,
    });
    if (item.expect === 'accept') {
      assert.equal(result.ok, true, `${item.id} 应通过：${result.message || ''}`);
    } else {
      assert.equal(result.ok, false, `${item.id} 应被拒绝`);
      assert.equal(result.code, item.code, `${item.id} 错误码不符：${result.code} / ${result.message}`);
    }
  }
});

test('合法字段批次的规范化与自动/确认拆分', () => {
  const state = baseState();
  const raw = legalProposal({
    changes: [
      {
        opId: 'op_1',
        op: 'field.set',
        fieldId: 'store.name',
        value: '松月食堂',
        evidence: { source: 'utterance', excerpt: '店名改为松月食堂' },
      },
      {
        opId: 'op_2',
        op: 'field.set',
        fieldId: 'store.businessHours',
        value: '10点到21点',
        evidence: { source: 'utterance', excerpt: '10点到21点' },
      },
      {
        opId: 'op_3',
        op: 'dish.upsert',
        name: '牛肉面',
        priceCents: 2800,
        evidence: { source: 'utterance', excerpt: '加牛肉面28元' },
      },
    ],
  });
  const result = validateAppAssistantResponse(raw, { state, contextRevision: 0, requestId: 'chat_req_ok' });
  assert.equal(result.ok, true);
  const proposal = result.proposal;
  assert.equal(proposal.changes.length, 3);
  assert.equal(proposal.changes[1].value, '10:00-21:00');
  assert.equal(proposal.changes[2].priceCents, 2800);

  const plan = buildProposalApplyPlan(proposal, state);
  assert.equal(plan.autoChanges.length, 3);
  assert.equal(plan.pendingConfirmations.length, 0);
});

test('清空已有值、删除菜品与 AppID 需要确认', () => {
  const state = {
    ...baseState(),
    store: { ...baseState().store, name: '旧店名', notes: '旧说明' },
    agentDraft: {
      ...baseState().agentDraft,
      storeName: '旧店名',
      dishes: [{ id: 'dish-1', name: '米饭', priceCents: 300, priceText: '3.00', description: '' }],
    },
  };
  const raw = legalProposal({
    changes: [
      { opId: 'op_1', op: 'field.set', fieldId: 'store.name', value: '', evidence: { source: 'utterance', excerpt: '清空店名' } },
      { opId: 'op_2', op: 'dish.remove', dishId: 'dish-1', evidence: { source: 'utterance', excerpt: '删掉米饭' } },
      { opId: 'op_3', op: 'field.set', fieldId: 'project.appid', value: 'wxaaaaaaaaaaaaaaaa', evidence: { source: 'utterance', excerpt: 'AppID' } },
    ],
  });
  const result = validateAppAssistantResponse(raw, { state, contextRevision: 0 });
  assert.equal(result.ok, true);
  const plan = buildProposalApplyPlan(result.proposal, state);
  assert.equal(plan.autoChanges.length, 0);
  assert.equal(plan.pendingConfirmations.length, 3);
});

test('取消已选功能需要确认；required 功能不可移除直接拒绝', () => {
  const base = baseState();
  const state = {
    ...base,
    features: { ...base.features, selected: [...base.features.selected, 'takeaway'] },
  };
  const cancel = legalProposal({
    changes: [{
      opId: 'op_1',
      op: 'field.set',
      fieldId: 'features.selected',
      value: state.features.selected.filter((id) => id !== 'takeaway'),
      evidence: { source: 'utterance', excerpt: '不要自取功能' },
    }],
  });
  const result = validateAppAssistantResponse(cancel, { state, contextRevision: 0 });
  assert.equal(result.ok, true);
  const plan = buildProposalApplyPlan(result.proposal, state);
  assert.equal(plan.pendingConfirmations.length, 1);

  const illegal = legalProposal({
    changes: [{
      opId: 'op_1',
      op: 'field.set',
      fieldId: 'features.selected',
      value: ['scan-order'],
      evidence: { source: 'utterance', excerpt: '只留扫码点餐' },
    }],
  });
  const rejected = validateAppAssistantResponse(illegal, { state, contextRevision: 0 });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'APP_ASSISTANT_VALUE_INVALID');
});

test('contextRevision 不一致返回 stale，reply 超长与未知键被拒绝', () => {
  const state = baseState();
  const stale = validateAppAssistantResponse(legalProposal(), { state, contextRevision: 9 });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'APP_ASSISTANT_CONTEXT_STALE');

  const tooLong = validateAppAssistantResponse(legalProposal({ reply: 'x'.repeat(501) }), { state });
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.code, 'APP_ASSISTANT_RESPONSE_INVALID');

  const unknownKey = validateAppAssistantResponse(legalProposal({ applied: true }), { state });
  assert.equal(unknownKey.ok, false);
  assert.equal(unknownKey.code, 'APP_ASSISTANT_RESPONSE_INVALID');
});

test('needs-input 必须给问题且不得附带写入', () => {
  const state = baseState();
  const noQuestion = validateAppAssistantResponse(legalProposal({ status: 'needs-input' }), { state });
  assert.equal(noQuestion.ok, false);
  const withChange = validateAppAssistantResponse(legalProposal({
    status: 'needs-input',
    questions: [{ id: 'q_1', text: '这张图做什么用？' }],
    changes: [{
      opId: 'op_1',
      op: 'field.set',
      fieldId: 'store.name',
      value: '猜的名字',
      evidence: { source: 'utterance', excerpt: '看图' },
    }],
  }), { state });
  assert.equal(withChange.ok, false);
  const ok = validateAppAssistantResponse(legalProposal({
    status: 'needs-input',
    changes: [],
    questions: [{ id: 'q_1', text: '这张图做什么用？' }],
  }), { state });
  assert.equal(ok.ok, true);
  assert.equal(ok.proposal.questions.length, 1);
});