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
    let lastProductId = '';
    for (const item of ROUTES) {
      const entry = { ...item, status: 'NOT_RUN', screenshot: '', data: null, error: '', observation: '' };
      // 菜品详情页必须带真实 productId，否则页面会渲染「已下架」降级态。
      const target = item.route === '/pages/product-detail/index' && lastProductId
        ? item.route + '?productId=' + encodeURIComponent(lastProductId)
        : item.route;
      const page = await openRoute(miniProgram, target);
      if (!page) {
        entry.status = 'FAIL';
        entry.error = '页面打开失败（重试 3 次仍失败）：' + target;
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
        productName: data && data.product && data.product.name ? data.product.name : '',
        productPrice: data && data.product && typeof data.product.priceCents === 'number'
          ? '¥' + (data.product.priceCents / 100).toFixed(2)
          : '',
      };
      if (entry.data.error) entry.observation = '页面渲染了降级错误态：' + entry.data.error;
      if (item.route === '/pages/menu/index') {
        const menuProduct = (data && Array.isArray(data.products) ? data.products[0] : null) || null;
        if (menuProduct && menuProduct.id) lastProductId = menuProduct.id;
        for (const result of await probeMenuInteractions(miniProgram, page)) {
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
    for (const result of await probeClickChain(miniProgram, shotsDir)) {
      report.interactions.push(result);
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
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const page = await miniProgram.reLaunch(route);
      await sleep(2000);
      return page;
    } catch (error) {
      await sleep(2000);
    }
  }
  return null;
}

/**
 * 菜单页交互验证：三条自定义组件交互（分类切换 / 加购 / 购物车展开）+ 真实点击链路。
 *
 * W5b 结论依据（本机 开发者工具 2.02 + miniprogram-automator 0.13）：
 * - page.$('category-nav') / page.$$('product-card') 恒为 null/0，自定义组件宿主不可选择；
 * - page.getElementsByXpath('//category-nav') 直接抛错（Cannot read properties of undefined (reading 'map')）；
 * - page.selectComponent('category-nav') 在 appservice 里同样返回 null（无 id/class 锚点）；
 * - element.dispatchEvent({ $: 'product-card' }) 不触发页面事件处理器；
 * - page.callMethod(...) 抛 No context found for objectId。
 * 因此「组件内部节点」交互如实记为 BLOCKED，并附可复现步骤；
 * 同时用 appservice 内直调页面事件处理器（等价事件负载）验证业务状态确实变化，
 * 以及用页面级可点击节点完成真实点击链路（首页→菜单→选桌→结算提交→演示模拟支付）。
 */
async function probeMenuInteractions(miniProgram, page) {
  const results = [];
  const before = await page.data();
  const categories = before.categories || [];
  const secondCategory = categories[1];

  // 路径一：组件内部节点点击（如实阻塞）
  results.push(
    await attempt('分类切换（组件内部节点点击）', async () => {
      if (!secondCategory) return { status: 'NOT_RUN', detail: '菜单没有第二个分类，无法切换' };
      const host = await page.$('category-nav');
      const chips = await page.$$('.category-nav__item');
      const probe = {
        hostSelector: host ? host.tagName || 'element' : null,
        chips: chips ? chips.length : 0,
      };
      if (chips && chips.length >= 2) {
        await chips[1].tap();
        await sleep(1200);
        const after = await page.data();
        const ok = after.activeCategoryId === secondCategory.id;
        return {
          status: ok ? 'PASS' : 'FAIL',
          detail: '点击 chip 后 activeCategoryId=' + after.activeCategoryId,
          evidence: probe,
        };
      }
      return {
        status: 'BLOCKED',
        detail:
          'automator 无法定位 category-nav 自定义组件内部节点：page.$("category-nav")='
          + String(probe.hostSelector)
          + '，page.$$(".category-nav__item")='
          + probe.chips
          + '；page.getElementsByXpath 抛错，page.selectComponent 返回 null。最小复现：见 .arts/w5b/probe-*.cjs',
        evidence: probe,
      };
    }),
  );

  // 路径二：加购
  results.push(
    await attempt('菜品加购（组件内部节点点击）', async () => {
      const target = (before.products || [])[0];
      if (!target) return { status: 'NOT_RUN', detail: '当前分类没有菜品' };
      const hosts = await page.$$('product-card');
      const addButtons = await page.$$('.product-card__add');
      if (addButtons && addButtons.length > 0) {
        await addButtons[0].tap();
        await sleep(1200);
        const after = await page.data();
        const qty = after.quantityMap ? after.quantityMap[target.id] || 0 : 0;
        return {
          status: qty > 0 ? 'PASS' : 'FAIL',
          detail: '加购后 quantityMap[' + target.id + ']=' + qty,
        };
      }
      return {
        status: 'BLOCKED',
        detail:
          '加购按钮在 product-card 自定义组件内部：page.$$("product-card")='
          + (hosts ? hosts.length : 0)
          + '，page.$$(".product-card__add")='
          + (addButtons ? addButtons.length : 0)
          + '；点击宿主 .menu__product 不触发 bind:add',
        evidence: { hosts: hosts ? hosts.length : 0, addButtons: addButtons ? addButtons.length : 0 },
      };
    }),
  );

  // 路径三：购物车展开
  results.push(
    await attempt('购物车展开（组件内部节点点击）', async () => {
      const hosts = await page.$$('cart-bar');
      const summaries = await page.$$('.cart-bar__summary');
      if (summaries && summaries.length > 0) {
        await summaries[0].tap();
        await sleep(1000);
        const after = await page.data();
        return after.cartVisible
          ? { status: 'PASS', detail: '购物车面板已展开（cartVisible=true）' }
          : { status: 'FAIL', detail: '点击后 cartVisible 仍为 false' };
      }
      return {
        status: 'BLOCKED',
        detail:
          'cart-bar 为自定义组件：page.$$("cart-bar")='
          + (hosts ? hosts.length : 0)
          + '，page.$$(".cart-bar__summary")='
          + (summaries ? summaries.length : 0)
          + '；宿主节点无 id/class 锚点，无法定位内部点击区',
        evidence: { hosts: hosts ? hosts.length : 0, summaries: summaries ? summaries.length : 0 },
      };
    }),
  );

  // 路径四：appservice 内直调页面事件处理器（组件 emit 的等价负载），断言业务状态真的变化
  results.push(
    await attempt('分类切换（页面处理器直调 + 状态断言）', async () => {
      if (!secondCategory) return { status: 'NOT_RUN', detail: '菜单没有第二个分类，无法切换' };
      await callPageHandler(miniProgram, 'onSelectCategory', { currentTarget: { dataset: { id: secondCategory.id } }, detail: { id: secondCategory.id } });
      await sleep(1200);
      const after = await page.data();
      const changed = after.activeCategoryId === secondCategory.id;
      const productsNow = (after.products || []).map((item) => item.id).join(',');
      return {
        status: changed ? 'PASS' : 'FAIL',
        detail: 'activeCategoryId: ' + before.activeCategoryId + ' → ' + after.activeCategoryId
          + ' · 当前菜品=' + productsNow
          + (changed ? '' : '（与目标分类不符）'),
        path: 'HANDLER_CALL（非点击）',
      };
    }),
  );

  results.push(
    await attempt('菜品加购（页面处理器直调 + 状态断言）', async () => {
      const target = (before.products || [])[0];
      if (!target) return { status: 'NOT_RUN', detail: '当前分类没有菜品' };
      const baseline = await page.data();
      const id = ((await page.data()).products || [])[0];
      const productId = id && id.id ? id.id : target.id;
      const qtyBefore = (baseline.quantityMap || {})[productId] || 0;
      await callPageHandler(miniProgram, 'onProductAdd', { currentTarget: { dataset: { productId } }, detail: { productId } });
      await sleep(1200);
      const after = await page.data();
      const qtyAfter = (after.quantityMap || {})[productId] || 0;
      const totalBefore = baseline.cartSummary ? baseline.cartSummary.totalQuantity : 0;
      const totalAfter = after.cartSummary ? after.cartSummary.totalQuantity : 0;
      return {
        status: qtyAfter === qtyBefore + 1 ? 'PASS' : 'FAIL',
        detail: 'quantityMap[' + productId + ']: ' + qtyBefore + ' → ' + qtyAfter
          + ' · 购物车总件数: ' + totalBefore + ' → ' + totalAfter
          + ' · 金额=' + (after.cartSummary && typeof after.cartSummary.totalCents === 'number'
            ? '¥' + (after.cartSummary.totalCents / 100).toFixed(2)
            : '(无)'),
        path: 'HANDLER_CALL（非点击）',
      };
    }),
  );

  results.push(
    await attempt('购物车展开（页面处理器直调 + 状态断言）', async () => {
      await callPageHandler(miniProgram, 'onExpandCart', { detail: {} });
      await sleep(1000);
      const after = await page.data();
      return {
        status: after.cartVisible === true ? 'PASS' : 'FAIL',
        detail: 'cartVisible: false → ' + after.cartVisible,
        path: 'HANDLER_CALL（非点击）',
      };
    }),
  );

  // 页面级真实点击（首页 CTA / 选桌 / 结算提交 / 演示模拟支付）在 probeClickChain 里执行，
  // 那里会先清空本地存储，保证「未选桌」状态可复现。
  return results;
}

/**
 * 清空小程序本地存储，让「选桌」入口回到干净状态（已选桌时菜单页不渲染选桌列表）。
 */
async function resetMiniProgramStorage(miniProgram) {
  await miniProgram.evaluate(() => {
    if (typeof wx !== 'undefined' && wx && typeof wx.clearStorageSync === 'function') {
      wx.clearStorageSync();
    }
    return true;
  });
}

/**
 * 真实点击链路：页面级可点击节点（首页 CTA → 选桌 → 结算提交 → 订单详情演示模拟支付）。
 * 起点用 reLaunch 保证状态干净；购物车数量不足时先直调页面处理器补足，
 * 该步骤在报告里单独标注 HANDLER_CALL，与点击步骤区分。
 */
async function probeClickChain(miniProgram, shotsDir) {
  const results = [];

  results.push(
    await attempt('真实点击·首页「开始点餐」跳转菜单', async () => {
      const home = await openRoute(miniProgram, '/pages/home/index');
      if (!home) return { status: 'FAIL', detail: '首页打开失败' };
      const cta = await home.$('.home__cta');
      if (!cta) return { status: 'BLOCKED', detail: '首页未渲染 .home__cta 节点（可能在加载态）' };
      await cta.tap();
      await sleep(2500);
      const current = await miniProgram.currentPage();
      const route = current ? current.path : '';
      return {
        status: route === 'pages/menu/index' ? 'PASS' : 'FAIL',
        detail: '点击后当前页面=' + route,
        path: 'CLICK（真实点击）',
      };
    }),
  );

  results.push(
    await attempt('真实点击·选择餐桌（菜单页 .menu__table）', async () => {
      await resetMiniProgramStorage(miniProgram);
      const menu = await openRoute(miniProgram, '/pages/menu/index');
      if (!menu) return { status: 'FAIL', detail: '菜单页打开失败（清空本地存储后）' };
      const beforeData = await menu.data();
      // 选桌列表只在「堂食 + 未选桌」时渲染；堂食开关在 fulfillment-switch 自定义组件内部，
      // 该组件不可点击，这里先直调页面处理器切到堂食，再对桌位做真实点击。
      if (beforeData.mode !== 'DINE_IN') {
        // 组件 emit 的形状是 { value }（见 components/fulfillment-switch）。
        await callPageHandler(miniProgram, 'onModeChange', {
          currentTarget: { dataset: {} },
          detail: { value: 'DINE_IN' },
        });
        await sleep(1200);
      }
      const tableNodes = await menu.$$('.menu__table');
      if (!tableNodes || tableNodes.length === 0) {
        const nowData = await menu.data();
        return {
          status: 'NOT_RUN',
          detail: '菜单页未渲染 .menu__table（mode=' + nowData.mode
            + '，tableName=' + JSON.stringify(nowData.tableName || '')
            + '，tableOptions=' + JSON.stringify(nowData.tableOptions || []) + '）',
        };
      }
      await tableNodes[0].tap();
      await sleep(1500);
      const after = await menu.data();
      return {
        status: after.tableName ? 'PASS' : 'FAIL',
        detail: '点击桌位后 tableName=' + JSON.stringify(after.tableName || '')
          + '（可点节点 ' + tableNodes.length + ' 个）',
        path: 'CLICK（真实点击）',
      };
    }),
  );

  results.push(
    await attempt('真实点击·结算提交下单', async () => {
      const menu = await openRoute(miniProgram, '/pages/menu/index');
      if (!menu) return { status: 'FAIL', detail: '菜单页打开失败' };
      const menuData = await menu.data();
      const product = (menuData.products || [])[0];
      if (!product) return { status: 'NOT_RUN', detail: '菜单没有菜品，无法构造购物车' };
      for (let i = 0; i < 2; i += 1) {
        await callPageHandler(miniProgram, 'onProductAdd', {
          currentTarget: { dataset: { productId: product.id } },
          detail: { productId: product.id },
        });
        await sleep(600);
      }
      const checkout = await miniProgram.navigateTo('/pages/checkout/index');
      if (!checkout) return { status: 'FAIL', detail: '结算页打开失败' };
      await sleep(2000);
      const checkoutData = await checkout.data();
      const button = await checkout.$('.checkout__bar-button');
      if (!button) return { status: 'BLOCKED', detail: '结算页未渲染提交按钮 .checkout__bar-button' };
      await button.tap();
      await sleep(3000);
      const current = await miniProgram.currentPage();
      const route = current ? current.path : '';
      const orderData = current ? await current.data() : null;
      const orderId = orderData && orderData.order ? orderData.order.id : '';
      const payHint = checkoutData && typeof checkoutData.payHint === 'string' ? checkoutData.payHint : '';
      return {
        status: orderId ? 'PASS' : 'FAIL',
        detail: '提交结算页（items=' + ((checkoutData.items || []).length) + '，合计=' + (checkoutData.totalText || '')
          + '）后落到 ' + route + '，真实后端订单号=' + (orderId || '(无)')
          + '；结算页演示支付提示=' + JSON.stringify(payHint),
        path: 'CLICK（真实点击）+ HANDLER_CALL（补足购物车）',
      };
    }),
  );

  results.push(
    await attempt('真实点击·订单详情「演示模拟支付」', async () => {
      const current = await miniProgram.currentPage();
      const route = current ? current.path : '';
      if (route !== 'pages/order-detail/index') {
        return { status: 'NOT_RUN', detail: '当前不在订单详情页（' + route + '），跳过演示模拟支付' };
      }
      const before = await current.data();
      const order = before.order || {};
      if (!order.canPay) {
        return { status: 'NOT_RUN', detail: '订单当前不可支付（canPay=false，status=' + order.status + '）' };
      }
      const payButton = await current.$('.detail__bar-primary');
      if (!payButton) return { status: 'BLOCKED', detail: '订单详情页未渲染 .detail__bar-primary 支付按钮' };
      await payButton.tap();
      await sleep(3500);
      const after = await current.data();
      const orderAfter = after.order || {};
      const changed = orderAfter.paymentStatus !== order.paymentStatus || Boolean(after.payResult);
      if (shotsDir) {
        try {
          await miniProgram.screenshot({ path: path.join(shotsDir, 'order-detail-paid.png') });
        } catch {
          /* 截图失败不影响结论 */
        }
      }
      return {
        status: changed ? 'PASS' : 'FAIL',
        detail: '演示模拟支付：paymentStatus ' + order.paymentStatus + ' → ' + orderAfter.paymentStatus
          + ' · payResult=' + (after.payResult ? after.payResult.state : '无')
          + ' · 订单号=' + (orderAfter.id || order.id || '')
          + '（演示支付，未发生真实交易）',
        path: 'CLICK（真实点击）',
      };
    }),
  );

  return results;
}

/**
 * 在 appservice 内直调页面事件处理器，负载与自定义组件 triggerEvent 的形状一致。
 * 仅用于「组件内部节点不可点击」时的业务状态验证，报告里标注 HANDLER_CALL，不冒充点击。
 */
async function callPageHandler(miniProgram, handler, payload) {
  const result = await miniProgram.evaluate(
    (handlerName, eventPayload) => {
      const pages = getCurrentPages();
      const current = pages[pages.length - 1];
      if (!current || typeof current[handlerName] !== 'function') {
        return { ok: false, reason: '页面缺少处理器 ' + handlerName };
      }
      current[handlerName](eventPayload);
      return { ok: true, route: current.route };
    },
    handler,
    payload,
  );
  if (!result || result.ok !== true) {
    throw new Error((result && result.reason) || '直调失败');
  }
  return result;
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
