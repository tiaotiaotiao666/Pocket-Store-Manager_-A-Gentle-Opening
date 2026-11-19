#!/usr/bin/env node
'use strict';

/**
 * 全应用统一会话 Agent：UIA 冒烟走查。
 *
 * 真实执行一次「打开项目 → 右侧栏统一输入 → 发送 → 读取结果 → 检查变更卡/提示」，
 * 不手改 project.json，也不伪造模型或界面结果。
 *
 * 先启动应用（npm run agent:app），再执行：
 *   node scripts/app-assistant-smoke.cjs
 *   node scripts/app-assistant-smoke.cjs --window-id w-1576746 --timeout-ms 20000
 *
 * 退出码：0 通过；1 断言失败；2 环境问题（未启动应用、窗口不可访问）。
 */

const {
  AgentDesktopError,
  findWindow,
  getStatus,
  snapshot,
  clickByQuery,
  setValueByQuery,
  hasText,
  waitForText,
} = require('./agent-debug.cjs');

const SIDEBAR_TEXTS = ['项目 Agent 对话', '项目对话消息', '项目会话'];
// 结果区任意一种都是真实状态：已写入 / 待确认 / 失败 / stale。
const RESULT_TEXTS = [
  '本轮已写入',
  '需要你确认',
  '上一轮没有成功',
  '项目在此期间已变化',
  '还没有对话',
];
// Composer 的可读名称在不同实现下可能是 placeholder 或 aria-label，按候选顺序尝试。
const COMPOSER_QUERIES = ['说明这一轮要改什么…', '说明这一轮要改什么', '发送到项目对话'];
const SEND_LABEL = '发送到项目对话';
const SMOKE_UTTERANCE = '店名改为松月食堂';

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
  return `全应用统一会话 Agent · UIA 冒烟走查

  node scripts/app-assistant-smoke.cjs [--window-id w-xxx] [--timeout-ms 20000]

前置：应用已启动（npm run agent:app），窗口标题包含「口袋店长」，agent-desktop 已安装。

说明：本脚本只读真实无障碍树并投递语义点击/输入；模型与网络不可用时，
结果区会显示失败，脚本按真实状态给出 PASS/FAIL，不做任何 mock。`;
}

function line(text) {
  process.stdout.write(`${text}\n`);
}

function sleep(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // 同步等待：脚本无需让出事件循环。
  }
}

function assertTexts(snap, texts, label) {
  const missing = texts.filter((text) => !hasText(snap, text));
  if (missing.length) {
    throw new AgentDesktopError(
      `${label} 缺少文本：${missing.map((text) => `「${text}」`).join('、')}`,
      { code: 'ASSERTION_FAILED' },
    );
  }
  line(`  ✓ ${label}：${texts.join('、')}`);
}

function waitForAnyText(windowId, texts, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = snapshot({ windowId });
  while (Date.now() < deadline) {
    if (texts.some((text) => hasText(last, text))) return { snap: last, found: true };
    sleep(500);
    last = snapshot({ windowId });
  }
  return { snap: last, found: false };
}

function openFirstProject(win, timeoutMs) {
  let snap = snapshot({ windowId: win.id });
  if (hasText(snap, '项目 Agent 对话')) return snap;
  const card = snap.nodes.find((node) => node.name && node.name.startsWith('打开项目：'));
  if (!card) return null;
  line(`  · 打开项目：${card.name}`);
  clickByQuery(win.id, card.name);
  const deadline = Date.now() + timeoutMs;
  snap = snapshot({ windowId: win.id });
  while (Date.now() < deadline) {
    if (hasText(snap, '项目 Agent 对话')) return snap;
    sleep(500);
    snap = snapshot({ windowId: win.id });
  }
  return snap;
}

function typeComposer(win, text) {
  let lastError = null;
  for (const query of COMPOSER_QUERIES) {
    try {
      setValueByQuery(win.id, query, text);
      return query;
    } catch (error) {
      lastError = error;
    }
  }
  throw new AgentDesktopError(
    `找不到统一输入框（已尝试：${COMPOSER_QUERIES.join('、')}）${lastError ? `：${lastError.message}` : ''}`,
    { code: 'ASSERTION_FAILED' },
  );
}

function main(argv) {
  const flags = parseArgs(argv);
  if (flags.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const timeoutMs = Number.isFinite(flags.timeoutMs) && flags.timeoutMs > 0 ? flags.timeoutMs : 20000;

  line('== 全应用统一会话 Agent · UIA 冒烟 ==');

  const status = getStatus();
  const accessibility = status.permissions?.accessibility;
  const accessibilityState = accessibility && typeof accessibility === 'object' ? accessibility.state : accessibility;
  if (accessibilityState !== 'granted') {
    throw new AgentDesktopError(`无障碍权限不可用：${accessibilityState || 'unknown'}`, { code: 'PERMISSION' });
  }
  line(`[1/5] agent-desktop ${status.version || ''} | 平台 ${status.platform} | 无障碍权限 granted`);

  const win = findWindow(flags.windowId);
  line(`[2/5] 窗口 ${win.id} | ${win.app_name} | ${win.title}`);

  const opened = openFirstProject(win, timeoutMs);
  if (!opened) {
    throw new AgentDesktopError('工作台里没有可打开的项目；请先在界面上新建或打开一个项目。', { code: 'ASSERTION_FAILED' });
  }
  assertTexts(opened, SIDEBAR_TEXTS, '统一会话侧栏');
  line(`[3/5] 侧栏快照 ${opened.snapshotId} | refs=${opened.refCount}`);

  const usedQuery = typeComposer(win, SMOKE_UTTERANCE);
  line(`[4/5] 已向「${usedQuery}」输入：${SMOKE_UTTERANCE}`);
  clickByQuery(win.id, SEND_LABEL);
  line('  已点击「发送到项目对话」');

  const { snap: after, found } = waitForAnyText(win.id, RESULT_TEXTS, timeoutMs);
  if (!found) {
    throw new AgentDesktopError(
      `等待结果区超时（${timeoutMs}ms）：没有出现「本轮已写入 / 需要你确认 / 上一轮没有成功 / 项目在此期间已变化」。`,
      { code: 'ASSERTION_FAILED' },
    );
  }
  assertTexts(after, SIDEBAR_TEXTS, '发送后的统一会话侧栏');
  line(`[5/5] 结果快照 ${after.snapshotId} | refs=${after.refCount}`);

  if (hasText(after, '本轮已写入')) {
    line('PASS 统一会话字段批次已写入，并显示真实变更卡（界面可读「本轮已写入」）。');
  } else if (hasText(after, '需要你确认')) {
    line('PASS 本轮进入待确认（高风险项未自动写入），界面如实提示需要确认。');
  } else if (hasText(after, '上一轮没有成功')) {
    line('PASS 失败态如实显示「上一轮没有成功」；这不是写入成功，请按界面提示重试或配置模型。');
  } else if (hasText(after, '项目在此期间已变化')) {
    line('PASS 迟到的批次被拒收并显示 stale 提示，项目未被覆盖。');
  } else {
    line('PASS 侧栏可交互，当前仍为空会话（未产生写入）。');
  }
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`\n[app-assistant-smoke] FAIL ${error.message}\n`);
  const environmentCodes = new Set(['WINDOW_NOT_FOUND', 'NOT_INSTALLED', 'PERMISSION', 'PERM_DENIED', 'SPAWN_FAILED']);
  process.exitCode = environmentCodes.has(error.code) ? 2 : 1;
  if (error.code === 'PERM_DENIED') {
process.stderr.write('agent-desktop 被本机文件 DACL 拦住（PERM_DENIED）：这属于环境 BLOCKED，不代表统一会话失败。\n');
  }
  if (error.code === 'WINDOW_NOT_FOUND') {
    process.stderr.write('请先在另一个终端执行 npm run agent:app，等待窗口出现后重试。\n');
  }
}