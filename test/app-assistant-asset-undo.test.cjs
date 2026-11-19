'use strict';

/**
 * T7 行为测试：素材添加撤销后状态里不出现「幽灵素材」。
 *
 * 物理文件按内容寻址保留（供 redo）是设计选择；但项目状态里的
 * `assets.images` 与引用必须随撤销一起回滚。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createInitialState, reducer, selectUndoState } = require('../src/state/sessionMachine.mjs');
const { toDocument, fromDocument } = require('../src/domain/projectSnapshot.mjs');

function baseState() {
  const state = createInitialState();
  return {
    ...state,
    project: { ...state.project, activeId: 'p_test' },
    store: { ...state.store, imageAssetIds: [] },
    visual: { ...state.visual, imageAssetId: null },
  };
}

const IMAGE = Object.freeze({
  assetId: 'asset_store_1',
  fileName: 'store.jpg',
  originalName: 'store.jpg',
  mime: 'image/jpeg',
  bytes: 1024,
  sha256: 'f'.repeat(64),
  source: 'user-upload',
  createdAt: '2026-11-20T00:00:00.000Z',
});

test('添加素材后可撤销：assets 与引用一起回滚', () => {
  const state = baseState();
  const before = selectUndoState(state).undoCount;
  const added = reducer(state, { type: 'ADD_PROJECT_IMAGES', images: [IMAGE] });
  assert.equal(added.assets.images.length, 1);
  assert.equal(selectUndoState(added).undoCount, before + 1);

  const linked = reducer(added, { type: 'SET_STORE_FIELD', field: 'imageAssetIds', value: ['asset_store_1'] });
  // 引用本身也是业务字段，撤销一次应回到添加前。
  const undone = reducer(linked, { type: 'UNDO_APPLY' });
  assert.equal(undone.store.imageAssetIds.includes('asset_store_1'), false);
  assert.equal(undone.assets.images.length, 1, '第一次撤销只回滚引用，素材仍在');

  const undoneTwice = reducer(undone, { type: 'UNDO_APPLY' });
  assert.equal(undoneTwice.assets.images.length, 0, '再撤销一次素材本身被移除');
});

test('redo 恢复素材，不产生未登记的 phantom asset', () => {
  const state = baseState();
  const added = reducer(state, { type: 'ADD_PROJECT_IMAGES', images: [IMAGE] });
  const undone = reducer(added, { type: 'UNDO_APPLY' });
  assert.equal(undone.assets.images.length, 0);
  const redone = reducer(undone, { type: 'REDO_APPLY' });
  assert.equal(redone.assets.images.length, 1);
  assert.equal(redone.assets.images[0].assetId, IMAGE.assetId);
  // 引用未被误写：撤销/重做只回放真实状态。
  assert.equal(redone.store.imageAssetIds.includes(IMAGE.assetId), false);
});

test('保存并重开：素材元数据恢复，运行态不恢复', () => {
  const state = baseState();
  const added = reducer(state, { type: 'ADD_PROJECT_IMAGES', images: [IMAGE] });
  const doc = toDocument(added, { projectId: 'p_test' });
  const restored = fromDocument(doc, { projectId: 'p_test' });
  assert.equal(restored.assets.images.length, 1);
  assert.equal(restored.assets.images[0].assetId, IMAGE.assetId);
});

test('重复添加同一 assetId 幂等，不压第二个撤销格', () => {
  const state = baseState();
  const once = reducer(state, { type: 'ADD_PROJECT_IMAGES', images: [IMAGE] });
  const twice = reducer(once, { type: 'ADD_PROJECT_IMAGES', images: [IMAGE] });
  assert.equal(twice, once);
  assert.equal(twice.assets.images.length, 1);
});