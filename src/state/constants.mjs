export const PHASES = Object.freeze({
  HOME: 'home',
  ONBOARDING: 'onboarding',
  FEATURES: 'features',
  BUILDING: 'building',
  TEMPLATE_PICK: 'template-pick',
  STORE_INFO: 'store-info',
  PROMPT_STUDIO: 'prompt-studio',
  IMAGE_REVIEW: 'image-review',
  DEPLOY: 'deploy',
});

export const ROLES = Object.freeze({ AGENT: 'agent', USER: 'user', SYSTEM: 'system' });

export const SESSION_KIND = Object.freeze({ MAIN: 'main', STEP: 'step' });

export const HOME_GREETING = '选择一个方案以开始构建你自己的小程序';
export const NEW_PROJECT_LABEL = '待命名项目';

export const PHASE_META = Object.freeze({
  [PHASES.HOME]: { label: '新建项目', caption: '选择一个方案以开始构建' },
  [PHASES.ONBOARDING]: { label: '轻启', caption: '认识这个项目' },
  [PHASES.FEATURES]: { label: '功能选择', caption: '挑选店铺能力' },
  [PHASES.BUILDING]: { label: '构建中', caption: '正在拼装小程序' },
  [PHASES.TEMPLATE_PICK]: { label: '模板匹配', caption: '挑选页面骨架' },
  [PHASES.STORE_INFO]: { label: '店铺装修', caption: '信息与风格' },
  [PHASES.PROMPT_STUDIO]: { label: '生图提示词', caption: '打磨视觉提示' },
  [PHASES.IMAGE_REVIEW]: { label: '效果审核', caption: '反复确认视觉' },
  [PHASES.DEPLOY]: { label: '部署小程序', caption: '交付上线' },
});

export const COMPOSER_PLACEHOLDER = Object.freeze({
  [PHASES.ONBOARDING]: '请给你的店铺小程序命名…',
  [PHASES.STORE_INFO]: '用一句话说店名、品类、营业时间、取餐方式和 3–5 道菜…',
  [PHASES.FEATURES]: '没有想要的功能？在这里告诉我们…',
  [PHASES.PROMPT_STUDIO]: '描述你想要的画面风格…',
  [PHASES.IMAGE_REVIEW]: '告诉我要修改的地方…',
});

export const COMPOSER_SUBMIT_LABEL = Object.freeze({
  [PHASES.ONBOARDING]: '命名并开始',
  [PHASES.STORE_INFO]: '整理资料',
  [PHASES.FEATURES]: '加入定制能力',
  [PHASES.PROMPT_STUDIO]: '确认这版提示词',
  [PHASES.IMAGE_REVIEW]: '确认这版效果',
});

export const AGENT_STATUS = Object.freeze({
  IDLE: 'idle',
  REQUESTING: 'requesting',
  COLLECTING: 'collecting',
  REVIEWING: 'reviewing',
  CONFIRMED: 'confirmed',
  FAILED: 'failed',
});

export const AGENT_STORE_INFO_HINT = '示例：店名是松月食堂，做社区家常菜，10:00-21:00，堂食和自取，宫保鸡丁 28 元、番茄炒蛋 16 元、米饭 3 元。';

export const CLOSED_PHASES = Object.freeze([PHASES.BUILDING, PHASES.DEPLOY]);

export const DEPLOY_STATUS = Object.freeze({
  IDLE: 'idle',
  CHOOSING: 'choosing',
  VALIDATING: 'validating',
  GENERATING: 'generating',
  VERIFYING: 'verifying',
  DONE: 'done',
  FAILED: 'failed',
  CONFLICT: 'conflict',
  CANCELLED: 'cancelled',
});

export function composerEnabled(phase) {
  return Object.prototype.hasOwnProperty.call(COMPOSER_PLACEHOLDER, phase);
}