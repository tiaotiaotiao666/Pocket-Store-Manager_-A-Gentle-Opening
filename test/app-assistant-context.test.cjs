const test = require('node:test');
const assert = require('node:assert/strict');

const { createInitialState, reducer } = require('../src/state/sessionMachine.mjs');
const {
  buildProjectAgentContext,
  buildProjectContextSnapshot,
  measureProjectContextBytes,
  PROJECT_CONTEXT_MAX_BYTES,
} = require('../src/domain/projectAgentContext.mjs');

function baseState() {
  return createInitialState();
}

test('上下文覆盖整个项目而不是当前阶段', () => {
  const state = baseState();
  const context = buildProjectAgentContext(state);
  assert.equal(context.capabilitiesVersion, 'app-capabilities.v1');
  assert.ok(context.fields['store.name'] !== undefined);
  assert.ok(context.fields['store.dishes']);
  assert.ok(context.validation);
  assert.ok(context.build);
  assert.ok(context.assets);
  assert.ok(context.deploy);
});

test('上下文不含设置、密钥、绝对路径、base64 与目录', () => {
  const state = {
    ...baseState(),
    deploy: { ...createInitialState().deploy, directory: 'E:\\智能开店app\\out' },
    settings: { config: { apiKey: 'sk-secret-value', baseUrl: 'https://api.deepseek.com' } },
    visual: { ...createInitialState().visual, prompt: '青色墙面', image: { dataUrl: 'data:image/png;base64,AAAA' } },
    assets: {
      images: [
        { assetId: 'asset-1', fileName: 'a.jpg', mime: 'image/jpeg', width: 100, height: 80, source: 'user-upload', dataUrl: 'data:image/jpeg;base64,BBBB' },
      ],
    },
  };
  const text = JSON.stringify(buildProjectAgentContext(state));
  assert.equal(text.includes('sk-secret-value'), false);
  assert.equal(text.includes('data:image'), false);
  assert.equal(text.includes('E:\\\\智能开店app'), false);
  assert.equal(text.includes('"directory"'), false);
  assert.equal(text.includes('settings'), false);
  assert.ok(text.includes('asset-1'));
});

test('phase/会话/草稿变化不改变业务快照；业务字段变化会改变', () => {
  const state = baseState();
  const before = buildProjectContextSnapshot(state);

  const phaseOnly = { ...state, phase: 'deploy' };
  assert.equal(buildProjectContextSnapshot(phaseOnly), before);

  const chatOnly = {
    ...state,
    agentChat: { ...state.agentChat, draft: '正在输入', messages: [{ id: 'm1', role: 'user', text: 'hi' }] },
    sessions: [{ ...state.sessions[0], messages: [{ id: 'x', role: 'agent', text: 'hello' }] }],
  };
  assert.equal(buildProjectContextSnapshot(chatOnly), before);

  const storeChanged = reducer(state, { type: 'SET_STORE_FIELD', field: 'name', value: '松月食堂' });
  assert.notEqual(buildProjectContextSnapshot(storeChanged), before);
});

test('上下文大小受控', () => {
  const state = baseState();
  const bytes = measureProjectContextBytes(buildProjectAgentContext(state));
  assert.ok(bytes < PROJECT_CONTEXT_MAX_BYTES, `上下文 ${bytes} 字节超过上限`);
});