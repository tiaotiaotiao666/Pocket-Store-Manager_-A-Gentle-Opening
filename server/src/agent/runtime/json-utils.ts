/** JSON/UTF-8 小工具，供执行器与循环共用。 */

import { isJsonObject } from './json-schema';

/**
 * 稳定序列化：对象键排序后再 JSON.stringify。
 * 用途：把工具参数规范化为可比较签名，避免键顺序不同导致循环检测失效。
 */
export function stableStringify(value: unknown): string {
  try {
    const text = JSON.stringify(sortJsonValue(value));
    return typeof text === 'string' ? text : 'null';
  } catch {
    return '"[unserializable]"';
  }
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortJsonValue(item));
  if (isJsonObject(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortJsonValue(value[key]);
    }
    return sorted;
  }
  return value;
}

/** 把模型返回的 arguments 文本规范化为签名；解析失败时退回原始文本。 */
export function canonicalJsonText(text: string): string {
  try {
    return stableStringify(JSON.parse(text));
  } catch {
    return text.trim();
  }
}

export function byteLengthUtf8(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * 按 UTF-8 字节数截断，且不切断代理对/多字节字符。
 * 结果可能略短于 maxBytes，但绝不会超出一个字符。
 */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (byteLengthUtf8(text) <= maxBytes) return text;
  let result = '';
  let used = 0;
  for (const character of text) {
    const size = byteLengthUtf8(character);
    if (used + size > maxBytes) break;
    result += character;
    used += size;
  }
  return result;
}

/** 按字符（码点）截断，用于回复长度上限。 */
export function truncateCharacters(text: string, maxCharacters: number): string {
  if (maxCharacters <= 0) return '';
  const characters = Array.from(text);
  if (characters.length <= maxCharacters) return text;
  return characters.slice(0, maxCharacters).join('');
}
