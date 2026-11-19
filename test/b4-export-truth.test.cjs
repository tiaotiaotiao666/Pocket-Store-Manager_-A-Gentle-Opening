'use strict';

/**
 * B4：模板选择与导出内容必须符合事实。
 *
 * 覆盖 11 条规则里可直接观测的部分：
 *  1. 候选折叠成真实 Recipe（同结构 = 配色方案，不是新模板）
 *  2. 模板回落不静默（plan.recipeFallback）
 *  3. 未验证 Recipe 不得默认进入正式导出（Composer 结构化拒绝）
 *  4/5. 「最终生成内容」完全从 Plan 派生
 *  6. 体检结果与确认绑定 Plan + 目标签名
 *  7/8. 默认只显示人话；例行披露不再制造「我已了解」
 *  9. Base 与 frontendPack 各自的门禁都还在
 *
 * 不覆盖：微信运行时、GUI 真实走查（见交付报告里的「未验证项」）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const REPO = path.resolve(__dirname, '..');
const composer = require(path.join(REPO, 'scripts', 'composer', 'index.cjs'));
const REGISTRY_ROOT = path.join(REPO, 'templates', 'registry');

let cache = null;
async function load() {
  if (!cache) {
    const imp = (rel) => import(pathToFileURL(path.join(REPO, rel)).href);
    cache = {
      machine: await imp('src/state/sessionMachine.mjs'),
      planner: await imp('src/composition/planFromSession.mjs'),
      groups: await imp('src/domain/templateGroups.mjs'),
      review: await imp('src/domain/exportReview.mjs'),
      signature: await imp('src/domain/planSignature.mjs'),
      rules: await imp('src/domain/preflightRules.mjs'),
    };
  }
  return cache;
}

function baseState(machine, overrides = {}) {
  const state = machine.createInitialState();
  return {
    ...state,
    view: 'flow',
    phase: 'deploy',
    project: { ...state.project, mode: 'desktop', activeId: 'p_12345678abcdef' },
    store: { ...state.store, name: '松月食堂' },
    build: { ...state.build, selectedId: 'warm-bistro' },
    features: { selected: ['scan-order', 'product-catalog', 'cart-checkout'], custom: '' },
    agentDraft: {
      ...state.agentDraft,
      storeName: '松月食堂',
      category: '社区餐馆',
      businessHours: '10:00-21:00',
      fulfillment: { dineIn: true, takeaway: true },
      dishes: [
        { id: 'dish-1', name: '宫保鸡丁', priceCents: 2800, priceText: '28.00', description: '' },
        { id: 'dish-2', name: '番茄炒蛋', priceCents: 1600, priceText: '16.00', description: '' },
      ],
    },
    ...overrides,
  };
}

/** 构造一条「体检已完成」的 preflight 状态。 */
function donePreflight(warns, signature) {
  return {
    status: 'done',
    errors: [],
    warns: warns || [],
    infos: [],
    acknowledged: [],
    planDigest: 'sha256:b4test',
    signature: signature || null,
    recipe: null,
    checkedAt: '2026-11-19T05:00:00Z',
    error: null,
  };
}

test('B4-1 三个候选只对应两套真实结构，同结构候选归为配色方案', async () => {
  const { groups } = await load();
  const structures = groups.listTemplateStructures();
  assert.strictEqual(structures.length, 2, '真实独立结构必须是 2 套');
  const classic = structures.find((item) => item.recipeId === 'order-classic');
  const poster = structures.find((item) => item.recipeId === 'order-poster');
  assert.deepStrictEqual(classic.members.map((item) => item.id), ['warm-bistro', 'modern-coffee']);
  assert.strictEqual(classic.isColorScheme, true);
  assert.deepStrictEqual(poster.members.map((item) => item.id), ['signature-kitchen']);
  assert.strictEqual(poster.isColorScheme, false);

  // 同结构候选：明确说成「经典点餐的配色方案」，不是第三套模板。
  const shared = groups.describeTemplateStructure('modern-coffee');
  assert.strictEqual(shared.recipeId, 'order-classic');
  assert.strictEqual(shared.shared, true);
  assert.match(shared.badge, /经典点餐/);
  assert.match(shared.badge, /配色方案/);
  assert.match(shared.note, /配色/);

  const solo = groups.describeTemplateStructure('signature-kitchen');
  assert.strictEqual(solo.shared, false);
  assert.doesNotMatch(solo.badge, /配色方案/);

  const coverage = groups.describeStructureCoverage(['warm-bistro', 'modern-coffee', 'signature-kitchen']);
  assert.strictEqual(coverage.structureCount, 2);
  assert.match(coverage.text, /真实独立结构 2 套/);
  assert.match(coverage.text, /两种配色/);
  assert.match(coverage.text, /不算额外模板/);
  // 只展示同结构的两个候选时，也不能暗示有两套结构。
  assert.strictEqual(groups.describeStructureCoverage(['warm-bistro', 'modern-coffee']).structureCount, 1);
});

test('B4-1 模板页文案不再把同结构候选说成两套骨架', () => {
  const gallery = fs.readFileSync(path.join(REPO, 'src', 'components', 'flow', 'TemplateGallery.jsx'), 'utf8');
  // 只看对用户可见的文案：注释里解释「为什么不能说两套骨架」不算违规。
  const shipped = gallery.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(shipped, /两套骨架|三套骨架|第三套模板/);
  assert.match(gallery, /describeStructureCoverage/);
  assert.match(gallery, /describeTemplateStructure/);
  assert.match(gallery, /template-structure-hint/);
  assert.match(gallery, /structure\.badge \|\| recipeName/);
});

test('B4-2 模板回落写进 plan.recipeFallback：记录原请求、实际 Recipe 与原因', async () => {
  const { machine, planner } = await load();
  const state = baseState(machine);
  state.build = { ...state.build, selectedId: 'ghost-template' };
  const built = planner.buildPlanFromSession(state);
  assert.ok(built.plan.recipeFallback, '发生回落时必须留痕');
  assert.strictEqual(built.plan.recipeFallback.requestedTemplateId, 'ghost-template');
  assert.strictEqual(built.plan.recipeFallback.recipeId, 'order-classic');
  assert.ok(built.plan.recipeFallback.recipeDisplayName.length > 0);
  assert.match(built.plan.recipeFallback.reason, /回落/);
  assert.ok(built.warnings.some((item) => item.includes('回落')), '回落必须同时进警告');
  assert.strictEqual(built.recipeFallback.recipeId, 'order-classic');

  // 没有回落时不写这个字段，Plan 形状与旧存档一致。
  const normal = planner.buildPlanFromSession(baseState(machine));
  assert.strictEqual('recipeFallback' in normal.plan, false);
  assert.strictEqual(normal.recipeFallback, null);
});

test('B4-2 recipeFallback 不破坏契约校验，仍能通过 Composer 校验闸', async () => {
  const { machine, planner } = await load();
  const state = baseState(machine);
  state.build = { ...state.build, selectedId: 'ghost-template' };
  const built = planner.buildPlanFromSession(state);
  const result = composer.validateComposition(built.plan);
  assert.strictEqual(result.ok, true, result.ok ? '' : `${result.code}: ${result.message}`);
  assert.strictEqual(result.recipe.stage, 'direct');
  assert.strictEqual(result.recipe.deliverable, true);
});

test('B4-3 注册表里未验证的配方不得进入正式导出：Composer 结构化拒绝', async () => {
  const { machine, planner } = await load();
  const built = planner.buildPlanFromSession(baseState(machine));
  const candidates = [['order-warm-home', '1.0.0'], ['order-classic-candidate', '0.1.0']];
  for (const [planId, planVersion] of candidates) {
    const result = composer.validateComposition({ ...built.plan, planId, planVersion });
    assert.strictEqual(result.ok, false, `${planId} 必须被拒绝`);
    assert.strictEqual(result.code, 'RECIPE_STAGE_NOT_DELIVERABLE');
    assert.strictEqual(result.details.stage, 'candidate');
    assert.strictEqual(result.details.recipeId, planId);
    assert.match(result.message, /还没有通过正式交付校验/);
  }
  // 已验证配方照常通过，新闸不误伤正式交付。
  const okResult = composer.validateComposition(built.plan);
  assert.strictEqual(okResult.ok, true, okResult.ok ? '' : okResult.code);
  assert.strictEqual(okResult.recipe.deliverable, true);
  // 资产本身没有被删除或改写：未验证的配方仍在注册表里如实标注 candidate。
  for (const [planId, planVersion] of candidates) {
    const dir = path.join(REPO, 'templates', 'recipes', planId, planVersion);
    assert.ok(fs.existsSync(path.join(dir, 'recipe.json')), `${planId}@${planVersion} 资产必须保留`);
  }
});

test('B4-3 候选验证上下文可以组合 candidate 配方，但结果必须自我标注不可交付', async () => {
  const { machine, planner } = await load();
  const built = planner.buildPlanFromSession(baseState(machine));
  const plan = { ...built.plan, planId: 'order-warm-home', planVersion: '1.0.0', previewOnlyAck: true };
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'b4-recipe-gate-'));
  try {
    const verify = await composer.compose({
      plan,
      parentDir: tmpRoot,
      projectName: 'b4-candidate-verify',
      mode: 'development',
      registryRoot: REGISTRY_ROOT,
      assetRoots: [REPO],
    });
    assert.strictEqual(verify.ok, true, verify.ok ? '' : `${verify.code}: ${verify.message}`);
    assert.strictEqual(verify.recipe.stage, 'candidate');
    assert.strictEqual(verify.recipe.deliverable, false);
    assert.strictEqual(verify.recipeDeliverable, false);

    // 正式模式即使给了 overlay 也不许拿 candidate 配方出工程。
    const formal = await composer.compose({
      plan,
      parentDir: tmpRoot,
      projectName: 'b4-candidate-formal',
      mode: 'production',
      registryRoot: REGISTRY_ROOT,
      assetRoots: [REPO],
    });
    assert.strictEqual(formal.ok, false);
    assert.strictEqual(formal.code, 'RECIPE_STAGE_NOT_DELIVERABLE');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('B4-6 体检结果绑定签名：资料、素材或目标一变旧结果立即失效', async () => {
  const { machine, planner, signature } = await load();
  const state = baseState(machine);
  const plan = planner.buildPlanFromSession(state).plan;
  const target = { directory: 'C:\\out', projectName: 'songyue' };
  const parts = signature.buildSignatureParts({ plan, posterAssetId: null, ...target });
  const withPreflight = { ...state, deploy: { ...state.deploy, preflight: donePreflight([], parts) } };
  assert.strictEqual(machine.selectCanExport(withPreflight, parts.signature).can, true);

  // 少一道菜 → 签名变 → 旧的「可以导出」失效。
  const fewerDishes = {
    ...plan,
    storeProfile: { ...plan.storeProfile, dishes: plan.storeProfile.dishes.slice(1) },
  };
  const changedPlan = signature.buildSignatureParts({ plan: fewerDishes, posterAssetId: null, ...target });
  assert.notStrictEqual(changedPlan.signature, parts.signature);
  const staleGate = machine.selectCanExport(withPreflight, changedPlan.signature);
  assert.strictEqual(staleGate.can, false);
  assert.strictEqual(staleGate.stale, true);
  assert.match(staleGate.reason, /重新体检/);
  assert.strictEqual(machine.selectCanChooseDirectory(withPreflight, changedPlan.signature).can, false);

  // 换导出位置同样失效（不用等 Plan 变）。
  const movedTarget = signature.buildSignatureParts({ plan, posterAssetId: null, directory: 'D:\\other', projectName: 'songyue' });
  assert.notStrictEqual(movedTarget.signature, parts.signature);
  assert.strictEqual(machine.selectCanChooseDirectory(withPreflight, movedTarget.signature).stale, true);

  // 换海报素材同样失效。
  const withPoster = signature.buildSignatureParts({ plan, posterAssetId: 'a_3f9c1d7e5b2a8406', ...target });
  assert.notStrictEqual(withPoster.signature, parts.signature);

  // 过期的原因要说人话，且指得出是哪一类变了。
  assert.match(signature.describeSignatureDrift(changedPlan, parts) || '', /资料/);
  assert.match(signature.describeSignatureDrift(movedTarget, parts) || '', /位置|目录/);
});

test('B4-8 缺 AppID 这类披露不再制造「我已了解」，只有真不交付的能力要确认', async () => {
  const { machine } = await load();
  const state = baseState(machine);
  const disclosure = [
    { ruleId: 'W-NO-APPID', level: 'warn', requiresAck: false, message: '还没有填 AppID，这次只生成体验版工程' },
    { ruleId: 'W-BASE-FEATURE-UNCHECKED', level: 'warn', requiresAck: false, message: '堂食由基础模板自带' },
    { ruleId: 'W-VERSION-GAP', level: 'warn', requiresAck: false, message: '工程依赖较旧' },
  ];
  const onlyDisclosure = { ...state, deploy: { ...state.deploy, preflight: donePreflight(disclosure) } };
  assert.strictEqual(machine.selectCanExport(onlyDisclosure).can, true, '纯披露不该挡住导出');

  const withUnmapped = {
    ...onlyDisclosure,
    deploy: {
      ...onlyDisclosure.deploy,
      preflight: donePreflight([
        ...disclosure,
        { ruleId: 'W-UNMAPPED-FEATURE', level: 'warn', requiresAck: true, message: '「扫码点单」这次不会生成' },
      ]),
    },
  };
  const gate = machine.selectCanExport(withUnmapped);
  assert.strictEqual(gate.can, false);
  assert.match(gate.reason, /1 项提示需要确认/);

  // 勾了之后放行。
  const acknowledged = {
    ...withUnmapped,
    deploy: {
      ...withUnmapped.deploy,
      preflight: { ...withUnmapped.deploy.preflight, acknowledged: ['W-UNMAPPED-FEATURE'] },
    },
  };
  assert.strictEqual(machine.selectCanExport(acknowledged).can, true);
});

test('B4-4/5 最终生成内容确认卡直接从 Plan 派生，与导出内容一致', async () => {
  const { machine, planner, review } = await load();
  const plan = planner.buildPlanFromSession(baseState(machine)).plan;
  const view = review.buildExportReview({
    plan,
    baselinePlan: plan,
    templateId: 'warm-bistro',
    styleName: '暖橙',
    target: { directory: 'C:\\out', projectName: 'songyue' },
    poster: { included: true },
    unmappedCapabilities: [],
  });
  assert.strictEqual(view.ok, true);
  assert.match(view.headline, /这就是将要生成的内容/);

  const rowOf = (sectionId, labelPart) => {
    const section = view.sections.find((item) => item.id === sectionId);
    assert.ok(section, `缺少 ${sectionId} 分区`);
    const row = section.rows.find((item) => item.label.includes(labelPart));
    assert.ok(row, `缺少「${labelPart}」一行`);
    return row;
  };

  assert.match(rowOf('store', '店名').value, /松月食堂/);
  assert.match(rowOf('store', '菜单').value, /^2 道/);
  assert.match(rowOf('store', '菜单').value, /宫保鸡丁/);
  assert.match(rowOf('store', '营业时段').value, /10:00/);
  assert.match(rowOf('template', '页面结构').value, /经典点餐/);
  assert.match(rowOf('template', '入口模板').value, /配色方案/);
  assert.match(rowOf('output', '生成位置').value, /songyue/);
  assert.match(view.disclaimers.join(' '), /仅生成本地工程/);
  assert.match(view.disclaimers.join(' '), /不上传/);
  assert.match(view.disclaimers.join(' '), /不产生真实支付/);
  assert.strictEqual(view.technical.baseTemplate, `${plan.baseTemplate.id}@${plan.baseTemplate.version}`);
  assert.strictEqual(view.technical.dishCount, plan.storeProfile.dishes.length);

  // 同一份 Plan 少一道菜 → 确认卡同步变化，不存在第二份数据副本。
  const fewer = review.buildExportReview({
    plan: { ...plan, storeProfile: { ...plan.storeProfile, dishes: plan.storeProfile.dishes.slice(0, 1) } },
    templateId: 'warm-bistro',
  });
  assert.match(fewer.sections.find((item) => item.id === 'store').rows
    .find((item) => item.label.includes('菜单')).value, /^1 道/);

  // 没有 Plan 时不编造内容。
  assert.strictEqual(review.buildExportReview({ plan: null }).ok, false);
});

test('B4-4 确认卡如实写明回落原因、不生成的能力和候选运行时状态', async () => {
  const { machine, planner, review } = await load();
  const plan = planner.buildPlanFromSession(baseState(machine)).plan;
  const view = review.buildExportReview({
    plan: {
      ...plan,
      recipeFallback: {
        requestedTemplateId: 'ghost-template',
        recipeId: 'order-classic',
        recipeDisplayName: '经典点餐',
        reason: '「ghost-template」没有对应的正式 Recipe，已回落到「经典点餐」。',
      },
    },
    templateId: 'ghost-template',
    unmappedCapabilities: ['scan-order'],
    frontendCandidate: { candidateId: 'cand_b4test', status: 'partial', runtimeStatus: 'NOT_RUN' },
    recipeStage: { stage: 'candidate', displayName: '经典点餐', wechatCompile: false },
    target: { directory: 'C:\\out', projectName: 'songyue' },
  });
  const templateRows = view.sections.find((item) => item.id === 'template').rows;
  const fallbackRow = templateRows.find((item) => item.label.includes('回落'));
  assert.ok(fallbackRow, '回落必须写在确认卡上');
  assert.match(fallbackRow.value, /ghost-template/);
  assert.match(fallbackRow.value, /经典点餐/);
  assert.strictEqual(fallbackRow.tone, 'warn');

  const scopeRows = view.sections.find((item) => item.id === 'scope').rows;
  const excluded = scopeRows.find((item) => item.label.includes('不包含') || item.label.includes('不会'));
  assert.ok(excluded, '必须写清这次不生成什么');
  assert.match(excluded.value, /不会生成|扫码/);

  const outputRows = view.sections.find((item) => item.id === 'output').rows;
  const candidateRow = outputRows.find((item) => item.label.includes('参考候选'));
  assert.ok(candidateRow, '有候选时必须说明它的运行时状态');
  assert.match(candidateRow.value, /未执行|NOT_RUN|验证/);
});

test('B4-7 体检面板默认只显示人话，ruleId/fieldPath 收进「技术详情」', () => {
  const panel = fs.readFileSync(path.join(REPO, 'src', 'components', 'deploy', 'PreflightPanel.jsx'), 'utf8');
  const techIndex = panel.indexOf('<summary>技术详情</summary>');
  assert.ok(techIndex > 0, '技术详情入口必须存在');
  assert.ok(panel.indexOf('<code>Plan 摘要</code>') > techIndex, 'Plan 摘要必须只在技术详情里');
  assert.doesNotMatch(panel, /\{rule\.ruleId\}<\/span>/, '默认行不再直接摆 ruleId');
  assert.match(panel, /rule\.message/);
  // 默认行先给后果说明、再给动作，不只给规则名。
  assert.match(panel, /rule\.consequence/);
});

test('B4-9 Base 与 frontendPack 各自的门禁都还在，没有被新闸放宽', async () => {
  const { machine, planner } = await load();
  const plan = planner.buildPlanFromSession(baseState(machine)).plan;
  // 纯 Base 导出：通过。
  assert.strictEqual(composer.validateComposition(plan).ok, true);
  // 带 frontendPack 但没有候选 overlay：结构化拒绝，不静默回落 Base。
  const packed = composer.validateComposition({ ...plan, frontendPack: { id: 'fp-missing-b4', version: '1.0.0' } });
  assert.strictEqual(packed.ok, false);
  assert.strictEqual(packed.code, 'FRONTEND_PACK_MISSING');
  // 未验证配方同理：拒绝码不同，但都不是「假装成功」。
  const candidate = composer.validateComposition({ ...plan, planId: 'order-warm-home', planVersion: '1.0.0' });
  assert.strictEqual(candidate.ok, false);
  assert.strictEqual(candidate.code, 'RECIPE_STAGE_NOT_DELIVERABLE');
});
