/**
 * 统一会话的动作执行器（T8）。
 *
 * 只允许显式映射：模型给 `actionId`，这里查表决定「能不能自动执行」，
 * 绝不接受 reducer action type、IPC 名、路径或任意函数名。
 *
 * 确认边界：
 * - `navigate.phase` 是只改变视图的导航，可自动执行；
 * - 模板选择/修订、候选采用/放弃、素材落盘、AppID、导出、资料确认
 *   一律返回 `needs-confirmation`，由用户在原业务面板确认后执行；
 * - 前置条件不满足（无候选、无 preflight、忙碌等）返回 `unavailable`。
 */

export const APP_ASSISTANT_ACTION_HANDLERS = Object.freeze({
  'navigate.phase': Object.freeze({ label: '切换阶段', auto: true, dep: 'navigate' }),
  'template.select': Object.freeze({ label: '选择模板', auto: false }),
  'template.revise': Object.freeze({ label: '对话修改当前模板', auto: false }),
  'frontend.reconstruct': Object.freeze({ label: '生成参考图候选', auto: false }),
  'frontend.adopt': Object.freeze({ label: '采用前端候选', auto: false }),
  'frontend.discard': Object.freeze({ label: '放弃前端候选', auto: false }),
  'agentDraft.confirm': Object.freeze({ label: '确认门店资料', auto: false }),
  'export.preflight': Object.freeze({ label: '导出前体检', auto: false }),
  'export.choose-directory': Object.freeze({ label: '选择导出目录', auto: false }),
  'export.run': Object.freeze({ label: '导出小程序工程', auto: false }),
  'asset.attach-store-image': Object.freeze({ label: '保存门店图片素材', auto: false }),
});

const PHASE_VALUES = Object.freeze([
  'home', 'onboarding', 'features', 'building', 'template-pick',
  'store-info', 'prompt-studio', 'image-review', 'deploy',
]);

function unavailable(reason) {
  return { status: 'unavailable', reason };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 检查一条动作请求当前是否可执行（不产生副作用）。
 *
 * @param {object} action `action.request` 规范化后的条目
 * @param {object} deps 显式注入的入口与状态
 * @returns {{status: 'auto'|'needs-confirmation'|'unavailable', reason?: string}}
 */
export function describeAppAssistantAction(action, deps = {}) {
  if (!isPlainObject(action) || action.op !== 'action.request') return unavailable('不是动作请求。');
  const handler = APP_ASSISTANT_ACTION_HANDLERS[action.actionId];
  if (!handler) return unavailable(`动作 ${String(action.actionId)} 不在能力目录里。`);
  if (!handler.auto) {
    return { status: 'needs-confirmation', reason: `${handler.label}需要你在原业务面板确认后执行。` };
  }
  const params = isPlainObject(action.params) ? action.params : {};
  if (action.actionId === 'navigate.phase') {
    const phase = typeof params.phase === 'string' ? params.phase.trim() : '';
    if (!phase || !PHASE_VALUES.includes(phase)) return unavailable('目标阶段不合法。');
    if (deps.state && deps.state.phase === phase) return unavailable('已经在目标阶段。');
    if (typeof deps[handler.dep] !== 'function') return unavailable('当前界面没有导航入口。');
    return { status: 'auto' };
  }
  return unavailable('该动作没有可自动执行的入口。');
}

/**
 * 执行一条动作：只有 `auto` 且前置条件满足才调用显式注入的函数。
 *
 * @returns {{status: 'executed'|'needs-confirmation'|'unavailable', reason?: string}}
 */
export function executeAppAssistantAction(action, deps = {}) {
  const decision = describeAppAssistantAction(action, deps);
  if (decision.status !== 'auto') return decision;
  const handler = APP_ASSISTANT_ACTION_HANDLERS[action.actionId];
  const params = isPlainObject(action.params) ? action.params : {};
  try {
    if (action.actionId === 'navigate.phase') {
      deps[handler.dep](params.phase);
    }
  } catch (error) {
    return unavailable('动作执行失败，请重试。');
  }
  return { status: 'executed' };
}

/**
 * 顺序执行一组动作请求；每条最多调用一次既有入口。
 *
 * @param {Array<object>} actions
 * @param {object} deps
 * @returns {Array<{opId: string|null, actionId: string|null, status: string, reason?: string}>}
 */
export function executeAppAssistantActions(actions, deps = {}) {
  const list = Array.isArray(actions) ? actions : [];
  const results = [];
  for (const action of list) {
    const result = executeAppAssistantAction(action, deps);
    results.push({
      opId: isPlainObject(action) && typeof action.opId === 'string' ? action.opId : null,
      actionId: isPlainObject(action) && typeof action.actionId === 'string' ? action.actionId : null,
      ...result,
    });
  }
  return results;
}

/** 尚未执行的动作（用于面板「等待确认」区）。 */
export function selectUnexecutedActions(results) {
  return (Array.isArray(results) ? results : [])
    .filter((item) => item && item.status !== 'executed')
    .map((item) => ({ opId: item.opId, actionId: item.actionId, status: item.status, reason: item.reason }));
}