const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * P2：主流程观感与演示模板质感的行为测试。
 *
 * L1 主线四步与返回/下一步投影
 * L2 模板页四种状态语义（当前使用 / 候选模板 / 已采用 / 已放弃）
 * L3 参考截图始终带「参考 · 候选」标注
 * L4 演示模板数据：分类、下单入口、演示标注，且不含外链素材
 * L5 长店名 / 长菜名 / 多菜品 / 无海报等边界仍有完整结构
 * L6 布局与无障碍不变量：不横向溢出的关键 CSS、步骤条 aria-current、状态徽标
 */

async function loadFlow() {
  return import('../src/domain/flowStages.mjs');
}

async function loadStatus() {
  return import('../src/domain/templateStatus.mjs');
}

async function loadPreview() {
  return import('../src/composition/previewViewModel.mjs');
}

async function loadPhases() {
  return import('../src/state/constants.mjs');
}

function readSource(relative) {
  return fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
}

function planWith(overrides = {}) {
  return {
    planId: 'order-classic',
    storeProfile: {
      name: '松月食堂',
      category: '快餐',
      fulfillment: { dineIn: true, takeaway: true },
      businessHours: [{ start: '10:00', end: '20:00' }],
      dishes: [],
      ...(overrides.storeProfile || {}),
    },
    features: [],
    slotOrder: [],
    ...overrides,
  };
}

test('L1 主线固定五步，当前步/可返回/下一步都说清楚', async () => {
  const { describeFlow, FLOW_STAGES } = await loadFlow();
  const { PHASES } = await loadPhases();

  assert.deepEqual(FLOW_STAGES.map((stage) => stage.label), [
    '门店资料',
    '能力与定制',
    '页面骨架',
    '装修与视觉',
    '导出',
  ]);

  const store = describeFlow(PHASES.STORE_INFO);
  assert.equal(store.currentKey, 'store');
  assert.deepEqual(store.steps.map((step) => step.state), ['current', 'todo', 'todo', 'todo', 'todo']);
  assert.equal(store.back, null, '第一站没有「返回修改」');
  assert.equal(store.next.label, '能力与定制');

  const template = describeFlow(PHASES.TEMPLATE_PICK);
  assert.deepEqual(template.steps.map((step) => step.state), ['done', 'done', 'current', 'todo', 'todo']);
  assert.equal(template.back.phase, PHASES.FEATURES);
  assert.equal(template.back.label, '返回调整能力');
  assert.equal(template.next.label, '装修与视觉');

  const materialImage = describeFlow(PHASES.IMAGE_REVIEW);
  assert.equal(materialImage.currentKey, 'material', '提示词与图片都属于「装修与视觉」这一步');
  assert.equal(materialImage.back.phase, PHASES.TEMPLATE_PICK);

  const deploy = describeFlow(PHASES.DEPLOY);
  assert.equal(deploy.currentKey, 'export');
  assert.equal(deploy.next, null, '导出是最后一步');
  assert.equal(deploy.back.phase, PHASES.IMAGE_REVIEW);

  const building = describeFlow(PHASES.BUILDING, { busy: true });
  assert.equal(building.back, null);
  assert.equal(building.currentKey, 'template');

  assert.equal(describeFlow(PHASES.HOME).visible, false);
  assert.equal(describeFlow(PHASES.STORE_INFO).visible, true);
});

test('L2/L3 模板卡四态语义：参考候选永远是「参考 · 候选」，采用后才变「已采用」', async () => {
  const { describeTemplateStatus, screenReferenceTag } = await loadStatus();

  // 通模板：选中的是「当前使用」，没选中的是「候选模板」
  const current = describeTemplateStatus({ id: 'warm-bistro' }, { selectedId: 'warm-bistro' });
  assert.equal(current.key, 'current');
  assert.equal(current.label, '当前使用');
  assert.equal(current.isCurrent, true);
  assert.equal(current.referenceTag, null);

  const candidate = describeTemplateStatus({ id: 'modern-coffee' }, { selectedId: 'warm-bistro' });
  assert.equal(candidate.key, 'candidate');
  assert.equal(candidate.label, '候选模板');
  assert.equal(candidate.isCurrent, false);

  // 参考截图生成、还没采用：必须是「候选模板」+ 参考标注，绝不能显示成当前使用
  const pending = describeTemplateStatus(
    { id: 'signature-kitchen' },
    { selectedId: 'warm-bistro', screenRef: { adopted: false, discarded: false, templateId: 'signature-kitchen' } },
  );
  assert.equal(pending.key, 'candidate');
  assert.equal(pending.isReference, true);
  assert.equal(pending.referenceTag, screenReferenceTag());
  assert.match(pending.referenceTag, /参考/);
  assert.match(pending.referenceTag, /候选/);
  assert.match(pending.note, /不会|不影响|切换/);

  // 采用之后：已采用，同时是当前使用
  const adopted = describeTemplateStatus(
    { id: 'signature-kitchen' },
    { selectedId: 'signature-kitchen', screenRef: { adopted: true, discarded: false, templateId: 'signature-kitchen' } },
  );
  assert.equal(adopted.key, 'adopted');
  assert.equal(adopted.label, '已采用');
  assert.equal(adopted.isCurrent, true);
  assert.equal(adopted.referenceTag, '参考截图 · 已采用');

  // 放弃之后：已放弃，且不能算当前使用
  const discarded = describeTemplateStatus(
    { id: 'signature-kitchen' },
    { selectedId: null, screenRef: { adopted: false, discarded: true, templateId: 'signature-kitchen' } },
  );
  assert.equal(discarded.key, 'discarded');
  assert.equal(discarded.label, '已放弃');
  assert.equal(discarded.isCurrent, false);
  assert.match(discarded.note, /没有.*改动|未改动|没有被改动/);

  // 四态文案互不相同，避免用户分不清
  const labels = ['current', 'candidate', 'adopted', 'discarded'].map((key) => {
    const fake = {
      current: { id: 'a' },
      candidate: { id: 'b' },
      adopted: { id: 'c' },
      discarded: { id: 'd' },
    }[key];
    const context = {
      current: { selectedId: 'a' },
      candidate: { selectedId: 'a' },
      adopted: { selectedId: 'c', screenRef: { adopted: true, templateId: 'c' } },
      discarded: { selectedId: null, screenRef: { discarded: true, templateId: 'd' } },
    }[key];
    return describeTemplateStatus(fake, context).label;
  });
  assert.equal(new Set(labels).size, 4);
});

test('L4 演示模板：分类、价格、下单入口齐全，且没有任何外链素材', async () => {
  const { buildPreviewViewModel } = await loadPreview();
  const viewModel = buildPreviewViewModel({ plan: planWith(), layout: 'menu' });

  assert.ok(viewModel.products.length >= 4, '演示状态必须给出可看的菜品');
  viewModel.products.forEach((product) => {
    assert.ok(product.name && product.name.length >= 2, '菜名要有意义，不能是空占位');
    assert.match(product.priceDisplay, /^\d+\.\d{2}$/, '价格必须格式化到分');
    assert.equal(product.thumbnail, 'theme-gradient', '缩略图只用主题渐变，不用外链素材');
  });

  assert.ok(Array.isArray(viewModel.categories) && viewModel.categories.length > 0, '分类条不能空');
  assert.ok(viewModel.categories.every((item) => item.label && item.count > 0));
  assert.equal(viewModel.categories[0].label, '全部', '分类条第一项是「全部」，与「共 N 道」呼应');
  assert.ok(viewModel.cta, '必须有下单入口');
  assert.equal(viewModel.cta.checkout, '去结算');
  assert.match(viewModel.cta.demoNotice, /演示/, '下单入口必须标注演示状态，不能伪装成真实支付');

  // 不允许出现任何外部资源地址：预览不消费未校验的 URL。
  const serialized = JSON.stringify(viewModel);
  assert.doesNotMatch(serialized, /https?:\/\//);
  assert.doesNotMatch(serialized, /cdn\.|unsplash|placeholder\.com/i);
});

test('L5 长店名 / 长菜名 / 多菜品 / 无海报，结构依然完整', async () => {
  const { buildPreviewViewModel } = await loadPreview();

  const longName = '这是一家名字特别长的老字号手工面馆总店（体育馆路分店）';
  const dishes = Array.from({ length: 12 }, (unused, index) => ({
    name: `招牌手工牛肉面加量版第${index + 1}号套餐`,
    priceCents: 1000 + index,
    description: '慢炖牛腩 · 现点现做 · 可选加面加辣',
    category: index % 2 === 0 ? '面食' : '小食',
  }));

  const viewModel = buildPreviewViewModel({
    plan: planWith({ storeProfile: { name: longName, dishes } }),
    layout: 'menu',
  });

  assert.equal(viewModel.store.name, longName, '长店名不能被数据层截断（换行交给样式）');
  assert.equal(viewModel.store.initial, Array.from(longName)[0]);
  assert.equal(viewModel.products.length, 12);
  assert.equal(new Set(viewModel.products.map((product) => product.key)).size, 12, '菜品 key 必须唯一');
  assert.equal(viewModel.products[0].name, dishes[0].name);

  // 真实分类优先：不会凭空出现演示分类
  const labels = viewModel.categories.map((item) => item.label);
  assert.deepEqual(labels, ['全部', '面食', '小食']);
  assert.ok(viewModel.categories.every((item) => item.demo === false));

  // 无海报：没有 home-hero 块时由首屏渐变兜底，不留空白
  assert.equal(viewModel.blocks.length, 0);
  assert.ok(viewModel.hero.title && viewModel.hero.cta, '无海报状态仍然要有首屏标题与入口');
  const previewSource = readSource('src/components/preview/PreviewTabs.jsx');
  assert.match(previewSource, /heroBlock[\s\S]{0,120}<HeroBanner/, '首页必须 hero 块缺失时回落到默认首屏');
});

test('L6 布局不变量：关键容器不横向溢出，长文本换行不撑破', () => {
  const flowCss = readSource('src/styles/flow.css');
  const previewCss = readSource('src/styles/preview.css');

  // 步骤条与模板栅格在窄窗口下换行，而不是撑出横向滚动
  assert.match(flowCss, /\.flow-steps\s*\{[\s\S]{0,400}flex-wrap:\s*wrap/);
  assert.match(flowCss, /\.template-grid\s*\{[\s\S]{0,200}minmax\(220px,\s*1fr\)/);
  assert.match(flowCss, /\.template-meta\s*\{[\s\S]{0,120}flex-wrap:\s*wrap/);

  // 长店名/长菜名允许在任意位置换行
  assert.match(previewCss, /\.mini-phone-head b[\s\S]{0,160}overflow-wrap:\s*anywhere/);
  assert.match(previewCss, /\.mini-product-copy b[\s\S]{0,160}overflow-wrap:\s*anywhere/);
  // 手机预览容器允许收缩，价格不被挤掉
  assert.match(previewCss, /\.mini-phone-body,[\s\S]{0,200}min-width:\s*0/);
  assert.match(previewCss, /\.mini-product-price\s*\{[\s\S]{0,80}white-space:\s*nowrap/);
  // 分类条与下单入口也是自适应布局
  assert.match(previewCss, /\.mini-categories\s*\{[\s\S]{0,200}overflow-x:\s*auto/);
  assert.match(previewCss, /\.mini-order-cta\s*\{[\s\S]{0,200}justify-content:\s*space-between/);

  // 步骤条与状态徽标在组件里带无障碍语义
  const stepper = readSource('src/components/flow/FlowStepper.jsx');
  assert.match(stepper, /aria-label="主流程进度"/);
  assert.match(stepper, /aria-current=\{step\.state === 'current' \? 'step' : undefined\}/);
  assert.match(stepper, /返回修改|返回/);

  const gallery = readSource('src/components/flow/TemplateGallery.jsx');
  assert.match(gallery, /template-status/, '模板卡必须有状态徽标');
  assert.match(gallery, /statusById/, '状态由领域函数算好传入，组件不自己发明状态');
  assert.match(gallery, /template-source is-reference/, '参考来源单独标注');

  // 演示状态标签保留，不被视觉包装掩盖
  const tabs = readSource('src/components/preview/PreviewTabs.jsx');
  assert.match(tabs, /demoNotice/, '下单入口必须展示演示标注');
  assert.match(tabs, /未导出/, '能力未导出状态仍然照实标注');

  // 接线不变量：步骤条只在非构建阶段出现，模板页状态由 App 统一注入
  const app = readSource('src/App.jsx');
  assert.match(app, /<FlowStepper[\s\S]{0,160}flow=\{flowDescriptor\}/);
  assert.match(app, /statusById=\{templateStatus\.byId\}/);
  assert.match(app, /<FlowStepper[\s\S]{0,400}renderStage\(\)/, '步骤条与阶段内容同屏，先看进度再看内容');
});

test('L7 门店资料两分区，菜单图、环境图与参考图入口都直接可见', () => {
  const sections = readSource('src/components/flow/StoreInfoSections.jsx');
  const app = readSource('src/App.jsx');
  const css = readSource('src/styles/store-info-sections.css');

  ['门店经营资料', '风格与图片素材'].forEach((label) => {
    assert.ok(sections.includes(label), `缺少固定分区：${label}`);
  });
  assert.match(sections, /aria-label="门店资料两分区"/);
  ['operations', 'appearance'].forEach((id) => {
    assert.ok(sections.includes(`id: '${id}'`), `缺少分区：${id}`);
  });
  ['store-basic', 'store-dishes', 'store-style', 'store-environment', 'store-reference'].forEach((anchor) => {
    assert.ok(sections.includes(`id: '${anchor}'`), `缺少内部定位锚点：${anchor}`);
  });
  const operationsBlock = sections.slice(sections.indexOf("id: 'operations'"), sections.indexOf("id: 'appearance'"));
  assert.ok(operationsBlock.indexOf("prop: 'basic'") < operationsBlock.indexOf("prop: 'dishes'"), 'operations 必须先渲染 basic 再渲染 dishes');
  const appearanceBlock = sections.slice(sections.indexOf("id: 'appearance'"));
  const appearanceOrder = ["prop: 'style'", "prop: 'environment'", "prop: 'reference'"].map((token) => appearanceBlock.indexOf(token));
  assert.ok(appearanceOrder.every((index) => index > -1), 'appearance 必须包含 style/environment/reference');
  assert.deepEqual([...appearanceOrder].sort((a, b) => a - b), appearanceOrder, 'appearance 顺序必须是 style → environment → reference');
  assert.match(app, /const styleSection = \([\s\S]*?showContact=\{false\}[\s\S]*?onStyleChange=/);
  assert.match(app, /<StoreInfoSections[\s\S]*?basic=\{basicSection\}[\s\S]*?dishes=\{dishesSection\}[\s\S]*?style=\{styleSection\}[\s\S]*?environment=\{environmentSection\}[\s\S]*?reference=\{referenceSection\}/);
  assert.match(app, /kinds=\{\['menu'\]\}/);
  assert.match(app, /onRecognize=\{handleRecognizeMenuImages\}/);
  assert.match(app, /onAnalyzeImage=\{handleAnalyzeStoreImage\}/);
  assert.match(app, /frontendPanel=\{frontendCandidatePanel\}/);
  assert.doesNotMatch(app, /<AttachGroup/);
  assert.match(css, /\.store-info-zone\s*\{[\s\S]{0,200}display:\s*flex/);
});
