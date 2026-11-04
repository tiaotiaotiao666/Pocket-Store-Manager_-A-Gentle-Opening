'use strict';

const fs = require('node:fs');
const path = require('node:path');
const automator = require('miniprogram-automator');

const WORKSPACE = path.resolve(__dirname, '..');
const CLI_PATH = process.env.WX_CLI_PATH || 'E:\\微信web开发者工具\\cli.bat';
const PROJECT_PATH = path.join(WORKSPACE, 'miniprogram');
const OUT_DIR = path.join(WORKSPACE, 'docs', 'evidence', 'visual');
const DEFAULT_ROUTES = [
  '/pages/home/index',
  '/pages/menu/index',
  '/pages/orders/index',
  '/pages/mine/index',
  '/pages/merchant-orders/index',
];

function parseRoutes() {
  const raw = process.argv[2];
  if (!raw) return DEFAULT_ROUTES;
  return raw.split(',').map((item) => item.trim()).filter(Boolean);
}

function slug(route) {
  return route.replace(/^\//, '').replace(/\//g, '-');
}

function summaryOf(data) {
  const source = data && typeof data === 'object' ? data : {};
  return {
    keys: Object.keys(source),
    error: typeof source.error === 'string' ? source.error : '',
    errorAction: typeof source.errorAction === 'string' ? source.errorAction : '',
    loading: source.loading === true || source.ordersLoading === true || source.productsLoading === true,
    allowed: typeof source.allowed === 'boolean' ? source.allowed : undefined,
  };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const routes = parseRoutes();
  const endpoint = process.env.WX_AUTO_WS || 'ws://127.0.0.1:9420';
  const miniProgram = await automator.connect({ wsEndpoint: endpoint });

  try {
    for (const route of routes) {
      const page = await miniProgram.reLaunch(route);
      await page.waitFor(1200);
      const file = path.join(OUT_DIR, `mini-${slug(route)}.png`);
      await miniProgram.screenshot({ path: file });
      const data = await page.data();
      console.log(JSON.stringify({ route, file, ...summaryOf(data) }));
    }
  } finally {
    await miniProgram.disconnect();
  }
}

main().catch((error) => {
  console.error('MINI_CAPTURE_FAILED', error && error.message ? error.message : error);
  process.exitCode = 1;
});