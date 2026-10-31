'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const REPO = path.resolve(__dirname, '..');

async function load() {
  const machine = await import(pathToFileURL(path.join(REPO, 'src', 'state', 'sessionMachine.mjs')).href);
  const snapshot = await import(pathToFileURL(path.join(REPO, 'src', 'domain', 'projectSnapshot.mjs')).href);
  return { machine, snapshot };
}

function makeFullState(machine, snapshot) {
  const base = machine.createInitialState();
  const messages = [
    { id: 'm1', role: 'agent', text: '请给你的店铺小程序命名', staged: true, delay: 720, instant: false, meta: { kind: 'naming' } },
    { id: 'm2', role: 'user', text: '松月食堂', staged: false, delay: 0, instant: true, meta: null },
  ];
  return {
    ...base,
    view: 'flow',
    phase: 'deploy',
    activeSessionId: 'session-deploy',
    seq: 2,
    store: {
      name: '松月食堂',
      type: '社区餐馆',
      notes: '只做当天的新鲜',
      address: '杭州市西湖区文三路 88 号',
      phone: '0571-88886666',
      logoAssetId: 'a_3f9c1d7e5b2a8406',
      imageAssetIds: ['a_3f9c1d7e5b2a8406'],
    },
    features: { selected: ['scan-order', 'product-catalog', 'cart-checkout', 'order-tracking', 'takeaway'], custom: '' },
    build: {
      status: 'ready',
      candidates: [{ id: 'warm-bistro', name: '街巷食集', layout: 'menu', score: 92, summary: '菜单优先' }],
      selectedId: 'warm-bistro',
    },
    visual: {
      styleId: 'warm',
      prompt: '暖木色家常餐馆招牌',
      promptRounds: [{ text: '再暖一点', reply: '好的' }],
      imageRounds: [{ text: '再亮一点', reply: '已调整', assetId: 'a_91ab5540cf1e7d32', extra: 'drop' }],
      image: { dataUrl: 'data:image/png;base64,AAAA', provider: 'mock' },
      imageAssetId: 'a_91ab5540cf1e7d32',
      imageMeta: { provider: 'mock', note: '本地占位', width: 1200, height: 800 },
    },
    agentDraft: {
      storeName: '松月食堂',
      category: '社区餐馆',
      businessHours: '10:00-21:00',
      fulfillment: { dineIn: true, takeaway: true },
      dishes: [
        { id: 'dish-1', name: '宫保鸡丁', priceCents: 2800, priceText: '28.00', description: '微辣' },
        { id: 'dish-2', name: '番茄炒蛋', priceCents: 1600, priceText: '16.00', description: '' },
        { id: 'dish-3', name: '米饭', priceCents: 300, priceText: '3.00', description: '' },
      ],
    },
    agent: {
      ...base.agent,
      status: 'confirmed',
      confirmedAtSeq: 2,
      missingFields: [],
      errors: [],
      nextQuestion: null,
      reply: '已整理好',
      meta: { turnId: 't1' },
    },
    sessions: [
      {
        id: 'session-main',
        title: '松月食堂',
        kind: 'main',
        status: 'done',
        messages,
        handoff: null,
        revealFlush: 2,
      },
      {
        id: 'session-deploy',
        title: '部署小程序',
        kind: 'step',
        status: 'active',
        messages: [{ id: 'm3', role: 'system', text: '部署开始', staged: true, delay: 700, instant: false, meta: { kind: 'handoff' } }],
        handoff: { from: '松月食堂', to: '部署小程序', summary: ['x'], payload: {} },
        revealFlush: 0,
      },
    ],
    deploy: {
      ...base.deploy,
      status: 'done',
      step: 4,
      progress: 100,
      busy: false,
      taskId: 'task-1',
      directory: 'D:\\小程序工程',
      projectName: 'songyue-shitang',
      result: { outputPath: 'D:\\小程序工程\\songyue-shitang', lockDigest: 'sha256:abc' },
      resultDigest: 'sha256:abc',
      error: { code: 'OLD_ERROR', message: '旧错误' },
      warnings: ['旧提示'],
      previewOnly: ['门店环境'],
      versionGaps: [{ id: 'x', current: '1', available: '2' }],
      preflight: { status: 'done', errors: [], warns: [], infos: [], acknowledged: ['W-X'], planDigest: 'sha256:plan', checkedAt: '2026-10-31T09:00:00Z', error: null },
      handoff: {
        stepId: 'appid',
        completedStepIds: ['prepare', 'import'],
        appidApplied: true,
        appidDigestBefore: 'sha256:1',
        appidDigestAfter: 'sha256:2',
        devtoolsDetected: true,
        updatedAt: '2026-10-31T09:40:12Z',
      },
      import: { status: 'done', preview: { big: 'x' }, confirmations: ['a'], busy: false, error: null, result: { ok: true } },
    },
    assets: {
      images: [
        {
          assetId: 'a_3f9c1d7e5b2a8406',
          fileName: '3f9c1d7e5b2a8406.png',
          originalName: '门头.png',
          mime: 'image/png',
          bytes: 284133,
          width: 1200,
          height: 800,
          sha256: 'sha256:' + 'c'.repeat(64),
          createdAt: '2026-10-31T06:20:11Z',
        },
      ],
    },
    project: {
      ...base.project,
      mode: 'desktop',
      status: 'ready',
      activeId: 'p_lz9k2m4a7f3c1x',
      createdAt: '2026-10-31T06:12:03Z',
      appid: 'wx1234567890abcdef',
      dirty: true,
      saving: true,
      lastSavedAt: '2026-10-31T09:41:55Z',
      lastSavedBytes: 41233,
      saveError: { code: 'X', message: 'y' },
    },
    unmappedFields: { futureThing: { keep: true } },
  };
}

test('toDocument 剥离全部 transient，只保留契约字段', async () => {
  const { machine, snapshot } = await load();
  const state = makeFullState(machine, snapshot);
  const doc = snapshot.toDocument(state, {
    projectId: 'p_lz9k2m4a7f3c1x',
    createdAt: '2026-10-31T06:12:03Z',
    appid: 'wx1234567890abcdef',
  });

  assert.strictEqual(doc.schemaVersion, 1);
  assert.strictEqual(doc.projectId, 'p_lz9k2m4a7f3c1x');
  assert.strictEqual(doc.name, '松月食堂');
  assert.strictEqual(doc.agentConfirmedSeq, 2);
  assert.strictEqual(doc.appid, 'wx1234567890abcdef');

  assert.strictEqual(doc.agent, undefined);
  assert.strictEqual(doc.view, undefined);
  assert.strictEqual(doc.settings, undefined);
  assert.strictEqual(doc.visual.image, undefined);
  assert.strictEqual(doc.visual.imageAssetId, 'a_91ab5540cf1e7d32');
  assert.strictEqual(doc.visual.imageRounds[0].extra, undefined);

  assert.deepStrictEqual(Object.keys(doc.deploy).sort(), ['directory', 'handoff', 'projectName', 'resultDigest']);
  assert.strictEqual(doc.deploy.directory, 'D:\\小程序工程');
  assert.strictEqual(doc.deploy.resultDigest, 'sha256:abc');

  assert.strictEqual(doc.sessions[0].revealFlush, undefined);
  assert.strictEqual(doc.sessions[0].messages[0].staged, undefined);
  assert.strictEqual(doc.sessions[0].messages[0].delay, undefined);
  assert.strictEqual(doc.sessions[0].messages[0].instant, undefined);
  assert.deepStrictEqual(doc.unmappedFields, { futureThing: { keep: true } });
});

test('toDocument → fromDocument 往返：业务切片保持一致', async () => {
  const { machine, snapshot } = await load();
  const state = makeFullState(machine, snapshot);
  const doc = snapshot.toDocument(state, {
    projectId: 'p_lz9k2m4a7f3c1x',
    createdAt: '2026-10-31T06:12:03Z',
    appid: 'wx1234567890abcdef',
  });
  const hydrated = snapshot.fromDocument(doc);

  assert.deepStrictEqual(hydrated.store, doc.store);
  assert.deepStrictEqual(hydrated.features, doc.features);
  assert.deepStrictEqual(hydrated.agentDraft, doc.agentDraft);
  assert.deepStrictEqual(hydrated.build, { ...doc.build, status: 'ready' });
  assert.deepStrictEqual(hydrated.visual.promptRounds, doc.visual.promptRounds);
  assert.deepStrictEqual(hydrated.visual.imageRounds, doc.visual.imageRounds);
  assert.strictEqual(hydrated.visual.image, null);
  assert.strictEqual(hydrated.seq, 2);
  assert.strictEqual(hydrated.activeSessionId, 'session-deploy');
  assert.strictEqual(hydrated.sessions.length, 2);
  assert.strictEqual(hydrated.sessions[0].messages[0].staged, false);
  assert.strictEqual(hydrated.sessions[0].messages[0].instant, true);

  assert.strictEqual(hydrated.agent.status, 'confirmed');
  assert.strictEqual(hydrated.agent.confirmedAtSeq, 2);
  assert.strictEqual(hydrated.agent.reply, '');
  assert.strictEqual(hydrated.deploy.status, 'idle');
  assert.strictEqual(hydrated.deploy.result, null);
  assert.deepStrictEqual(hydrated.deploy.preflight, snapshot.createEmptyPreflight());
  assert.strictEqual(hydrated.deploy.handoff.stepId, 'appid');
  assert.strictEqual(hydrated.project.activeId, 'p_lz9k2m4a7f3c1x');
  assert.strictEqual(hydrated.project.appid, 'wx1234567890abcdef');
  assert.deepStrictEqual(hydrated.unmappedFields, { futureThing: { keep: true } });
});

test('hydrate 时恢复 deployment 持久字段与交接状态', async () => {
  const { machine, snapshot } = await load();
  const state = makeFullState(machine, snapshot);
  const hydrated = snapshot.fromDocument(snapshot.toDocument(state, {
    projectId: 'p_lz9k2m4a7f3c1x',
    createdAt: '2026-10-31T06:12:03Z',
  }));
  assert.strictEqual(hydrated.deploy.directory, 'D:\\小程序工程');
  assert.strictEqual(hydrated.deploy.projectName, 'songyue-shitang');
  assert.strictEqual(hydrated.deploy.resultDigest, 'sha256:abc');
  assert.deepStrictEqual(hydrated.deploy.handoff.completedStepIds, ['prepare', 'import']);
  assert.strictEqual(hydrated.deploy.handoff.appidApplied, true);
});

test('phase 降级：building / 空 candidates / 无效果图不把用户卡在异步中间态', async () => {
  const { machine, snapshot } = await load();
  const state = makeFullState(machine, snapshot);
  const doc = snapshot.toDocument(state, { projectId: 'p_lz9k2m4a7f3c1x' });

  assert.strictEqual(snapshot.fromDocument({ ...doc, phase: 'building' }).phase, 'features');
  assert.strictEqual(snapshot.fromDocument({ ...doc, phase: 'template-pick', build: { candidates: [], selectedId: null } }).phase, 'features');
  assert.strictEqual(snapshot.fromDocument({
    ...doc,
    phase: 'image-review',
    visual: { ...doc.visual, prompt: 'x', imageAssetId: null },
  }).phase, 'store-info');
  assert.strictEqual(snapshot.fromDocument({ ...doc, phase: '不存在的阶段' }).phase, 'onboarding');
});

test('未确认的资料不会在重启后误判为已确认', async () => {
  const { machine, snapshot } = await load();
  const state = makeFullState(machine, snapshot);
  const doc = snapshot.toDocument(state, { projectId: 'p_lz9k2m4a7f3c1x' });
  const reopened = snapshot.fromDocument({ ...doc, agentConfirmedSeq: null });
  assert.strictEqual(reopened.agent.status, 'reviewing');
  assert.strictEqual(reopened.agent.confirmedAtSeq, null);
});

test('会话裁剪：超过 200 条保留第一条与最近 199 条', async () => {
  const { machine, snapshot } = await load();
  const state = machine.createInitialState();
  const messages = Array.from({ length: 260 }, (_, index) => ({
    id: `m${index + 1}`,
    role: index === 0 ? 'agent' : 'user',
    text: index === 0 ? '命名引导' : `消息 ${index}`,
    meta: null,
  }));
  const doc = snapshot.toDocument({
    ...state,
    project: { ...state.project, activeId: 'p_lz9k2m4a7f3c1x' },
    sessions: [{ ...state.sessions[0], messages }],
  }, { projectId: 'p_lz9k2m4a7f3c1x' });
  assert.strictEqual(doc.sessions[0].messages.length, 200);
  assert.strictEqual(doc.sessions[0].messages[0].text, '命名引导');
  assert.strictEqual(doc.sessions[0].messages[199].text, '消息 259');
});

test('未来版本文档被标记为只读候选', async () => {
  const { machine, snapshot } = await load();
  const state = machine.createInitialState();
  const hydrated = snapshot.fromDocument({ ...snapshot.toDocument(state, { projectId: 'p_lz9k2m4a7f3c1x' }), schemaVersion: 2 });
  assert.strictEqual(hydrated.futureVersion, true);
});

test('estimateBytes 对常规项目低于 1 MiB，超大 prompt 能被提前发现', async () => {
  const { machine, snapshot } = await load();
  const state = makeFullState(machine, snapshot);
  const doc = snapshot.toDocument(state, { projectId: 'p_lz9k2m4a7f3c1x' });
  assert.ok(snapshot.estimateBytes(doc) < 1024 * 1024);
  const huge = { ...doc, visual: { ...doc.visual, prompt: 'x'.repeat(1100 * 1024) } };
  assert.ok(snapshot.estimateBytes(huge) > 1024 * 1024);
});

test('collectUnknown 只收集未知顶层键，已知键不误判', async () => {
  const { machine, snapshot } = await load();
  const state = machine.createInitialState();
  const doc = snapshot.toDocument(state, { projectId: 'p_lz9k2m4a7f3c1x' });
  const unknown = snapshot.collectUnknown({ ...doc, futureA: 1, futureB: { x: 2 } });
  assert.deepStrictEqual(unknown, { futureA: 1, futureB: { x: 2 } });
});