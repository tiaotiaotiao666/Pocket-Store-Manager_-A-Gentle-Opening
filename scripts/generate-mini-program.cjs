const fs = require('node:fs/promises');
const path = require('node:path');
const templateRoot = path.join(__dirname, '..', 'templates', 'mini-program');

function slugify(value) {
  const slug = String(value || 'restaurant').toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/g, '-').replace(/(^-|-$)/g, '');
  return slug || 'restaurant';
}

function safeProjectName(value) {
  return slugify(value).replace(/-+/g, '-').slice(0, 36);
}

async function writeProject(parent, payload) {
  if (!payload || typeof payload !== 'object') throw new Error('A project configuration is required.');
  const storeName = String(payload.storeName || '我的餐馆').trim().slice(0, 48) || '我的餐馆';
  const projectName = safeProjectName(storeName);
  await fs.mkdir(path.resolve(parent), { recursive: true });
  const destination = path.join(path.resolve(parent), projectName);
  await fs.mkdir(destination, { recursive: false });
  try {
    await copyTemplate(templateRoot, destination, payload);
  } catch (error) {
    await fs.rm(destination, { recursive: true, force: true });
    throw error;
  }
  return destination;
}

function safeColor(value, fallback) {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toUpperCase() : fallback;
}

async function copyTemplate(sourceRoot, destinationRoot, payload) {
  const { templates, themes } = await import('../src/domain/catalog.mjs');
  const pages = ['home', 'menu', 'orders', 'mine'];
  const appJson = {
    pages: pages.map((page) => `pages/${page}/index`),
    window: { navigationBarBackgroundColor: payload.theme?.colors?.[0] || '#FAF7F1', navigationBarTextStyle: 'black', navigationBarTitleText: String(payload.storeName || '我的餐馆').trim().slice(0, 10), backgroundColor: payload.theme?.colors?.[0] || '#FAF7F1', backgroundTextStyle: 'dark' },
    tabBar: {
      color: '#77766f', selectedColor: payload.theme?.colors?.[1] || '#E78A35', backgroundColor: '#fffefa', borderStyle: 'white',
      list: [
        { pagePath: 'pages/home/index', text: '首页' }, { pagePath: 'pages/menu/index', text: '菜单' },
        { pagePath: 'pages/orders/index', text: '订单' }, { pagePath: 'pages/mine/index', text: '我的' },
      ],
    },
    style: 'v2', sitemapLocation: 'sitemap.json',
  };
  const project = { description: `${payload.storeName || '我的餐馆'} 独立小程序工程`, compileType: 'miniprogram', appid: 'touristappid', projectname: `${safeProjectName(payload.storeName)}-miniprogram`, setting: { urlCheck: false, es6: true, enhance: true, minified: true }, miniprogramRoot: './', condition: {} };
  const rendererData = {
    schemaVersion: 1,
    store: { id: 'store-demo-001', name: String(payload.storeName || '我的餐馆').trim().slice(0, 48), address: '', phone: '', businessHours: '10:00-22:00', notice: '欢迎光临，现点现做。' },
    catalog: [
      { id: 'signature', name: '主打推荐', products: [
        { id: 'meal-1', name: '门店招牌饭', description: '在项目配置中替换为自己的商品介绍', priceCents: 2800, priceText: '28.00', badge: '本店招牌', icon: '★', available: true },
        { id: 'meal-2', name: '时令小食拼盘', description: '清爽搭配，适合和朋友一起分享', priceCents: 1600, priceText: '16.00', badge: '人气推荐', icon: '✳', available: true },
      ] },
      { id: 'drinks', name: '饮品与小食', products: [
        { id: 'drink-1', name: '自选鲜泡茶', description: '每日现泡，可以根据门店风格自由调整', priceCents: 1000, priceText: '10.00', badge: '每日现泡', icon: '◇', available: true },
      ] },
    ],
    fulfillmentOptions: { dineIn: payload.features?.includes('table-dining') ?? false, takeaway: payload.features?.includes('takeaway') ?? false, delivery: false },
    capabilities: { configured: [...new Set(payload.features || [])], available: (payload.generatedModules || []).filter((id) => id !== 'product-availability'), pendingImplementation: [...new Set(payload.pendingFeatures || [])] },
    template: templates.find(({ id }) => id === payload.template?.id)?.name || templates[0].name,
    theme: { id: payload.theme?.id || 'citrus', colors: payload.theme?.colors?.slice(0, 4) || [...themes[0].preview] },
    icons: (payload.icons || []).map(({ id, label, tint, dataUrl }) => ({ id, label, tint, asset: dataUrl ? `assets/icons/${slugify(label)}.png` : '' })),
    demoPaymentDisclaimer: '此模板为演示工程。生成的模板当前不集成真实订单后端、真实微信支付或自动小程序发布。上线前需接入独立服务器、HTTPS 域名、合法域名配置、店铺业务数据及微信支付。',
  };

  await fs.cp(sourceRoot, destinationRoot, { recursive: true, filter: (source) => !source.endsWith('project-template.json') && !source.endsWith('sitemap-template.json') });
  const wxssPath = path.join(destinationRoot, 'app.wxss');
  let wxss = await fs.readFile(wxssPath, 'utf8');
  const colors = payload.theme?.colors || themes[0].preview;
  wxss = wxss.replace('--store-bg:#FAF7F1', `--store-bg:${safeColor(colors[0], '#FAF7F1')}`)
    .replace('--store-primary:#E78A35', `--store-primary:${safeColor(colors[1], '#E78A35')}`)
    .replace('--store-accent:#286957', `--store-accent:${safeColor(colors[2], '#286957')}`)
    .replace('--store-text:#29332F', `--store-text:${safeColor(colors[3], '#29332F')}`);
  await fs.writeFile(wxssPath, wxss, 'utf8');
  await writeJson(destinationRoot, 'app.json', appJson);
  await writeJson(destinationRoot, 'project.config.json', project);
  await writeJson(destinationRoot, 'config/store.generated.json', rendererData);
  await writeExportReadme(destinationRoot, rendererData);
  await fs.mkdir(path.join(destinationRoot, 'assets', 'icons'), { recursive: true });
  for (const icon of payload.icons || []) {
    if (typeof icon.dataUrl !== 'string' || !/^data:image\/png;base64,/.test(icon.dataUrl)) continue;
    const targetName = `${slugify(icon.label)}.png`;
    const bytes = Buffer.from(icon.dataUrl.split(',')[1], 'base64');
    if (bytes.length > 10 * 1024 * 1024) continue;
    await fs.writeFile(path.join(destinationRoot, 'assets', 'icons', targetName), bytes);
    const config = rendererData.icons.find((item) => item.label === icon.label);
    if (config) config.asset = `assets/icons/${targetName}`;
  }
  await writeJson(destinationRoot, 'config/store.generated.json', rendererData);
}

async function writeExportReadme(root, config) {
  const contents = `# ${config.store.name} 微信小程序工程\n\n这是由“智能开店”Windows 生成器导出的独立微信原生小程序工程。\n\n## 导入预览\n\n1. 安装并打开微信开发者工具。\n2. 选择“导入项目”，项目目录选本文件所在目录。\n3. 当前工程使用游客 AppID 作为预览配置。正式开发时，请在微信开发者工具中使用店主自己的小程序账号和 AppID。\n4. 点击编译，检查首页、菜单、订单和我的页面。\n\n## 门店配置\n\n- 门店名称、地址、营业时间、公告、示例菜单和所选功能位于 \`config/store.generated.json\`。\n- 商品价格以整数分保存，\`priceText\` 用于页面展示。\n- 页面文件位于 \`pages/\`，全局样式位于 \`app.wxss\`。\n- 页面订单目前是演示占位。修改商品配置不会创建真实订单或后端接口。\n\n## 当前范围\n\n这是可导入预览的前端模板，不含线上订单后端、登录、真实微信支付、外送或店主订单管理服务。请勿将演示数据当作真实营业数据。\n\n正式发布需要店主使用自己的微信小程序账号与合法主体，配置 AppID、HTTPS 服务域名和业务后端，使用微信开发者工具上传代码，并自行提交平台审核。生成器不会代办注册、认证、审核或发布。\n\n演示支付说明：${config.demoPaymentDisclaimer}\n`;
  await fs.writeFile(path.join(root, 'README.md'), contents, 'utf8');
}

async function writeJson(root, relative, data) {
  const output = path.join(root, relative);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

async function main() {
  const { themes } = await import('../src/domain/catalog.mjs');
  const outputParent = path.resolve(process.argv[2] || path.join(process.cwd(), 'generated-projects'));
  const payloadPath = process.argv[3];
  let payload;
  if (payloadPath) payload = JSON.parse(await fs.readFile(path.resolve(payloadPath), 'utf8'));
  else payload = { storeName: '松月食堂', template: { id: 'warm-bistro' }, features: ['scan-order', 'product-catalog', 'cart-checkout', 'order-tracking', 'table-dining', 'takeaway', 'merchant-orders', 'store-profile'], generatedModules: ['table-dining', 'takeaway', 'merchant-orders', 'store-profile'], pendingFeatures: [], theme: { id: 'citrus', colors: [...themes[0].preview] }, icons: [] };
  const destination = await writeProject(outputParent, payload);
  process.stdout.write(`Mini-program project exported to: ${destination}\n`);
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });

module.exports = { safeProjectName, writeProject };
