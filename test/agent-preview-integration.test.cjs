'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CANDIDATES = [
  { id: 'warm-bistro', name: '街巷食集', score: 88, layout: 'menu' },
  { id: 'modern-coffee', name: '现代咖啡', score: 82, layout: 'catalog' },
];

async function loadIntegrationModules() {
  const [machine, preview, composition, snapshot] = await Promise.all([
    import('../src/state/sessionMachine.mjs'),
    import('../src/composition/previewViewModel.mjs'),
    import('../src/composition/planFromSession.mjs'),
    import('../src/domain/projectSnapshot.mjs'),
  ]);
  return { machine, preview, composition, snapshot };
}

function seededStoreInfo(machine) {
  let state = machine.createInitialState();
  state = machine.reducer(state, { type: 'START_ONBOARDING' });
  state = machine.reducer(state, { type: 'SUBMIT_NAME', name: '松月食堂' });
  state = machine.reducer(state, { type: 'SKIP_INTRO' });
  state = machine.reducer(state, { type: 'SUBMIT_CUSTOMIZE', value: '' });
  state = machine.reducer(state, { type: 'BUILD_READY', candidates: CANDIDATES });
  state = machine.reducer(state, { type: 'CONFIRM_TEMPLATE' });
  return state;
}

function createPartialDraft() {
  return {
    storeName: '松月食堂晚市',
    category: '社区家常菜',
    businessHours: '10:00-14:00，17:00-20:00',
    fulfillment: { dineIn: true, takeaway: false },
    dishes: [
      {
        id: 'dish-evening',
        name: '晚市招牌饭',
        priceCents: 2885,
        priceText: '28.85',
        description: '现点现做',
      },
    ],
  };
}

function createFullDraft() {
  return {
    storeName: '松月食堂二店',
    category: '社区餐馆',
    businessHours: '10:00-21:00',
    fulfillment: { dineIn: true, takeaway: true },
    dishes: [
      { id: 'dish-kung-pao', name: '宫保鸡丁', priceCents: 2800, priceText: '28.00', description: '微辣下饭' },
      { id: 'dish-tomato-egg', name: '番茄炒蛋', priceCents: 1600, priceText: '16.00', description: '家常酸甜' },
      { id: 'dish-rice', name: '米饭', priceCents: 300, priceText: '3.00', description: '当季新米' },
    ],
  };
}

function acceptTurn(machine, state, requestId, draft) {
  const requested = machine.reducer(state, {
    type: 'AGENT_TURN_REQUEST',
    utterance: '更新开店资料',
    requestId,
  });
  return machine.reducer(requested, {
    type: 'AGENT_TURN_SUCCESS',
    requestId,
    reply: '已更新草稿',
    draft,
  });
}

function selectedViewModel(preview, state) {
  return preview.buildSessionPreviewViewModels(state).selected;
}

function readSource(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('T3-I1 collecting 部分响应无需 readyForReview，五类字段进入所有模板 VM', async () => {
  const { machine, preview } = await loadIntegrationModules();
  const seeded = seededStoreInfo(machine);
  const accepted = acceptTurn(machine, seeded, 'agent-request-partial', createPartialDraft());

  assert.equal(accepted.agent.status, 'collecting');
  assert.ok(accepted.agent.missingFields.some((item) => item.field === 'dishes'));
  assert.equal(accepted.store, seeded.store);
  assert.equal(accepted.build, seeded.build);
  assert.equal(accepted.visual, seeded.visual);

  const viewModels = preview.buildSessionPreviewViewModels(accepted);
  const selected = viewModels.selected;
  assert.equal(selected, viewModels.byTemplateId['warm-bistro']);
  assert.equal(selected.store.name, '松月食堂晚市');
  assert.equal(selected.store.category, '社区家常菜');
  assert.equal(selected.store.businessHoursText, '10:00-14:00，17:00-20:00');
  assert.equal(selected.store.fulfillmentText, '堂食');
  assert.deepEqual(selected.products.map((product) => ({
    key: product.key,
    name: product.name,
    priceCents: product.priceCents,
    priceDisplay: product.priceDisplay,
  })), [{
    key: 'dish-evening',
    name: '晚市招牌饭',
    priceCents: 2885,
    priceDisplay: '28.85',
  }]);

  const catalog = viewModels.byTemplateId['modern-coffee'];
  assert.equal(catalog.layout, 'catalog');
  assert.deepEqual(catalog.store, selected.store);
  assert.deepEqual(catalog.products, selected.products);
});

test('T3-I2 reviewing 完整响应更新五类字段，export 默认仍 confirmed-first', async () => {
  const { machine, preview, composition } = await loadIntegrationModules();
  const seeded = seededStoreInfo(machine);
  const accepted = acceptTurn(machine, seeded, 'agent-request-full', createFullDraft());

  assert.equal(accepted.agent.status, 'reviewing');
  assert.deepEqual(accepted.agent.missingFields, []);
  assert.deepEqual(accepted.agent.errors, []);
  const selected = selectedViewModel(preview, accepted);
  assert.equal(selected.store.name, '松月食堂二店');
  assert.equal(selected.store.category, '社区餐馆');
  assert.equal(selected.store.businessHoursText, '10:00-21:00');
  assert.equal(selected.store.fulfillmentText, '堂食 · 到店自取');
  assert.deepEqual(selected.products.map((product) => ({
    key: product.key,
    name: product.name,
    priceCents: product.priceCents,
    priceDisplay: product.priceDisplay,
  })), [
    { key: 'dish-kung-pao', name: '宫保鸡丁', priceCents: 2800, priceDisplay: '28.00' },
    { key: 'dish-tomato-egg', name: '番茄炒蛋', priceCents: 1600, priceDisplay: '16.00' },
    { key: 'dish-rice', name: '米饭', priceCents: 300, priceDisplay: '3.00' },
  ]);

  const exportDefault = composition.buildPlanFromSession(accepted);
  const previewPlan = composition.buildPlanFromSession(accepted, { storeNameSource: 'draft-first' });
  assert.equal(exportDefault.plan.storeProfile.name, '松月食堂');
  assert.equal(previewPlan.plan.storeProfile.name, '松月食堂二店');
  assert.equal('storeNameSource' in exportDefault.plan, false);
});

test('T3-I3 requesting 与当前请求 failure 均保留最后接受的草稿和预览', async () => {
  const { machine, preview } = await loadIntegrationModules();
  const accepted = acceptTurn(
    machine,
    seededStoreInfo(machine),
    'agent-request-accepted',
    createFullDraft(),
  );
  const acceptedViewModel = selectedViewModel(preview, accepted);
  const requesting = machine.reducer(accepted, {
    type: 'AGENT_TURN_REQUEST',
    utterance: '继续补充资料',
    requestId: 'agent-request-pending',
  });

  assert.equal(requesting.agent.status, 'requesting');
  assert.equal(requesting.agent.activeRequestId, 'agent-request-pending');
  assert.equal(requesting.agentDraft, accepted.agentDraft);
  assert.equal(requesting.store, accepted.store);
  assert.equal(requesting.build, accepted.build);
  assert.equal(requesting.visual, accepted.visual);
  assert.deepEqual(selectedViewModel(preview, requesting), acceptedViewModel);

  const failed = machine.reducer(requesting, {
    type: 'AGENT_TURN_FAILURE',
    requestId: 'agent-request-pending',
    error: { code: 'AGENT_NETWORK', message: '网络失败', retryable: true },
  });
  assert.equal(failed.agent.status, 'failed');
  assert.equal(failed.agent.activeRequestId, null);
  assert.equal(failed.agent.lastError.code, 'AGENT_NETWORK');
  assert.equal(failed.agentDraft, accepted.agentDraft);
  assert.equal(failed.store, accepted.store);
  assert.equal(failed.build, accepted.build);
  assert.equal(failed.visual, accepted.visual);
  assert.deepEqual(selectedViewModel(preview, failed), acceptedViewModel);
});

test('T3-I4 RESET_PROJECT 加新请求后，旧 success/failure 不改变状态或预览', async () => {
  const { machine, preview } = await loadIntegrationModules();
  const accepted = acceptTurn(
    machine,
    seededStoreInfo(machine),
    'agent-request-before-reset',
    createFullDraft(),
  );
  const oldRequest = machine.reducer(accepted, {
    type: 'AGENT_TURN_REQUEST',
    utterance: 'reset 前未完成请求',
    requestId: 'agent-request-old',
  });
  const reset = machine.reducer(oldRequest, { type: 'RESET_PROJECT' });
  const newRequest = machine.reducer(reset, {
    type: 'AGENT_TURN_REQUEST',
    utterance: 'reset 后新请求',
    requestId: 'agent-request-new',
  });
  const beforeStale = selectedViewModel(preview, newRequest);

  const staleSuccess = machine.reducer(newRequest, {
    type: 'AGENT_TURN_SUCCESS',
    requestId: 'agent-request-old',
    reply: '过期成功',
    draft: { ...createFullDraft(), storeName: '过期门店' },
  });
  assert.equal(staleSuccess, newRequest);
  assert.deepEqual(selectedViewModel(preview, staleSuccess), beforeStale);

  const staleFailure = machine.reducer(newRequest, {
    type: 'AGENT_TURN_FAILURE',
    requestId: 'agent-request-old',
    error: { code: 'AGENT_NETWORK', message: '过期失败' },
  });
  assert.equal(staleFailure, newRequest);
  assert.deepEqual(selectedViewModel(preview, staleFailure), beforeStale);
  assert.equal(newRequest.agent.lastError, null);
  assert.equal(newRequest.agent.activeRequestId, 'agent-request-new');
});

test('T3-I5 confirm 仅晋升名称和品类，reopen/edit 投影新草稿且 confirmed store 不变', async () => {
  const { machine, preview } = await loadIntegrationModules();
  const accepted = acceptTurn(
    machine,
    seededStoreInfo(machine),
    'agent-request-confirm',
    createFullDraft(),
  );
  const beforeConfirm = selectedViewModel(preview, accepted);
  const confirmed = machine.reducer(accepted, { type: 'CONFIRM_AGENT_DRAFT' });

  assert.equal(confirmed.agent.status, 'confirmed');
  assert.deepEqual(confirmed.store, {
    ...accepted.store,
    name: '松月食堂二店',
    type: '社区餐馆',
  });
  assert.equal(confirmed.build, accepted.build);
  assert.equal(confirmed.visual, accepted.visual);
  assert.equal(confirmed.agentDraft, accepted.agentDraft);
  assert.deepEqual(selectedViewModel(preview, confirmed), beforeConfirm);

  const reopened = machine.reducer(confirmed, { type: 'REOPEN_AGENT_DRAFT' });
  assert.equal(reopened.agent.status, 'reviewing');
  assert.equal(reopened.store, confirmed.store);
  assert.equal(reopened.build, confirmed.build);
  assert.equal(reopened.visual, confirmed.visual);
  assert.equal(reopened.agentDraft, confirmed.agentDraft);
  assert.deepEqual(selectedViewModel(preview, reopened), beforeConfirm);

  const edited = machine.reducer(reopened, {
    type: 'EDIT_AGENT_DRAFT_FIELD',
    field: 'storeName',
    value: '松月食堂三店',
  });
  assert.equal(edited.store.name, '松月食堂二店');
  assert.equal(edited.store.type, '社区餐馆');
  assert.equal(edited.build, confirmed.build);
  assert.equal(edited.visual, confirmed.visual);
  assert.equal(selectedViewModel(preview, edited).store.name, '松月食堂三店');
});

test('T3-I6 快照保留可投影草稿，activeRequestId 不落盘且恢复后忽略旧响应', async () => {
  const { machine, preview, snapshot } = await loadIntegrationModules();
  const accepted = acceptTurn(
    machine,
    seededStoreInfo(machine),
    'agent-request-snapshot',
    createFullDraft(),
  );
  const expectedViewModel = selectedViewModel(preview, accepted);
  const requesting = machine.reducer(accepted, {
    type: 'AGENT_TURN_REQUEST',
    utterance: '快照时仍在请求',
    requestId: 'agent-request-transient',
  });
  const document = snapshot.toDocument(requesting, {
    projectId: 'project-preview',
    createdAt: '2026-11-03T00:00:00Z',
  });

  assert.equal(JSON.stringify(document).includes('activeRequestId'), false);
  assert.deepEqual(document.agentDraft, accepted.agentDraft);
  const restored = {
    ...machine.createInitialState(),
    ...snapshot.fromDocument(document),
  };
  assert.deepEqual(restored.agentDraft, accepted.agentDraft);
  assert.equal(restored.agent.status, 'reviewing');
  assert.deepEqual(selectedViewModel(preview, restored), expectedViewModel);

  const lateCompletion = machine.reducer(restored, {
    type: 'AGENT_TURN_SUCCESS',
    requestId: 'agent-request-transient',
    reply: '快照前响应',
    draft: { ...createFullDraft(), storeName: '不应恢复的旧响应' },
  });
  assert.equal(lateCompletion, restored);
});

test('T3-I7 App/Gallery 只传唯一 VM，旧预览 props 完全替换', () => {
  const appSource = readSource('src/App.jsx');
  const gallerySource = readSource('src/components/flow/TemplateGallery.jsx');

  assert.match(appSource, /import \{ buildSessionPreviewViewModels \} from '\.\/composition\/previewViewModel\.mjs';/);
  assert.match(appSource, /buildSessionPreviewViewModels\(state\)/);
  assert.match(appSource, /buildPanelCards\(state, promptTips, imageBusy, previewViewModels\.selected\)/);
  assert.match(appSource, /viewModelsByTemplateId=\{previewViewModels\.byTemplateId\}/);
  assert.equal(appSource.includes('buildPreviewViewModel('), false);

  for (const [source, expectedCount] of [[appSource, 2], [gallerySource, 2]]) {
    const previewTags = source.match(/<MiniProgramPreview\b[\s\S]*?\/>/g) || [];
    assert.equal(previewTags.length, expectedCount);
    for (const tag of previewTags) {
      assert.match(tag, /viewModel=\{/);
      assert.doesNotMatch(tag, /\b(?:template|theme|storeName|features)=\{/);
    }
  }
  assert.match(gallerySource, /viewModelsByTemplateId = \{\}/);
  assert.match(gallerySource, /viewModelsByTemplateId\[item\.id\]/);
  assert.match(gallerySource, /viewModelsByTemplateId\[selected\.id\]/);
  assert.doesNotMatch(gallerySource, /buildPreviewViewModel|buildSessionPreviewViewModels/);
});

test('T3-I8 App 为新 turn/retry 生成进程内单调 ID，并关联四类 action', () => {
  const appSource = readSource('src/App.jsx');

  assert.match(appSource, /let agentRequestSequence = 0;/);
  assert.match(appSource, /agentRequestSequence \+= 1;/);
  assert.match(appSource, /return `agent-request-\$\{agentRequestSequence\}`;/);
  assert.ok(appSource.includes("{ type: 'AGENT_TURN_RETRY', requestId }"));
  assert.ok(appSource.includes("{ type: 'AGENT_TURN_REQUEST', utterance: text, requestId }"));
  assert.ok(appSource.includes("{ type: 'AGENT_TURN_SUCCESS', ...result, requestId }"));
  assert.ok(appSource.includes("{ type: 'AGENT_TURN_FAILURE', requestId, error }"));
});