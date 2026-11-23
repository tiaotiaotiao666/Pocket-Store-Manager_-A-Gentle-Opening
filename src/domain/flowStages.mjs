import { PHASES } from '../state/constants.mjs';

/**
 * P2：桌面端唯一主线的四步。
 *
 * 只描述「现在在哪一步、能回到哪一步、下一步是什么」，不定义任何业务动作；
 * 真正的跳转仍由 sessionMachine 的 `PHASE_GOTO` 完成。
 *
 * 顺序即屏幕上从左到右的顺序：门店资料 → 模板/参考截图 → 素材 → 导出。
 */
export const FLOW_STAGES = Object.freeze([
  Object.freeze({
    key: 'store',
    label: '门店资料',
    hint: '店名、营业时间、菜品与价格',
    entryPhase: PHASES.STORE_INFO,
    backPhase: null,
    backLabel: null,
  }),
  Object.freeze({
    key: 'capabilities',
    label: '能力与定制',
    hint: '基础/扩展能力，定制可跳过',
    entryPhase: PHASES.FEATURES,
    backPhase: PHASES.STORE_INFO,
    backLabel: '返回修改门店资料',
  }),
  Object.freeze({
    key: 'template',
    label: '页面骨架',
    hint: '生成并挑选页面骨架',
    entryPhase: PHASES.TEMPLATE_PICK,
    backPhase: PHASES.FEATURES,
    backLabel: '返回调整能力',
  }),
  Object.freeze({
    key: 'material',
    label: '装修与视觉',
    hint: '风格偏好与海报素材',
    entryPhase: PHASES.PROMPT_STUDIO,
    backPhase: PHASES.TEMPLATE_PICK,
    backLabel: '返回换骨架',
  }),
  Object.freeze({
    key: 'export',
    label: '导出',
    hint: '体检后导出白名单工程',
    entryPhase: PHASES.DEPLOY,
    backPhase: PHASES.IMAGE_REVIEW,
    backLabel: '返回改素材',
  }),
]);

export const FLOW_STAGE_KEYS = Object.freeze(FLOW_STAGES.map((stage) => stage.key));

/** 阶段 → 相位。一个阶段可以覆盖多个相位（例如能力阶段包含生成中的过渡相位）。 */
const STAGE_PHASES = Object.freeze({
  store: Object.freeze([
    PHASES.HOME,
    PHASES.ONBOARDING,
    PHASES.STORE_INFO,
  ]),
  capabilities: Object.freeze([PHASES.FEATURES]),
  template: Object.freeze([PHASES.BUILDING, PHASES.TEMPLATE_PICK]),
  material: Object.freeze([PHASES.PROMPT_STUDIO, PHASES.IMAGE_REVIEW]),
  export: Object.freeze([PHASES.DEPLOY]),
});

export function stageForPhase(phase) {
  const matched = FLOW_STAGES.find((stage) => STAGE_PHASES[stage.key].includes(phase));
  return matched ? matched.key : 'store';
}

/** 首页不算流程图里的一步：它在流程开始之前。 */
export function isFlowVisible(phase) {
  return phase !== PHASES.HOME;
}

/**
 * @param {string} phase 当前相位
 * @param {{busy?:boolean, reachedIndex?:number}} [options]
 *   reachedIndex：本次打开项目里已经走到过的最远步骤下标；缺省等于当前步骤。
 * @returns {{
 *   visible:boolean, currentKey:string, currentIndex:number, currentLabel:string,
 *   steps:Array<{key:string,label:string,hint:string,index:number,state:'done'|'current'|'todo',phase:string,visited:boolean,canVisit:boolean}>,
 *   back:{key:string,label:string,phase:string}|null,
 *   next:{key:string,label:string}|null
 * }}
 */
export function describeFlow(phase, options = {}) {
  const currentKey = stageForPhase(phase);
  const currentIndex = FLOW_STAGE_KEYS.indexOf(currentKey);
  const busy = options && options.busy === true;
  const reachedIndex = options && Number.isInteger(options.reachedIndex)
    ? Math.max(currentIndex, Math.min(options.reachedIndex, FLOW_STAGES.length - 1))
    : currentIndex;
  const current = FLOW_STAGES[currentIndex];

  const steps = FLOW_STAGES.map((stage, index) => {
    const state = index < currentIndex ? 'done' : (index === currentIndex ? 'current' : 'todo');
    return {
      key: stage.key,
      label: stage.label,
      hint: stage.hint,
      index,
      state,
      phase: stage.entryPhase,
      visited: index <= reachedIndex,
      // 到过的步骤可以双向跳：退回去改了还能点回来，不必一步步重走。
      // 构建中/模型请求中不提供跳转，与「返回修改」同一道门禁。
      canVisit: !busy && index !== currentIndex && index <= reachedIndex,
    };
  });

  const back = current.backPhase
    ? { key: FLOW_STAGES[currentIndex - 1].key, label: current.backLabel, phase: current.backPhase }
    : null;

  const nextStage = FLOW_STAGES[currentIndex + 1] || null;

  return {
    visible: isFlowVisible(phase),
    currentKey,
    currentIndex,
    currentLabel: current.label,
    // 构建中不提供返回入口：与既有并发门禁一致，避免半途打断。
    steps,
    back: busy ? null : back,
    next: nextStage ? { key: nextStage.key, label: nextStage.label } : null,
  };
}
