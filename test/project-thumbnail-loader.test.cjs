'use strict';

const test = require('node:test');
const assert = require('node:assert');

async function loadLoader() {
  return import('../src/services/projectThumbnailLoader.js');
}

function tick() {
  return new Promise((resolve) => { setTimeout(resolve, 0); });
}

function okAsset(dataUrl) {
  return { status: 'ok', asset: { dataUrl } };
}

test('10 个不同资产同时加载，峰值并发不超过 4 且全部有结果', async () => {
  const { createProjectThumbnailLoader } = await loadLoader();
  let active = 0;
  let peak = 0;
  const loader = createProjectThumbnailLoader({
    concurrency: 4,
    readAsset: async (projectId, assetId) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => { setTimeout(resolve, 5); });
      active -= 1;
      return okAsset(`data:${projectId}:${assetId}`);
    },
  });

  const projects = Array.from({ length: 10 }, (_, index) => ({
    projectId: `p${index}`,
    thumbnailAssetId: `a${index}`,
  }));
  const result = await loader.load(projects);

  assert.ok(peak <= 4, `峰值并发 ${peak} 超过 4`);
  assert.ok(peak >= 2, `并发队列没有真正并行，峰值 ${peak}`);
  assert.strictEqual(Object.keys(result).length, 10);
  projects.forEach((project) => {
    assert.strictEqual(result[project.projectId], `data:${project.projectId}:${project.thumbnailAssetId}`);
  });
});

test('相同项目重复加载命中缓存，不重复调用 readAsset', async () => {
  const { createProjectThumbnailLoader } = await loadLoader();
  let calls = 0;
  const loader = createProjectThumbnailLoader({
    readAsset: async (projectId, assetId) => {
      calls += 1;
      return okAsset(`data:${assetId}`);
    },
  });
  const projects = [{ projectId: 'p1', thumbnailAssetId: 'a1' }];

  const first = await loader.load(projects);
  const second = await loader.load(projects);

  assert.strictEqual(first.p1, 'data:a1');
  assert.strictEqual(second.p1, 'data:a1');
  assert.strictEqual(calls, 1);
});

test('同一键在请求未完成时重复加载，只产生一次底层请求', async () => {
  const { createProjectThumbnailLoader } = await loadLoader();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const loader = createProjectThumbnailLoader({
    readAsset: async (projectId, assetId) => {
      calls += 1;
      await gate;
      return okAsset(`data:${assetId}`);
    },
  });
  const projects = [{ projectId: 'p1', thumbnailAssetId: 'a1' }];

  const first = loader.load(projects);
  const second = loader.load(projects);
  await tick();
  assert.strictEqual(calls, 1);

  release();
  const [left, right] = await Promise.all([first, second]);
  assert.strictEqual(left.p1, 'data:a1');
  assert.strictEqual(right.p1, 'data:a1');
  assert.strictEqual(calls, 1);
});

test('无 thumbnailAssetId 的项目不发起请求并回退 null', async () => {
  const { createProjectThumbnailLoader } = await loadLoader();
  let calls = 0;
  const loader = createProjectThumbnailLoader({
    readAsset: async () => {
      calls += 1;
      return okAsset('data:x');
    },
  });

  const result = await loader.load([
    { projectId: 'p1' },
    { projectId: 'p2', thumbnailAssetId: '' },
    { projectId: '', thumbnailAssetId: 'a3' },
  ]);

  assert.strictEqual(calls, 0);
  assert.strictEqual(result.p1, null);
  assert.strictEqual(result.p2, null);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(result, ''), false);
});

test('单个失败只让该项目回退 null，不影响其余项目', async () => {
  const { createProjectThumbnailLoader } = await loadLoader();
  const loader = createProjectThumbnailLoader({
    readAsset: async (projectId, assetId) => {
      if (assetId === 'reject') throw new Error('boom');
      if (assetId === 'failed') return { status: 'failed', code: 'READ_FAILED' };
      if (assetId === 'empty') return { status: 'ok', asset: { dataUrl: '' } };
      return okAsset(`data:${assetId}`);
    },
  });

  const result = await loader.load([
    { projectId: 'p1', thumbnailAssetId: 'reject' },
    { projectId: 'p2', thumbnailAssetId: 'failed' },
    { projectId: 'p3', thumbnailAssetId: 'empty' },
    { projectId: 'p4', thumbnailAssetId: 'good' },
  ]);

  assert.strictEqual(result.p1, null);
  assert.strictEqual(result.p2, null);
  assert.strictEqual(result.p3, null);
  assert.strictEqual(result.p4, 'data:good');
});

test('同一 assetId 用于不同 projectId 时不错误共享缓存', async () => {
  const { createProjectThumbnailLoader } = await loadLoader();
  let calls = 0;
  const loader = createProjectThumbnailLoader({
    readAsset: async (projectId, assetId) => {
      calls += 1;
      return okAsset(`data:${projectId}:${assetId}`);
    },
  });

  const first = await loader.load([{ projectId: 'p1', thumbnailAssetId: 'shared' }]);
  const second = await loader.load([{ projectId: 'p2', thumbnailAssetId: 'shared' }]);

  assert.strictEqual(first.p1, 'data:p1:shared');
  assert.strictEqual(second.p2, 'data:p2:shared');
  assert.strictEqual(calls, 2);
});

test('项目更换 assetId 后读取新图，不回显旧图', async () => {
  const { createProjectThumbnailLoader } = await loadLoader();
  const calls = [];
  const loader = createProjectThumbnailLoader({
    readAsset: async (projectId, assetId) => {
      calls.push(assetId);
      return okAsset(`data:${assetId}`);
    },
  });

  const first = await loader.load([{ projectId: 'p1', thumbnailAssetId: 'a1' }]);
  const second = await loader.load([{ projectId: 'p1', thumbnailAssetId: 'a2' }]);

  assert.strictEqual(first.p1, 'data:a1');
  assert.strictEqual(second.p1, 'data:a2');
  assert.deepStrictEqual(calls, ['a1', 'a2']);
});

test('超过缓存上限后按 LRU 淘汰，被淘汰项再次读取会重新请求', async () => {
  const { createProjectThumbnailLoader } = await loadLoader();
  let calls = 0;
  const loader = createProjectThumbnailLoader({
    maxCacheEntries: 2,
    readAsset: async (projectId, assetId) => {
      calls += 1;
      return okAsset(`data:${assetId}`);
    },
  });

  await loader.load([
    { projectId: 'p1', thumbnailAssetId: 'a1' },
    { projectId: 'p2', thumbnailAssetId: 'a2' },
  ]);
  assert.strictEqual(loader.getCacheSize(), 2);

  await loader.load([{ projectId: 'p3', thumbnailAssetId: 'a3' }]);
  assert.strictEqual(loader.getCacheSize(), 2);
  assert.strictEqual(calls, 3);

  await loader.load([{ projectId: 'p1', thumbnailAssetId: 'a1' }]);
  assert.strictEqual(calls, 4);

  const hit = await loader.load([{ projectId: 'p3', thumbnailAssetId: 'a3' }]);
  assert.strictEqual(hit.p3, 'data:a3');
  assert.strictEqual(calls, 4);
});

test('clear 后缓存清空，进行中的旧结果不会污染新缓存', async () => {
  const { createProjectThumbnailLoader } = await loadLoader();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const loader = createProjectThumbnailLoader({
    readAsset: async (projectId, assetId) => {
      calls += 1;
      if (calls === 1) {
        await gate;
        return okAsset('data:old');
      }
      return okAsset('data:new');
    },
  });

  const first = loader.load([{ projectId: 'p1', thumbnailAssetId: 'a1' }]);
  await tick();
  assert.strictEqual(calls, 1);

  loader.clear();
  assert.strictEqual(loader.getCacheSize(), 0);
  release();
  const old = await first;
  assert.strictEqual(old.p1, 'data:old');
  assert.strictEqual(loader.getCacheSize(), 0);

  const fresh = await loader.load([{ projectId: 'p1', thumbnailAssetId: 'a1' }]);
  assert.strictEqual(fresh.p1, 'data:new');
  assert.strictEqual(calls, 2);
  assert.strictEqual(loader.getCacheSize(), 1);
});

test('未注入 readAsset 时安全返回 null，不抛异常', async () => {
  const { createProjectThumbnailLoader } = await loadLoader();
  const loader = createProjectThumbnailLoader();
  const result = await loader.load([{ projectId: 'p1', thumbnailAssetId: 'a1' }]);
  assert.strictEqual(result.p1, null);
});