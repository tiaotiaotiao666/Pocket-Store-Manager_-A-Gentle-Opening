import { createHash } from 'node:crypto';

/** 稳定 JSON：对象键排序、无空白、LF。用于幂等 requestHash 与 previewToken。 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'boolean' || type === 'string') return JSON.stringify(value);
  if (type === 'number') {
    if (!Number.isFinite(value as number)) throw new Error('NON_FINITE_NUMBER');
    return String(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((item) => canonicalJson(item)).join(',') + ']';
  }
  if (type === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
    return '{' + keys.map((key) => JSON.stringify(key) + ':' + canonicalJson(record[key])).join(',') + '}';
  }
  throw new Error('UNSUPPORTED_TYPE:' + type);
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function digestOf(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}