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

test('侧栏入口统一走 app-assistant，任意阶段同一路径', () => {
  const source = readApp();
  const submit = sliceBlock(source, 'const handleAgentChatSubmit = (value) => {');
  assert.match(
    submit,
    /buildAgentChatSubmitPlan\(\{\s*projectId,\s*phase,\s*hasProject:\s*Boolean\(projectId\)\s*\}\)/,
    '能否发送必须复用 domain 的唯一口径',
  );
  assert.match(
    submit,
    /if \(!plan\.allowed\) \{[\s\S]{0,160}setNotice\(plan\.notice\);[\s\S]{0,40}return;/,
    '没有活动项目时本地拦截并提示，不发任何请求',
  );
  assert.match(submit, /dispatchAgentChatTurn\(text, images\);/, '统一入口先按附件用途分流');
  // 阶段不再决定路由：不允许残留按阶段分叉到旧入口。
  assert.doesNotMatch(
    submit,
    /plan\.actionKind === 'store-info'|plan\.actionKind === 'template-revise'|appendAgentChatGuide\(text\)/,
    '统一入口不得再按阶段分叉到旧 handler 或本地指引',
  );

  const turn = sliceBlock(source, 'const runAppAssistantTurn = async ({');
  assert.match(turn, /requestAppAssistant\(\{/, '统一入口必须调用 appAssistantService');
  assert.match(turn, /actionKind: 'app-assistant'/, '请求/消息口径必须是 app-assistant');
  assert.match(turn, /buildProposalApplyPlan\(proposal, frozenState\)/, '按桌面能力目录拆批');
  assert.match(turn, /type: 'APP_ASSISTANT_CHANGES_APPLY'/, '字段批次必须走统一 reducer');
  assert.match(turn, /pending: \{/, '高风险项必须登记为待确认，不自动写入');
  assert.match(turn, /contextRevision: frozenRevision/, '请求身份必须冻结内容版本');
  // 侧栏轮次仍只由 App 协调，不直接 fetch。
  assert.doesNotMatch(turn, /fetch\(/, '侧栏入口不能自己发 HTTP 请求');
});

test('统一入口拿到回应后一律清空输入框，只有请求异常才保留草稿', () => {
  const source = readApp();
  const turn = sliceBlock(source, 'const runAppAssistantTurn = async ({');
  assert.ok(!turn.includes('keepInput'), '不得再按 proposal 状态跳过清空输入框');
  assert.match(
    turn,
    /AGENT_CHAT_SUCCESS[\s\S]{0,2500}dispatch\(\{ type: 'AGENT_CHAT_DRAFT_SET', value: '' \}\)/,
    'proposal / needs-input / rejected 拿到回应后都要清空输入框',
  );
  assert.match(
    turn,
    /const keepAttachments = preserveAttachments[\s\S]{0,200}proposal\.status === 'needs-input'[\s\S]{0,120}proposal\.status === 'rejected'/,
    '追问/拒收时保留图片，方便用户补充说明后继续发送',
  );
  const catchBlock = turn.slice(turn.indexOf('} catch (error) {'));
  assert.ok(!catchBlock.includes("type: 'AGENT_CHAT_DRAFT_SET'"), '请求异常时保留草稿，重试才有内容可重放');
});

test('参考图使用资料写回后的 projectState 自动构建，不再以本地指引结束', () => {
  const source = readApp();
  const turn = sliceBlock(source, 'const runAppAssistantTurn = async ({');
  assert.match(turn, /projectState/, '统一会话必须返回同一 apply action 计算出的最新项目状态');
  assert.match(source, /resolveFrontendGenerationIntent\(\{[\s\S]{0,160}text,[\s\S]{0,160}images/, '参考图与文字必须先生成唯一自动请求意图');
  assert.match(source, /type:\s*'FRONTEND_AUTO_REQUEST'/, '自动链必须原子设置请求并清理上一未采用结果');
  assert.match(source, /prepareProjectPreview\(\{/, '分析后必须准备当前项目与 run 的预览数据');
  assert.match(source, /frontendService\.buildCandidate\(\{[\s\S]{0,900}\bplan,/, '候选 Plan 必须来自资料写回后的 projectState');
  assert.match(source, /frontendService\.verifyCandidate\(/, '构建完成后必须继续微信验证，不能只显示本地摘要');
  assert.match(source, /type:\s*'PHASE_GOTO'/, '自动链开始前必须切到可展示候选的项目阶段');
  assert.match(
    source,
    /document\.getElementById\('frontend-reconstruct-panel'\)/,
    '候选展示继续复用既有面板',
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
  // 空白且无附件必须被 App 层拦住，而且要给可见原因 —— 不允许静默 return 造成“点按钮没反应”。
  assert.match(
    submit,
    /if \(!isValidChatDraft\(text\) && !images\.length\) \{[\s\S]{0,200}setNotice\([\s\S]{0,80}return;/,
    '空白且无附件必须被 App 层拦住并给出可见原因；只发图片是允许的',
  );
  assert.doesNotMatch(
    submit,
    /if \(!isValidChatDraft\(text\) && !images\.length\)\s*return;/,
    '不允许静默吞掉空输入',
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

test('统一入口图片全阶段开放，候选生成忙碌时给出动态阻断原因', () => {
  const source = readApp();
  assert.doesNotMatch(source, /const agentChatSendBlockedReason = null;/, '忙碌原因不能固定为 null');
  assert.match(source, /const agentChatSendBlockedReason =/, 'App 必须统一计算当前生成链的忙碌原因');
  assert.match(source, /sendBlockedReason: agentChatSendBlockedReason/, '动态原因必须传给侧栏显示并禁用发送');
  const submit = sliceBlock(source, 'const handleAgentChatSubmit = (value) => {');
  assert.match(
    submit,
    /agentChatBusy\.current \|\| agentChatState\.status === CHAT_STATUS\.REQUESTING/,
    '提交路径必须用同步 ref 与请求状态直接拦截双击',
  );
  assert.match(source, /const agentChatImageKinds = \(\(\) => \{[\s\S]{0,200}return \['auto', 'menu', 'store', 'reference'\]/, '有项目即可带图片');
  // 旧 handler 的兜底守卫仍保留（只影响主输入框）。
  const revise = sliceBlock(source, 'const handleTemplateReviseSubmit = async (utterance, {');
  assert.match(revise, /if \(reviseContext\.blockedReason\) \{[\s\S]{0,80}if \(fromSidebar\) setNotice\(reviseContext\.blockedReason\);/, '旧 handler 兜底仍如实反馈');
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
