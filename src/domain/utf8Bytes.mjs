/**
 * UTF-8 字节数计算（渲染进程与 Node 共用）。
 *
 * 渲染进程开了 `contextIsolation` 且 `nodeIntegration: false`，全局没有
 * `Buffer`；任何依赖 `Buffer.byteLength` 的「大小上限」判断在界面上都会
 * 直接抛错并退化成 `Number.MAX_SAFE_INTEGER`，表现为永远超限。
 * 因此统一走 `TextEncoder`（Node 11+ 与全部现代 Chromium 都有）。
 */

/**
 * @param {string} value 已序列化的字符串
 * @returns {number} UTF-8 字节数
 */
export function utf8ByteLength(value) {
  if (typeof value !== 'string') return 0;
  if (typeof TextEncoder === 'function') {
    return new TextEncoder().encode(value).length;
  }
  if (typeof Buffer !== 'undefined' && typeof Buffer.byteLength === 'function') {
    return Buffer.byteLength(value, 'utf8');
  }
  // 最后兜底：按最坏情况估算（每个 UTF-16 code unit 最多 3 字节），只用于渲染进程缺 TextEncoder 的极端情况。
  return value.length * 3;
}