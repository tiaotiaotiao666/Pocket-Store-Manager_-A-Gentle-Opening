'use strict';

/**
 * HTTP 可选 transport（rev15 §14.7 末条）。
 *
 * 冻结口径：
 * - HTTP 只是**可选**通道：由 Coordinator 注册「短期、项目/run 绑定」的 RPC channel；
 *   桌面从不猜服务端地址，也不开公网文件代理。
 * - E0 只保证一件事：**未连接时明确 unavailable，且不影响 direct**。
 * - 因此这里**不伪造可用性**：没有 channel 就是 `available:false` + 稳定 reason，
 *   任何“看起来能用”的状态都必须来自真实注册的 channel（带 runId/projectId 绑定校验）。
 * - 不新增 AGENT_* 错误码（§14.9 不得私增）：unavailable 用结构化状态表达，不是错误码。
 */

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const UNAVAILABLE_REASON = 'HTTP_BRIDGE_NOT_CONNECTED';
const UNAVAILABLE_MESSAGE = 'HTTP 通道未连接（direct 不受影响）。';

/**
 * @param {object} options
 * @param {(binding: {projectId: string, runId: string}) => object|null} [options.resolveChannel]
 *        返回已注册的 channel（{ channelId, send }）；没有就返回 null/undefined。
 */
function createHttpBridge(options) {
  const opts = isPlainObject(options) ? options : {};
  const resolveChannel = typeof opts.resolveChannel === 'function' ? opts.resolveChannel : () => null;

  function bindingOf(input) {
    const source = isPlainObject(input) ? input : {};
    return {
      projectId: typeof source.projectId === 'string' ? source.projectId : '',
      runId: typeof source.runId === 'string' ? source.runId : '',
    };
  }

  function channelOf(binding) {
    if (!binding.projectId || !binding.runId) return null;
    let channel = null;
    try {
      channel = resolveChannel(binding);
    } catch (error) {
      channel = null;
    }
    if (!channel || typeof channel !== 'object' || typeof channel.send !== 'function') return null;
    // 只承认与本次 run 绑定的 channel：别的 run 的 channel 一律当作未连接。
    if (typeof channel.runId === 'string' && channel.runId !== binding.runId) return null;
    if (typeof channel.projectId === 'string' && channel.projectId !== binding.projectId) return null;
    return channel;
  }

  /** 只读状态：direct 永远可用；HTTP 只在真有 channel 时才算 available。 */
  function status(input) {
    const binding = bindingOf(input);
    const channel = channelOf(binding);
    if (!channel) {
      return {
        transport: 'http',
        available: false,
        reason: UNAVAILABLE_REASON,
        message: UNAVAILABLE_MESSAGE,
        binding,
      };
    }
    return {
      transport: 'http',
      available: true,
      reason: null,
      message: null,
      binding,
      channelId: typeof channel.channelId === 'string' ? channel.channelId : null,
    };
  }

  /** 发送（E0 不会走到这里，除非真的注册了 channel）；未连接时明确 unavailable。 */
  async function send(input) {
    const source = isPlainObject(input) ? input : {};
    const binding = bindingOf(source);
    const channel = channelOf(binding);
    if (!channel) {
      return {
        ok: false,
        transport: 'http',
        available: false,
        reason: UNAVAILABLE_REASON,
        message: UNAVAILABLE_MESSAGE,
        data: null,
      };
    }
    const result = await channel.send(source.request);
    return { ok: true, transport: 'http', available: true, reason: null, data: result === undefined ? null : result };
  }

  return { status, send, describe: () => status({}) };
}

module.exports = {
  createHttpBridge,
  UNAVAILABLE_REASON,
  UNAVAILABLE_MESSAGE,
};
