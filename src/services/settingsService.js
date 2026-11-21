/**
 * 应用设置服务。桌面端走 settings:* 通道，浏览器端退化为 localStorage。
 * 组件不直接读桥接对象，只通过本服务。
 */

const CONFIG_KEY = 'smartstore.config.v1';

export const DEFAULT_SETTINGS = Object.freeze({
  schemaVersion: 1,
  apiBaseUrl: 'http://127.0.0.1:3000/api/v1',
  modelChannel: 'deepseek',
  modelApiBaseUrl: 'https://api.deepseek.com',
  modelName: 'deepseek-flash',
  modelTimeoutMs: 60000,
  agentTransport: 'direct',
  agentEndpoint: '/api/v1/agent/turn',
  agentTimeoutMs: 30000,
  defaultAppid: '',
  autoSaveEnabled: true,
  autoSaveDebounceMs: 800,
  maxBackups: 3,
  lastProjectId: '',
  uiScale: 'default',
});

/** 通道 → 内部 transport；只支持 DeepSeek 官方协议。 */
export function transportForChannel(channel) {
  return channel === 'server' ? 'http' : 'direct';
}

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

/** 旧配置里的 deepseek-chat 是官方别名，统一迁移到带图像理解能力的 deepseek-flash。 */
function migrateConfig(config) {
  if (config && config.modelName === 'deepseek-chat') {
    return { ...config, modelName: 'deepseek-flash' };
  }
  return config;
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
          return defaultLoadResult('这个版本还不支持读取设置，已用默认值；装最新版本就能改这些选项。');
        }
        const result = await withTimeout(api.settingsLoad(), 2500, null);
        if (!result) {
          return defaultLoadResult('设置读取超时，已用默认值。请重启桌面应用再试；还不行就在「设置与自检」里导出诊断日志。');
        }
        if (result.ok !== true) {
          return defaultLoadResult(result.message || '设置没读出来，已用默认值。可以在「设置与自检」里重试，或重启应用。');
        }
        const data = result.data || {};
        return {
          status: 'ok',
          config: migrateConfig({ ...DEFAULT_SETTINGS, ...(data.config || {}) }),
          source: data.source || 'file',
          warning: data.warning || null,
        };
      }
      const store = storage();
      if (!store) return defaultLoadResult(null);
      try {
        const raw = store.getItem(CONFIG_KEY);
        if (!raw) return defaultLoadResult(null);
        const config = migrateConfig({ ...DEFAULT_SETTINGS, ...JSON.parse(raw) });
        return { status: 'ok', config, source: 'file', warning: null };
      } catch (error) {
        return defaultLoadResult('浏览器里的设置已损坏，已用默认值。重新保存一次设置即可覆盖。');
      }
    } catch (error) {
      return defaultLoadResult('设置没读出来，已用默认值。可以重新打开设置页再试一次。');
    }
  }

  async function save(config) {
    const next = {
      ...config,
      // agentTransport 是派生值，界面上不暴露，避免通道与 transport 互相矛盾。
      agentTransport: transportForChannel(config?.modelChannel),
    };
    if (mode === 'desktop') {
      const api = bridge();
      if (!api || typeof api.settingsSave !== 'function') {
        return failure('SETTINGS_INVALID', '当前版本不支持设置保存');
      }
      const result = await api.settingsSave({ config: next });
      if (!result || result.ok !== true) {
        return failure(result?.code || 'SETTINGS_INVALID', result?.message || '设置保存失败');
      }
      return { status: 'ok', ...(result.data || {}) };
    }
    const store = storage();
    if (!store) return failure('SETTINGS_INVALID', '浏览器存储不可用');
    try {
      store.setItem(CONFIG_KEY, JSON.stringify(next));
      return { status: 'ok', config: next };
    } catch (error) {
      return failure('SETTINGS_INVALID', '浏览器存储空间不足');
    }
  }

  return { mode, load, save, defaults: DEFAULT_SETTINGS, model: createModelService(mode) };
}

/**
 * 模型与 API（只支持 DeepSeek 官方协议）。
 *
 * 桌面端：密钥由主进程 safeStorage 加密保存，渲染进程只能拿到「是否已配置」。
 * 浏览器端：没有安全存储，直接如实说明不可用，绝不明文存 Key。
 */
function createModelService(mode) {
  const unavailable = (message) => ({ status: 'failed', code: 'MODEL_UNAVAILABLE', message });

  async function status() {
    if (mode !== 'desktop') {
      return { status: 'ok', configured: false, updatedAt: null, supported: false };
    }
    const api = bridge();
    if (!api || typeof api.modelKeyStatus !== 'function') {
      return { status: 'ok', configured: false, updatedAt: null, supported: false };
    }
    const result = await withTimeout(api.modelKeyStatus(), 2500, null);
    if (!result || result.ok !== true) {
      return { status: 'ok', configured: false, updatedAt: null, supported: true };
    }
    const data = result.data || {};
    return {
      status: 'ok',
      configured: data.configured === true,
      updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : null,
      supported: true,
    };
  }

  async function saveKey(key) {
    if (mode !== 'desktop') {
      return unavailable('浏览器预览里不能保存 API Key，请在桌面应用里填写。');
    }
    const api = bridge();
    if (!api || typeof api.modelKeySave !== 'function') {
      return unavailable('当前版本不支持保存 API Key，请安装最新版本。');
    }
    const result = await api.modelKeySave({ key });
    if (!result || result.ok !== true) {
      return { status: 'failed', code: result?.code || 'MODEL_KEY_WRITE_FAILED', message: result?.message || 'API Key 保存失败' };
    }
    return { status: 'ok', ...(result.data || {}) };
  }

  async function clearKey() {
    if (mode !== 'desktop') return unavailable('浏览器预览里没有可清除的 API Key。');
    const api = bridge();
    if (!api || typeof api.modelKeyClear !== 'function') return unavailable('当前版本不支持清除 API Key。');
    const result = await api.modelKeyClear();
    if (!result || result.ok !== true) {
      return { status: 'failed', code: result?.code || 'MODEL_KEY_WRITE_FAILED', message: result?.message || 'API Key 清除失败' };
    }
    return { status: 'ok', ...(result.data || {}) };
  }

  async function test(config = {}) {
    if (mode !== 'desktop') {
      return unavailable('浏览器预览里无法连接模型服务，请在桌面应用里测试。');
    }
    const api = bridge();
    if (!api || typeof api.modelTest !== 'function') return unavailable('当前版本不支持测试连接。');
    const result = await api.modelTest({
      baseUrl: config.modelApiBaseUrl,
      model: config.modelName,
    });
    if (!result || result.ok !== true) {
      return {
        status: 'failed',
        code: result?.code || 'DEEPSEEK_UPSTREAM_ERROR',
        message: result?.message || '连接失败，请检查网络与 API 地址。',
      };
    }
    return { status: 'ok', ...(result.data || {}) };
  }

  return { status, saveKey, clearKey, test };
}

export const settingsService = createSettingsService();