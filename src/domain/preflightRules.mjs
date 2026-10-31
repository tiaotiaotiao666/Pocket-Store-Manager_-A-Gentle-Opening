/**
 * 导出前体检规则（纯函数）。
 *
 * 先跑本地静态规则，再（无 error 时）调用 Composer 的 validateComposition（P0–P2，不写盘）。
 * 规则 ID 与判定口径见实现方案 6.3.1。
 */

import { features as catalogFeatures } from './catalog.mjs';

const MAX_STORE_NAME = 48;
const MIN_DISHES = 3;
const MAX_DISHES = 5;
const MIN_PRICE_CENTS = 1;
const MAX_PRICE_CENTS = 999999;
const MAX_HOURS_SEGMENTS = 3;
const APPID_RE = /^wx[0-9a-f]{16}$/;

const BASE_CAPABILITIES = new Set([
  'scan-order',
  'product-catalog',
  'cart-checkout',
  'order-tracking',
  'table-dining',
  'takeaway',
  'merchant-orders',
  'product-availability',
  'store-profile',
]);

function featureLabel(id) {
  return catalogFeatures.find((feature) => feature.id === id)?.label || id;
}

function rule(ruleId, level, message, fieldPath, action) {
  return {
    ruleId,
    level,
    message,
    fieldPath: fieldPath || null,
    action: action || null,
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
      `有效菜品只有 ${validDishes.length} 道（需要 ${MIN_DISHES}–${MAX_DISHES} 道，名称与整数价格都要填）。`,
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

  const hoursSegments = String(draft.businessHours || '').split(',').filter(Boolean);
  if (hoursSegments.length === 0) {
    errors.push(rule('E-PLAN-HOURS', 'error', '还没有营业时间，导出后会显示为空。', 'agentDraft.businessHours', { label: '去填写营业时间', phase: 'store-info' }));
  } else if (hoursSegments.length > MAX_HOURS_SEGMENTS) {
    errors.push(rule('E-PLAN-HOURS', 'error', `营业时间超过 ${MAX_HOURS_SEGMENTS} 个时段，请删减。`, 'agentDraft.businessHours', { label: '去删减时段', phase: 'store-info' }));
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
    warns.push(rule(
      'W-UNMAPPED-FEATURE',
      'warn',
      `以下能力暂无模板资产，不会写入导出工程：${unmapped.map(featureLabel).join('、')}。`,
      'features.selected',
      null,
    ));
  }

  if (dishes.length !== validDishes.length) {
    warns.push(rule(
      'W-DISH-DROPPED',
      'warn',
      `有 ${dishes.length - validDishes.length} 道菜缺少名称或整数价格，不会写入导出配置。`,
      'agentDraft.dishes',
      { label: '去补全菜品', phase: 'store-info' },
    ));
  }

  if (!appid) {
    warns.push(rule('W-NO-APPID', 'warn', '还没有 AppID，产物会保留 touristappid；可在交接向导第 3 步写入。', 'appid', null));
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
    const ruleId = code === 'THEME_CONTRAST_LOW' ? 'E-THEME-CONTRAST' : 'E-PLAN-CONTRACT';
    errors.push(rule(
      ruleId,
      'error',
      result.message || `Composer 校验未通过（${code}）`,
      result.path || null,
      code === 'THEME_CONTRAST_LOW' ? { label: '去换一套风格', phase: 'store-info' } : null,
    ));
    return { errors, warns, infos, planDigest: null, checkedAt: base.checkedAt || null };
  }

  const previewOnly = Array.isArray(result.previewOnly) ? result.previewOnly : [];
  if (previewOnly.length > 0) {
    warns.push(rule(
      'W-PREVIEW-ONLY',
      'warn',
      `以下能力仅预览、未接入线上：${previewOnly.map(featureLabel).join('、')}。`,
      'features.selected',
      null,
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
    ));
  }

  return {
    errors,
    warns,
    infos,
    planDigest: result.planDigest || null,
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
    checkedAt: base.checkedAt || null,
  };
}

export const PREFLIGHT_RULE_IDS = Object.freeze({
  ERROR: ['E-PLAN-NAME', 'E-PLAN-DISHES', 'E-PLAN-PRICE', 'E-PLAN-HOURS', 'E-PLAN-FULFILLMENT', 'E-PLAN-CONTRACT', 'E-THEME-CONTRAST', 'E-APPID-FORMAT', 'E-DESKTOP-REQUIRED', 'E-TARGET-EXISTS', 'E-TARGET-CHECK-FAILED'],
  WARN: ['W-PREVIEW-ONLY', 'W-VERSION-GAP', 'W-UNMAPPED-FEATURE', 'W-DISH-DROPPED', 'W-NO-APPID'],
  INFO: ['I-IMG-NOT-EXPORTED', 'I-SESSION-LONG', 'I-DEVTOOLS-NOT-FOUND', 'I-DEMO-PAYMENT'],
});