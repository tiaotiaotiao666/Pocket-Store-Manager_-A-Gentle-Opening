const test = require('node:test');
const assert = require('node:assert/strict');

const { createInitialState, reducer, selectAgentChatState, selectUndoState } = require('../src/state/sessionMachine.mjs');
const { toDocument, fromDocument } = require('../src/domain/projectSnapshot.mjs');
const { buildProjectContextSnapshot } = require('../src/domain/projectAgentContext.mjs');

function baseState() {
  const state = createInitialState();
  return { ...state, project: { ...state.project, activeId: 'p_test' } };
}

function changeSet(changes) {
  return changes.map((item, index) => ({
    opId: item.opId ?? `op_${index + 1}`,
    evidence: { source: 'utterance', excerpt: '测试' },
    ...item,
  }));
}

function apply(state, changes, options = {}) {
  const revision = Number.isInteger(state.project.contentRevision) ? state.project.contentRevision : 0;
  return reducer(state, {
    type: 'APP_ASSISTANT_CHANGES_APPLY',
    proposalId: options.proposalId ?? 'proposal_1',
    baseContextRevision: options.baseContextRevision ?? revision,
    changes,
  });
}

test('店名与品类双写两个切片，营业时间规范化', () => {
  const state = baseState();
  const next = apply(state, changeSet([
    { op: 'field.set', fieldId: 'store.name', value: '松月食堂' },
    { op: 'field.set', fieldId: 'store.category', value: '社区餐馆' },
    { op: 'field.set', fieldId: 'store.businessHours', value: '10点到21点' },
    { op: 'field.set', fieldId: 'store.fulfillment', value: { dineIn: true, takeaway: true } },
  ]));
  assert.equal(next.store.name, '松月食堂');
  assert.equal(next.agentDraft.storeName, '松月食堂');
  assert.equal(next.store.type, '社区餐馆');
  assert.equal(next.agentDraft.category, '社区餐馆');
  assert.equal(next.agentDraft.businessHours, '10:00-21:00');
  assert.deepEqual(next.agentDraft.fulfillment, { dineIn: true, takeaway: true });
});

test('跨天营业时间被接受，非法段整批拒绝', () => {
  const state = baseState();
  const overnight = apply(state, changeSet([
    { op: 'field.set', fieldId: 'store.businessHours', value: '22:00-02:00' },
  ]));
  assert.equal(overnight.agentDraft.businessHours, '22:00-02:00');

  const rejected = apply(state, changeSet([
    { op: 'field.set', fieldId: 'store.name', value: '松月食堂' },
    { op: 'field.set', fieldId: 'store.businessHours', value: '10:00-25:00' },
  ]));
  assert.equal(rejected, state, '非法批次必须整批不写');
});

test('菜品 upsert 按名匹配、按 id 更新，remove 删除', () => {
  const state = baseState();
  const added = apply(state, changeSet([
    { op: 'dish.upsert', name: '牛肉面', priceCents: 2800 },
    { op: 'dish.upsert', name: '米饭', priceCents: 300 },
  ]));
  assert.equal(added.agentDraft.dishes.length, 2);
  assert.equal(added.agentDraft.dishes[0].name, '牛肉面');
  assert.equal(added.agentDraft.dishes[0].priceCents, 2800);
  assert.match(added.agentDraft.dishes[0].id, /^dish-\d+$/);

  const updated = apply(added, changeSet([
    { op: 'dish.upsert', name: '牛肉面', priceCents: 3200 },
  ]), { proposalId: 'proposal_2' });
  assert.equal(updated.agentDraft.dishes.length, 2);
  assert.equal(updated.agentDraft.dishes[0].priceCents, 3200);

  const removed = apply(updated, changeSet([
    { op: 'dish.remove', dishId: updated.agentDraft.dishes[1].id },
  ]), { proposalId: 'proposal_3' });
  assert.equal(removed.agentDraft.dishes.length, 1);
});

test('超过 8 道菜时整批拒绝，不写一半', () => {
  let state = baseState();
  const changes = [];
  for (let index = 0; index < 9; index += 1) {
    changes.push({ op: 'dish.upsert', name: `菜${index}`, priceCents: 1000 });
  }
  const next = apply(state, changeSet(changes));
  assert.equal(next, state);
  assert.equal(next.agentDraft.dishes.length, 0);
});

test('stale：revision 不匹配时整批不写，也不产生撤销格', () => {
  const state = baseState();
  const next = apply(state, changeSet([
    { op: 'field.set', fieldId: 'store.name', value: '松月食堂' },
  ]), { baseContextRevision: 5 });
  assert.equal(next, state);
  assert.equal(selectUndoState(next).undoCount, 0);
});

test('手改字段后 contentRevision 前进，旧提案变 stale', () => {
  const state = baseState();
  assert.equal(state.project.contentRevision, 0);
  const frozen = state.project.contentRevision;
  const edited = reducer(state, { type: 'SET_STORE_FIELD', field: 'name', value: '手改店名' });
  assert.equal(edited.project.contentRevision, frozen + 1);
  const next = apply(edited, changeSet([
    { op: 'field.set', fieldId: 'store.name', value: '松月食堂' },
  ]), { baseContextRevision: frozen });
  assert.equal(next, edited);
  assert.equal(next.store.name, '手改店名');
});

test('phase/会话/输入草稿不改变 contentRevision', () => {
  const state = baseState();
  const switched = reducer(state, { type: 'SET_PHASE', phase: 'template-pick' });
  assert.equal(switched === state, true);
  const chat = reducer(state, { type: 'AGENT_CHAT_DRAFT_SET', value: '正在输入' });
  assert.equal(chat.project.contentRevision, state.project.contentRevision);
  assert.equal(buildProjectContextSnapshot(chat), buildProjectContextSnapshot(state));
});

test('一批修改只占一格撤销，undo/redo 恢复整批', () => {
  const state = baseState();
  const before = selectUndoState(state).undoCount;
  const next = apply(state, changeSet([
    { op: 'field.set', fieldId: 'store.name', value: '松月食堂' },
    { op: 'field.set', fieldId: 'store.businessHours', value: '10:00-21:00' },
    { op: 'dish.upsert', name: '牛肉面', priceCents: 2800 },
  ]));
  assert.equal(selectUndoState(next).undoCount, before + 1);

  const undone = reducer(next, { type: 'UNDO_APPLY' });
  assert.equal(undone.store.name, '');
  assert.equal(undone.agentDraft.businessHours, '');
  assert.equal(undone.agentDraft.dishes.length, 0);
  assert.equal(undone.project.contentRevision, next.project.contentRevision + 1);

  const redone = reducer(undone, { type: 'REDO_APPLY' });
  assert.equal(redone.store.name, '松月食堂');
  assert.equal(redone.agentDraft.dishes.length, 1);
});

test('同一 proposalId 重复应用被忽略（幂等）', () => {
  const state = baseState();
  const changes = changeSet([{ op: 'field.set', fieldId: 'store.name', value: '松月食堂' }]);
  const once = apply(state, changes, { proposalId: 'proposal_dup' });
  const twice = apply(once, changes, { proposalId: 'proposal_dup' });
  assert.equal(twice, once);
});

test('应用后给出桌面真实 before/after，而不是模型文案', () => {
  const state = baseState();
  const next = apply(state, changeSet([
    { op: 'field.set', fieldId: 'store.name', value: '松月食堂' },
  ]), { proposalId: 'proposal_desc' });
  const view = selectAgentChatState(next);
  assert.equal(view.lastApplied.proposalId, 'proposal_desc');
  assert.equal(view.lastApplied.appliedRevision, next.project.contentRevision);
  const entry = view.lastApplied.entries.find((item) => item.fieldId === 'store.name');
  assert.equal(entry.before, '');
  assert.equal(entry.after, '松月食堂');
  assert.equal(entry.label, '店名');
});

test('保存并重开项目后业务字段仍在，运行态不恢复', () => {
  const state = baseState();
  const next = apply(state, changeSet([
    { op: 'field.set', fieldId: 'store.name', value: '松月食堂' },
    { op: 'field.set', fieldId: 'store.notes', value: '社区食堂，主打家常味' },
  ]));
  const doc = toDocument(next, { projectId: 'p_test', updatedAt: '2026-11-20T00:00:00.000Z' });
  const restored = fromDocument(doc, { projectId: 'p_test' });
  assert.equal(restored.store.name, '松月食堂');
  assert.equal(restored.agentDraft.storeName, '松月食堂');
  assert.equal(restored.store.notes, '社区食堂，主打家常味');
  assert.equal(restored.agentChat.lastApplied, undefined);
});