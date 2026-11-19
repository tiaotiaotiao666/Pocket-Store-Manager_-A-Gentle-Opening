'use strict';

/**
 * T4 静态接线检查：右侧栏「Agent 对话」在 App 里的接入点。
 *
 * 只读 `src/App.jsx` 源码，不渲染 React —— 真实行为由
 * `test/agent-sidebar.test.cjs`（domain）与 `test/session-machine.test.cjs`（reducer）覆盖。
 * 这里守住 App 这一层不该被破坏的契约：
 *
 * 1. `handleAgentTurn` / `handleTemplateReviseSubmit` 支持 `origin: 'main' | 'sidebar'`；
 * 2. 侧栏每一轮只追加一条用户消息（REQUEST_START 在各自函数体内各出现一次），
 *    成功/失败各写一条助手消息，外层不再重复追加；
 * 3. 侧栏入口按阶段路由：门店资料 → agent turn，模板展示 → 模板对话修改，
 *    其余阶段只给本地指引（不调用模型）；没有活动项目时本地拦截；
 * 4. 防重：在途时忽略再次提交（`status === 'requesting'` + 同步 ref 守卫）；
 * 5. 防串：请求身份（项目/阶段/requestId）在发起时冻结，迟到响应交给 reducer 丢弃，
 *    App 不另写一套「是否可写入」的判断；
 * 6. 过程卡只用 `lastRun`（`normalizeChatRun` 白名单产物），trace 不进消息正文；
 * 7. RightPanel 拿到 `agentChat` 视图模型；会话按项目持久化（toDocument/依赖列）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_PATH = path.join(__dirname, '..', 'src', 'App.jsx');

function readApp() {
  // 统一换行，避免 CRLF 让分块标记失配（只做只读分析）。
  return fs.readFileSync(APP_PATH, 'utf8').replace(/\r\n/g, '\n');
}

/** 截取一个函数/代码块的源码（从起始标记到结束的 `  };`）。 */
function sliceBlock(source, startMarker, endMarker = '\n  };\n') {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `App.jsx 里找不到起始标记：${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.ok(end > start, `App.jsx 里找不到结束标记：${endMarker}`);
  return source.slice(start, end);
}

function countMatches(source, pattern) {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const matches = source.match(new RegExp(pattern.source, flags));
  return matches ? matches.length : 0;
}

test('两个既有入口都支持 origin: main | sidebar，主会话行为不变', () => {
  const source = readApp();
  assert.match(
    source,
    /import\s*\{[\s\S]*?AGENT_CHAT_ORIGINS[\s\S]*?\}\s*from\s+['"]\.\/state\/sessionMachine\.mjs['"]|const AGENT_CHAT_ORIGINS = Object\.freeze\(\{ MAIN: 'main', SIDEBAR: 'sidebar' \}\)/,
    'origin 取值必须是 main / sidebar 两种，且集中定义一次',
  );
  assert.match(
    source,
    /const handleAgentTurn = async \(utterance, \{[\s\S]{0,200}origin = AGENT_CHAT_ORIGINS\.MAIN/,
    'handleAgentTurn 必须新增默认 origin=main 的可选参数',
  );
  assert.match(
    source,
    /const handleTemplateReviseSubmit = async \(utterance, \{[\s\S]{0,200}origin = AGENT_CHAT_ORIGINS\.MAIN/,
    'handleTemplateReviseSubmit 必须新增默认 origin=main 的可选参数',
  );
  // 主输入框既有调用点保持不变：不带 origin 即为 main。
  assert.match(source, /handleAgentTurn\(text\);\s*\n\s*return;/, '主输入框 STORE_INFO 调用点不变');
  assert.match(
    source,
    /handleTemplateReviseSubmit\(text\);/,
    '主输入框 TEMPLATE_PICK 调用点不变（不带 origin）',
  );
});

test('侧栏一轮只追加一次用户消息：REQUEST_START 在各自函数体内唯一', () => {
  const source = readApp();
  const agentTurn = sliceBlock(source, 'const handleAgentTurn = async (utterance, {');
  const templateRevise = sliceBlock(source, 'const handleTemplateReviseSubmit = async (utterance, {');

  [['handleAgentTurn', agentTurn], ['handleTemplateReviseSubmit', templateRevise]].forEach(([name, body]) => {
    assert.equal(
      countMatches(body, /type:\s*'AGENT_CHAT_REQUEST_START'/),
      1,
      `${name} 里只能有一处追加用户消息的 REQUEST_START`,
    );
    assert.match(body, /if \(fromSidebar\) \{/, `${name} 的侧栏记账必须由 fromSidebar 分支控制`);
    assert.match(
      body,
      /AGENT_CHAT_RETRY_PREPARE[\s\S]{0,320}AGENT_CHAT_REQUEST_START/,
      `${name} 的重试只能走 RETRY_PREPARE（不重复追加用户消息）`,
    );
    assert.equal(
      countMatches(body, /type:\s*'AGENT_CHAT_SUCCESS'/),
      1,
      `${name} 成功时只写一条侧栏助手消息`,
    );
    assert.ok(
      countMatches(body, /type:\s*'AGENT_CHAT_FAILURE'/) >= 1,
      `${name} 失败时必须把侧栏会话置为失败态`,
    );
    // 侧栏草稿只在成功后清空（失败要保留原话，重试才有内容可重放）。
    assert.match(body, /AGENT_CHAT_SUCCESS[\s\S]{0,1200}AGENT_CHAT_DRAFT_SET/, `${name} 成功后清空侧栏草稿`);
    assert.match(body, /finally \{[\s\S]{0,200}agentChatBusy\.current = false;/, `${name} 必须在 finally 释放防重守卫`);
  });
});

test('侧栏入口按阶段路由，其余阶段只给本地指引', () => {
  const source = readApp();
  const submit = sliceBlock(source, 'const handleAgentChatSubmit = (value) => {');
  assert.match(
    submit,
    /buildAgentChatSubmitPlan\(\{\s*projectId,\s*phase,\s*hasProject:\s*Boolean\(projectId\)\s*\}\)/,
    '能否发送/本轮做什么必须复用 domain 的唯一口径',
  );
  assert.match(
    submit,
    /if \(!plan\.allowed\) \{[\s\S]{0,160}setNotice\(plan\.notice\);[\s\S]{0,40}return;/,
    '没有活动项目时本地拦截并提示，不发任何请求',
  );
  assert.match(
    submit,
    /plan\.actionKind === 'store-info'[\s\S]{0,120}handleAgentTurn\(text, \{ origin: AGENT_CHAT_ORIGINS\.SIDEBAR, images \}\)/,
    '门店资料阶段走既有 handleAgentTurn，并带上侧栏本轮附件',
  );
  assert.match(
    submit,
    /plan\.actionKind === 'template-revise'[\s\S]{0,200}handleTemplateReviseSubmit\(text, \{[\s\S]{0,120}origin: AGENT_CHAT_ORIGINS\.SIDEBAR[\s\S]{0,120}images: toAgentTurnImages\(images\)/,
    '模板展示阶段走既有 handleTemplateReviseSubmit，并把附件转成线上格式',
  );
  assert.match(submit, /appendAgentChatGuide\(text\);/, '其余阶段落成本地指引');
  // 侧栏发送入口只派发，不直接碰服务层。
  assert.doesNotMatch(
    submit,
    /fetch\(|requestAgentTurn\(|requestAgentRun\(|requestTemplateRevise\(|requestScreenReference\(/,
    '侧栏入口不能自己发请求：必须复用既有分派函数',
  );
});

test('本地指引不调用模型，也不伪造工具步骤', () => {
  const source = readApp();
  const guide = sliceBlock(source, 'const appendAgentChatGuide = (text, { retry = false } = {}) => {');
  assert.match(guide, /actionKind: 'guide'/, '指引消息的 actionKind 必须是 guide');
  assert.doesNotMatch(
    guide,
    /requestAgentTurn\(|requestAgentRun\(|requestTemplateRevise\(|fetch\(/,
    '本地指引不调用模型、不发请求',
  );
  assert.match(guide, /toolLabels: \[\]/, '本地指引没有工具步骤就不写步骤');
  assert.match(guide, /本轮没有调用模型/, '过程卡必须说明本轮没有调用模型');
  assert.match(source, /const agentChatCandidate = \(\(\) => \{/, '参考图重构摘要只从既有视图派生');
  assert.match(
    source,
    /document\.getElementById\('frontend-reconstruct-panel'\)/,
    '「查看候选」只跳既有候选面板，不在侧栏生成候选',
  );
});

test('防重：在途时忽略重复提交（状态 + 同步守卫）', () => {
  const source = readApp();
  const submit = sliceBlock(source, 'const handleAgentChatSubmit = (value) => {');
  assert.match(
    submit,
    /agentChatBusy\.current \|\| agentChatState\.status === CHAT_STATUS\.REQUESTING/,
    '同一帧连点与在途请求都要被拦住',
  );
  assert.match(source, /const agentChatBusy = useRef\(false\);/, '必须有同步 ref 守卫（state 更新晚一帧）');
  assert.match(
    source,
    /if \(!isValidChatDraft\(text\)\) \{[\s\S]{0,160}return;/,
    '空白与超 500 字必须在 App 层也被拦住（规则来自 domain）',
  );
  const retry = sliceBlock(source, 'const handleAgentChatRetry = () => {');
  assert.match(retry, /CHAT_STATUS\.FAILED/, '只有失败态才允许重试');
  assert.match(retry, /lastUtterance/, '重试重放上一轮原话');
});

test('防串：请求身份在发起时冻结，迟到响应交给 reducer 丢弃', () => {
  const source = readApp();
  [sliceBlock(source, 'const handleAgentTurn = async (utterance, {'), sliceBlock(source, 'const handleTemplateReviseSubmit = async (utterance, {')].forEach((body) => {
    assert.match(body, /const chatProjectId = state\.project\.activeId/, '必须冻结发起时的项目 id');
    assert.match(body, /const chatPhase = phase;/, '必须冻结发起时的阶段');
    assert.match(body, /const chatRequestId = createAgentChatRequestId\(\);/, '每轮必须有独立 requestId');
    // SUCCESS/FAILURE 都用冻结值回报，不能用「当前」项目（否则会串到新项目）。
    ['AGENT_CHAT_SUCCESS', 'AGENT_CHAT_FAILURE'].forEach((type) => {
      const dispatchAt = body.indexOf(`type: '${type}'`);
      assert.ok(dispatchAt > 0, `缺少 ${type}`);
      const tail = body.slice(dispatchAt, dispatchAt + 320);
      assert.match(tail, /projectId: chatProjectId/, `${type} 必须带冻结的项目 id`);
      assert.match(tail, /requestId: chatRequestId/, `${type} 必须带同一个 requestId`);
      assert.match(tail, /phase: chatPhase/, `${type} 必须带冻结的阶段`);
    });
  });
  // App 不另写一套「响应是否可接受」的规则（该判断在 reducer 里只有一份）。
  assert.doesNotMatch(
    source,
    /isChatResponseAcceptable\s*\(/,
    'isChatResponseAcceptable 只在 reducer 里调用，App 不要复制第二套判断',
  );
});

test('过程卡只用 lastRun 安全视图，trace 不进消息正文', () => {
  const source = readApp();
  const summary = sliceBlock(source, 'function buildAgentChatRunSummary({', '\n}\n');
  assert.match(summary, /normalizeChatRun\(\{/, '运行视图必须经 normalizeChatRun 白名单裁剪');
  const normalizeCall = summary.slice(summary.indexOf('normalizeChatRun({'));
  assert.doesNotMatch(normalizeCall, /trace:|degradation:|prompt|toolCalls/, 'trace/prompt 不得进入安全运行视图');
  assert.match(normalizeCall, /toolLabels,/, '只保留工具标签');
  assert.match(summary, /buildProcessView\(\{ trace, degradation, changeSummary: \[\], runId \}\)/, '复用既有 agentRunProcess 安全视图');
  // 消息正文只来自模型回复/本地文案，绝不拼接 trace。
  assert.doesNotMatch(source, /reply:[\s\S]{0,80}\.trace/, 'reply 不能拼 trace');
});

test('RightPanel 拿到 agentChat 视图模型，回调全部集中在这里', () => {
  const source = readApp();
  assert.match(source, /<RightPanel[\s\S]{0,160}agentChat=\{agentChatViewModel\}/, 'RightPanel 必须收到 agentChat 视图模型');
  const viewModel = sliceBlock(source, 'const agentChatViewModel = {', '\n  };\n');
  ['projectId', 'projectName', 'phase', 'phaseLabel', 'chat: agentChatState', 'candidate: agentChatCandidate'].forEach((key) => {
    assert.ok(viewModel.includes(`${key}`), `视图模型缺少字段：${key}`);
  });
  ['images: agentChatImages', 'imageKinds: agentChatImageKinds', 'imageError: agentChatImageError'].forEach((key) => {
    assert.ok(viewModel.includes(`${key}`), `视图模型缺少附件字段：${key}`);
  });
  ['onDraftChange', 'onSubmit', 'onRetry', 'onOpenCandidates', 'onAddImages', 'onRemoveImage'].forEach((key) => {
    assert.ok(viewModel.includes(`${key}:`), `视图模型缺少回调：${key}`);
  });
  assert.match(
    source,
    /selectAgentChatState/,
    '会话状态只能来自 sessionMachine 的唯一选择器',
  );
  assert.match(source, /onDraftChange: \(value\) => dispatch\(\{ type: 'AGENT_CHAT_DRAFT_SET', value \}\)/, '草稿改动回写会话切片');
});

test('项目级会话按项目持久化：整片交给 toDocument，消息变化触发保存', () => {
  const source = readApp();
  assert.match(
    source,
    /const doc = toDocument\(\s*\{ \.\.\.state, frontendCandidate: adoptionStateSlice\(frontendCandidateRecord\) \}/,
    'toDocument 必须收到整片 state（含 agentChat）',
  );
  assert.match(
    source,
    /state\.agentChat\?\.messages,/,
    '消息变化必须触发一次自动保存，重开项目后历史才能恢复',
  );
  assert.match(source, /fromDocument\(result\.doc/, '打开项目必须走 fromDocument 恢复会话');
});

test('侧栏发送口径与底层 handler 一致：不可执行时禁用 + 提示，不存在静默 no-op', () => {
  const source = readApp();
  const submit = sliceBlock(source, 'const handleAgentChatSubmit = (value) => {');
  // 单一真相源：可执行条件只在 resolveTemplateReviseContext 里判断一次。
  const context = sliceBlock(source, 'const resolveTemplateReviseContext = () => {');
  assert.match(context, /if \(!presentationState\.canRevise\)/, '必须覆盖「候选未就绪」这一条');
  assert.match(context, /presentationState\.status === 'revising'/, '必须覆盖「上一轮修订在途」这一条');
  assert.match(context, /else if \(!templateId \|\| !candidate\)/, '必须覆盖「没有选中候选」这一条');
  assert.match(context, /blockedReason = '候选模板还没准备好/, '原因文案必须如实说明候选未就绪');
  assert.match(context, /blockedReason = '上一轮模板修订还在进行中/, '原因文案必须如实说明「进行中」');
  assert.doesNotMatch(context, /全部成功|已完成/, '原因文案不得使用误导性措辞');
  assert.doesNotMatch(context, /requestAgentTurn\(|requestTemplateRevise\(|fetch\(/, '判断不可执行时不得调用任何服务');

  // App 用同一份判断算出侧栏提示原因，并写进视图模型（面板据此禁用发送）。
  assert.match(
    source,
    /const agentChatSendBlockedReason = \(\(\) => \{[\s\S]{0,400}resolveTemplateReviseContext\(\)\.blockedReason/,
    '侧栏可发送口径必须复用同一份判断',
  );
  assert.match(submit, /if \(agentChatSendBlockedReason\) \{[\s\S]{0,120}setNotice\(agentChatSendBlockedReason\);/, '提交时必须有明确提示');
  assert.match(
    source,
    /sendBlockedReason: agentChatSendBlockedReason/,
    '视图模型必须把原因传给 RightPanel→AgentSidebarPanel',
  );
  // handler 侧同样不再静默：旧的「canRevise 直接 return」已被原因判断取代。
  const revise = sliceBlock(source, 'const handleTemplateReviseSubmit = async (utterance, {');
  assert.doesNotMatch(revise, /if \(!presentationState\.canRevise\) return;/, '不得保留静默 return 路径');
  assert.match(
    revise,
    /if \(reviseContext\.blockedReason\) \{[\s\S]{0,80}if \(fromSidebar\) setNotice\(reviseContext\.blockedReason\);[\s\S]{0,20}return;/,
    'handler 的兜底守卫也必须给侧栏反馈，不静默吞输入',
  );
});

test('侧栏代码块内不出现第二套服务/存储调用', () => {
  const source = readApp();
  const start = source.indexOf('// ---- 右侧栏「Agent 对话」');
  const end = source.indexOf('// ---- P3：参考截图');
  assert.ok(start > 0 && end > start, '找不到侧栏代码块');
  const block = source.slice(start, end);
  assert.doesNotMatch(
    block,
    /fetch\(|localStorage|sessionStorage|requestAgentTurn\(|requestAgentRun\(|requestTemplateRevise\(|requestScreenReference\(|projectServiceRef/,
    '侧栏接线只派发 dispatch 与复用既有函数，不自己发请求、不另建存储',
  );
  assert.doesNotMatch(
    block,
    /本轮将补充\/修改门店资料|本轮将修改当前模板展示/,
    '轮次说明文案只留在 domain，App 不复制一份',
  );
});
