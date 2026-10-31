/**
 * 应用设置服务。桌面端走 settings:* 通道，浏览器端退化为 localStorage。
 * 组件不直接读桥接对象，只通过本服务。
 */

const CONFIG_KEY = 'smartstore.config.v1';

export const DEFAULT_SETTINGS = Object.freeze({
  schemaVersion: 1,
  apiBaseUrl: 'http://127.0.0.1:3000/api/v1',
  agentTransport: 'mock',
  agentEndpoint: '/api/v1/agent/turn',
  agentTimeoutMs: 30000,
  defaultAppid: '',
  autoSaveEnabled: true,
  autoSaveDebounceMs: 800,
  maxBackups: 3,
  lastProjectId: '',
  uiScale: 'default',
});

function bridge() {
  if (typeof window === 'undefined') return null;
  const api = window.smartStore;
  return api && api.isDesktop ? api : null;
}

function storage() {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  return window.localStorage;
}

function failure(code, message) {
  return { status: 'failed', code, message };
}

function defaultLoadResult(warning) {
  return {
    status: 'ok',
    config: { ...DEFAULT_SETTINGS },
    source: 'default',
    warning: warning || null,
  };
}

/**
 * 桌面端 IPC 在「主进程未注册 / 主进程被旧进程占用」时会一直 pending，
 * 这会让设置页永久停在「正在读取应用设置…」。这里加超时兜底，保证 UI 一定能渲染。
 */
function withTimeout(promise, ms, fallback) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(() => finish(fallback), ms);
    if (typeof timer.unref === 'function') timer.unref();
    Promise.resolve(promise)
      .then((value) => {
        clearTimeout(timer);
        finish(value);
      })
      .catch(() => {
        clearTimeout(timer);
        finish(fallback);
      });
  });
}

export function createSettingsService() {
  const mode = bridge() ? 'desktop' : 'browser';

  async function load() {
    try {
      if (mode === 'desktop') {
        const api = bridge();
        if (!api || typeof api.settingsLoad !== 'function') {
          return defaultLoadResult('当前版本不支持设置读取，已使用默认值');
        }
        const result = await withTimeout(api.settingsLoad(), 2500, null);
        if (!result) {
          return defaultLoadResult('设置读取超时（主进程未响应），已使用默认值；请重启桌面应用');
        }
        if (result.ok !== true) {
          return defaultLoadResult(result.message || '设置读取失败，已使用默认值');
        }
        const data = result.data || {};
        return {
          status: 'ok',
          config: { ...DEFAULT_SETTINGS, ...(data.config || {}) },
          source: data.source || 'file',
          warning: data.warning || null,
        };
      }
      const store = storage();
      if (!store) return defaultLoadResult(null);
      try {
        const raw = store.getItem(CONFIG_KEY);
        if (!raw) return defaultLoadResult(null);
        const config = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
        return { status: 'ok', config, source: 'file', warning: null };
      } catch (error) {
        return defaultLoadResult('浏览器设置已损坏，已使用默认值');
      }
    } catch (error) {
      return defaultLoadResult('设置读取失败，已使用默认值');
    }
  }

  async function save(config) {
    if (mode === 'desktop') {
      const api = bridge();
      if (!api || typeof api.settingsSave !== 'function') {
        return failure('SETTINGS_INVALID', '当前版本不支持设置保存');
      }
      const result = await api.settingsSave({ config });
      if (!result || result.ok !== true) {
        return failure(result?.code || 'SETTINGS_INVALID', result?.message || '设置保存失败');
      }
      return { status: 'ok', ...(result.data || {}) };
    }
    const store = storage();
    if (!store) return failure('SETTINGS_INVALID', '浏览器存储不可用');
    try {
      store.setItem(CONFIG_KEY, JSON.stringify(config));
      return { status: 'ok', config };
    } catch (error) {
      return failure('SETTINGS_INVALID', '浏览器存储空间不足');
    }
  }

  return { mode, load, save, defaults: DEFAULT_SETTINGS };
}

export const settingsService = createSettingsService();