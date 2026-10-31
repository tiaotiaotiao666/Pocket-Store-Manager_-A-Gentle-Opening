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