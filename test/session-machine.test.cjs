const test = require('node:test');
const assert = require('node:assert/strict');

async function loadMachine() {
  return import('../src/state/sessionMachine.mjs');
}

async function loadConstants() {
  return import('../src/state/constants.mjs');
}

async function seeded() {
  const machine = await loadMachine();
  let state = machine.createInitialState();
  state = machine.reducer(state, { type: 'START_ONBOARDING' });
  state = machine.reducer(state, { type: 'SUBMIT_NAME', name: '松月食堂' });
  state = machine.reducer(state, { type: 'SKIP_INTRO' });
  return { machine, state };
}

test('initial state is home with a single main session and required features', async () => {
  const { createInitialState, selectSelectedFeatures } = await loadMachine();
  const { PHASES } = await loadConstants();
  const state = createInitialState();
  assert.equal(state.phase, PHASES.HOME);
  assert.equal(state.sessions.length, 1);
  assert.equal(state.sessions[0].kind, 'main');
  assert.deepEqual(selectSelectedFeatures(state), [
    'scan-order',
    'product-catalog',
    'cart-checkout',
    'order-tracking',
  ]);
});

test('START_ONBOARDING enters onboarding and appends an agent prompt', async () => {
  const { createInitialState, reducer } = await loadMachine();
  const { PHASES, ROLES } = await loadConstants();
  const state = reducer(createInitialState(), { type: 'START_ONBOARDING' });
  assert.equal(state.phase, PHASES.ONBOARDING);
  assert.equal(state.sessions[0].messages.length, 1);
  assert.equal(state.sessions[0].messages[0].role, ROLES.AGENT);
  assert.ok(state.sessions[0].messages[0].text.includes('命名'));
});

test('SUBMIT_NAME rejects blank names and accepts a valid store name', async () => {
  const machine = await loadMachine();
  const { PHASES } = await loadConstants();
  const started = machine.reducer(machine.createInitialState(), { type: 'START_ONBOARDING' });

  const blank = machine.reducer(started, { type: 'SUBMIT_NAME', name: '   ' });
  assert.equal(blank, started);

  const named = machine.reducer(started, { type: 'SUBMIT_NAME', name: '松月食堂' });
  assert.equal(named.phase, PHASES.ONBOARDING);
  assert.equal(named.store.name, '松月食堂');
  assert.equal(named.sessions[0].title, '松月食堂');
  assert.ok(named.sessions[0].messages.some((message) => message.role === 'user'));
  assert.ok(named.sessions[0].messages.some((message) => message.text.includes('轻启')));
});

test('SKIP_INTRO and ENTER_FEATURES both land on the features phase', async () => {
  const { machine, state } = await seeded();
  const { PHASES } = await loadConstants();
  const skipped = machine.reducer(state, { type: 'SKIP_INTRO' });
  assert.equal(skipped.phase, PHASES.FEATURES);
  const entered = machine.reducer(state, { type: 'ENTER_FEATURES' });
  assert.equal(entered.phase, PHASES.FEATURES);
});

test('SKIP_INTRO flushes queued reveals while keeping every message', async () => {
  const machine = await loadMachine();
  let state = machine.reducer(machine.createInitialState(), { type: 'START_ONBOARDING' });
  state = machine.reducer(state, { type: 'SUBMIT_NAME', name: '松月食堂' });
  const before = state.sessions.find((item) => item.id === state.activeSessionId);
  assert.equal(before.revealFlush, 0);
  const queued = before.messages.length;

  const skipped = machine.reducer(state, { type: 'SKIP_INTRO' });
  const flushed = skipped.sessions.find((item) => item.id === skipped.activeSessionId);
  assert.equal(flushed.revealFlush, 1);
  assert.equal(flushed.messages.length, queued + 1);
  assert.ok(flushed.messages.some((message) => message.meta?.kind === 'feature-intro'));
  assert.ok(flushed.messages.some((message) => message.text.includes('轻启')));

  const entered = machine.reducer(state, { type: 'ENTER_FEATURES' });
  assert.equal(entered.sessions.find((item) => item.id === entered.activeSessionId).revealFlush, 0);
});

test('TOGGLE_FEATURE keeps required features locked and toggles optional ones', async () => {
  const { machine, state } = await seeded();
  const locked = machine.reducer(state, { type: 'TOGGLE_FEATURE', id: 'scan-order' });
  assert.equal(locked, state);

  const added = machine.reducer(state, { type: 'TOGGLE_FEATURE', id: 'takeaway' });
  assert.ok(added.features.selected.includes('takeaway'));
  const removed = machine.reducer(added, { type: 'TOGGLE_FEATURE', id: 'takeaway' });
  assert.ok(!removed.features.selected.includes('takeaway'));
});

test('SUBMIT_CUSTOMIZE captures the custom requirement and enters building', async () => {
  const { machine, state } = await seeded();
  const { PHASES } = await loadConstants();
  const building = machine.reducer(state, { type: 'SUBMIT_CUSTOMIZE', value: '想要预约排队功能' });
  assert.equal(building.phase, PHASES.BUILDING);
  assert.equal(building.features.custom, '想要预约排队功能');
  assert.ok(
    building.sessions[0].messages.some(
      (message) => message.role === 'user' && message.text === '想要预约排队功能',
    ),
  );
});

test('BUILD_READY selects the first candidate and moves to template picking', async () => {
  const { machine, state } = await seeded();
  const { PHASES } = await loadConstants();
  const building = machine.reducer(state, { type: 'SUBMIT_CUSTOMIZE', value: '' });
  const candidates = [
    { id: 'warm-bistro', name: '街巷食集', score: 88 },
    { id: 'modern-coffee', name: '一杯日常', score: 70 },
  ];
  const picked = machine.reducer(building, { type: 'BUILD_READY', candidates });
  assert.equal(picked.phase, PHASES.TEMPLATE_PICK);
  assert.deepEqual(picked.build.candidates, candidates);
  assert.equal(picked.build.selectedId, 'warm-bistro');
});

test('CONFIRM_TEMPLATE opens a new step session with a system handoff', async () => {
  const { machine, state } = await seeded();
  const { PHASES } = await loadConstants();
  const building = machine.reducer(state, { type: 'SUBMIT_CUSTOMIZE', value: '' });
  const picked = machine.reducer(building, {
    type: 'BUILD_READY',
    candidates: [{ id: 'warm-bistro', name: '街巷食集', score: 88 }],
  });
  const storeInfo = machine.reducer(picked, { type: 'CONFIRM_TEMPLATE' });

  assert.equal(storeInfo.phase, PHASES.STORE_INFO);
  assert.equal(storeInfo.sessions.length, picked.sessions.length + 1);
  const active = storeInfo.sessions.find((session) => session.id === storeInfo.activeSessionId);
  assert.equal(active.title, '店铺装修');
  assert.equal(active.kind, 'step');
  assert.equal(active.messages[0].role, 'system');
  assert.ok(active.messages[0].text.includes('会话交接'));
  const previous = storeInfo.sessions.find((session) => session.id === 'session-main');
  assert.equal(previous.status, 'done');
});

test('SUBMIT_STORE_INFO enters prompt studio and keeps the chosen style', async () => {
  const { machine, state } = await seeded();
  const { PHASES } = await loadConstants();
  let next = machine.reducer(state, { type: 'SUBMIT_CUSTOMIZE', value: '' });
  next = machine.reducer(next, {
    type: 'BUILD_READY',
    candidates: [{ id: 'warm-bistro', name: '街巷食集', score: 88 }],
  });
  next = machine.reducer(next, { type: 'CONFIRM_TEMPLATE' });
  next = machine.reducer(next, {
    type: 'SUBMIT_STORE_INFO',
    summary: '店铺：松月食堂 · 社区餐馆',
    styleId: 'fresh',
  });
  assert.equal(next.phase, PHASES.PROMPT_STUDIO);
  assert.equal(next.visual.styleId, 'fresh');
});

test('CONFIRM_PROMPT switches phase but keeps the same session for image review', async () => {
  const { machine, state } = await seeded();
  const { PHASES } = await loadConstants();
  let next = machine.reducer(state, { type: 'SUBMIT_CUSTOMIZE', value: '' });
  next = machine.reducer(next, {
    type: 'BUILD_READY',
    candidates: [{ id: 'warm-bistro', name: '街巷食集', score: 88 }],
  });
  next = machine.reducer(next, { type: 'CONFIRM_TEMPLATE' });
  next = machine.reducer(next, { type: 'SUBMIT_STORE_INFO', summary: '店铺资料', styleId: 'warm' });
  const sessionBefore = next.activeSessionId;
  const review = machine.reducer(next, { type: 'CONFIRM_PROMPT' });
  assert.equal(review.phase, PHASES.IMAGE_REVIEW);
  assert.equal(review.activeSessionId, sessionBefore);
});

test('ADD_IMAGE_ROUND records feedback rounds and the revised image', async () => {
  const { machine, state } = await seeded();
  let next = machine.reducer(state, { type: 'SUBMIT_CUSTOMIZE', value: '' });
  next = machine.reducer(next, {
    type: 'BUILD_READY',
    candidates: [{ id: 'warm-bistro', name: '街巷食集', score: 88 }],
  });
  next = machine.reducer(next, { type: 'CONFIRM_TEMPLATE' });
  next = machine.reducer(next, { type: 'SUBMIT_STORE_INFO', summary: '店铺资料', styleId: 'warm' });
  next = machine.reducer(next, { type: 'CONFIRM_PROMPT' });
  const revised = machine.reducer(next, {
    type: 'ADD_IMAGE_ROUND',
    text: '再暖一点',
    reply: '已调整',
    image: { dataUrl: 'data:image/svg+xml;base64,AAAA' },
  });
  assert.equal(revised.visual.imageRounds.length, 1);
  assert.equal(revised.visual.image.dataUrl, 'data:image/svg+xml;base64,AAAA');
});

test('APPROVE_IMAGE opens a deployment session', async () => {
  const { machine, state } = await seeded();
  const { PHASES } = await loadConstants();
  let next = machine.reducer(state, { type: 'SUBMIT_CUSTOMIZE', value: '' });
  next = machine.reducer(next, {
    type: 'BUILD_READY',
    candidates: [{ id: 'warm-bistro', name: '街巷食集', score: 88 }],
  });
  next = machine.reducer(next, { type: 'CONFIRM_TEMPLATE' });
  next = machine.reducer(next, { type: 'SUBMIT_STORE_INFO', summary: '店铺资料', styleId: 'warm' });
  next = machine.reducer(next, { type: 'CONFIRM_PROMPT' });
  const deploy = machine.reducer(next, { type: 'APPROVE_IMAGE' });
  assert.equal(deploy.phase, PHASES.DEPLOY);
  assert.equal(deploy.sessions.length, next.sessions.length + 1);
  const active = deploy.sessions.find((session) => session.id === deploy.activeSessionId);
  assert.equal(active.title, '部署小程序');
  assert.equal(active.messages[0].role, 'system');
});

test('DEPLOY_PROGRESS and DEPLOY_DONE update deployment state', async () => {
  const { createInitialState, reducer } = await loadMachine();
  const running = reducer(createInitialState(), { type: 'DEPLOY_PROGRESS', step: 2, progress: 50 });
  assert.equal(running.deploy.status, 'running');
  assert.equal(running.deploy.progress, 50);
  const done = reducer(running, { type: 'DEPLOY_DONE' });
  assert.equal(done.deploy.status, 'done');
  assert.equal(done.deploy.progress, 100);
});

test('SWITCH_SESSION changes the active session id', async () => {
  const { machine, state } = await seeded();
  const switched = machine.reducer(state, { type: 'SWITCH_SESSION', id: 'session-main' });
  assert.equal(switched.activeSessionId, 'session-main');
});

test('buildHandoff renders the title, summary and payload block', async () => {
  const { buildHandoff } = await import('../src/domain/handoff.mjs');
  const text = buildHandoff({
    from: '松月食堂',
    to: '店铺装修',
    summary: ['店铺名称：松月食堂', '页面骨架：街巷食集'],
    payload: { template: 'warm-bistro' },
  });
  assert.ok(text.includes('# 会话交接'));
  assert.ok(text.includes('店铺装修'));
  assert.ok(text.includes('店铺名称：松月食堂'));
  assert.ok(text.includes('```json'));
  assert.ok(text.includes('"template": "warm-bistro"'));
});

test('onboarding script exposes the expected fixed copy', async () => {
  const script = await import('../src/domain/onboardingScript.mjs');
  assert.ok(Array.isArray(script.INTRO_SCRIPT));
  assert.ok(script.INTRO_SCRIPT.length > 0);
  assert.equal(script.SKIP_HINT.question, '已经了解？想跳过');
  assert.equal(script.SKIP_HINT.action, '跳过');
  assert.equal(script.DEPLOY_STEPS.length, 4);
});
test('SUBMIT_STORE_INFO opens a dedicated visual generation session', async () => {
  const { machine, state } = await seeded();
  const { PHASES } = await loadConstants();
  let next = machine.reducer(state, { type: 'SUBMIT_CUSTOMIZE', value: '' });
  next = machine.reducer(next, {
    type: 'BUILD_READY',
    candidates: [{ id: 'warm-bistro', name: '街巷食集', score: 88 }],
  });
  next = machine.reducer(next, { type: 'CONFIRM_TEMPLATE' });
  const before = next.sessions.length;
  const visual = machine.reducer(next, {
    type: 'SUBMIT_STORE_INFO',
    summary: '店铺：松月食堂 · 社区餐馆',
    styleId: 'fresh',
  });

  assert.equal(visual.phase, PHASES.PROMPT_STUDIO);
  assert.equal(visual.sessions.length, before + 1);
  assert.equal(visual.activeSessionId, 'session-visual');
  const active = visual.sessions.find((session) => session.id === 'session-visual');
  assert.equal(active.title, '视觉生成');
  assert.equal(active.messages[0].role, 'system');
  assert.ok(active.messages[0].text.includes('会话交接'));
  const storeSession = visual.sessions.find((session) => session.id === 'session-store');
  assert.equal(storeSession.status, 'done');
  assert.equal(visual.visual.styleId, 'fresh');
});

test('prompt studio and image review share the visual generation session', async () => {
  const { machine, state } = await seeded();
  let next = machine.reducer(state, { type: 'SUBMIT_CUSTOMIZE', value: '' });
  next = machine.reducer(next, {
    type: 'BUILD_READY',
    candidates: [{ id: 'warm-bistro', name: '街巷食集', score: 88 }],
  });
  next = machine.reducer(next, { type: 'CONFIRM_TEMPLATE' });
  next = machine.reducer(next, { type: 'SUBMIT_STORE_INFO', summary: '店铺资料', styleId: 'warm' });
  const visualSession = next.activeSessionId;
  assert.equal(visualSession, 'session-visual');
  const review = machine.reducer(next, { type: 'CONFIRM_PROMPT' });
  assert.equal(review.activeSessionId, visualSession);
  assert.equal(review.activeSessionId, 'session-visual');
});
test('DEPLOY 状态机：选择目录、真实阶段、成功/失败/冲突/取消与重置', async () => {
  const { machine, state } = await seeded();
  const { DEPLOY_STATUS, PHASES } = await loadConstants();
  let next = { ...state, phase: PHASES.DEPLOY };

  assert.equal(next.deploy.status, DEPLOY_STATUS.IDLE);
  assert.deepEqual(next.deploy.previewOnly, []);

  next = machine.reducer(next, { type: 'DEPLOY_START', taskId: 'task-1' });
  assert.equal(next.deploy.status, DEPLOY_STATUS.CHOOSING);
  assert.equal(next.deploy.taskId, 'task-1');

  next = machine.reducer(next, { type: 'DEPLOY_DIRECTORY_CHOSEN', directory: 'C:\\exports', projectName: '松月食堂' });
  assert.equal(next.deploy.status, DEPLOY_STATUS.VALIDATING);
  assert.equal(next.deploy.busy, true);
  assert.equal(next.deploy.step, 0);

  next = machine.reducer(next, { type: 'DEPLOY_STAGE', stage: 'emit', step: 6, progress: 25, message: '生成工程' });
  assert.equal(next.deploy.status, DEPLOY_STATUS.GENERATING);
  assert.equal(next.deploy.step, 1);
  assert.equal(next.deploy.progress, 25);
  assert.equal(next.deploy.stageMessage, '生成工程');

  next = machine.reducer(next, { type: 'DEPLOY_STAGE', stage: 'verify', step: 7, message: '检查产物' });
  assert.equal(next.deploy.status, DEPLOY_STATUS.VERIFYING);
  assert.equal(next.deploy.step, 2);

  const success = machine.reducer(next, {
    type: 'DEPLOY_SUCCESS',
    result: { outputPath: 'C:\\exports\\松月食堂', lockDigest: 'sha256:' + 'a'.repeat(64) },
    previewOnly: [],
    warnings: ['提示'],
  });
  assert.equal(success.deploy.status, DEPLOY_STATUS.DONE);
  assert.equal(success.deploy.step, 4);
  assert.equal(success.deploy.progress, 100);
  assert.equal(success.deploy.result.outputPath, 'C:\\exports\\松月食堂');
  assert.deepEqual(success.deploy.warnings, ['提示']);

  const failed = machine.reducer(next, {
    type: 'DEPLOY_FAILURE',
    error: { code: 'TARGET_NOT_WRITABLE', message: '导出位置不可写' },
  });
  assert.equal(failed.deploy.status, DEPLOY_STATUS.FAILED);
  assert.equal(failed.deploy.error.code, 'TARGET_NOT_WRITABLE');

  const conflict = machine.reducer(next, {
    type: 'DEPLOY_CONFLICT',
    error: { code: 'TARGET_EXISTS', message: '同名目录已存在', suggestedName: '松月食堂-2' },
  });
  assert.equal(conflict.deploy.status, DEPLOY_STATUS.CONFLICT);
  assert.equal(conflict.deploy.error.suggestedName, '松月食堂-2');

  const cancelled = machine.reducer(next, { type: 'DEPLOY_CANCELLED' });
  assert.equal(cancelled.deploy.status, DEPLOY_STATUS.CANCELLED);
  assert.equal(cancelled.deploy.progress, 0);
  assert.equal(cancelled.deploy.busy, false);

  const reset = machine.reducer(success, { type: 'DEPLOY_RESET' });
  assert.equal(reset.deploy.status, DEPLOY_STATUS.IDLE);
  assert.equal(reset.deploy.step, 0);
  assert.equal(reset.deploy.result, null);
  assert.equal(reset.deploy.directory, 'C:\\exports');
});

test('轻启：无活动项目直接开始，有活动项目必须先确认新建', async () => {
  const machine = await loadMachine();
  const base = machine.createInitialState();
  assert.strictEqual(machine.selectOnboardingStart(base), 'start');

  const withProject = { ...base, project: { ...base.project, activeId: 'p_test12345678' } };
  assert.strictEqual(machine.selectOnboardingStart(withProject), 'confirm-create');

  const deployed = { ...withProject, phase: 'deploy' };
  assert.strictEqual(machine.selectOnboardingStart(deployed), 'confirm-create');
});

test('ADD_PROJECT_IMAGES 合并去重、限制 6 张，空输入不改变状态', async () => {
  const machine = await loadMachine();
  const base = machine.createInitialState();
  const image = (id) => ({
    assetId: `a_${id}`,
    fileName: `${id}.png`,
    originalName: `${id}.png`,
    mime: 'image/png',
    bytes: 1024,
    width: 800,
    height: 600,
  });

  const empty = machine.reducer(base, { type: 'ADD_PROJECT_IMAGES', images: [] });
  assert.strictEqual(empty, base);

  const first = machine.reducer(base, { type: 'ADD_PROJECT_IMAGES', images: [image('1'), image('2')] });
  assert.deepStrictEqual(first.assets.images.map((item) => item.assetId), ['a_1', 'a_2']);

  const dedup = machine.reducer(first, { type: 'ADD_PROJECT_IMAGES', images: [image('2'), image('3')] });
  assert.deepStrictEqual(dedup.assets.images.map((item) => item.assetId), ['a_1', 'a_2', 'a_3']);

  const same = machine.reducer(dedup, { type: 'ADD_PROJECT_IMAGES', images: [image('1')] });
  assert.strictEqual(same, dedup);

  const many = machine.reducer(base, {
    type: 'ADD_PROJECT_IMAGES',
    images: ['1', '2', '3', '4', '5', '6', '7'].map(image),
  });
  assert.strictEqual(many.assets.images.length, 6);
  assert.deepStrictEqual(many.assets.images.map((item) => item.assetId), ['a_1', 'a_2', 'a_3', 'a_4', 'a_5', 'a_6']);
  assert.deepStrictEqual(base.assets.images, []);
});

test('新建项目与删除当前项目不会丢失已加载的设置', async () => {
  const machine = await loadMachine();
  const config = {
    apiBaseUrl: 'http://127.0.0.1:3000/api/v1',
    autoSaveEnabled: true,
    autoSaveDebounceMs: 800,
  };
  const loaded = machine.reducer(machine.createInitialState(), { type: 'SETTINGS_LOAD_SUCCESS', config });
  assert.deepStrictEqual(loaded.settings.config, config);

  const created = machine.reducer(loaded, {
    type: 'PROJECT_NEW_SUCCESS',
    projectId: 'p_test12345678',
    createdAt: '2026-10-31T00:00:00Z',
    appid: '',
  });
  assert.deepStrictEqual(created.settings.config, config);
  assert.strictEqual(created.settings.status, 'ready');

  const opened = machine.reducer(loaded, {
    type: 'PROJECT_OPEN_SUCCESS',
    projectId: 'p_active12345678',
    doc: { schemaVersion: 1 },
  });
  const deleted = machine.reducer(opened, {
    type: 'PROJECT_DELETE_SUCCESS',
    projectId: 'p_active12345678',
  });
  assert.deepStrictEqual(deleted.settings.config, config);
});

test('导出与更换目录两种门禁：同名冲突不可直接导出但可换目录', async () => {
  const machine = await loadMachine();
  const base = machine.createInitialState();
  const withPreflight = ({ errors = [], warns = [], acknowledged = [], status = 'done' } = {}) => ({
    ...base,
    project: { ...base.project, mode: 'desktop' },
    deploy: {
      ...base.deploy,
      preflight: {
        status,
        errors,
        warns,
        infos: [],
        acknowledged,
        planDigest: null,
        checkedAt: null,
        error: null,
      },
    },
  });
  const conflict = { ruleId: 'E-TARGET-EXISTS', level: 'error', message: '同名目录已存在' };

  const onlyConflict = withPreflight({ errors: [conflict] });
  assert.equal(machine.selectCanExport(onlyConflict).can, false);
  assert.equal(machine.selectCanChooseDirectory(onlyConflict).can, true);

  const otherError = withPreflight({ errors: [conflict, { ruleId: 'E-PLAN-NAME', level: 'error', message: '缺店名' }] });
  assert.equal(machine.selectCanChooseDirectory(otherError).can, false);

  const unackedWarn = withPreflight({
    errors: [conflict],
    warns: [{ ruleId: 'W-NO-APPID', level: 'warn', message: '缺 AppID' }],
  });
  assert.equal(machine.selectCanChooseDirectory(unackedWarn).can, false);

  const ackedWarn = withPreflight({
    errors: [conflict],
    warns: [{ ruleId: 'W-NO-APPID', level: 'warn', message: '缺 AppID' }],
    acknowledged: ['W-NO-APPID'],
  });
  assert.equal(machine.selectCanChooseDirectory(ackedWarn).can, true);

  const clean = withPreflight();
  assert.equal(machine.selectCanExport(clean).can, true);
  assert.equal(machine.selectCanChooseDirectory(clean).can, true);

  const checking = withPreflight({ status: 'checking' });
  assert.equal(machine.selectCanChooseDirectory(checking).can, false);

  const failed = withPreflight({ status: 'failed' });
  assert.equal(machine.selectCanChooseDirectory(failed).can, false);

  const browser = { ...onlyConflict, project: { ...onlyConflict.project, mode: 'browser' } };
  assert.equal(machine.selectCanChooseDirectory(browser).can, false);
});

test('APPROVE_IMAGE 进入部署阶段时重置部署状态', async () => {
  const { machine, state } = await seeded();
  const { DEPLOY_STATUS, PHASES } = await loadConstants();
  const dirty = {
    ...state,
    deploy: { ...state.deploy, status: DEPLOY_STATUS.DONE, step: 4, result: { outputPath: 'old' } },
  };
  const next = machine.reducer(dirty, { type: 'APPROVE_IMAGE' });
  assert.equal(next.phase, PHASES.DEPLOY);
  assert.equal(next.deploy.status, DEPLOY_STATUS.IDLE);
  assert.equal(next.deploy.result, null);
});

test('部署四个步骤文案对齐真实能力，不再出现上传/审核', async () => {
  const script = await import('../src/domain/onboardingScript.mjs');
  assert.deepEqual([...script.DEPLOY_STEPS], ['校验配置', '生成工程', '检查产物', '导入微信开发者工具（外部）']);
  const joinedSteps = script.DEPLOY_STEPS.join(' ');
  ['上传', '审核', '发布', '部署上线'].forEach((word) => {
    assert.equal(joinedSteps.includes(word), false, '步骤文案不应包含 ' + word);
  });
  assert.equal(script.DEPLOY_INTRO.includes('上传到演示环境'), false);
  assert.equal(script.DEPLOY_INTRO.includes('等待审核'), false);
  assert.ok(script.DEPLOY_INTRO.includes('不会自动上传或发布'));
});