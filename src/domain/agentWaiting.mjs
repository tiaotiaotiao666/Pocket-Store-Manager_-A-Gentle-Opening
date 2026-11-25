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
 * - 同一个等待目标只给一张提示卡（`jumpId` 唯一），调用方据此和「前往确认」卡去重；
 * - 没有把握的等待状态宁可不提示，也不编造入口。
 *
 * 覆盖的等待态（都来自真实状态，不是文案清单）：
 * 1. 门店资料 Agent 资料齐全、等用户点「资料无误，继续」→ `store-info-confirm`
 * 2. 页面骨架有候选但没选，等用户看预览后点「就用这套」→ `template-apply`
 * 3. 参考图候选已通过静态检查，等用户点「采用」→ `frontend-candidates`
 * 4. 导出前体检没做完 / 有风险项没勾选，等用户处理 → `export-preflight`
 *
 * @param {object} input
 * @param {string} input.phase 当前流程阶段
 * @param {object} [input.agent] 门店资料 Agent 状态（`state.agent`）
 * @param {object} [input.build] 候选骨架状态（`state.build`）
 * @param {object} [input.presentation] 模板展示/修订状态
 * @param {object} [input.frontend] 候选前端视图模型（`buildFrontendReconstructView` 的返回）
 * @param {object} [input.deploy] 导出/发布状态（`state.deploy`）
 * @returns {{title: string, detail: string, jumpId: string, actionLabel: string}|null}
 */
export function selectAgentWaitingHint({ phase, agent, build, presentation, frontend, deploy } = {}) {
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
    // 参考图重构出来的候选已经过了静态检查，此时确实在等用户点「采用」（采用才会写进项目）。
    if (!revising && frontend && typeof frontend === 'object' && frontend.canAdopt === true) {
      return {
        title: '等你确认候选前端',
        detail: '参考图候选已生成并通过静态检查：看中间「参考图候选」卡片，点「采用」才会写进项目，撤销也在这里。',
        jumpId: 'frontend-candidates',
        actionLabel: '前往处理',
      };
    }
    return null;
  }

  if (phase === 'deploy') {
    // 没有真实导出状态就不猜：宁可不出提示，也不编造等待态。
    if (!deploy || typeof deploy !== 'object') return null;
    const preflight = deploy.preflight;
    if (!preflight || typeof preflight !== 'object') return null;
    const status = typeof preflight.status === 'string' ? preflight.status : 'idle';
    if (status === 'checking') return null;
    // 没做过体检、体检失败、或体检完成但还有风险项没勾选：都需要用户自己点，不是自动流程。
    const errors = Array.isArray(preflight?.errors) ? preflight.errors.length : 0;
    const warns = Array.isArray(preflight?.warns) ? preflight.warns.length : 0;
    const acknowledged = Array.isArray(preflight?.acknowledged) ? preflight.acknowledged.length : 0;
    const pendingAck = status === 'done' && errors + warns > 0 && acknowledged < errors + warns;
    if (status === 'idle' || status === 'failed' || pendingAck) {
      return {
        title: status === 'done' ? '等你确认导出风险项' : '等你做导出前体检',
        detail: status === 'done'
          ? '体检还有风险项没勾选：看中间「导出前检查」区，逐条勾选后才会放行导出。'
          : '看中间「导出前检查」区的「开始体检」，体检通过才允许导出；失败可以直接重试。',
        jumpId: 'export-preflight',
        actionLabel: '前往处理',
      };
    }
    return null;
  }

  return null;
}

export default selectAgentWaitingHint;
