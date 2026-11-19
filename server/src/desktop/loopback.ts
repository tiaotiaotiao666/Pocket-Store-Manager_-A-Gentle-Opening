/**
 * B2：本机回环判定。
 *
 * 只用于两件事：
 * 1. 后端默认只监听 127.0.0.1（见 main.ts / env.validation.ts）；
 * 2. 桌面会话只有本机进程才允许申领（见 desktop-session.controller.ts）。
 *
 * 注意：回环只是「最低门槛」，不是凭证。模型接口一律要 Bearer，
 * 不因为「来自本机」就放行（避免把 CORS/回环当成鉴权）。
 */

const LOOPBACK_V4 = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** 常见写法都算本机：IPv4 回环、IPv6 回环、IPv4-mapped IPv6 回环。 */
export function isLoopbackAddress(address: unknown): boolean {
  if (typeof address !== 'string') return false;
  let value = address.trim();
  if (!value) return false;
  // Express/Node 可能给出 `::ffff:127.0.0.1`、带 zone 的 `::1%lo0`。
  const zoneIndex = value.indexOf('%');
  if (zoneIndex > 0) value = value.slice(0, zoneIndex);
  if (value.startsWith('::ffff:')) value = value.slice('::ffff:'.length);
  if (value === '::1') return true;
  const match = LOOPBACK_V4.exec(value);
  if (!match) return false;
  return match.slice(1).every((part) => Number(part) <= 255);
}

/**
 * 监听地址是否只对本机开放。
 * `0.0.0.0` / `::` / 具体网卡 IP 都算「对外暴露」，必须走显式配置。
 */
export function isLoopbackHost(host: unknown): boolean {
  if (typeof host !== 'string') return false;
  const value = host.trim().toLowerCase();
  if (value === 'localhost') return true;
  return isLoopbackAddress(value);
}
