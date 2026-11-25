'use strict';

/**
 * 多模态消息构造（rev15 §14.8 / X2，E0-R2）。
 *
 * ```js
 * buildMultimodalContent({ utterance, images })
 *   => [{ type:'text', text }, { type:'image_url', image_url:{ url:'data:...' } }]
 * ```
 *
 * 边界：
 * - **顺序稳定**：先 text，再按传入顺序排 image_url；无图时退化为单 text 块。
 * - data URL 只在本函数的返回值里；本模块不写文件、不打日志、不返回路径。
 * - 视觉能力**失败即拒**（fail-closed）：调用方不显式声明 `supportsVision` 就不许把图发出去，
 *   绝不允许“有图但悄悄按纯文本跑”。
 * - 单张大小另有上游通道口径：`model-credentials` 的规范器是唯一权威，
 *   这里通过 `assertChannelAccepts()` 预检，把它的上限变成明确的 `AGENT_IMAGE_INVALID`。
 */

const { normalizeChatPayload } = require('../model-credentials.cjs');
const { imageInvalid, visionUnavailable, MAX_IMAGES_PER_TURN } = require('./images.cjs');

/** utterance 为空但有图时的固定引导语（模型必须收到非空 text 块）。 */
const IMAGE_ONLY_TEXT = '请查看这张目标页参考图，按图中内容调整小程序界面。';

const DATA_URL_PATTERN = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 只接受本模块 resolveAssetImage 的产物形状（有 dataUrl），不接受裸 base64/路径。 */
function imageUrlOf(image) {
  if (typeof image === 'string') {
    throw imageInvalid('raw_base64_rejected', '只接受 assetId 解析后的图片对象，不接受 base64 文本。');
  }
  if (!isPlainObject(image)) throw imageInvalid('image_part_invalid', '图片内容块不合法。');
  const dataUrl = typeof image.dataUrl === 'string' ? image.dataUrl : '';
  if (!DATA_URL_PATTERN.test(dataUrl)) {
    throw imageInvalid('data_url_invalid', '图片 data URL 不合法（只接受内联 PNG/JPEG/WebP）。');
  }
  return dataUrl;
}

/**
 * 构造 content parts。
 * @param {{utterance?: string, images?: Array, limits?: object}} options
 * @returns {Array<{type: 'text', text: string} | {type: 'image_url', image_url: {url: string}}>}
 */
function buildMultimodalContent(options) {
  const opts = isPlainObject(options) ? options : {};
  const images = Array.isArray(opts.images) ? opts.images : [];
  const limits = isPlainObject(opts.limits) ? opts.limits : {};
  const maxImages = Number.isInteger(limits.maxImages) && limits.maxImages > 0
    ? Math.min(limits.maxImages, MAX_IMAGES_PER_TURN)
    : MAX_IMAGES_PER_TURN;

  if (images.length > maxImages) {
    throw imageInvalid(
      'too_many_images',
      maxImages === 1 ? 'E0 每轮只接受 1 张目标页参考图。' : `本轮最多 ${maxImages} 张图片。`,
    );
  }

  const rawText = typeof opts.utterance === 'string' ? opts.utterance : '';
  const text = rawText.trim() === '' ? (images.length > 0 ? IMAGE_ONLY_TEXT : '') : rawText;
  if (text === '') throw imageInvalid('utterance_missing', '缺少用户指令文本。');

  const parts = [{ type: 'text', text }];
  for (const image of images) {
    parts.push({ type: 'image_url', image_url: { url: imageUrlOf(image) } });
  }
  return parts;
}

/**
 * 用 `model-credentials` 的规范器（上游唯一权威）预检一份 messages 是否会被通道接受。
 * 把「通道上限比 §14.8 更严」翻译成明确的 AGENT_IMAGE_INVALID，而不是事后的 MODEL_REQUEST_INVALID。
 */
function assertChannelAccepts(messages) {
  try {
    normalizeChatPayload({ messages });
    return { ok: true };
  } catch (error) {
    const message = error && typeof error.message === 'string' ? error.message : '图片无法作为多模态消息发送。';
    if (/图片/.test(message)) throw imageInvalid('channel_rejected', message, error && error.code);
    throw imageInvalid('channel_rejected', message, error && error.code);
  }
}

/**
 * 视觉能力判定（fail-closed）。
 * - `vision === true` → 可用；
 * - `vision === false` → 不可用（AGENT_VISION_UNAVAILABLE）；
 * - `vision === 'auto'` / 未声明 → 读 modelChat.describe().supportsVision，只有明确 true 才算可用。
 */
function resolveVisionSupport(options) {
  const opts = isPlainObject(options) ? options : {};
  const declared = opts.vision;
  if (declared === true) return { ok: true, source: 'explicit' };
  if (declared === false) {
    return {
      ok: false,
      source: 'explicit',
      error: visionUnavailable('vision_disabled', '当前模型未启用视觉能力，无法接收参考图。'),
    };
  }
  const describe = isPlainObject(opts.modelDescribe) ? opts.modelDescribe : {};
  if (describe.supportsVision === true) return { ok: true, source: 'model' };
  return {
    ok: false,
    source: 'model',
    error: visionUnavailable(
      'vision_unsupported',
      '当前模型不支持视觉输入（未声明 supportsVision），已拒绝按纯文本降级处理。',
    ),
  };
}

module.exports = {
  buildMultimodalContent,
  assertChannelAccepts,
  resolveVisionSupport,
  IMAGE_ONLY_TEXT,
  DATA_URL_PATTERN,
};
