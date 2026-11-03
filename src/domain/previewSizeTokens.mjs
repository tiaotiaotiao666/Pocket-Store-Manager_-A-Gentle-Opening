/**
 * `preview-size-tokens.v1` 的唯一尺寸事实。
 *
 * 约定（见 plan.md 2.2.1）：
 * - 只允许 3 组 × 3 档，禁止出现任意数值 token；
 * - `px` 只给 React 预览用，`rpx` 只给小程序导出用，两边不得交叉；
 * - 缺省档位固定为 `md`。
 *
 * 本模块是纯逻辑，不依赖 DOM / React，可被前端预览、Composer 与测试复用。
 */
import sizeDoc from '../../templates/presentation/size-tokens.v1.json' with { type: 'json' };

export const SIZE_TOKEN_CONTRACT = sizeDoc.contract;

export const SIZE_GROUPS = Object.freeze(['homeHero', 'productCard', 'carousel']);
export const SIZE_STEPS = Object.freeze(['sm', 'md', 'lg']);

export const DEFAULT_SIZE_TOKENS = Object.freeze({
  homeHero: sizeDoc.defaults.homeHero,
  productCard: sizeDoc.defaults.productCard,
  carousel: sizeDoc.defaults.carousel,
});

/** 尺寸 token 的原始表（只读副本，避免调用方意外改写冻结事实）。 */
export const SIZE_TOKEN_TABLE = Object.freeze(sizeDoc.sizes);

const FALLBACK_GROUP = 'homeHero';

/**
 * 解析一个尺寸档位。
 * 未知 group / step 一律回落到默认值并标记 fallback，不向渲染层抛异常。
 *
 * @returns {{group: string, step: string, px: number, rpx: number, label: string, fallback: boolean}}
 */
export function resolveSizeToken(group, step) {
  const groupKnown = SIZE_GROUPS.includes(group);
  const safeGroup = groupKnown ? group : FALLBACK_GROUP;
  const stepKnown = SIZE_STEPS.includes(step);
  const safeStep = stepKnown ? step : DEFAULT_SIZE_TOKENS[safeGroup];
  const entry = sizeDoc.sizes[safeGroup][safeStep];

  return {
    group: safeGroup,
    step: safeStep,
    px: entry.px,
    rpx: entry.rpx,
    label: entry.label,
    fallback: !groupKnown || !stepKnown,
  };
}

/** React 预览使用：取 px 值。 */
export function toPx(group, step) {
  return resolveSizeToken(group, step).px;
}

/** 小程序导出使用：取 rpx 值。 */
export function toRpx(group, step) {
  return resolveSizeToken(group, step).rpx;
}

/**
 * 把 CompositionPlan 里可选的 `presentationTokens` 规范化为固定两键，
 * 缺省与非法值统一回落 `md`（见 plan.md 2.2.2）。
 */
export function normalizePresentationTokens(tokens) {
  const source = tokens && typeof tokens === 'object' && !Array.isArray(tokens) ? tokens : {};
  return {
    homeHeroSize: SIZE_STEPS.includes(source.homeHeroSize)
      ? source.homeHeroSize
      : DEFAULT_SIZE_TOKENS.homeHero,
    productCardSize: SIZE_STEPS.includes(source.productCardSize)
      ? source.productCardSize
      : DEFAULT_SIZE_TOKENS.productCard,
  };
}