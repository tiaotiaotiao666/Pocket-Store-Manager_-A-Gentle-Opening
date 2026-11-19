/**
 * G1：海报提示词构建（纯函数，可单测）。
 *
 * 边界：
 * - 只使用开店主线已经确认的字段：店名、品类、视觉风格、菜品名。
 * - 不拼匿名信息、不读文件、不联网：地址、电话、备注这类用户隐私字段一律不进提示词。
 * - 输出长度上限与 `poster-generation.service.ts` 的校验口径一致（1..1200 字符）。
 */

export const POSTER_PROMPT_MAX_LENGTH = 1200;
export const POSTER_PROMPT_MIN_LENGTH = 1;

export interface PosterPromptInput {
  storeName?: string;
  storeType?: string;
  styleLabel?: string;
  dishes?: string[];
  userHint?: string;
}

const STYLE_HINTS: Record<string, string> = {
  'warm-bistro': '温暖家常、木质与暖黄灯光',
  'modern-coffee': '现代简约、冷灰与绿植点缀',
  'signature-kitchen': '手工烟火气、深色背景与高对比摆盘',
};

function clean(value: unknown, limit: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function styleText(input: PosterPromptInput): string {
  const label = clean(input.styleLabel, 24);
  const key = clean(input.styleLabel, 64);
  const hint = STYLE_HINTS[key] || STYLE_HINTS[label] || '';
  if (label && hint) return `${label}（${hint}）`;
  return label || hint;
}

/**
 * 依据已确认的门店资料生成中文海报提示词。
 * 提示词只描述画面与风格，不写品牌承诺、不写价格，也不要求模型生成任何文字。
 */
export function buildPosterPrompt(input: PosterPromptInput): string {
  const storeName = clean(input.storeName, 40) || '这家小店';
  const storeType = clean(input.storeType, 24);
  const style = styleText(input);
  const dishes = (Array.isArray(input.dishes) ? input.dishes : [])
    .map((item) => clean(item, 24))
    .filter(Boolean)
    .slice(0, 3);
  const hint = clean(input.userHint, 200);

  const parts: string[] = [];
  parts.push(`为「${storeName}」制作一张餐饮门店营销海报的主视觉图片。`);
  if (storeType) parts.push(`店铺类型：${storeType}。`);
  if (style) parts.push(`视觉风格：${style}。`);
  if (dishes.length > 0) parts.push(`画面主体可以取用这些招牌菜品：${dishes.join('、')}。`);
  parts.push('构图为干净的产品摄影或插画主视觉，主体居中，四周留出可以放文字的空白区域，光线自然，色彩统一。');
  parts.push('画面内不要出现任何文字、水印、二维码、商标或真实品牌标识。');
  if (hint) parts.push(`补充要求：${hint}。`);

  const prompt = parts.join('');
  return prompt.length > POSTER_PROMPT_MAX_LENGTH ? prompt.slice(0, POSTER_PROMPT_MAX_LENGTH) : prompt;
}

/** 服务端入参校验：与前端输入框共用同一口径。 */
export function normalizePosterPrompt(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const prompt = value.trim();
  if (prompt.length < POSTER_PROMPT_MIN_LENGTH || prompt.length > POSTER_PROMPT_MAX_LENGTH) return null;
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(prompt)) return null;
  return prompt;
}
