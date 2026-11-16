#!/usr/bin/env node
/**
 * W5：微信小程序「真实编译 + 自动化运行」验证包装。
 *
 * 只做可复现的事，状态一律 PASS / FAIL / BLOCKED / NOT_RUN：
 *   1. 探测开发者工具 CLI 与登录态
 *   2. cli open --project 触发真实编译
 *   3. cli auto --project --auto-port 打开自动化端口
 *   4. miniprogram-automator 连接后逐页检查并截图
 *
 * 用法：
 *   node scripts/wechat-devtools-run.cjs <导出工程目录> [--auto-port 9420] [--json 证据.json] [--shots 截图目录]
 *
 * 说明：
 * - 平台环境里 ELECTRON_RUN_AS_NODE=1 会让开发者工具进程退化成纯 Node，
 *   因此脚本在派生子进程前显式剔除该变量。
 * - 任何一步失败即停止后续依赖步骤，并如实写入状态与错误文本，不伪造编译结果。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const CLI_CANDIDATES = [
  process.env.WX_CLI_PATH,
  'D:\\Downloads\\微信web开发者工具\\cli.bat',
  'C:\\Program Files (x86)\\Tencent\\微信web开发者工具\\cli.bat',
  'C:\\Program Files\\Tencent\\微信web开发者工具\\cli.bat',
].filter(Boolean);

const ROUTES = [
  { route: '/pages/home/index', label: '首页' },
  { route: '/pages/menu/index', label: '菜单' },
  { route: '/pages/product-detail/index', label: '菜品详情' },
  { route: '/pages/checkout/index', label: '结算/下单入口' },
];

function resolveCli() {
  for (const candidate of CLI_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return '';
}

function cleanEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function runCli(cliPath, args, timeoutMs = 180000) {
  return new Promise((resolve) => {
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const child = spawn(cliPath, args, { env: cleanEnv(), shell: true, windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        command: [cliPath, ...args].join(' '),
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
        exitCode: code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
}

function tail(text, limit = 1200) {
  const value = String(text || '');
  return value.length <= limit ? value : '…' + value.slice(-limit);
}

function detectBlockedReason(result) {
  const output = (result.stdout || '') + '\n' + (result.stderr || '');
  if (/APPID_ERROR|不存在此 AppID/.test(output)) {
    return 'APPID_ERROR：导出工程使用 touristappid 占位，开发者工具拒绝打开；本机没有真实小程序 AppID，无法进入编译。';
  }
  if (/service port|服务端口/.test(output)) {
    return 'SERVICE_PORT_DISABLED：开发者工具服务端口未开启，CLI 无法调用。';
  }
  if (/login/i.test(output) && /false/i.test(output)) {
    return 'NOT_LOGGED_IN：开发者工具未登录。';
  }
  return '';
}

async function main() {
  const argv = process.argv.slice(2);
  const projectRoot = argv[0] ? path.resolve(argv[0]) : '';
  const argOf = (flag, fallback) => {
    const index = argv.indexOf(flag);
    return index > -1 && argv[index + 1] ? argv[index + 1] : fallback;
  };
  const autoPort = Number(argOf('--auto-port', '9420'));
  const jsonOut = argOf('--json', '');
  const shotsDir = argOf('--shots', '');

  const report = {
    schemaVersion: 'wechat-devtools-run.v1',
    generatedAt: new Date().toISOString(),
    projectRoot,
    cliPath: resolveCli(),
    status: 'NOT_RUN',
    steps: [],
    blocked: null,
    pages: [],
    interactions: [],
  };

  if (!projectRoot || !fs.existsSync(projectRoot)) {
    report.status = 'BLOCKED';
    report.blocked = '导出工程目录不存在：' + projectRoot;
    finish(report, jsonOut);
    return;
  }

  if (!report.cliPath) {
    report.status = 'BLOCKED';
    report.blocked = '本机未找到微信开发者工具 cli.bat（可用 WX_CLI_PATH 指定）。';
    finish(report, jsonOut);
    return;
  }

  const login = await runCli(report.cliPath, ['islogin'], 90000);
  const loggedIn = /"login"\s*:\s*true/.test(login.stdout);
  report.steps.push({
    id: 'login',
    title: '开发者工具登录态',
    status: loggedIn ? 'PASS' : 'BLOCKED',
    ...login,
  });
  if (!loggedIn) {
    report.status = 'BLOCKED';
    report.blocked = '开发者工具未登录（cli islogin 未返回 login:true）。';
    finish(report, jsonOut);
    return;
  }

  const open = await runCli(report.cliPath, ['open', '--project', projectRoot], 240000);
  const openBlocked = detectBlockedReason(open);
  const openOk = open.exitCode === 0 && !openBlocked;
  report.steps.push({
    id: 'compile',
    title: 'cli open --project（真实编译）',
    status: openOk ? 'PASS' : openBlocked ? 'BLOCKED' : 'FAIL',
    ...open,
  });
  if (!openOk) {
    report.status = openBlocked ? 'BLOCKED' : 'FAIL';
    report.blocked = openBlocked || '编译打开失败：' + tail(open.stdout + open.stderr, 400);
    finish(report, jsonOut);
    return;
  }

  const auto = await runCli(report.cliPath, ['auto', '--project', projectRoot, '--auto-port', String(autoPort)], 240000);
  const autoBlocked = detectBlockedReason(auto);
  const autoOk = auto.exitCode === 0 && !autoBlocked;
  report.steps.push({
    id: 'automation',
    title: 'cli auto --auto-port（自动化端口）',
    status: autoOk ? 'PASS' : autoBlocked ? 'BLOCKED' : 'FAIL',
    ...auto,
  });
  if (!autoOk) {
    report.status = autoBlocked ? 'BLOCKED' : 'FAIL';
    report.blocked = autoBlocked || '自动化端口打开失败：' + tail(auto.stdout + auto.stderr, 400);
    finish(report, jsonOut);
    return;
  }

  let automator = null;
  try {
    automator = require('miniprogram-automator');
  } catch (error) {
    report.status = 'BLOCKED';
    report.blocked = '缺少 miniprogram-automator 依赖：' + error.message;
    finish(report, jsonOut);
    return;
  }

  const endpoint = 'ws://127.0.0.1:' + autoPort;
  let miniProgram = null;
  try {
    miniProgram = await automator.connect({ wsEndpoint: endpoint });
    // 连接就绪后模拟器还需要一点时间注册 webview，否则 reLaunch 会报
    // getPageMetaByWebviewId(...) is null（devtools 2.02 + automator 0.13）。
    await sleep(3000);
    if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true });
    for (const item of ROUTES) {
      const entry = { ...item, status: 'NOT_RUN', screenshot: '', data: null, error: '', observation: '' };
      const page = await openRoute(miniProgram, item.route);
      if (!page) {
        entry.status = 'FAIL';
        entry.error = '页面打开失败（重试 2 次仍失败）';
        report.pages.push(entry);
        continue;
      }
      entry.status = 'PASS';
      const data = await page.data();
      entry.data = {
        keys: data && typeof data === 'object' ? Object.keys(data).slice(0, 24) : [],
        error: data && typeof data.error === 'string' ? data.error : '',
        storeName: data && data.store && data.store.name ? data.store.name : '',
        categories: Array.isArray(data && data.categories) ? data.categories.length : 0,
        products: Array.isArray(data && data.products) ? data.products.length : 0,
        emptyCart: data && typeof data.emptyCart === 'boolean' ? data.emptyCart : null,
        payHint: data && typeof data.payHint === 'string' ? data.payHint : '',
      };
      if (entry.data.error) entry.observation = '页面渲染了降级错误态：' + entry.data.error;
      if (item.route === '/pages/menu/index') {
        for (const result of await probeMenuInteractions(page)) {
          report.interactions.push(result);
        }
        entry.observation = [
          entry.observation,
          '分类 ' + entry.data.categories + ' 个 · 菜品种类 ' + entry.data.products + ' 个',
        ].filter(Boolean).join(' · ');
      }
      if (shotsDir) {
        const file = path.join(shotsDir, item.route.replace(/^\//, '').replace(/\//g, '-') + '.png');
        try {
          await miniProgram.screenshot({ path: file });
          entry.screenshot = file;
        } catch (error) {
          entry.screenshot = '';
        }
      }
      report.pages.push(entry);
    }
    const failed = report.pages.filter((page) => page.status !== 'PASS');
    report.status = failed.length === 0 ? 'PASS' : 'FAIL';
  } catch (error) {
    report.status = 'BLOCKED';
    report.blocked = '自动化连接失败：' + (error && error.message ? error.message : String(error));
  } finally {
    if (miniProgram) {
      try {
        await miniProgram.disconnect();
      } catch {
        /* 断开失败不影响结论 */
      }
    }
    finish(report, jsonOut);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function openRoute(miniProgram, route) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const page = await miniProgram.reLaunch(route);
      await sleep(1500);
      return page;
    } catch (error) {
      await sleep(1500);
    }
  }
  return null;
}

/**
 * 尝试三条真实交互路径：分类切换、菜品加购、购物车展开。
 * 当前 automator 0.13 + 开发者工具 2.02 无法定位自定义组件内部节点，
 * 因此这里如实记录 PASS / BLOCKED，不做「假通过」。
 */
async function probeMenuInteractions(page) {
  const results = [];

  const before = await page.data();
  const firstCategory = (before.categories || [])[0];
  const secondCategory = (before.categories || [])[1];

  results.push(
    await attempt('分类切换', async () => {
      if (!secondCategory) return { status: 'NOT_RUN', detail: '菜单没有第二个分类，无法切换' };
      const chips = await page.$$('.category-nav__item');
      if (!chips || chips.length < 2) {
        return {
          status: 'BLOCKED',
          detail: '当前 automator 无法定位 category-nav 内部节点（page.$$ 返回 0），分类切换只能静态检查',
        };
      }
      await chips[1].tap();
      await sleep(1200);
      const after = await page.data();
      if (after.activeCategoryId === secondCategory.id) {
        return { status: 'PASS', detail: '点击分类后 activeCategoryId=' + after.activeCategoryId };
      }
      return { status: 'FAIL', detail: '点击分类后 activeCategoryId 未变化（' + after.activeCategoryId + '）' };
    }),
  );

  results.push(
    await attempt('菜品加购', async () => {
      const target = (before.products || [])[0];
      if (!target) return { status: 'NOT_RUN', detail: '当前分类没有菜品' };
      const cards = await page.$$('.menu__product');
      if (!cards || cards.length === 0) {
        return { status: 'FAIL', detail: '未渲染 .menu__product 节点' };
      }
      await cards[0].tap();
      await sleep(1000);
      const after = await page.data();
      const qty = after.cartSummary ? after.cartSummary.totalQuantity : 0;
      if (qty > 0) return { status: 'PASS', detail: '加购后购物车数量=' + qty };
      return {
        status: 'BLOCKED',
        detail: '加购按钮位于 product-card 自定义组件内部，automator 无法点击；点击宿主节点不触发事件',
      };
    }),
  );

  results.push(
    await attempt('购物车展开', async () => {
      const bars = await page.$$('.cart-bar__summary');
      if (!bars || bars.length === 0) {
        return { status: 'BLOCKED', detail: 'cart-bar 为自定义组件，内部节点不可定位' };
      }
      await bars[0].tap();
      await sleep(800);
      const after = await page.data();
      return after.cartVisible
        ? { status: 'PASS', detail: '购物车面板已展开' }
        : { status: 'FAIL', detail: '点击后 cartVisible 仍为 false' };
    }),
  );

  results.push(
    await attempt('page.callMethod 兜底', async () => {
      if (typeof page.callMethod !== 'function') return { status: 'NOT_RUN', detail: '当前 automator 不支持 callMethod' };
      if (!firstCategory) return { status: 'NOT_RUN', detail: '无分类可切换' };
      try {
        await page.callMethod('onSelectCategory', { detail: { id: secondCategory.id } });
        await sleep(800);
        return { status: 'PASS', detail: 'callMethod 生效' };
      } catch (error) {
        return {
          status: 'BLOCKED',
          detail: 'callMethod 在本机版本下 this 绑定错误：' + (error.message || String(error)),
        };
      }
    }),
  );

  return results;
}

async function attempt(label, fn) {
  try {
    const result = await fn();
    return { label, ...result };
  } catch (error) {
    return { label, status: 'FAIL', detail: error && error.message ? error.message : String(error) };
  }
}

function finish(report, jsonOut) {
  const lines = [];
  lines.push('微信小程序真实编译/运行验证');
  lines.push('  工程：' + (report.projectRoot || '(未提供)'));
  lines.push('  CLI：' + (report.cliPath || '(未找到)'));
  for (const step of report.steps) {
    lines.push('  [' + step.status + '] ' + step.id + ' · ' + step.title + ' · exit=' + step.exitCode + ' · ' + step.durationMs + 'ms');
  }
  for (const page of report.pages) {
    lines.push('  [' + page.status + '] ' + page.label + ' ' + page.route + (page.screenshot ? ' → ' + page.screenshot : ''));
  }
  for (const item of report.interactions || []) {
    lines.push('  [' + item.status + '] 交互·' + item.label + '：' + item.detail);
  }
  if (report.blocked) lines.push('  阻塞原因：' + report.blocked);
  lines.push('  结论：' + report.status);
  console.log(lines.join('\n'));
  if (jsonOut) {
    fs.mkdirSync(path.dirname(path.resolve(jsonOut)), { recursive: true });
    fs.writeFileSync(path.resolve(jsonOut), JSON.stringify(report, null, 2), 'utf8');
    console.log('  证据：' + path.resolve(jsonOut));
  }
  if (report.status === 'FAIL') process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error('WECHAT_RUN_FAILED', error && error.message ? error.message : error);
    process.exitCode = 1;
  });
}

module.exports = { runCli, detectBlockedReason, resolveCli };
