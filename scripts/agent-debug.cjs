#!/usr/bin/env node
'use strict';

/**
 * 智能开店：agent-desktop 无障碍调试助手。
 *
 * 通过操作系统无障碍树（Windows UI Automation）读取 Electron 窗口，
 * 用 @snapshot:ref 定位控件并执行点击/输入，再重新快照验证结果。
 * 不截图、不做像素匹配，也不抢占鼠标和焦点（默认 headless 语义投递）。
 *
 * 用法：
 *   node scripts/agent-debug.cjs status
 *   node scripts/agent-debug.cjs windows
 *   node scripts/agent-debug.cjs snapshot [--json | --out file.json] [--all]
 *   node scripts/agent-debug.cjs find "设置"
 *   node scripts/agent-debug.cjs click "设置与自检"
 *   node scripts/agent-debug.cjs type "搜索项目" "源麦甜"
 *   node scripts/agent-debug.cjs verify "我的项目" "新建项目：创建空白门店项目"
 *
 * 退出码：0 成功；1 断言/用法失败；2 环境问题（未安装、找不到窗口）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const LAUNCHER = path.join(ROOT, 'node_modules', 'agent-desktop', 'bin', 'agent-desktop');
const WINDOW_TITLE_HINT = process.env.AGENT_DESKTOP_WINDOW_TITLE || '智能开店';
const DEFAULT_SNAPSHOT_TIMEOUT_MS = Number(process.env.AGENT_DESKTOP_TIMEOUT_MS || 25000);
const ACTION_TIMEOUT_MS = Number(process.env.AGENT_DESKTOP_ACTION_TIMEOUT_MS || 8000);
const MAX_TREE_NODES = 4000;

class AgentDesktopError extends Error {
  constructor(message, { code = '', disposition = '', hint = '' } = {}) {
    super(message);
    this.name = 'AgentDesktopError';
    this.code = code;
    this.disposition = disposition;
    this.hint = hint;
  }
}

function ensureInstalled() {
  if (fs.existsSync(LAUNCHER)) return;
  throw new AgentDesktopError(
    `没有找到 agent-desktop：${path.relative(ROOT, LAUNCHER)}。请先执行 npm install。`,
    { code: 'NOT_INSTALLED' },
  );
}

function runRaw(args, { timeoutMs = 150000 } = {}) {
  ensureInstalled();
  const result = spawnSync(process.execPath, [LAUNCHER, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) {
    throw new AgentDesktopError(`无法启动 agent-desktop：${result.error.message}`, { code: 'SPAWN_FAILED' });
  }
  return result;
}

function parseEnvelope(stdout) {
  const text = (stdout || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const lastLine = text.split(/\r?\n/).filter(Boolean).pop();
    try {
      return JSON.parse(lastLine);
    } catch {
      return null;
    }
  }
}

function call(command, args = [], options = {}) {
  const result = runRaw([command, ...args], options);
  const envelope = parseEnvelope(result.stdout);
  if (!envelope) {
    const detail = (result.stderr || result.stdout || '(无输出)').trim().slice(0, 400);
    throw new AgentDesktopError(`agent-desktop ${command} 没有返回 JSON：${detail}`, { code: 'BAD_OUTPUT' });
  }
  if (!envelope.ok) {
    const error = envelope.error || {};
    throw new AgentDesktopError(
      `${command} 失败：${error.code || 'UNKNOWN'} ${error.message || ''}`.trim(),
      {
        code: error.code || 'CLI_ERROR',
        disposition: error.disposition?.retry || '',
        hint: error.suggestion || error.recovery?.strategy || '',
      },
    );
  }
  return envelope.data;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function flattenTree(tree) {
  const nodes = [];
  const visit = (node, depth) => {
    if (!node || nodes.length >= MAX_TREE_NODES) return;
    const entry = {
      role: node.role || '',
      subrole: node.subrole || '',
      name: node.name || '',
      description: node.description || '',
      value: node.value || '',
      ref: node.ref_id || '',
      actions: Array.isArray(node.available_actions) ? node.available_actions : [],
      states: Array.isArray(node.states) ? node.states : [],
      automationId: node.native_id?.kind === 'automation_id' ? node.native_id.value : '',
      depth,
    };
    if (entry.ref || entry.name || entry.automationId) nodes.push(entry);
    for (const child of node.children || []) visit(child, depth + 1);
  };
  visit(tree, 0);
  return nodes;
}

function getStatus() {
  return call('status', []);
}

function listWindows() {
  const data = call('list-windows', []);
  return Array.isArray(data) ? data : [];
}

function findWindow(explicitWindowId) {
  const windows = listWindows();
  if (explicitWindowId) {
    const exact = windows.find((win) => win.id === explicitWindowId);
    if (!exact) {
      throw new AgentDesktopError(`没有找到窗口 ${explicitWindowId}。当前窗口：\n${formatWindows(windows)}`, {
        code: 'WINDOW_NOT_FOUND',
      });
    }
    return exact;
  }
  const candidates = windows.filter((win) => (win.title || '').includes(WINDOW_TITLE_HINT) && win.accessible !== false);
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    const focused = candidates.find((win) => win.is_focused);
    return focused || candidates[0];
  }
  throw new AgentDesktopError(
    `没有找到标题包含「${WINDOW_TITLE_HINT}」的可见窗口。请先启动 npm run agent:app，然后用 windows 命令确认。`,
    { code: 'WINDOW_NOT_FOUND' },
  );
}

function snapshot({ windowId, timeoutMs = DEFAULT_SNAPSHOT_TIMEOUT_MS, interactiveOnly = true } = {}) {
  const resolvedWindowId = windowId || findWindow().id;
  const args = ['--window-id', resolvedWindowId];
  if (interactiveOnly) args.push('-i');
  args.push('--compact', '--timeout-ms', String(timeoutMs));
  const data = call('snapshot', args, { timeoutMs: timeoutMs + 30000 });
  return {
    windowId: data.window?.id || resolvedWindowId,
    windowTitle: data.window?.title || '',
    app: data.app || '',
    snapshotId: data.snapshot_id,
    refCount: data.ref_count,
    nodes: flattenTree(data.tree),
    tree: data.tree,
  };
}

function matchesAction(node, action) {
  return !action || node.actions.includes(action);
}

function resolveTarget(snap, query, { action = 'Click' } = {}) {
  if (!query || !query.trim()) {
    throw new AgentDesktopError('缺少要定位的元素名称或 @ref。', { code: 'USAGE' });
  }
  if (query.startsWith('@')) return { ref: query, node: null };

  const usable = snap.nodes.filter((node) => node.name && matchesAction(node, action));
  const exact = usable.filter((node) => node.name === query);
  if (exact.length === 1) return { ref: exact[0].ref, node: exact[0] };
  if (exact.length > 1) {
    throw new AgentDesktopError(
      `「${query}」匹配到 ${exact.length} 个元素，请改用更完整的名称或直接传 @ref：\n${formatNodes(exact)}`,
      { code: 'AMBIGUOUS_TARGET' },
    );
  }

  const lower = query.toLowerCase();
  const partial = usable.filter((node) => node.name.toLowerCase().includes(lower));
  if (partial.length === 1) return { ref: partial[0].ref, node: partial[0] };
  if (partial.length > 1) {
    throw new AgentDesktopError(
      `「${query}」模糊匹配到 ${partial.length} 个元素，请改用更完整的名称或直接传 @ref：\n${formatNodes(partial)}`,
      { code: 'AMBIGUOUS_TARGET' },
    );
  }

  const sample = usable.slice(0, 30);
  throw new AgentDesktopError(
    `快照里没有可${action === 'SetValue' ? '输入' : '点击'}的「${query}」。当前可操作元素：\n${formatNodes(sample)}`,
    { code: 'TARGET_NOT_FOUND' },
  );
}

function clickByQuery(windowId, query) {
  const snap = snapshot({ windowId });
  const target = resolveTarget(snap, query);
  const data = call('click', [target.ref, '--timeout-ms', String(ACTION_TIMEOUT_MS)]);
  return { snap, target, data };
}

function setValueByQuery(windowId, query, value) {
  const snap = snapshot({ windowId });
  const target = resolveTarget(snap, query, { action: 'SetValue' });
  const data = call('set-value', [target.ref, value, '--timeout-ms', String(ACTION_TIMEOUT_MS)]);
  return { snap, target, data };
}

function hasText(snap, text) {
  const lower = String(text).toLowerCase();
  return snap.nodes.some((node) => node.name && node.name.toLowerCase().includes(lower));
}

function waitForText(windowId, text, { timeoutMs = 15000, intervalMs = 400 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = snapshot({ windowId });
    if (hasText(last, text)) return last;
    sleep(intervalMs);
  }
  const sample = last ? formatNodes(last.nodes.filter((node) => node.name).slice(0, 20)) : '(没有快照)';
  throw new AgentDesktopError(`等待文本「${text}」超时（${timeoutMs}ms）。最后快照：\n${sample}`, {
    code: 'WAIT_TIMEOUT',
  });
}

function assertTexts(snap, texts) {
  const missing = texts.filter((text) => !hasText(snap, text));
  return { ok: missing.length === 0, missing };
}

function truncate(text, width) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (value.length <= width) return value;
  return `${value.slice(0, width - 1)}…`;
}

function formatNodes(nodes, { limit = 60 } = {}) {
  const lines = nodes.slice(0, limit).map((node) => {
    const role = truncate(node.role || '-', 12).padEnd(12, ' ');
    const name = truncate(node.name || node.automationId || '-', 58).padEnd(58, ' ');
    return `${role} | ${name} | ${node.ref || '-'}`;
  });
  if (nodes.length > limit) lines.push(`… 另有 ${nodes.length - limit} 个节点`);
  return lines.join('\n');
}

function formatWindows(windows) {
  return windows
    .map((win) => `${win.id} | ${win.app_name} | ${win.title}${win.is_focused ? ' | focused' : ''}`)
    .join('\n');
}

function stamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function parseArgs(argv) {
  const positional = [];
  const flags = { json: false, all: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') flags.json = true;
    else if (arg === '--all') flags.all = true;
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg === '--window-id') flags.windowId = argv[(index += 1)];
    else if (arg === '--out') flags.out = argv[(index += 1)];
    else if (arg === '--limit') flags.limit = Number(argv[(index += 1)]);
    else if (arg === '--timeout-ms') flags.timeoutMs = Number(argv[(index += 1)]);
    else positional.push(arg);
  }
  return { positional, flags };
}

function usage() {
  return `智能开店 · agent-desktop 无障碍调试助手

  node scripts/agent-debug.cjs status                         检查 UI Automation 权限与平台能力
  node scripts/agent-debug.cjs windows                        列出可见窗口（含窗口 id）
  node scripts/agent-debug.cjs snapshot [--all] [--json]      打印无障碍树（默认仅交互元素）
  node scripts/agent-debug.cjs find <文本>                    按名称搜索元素
  node scripts/agent-debug.cjs click <名称|@ref>              按名称定位并点击
  node scripts/agent-debug.cjs type <名称> [文本]             按名称定位并写入文本（省略文本表示清空）
  node scripts/agent-debug.cjs verify <文本...>               断言文本全部存在，缺失则退出码 1

通用参数：--window-id w-xxx 指定窗口；--timeout-ms 快照超时（默认 25000）
npm scripts：agent:status / agent:snapshot / agent:find / agent:click / agent:type / agent:verify / agent:smoke`;
}

function main(argv) {
  const { positional, flags } = parseArgs(argv);
  const command = positional[0];

  if (!command || flags.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  const windowId = flags.windowId;

  if (command === 'status') {
    const data = getStatus();
    const permissionState = (value) => (value && typeof value === 'object' ? value.state || JSON.stringify(value) : String(value || '-'));
    const permissions = data.permissions || {};
    process.stdout.write(`平台：${data.platform || '-'}\n`);
    process.stdout.write(`agent-desktop：${data.version || '-'}\n`);
    process.stdout.write(`无障碍权限：${permissionState(permissions.accessibility)}\n`);
    process.stdout.write(`自动化权限：${permissionState(permissions.automation)}\n`);
    process.stdout.write(`屏幕录制：${permissionState(permissions.screen_recording)}\n`);
    process.stdout.write(`支持的 surface：${(data.supported_surfaces || []).join(', ')}\n`);
    process.stdout.write(`状态目录：${data.state_root || '-'}\n`);
    return 0;
  }

  if (command === 'windows') {
    const windows = listWindows();
    if (flags.json) process.stdout.write(`${JSON.stringify(windows, null, 2)}\n`);
    else process.stdout.write(`${formatWindows(windows)}\n`);
    return 0;
  }

  if (command === 'snapshot') {
    const snap = snapshot({
      windowId,
      interactiveOnly: !flags.all,
      timeoutMs: flags.timeoutMs || DEFAULT_SNAPSHOT_TIMEOUT_MS,
    });
    const payload = {
      windowId: snap.windowId,
      windowTitle: snap.windowTitle,
      app: snap.app,
      snapshotId: snap.snapshotId,
      refCount: snap.refCount,
      capturedAt: new Date().toISOString(),
      nodes: snap.nodes,
    };
    if (flags.out) {
      const outputPath = path.resolve(ROOT, flags.out);
      fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    }
    if (flags.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else {
      process.stdout.write(
        `窗口：${snap.windowId} | ${snap.windowTitle}\nsnapshot：${snap.snapshotId} | refs：${snap.refCount}\n`,
      );
      process.stdout.write(`${formatNodes(snap.nodes, { limit: flags.limit || 80 })}\n`);
      if (flags.out) process.stdout.write(`已写入：${path.resolve(ROOT, flags.out)}\n`);
    }
    return 0;
  }

  if (command === 'find') {
    const query = positional[1];
    if (!query) throw new AgentDesktopError('用法：find <文本>', { code: 'USAGE' });
    const snap = snapshot({ windowId });
    const matches = snap.nodes.filter((node) => node.name && node.name.toLowerCase().includes(query.toLowerCase()));
    if (!matches.length) {
      process.stderr.write(`没有找到包含「${query}」的元素。\n`);
      return 1;
    }
    process.stdout.write(`匹配 ${matches.length} 个元素（snapshot ${snap.snapshotId}）：\n${formatNodes(matches)}\n`);
    return 0;
  }

  if (command === 'click') {
    const query = positional[1];
    if (!query) throw new AgentDesktopError('用法：click <名称|@ref>', { code: 'USAGE' });
    const { target, data } = clickByQuery(windowId, query);
    const steps = (data.steps || []).map((step) => `${step.label}:${step.outcome}`).join(', ');
    process.stdout.write(`已点击：${target.node?.name || target.ref} (${target.ref})\n`);
    process.stdout.write(`投递：${data.disposition?.delivery || '-'} | 步骤：${steps || '-'}\n`);
    if (data.disposition?.delivery === 'delivered_unverified') {
      process.stdout.write('提示：点击已投递但未验证，请用 verify 或 snapshot 复查界面。\n');
    }
    return 0;
  }

  if (command === 'type') {
    const query = positional[1];
    if (!query) throw new AgentDesktopError('用法：type <名称> [文本]（省略文本表示清空）', { code: 'USAGE' });
    const value = positional.length >= 3 ? positional[2] : '';
    const { target, data } = setValueByQuery(windowId, query, value);
    const steps = (data.steps || []).map((step) => `${step.label}:${step.outcome}`).join(', ');
    process.stdout.write(`已写入：${target.node?.name || target.ref} (${target.ref}) ← ${JSON.stringify(value)}\n`);
    process.stdout.write(`投递：${data.disposition?.delivery || '-'} | 步骤：${steps || '-'}\n`);
    return 0;
  }

  if (command === 'verify') {
    const texts = positional.slice(1);
    if (!texts.length) throw new AgentDesktopError('用法：verify <文本...>', { code: 'USAGE' });
    const snap = snapshot({ windowId });
    const result = assertTexts(snap, texts);
    if (!result.ok) {
      process.stderr.write(`缺少 ${result.missing.length} 个文本：${result.missing.map((text) => `「${text}」`).join('、')}\n`);
      process.stderr.write(`当前快照（${snap.snapshotId}）：\n${formatNodes(snap.nodes, { limit: 40 })}\n`);
      return 1;
    }
    process.stdout.write(`PASS ${texts.length} 项文本均存在（snapshot ${snap.snapshotId}）\n`);
    return 0;
  }

  process.stderr.write(`未知命令：${command}\n\n${usage()}\n`);
  return 1;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`\n[agent-debug] ${error.message}\n`);
    if (error.hint) process.stderr.write(`建议：${error.hint}\n`);
    if (error.code === 'NOT_INSTALLED' || error.code === 'WINDOW_NOT_FOUND') process.exitCode = 2;
    else process.exitCode = 1;
  }
}

module.exports = {
  ROOT,
  AgentDesktopError,
  getStatus,
  listWindows,
  findWindow,
  snapshot,
  flattenTree,
  resolveTarget,
  clickByQuery,
  setValueByQuery,
  hasText,
  waitForText,
  assertTexts,
  formatNodes,
  formatWindows,
  stamp,
  DEFAULT_SNAPSHOT_TIMEOUT_MS,
  ACTION_TIMEOUT_MS,
};
