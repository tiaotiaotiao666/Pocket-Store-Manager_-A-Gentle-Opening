/**
 * 「Agent 正在等你操作」提示的唯一推导口径。
 *
 * 只在**确实卡在等用户点一个控件**时给出提示：说清等什么、在哪一块、点哪个按钮，
 * 并给出一个跳转定位用的 `jumpId`（真实控件的 `data-jump-id`）。
 *
 * 硬约束：
 * - 纯函数：不读 DOM、不发请求、不 dispatch、不保存「已提示过」之类的本地记忆；
 *   状态一变（确认、取消、失败、切项目、新请求），条件自然不成立，提示就消失；
 * - 只描述位置，不代替用户点确认/应用/生成/导出/下单；
 * - 没有把握的等待状态宁可不提示，也不编造入口。
 *
 * @param {object} input
 * @param {string} input.phase 当前流程阶段
 * @param {object} [input.agent] 门店资料 Agent 状态（`state.agent`）
 * @param {object} [input.build] 候选骨架状态（`state.build`）
 * @param {object} [input.presentation] 模板展示/修订状态
 * @returns {{title: string, detail: string, jumpId: string, actionLabel: string}|null}
 */
export function selectAgentWaitingHint({ phase, agent, build, presentation } = {}) {
  if (phase === 'store-info') {
    const status = agent && typeof agent === 'object' ? agent.status : null;
    const missing = Array.isArray(agent?.missingFields) ? agent.missingFields.length : 0;
    const errors = Array.isArray(agent?.errors) ? agent.errors.length : 0;
    // 只有「资料齐全、正在等确认」才是真的在等用户点按钮。
    if (status === 'reviewing' && missing === 0 && errors === 0) {
      return {
        title: '等你确认门店资料',
        detail: '资料已齐全：看中间对话栏底部的「资料无误，继续」按钮，点它才会写入门店信息。',
        jumpId: 'store-info-confirm',
        actionLabel: '前往处理',
      };
    }
    return null;
  }

  if (phase === 'template-pick') {
    const candidates = Array.isArray(build?.candidates) ? build.candidates : [];
    const selectedId = build && typeof build.selectedId === 'string' ? build.selectedId : '';
    const revising = presentation && typeof presentation === 'object' && presentation.status === 'revising';
    // 修订/重新匹配在跑的时候不是「等你」，此时不提示，避免和进度条抢注意力。
    if (candidates.length > 0 && !selectedId && !revising) {
      return {
        title: '等你挑一套页面骨架',
        detail: '在中间「页面骨架」区先点卡片看预览，再点详情里的「就用这套」。',
        jumpId: 'template-apply',
        actionLabel: '前往处理',
      };
    }
    return null;
  }

  return null;
}

export default selectAgentWaitingHint;
