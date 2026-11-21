'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * T3 静态门禁：右栏「项目信息 / Agent 对话」双视图。
 *
 * 只读源码、不渲染 React——UIA 走查依赖的可见名称、默认视图、忙碌文案与安全口径
 * 一旦被改坏，这里先失败。组件的行为级断言见 T5 的端到端验收。
 */

const REPO = path.join(__dirname, '..');
const RIGHT_PANEL = path.join(REPO, 'src', 'components', 'layout', 'RightPanel.jsx');
const AGENT_PANEL = path.join(REPO, 'src', 'components', 'agent', 'AgentSidebarPanel.jsx');
const AGENT_PANEL_CSS = path.join(REPO, 'src', 'styles', 'agent-sidebar.css');
const PANEL_CSS = path.join(REPO, 'src', 'styles', 'panel.css');

function readSource(file) {
  return fs.readFileSync(file, 'utf8');
}

test('T3 RightPanel：两个标签文本固定、默认打开「Agent 对话」、项目信息仍是原 panelCards', () => {
  const source = readSource(RIGHT_PANEL);
  assert.match(source, /label: '项目信息'/, '缺少「项目信息」标签');
  assert.match(source, /label: 'Agent 对话'/, '缺少「Agent 对话」标签');
  assert.match(source, /AGENT: 'agent'/);
  assert.match(source, /initialView = VIEWS\.AGENT/, '默认视图必须是「Agent 对话」');
  assert.match(source, /role="tablist"/);
  assert.match(source, /aria-selected=\{view === tab\.id\}/);
  // 项目信息视图沿用原有摘要结构，不得回归成别的样子
  assert.match(source, /className="panel-cards"/);
  assert.match(source, /className="panel-card-title"/);
  assert.match(source, /const className = \['panel-card'/);
});

test('T3 RightPanel：同一时刻只渲染一个视图（避免同名可访问名称）', () => {
  const source = readSource(RIGHT_PANEL);
  // 双视图是三元表达式互斥渲染，不是同时挂载再隐藏
  assert.match(source, /view === VIEWS\.AGENT \?/);
  assert.ok(!/hidden=|visibility: hidden/.test(source));
});

test('T3 AgentSidebarPanel：无障碍锚点、忙态文案与消息列表名称', () => {
  const source = readSource(AGENT_PANEL);
  assert.match(source, /role="region" aria-label="项目 Agent 对话"/, '面板必须是 region + aria-label');
  assert.match(source, /role="log"/, '消息列表必须是 log');
  assert.match(source, /aria-label="项目对话消息"/, '消息列表需要可读名称');
  assert.ok(source.includes('正在等待模型与工具结果'), '忙碌态文案必须固定');
  assert.match(source, /role="status"/);
  assert.match(source, /aria-label="跳到最新消息"/, '纯图标按钮必须有无歧义的 aria-label');
  assert.match(source, /id="project-agent-sidebar"/);
  assert.match(source, /id="project-agent-messages"/);
  assert.match(source, /id="project-agent-error"/);
});

test('T3 AgentSidebarPanel：不直连服务、不发请求、不 dispatch、不持有会话状态', () => {
  const source = readSource(AGENT_PANEL);
  assert.ok(!/\bfetch\s*\(/.test(source), '组件内不得发 fetch');
  assert.ok(!/\bdispatch\s*\(/.test(source), '组件内不得 dispatch');
  assert.ok(!/from '[^']*services\//.test(source), '组件内不得 import service');
  assert.ok(!/\blocalStorage\b|\bsessionStorage\b/.test(source), '组件内不得读写本地存储');
  assert.ok(!/useReducer|useState/.test(source), '会话状态只能来自 App 传入的视图模型');
});

test('T3 AgentSidebarPanel：复用 ChatStream 的 ProcessSummary 与 chat/Composer', () => {
  const source = readSource(AGENT_PANEL);
  assert.match(source, /import Composer from '\.\.\/chat\/Composer\.jsx'/);
  assert.match(source, /import \{ ProcessSummary \} from '\.\.\/chat\/ChatStream\.jsx'/);
  assert.match(source, /<ProcessSummary process=\{/, '过程卡必须复用 ProcessSummary');
});

test('T3 AgentSidebarPanel：partial 显示「部分完成」，没有真实 trace 不造工具步骤', () => {
  const source = readSource(AGENT_PANEL);
  assert.match(source, /partial: '部分完成'/, 'partial 必须显示「部分完成」');
  assert.ok(!/title: '全部成功'/.test(source), '不得把 partial 说成全部成功');
  assert.ok(source.includes('只完成了一部分'), '必须显式声明 partial 不等于全部成功');
  // 步骤只由真实 toolLabels 生成：没有标签时 steps 为空，ProcessSummary 不渲染步骤列表
  assert.match(source, /const steps = toolLabels\.map/);
  assert.match(source, /Array\.isArray\(run\.toolLabels\)/, '工具标签必须来自领域层安全视图');
});

test('T3 AgentSidebarPanel：本轮附件区只在允许的阶段出现，且支持拖拽落图', () => {
  const source = readSource(AGENT_PANEL);
  assert.match(source, /import AgentChatAttachments from '\.\/AgentChatAttachments\.jsx'/, '侧栏必须复用受控附件组件');
  assert.match(source, /const attachmentsEnabled = imageKindList\.length > 0/, '附件入口由 App 传的阶段能力决定');
  assert.match(source, /<AgentChatAttachments[\s\S]{0,400}kinds=\{imageKindList\}/, '附件组件只能带 App 允许的图片用途');
  const attachments = readSource(path.join(__dirname, '..', 'src', 'components', 'agent', 'AgentChatAttachments.jsx'));
  assert.match(attachments, /onDrop=\{\(event\) => \{[\s\S]{0,200}ingestFiles\(event\.dataTransfer\?\.files\)/, '拖拽图片必须直接进入同一套压缩/校验链路');
  assert.match(attachments, /prepareImageFile\(file, \{ kind: COMPRESS_KIND\[activeKind\] \|\| 'menu' \}\)/, '附件压缩必须复用既有 prepareImageFile，且只传压缩标签');
  assert.match(attachments, /drafts\.push\(\{ \.\.\.draft, kind: activeKind \}\)/, '业务用途必须在 draft 上回写，不能让参考图/自动判断被压缩层拒掉');
  assert.ok(!/localStorage|sessionStorage|project\.json/.test(attachments), '附件不得落盘');
  assert.ok(!/appendChatMessage|createChatMessage/.test(attachments), '附件不得写消息正文');
});

test('T3 AgentSidebarPanel：重构意图展示候选与自动进度，不另放图片上传入口', () => {
  const source = readSource(AGENT_PANEL);
  assert.ok(source.includes('查看候选'));
  assert.match(source, /candidate/, '候选与自动执行状态必须由 App 视图模型传入');
  assert.ok(!source.includes('侧栏只显示摘要'), '参考图发送后必须展示自动构建与验证进度，不能停留在旧摘要口径');
  assert.ok(!/type="file"|type='file'/.test(source), '侧栏不得出现图片上传控件');
});

test('T3 AgentSidebarPanel：发送校验复用 domain/agentSidebar.mjs', () => {
  const source = readSource(AGENT_PANEL);
  assert.match(source, /from '\.\.\/\.\.\/domain\/agentSidebar\.mjs'/);
  assert.match(source, /isValidChatDraft/);
  assert.match(source, /CHAT_DRAFT_MAX_CHARS/);
  assert.match(source, /buildAgentChatSubmitPlan/);
  assert.match(source, /maxChars=\{CHAT_DRAFT_MAX_CHARS\}/);
});

test('T8 AgentSidebarPanel：阶段动作不可执行时禁用发送并把原因显示出来', () => {
  const source = readSource(AGENT_PANEL);
  // 原因由 App 算好传入（单一真相源），组件只负责禁用 + 显示。
  assert.match(source, /sendBlockedReason = null/, '必须接收 App 算好的不可执行原因');
  assert.match(source, /const blockedReason = typeof sendBlockedReason === 'string'/, '原因必须先归一');
  assert.match(
    source,
    /const submitBlocked = busy \|\| imageBusy \|\| plan\.allowed === false \|\| !draftValid \|\| Boolean\(blockedReason\)/,
    '不可执行或附件仍在压缩时必须禁用发送按钮',
  );
  assert.match(
    source,
    /hint=\{busy\s*\?[\s\S]{0,200}:\s*\(imageBusy\s*\?[\s\S]{0,200}:\s*\(plan\.allowed === false\s*\? plan\.notice\s*:\s*\(blockedReason\s*\|\|/,
    '输入框提示必须优先显示忙态与不可执行原因，不能仍显示 Enter 发送',
  );
  assert.match(source, /Enter 发送 · Shift\+Enter 换行/, '没有原因与附件时仍提示正常发送快捷键',
  );
  // 组件不得自己判断业务可执行条件（否则又变成第二套口径）。
  assert.ok(!/canRevise/.test(source), '组件不得直接读 canRevise 等业务状态');
  assert.ok(!/presentationState/.test(source), '组件不得直接读展示补丁状态');
});

test('T8 AgentSidebarPanel：消息列表不再渲染不可达的 failed 分支', () => {
  const source = readSource(AGENT_PANEL);
  // 会话里只有「用户原话」与「助手回复」两种已落地消息；失败态由 lastError + 重试表达。
  assert.ok(!source.includes("message.status === 'failed'"), '死分支已删除，不得保留');
  assert.ok(!source.includes('这一条没有落地'), '死分支文案已删除，不得保留');
  assert.match(source, /失败不会写进消息列表/, '必须用注释说明失败不走消息列表');
  assert.match(source, /className=\{\['agent-sidebar-msg', `is-\$\{item\.message\.role\}`\]/, '消息 class 只由角色决定');
});

test('T3 样式：新增 agent-sidebar.css 并在 panel.css 追加双视图样式', () => {
  const agentCss = readSource(AGENT_PANEL_CSS);
  for (const token of ['.agent-sidebar', '.agent-sidebar-log', '.agent-sidebar-busy', '.agent-sidebar-error', '.agent-sidebar-composer']) {
    assert.ok(agentCss.includes(token), `agent-sidebar.css 缺少 ${token}`);
  }
  const panelCss = readSource(PANEL_CSS);
  for (const token of ['.panel-dual', '.panel-tabs', '.panel-tab.is-active', '.panel-view-agent']) {
    assert.ok(panelCss.includes(token), `panel.css 缺少 ${token}`);
  }
  // 跟随既有变量：不引入硬编码主色
  assert.ok(!/#6d5efc|#5a48f0/i.test(agentCss), '不得硬编码主题色，必须用 CSS 变量');
});
