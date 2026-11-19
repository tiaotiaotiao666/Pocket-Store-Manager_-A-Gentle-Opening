/**
 * 门店资料的统一限制口径（B3）。
 *
 * 为什么单独一个模块：菜品数量与营业时段的上限同时被
 * 领域校验（agentDraft）、导出前体检（preflightRules）、会话状态机（sessionMachine）、
 * 模拟 transport（mockAgentTransport）、快照归一（projectSnapshot）、
 * 编辑器（DraftEditor / StoreInfoActionBar）以及服务端校验器使用。
 * 以前每处各写一份数字（3–5 道、最多 5 道），改一处不改另一处就会互相打架。
 */

/** 至少 1 道「名称 + 整数价格」都齐全的菜就能继续；不再强制 3–5 道。 */
export const MIN_DISHES = 1;

/**
 * 上限 8 道：给用户留出「一次填 6 道」的空间，并且**不做静默截断**——
 * 超过上限时明确报错让用户自己删，不替他丢数据。
 */
export const MAX_DISHES = 8;

/** 营业时段上限（含午休分段；跨午夜算一个时段）。 */
export const MAX_HOURS_SEGMENTS = 3;

export function describeDishRequirement() {
  return `至少 ${MIN_DISHES} 道菜（菜名 + 整数价格都要填），最多 ${MAX_DISHES} 道`;
}
