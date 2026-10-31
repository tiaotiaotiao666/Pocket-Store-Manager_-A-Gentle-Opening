/**
 * 导出交接向导步骤机（纯函数）。
 *
 * 六步：确认产物 → 导入开发者工具 → 写入 AppID → 配置域名 → 真机预览 → 后续与边界。
 * 状态写入 project.json → deploy.handoff，可在重启后继续（但非 done 状态不允许继续写 AppID）。
 */

export const HANDOFF_STEPS = Object.freeze([
  {
    id: 'prepare',
    title: '确认产物',
    summary: '核对导出目录、Lock 摘要与检查项',
    completeText: '产物没问题',
    hint: '本应用不会上传或发布，只生成并交付本地目录。',
  },
  {
    id: 'import',
    title: '导入微信开发者工具',
    summary: '打开工具 → 导入项目 → 选择导出目录',
    completeText: '已导入成功',
    hint: 'AppID 可先选「测试号」，正式号在下一步写入。',
  },
  {
    id: 'appid',
    title: '写入 AppID',
    summary: '把项目 AppID 写进产物 project.config.json',
    completeText: 'AppID 已写入',
    hint: '会改变产物摘要并已回填 lock/report；配方与模板指纹不变。',
  },
  {
    id: 'domain',
    title: '配置服务器域名',
    summary: '在开发者工具里配置 request 合法域名',
    completeText: '已配置',
    hint: '本地联调可用测试号并关闭域名校验。',
  },
  {
    id: 'preview',
    title: '真机预览',
    summary: '生成预览码，走一遍菜单 → 加购 → 结算 → 演示支付',
    completeText: '真机走查完成',
    hint: '重点检查支付结果页的取餐号与演示声明。',
  },
  {
    id: 'next',
    title: '后续与边界',
    summary: '了解未接入能力与后续动作',
    completeText: '完成交接',
    hint: '不代办认证、审核与发布。',
  },
]);

const STEP_IDS = HANDOFF_STEPS.map((step) => step.id);
const STEP_ID_SET = new Set(STEP_IDS);

export function handoffStepIds() {
  return [...STEP_IDS];
}

export function findStep(stepId) {
  return HANDOFF_STEPS.find((step) => step.id === stepId) || null;
}

export function stepIndex(stepId) {
  const index = STEP_IDS.indexOf(stepId);
  return index === -1 ? 0 : index;
}

export function nextStepId(stepId) {
  const index = stepIndex(stepId);
  return STEP_IDS[Math.min(STEP_IDS.length - 1, index + 1)];
}

export function prevStepId(stepId) {
  const index = stepIndex(stepId);
  return STEP_IDS[Math.max(0, index - 1)];
}

function stamp(now) {
  const date = typeof now === 'function' ? now() : (now instanceof Date ? now : new Date());
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function createHandoffState(now) {
  return {
    stepId: 'prepare',
    completedStepIds: [],
    appidApplied: false,
    appidDigestBefore: null,
    appidDigestAfter: null,
    devtoolsDetected: false,
    updatedAt: stamp(now),
  };
}

export function validateHandoffShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!STEP_ID_SET.has(value.stepId)) return null;
  const completed = Array.isArray(value.completedStepIds)
    ? value.completedStepIds.filter((id) => STEP_ID_SET.has(id)).filter((id, index, list) => list.indexOf(id) === index)
    : [];
  return {
    stepId: value.stepId,
    completedStepIds: completed,
    appidApplied: value.appidApplied === true,
    appidDigestBefore: typeof value.appidDigestBefore === 'string' ? value.appidDigestBefore : null,
    appidDigestAfter: typeof value.appidDigestAfter === 'string' ? value.appidDigestAfter : null,
    devtoolsDetected: value.devtoolsDetected === true,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : stamp(),
  };
}

export function setStep(handoff, stepId, now) {
  const base = validateHandoffShape(handoff) || createHandoffState(now);
  if (!STEP_ID_SET.has(stepId)) return base;
  return { ...base, stepId, updatedAt: stamp(now) };
}

export function completeStep(handoff, stepId, now) {
  const base = validateHandoffShape(handoff) || createHandoffState(now);
  if (!STEP_ID_SET.has(stepId)) return base;
  const completedStepIds = [...new Set([...base.completedStepIds, stepId])];
  return {
    ...base,
    completedStepIds,
    stepId: nextStepId(stepId),
    updatedAt: stamp(now),
  };
}

export function canComplete(handoff, stepId) {
  const base = validateHandoffShape(handoff);
  if (!base) return { can: true, reason: '' };
  if (stepId === 'appid' && !base.appidApplied) {
    return { can: false, reason: 'AppID 尚未写入或已选择跳过' };
  }
  return { can: true, reason: '' };
}

export function applyAppidResult(handoff, result, now) {
  const base = validateHandoffShape(handoff) || createHandoffState(now);
  return {
    ...base,
    appidApplied: Boolean(result && result.applied),
    appidDigestBefore: result && result.digestBefore ? result.digestBefore : base.appidDigestBefore,
    appidDigestAfter: result && result.digestAfter ? result.digestAfter : base.appidDigestAfter,
    updatedAt: stamp(now),
  };
}

export function progressOf(handoff) {
  const base = validateHandoffShape(handoff);
  if (!base) {
    return { currentIndex: 0, total: STEP_IDS.length, completedCount: 0, percent: 0 };
  }
  return {
    currentIndex: stepIndex(base.stepId),
    total: STEP_IDS.length,
    completedCount: base.completedStepIds.length,
    percent: Math.round((base.completedStepIds.length / STEP_IDS.length) * 100),
  };
}

export function isFinished(handoff) {
  const base = validateHandoffShape(handoff);
  if (!base) return false;
  return base.stepId === 'next' && base.completedStepIds.includes('next');
}