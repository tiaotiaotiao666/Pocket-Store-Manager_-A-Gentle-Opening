/**
 * 店名长度规则（R3 问题 7）——全仓唯一一份。
 *
 * 为什么要有这层：以前店名上限写在 4 个地方各写一个 48（草稿校验、导出体检、
 * 项目快照、合成器 schema），输入框却完全没有上限，于是「输入时随便写、保存时
 * 被下游悄悄砍」——用户看到的名字和真正落盘/导出的名字不一致。
 *
 * 现在分两档，且都由本模块给常量：
 * - `STORE_NAME_MAX_LENGTH`（20）：**新输入**的硬上限，输入框、AI 提案、领域校验、
 *   服务端校验同一口径；
 * - `STORE_NAME_LEGACY_MAX_LENGTH`（48）：**只读兼容**老数据的上限。老项目里超过
 *   20 字的店名不能被静默改写，打开/导出照旧，用户重新编辑时才按新规则收敛。
 *
 * 计数口径是「用户看到的字符」：CJK、拉丁字母、数字都是 1，常见 emoji（含 ZWJ 组合、
 * 变体选择符、肤色修饰符）算 1 个整体，不会把代理对切半导致乱码。
 */

/** 新输入的店名上限（用户可见字符）。 */
export const STORE_NAME_MAX_LENGTH = 20;

/** 老数据的只读兼容上限：超过它的历史值才属于异常数据。 */
export const STORE_NAME_LEGACY_MAX_LENGTH = 48;

/** 有 Segmenter 就用它按字素簇切，没有就退回手写的近似切分。 */
const segmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter('zh', { granularity: 'grapheme' })
  : null;

const ZWJ = 0x200d;
const COMBINING_LIKE = (code) => (
  code === 0xfe0e || code === 0xfe0f // 变体选择符
  || (code >= 0x1f3fb && code <= 0x1f3ff) // 肤色修饰符
  || (code >= 0x0300 && code <= 0x036f) // 组合附加符号
  || (code >= 0x200b && code <= 0x200f) // 零宽/方向控制符
  || code === 0x20e3 // 组合用键帽
);

/**
 * 把字符串切成「用户可见的字符」数组。
 * @param {unknown} value
 * @returns {string[]}
 */
export function splitStoreNameChars(value) {
  const text = typeof value === 'string' ? value : '';
  if (!text) return [];
  if (segmenter) return Array.from(segmenter.segment(text), (item) => item.segment);
  const chars = [];
  for (const char of Array.from(text)) {
    const code = char.codePointAt(0);
    const last = chars.length ? chars[chars.length - 1] : '';
    const lastCode = last ? last.codePointAt(last.length - 1) : 0;
    // 组合符、变体选择符、肤色修饰符挂在前面那个字符上；ZWJ 让左右两侧连成一个整体。
    if (last && (COMBINING_LIKE(code) || lastCode === ZWJ || code === ZWJ)) {
      chars[chars.length - 1] = last + char;
      continue;
    }
    chars.push(char);
  }
  return chars;
}

/**
 * 统计用户可见字符数。
 * @param {unknown} value
 * @returns {number}
 */
export function countStoreNameChars(value) {
  return splitStoreNameChars(value).length;
}

/**
 * 按 20 字上限裁剪（不会把 emoji 或代理对切半）。
 * @param {unknown} value
 * @param {number} [max]
 * @returns {{ value: string, truncated: boolean }}
 */
export function truncateStoreName(value, max = STORE_NAME_MAX_LENGTH) {
  const text = typeof value === 'string' ? value : '';
  const chars = splitStoreNameChars(text);
  if (chars.length <= max) return { value: text, truncated: false };
  return { value: chars.slice(0, max).join(''), truncated: true };
}

/**
 * 输入框展示用的长度描述。
 * @param {unknown} value
 * @param {number} [max]
 * @returns {{ length: number, max: number, atLimit: boolean, overLimit: boolean }}
 */
export function describeStoreNameLength(value, max = STORE_NAME_MAX_LENGTH) {
  const length = countStoreNameChars(value);
  return { length, max, atLimit: length >= max, overLimit: length > max };
}

/** 粘贴/拖拽被裁剪时的固定提示语（输入框与测试共用一份）。 */
export const STORE_NAME_TRUNCATED_NOTICE = `已按 ${STORE_NAME_MAX_LENGTH} 字上限截断`;

/** 到上限时的轻提示语。 */
export const STORE_NAME_LIMIT_NOTICE = `已到 ${STORE_NAME_MAX_LENGTH} 字上限`;

/**
 * 校验店名是否符合新输入规则。
 * @param {unknown} value
 * @returns {{ ok: boolean, length: number, reason: string }}
 */
export function validateStoreName(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  const { length, max, overLimit } = describeStoreNameLength(text);
  if (overLimit) {
    return { ok: false, length, reason: `店名不能超过 ${max} 个字，当前 ${length} 个字。` };
  }
  return { ok: true, length, reason: '' };
}
