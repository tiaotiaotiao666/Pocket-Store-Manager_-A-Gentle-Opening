#!/usr/bin/env node
'use strict';

/**
 * 智能开店：agent-desktop 无障碍冒烟走查。
 *
 * 真实执行一次「快照 → 点击 → 重新快照验证 → 返回」闭环：
 *   项目工作台 → 设置与自检 → 返回项目工作台
 *
 * 先启动应用（推荐 npm run agent:app），再执行：
 *   node scripts/agent-smoke.cjs
 *   node scripts/agent-smoke.cjs --window-id w-1576746
 *
 * 退出码：0 通过；1 断言失败；2 环境问题（未启动应用、窗口不可访问）。
 */

const {
  AgentDesktopError,
  findWindow,
  getStatus,
  snapshot,
  clickByQuery,
  waitForText,
  hasText,
} = require('./agent-debug.cjs');

const WORKBENCH_TEXTS = ['我的项目', '新建项目：创建空白门店项目', '搜索项目'];
const SETTINGS_TEXTS = ['运行环境与自检', '返回项目', '重新自检', '保存设置'];
// P4：候选前端主链只在「开店资料」阶段出现；控件必须有唯一可读名称（UIA name）。
const FRONTEND_PANEL_TEXTS = [
  '门店基本资料',
  '菜品资料与菜单图片',
  '门店环境图片',
  '参考小程序截图',
  '识别菜品并回写',
  '添加环境图片',
  '上传截图',
  '识别并生成候选方案',
  '补充要求',
  '目标页面：首页',
];
const TIMING = [];

function parseArgs(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--window-id') flags.windowId = argv[(index += 1)];
    else if (arg === '--timeout-ms') flags.timeoutMs = Number(argv[(index += 1)]);
    else if (arg === '--help' || arg === '-h') flags.help = true;
  }
  return flags;
}

function usage() {
  return `智能开店 · 无障碍调试冒烟走查

  node scripts/agent-smoke.cjs [--window-id w-xxx] [--timeout-ms 15000]

前置：应用已启动（npm run agent:app），窗口标题包含「智能开店」，且 agent-desktop 已安装。`;
}

function record(label) {
  TIMING.push({ label, at: Date.now() });
}

function elapsedSinceLast() {
  if (TIMING.length < 2) return 0;
  return TIMING[TIMING.length - 1].at - TIMING[TIMING.length - 2].at;
}

function line(label, detail = '') {
  process.stdout.write(`${label}${detail ? ` ${detail}` : ''}\n`);
}

function assertSnap(snap, texts, label) {
  const missing = texts.filter((text) => !hasText(snap, text));
  if (missing.length) {
    throw new AgentDesktopError(
      `${label} 缺少文本：${missing.map((text) => `「${text}」`).join('、')}`,
      { code: 'ASSERTION_FAILED' },
    );
  }
  line(`  ✓ ${label}：${texts.join('、')}`);
}

function sleep(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // 同步等待：agent-smoke 是脚本，不需要事件循环让位。
  }
}

function waitForWorkbench(windowId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = snapshot({ windowId });
  let navigated = false;
  while (Date.now() < deadline) {
    if (hasText(last, '搜索项目')) return last;
    if (!navigated && hasText(last, '我的项目：打开工作台')) {
      clickByQuery(windowId, '我的项目：打开工作台');
      navigated = true;
    }
    sleep(400);
    last = snapshot({ windowId });
  }
  return last;
}

/** 轮询到面板出现；超时返回 null（不抛错，方便如实标 NOT_VISIBLE）。 */
function waitForFrontendPanel(windowId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = snapshot({ windowId });
  while (Date.now() < deadline) {
    if (hasText(last, '识别并生成候选方案')) return last;
    sleep(400);
    last = snapshot({ windowId });
  }
  return hasText(last, '识别并生成候选方案') ? last : null;
}

/**
 * P4 UIA 断言：候选前端主链的控件必须能被无障碍树读到。
 *
 * 该面板挂在「开店资料」阶段。工作台里如果有项目卡片，就打开第一个项目再看；
 * 看完（或不在该阶段）用侧边栏「我的项目：打开工作台」退回，保证走查可重复。
 * 返回 `{visible, reason}`：不在该阶段时如实标 NOT_VISIBLE，不伪造通过。
 */
function assertFrontendPanel(win, waitTimeoutMs) {
  let snap = snapshot({ windowId: win.id });
  let openedProject = false;
  if (!hasText(snap, '识别并生成候选方案')) {
    const card = snap.nodes.find((node) => node.name && node.name.startsWith('打开项目：'));
    if (!card) return { visible: false, reason: '工作台里没有可打开的项目' };
    clickByQuery(win.id, card.name);
    openedProject = true;
    // 「我的项目」在侧边栏始终存在，不能拿它当出现信号：只等面板本身。
    snap = waitForFrontendPanel(win.id, Math.min(waitTimeoutMs, 8000)) || snapshot({ windowId: win.id });
  }

  let visible = false;
  let reason = '';
  if (hasText(snap, '识别并生成候选方案')) {
    assertSnap(snap, FRONTEND_PANEL_TEXTS, '候选前端主链控件');
    visible = true;
  } else {
    reason = '打开的项目不在「开店资料」阶段';
  }

  // 回到工作台：侧边栏按钮的可读名称固定，不依赖项目标题。
  if (openedProject) {
    try {
      clickByQuery(win.id, '我的项目：打开工作台');
      waitForWorkbench(win.id, waitTimeoutMs);
    } catch (error) {
      // 返回失败不掩盖主断言：上面已经给出真实结论。
      line(`  ! 从项目页返回工作台失败：${error.message}`);
    }
  }
  return { visible, reason };
}

function main(argv) {
  const flags = parseArgs(argv);
  if (flags.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const waitTimeoutMs = flags.timeoutMs || 15000;

  line('== 智能开店 · 无障碍调试冒烟 ==');

  record('status');
  const status = getStatus();
  const accessibility = status.permissions?.accessibility;
  const accessibilityState = accessibility && typeof accessibility === 'object' ? accessibility.state : accessibility;
  if (accessibilityState !== 'granted') {
    throw new AgentDesktopError(`无障碍权限不可用：${accessibilityState || 'unknown'}`, { code: 'PERMISSION' });
  }
  line(`[1/7] agent-desktop ${status.version || ''} | 平台 ${status.platform} | 无障碍权限 granted`);

  record('window');
  const win = findWindow(flags.windowId);
  line(`[2/7] 窗口 ${win.id} | ${win.app_name} | ${win.title} | accessible=${win.accessible}`);

  record('snapshot');
  let snap = snapshot({ windowId: win.id, timeoutMs: flags.timeoutMs || undefined });
  line(`[3/7] 初始快照 ${snap.snapshotId} | refs=${snap.refCount} | ${elapsedSinceLast()}ms`);

  if (hasText(snap, '运行环境与自检')) {
    line('  检测到当前停在设置页，先点击「返回项目」。');
    clickByQuery(win.id, '返回项目');
  }
  snap = waitForWorkbench(win.id, waitTimeoutMs);

  assertSnap(snap, WORKBENCH_TEXTS, '项目工作台');
  const card = snap.nodes.find((node) => node.name.startsWith('打开项目：'));
  if (card) line(`  · 项目卡片：${card.name}`);

  record('open-settings');
  const { target } = clickByQuery(win.id, '设置与自检');
  line(`[4/7] 点击「设置与自检」→ ${target.ref}（语义 Click 已投递）`);

  record('settings-verify');
  const settings = waitForText(win.id, '运行环境与自检', { timeoutMs: waitTimeoutMs });
  line(`[5/7] 复查设置页 ${settings.snapshotId} | refs=${settings.refCount} | ${elapsedSinceLast()}ms`);
  assertSnap(settings, SETTINGS_TEXTS, '设置页');

  record('back');
  clickByQuery(win.id, '返回项目');
  const back = waitForWorkbench(win.id, waitTimeoutMs);
  assertSnap(back, WORKBENCH_TEXTS, '返回后的项目工作台');

  record('frontend-panel');
  line(`[6/7] 最终快照 ${back.snapshotId} | refs=${back.refCount} | ${elapsedSinceLast()}ms`);
  const frontend = assertFrontendPanel(win, waitTimeoutMs);
  if (frontend.visible) {
    line('[7/7] 四分区与候选前端主链控件已通过 UIA 断言（识别/补充要求/目标页面）');
  } else {
    line(`[7/7] 候选前端主链 NOT_VISIBLE：${frontend.reason}（未在「开店资料」阶段，未伪造断言）`);
  }

  line('');
  line('PASS 无障碍调试闭环通过：snapshot → click → snapshot 验证 → 返回');
  line('提示：设置页曾显示「返回项目」按钮，说明该页由真实的 React 状态切换产生，不是静态占位。');
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`\n[agent-smoke] FAIL ${error.message}\n`);
  const environmentCodes = new Set(['WINDOW_NOT_FOUND', 'NOT_INSTALLED', 'PERMISSION', 'SPAWN_FAILED']);
  process.exitCode = environmentCodes.has(error.code) ? 2 : 1;
  if (error.code === 'WINDOW_NOT_FOUND') {
    process.stderr.write('请先在另一个终端执行 npm run agent:app，等待窗口出现后重试。\n');
  }
}
