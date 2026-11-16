/**
 * UX0a-3：生图能力开关。
 *
 * 当前版本没有任何真实生图服务：agentService.generateImage / reviseImage
 * 只会返回 local-demo 占位图。所以这里恒为 false —— 调用方必须据此
 * 跳过生成、隐藏"重新生成"入口，而不是制造假的"生成中"状态。
 *
 * 等真正接入服务端生图后，把 AVAILABLE 改成按配置判定即可，调用点不用改。
 */

export const IMAGE_GENERATION_AVAILABLE = false;

export const IMAGE_GENERATION_BLOCKED_REASON = '尚未接入生图服务，当前版本不会生成海报；可上传自己的图片，或暂时跳过。';

export function canGenerateImage() {
  return IMAGE_GENERATION_AVAILABLE === true;
}

/** 效果图阶段是否应该自动发起一次生成。没有服务时永远为 false。 */
export function shouldAutoGenerateImage({ phase, hasImage, imageReviewPhase, available = canGenerateImage() } = {}) {
  if (!available) return false;
  if (phase !== imageReviewPhase) return false;
  return !hasImage;
}
