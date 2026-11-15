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
  line(`[1/6] agent-desktop ${status.version || ''} | 平台 ${status.platform} | 无障碍权限 granted`);

  record('window');
  const win = findWindow(flags.windowId);
  line(`[2/6] 窗口 ${win.id} | ${win.app_name} | ${win.title} | accessible=${win.accessible}`);

  record('snapshot');
  let snap = snapshot({ windowId: win.id, timeoutMs: flags.timeoutMs || undefined });
  line(`[3/6] 初始快照 ${snap.snapshotId} | refs=${snap.refCount} | ${elapsedSinceLast()}ms`);

  // 允许从设置页开始：先回到项目工作台，保证走查可重复。
  if (!hasText(snap, '我的项目') && hasText(snap, '运行环境与自检')) {
    line('  检测到当前停在设置页，先点击「返回项目」。');
    clickByQuery(win.id, '返回项目');
    snap = waitForText(win.id, '我的项目', { timeoutMs: waitTimeoutMs });
  }

  assertSnap(snap, WORKBENCH_TEXTS, '项目工作台');
  const card = snap.nodes.find((node) => node.name.startsWith('打开项目：'));
  if (card) line(`  · 项目卡片：${card.name}`);

  record('open-settings');
  const { target } = clickByQuery(win.id, '设置与自检');
  line(`[4/6] 点击「设置与自检」→ ${target.ref}（语义 Click 已投递）`);

  record('settings-verify');
  const settings = waitForText(win.id, '运行环境与自检', { timeoutMs: waitTimeoutMs });
  line(`[5/6] 复查设置页 ${settings.snapshotId} | refs=${settings.refCount} | ${elapsedSinceLast()}ms`);
  assertSnap(settings, SETTINGS_TEXTS, '设置页');

  record('back');
  clickByQuery(win.id, '返回项目');
  const back = waitForText(win.id, '我的项目', { timeoutMs: waitTimeoutMs });
  assertSnap(back, WORKBENCH_TEXTS, '返回后的项目工作台');

  line(`[6/6] 最终快照 ${back.snapshotId} | refs=${back.refCount} | ${elapsedSinceLast()}ms`);
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
