import { randomBytes } from 'node:crypto';

export const REQUEST_ID_HEADER = 'x-request-id';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,80}$/;

export function isValidRequestId(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value);
}

/**
 * 复用调用方提供的 requestId（便于网关/前端串联），否则生成新的。
 * 只允许可见 ASCII 安全字符，避免把任意头内容写回响应或日志。
 */
export function resolveRequestId(headers?: Record<string, unknown>, existing?: string): string {
  if (isValidRequestId(existing)) return existing;

  if (headers) {
    const raw = headers[REQUEST_ID_HEADER] ?? headers['X-Request-Id'];
    const single = Array.isArray(raw) ? raw[0] : raw;
    if (isValidRequestId(single)) return single;
  }

  return `req_${randomBytes(12).toString('hex')}`;
}