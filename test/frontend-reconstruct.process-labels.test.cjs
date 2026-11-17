'use strict';

/**
 * P6 过程可观测性：前端重构（frontend-reconstruct.v1）过程卡标签来自真实 trace，
 * 只展示受控标签/runId/attempt/状态/耗时，不泄漏源码、base64、prompt 或密钥。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

async function loadProcess() {
  return import('../src/domain/agentRunProcess.mjs');
}

async function loadStageNotice() {
  return import('../src/components/chat/stageNotice.mjs');
}

function realFrontendTrace(overrides = {}) {
  return {
    modelCalls: 4,
    toolCalls: [
      { callId: 'call_1', name: 'get_frontend_capabilities', ok: true, attempts: 1, truncated: false },
      { callId: 'call_2', name: 'check_frontend_coverage', ok: true, attempts: 1, truncated: false },
      { callId: 'call_3', name: 'propose_frontend_draft', ok: true, attempts: 1, truncated: false },
      { callId: 'call_4', name: 'repair_frontend_draft', ok: false, errorCode: 'FRONTEND_DRAFT_INVALID', attempts: 1, truncated: false },
    ],
    stopReason: 'final_answer',
    degraded: true,
    ...overrides,
  };
}

test('P6-1 前端过程卡只翻译真实 trace 里的四个工具，并展示 runId/attempt/状态/耗时', async () => {
  const { buildFrontendProcessView } = await loadProcess();
  const view = buildFrontendProcessView({
    status: 'partial',
    trace: realFrontendTrace(),
    progress: { stage: 'observable', attempt: 2 },
    runId: 'frun-abc123',
    attempt: 2,
    durationMs: 12345,
  });

  assert.equal(view.tone, 'partial');
  assert.equal(view.title, '部分完成');
  assert.deepEqual(view.steps.map((step) => step.label), [
    '读取前端能力',
    '检查能力覆盖',
    '生成候选 DSL',
    '修复候选 DSL',
    '可观察项对照',
  ]);
  assert.deepEqual(view.steps.map((step) => step.state), ['done', 'done', 'done', 'failed', 'partial']);
  assert.equal(view.meta.runId, 'frun-abc123');
  assert.equal(view.meta.attempt, 2);
  assert.equal(view.meta.status, 'partial');
  assert.equal(view.meta.durationLabel, '12.3s');
  assert.deepEqual(view.metaLines, [
    '运行 frun-abc123',
    '第 2 次尝试',
    '状态：部分完成',
    '耗时 12.3s',
  ]);
  assert.match(view.headline, /4 次真实工具调用/);
  assert.match(view.notice, /采用前需要单独确认/);
});

test('P6-2 没有真实 trace/进度不编造步骤；未知工具只显示辅助步骤', async () => {
  const { buildFrontendProcessView } = await loadProcess();

  const idle = buildFrontendProcessView();
  assert.deepEqual(idle.steps, [], '没有真实输入时不得点亮任何步骤');
  assert.equal(idle.title, '等待输入');
  assert.equal(idle.metaLines.length, 1);

  const unknown = buildFrontendProcessView({
    status: 'generating',
    trace: realFrontendTrace({
      toolCalls: [{ callId: 'c', name: 'internal_debug_tool', ok: false, attempts: 1, truncated: false }],
    }),
  });
  assert.deepEqual(unknown.steps.map((step) => step.label), ['辅助步骤']);
  assert.equal(unknown.steps[0].state, 'failed');
  assert.ok(!JSON.stringify(unknown).includes('internal_debug_tool'), '不得回显未知工具真名');

  const onlyOne = buildFrontendProcessView({
    trace: { modelCalls: 1, toolCalls: [{ name: 'propose_frontend_draft', ok: true }], stopReason: 'final_answer' },
  });
  assert.deepEqual(onlyOne.steps.map((step) => step.label), ['生成候选 DSL'], '没发生的工具不得补步骤');
});

test('P6-3 耗时只在真实数据存在时展示，绝不用 0 或估算伪造', async () => {
  const { buildFrontendProcessView } = await loadProcess();

  const fromRange = buildFrontendProcessView({ startedAt: 1000, endedAt: 3500 });
  assert.equal(fromRange.meta.durationMs, 2500);
  assert.equal(fromRange.meta.durationLabel, '2.5s');
  assert.ok(fromRange.metaLines.includes('耗时 2.5s'));

  const missing = buildFrontendProcessView({ runId: 'frun-x', attempt: 1 });
  assert.equal(missing.meta.durationMs, null);
  assert.equal(missing.meta.durationLabel, null);
  assert.ok(!missing.metaLines.some((line) => line.includes('耗时')));

  const invalid = buildFrontendProcessView({ durationMs: -5, startedAt: 10, endedAt: 5 });
  assert.equal(invalid.meta.durationMs, null, '负数/倒序区间必须被忽略');
  assert.equal(invalid.meta.durationLabel, null);

  const millis = buildFrontendProcessView({ durationMs: 850 });
  assert.equal(millis.meta.durationLabel, '850ms');
  const minutes = buildFrontendProcessView({ durationMs: 125000 });
  assert.equal(minutes.meta.durationLabel, '2min');
});

test('P6-4 过程卡视图不包含工具真名、源码、base64、prompt、密钥或本机路径', async () => {
  const { buildFrontendProcessView } = await loadProcess();
  const view = buildFrontendProcessView({
    status: 'failed',
    trace: realFrontendTrace(),
    runId: 'frun-secret',
    attempt: 3,
    durationMs: 900,
    lastError: {
      code: 'FRONTEND_INTERNAL_ERROR',
      message: '失败：E:\\智能开店app\\server\\x.ts data:image/png;base64,AAAA sk-1234567890abcdef prompt=完整提示词 Authorization: Bearer x',
    },
  });
  const serialized = JSON.stringify(view);

  for (const forbidden of [
    'get_frontend_capabilities',
    'check_frontend_coverage',
    'propose_frontend_draft',
    'repair_frontend_draft',
    'call_1',
    'toolCalls',
    'toolResults',
    'arguments',
    'data:image',
    'base64',
    'sk-1234567890abcdef',
    'prompt=',
    'Authorization',
    'E:\\智能开店app',
  ]) {
    assert.ok(!serialized.includes(forbidden), `过程卡视图不得包含 ${forbidden}`);
  }
  assert.ok(serialized.includes('<local-path>'), '错误文本中的本机路径必须脱敏');
});

test('P6-5 受控阶段文案覆盖 frontend 进度，且绝不读取系统消息正文', async () => {
  const {
    stageNoticeFor,
    frontendStageNotice,
    FRONTEND_STAGE_NOTICE_LABELS,
    STAGE_NOTICE_LABELS,
  } = await loadStageNotice();

  assert.equal(frontendStageNotice('compose').label, 'Composer 校验');
  assert.equal(frontendStageNotice('unknown-stage').known, false);
  assert.equal(
    stageNoticeFor({ role: 'system', meta: { stage: 'frontend:mini-check' } }).label,
    '小程序静态校验',
  );
  assert.equal(
    stageNoticeFor({ role: 'system', meta: { frontendStage: 'verify' } }).label,
    '微信真实编译与截图',
  );
  // 原有交接阶段不回归。
  assert.equal(STAGE_NOTICE_LABELS['部署小程序'], '导出小程序');
  assert.equal(FRONTEND_STAGE_NOTICE_LABELS['frontend:done'], '完成');

  const poisoned = {
    role: 'system',
    text: 'HANDOFF-SENTINEL 店铺名称：松月食堂 {payload:{"styleId":"warm"}} sk-secret',
    meta: { stage: 'frontend:not-exist' },
  };
  const fallback = stageNoticeFor(poisoned);
  assert.equal(fallback.known, false);
  assert.equal(fallback.hint, '请按提示继续。');
  assert.doesNotMatch(`${fallback.label} ${fallback.hint}`, /HANDOFF-SENTINEL|松月食堂|payload|sk-secret/);

  // 前端阶段只认表内 key，未知 key 回落到固定兜底。
  const unknown = frontendStageNotice('raw-internal-stage');
  assert.equal(unknown.known, false);
  assert.equal(unknown.label, '进行中');
});

test('P6-6 ChatStream 只渲染安全过程卡，不序列化 trace、不读消息正文', () => {
  const chatSource = fs.readFileSync(path.join(ROOT, 'src/components/chat/ChatStream.jsx'), 'utf8');
  const noticeSource = fs.readFileSync(path.join(ROOT, 'src/components/chat/stageNotice.mjs'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src/styles/chat.css'), 'utf8');

  for (const token of ['process.metaLines', 'process.steps', 'process.title', '本轮处理过程', '运行标识与耗时', '处理步骤']) {
    assert.ok(chatSource.includes(token), 'ChatStream 缺少安全过程卡字段：' + token);
  }
  assert.ok(chatSource.includes('ProcessSummary'));
  assert.ok(!chatSource.includes('JSON.stringify'), 'ChatStream 不得序列化原始 trace');
  assert.ok(!chatSource.includes('dangerouslySetInnerHTML'), 'ChatStream 不得注入 HTML');
  assert.ok(!/message\.text/.test(chatSource), 'ChatStream 不得直接读取消息正文');

  assert.ok(noticeSource.includes('FRONTEND_STAGE_NOTICES'));
  assert.ok(noticeSource.includes('frontendStageNotice'));
  assert.ok(!/message\.text/.test(noticeSource), 'stageNotice 不得读取消息正文');

  for (const token of ['.chat-process', '.chat-process-meta', '.chat-process-steps', '.chat-process-step-detail']) {
    assert.ok(css.includes(token), 'chat.css 缺少过程卡样式：' + token);
  }
});

test('P6-7 既有 agent-run 过程卡标签与语义保持不变', async () => {
  const { buildProcessView, TOOL_STEP_LABELS, translateToolName } = await loadProcess();
  assert.deepEqual(TOOL_STEP_LABELS, {
    get_store_draft: '读取门店资料',
    update_store_draft: '更新门店资料',
  });
  assert.equal(translateToolName('get_store_draft'), '读取门店资料');
  assert.equal(translateToolName('propose_frontend_draft'), '生成候选 DSL');
  assert.equal(translateToolName('run_sql'), '辅助步骤');

  const view = buildProcessView({
    trace: {
      modelCalls: 2,
      toolCalls: [
        { name: 'get_store_draft', ok: true },
        { name: 'update_store_draft', ok: true },
      ],
      stopReason: 'final_answer',
      degraded: false,
    },
    runId: 'run_1',
  });
  assert.equal(view.tone, 'done');
  assert.equal(view.title, '完成');
  assert.deepEqual(view.steps.map((step) => step.label), ['理解需求', '读取门店资料', '更新门店资料', '校验信息']);
});

test('P6-8 package/AGENTS 入口可执行且不虚增不存在的命令', async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['frontend:verify'], 'node scripts/frontend-verify.cjs');
  assert.ok(fs.existsSync(path.join(ROOT, 'scripts/frontend-verify.cjs')));
  assert.equal(pkg.scripts['frontend:smoke'], undefined, '没有 frontend-smoke 脚本时不得虚增');

  const agents = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
  assert.ok(agents.includes('frontend:verify'), 'AGENTS.md 应记录 frontend:verify');
  assert.ok(agents.includes('scripts/frontend-verify.cjs'), 'AGENTS.md 说明实际脚本入口');
  assert.ok(agents.includes('frontend:capabilities:check'));
});
