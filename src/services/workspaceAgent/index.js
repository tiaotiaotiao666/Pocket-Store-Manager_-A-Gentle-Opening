/**
 * B3：Workspace Agent renderer facade（新增 renderer 代码中唯一允许触碰 `window.smartStore` 的地方）。
 *
 * 职责：
 * - 只调用 preload 暴露的 `window.smartStore.workspaceAgent` 19 个语义方法 + onProgress，不拼 channel；
 * - 把结果归一为 `{ok:true,data,issues,meta}` / `{ok:false,code,message,data:null,issues,meta}`；
 * - 桥缺失 / 超时 / 取消 / 异常都返回结构化 envelope，不向 UI 抛异常；
 * - 取消：`cancelRun(projectId, runId)` 语义由主进程决定（requested/cancelled/too-late）。
 *
 * 注意：这里不做业务校验（页面/路径/版本），主进程会重新校验；facade 只负责传输与归一。
 */

export const WORKSPACE_AGENT_METHODS = Object.freeze([
  'runTurn',
  'getAttempt',
  'getContext',
  'listFiles',
  'readFile',
  'searchFiles',
  'writeFiles',
  'deleteFiles',
  'addImageAsset',
  'getDiff',
  'runCheck',
  'verifyWechat',
  'readVerification',
  'readArtifact',
  'submitCandidate',
  'adoptAttempt',
  'versions',
  'adoptVersion',
  'undo',
  'redo',
  'reopen',
  'cancelRun',
]);

const BRIDGE_KEY = 'workspaceAgent';
const TIMEOUT_TOKEN = Symbol('workspace-agent-timeout');

function baseMeta() {
  return { projectId: null, durationMs: 0, truncated: false };
}

function failure(code, message) {
  return {
    ok: false,
    code,
    message,
    data: null,
    issues: [],
    meta: baseMeta(),
  };
}

function normalizeEnvelope(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return failure('AGENT_PAYLOAD_INVALID', '桥接返回了无法识别的结果');
  }
  const meta = result.meta && typeof result.meta === 'object' ? result.meta : baseMeta();
  const issues = Array.isArray(result.issues) ? result.issues : [];
  if (result.ok === true) {
    return { ok: true, data: result.data === undefined ? null : result.data, issues, meta };
  }
  return {
    ok: false,
    code: typeof result.code === 'string' ? result.code : 'AGENT_PAYLOAD_INVALID',
    message: typeof result.message === 'string' ? result.message.slice(0, 240) : '请求失败',
    data: null,
    issues,
    meta,
  };
}

/** 解析 preload 注入的 workspaceAgent 命名空间（不缓存，便于测试/热更新替换）。 */
export function resolveWorkspaceAgentBridge(scope) {
  const target = scope || (typeof globalThis !== 'undefined' ? globalThis : undefined);
  const store = target && target.window && target.window.smartStore;
  if (!store || typeof store !== 'object') return null;
  const bridge = store[BRIDGE_KEY];
  return bridge && typeof bridge === 'object' ? bridge : null;
}

/**
 * @param {object} [options]
 * @param {() => object|null} [options.getBridge] 桥解析器（测试注入）
 * @param {number} [options.timeoutMs] 单次调用超时（>0 生效）
 * @param {{setTimeout:Function, clearTimeout:Function}} [options.timers]
 * @param {object} [options.scope] 解析 window 的 scope（默认 globalThis）
 */
export function createWorkspaceAgentFacade(options = {}) {
  const opts = options || {};
  const getBridge = typeof opts.getBridge === 'function'
    ? opts.getBridge
    : () => resolveWorkspaceAgentBridge(opts.scope);
  const timeoutMs = Number.isInteger(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 0;
  const timers = opts.timers || { setTimeout, clearTimeout };

  async function call(method, payload, callOptions) {
    const bridge = getBridge();
    if (!bridge || typeof bridge[method] !== 'function') {
      return failure('AGENT_RUNTIME_TOOL_MISSING', '桌面版 Workspace Agent 桥不可用');
    }
    const signal = callOptions && callOptions.signal;
    if (signal && signal.aborted) return failure('AGENT_CANCELLED', '请求已取消');
    let timer = null;
    try {
      const pending = Promise.resolve().then(() => bridge[method](payload));
      const raced = timeoutMs > 0
        ? Promise.race([
          pending,
          new Promise((resolvePromise) => {
            timer = timers.setTimeout(() => resolvePromise(TIMEOUT_TOKEN), timeoutMs);
            if (timer && typeof timer.unref === 'function') timer.unref();
          }),
        ])
        : pending;
      const result = await raced;
      if (result === TIMEOUT_TOKEN) return failure('AGENT_TIMEOUT', '请求超时');
      return normalizeEnvelope(result);
    } catch (error) {
      return failure('AGENT_PAYLOAD_INVALID', '桥接调用失败');
    } finally {
      if (timer) timers.clearTimeout(timer);
    }
  }

  const facade = {
    onProgress(listener) {
      if (typeof listener !== 'function') return () => {};
      const bridge = getBridge();
      if (!bridge || typeof bridge.onProgress !== 'function') return () => {};
      const unsubscribe = bridge.onProgress(listener);
      return typeof unsubscribe === 'function' ? unsubscribe : () => {};
    },
    get bridgeAvailable() {
      return Boolean(getBridge());
    },
  };

  for (const method of WORKSPACE_AGENT_METHODS) {
    facade[method] = (payload, callOptions) => call(method, payload, callOptions);
  }
  return Object.freeze(facade);
}

/** 默认单例：每次调用时解析当前 window，避免模块加载早于 preload 的场景。 */
export const workspaceAgent = createWorkspaceAgentFacade();

export default workspaceAgent;
