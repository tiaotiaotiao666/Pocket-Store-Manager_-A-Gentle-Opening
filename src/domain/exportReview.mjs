/**
 * 「最终生成内容」确认卡的视图模型（B4 规则 4、5）。
 *
 * 唯一要求：**所有事实都从当前这一份 CompositionPlan（以及同一份权威会话状态）派生**，
 * 不另抄一套数据。界面拿到的是纯数据，渲染层只负责排版。
 *
 * 因此这里没有常量表里的店名/菜品/时间，也没有第二份「导出配置」：
 * - 店铺、菜单、营业时段 → `plan.storeProfile`
 * - 模板与配色 → `plan.planId/planVersion` + `plan.themeTokens` + `plan.presentationTokens`
 * - 页面与能力 → `plan.pages` / `plan.features`
 * - 已采用修改 → 与「同一 builder 生成、但未带展示补丁」的基线 Plan 做差
 * - 回落与候选状态 → `plan.recipeFallback` / 候选摘要（主进程判定结果）
 */

import { describeHoursSegment } from './businessHours.mjs';
import { BASE_CAPABILITIES } from './capabilities.mjs';
import { features as catalogFeatures } from './catalog.mjs';
import { describeRecipe } from './recipeCatalog.mjs';
import { describeTemplateStructure } from './templateGroups.mjs';

/** 页面显示名（只影响文案，事实仍来自 `plan.pages`）。 */
const PAGE_LABELS = Object.freeze({
  home: '首页',
  menu: '菜单',
  orders: '订单列表',
  'order-detail': '订单详情',
  checkout: '下单页',
  'product-detail': '菜品详情',
  mine: '我的',
  'merchant-orders': '商家订单',
});

const HERO_SIZE_LABELS = Object.freeze({ sm: '小', md: '中', lg: '大' });

function text(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function capabilityLabel(id) {
  const found = catalogFeatures.find((item) => item.id === id);
  return found ? found.label : id;
}

function pageLabel(pageId) {
  return PAGE_LABELS[pageId] || pageId;
}

function summarizeDishes(dishes) {
  const list = Array.isArray(dishes) ? dishes : [];
  const names = list.map((dish) => text(dish && dish.name)).filter(Boolean);
  if (names.length === 0) return { count: 0, value: '一道菜都没有（导出会得到空菜单）' };
  const shown = names.slice(0, 6).join('、');
  const suffix = names.length > 6 ? ` 等 ${names.length} 道` : '';
  return { count: names.length, value: `${names.length} 道：${shown}${suffix}` };
}

function summarizeHours(segments) {
  const list = Array.isArray(segments) ? segments : [];
  const described = list.map((segment) => describeHoursSegment(segment)).filter(Boolean);
  if (described.length === 0) return '没有可用的营业时间';
  return described.join('，');
}

function summarizeFulfillment(fulfillment) {
  const source = fulfillment && typeof fulfillment === 'object' ? fulfillment : {};
  if (source.dineIn && source.takeaway) return '堂食 + 自取';
  if (source.dineIn) return '仅堂食';
  if (source.takeaway) return '仅自取';
  return '未选择取餐方式';
}

function describeRuntime(runtimeStatus) {
  if (runtimeStatus === 'PASS') return '微信运行时验证通过';
  if (runtimeStatus === 'FAIL') return '微信运行时验证未通过';
  if (runtimeStatus === 'PARTIAL') return '微信运行时验证只完成了一部分';
  return '微信运行时验证未执行（如实标注）';
}

/** 与基线 Plan 做差，得到「已采用的修改」；两边都来自同一个 builder。 */
export function diffPlans(baseline, current) {
  const changes = [];
  if (!baseline || !current) return changes;
  const before = baseline.themeTokens || {};
  const after = current.themeTokens || {};
  Object.keys({ ...before, ...after }).sort().forEach((key) => {
    const left = before[key];
    const right = after[key];
    if (left === right) return;
    changes.push({ label: `配色 ${key}`, before: left == null ? '默认' : String(left), after: right == null ? '默认' : String(right) });
  });
  const beforeSize = baseline.presentationTokens || {};
  const afterSize = current.presentationTokens || {};
  // 尺寸用中文说话；两边映射后相同就不算「已采用修改」（避免 中 → md 这种假变化）。
  const sizeLabel = (value) => (value ? (HERO_SIZE_LABELS[value] || String(value)) : '中');
  ['homeHeroSize', 'productCardSize'].forEach((key) => {
    const left = beforeSize[key];
    const right = afterSize[key];
    if (!left && !right) return;
    const beforeLabel = sizeLabel(left);
    const afterLabel = sizeLabel(right);
    if (beforeLabel === afterLabel) return;
    const label = key === 'homeHeroSize' ? '首页大图尺寸' : '菜品卡尺寸';
    changes.push({ label, before: beforeLabel, after: afterLabel });
  });
  const slotIds = (plan) => (Array.isArray(plan.slotOrder) ? plan.slotOrder.map((slot) => `${slot.pageId}/${slot.slotId}`).join(' → ') : '');
  if (slotIds(baseline) !== slotIds(current)) {
    changes.push({ label: '区块顺序', before: slotIds(baseline) || '模板默认', after: slotIds(current) || '模板默认' });
  }
  const carouselSize = (plan) => {
    const features = Array.isArray(plan.features) ? plan.features : [];
    const feature = features.find((item) => item && item.id === 'poster-carousel');
    const slot = feature && Array.isArray(feature.slots) ? feature.slots[0] : null;
    return slot && slot.props && slot.props.size ? slot.props.size : '';
  };
  if (carouselSize(baseline) !== carouselSize(current)) {
    changes.push({ label: '海报轮播尺寸', before: carouselSize(baseline) || '默认', after: carouselSize(current) || '默认' });
  }
  return changes;
}

/**
 * 生成「最终生成内容」确认数据。
 *
 * @param {object} input
 * @param {object} input.plan 即将导出的 Plan（唯一事实来源）
 * @param {object|null} [input.baselinePlan] 未带展示补丁的基线 Plan，用来算「已采用修改」
 * @param {string|null} [input.templateId] 当前选中的模板入口（权威会话状态）
 * @param {string|null} [input.styleName] 当前装修风格名（权威会话状态）
 * @param {{directory?: string|null, projectName?: string|null, defaultDirectory?: string|null}} [input.target]
 * @param {{included?: boolean, reason?: string|null}|null} [input.poster]
 * @param {object|null} [input.frontendCandidate] 参考候选与运行时状态
 * @param {object|null} [input.recipeStage] Composer/注册表给出的配方状态（若已拿到）
 * @param {string[]} [input.warnings] Plan 构建阶段的提示
 */
export function buildExportReview(input) {
  const source = input || {};
  const plan = source.plan && typeof source.plan === 'object' ? source.plan : null;
  if (!plan) {
    return {
      ok: false,
      emptyReason: '还没有可以导出的内容，请先完成前面的步骤。',
      sections: [],
      disclaimers: [],
      technical: {},
    };
  }
  const profile = plan.storeProfile && typeof plan.storeProfile === 'object' ? plan.storeProfile : {};
  const recipe = describeRecipe(plan.planId);
  const structure = describeTemplateStructure(source.templateId);
  const dishes = summarizeDishes(profile.dishes);
  const pages = (Array.isArray(plan.pages) ? plan.pages : []).map((page) => pageLabel(page.pageId));
  const deliveredFeatures = (Array.isArray(plan.features) ? plan.features : []).map((feature) => feature && feature.id).filter(Boolean);
  const unmapped = Array.isArray(source.unmappedCapabilities) ? source.unmappedCapabilities : [];
  const changes = diffPlans(source.baselinePlan, plan);

  const storeRows = [
    { label: '店名', value: text(profile.name, '我的餐馆') },
    { label: '营业时段', value: summarizeHours(profile.businessHours) },
    { label: '菜单', value: dishes.value },
    { label: '取餐方式', value: summarizeFulfillment(profile.fulfillment) },
  ];

  const templateRows = [
    { label: '页面结构（Recipe）', value: `${recipe.displayName}（${recipe.id}@${recipe.version}）` },
    { label: '入口模板', value: structure.badge ? `${structure.badge}${structure.shared ? '（与同组候选共用同一结构）' : ''}` : '默认结构' },
    { label: '配色', value: `${text(source.styleName, '默认风格')}${plan.themeTokens && plan.themeTokens.primary ? `（主色 ${plan.themeTokens.primary}）` : ''}` },
    {
      label: '已采用修改',
      value: changes.length === 0 ? '没有额外改动，按模板默认生成' : changes.map((item) => `${item.label} ${item.before} → ${item.after}`).join('；'),
    },
  ];
  if (plan.recipeFallback) {
    const fallback = plan.recipeFallback;
    templateRows.push({
      label: '模板回落',
      value: `原请求「${fallback.requestedTemplateId || '未指定'}」→ 实际用「${fallback.recipeDisplayName || recipe.displayName}」。${text(fallback.reason)}`,
      tone: 'warn',
    });
  }
  if (source.recipeStage && source.recipeStage.stage) {
    const stage = source.recipeStage;
    templateRows.push({
      label: '配方交付状态',
      value: `${stage.stage}${stage.wechatCompile ? `（微信编译：${stage.wechatCompile}）` : ''}${stage.verifiedAt ? `，验证于 ${String(stage.verifiedAt).slice(0, 10)}` : ''}`,
    });
  }

  const scopeRows = [
    { label: '包含页面', value: pages.length > 0 ? pages.join('、') : '没有页面' },
    {
      label: '会生成的能力',
      value: deliveredFeatures.length > 0
        ? deliveredFeatures.map((id) => (BASE_CAPABILITIES.has(id) ? capabilityLabel(id) : `${capabilityLabel(id)}（模板特有能力）`)).join('、')
        : '只有基础上架页面，没有额外能力',
    },
    {
      label: '不包含 / 未实现',
      value: [
        unmapped.length > 0 ? `你勾选但本版不会生成的：${unmapped.map((item) => (typeof item === 'string' ? capabilityLabel(item) : capabilityLabel(item && item.id))).join('、')}` : null,
        '真实支付与交易（仅演示支付）',
        '自动上传、发布与提交审核',
        'AI 生成整站前端（当前只有海报素材走第三方生图服务）',
      ].filter(Boolean).join('；'),
      tone: unmapped.length > 0 ? 'warn' : null,
    },
  ];

  const target = source.target && typeof source.target === 'object' ? source.target : {};
  const directory = text(target.directory);
  const projectName = text(target.projectName);
  const targetText = directory
    ? `${directory}${projectName ? `\\${projectName}` : ''}`
    : (target.defaultDirectory
      ? `默认位置：${target.defaultDirectory}${projectName ? `\\${projectName}` : ''}`
      : '还没有可用的导出位置');
  const poster = source.poster && typeof source.poster === 'object' ? source.poster : null;
  const candidate = source.frontendCandidate && typeof source.frontendCandidate === 'object' ? source.frontendCandidate : null;

  const outputRows = [
    { label: '生成位置', value: targetText },
    {
      label: '海报素材',
      value: poster && poster.included
        ? '会进入工程（首页背景图）'
        : text(poster && poster.reason, '不进工程；基础页面照常生成'),
    },
    {
      label: '参考候选（候选前端）',
      value: candidate && candidate.candidateId
        ? `${candidate.candidateId}@${candidate.candidateVersion || '?'}，${describeRuntime(candidate.runtimeStatus)}`
        : '本次没有使用参考候选，页面来自 Base 模板',
      tone: candidate && candidate.runtimeStatus && candidate.runtimeStatus !== 'PASS' ? 'warn' : null,
    },
  ];

  const warnings = Array.isArray(source.warnings) ? source.warnings.filter((item) => typeof item === 'string' && item.trim()) : [];

  return {
    ok: true,
    headline: '这就是将要生成的内容',
    sections: [
      { id: 'store', title: '店铺与菜单', rows: storeRows },
      { id: 'template', title: '模板与配色', rows: templateRows },
      { id: 'scope', title: '包含什么、不含什么', rows: scopeRows },
      { id: 'output', title: '生成位置与素材', rows: outputRows },
    ],
    disclaimers: ['仅生成本地工程：不上传、不发布、不产生真实支付。'],
    notes: warnings,
    technical: {
      planId: plan.planId || null,
      planVersion: plan.planVersion || null,
      registryVersion: plan.registryVersion || null,
      schemaVersion: plan.schemaVersion || null,
      baseTemplate: plan.baseTemplate ? `${plan.baseTemplate.id}@${plan.baseTemplate.version}` : null,
      frontendPack: plan.frontendPack ? `${plan.frontendPack.id}@${plan.frontendPack.version}` : null,
      recipeFallback: plan.recipeFallback || null,
      dishCount: dishes.count,
      pageCount: pages.length,
      featureIds: deliveredFeatures,
      changes,
    },
  };
}
