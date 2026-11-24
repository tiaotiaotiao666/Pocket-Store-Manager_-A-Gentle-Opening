/**
 * 导出前体检规则（纯函数）。
 *
 * 先跑本地静态规则，再（无 error 时）调用 Composer 的 validateComposition（P0–P2，不写盘）。
 * 规则 ID 与判定口径见实现方案 6.3.1。
 */

import { BASE_CAPABILITIES } from './capabilities.mjs';
import { features as catalogFeatures } from './catalog.mjs';
import { countUsableSegments, parseHoursText, validateHoursSegments } from './businessHours.mjs';
import { MAX_DISHES, MIN_DISHES } from './storeLimits.mjs';
import { STORE_NAME_LEGACY_MAX_LENGTH } from './storeName.mjs';

// 导出口径走「老数据兼容上限」：历史项目里超过 20 字的店名不能因为体检而被判失败，
// 否则老项目连打开后导出都做不了。新输入的 20 字规则在 storeName.mjs / 输入框里生效。
const MAX_STORE_NAME = STORE_NAME_LEGACY_MAX_LENGTH;
const MIN_PRICE_CENTS = 1;
const MAX_PRICE_CENTS = 999999;
const APPID_RE = /^wx[0-9a-f]{16}$/;

/** Base 内置、但属于"可选"的能力：不勾选也不会从导出工程里消失。 */
const OPTIONAL_BASE_CAPABILITY_IDS = Object.freeze([
  'table-dining',
  'takeaway',
  'merchant-orders',
  'product-availability',
  'store-profile',
]);

function featureLabel(id) {
  return catalogFeatures.find((feature) => feature.id === id)?.label || id;
}

/**
 * @param {string} ruleId 技术标识（只在「技术详情」里展示）
 * @param {'error'|'warn'|'info'} level
 * @param {string} message 用户可读的一句话
 * @param {string|null} fieldPath 技术定位（只在「技术详情」里展示）
 * @param {{label?: string, phase?: string}|null} action 可执行动作
 * @param {{requiresAck?: boolean, consequence?: string}} [extra]
 *   `requiresAck:false` = 只是披露，不要让用户例行点「我已了解」（B4 规则 8）；
 *   `consequence` = 用户真正要承担的后果，和 message 分开显示。
 */
function rule(ruleId, level, message, fieldPath, action, extra) {
  const options = extra && typeof extra === 'object' ? extra : {};
  return {
    ruleId,
    level,
    message,
    fieldPath: fieldPath || null,
    action: action || null,
    requiresAck: options.requiresAck !== false,
    ...(options.consequence ? { consequence: options.consequence } : {}),
  };
}

function codePointLength(value) {
  return Array.from(String(value || '')).length;
}

/**
 * @param {object} state 会话状态
 * @param {{devtoolsDetected?: boolean}} options
 */
export function evaluateLocal(state, options) {
  const errors = [];
  const warns = [];
  const infos = [];
  const opts = options || {};
  const draft = state.agentDraft || {};
  const store = state.store || {};
  const project = state.project || {};
  const deploy = state.deploy || {};

  const planName = String(store.name || draft.storeName || '').trim();
  if (!planName) {
    errors.push(rule('E-PLAN-NAME', 'error', '还没有店名，导出时会回落成「我的餐馆」。请先填写店名。', 'store.name', { label: '去填写店名', phase: 'store-info' }));
  } else if (codePointLength(planName) > MAX_STORE_NAME) {
    errors.push(rule('E-PLAN-NAME', 'error', `店名超过 ${MAX_STORE_NAME} 个字，请缩短。`, 'store.name', { label: '去修改店名', phase: 'store-info' }));
  }

  const dishes = Array.isArray(draft.dishes) ? draft.dishes : [];
  const validDishes = dishes.filter((dish) => dish && String(dish.name || '').trim() && Number.isInteger(dish.priceCents));
  if (validDishes.length < MIN_DISHES) {
    errors.push(rule(
      'E-PLAN-DISHES',
      'error',
      `有效菜品只有 ${validDishes.length} 道（至少 ${MIN_DISHES} 道，最多 ${MAX_DISHES} 道；菜名与整数价格都要填）。`,
      'agentDraft.dishes',
      { label: '去补充菜单', phase: 'store-info' },
    ));
  } else if (validDishes.length > MAX_DISHES) {
    errors.push(rule('E-PLAN-DISHES', 'error', `菜品超过 ${MAX_DISHES} 道，请删减。`, 'agentDraft.dishes', { label: '去删减菜品', phase: 'store-info' }));
  }

  dishes.forEach((dish, index) => {
    if (!dish || dish.priceCents === null || dish.priceCents === undefined) return;
    if (!Number.isInteger(dish.priceCents) || dish.priceCents < MIN_PRICE_CENTS || dish.priceCents > MAX_PRICE_CENTS) {
      errors.push(rule(
        'E-PLAN-PRICE',
        'error',
        `第 ${index + 1} 道菜「${dish.name || '未命名'}」的价格必须是 0.01–9999.99 元之间的整数分。`,
        `agentDraft.dishes[${index}].priceCents`,
        { label: '去修改价格', phase: 'store-info' },
      ));
    }
  });

  // 营业时间与编辑器、领域校验共用一套口径（businessHours.mjs）：跨午夜算一个时段。
  const hoursSegments = parseHoursText(String(draft.businessHours || ''));
  if (countUsableSegments(hoursSegments) === 0) {
    errors.push(rule('E-PLAN-HOURS', 'error', '还没有可用的营业时间（需要开始和结束时间），导出后会显示为空。', 'agentDraft.businessHours', { label: '去填写营业时间', phase: 'store-info' }));
  } else {
    for (const problem of validateHoursSegments(hoursSegments)) {
      errors.push(rule(
        'E-PLAN-HOURS',
        'error',
        problem.message,
        'agentDraft.businessHours',
        { label: '去修改营业时间', phase: 'store-info' },
      ));
    }
  }

  if (!draft.fulfillment || (!draft.fulfillment.dineIn && !draft.fulfillment.takeaway)) {
    errors.push(rule('E-PLAN-FULFILLMENT', 'error', '取餐方式至少选择堂食或到店自取其中一种。', 'agentDraft.fulfillment', { label: '去选择取餐方式', phase: 'store-info' }));
  }

  const appid = String(project.appid || '').trim();
  if (appid && !APPID_RE.test(appid)) {
    errors.push(rule('E-APPID-FORMAT', 'error', 'AppID 格式不正确（wx + 16 位十六进制），后置写入会失败。', 'appid', { label: '去填写 AppID', phase: 'deploy' }));
  }

  if (project.mode === 'browser') {
    errors.push(rule('E-DESKTOP-REQUIRED', 'error', '浏览器预览不能写出小程序工程，请在桌面应用中导出。', null, null));
  }

  const selected = Array.isArray(state.features && state.features.selected) ? state.features.selected : [];
  const unmapped = selected.filter((id) => !BASE_CAPABILITIES.has(id));
  if (unmapped.length > 0) {
    // 这是唯一需要用户确认后果的一类：他自己勾了，但这次真的不会交付。
    warns.push(rule(
      'W-UNMAPPED-FEATURE',
      'warn',
      `你勾选的「${unmapped.map(featureLabel).join('、')}」这次不会生成。`,
      'features.selected',
      null,
      { requiresAck: true, consequence: '当前模板没有这些能力对应的资产；导出的小程序里不会有它们，需要额外开发或换模板。' },
    ));
  }

  // 反向披露：Base 自带的页面/组件不因取消勾选而消失。
  // 只在用户真的做过勾选时提示，避免首次进入就报噪音。
  // 这是「说明」而不是「后果」，不再要求逐条点「我已了解」（B4 规则 8）。
  if (selected.length > 0) {
    const unselectedBase = OPTIONAL_BASE_CAPABILITY_IDS.filter((id) => !selected.includes(id));
    if (unselectedBase.length > 0) {
      warns.push(rule(
        'W-BASE-FEATURE-UNCHECKED',
        'warn',
        `「${unselectedBase.map(featureLabel).join('、')}」由基础模板自带，不勾选也仍在导出工程里。`,
        'features.selected',
        { label: '去确认能力勾选', phase: 'features' },
        { requiresAck: false },
      ));
    }
  }

  if (dishes.length !== validDishes.length) {
    warns.push(rule(
      'W-DISH-DROPPED',
      'warn',
      `有 ${dishes.length - validDishes.length} 道菜缺菜名或价格，不会写进小程序。`,
      'agentDraft.dishes',
      { label: '去补全菜品', phase: 'store-info' },
      { requiresAck: true, consequence: '这些菜在小程序菜单里看不到；补全菜名和价格后重新体检就会包含。' },
    ));
  }

  if (!appid) {
    // 常规信息披露：AppID 可以在交接向导里写，不必为此卡一次确认。
    warns.push(rule(
      'W-NO-APPID',
      'warn',
      '还没有 AppID，产物先保留 touristappid，正式上传前在交接向导第 3 步写入即可。',
      'appid',
      null,
      { requiresAck: false },
    ));
  }

  const images = state.assets && Array.isArray(state.assets.images) ? state.assets.images : [];
  if (images.length > 0) {
    infos.push(rule('I-IMG-NOT-EXPORTED', 'info', `已有 ${images.length} 张门店图片；本轮图片只作为项目资产保存，不会打进导出工程。`, 'assets.images', null));
  }

  const messageCount = (state.sessions || []).reduce((sum, session) => sum + (session.messages?.length || 0), 0);
  if (messageCount > 120) {
    infos.push(rule('I-SESSION-LONG', 'info', `会话记录已有 ${messageCount} 条，接近项目文件上限，可在项目里重置会话。`, 'sessions', null));
  }

  if (opts.devtoolsDetected === false) {
    infos.push(rule('I-DEVTOOLS-NOT-FOUND', 'info', '未探测到微信开发者工具；导入步骤会给出手动打开指引。', null, null));
  }

  infos.push(rule('I-DEMO-PAYMENT', 'info', '导出工程使用演示付款，不产生真实扣款。', null, null));

  return {
    errors,
    warns,
    infos,
    checkedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}

/** 合并 Composer validateComposition（P0–P2）的返回。 */
export function mergeComposerResult(local, composerResult) {
  const base = local || { errors: [], warns: [], infos: [] };
  const errors = [...(base.errors || [])];
  const warns = [...(base.warns || [])];
  const infos = [...(base.infos || [])];
  const result = composerResult || {};

  if (result.ok === false) {
    const code = result.code || 'COMPOSE_FAILED';
    // 未验证配方（B4 规则 3）：Composer 结构化拒绝，这里翻成人话 + 可执行动作。
    const recipeStageBlocked = String(code).startsWith('RECIPE_STAGE');
    const ruleId = recipeStageBlocked
      ? 'E-RECIPE-STAGE'
      : (code === 'THEME_CONTRAST_LOW' ? 'E-THEME-CONTRAST' : 'E-PLAN-CONTRACT');
    errors.push(rule(
      ruleId,
      'error',
      result.message || `Composer 校验未通过（${code}）`,
      result.path || null,
      recipeStageBlocked
        ? { label: '去换一个已验证模板', phase: 'template' }
        : (code === 'THEME_CONTRAST_LOW' ? { label: '去换一套风格', phase: 'store-info' } : null),
      recipeStageBlocked
        ? { consequence: '未验证的页面结构不会被当作正式成果导出，避免交付一个没跑通过的工程。' }
        : undefined,
    ));
    return { errors, warns, infos, planDigest: null, checkedAt: base.checkedAt || null };
  }

  const previewOnly = Array.isArray(result.previewOnly) ? result.previewOnly : [];
  if (previewOnly.length > 0) {
    warns.push(rule(
      'W-PREVIEW-ONLY',
      'warn',
      `「${previewOnly.map(featureLabel).join('、')}」目前只能预览，没有接入线上能力。`,
      'features.selected',
      null,
      { requiresAck: true, consequence: '上线后这些入口能点但没有真实后端；对外不能说已经接入。' },
    ));
  }

  const updates = Array.isArray(result.updatesAvailable) ? result.updatesAvailable : [];
  if (updates.length > 0) {
    warns.push(rule(
      'W-VERSION-GAP',
      'warn',
      `有可用模板版本：${updates.map((item) => `${item.id} ${item.current} → ${item.available}`).join('；')}。本次仍按 Plan 精确版本导出。`,
      null,
      null,
      { requiresAck: false },
    ));
  }

  return {
    errors,
    warns,
    infos,
    planDigest: result.planDigest || null,
    // 配方交付状态（stage/wechatCompile/knownLimits）如实带给界面，用于导出摘要。
    recipe: result.recipe || null,
    checkedAt: base.checkedAt || null,
  };
}

export const TARGET_RULE_IDS = Object.freeze({
  CONFLICT: 'E-TARGET-EXISTS',
  CHECK_FAILED: 'E-TARGET-CHECK-FAILED',
});

/**
 * 合并只读目标预检结果。
 *
 * - 冲突：追加且只追加一条 E-TARGET-EXISTS。
 * - 检查失败（含旧主进程缺少通道）：追加 E-TARGET-CHECK-FAILED，阻断导出。
 * - 目标不存在：不产生 error。
 * - 重复合并同一结果不会产生重复行。
 */
export function mergeTargetPreflight(local, targetResult) {
  const base = local || { errors: [], warns: [], infos: [] };
  const errors = [...(base.errors || [])];
  const result = targetResult || {};
  const hasRule = (ruleId) => errors.some((item) => item && item.ruleId === ruleId);

  if (result.status === 'conflict' || result.exists === true) {
    if (!hasRule(TARGET_RULE_IDS.CONFLICT)) {
      const suggestion = result.suggestedName ? `可试试「${result.suggestedName}」。` : '';
      errors.push(rule(
        TARGET_RULE_IDS.CONFLICT,
        'error',
        `目标目录已有同名工程，不会覆盖；请更换导出位置或项目名。${suggestion}`,
        'deploy.projectName',
        null,
      ));
    }
  } else if (result.status !== 'ok' && result.exists !== false) {
    if (!hasRule(TARGET_RULE_IDS.CHECK_FAILED)) {
      errors.push(rule(
        TARGET_RULE_IDS.CHECK_FAILED,
        'error',
        result.message || '无法检查目标目录；为避免覆盖，本次导出已阻断。',
        'deploy.directory',
        null,
      ));
    }
  }

  return {
    errors,
    warns: [...(base.warns || [])],
    infos: [...(base.infos || [])],
    planDigest: base.planDigest || null,
    recipe: base.recipe || null,
    checkedAt: base.checkedAt || null,
  };
}

export const PREFLIGHT_RULE_IDS = Object.freeze({
  ERROR: ['E-PLAN-NAME', 'E-PLAN-DISHES', 'E-PLAN-PRICE', 'E-PLAN-HOURS', 'E-PLAN-FULFILLMENT', 'E-PLAN-CONTRACT', 'E-RECIPE-STAGE', 'E-THEME-CONTRAST', 'E-APPID-FORMAT', 'E-DESKTOP-REQUIRED', 'E-TARGET-EXISTS', 'E-TARGET-CHECK-FAILED'],
  /** 需要用户确认后果的规则（B4 规则 8）：只有「你选了但真的不交付」与「会丢数据」两类。 */
  ACK: ['W-PREVIEW-ONLY', 'W-UNMAPPED-FEATURE', 'W-DISH-DROPPED'],
  WARN: ['W-PREVIEW-ONLY', 'W-VERSION-GAP', 'W-UNMAPPED-FEATURE', 'W-BASE-FEATURE-UNCHECKED', 'W-DISH-DROPPED', 'W-NO-APPID'],
  INFO: ['I-IMG-NOT-EXPORTED', 'I-SESSION-LONG', 'I-DEVTOOLS-NOT-FOUND', 'I-DEMO-PAYMENT'],
});