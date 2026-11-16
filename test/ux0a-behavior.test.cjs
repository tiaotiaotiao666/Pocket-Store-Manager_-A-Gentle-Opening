'use strict';

/**
 * UX0a 行为测试：五条必须用行为证明的约束。
 * 1. 跨会话后旧消息与新消息都在可见结果里（不再被重置为 0）；
 * 2. handoff 原文 / JSON / payload 不出现在阶段提示里；
 * 3. 没有真实生图服务时不发起 generateImage；
 * 4. 上传素材与跳过素材分别进入正确的导出状态；
 * 5. config.json 损坏时先备份再恢复默认设置。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function loadModule(relative) {
  return import(`../src/${relative}`);
}

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 一路走到「海报素材（IMAGE_REVIEW）」阶段。 */
async function reachImageReview() {
  const machine = await loadModule('state/sessionMachine.mjs');
  let state = machine.createInitialState();
  state = machine.reducer(state, { type: 'START_ONBOARDING' });
  state = machine.reducer(state, { type: 'SUBMIT_NAME', name: '松月食堂' });
  state = machine.reducer(state, { type: 'SKIP_INTRO' });
  state = machine.reducer(state, { type: 'SUBMIT_CUSTOMIZE', value: '' });
  state = machine.reducer(state, {
    type: 'BUILD_READY',
    candidates: [{ id: 'warm-bistro', name: '街巷食集', score: 88 }],
  });
  state = machine.reducer(state, { type: 'CONFIRM_TEMPLATE' });
  state = machine.reducer(state, { type: 'SUBMIT_STORE_INFO', summary: '店铺资料', styleId: 'warm' });
  state = machine.reducer(state, { type: 'CONFIRM_PROMPT' });
  return { machine, state };
}

test('UX0a-1 统一对话流：跨会话后历史消息仍在可见结果里，且不会被重置为 0', async () => {
  const { buildConversationStream } = await loadModule('state/conversationStream.mjs');
  const { nextRevealCount } = await import('../src/hooks/revealTransition.mjs');
  const { machine, state } = await reachImageReview();

  const beforeStream = buildConversationStream(state.sessions);
  assert.ok(beforeStream.messages.some((message) => message.text && message.text.includes('松月食堂')),
    '早期的店铺命名消息必须在统一流里');
  assert.equal(beforeStream.revealAll, true);

  // 进入部署阶段会产生新会话（正是原先导致"整段消失"的场景）。
  const deploy = machine.reducer(state, { type: 'APPROVE_IMAGE', material: 'skipped' });
  assert.ok(deploy.sessions.length > state.sessions.length, '应当新增了部署会话');

  const afterStream = buildConversationStream(deploy.sessions);
  assert.ok(afterStream.messages.length > beforeStream.messages.length, '新回复必须追加进来');
  assert.ok(afterStream.messages.some((message) => message.text && message.text.includes('松月食堂')),
    '旧消息必须还在可见结果里');
  assert.ok(afterStream.messages.some((message) => message.meta && message.meta.to === '部署小程序'),
    '新阶段的系统消息必须在同一条流里');

  // 展示语义稳定：换会话不改变 revealKey。
  assert.equal(afterStream.revealKey, beforeStream.revealKey, 'revealKey 必须是稳定常量');

  // 关键回归：切到新会话时计数必须等于消息总数（旧实现这里会得到 0）。
  const switched = nextRevealCount(
    { revealKey: beforeStream.revealKey, flushKey: 0 },
    {
      revealKey: afterStream.revealKey,
      flushKey: 0,
      messageCount: afterStream.messages.length,
      revealAll: afterStream.revealAll,
    },
  );
  assert.equal(switched, null, '同一 revealKey 下不得重置计数');
  const initial = nextRevealCount(
    { revealKey: 'other-session', flushKey: 0 },
    {
      revealKey: afterStream.revealKey,
      flushKey: 0,
      messageCount: afterStream.messages.length,
      revealAll: afterStream.revealAll,
    },
  );
  assert.equal(initial, afterStream.messages.length, '首次进入也必须整段可见，不能是 0');

  // 不删消息：合并结果就是各会话消息的并集。
  const union = deploy.sessions.reduce((total, session) => total + session.messages.length, 0);
  assert.equal(afterStream.messages.length, union);
});

test('UX0a-2 阶段提示只输出受控文案，绝不截取 handoff 原文/JSON/payload', async () => {
  const { stageNoticeFor } = await loadModule('components/chat/stageNotice.mjs');
  const { machine, state } = await reachImageReview();
  const deploy = machine.reducer(state, { type: 'APPROVE_IMAGE', material: 'skipped' });
  const systemMessage = deploy.sessions
    .find((session) => session.id === deploy.activeSessionId)
    .messages[0];
  assert.equal(systemMessage.role, 'system');

  const notice = stageNoticeFor(systemMessage);
  const rendered = `${notice.label} ${notice.hint}`;
  assert.equal(notice.known, true, '部署阶段应是受控阶段之一');
  assert.doesNotMatch(rendered, /payload|店铺名称|装修风格|生图提示词|海报素材|[{}\[\]]/);
  assert.doesNotMatch(rendered, /轮打磨|轮修改/);

  // 内部正文里塞入哨兵字符串：一旦实现改成"截取原文"，这里立刻失败。
  const poisoned = {
    role: 'system',
    text: 'HANDOFF-SENTINEL 店铺名称：松月食堂 {payload:{"styleId":"warm"}}',
    meta: { to: '某个未知内部阶段' },
  };
  const fallback = stageNoticeFor(poisoned);
  assert.doesNotMatch(`${fallback.label} ${fallback.hint}`, /HANDOFF-SENTINEL|松月食堂|payload/);
  assert.equal(fallback.known, false);
  assert.equal(fallback.hint, '请按提示继续。');
});

test('UX0a-3 没有真实生图服务时不会发起 generateImage', async () => {
  const capability = await loadModule('services/imageCapability.js');
  const { PHASES } = await loadModule('state/constants.mjs');

  assert.equal(capability.canGenerateImage(), false, '当前版本必须自报"没有真实生图能力"');
  assert.equal(capability.shouldAutoGenerateImage({
    phase: PHASES.IMAGE_REVIEW,
    hasImage: false,
    imageReviewPhase: PHASES.IMAGE_REVIEW,
  }), false, '没有服务时不得自动生成');

  // 即便将来有服务，也要满足"进入该阶段 + 还没有图"才生成。
  assert.equal(capability.shouldAutoGenerateImage({
    phase: PHASES.IMAGE_REVIEW,
    hasImage: true,
    imageReviewPhase: PHASES.IMAGE_REVIEW,
    available: true,
  }), false);
  assert.equal(capability.shouldAutoGenerateImage({
    phase: PHASES.DEPLOY,
    hasImage: false,
    imageReviewPhase: PHASES.IMAGE_REVIEW,
    available: true,
  }), false);

  // 接线检查：App 里守卫必须出现在 generateImage 调用之前。
  const appSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.jsx'), 'utf8');
  const guardAt = appSource.indexOf('shouldAutoGenerateImage(');
  const callAt = appSource.indexOf('generateImage({ prompt: state.visual.prompt');
  assert.ok(guardAt > -1, 'App 必须用 shouldAutoGenerateImage 守卫自动生成');
  assert.ok(callAt > -1, '保留调用点以便未来接入服务');
  assert.ok(guardAt < callAt, '守卫必须在调用之前生效');
  assert.match(appSource, /phase === PHASES\.IMAGE_REVIEW \? false : COMPOSER_PHASES\.includes\(phase\)/,
    '海报素材阶段不得显示"重新生成"输入区');
});

test('UX0a-4 上传素材与跳过素材分别进入正确的导出状态', async () => {
  const { machine, state } = await reachImageReview();
  const { PHASES } = await loadModule('state/constants.mjs');

  const withUpload = machine.reducer(state, {
    type: 'SET_POSTER_ASSET',
    assetId: 'a_0123456789abcdef',
    meta: { provider: 'user-upload', width: 32, height: 24 },
    preview: 'data:image/png;base64,AAAA',
  });
  const usedDeploy = machine.reducer(withUpload, { type: 'APPROVE_IMAGE', material: 'uploaded' });
  assert.equal(usedDeploy.phase, PHASES.DEPLOY);
  const usedText = usedDeploy.sessions.find((session) => session.id === usedDeploy.activeSessionId).messages[0].text;
  assert.match(usedText, /已选用上传图片/);
  assert.doesNotMatch(usedText, /效果图审核已通过/);

  const skippedDeploy = machine.reducer(state, { type: 'APPROVE_IMAGE', material: 'skipped' });
  assert.equal(skippedDeploy.phase, PHASES.DEPLOY);
  const skippedText = skippedDeploy.sessions.find((session) => session.id === skippedDeploy.activeSessionId).messages[0].text;
  assert.match(skippedText, /未添加（已跳过/);
  assert.doesNotMatch(skippedText, /效果图审核已通过/);

  // 没有上传却声称"已选用"时必须被纠正为跳过。
  const lying = machine.reducer(state, { type: 'APPROVE_IMAGE', material: 'uploaded' });
  const lyingText = lying.sessions.find((session) => session.id === lying.activeSessionId).messages[0].text;
  assert.match(lyingText, /未添加（已跳过/);

  // local-demo 占位图不算素材。
  const placeholder = machine.reducer(state, {
    type: 'SET_IMAGE',
    image: { dataUrl: 'data:image/svg+xml;base64,AAAA', provider: 'local-demo' },
  });
  const placeholderDeploy = machine.reducer(placeholder, { type: 'APPROVE_IMAGE', material: 'uploaded' });
  const placeholderText = placeholderDeploy.sessions
    .find((session) => session.id === placeholderDeploy.activeSessionId).messages[0].text;
  assert.match(placeholderText, /未添加（已跳过/);
});

test('UX0a-5 config.json 损坏：先备份原文件，再用默认设置继续，且合法配置不被改写', async () => {
  const { createSettingsStore } = require('../desktop/settings-store.cjs');

  // 情况一：内容不是合法 JSON。
  const dir = makeTempDir('ux0a-broken-');
  const broken = '{ "apiBaseUrl": "http://127.0.0.1:3000/api/v1", oops';
  fs.writeFileSync(path.join(dir, 'config.json'), broken);
  const store = createSettingsStore({ userDataDir: dir, now: () => new Date('2026-11-16T02:00:00Z') });

  const loaded = await store.loadConfig();
  assert.equal(loaded.source, 'default');
  assert.match(loaded.warning, /设置文件读不出来/);
    assert.match(loaded.warning, /备份/);
  assert.equal(loaded.details.reason, 'unreadable');
  assert.equal(loaded.config.apiBaseUrl, 'http://127.0.0.1:3000/api/v1', '默认配置必须可直接使用');

  const backups = fs.readdirSync(dir).filter((name) => name.startsWith('config.json.bak-'));
  assert.equal(backups.length, 1, '损坏文件必须留下带时间戳的备份');
  assert.equal(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), broken, '备份必须是原始内容');
  assert.equal(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), broken, '原配置文件不得被删除或改写');

  // 默认配置可以继续保存使用。
  const saved = await store.saveConfig({ ...loaded.config, agentTransport: 'http' });
  assert.equal(saved.config.agentTransport, 'http');
  assert.equal((await store.loadConfig()).config.agentTransport, 'http');

  // 提示里不得泄露配置内容/密钥。
  assert.doesNotMatch(`${loaded.warning} ${JSON.stringify(loaded.details)}`, /apiBaseUrl|sk-|token|password/i);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), /DEEPSEEK_API_KEY/i);

  // 情况二：JSON 合法但配置项不合法 —— 保留原文件，不产生损坏备份。
  const dir2 = makeTempDir('ux0a-invalid-');
  const invalid = `${JSON.stringify({ schemaVersion: 1, agentTransport: 'ftp' }, null, 2)}\n`;
  fs.writeFileSync(path.join(dir2, 'config.json'), invalid);
  const store2 = createSettingsStore({ userDataDir: dir2, now: () => new Date('2026-11-16T02:05:00Z') });
  const loaded2 = await store2.loadConfig();
  assert.equal(loaded2.source, 'default');
  assert.match(loaded2.warning, /不合法/);
    assert.match(loaded2.warning, /设置与自检/);
  assert.equal(loaded2.details.reason, 'invalid');
  assert.ok(Array.isArray(loaded2.details.fields) && loaded2.details.fields.includes('agentTransport'));
  assert.equal(fs.readFileSync(path.join(dir2, 'config.json'), 'utf8'), invalid, '配置项不合法时不得改写原文件');
  assert.equal(fs.readdirSync(dir2).filter((name) => name.startsWith('config.json.bak-')).length, 0,
    '内容合法（只是字段不合法）不应产生损坏备份');

  // 情况三：合法配置照旧读取，不备份、不改写。
  const dir3 = makeTempDir('ux0a-valid-');
  const valid = `${JSON.stringify({
    schemaVersion: 1,
    apiBaseUrl: 'http://127.0.0.1:4000/api/v1',
    agentTransport: 'http',
    agentEndpoint: '/api/v1/agent/turn',
    agentTimeoutMs: 45000,
    defaultAppid: '',
    autoSaveEnabled: false,
    autoSaveDebounceMs: 900,
    maxBackups: 2,
    lastProjectId: '',
    uiScale: 'compact',
  }, null, 2)}\n`;
  fs.writeFileSync(path.join(dir3, 'config.json'), valid);
  const store3 = createSettingsStore({ userDataDir: dir3, now: () => new Date('2026-11-16T02:10:00Z') });
  const loaded3 = await store3.loadConfig();
  assert.equal(loaded3.source, 'file');
  assert.equal(loaded3.warning, null);
  assert.equal(loaded3.config.agentTransport, 'http');
  assert.equal(loaded3.config.agentTimeoutMs, 45000);
  assert.equal(fs.readFileSync(path.join(dir3, 'config.json'), 'utf8'), valid, '合法配置不得被改写');
  assert.equal(fs.readdirSync(dir3).filter((name) => name.startsWith('config.json.bak-')).length, 0);
});
