const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * P3：「参考截图 → 识别 → 确认 → 候选模板 → 导出链路」行为测试。
 *
 * 覆盖（对应 P3 目标 9）：
 * P1 识别 → 确认 → 候选 → 导出可用
 * P2 拒绝确认识别结果时不产生候选
 * P3 晚响应 / 换图后的旧响应被丢弃
 * P4 不支持组件如实列出，不做静默替换
 * P5 重开项目恢复（原图 assetId / 识别 / 候选 / 选用状态），且不落 base64
 * P6 旧流程不回归（agent-turn 草稿、模板选择、快照字段不变）
 * P7 视觉不可用时如实降级，不伪造识别结果
 */

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/wF9HQAAAABJRU5ErkJggg==';

async function loadDomain() {
  return import('../src/domain/screenReference.mjs');
}

async function loadMachine() {
  return import('../src/state/sessionMachine.mjs');
}

async function loadSnapshot() {
  return import('../src/domain/projectSnapshot.mjs');
}

async function loadPlan() {
  return import('../src/composition/planFromSession.mjs');
}

async function loadService() {
  return import('../src/services/agentTurn/screenReferenceService.js');
}

/** 白名单内的识别结果（服务端裁剪后的形状）。 */
function recognitionFixture(extra = {}) {
  return {
    layouts: [{ id: 'order-poster', label: '海报点餐' }],
    components: [
      { id: 'scan-order', label: '扫码点餐' },
      { id: 'store-gallery', label: '门店环境' },
    ],
    style: { theme: { primaryColor: '#FF5500' }, sizes: { homeHero: 'lg' } },
    approximate: [{ label: '视频开场', reason: '用静态海报近似' }],
    unsupported: [{ label: '直播带货', reason: '当前模板体系没有直播组件' }],
    rejected: [{ id: 'live-stream', reason: '不在已验证组件白名单', source: 'component' }],
    notes: '参考的是首页布局',
    ...extra,
  };
}

function imageFixture() {
  return {
    assetId: 'asset-ref-1',
    name: '别人的首页截图.png',
    mediaType: 'image/png',
    bytes: 512,
    dataBase64: PNG_BASE64,
    previewUrl: `data:image/png;base64,${PNG_BASE64}`,
  };
}

async function buildConfirmedCandidateState() {
  const { reducer, createInitialState } = await loadMachine();
  let state = createInitialState();
  state = reducer(state, { type: 'SET_STORE_FIELD', field: 'name', value: '松月食堂' });
  state = {
    ...state,
    agentDraft: {
      ...state.agentDraft,
      storeName: '松月食堂',
      category: '快餐',
      businessHours: '10:00-20:00',
      dishes: [
        { id: 'd1', name: '牛肉面', priceCents: 2000, description: '招牌' },
        { id: 'd2', name: '酸梅汤', priceCents: 500, description: '' },
        { id: 'd3', name: '小菜', priceCents: 300, description: '' },
      ],
    },
  };
  state = reducer(state, { type: 'SCREEN_REF_IMAGE_SET', image: imageFixture() });
  state = reducer(state, { type: 'SCREEN_REF_REQUEST', requestId: 'sr-1' });
  state = reducer(state, {
    type: 'SCREEN_REF_SUCCESS',
    requestId: 'sr-1',
    imageRevision: state.screenRef.imageRevision,
    recognition: recognitionFixture(),
    meta: { analyzed: true, model: 'stub', latencyMs: 20, runId: 'req-1' },
  });
  return { state, reducer };
}

test('P1 识别 → 确认 → 候选 → 采用后导出链路可用（含门店资料与菜品保留）', async () => {
  const { state: recognized, reducer } = await buildConfirmedCandidateState();

  assert.equal(recognized.screenRef.status, 'ready');
  assert.equal(recognized.screenRef.view.confirmable, true);

  const confirmed = reducer(recognized, { type: 'SCREEN_REF_CONFIRM', at: '2026-11-16T00:00:00.000Z' });
  assert.equal(confirmed.screenRef.confirmedAt, '2026-11-16T00:00:00.000Z');

  const withCandidate = reducer(confirmed, {
    type: 'SCREEN_REF_CREATE_CANDIDATE',
    at: '2026-11-16T00:00:01.000Z',
  });
  const candidate = withCandidate.screenRef.candidate;
  assert.ok(candidate, '确认识别后必须能生成候选模板');
  assert.equal(candidate.recipeId, 'order-poster');
  assert.deepEqual(candidate.featureIds, ['scan-order', 'store-gallery']);
  // 门店资料与菜品原样保留
  assert.equal(candidate.storeSnapshot.storeName, '松月食堂');
  assert.equal(candidate.storeSnapshot.dishes.length, 3);
  assert.equal(candidate.storeSnapshot.dishes[0].name, '牛肉面');

  // 采用前不覆盖当前版本
  assert.equal(withCandidate.build.selectedId, null);

  const adopted = reducer(withCandidate, { type: 'SCREEN_REF_ADOPT' });
  // 会话里的 selectedId 是模板 id；Recipe 由模板反查，因此这里落到 signature-kitchen
  assert.equal(adopted.build.selectedId, 'signature-kitchen');
  assert.ok(adopted.build.candidates.some((item) => item.id === 'signature-kitchen'));
  assert.ok(adopted.features.selected.includes('store-gallery'));
  assert.ok(adopted.features.selected.includes('scan-order'));
  assert.equal(adopted.screenRef.adopted, true);
  // 菜品没有被候选改写
  assert.equal(adopted.agentDraft.dishes.length, 3);
  assert.equal(adopted.agentDraft.storeName, '松月食堂');

  // 交给现有 Composer/导出链路：同一份 state 能算出 CompositionPlan
  const { buildPlanFromSession } = await loadPlan();
  const plan = buildPlanFromSession(adopted);
  assert.equal(plan.recipeId, 'order-poster');
  assert.ok(plan.plan, 'CompositionPlan 必须可生成');
});

test('P2 未确认识别结果时不生成候选；状态不对时确认被拒绝', async () => {
  const { state: recognized, reducer } = await buildConfirmedCandidateState();

  // 未确认 → 生成候选被拒（不产生候选，只给提示）
  const blocked = reducer(recognized, { type: 'SCREEN_REF_CREATE_CANDIDATE', at: '2026-11-16T00:00:02.000Z' });
  assert.equal(blocked.screenRef.candidate, null);
  assert.match(blocked.screenRef.error, /确认识别结果/);

  // 识别未完成（只有图片）→ 确认无效
  let idle = reducer(recognized, { type: 'SCREEN_REF_RESET' });
  idle = reducer(idle, { type: 'SCREEN_REF_IMAGE_SET', image: imageFixture() });
  assert.equal(idle.screenRef.status, 'idle');
  const stillIdle = reducer(idle, { type: 'SCREEN_REF_CONFIRM', at: '2026-11-16T00:00:03.000Z' });
  assert.equal(stillIdle.screenRef.confirmedAt, null);
  assert.equal(stillIdle.screenRef.view.confirmable, false);
});

test('P3 晚响应与换图后的旧响应都被丢弃（并发门禁不变）', async () => {
  const { reducer, createInitialState } = await loadMachine();
  let state = createInitialState();
  state = reducer(state, { type: 'SCREEN_REF_IMAGE_SET', image: imageFixture() });
  state = reducer(state, { type: 'SCREEN_REF_REQUEST', requestId: 'sr-late' });

  // 1) requestId 不匹配（更早一次请求的迟到响应）
  const stale = reducer(state, {
    type: 'SCREEN_REF_SUCCESS',
    requestId: 'sr-older',
    recognition: recognitionFixture(),
  });
  assert.equal(stale.screenRef.status, 'recognizing');
  assert.equal(stale.screenRef.recognition, null);

  // 2) 换图之后，旧请求的成功响应同样无效
  const revisionAtRequest = state.screenRef.imageRevision;
  const changed = reducer(state, { type: 'SCREEN_REF_IMAGE_SET', image: { ...imageFixture(), name: '第二张.png' } });
  const afterChange = reducer(changed, {
    type: 'SCREEN_REF_SUCCESS',
    requestId: 'sr-late',
    imageRevision: revisionAtRequest,
    recognition: recognitionFixture(),
  });
  assert.equal(afterChange.screenRef.recognition, null);
  assert.equal(afterChange.screenRef.status, 'idle');

  // 3) 识别中重复点「开始识别」不重复发请求
  const again = reducer(state, { type: 'SCREEN_REF_REQUEST', requestId: 'sr-second' });
  assert.equal(again.screenRef.requestId, 'sr-late');
  assert.equal(again.screenRef.attempt, state.screenRef.attempt);
});

test('P4 不支持/不在白名单的部分如实列出，不做静默替换', async () => {
  const { normalizeRecognition, buildRecognitionView, buildCandidateRecipe } = await loadDomain();
  const recognition = normalizeRecognition({
    layouts: ['order-poster', 'neon-fullscreen'],
    components: ['scan-order', 'live-stream'],
    style: { theme: { primaryColor: '#FF5500', brandGradient: 'linear-gradient(red,blue)' }, sizes: { homeHero: 'xl' } },
    approximate: [{ label: '视频开场', reason: '静态海报近似' }],
    unsupported: [{ label: '直播带货', reason: '没有直播组件' }],
  });
  const view = buildRecognitionView(recognition);

  assert.deepEqual(recognition.components.map((item) => item.id), ['scan-order']);
  assert.equal(recognition.style.theme.primaryColor, '#FF5500');
  assert.equal(recognition.style.theme.brandGradient, undefined);
  assert.equal(recognition.style.sizes.homeHero, undefined);
  assert.ok(view.groups.unsupported.some((item) => item.label === 'neon-fullscreen'));
  assert.ok(view.groups.unsupported.some((item) => item.label === 'live-stream'));
  assert.ok(view.groups.approximate.some((item) => item.label === '视频开场'));
  assert.equal(view.canConfirm, true);

  // 候选只带白名单 id，绝不带入未知组件
  const { candidate } = buildCandidateRecipe({
    recognition,
    confirmedAt: '2026-11-16T00:00:00.000Z',
    baseRecipeId: null,
    draft: { storeName: '松月食堂', dishes: [] },
    createdAt: '2026-11-16T00:00:01.000Z',
  });
  assert.deepEqual(candidate.featureIds, ['scan-order']);
  assert.equal(candidate.presentation.theme.primaryColor, '#FF5500');
  assert.equal(candidate.presentation.sizes.homeHero, undefined);
  assert.ok(candidate.unsupported.length >= 2);
});

test('P5 重开项目：原图 / 识别 / 候选 / 选用状态都在，且不把 base64 写进文档', async () => {
  const { reducer } = await loadMachine();
  const { toDocument, fromDocument } = await loadSnapshot();
  const { state: recognized } = await buildConfirmedCandidateState();
  let state = reducer(recognized, { type: 'SCREEN_REF_CONFIRM', at: '2026-11-16T00:00:00.000Z' });
  state = reducer(state, { type: 'SCREEN_REF_CREATE_CANDIDATE', at: '2026-11-16T00:00:01.000Z' });
  state = reducer(state, { type: 'SCREEN_REF_ADOPT' });
  state = { ...state, phase: 'template-pick' };

  const doc = toDocument(state, { projectId: 'p1', updatedAt: '2026-11-16T00:00:02.000Z' });
  const serialized = JSON.stringify(doc);
  assert.ok(!serialized.includes(PNG_BASE64), '持久化文档不得包含截图 base64');
  assert.ok(!serialized.includes('data:image/png'), '持久化文档不得包含预览 dataURL');
  assert.equal(doc.screenRef.image.assetId, 'asset-ref-1');
  assert.equal(doc.screenRef.adopted, true);
  assert.equal(doc.screenRef.candidate.recipeId, 'order-poster');

  const restored = fromDocument(doc);
  assert.equal(restored.phase, 'template-pick', '重开不得退回门店资料页');
  assert.equal(restored.build.selectedId, 'signature-kitchen', '采用过的候选必须仍然生效');
  assert.equal(restored.screenRef.adopted, true);
  assert.equal(restored.screenRef.image.assetId, 'asset-ref-1');
  assert.equal(restored.screenRef.recognition.components.length, 2);
  assert.equal(restored.screenRef.candidate.storeSnapshot.dishes.length, 3);
  assert.equal(restored.screenRef.status, 'ready');
  assert.equal(restored.screenRef.view.canAdopt, false, '已采用的候选不应再次「待采用」');
});

test('P6 旧流程不回归：agent 草稿与模板选择仍按原语义走，快照字段不变', async () => {
  const { reducer, createInitialState } = await loadMachine();
  const { toDocument } = await loadSnapshot();
  let state = createInitialState();
  assert.equal(state.screenRef.status, 'idle');
  assert.equal(state.screenRef.view.tone, 'idle');

  // agent 请求/成功链路仍可用（P3 未改变其入参与草稿合并）
  state = reducer(state, {
    type: 'AGENT_TURN_REQUEST',
    utterance: '店名叫松月食堂，卖牛肉面',
    requestId: 'agent-1',
    draftRevision: state.agent.draftRevision,
  });
  assert.equal(state.agent.status, 'requesting');
  state = reducer(state, {
    type: 'AGENT_TURN_SUCCESS',
    requestId: 'agent-1',
    draftRevision: state.agent.draftRevision,
    status: 'collecting',
    draft: {
      ...state.agentDraft,
      storeName: '松月食堂',
      dishes: [{ id: 'd1', name: '牛肉面', priceCents: 2000, description: '' }],
    },
    missingFields: [],
    errors: [],
    nextQuestion: null,
    reply: '好的',
    meta: { mock: true },
  });
  assert.equal(state.agent.status, 'collecting');
  assert.equal(state.agentDraft.storeName, '松月食堂');

  // 模板选择流程不受影响：候选存在时选中即可持久化（与既有模型一致）
  state = {
    ...state,
    build: {
      ...state.build,
      candidates: [{ id: 'signature-kitchen', name: '招牌厨房', layout: 'poster', score: 88, summary: '' }],
      status: 'ready',
    },
  };
  state = reducer(state, { type: 'SELECT_TEMPLATE', id: 'signature-kitchen' });
  assert.equal(state.build.selectedId, 'signature-kitchen');

  const doc = toDocument(state, { projectId: 'p2' });
  assert.equal(doc.phase, state.phase);
  assert.equal(doc.build.selectedId, 'signature-kitchen');
  assert.equal(doc.screenRef.status, 'idle');
  // 店名来自 agent 草稿：文档标题与草稿都要保留（旧语义未变）
  assert.equal(doc.name, '松月食堂');
  assert.equal(doc.agentDraft.storeName, '松月食堂');
});

test('P7 识别服务不可用时如实降级，不伪造识别结果', async () => {
  const { requestScreenReference } = await loadService();
  const degraded = await requestScreenReference({
    image: imageFixture(),
    draft: {},
    requestId: 'sr-degraded',
  });
  // 默认本地（mock）模式：没有视觉能力，必须明确失败而不是返回假结果
  assert.equal(degraded.ok, false);
  assert.equal(degraded.degraded, true);
  assert.match(degraded.message, /没有真实图片识别能力|识别服务/);
  assert.equal(degraded.recognition, undefined);
});

test('P9 面板达标：关键容器有 role/aria-label，按钮可读，无同名按钮', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'components', 'screenRef', 'ScreenReferencePanel.jsx'),
    'utf8',
  );
  // 关键容器与稳定锚点
  assert.match(source, /role="group"/);
  assert.match(source, /aria-label="参考小程序截图"/);
  assert.match(source, /id="screen-ref-panel"/);
  // 上传控件有可读名称与类型限制
  assert.match(source, /type="file"/);
  assert.match(source, /accept="image\/jpeg,image\/png,image\/webp"/);
  assert.match(source, /aria-label="选择参考截图"/);

  // 可见按钮文案齐全且互不同名
  const labels = ['上传截图', '换一张', '删除截图', '历史参考候选', '重新识别历史截图', '确认识别结果', '生成候选模板', '采用这个候选', '放弃候选'];
  labels.forEach((label) => {
    assert.ok(source.includes(label), `缺少按钮文案：${label}`);
  });
  assert.match(source, /浏览器模式/);
});

test('P8 服务端说「没看成图」时客户端标记为降级，不落任何识别结果', async () => {
  const { parseScreenReferenceResponse } = await loadDomain();
  const parsed = parseScreenReferenceResponse({
    contractVersion: 'screen-reference.v1',
    status: 'unavailable',
    recognition: null,
    meta: { analyzed: false, model: null, latencyMs: 30, runId: 'req-x' },
  });
  assert.equal(parsed.ok, false);
  assert.equal(parsed.degraded, true);
  assert.equal(parsed.recognition, undefined);

  const ok = parseScreenReferenceResponse({
    contractVersion: 'screen-reference.v1',
    status: 'ok',
    recognition: {
      layouts: ['order-poster'],
      components: ['scan-order', 'ghost-widget'],
      style: { theme: { primaryColor: 'red' } },
    },
    meta: { analyzed: true, model: 'vision', latencyMs: 800, runId: 'req-y' },
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.recognition.components.map((item) => item.id), ['scan-order']);
  assert.ok(ok.recognition.unsupported.some((item) => item.label === 'ghost-widget'));
  assert.equal(ok.recognition.style.theme.primaryColor, undefined);
});
