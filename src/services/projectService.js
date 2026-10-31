/**
 * 项目服务（渲染进程唯一允许触碰 window.smartStore / localStorage 的项目入口）。
 *
 * 双 adapter：
 * - desktop：走 preload 暴露的 project:* / settings:* 通道，图片真实落盘。
 * - browser：localStorage 前缀存储，图片不落盘，UI 必须明示。
 *
 * 自动保存节流：桌面 800ms，浏览器 3000ms（localStorage 同步写会卡主线程）。
 * 契约来源：docs/2026-10-31-P0工作台与交接-实现方案.md 5.4、7.2。
 */

const BROWSER_PREFIX = 'smartstore.project.v1.';
const BROWSER_MAX_BYTES = 4 * 1024 * 1024;
const PROJECT_ID_RE = /^p_[a-z0-9]{8,24}$/;

function bridge() {
  if (typeof window === 'undefined') return null;
  const api = window.smartStore;
  if (!api || !api.isDesktop) return null;
  return api;
}

function storage() {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  return window.localStorage;
}

export function projectMode() {
  return bridge() ? 'desktop' : 'browser';
}

export function projectCapabilities() {
  const desktop = projectMode() === 'desktop';
  return {
    fileAssets: desktop,
    imageStorage: desktop,
    autoSave: true,
    appidWrite: desktop,
    devtoolsProbe: desktop,
    revealInFolder: desktop,
    mode: desktop ? 'desktop' : 'browser',
  };
}

function failure(code, message) {
  return { status: 'failed', code, message };
}

function desktopFailure(result, fallbackMessage) {
  return failure((result && result.code) || 'PROJECT_FAILED', (result && result.message) || fallbackMessage);
}

function browserDocument({ projectId, name, createdAt, appid }) {
  const stamp = createdAt || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const displayName = String(name || '').trim().slice(0, 60);
  return {
    schemaVersion: 1,
    projectId,
    createdAt: stamp,
    updatedAt: stamp,
    name: displayName,
    phase: 'home',
    activeSessionId: 'session-main',
    store: { name: displayName, type: '社区餐馆', notes: '', address: '', phone: '', logoAssetId: null, imageAssetIds: [] },
    features: { selected: ['scan-order', 'product-catalog', 'cart-checkout', 'order-tracking'], custom: '' },
    build: { candidates: [], selectedId: null },
    visual: { styleId: 'warm', prompt: '', promptRounds: [], imageRounds: [], imageAssetId: null, imageMeta: null },
    agentDraft: { storeName: displayName, category: '社区餐馆', businessHours: '', fulfillment: { dineIn: true, takeaway: false }, dishes: [] },
    agentConfirmedSeq: null,
    assets: { images: [] },
    sessions: [{ id: 'session-main', title: displayName || '待命名项目', kind: 'main', status: 'active', messages: [], handoff: null }],
    seq: 0,
    deploy: { directory: '', projectName: '', resultDigest: null, handoff: null },
    appid: typeof appid === 'string' ? appid : '',
    lastExportParent: '',
  };
}

function browserProjectId() {
  const stamp = Date.now().toString(36).padStart(8, '0').slice(-8);
  const random = Math.random().toString(36).slice(2, 8).padEnd(6, '0');
  return `p_${stamp}${random}`.replace(/[^a-z0-9_]/g, '0');
}

function listBrowserProjects() {
  const store = storage();
  if (!store) return [];
  const projects = [];
  for (let index = 0; index < store.length; index += 1) {
    const key = store.key(index);
    if (!key || !key.startsWith(BROWSER_PREFIX)) continue;
    const projectId = key.slice(BROWSER_PREFIX.length);
    if (!PROJECT_ID_RE.test(projectId)) continue;
    try {
      const doc = JSON.parse(store.getItem(key));
      const images = Array.isArray(doc.assets && doc.assets.images) ? doc.assets.images : [];
      projects.push({
        projectId,
        name: String(doc.name || projectId).slice(0, 60),
        updatedAt: typeof doc.updatedAt === 'string' ? doc.updatedAt : null,
        phase: typeof doc.phase === 'string' ? doc.phase : 'home',
        thumbnailAssetId: images[0]?.assetId ?? null,
        hasCorrupt: false,
        futureVersion: Number(doc.schemaVersion) > 1,
      });
    } catch (error) {
      projects.push({
        projectId,
        name: projectId,
        updatedAt: null,
        phase: 'home',
        thumbnailAssetId: null,
        hasCorrupt: true,
        futureVersion: false,
      });
    }
  }
  projects.sort((left, right) => {
    const leftTime = left.updatedAt ? Date.parse(left.updatedAt) : 0;
    const rightTime = right.updatedAt ? Date.parse(right.updatedAt) : 0;
    return rightTime - leftTime;
  });
  return projects;
}

/**
 * @param {{debounceMs?: number, browserDebounceMs?: number}} options
 */
export function createProjectService(options) {
  const opts = options || {};
  const mode = projectMode();
  let debounceMs = Number(opts.debounceMs)
    || Number(opts.browserDebounceMs)
    || (mode === 'desktop' ? 800 : 3000);
  let pending = null;
  let timer = null;
  let inflight = null;
  let lastResult = null;

  function setDebounce(ms) {
    const value = Number(ms);
    if (Number.isFinite(value) && value >= 300 && value <= 5000) debounceMs = value;
  }

  async function doSave(projectId, doc) {
    if (!PROJECT_ID_RE.test(String(projectId || ''))) return failure('PROJECT_INVALID_ID', '项目标识无效');
    if (mode === 'desktop') {
      const result = await bridge().projectSave({ projectId, doc });
      if (!result || result.ok !== true) return desktopFailure(result, '保存失败');
      return { status: 'ok', ...(result.data || {}) };
    }
    const store = storage();
    if (!store) return failure('PROJECT_WRITE_FAILED', '浏览器存储不可用');
    const text = JSON.stringify(doc);
    if (text.length * 2 > BROWSER_MAX_BYTES) {
      return failure('PROJECT_TOO_LARGE', '项目数据过大，请清理会话记录');
    }
    try {
      store.setItem(`${BROWSER_PREFIX}${projectId}`, text);
      return {
        status: 'ok',
        savedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        bytes: text.length * 2,
      };
    } catch (error) {
      return failure('PROJECT_TOO_LARGE', '浏览器存储空间不足，请清理会话记录');
    }
  }

  async function runPending() {
    if (!pending) {
      if (inflight) await inflight.catch(() => {});
      return lastResult || { status: 'ok', flushed: true };
    }
    const task = pending;
    pending = null;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    inflight = doSave(task.projectId, task.doc)
      .then((result) => {
        lastResult = result;
        task.resolve(result);
        return result;
      })
      .catch((error) => {
        const result = failure('PROJECT_WRITE_FAILED', error instanceof Error ? error.message : '保存失败');
        lastResult = result;
        task.resolve(result);
        return result;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  function scheduleSave(projectId, doc) {
    return new Promise((resolve) => {
      if (pending) pending.resolve({ status: 'superseded' });
      pending = { projectId, doc, resolve };
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void runPending();
      }, debounceMs);
    });
  }

  async function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const result = await runPending();
    if (inflight) await inflight;
    return result || { status: 'ok', flushed: true };
  }

  /** 丢弃尚未开始的保存（删除当前项目或重置前调用，避免又把目录写回来）。 */
  function cancelPending() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending) {
      pending.resolve({ status: 'cancelled' });
      pending = null;
    }
  }

  /** 关窗前 flush 握手：只暴露订阅与回执，不把 ipcRenderer 泄漏到组件层。 */
  function onFlushRequest(listener) {
    if (mode !== 'desktop' || typeof listener !== 'function') return () => {};
    const api = bridge();
    if (!api || typeof api.onProjectFlushRequest !== 'function') return () => {};
    const unsubscribe = api.onProjectFlushRequest(listener);
    return typeof unsubscribe === 'function' ? unsubscribe : () => {};
  }

  async function reportFlushDone() {
    if (mode !== 'desktop') return { status: 'ok' };
    const api = bridge();
    if (!api || typeof api.reportFlushDone !== 'function') return { status: 'ok' };
    const result = await api.reportFlushDone();
    return result && result.ok === false
      ? failure(result.code || 'PROJECT_WRITE_FAILED', result.message || 'flush 回执失败')
      : { status: 'ok' };
  }

  async function list() {
    if (mode === 'desktop') {
      const result = await bridge().projectList();
      if (!result || result.ok !== true) return desktopFailure(result, '项目列表读取失败');
      return { status: 'ok', projects: result.data?.projects || [] };
    }
    return { status: 'ok', projects: listBrowserProjects() };
  }

  async function create(payload) {
    const input = payload && typeof payload === 'object' ? payload : {};
    if (mode === 'desktop') {
      const result = await bridge().projectCreate(input);
      if (!result || result.ok !== true) return desktopFailure(result, '新建项目失败');
      return { status: 'ok', ...(result.data || {}) };
    }
    const store = storage();
    if (!store) return failure('PROJECT_WRITE_FAILED', '浏览器存储不可用');
    const projectId = browserProjectId();
    const createdAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const doc = browserDocument({ projectId, name: input.name, createdAt, appid: '' });
    try {
      store.setItem(`${BROWSER_PREFIX}${projectId}`, JSON.stringify(doc));
    } catch (error) {
      return failure('PROJECT_TOO_LARGE', '浏览器存储空间不足');
    }
    return { status: 'ok', projectId, createdAt, appid: '', name: doc.name };
  }

  async function load(projectId) {
    if (mode === 'desktop') {
      const result = await bridge().projectLoad({ projectId });
      if (!result || result.ok !== true) return desktopFailure(result, '项目读取失败');
      return { status: 'ok', ...(result.data || {}) };
    }
    const store = storage();
    if (!store) return failure('PROJECT_READ_FAILED', '浏览器存储不可用');
    const key = `${BROWSER_PREFIX}${projectId}`;
    const raw = store.getItem(key);
    if (!raw) return failure('PROJECT_NOT_FOUND', '项目不存在或已被删除');
    try {
      const doc = JSON.parse(raw);
      return {
        status: 'ok',
        doc,
        assets: Array.isArray(doc.assets?.images) ? doc.assets.images : [],
        savedAt: doc.updatedAt || null,
        bytes: raw.length * 2,
        futureVersion: Number(doc.schemaVersion) > 1,
        recoveredFrom: null,
        corrupt: false,
      };
    } catch (error) {
      return failure('PROJECT_PARSE_FAILED', '项目文件已损坏');
    }
  }

  async function remove(projectId, confirmName) {
    if (mode === 'desktop') {
      const result = await bridge().projectDelete({ projectId, confirmName });
      if (!result || result.ok !== true) return desktopFailure(result, '删除项目失败');
      return { status: 'ok', ...(result.data || {}) };
    }
    const store = storage();
    if (!store) return failure('PROJECT_WRITE_FAILED', '浏览器存储不可用');
    const key = `${BROWSER_PREFIX}${projectId}`;
    const raw = store.getItem(key);
    if (!raw) return failure('PROJECT_NOT_FOUND', '项目不存在或已被删除');
    let doc;
    try {
      doc = JSON.parse(raw);
    } catch (error) {
      return failure('PROJECT_PARSE_FAILED', '项目文件已损坏');
    }
    if (String(confirmName || '') !== String(doc.name || '').trim()) {
      return failure('PROJECT_DELETE_CONFIRM_MISMATCH', '项目名称不一致，已取消删除');
    }
    store.removeItem(key);
    return { status: 'ok', trashed: true, trashPath: null };
  }

  async function reveal(projectId) {
    if (mode !== 'desktop') return failure('DESKTOP_REQUIRED', '浏览器模式不能打开项目文件夹');
    const result = await bridge().projectReveal({ projectId });
    if (!result || result.ok !== true) return desktopFailure(result, '打开项目目录失败');
    return { status: 'ok', ...(result.data || {}) };
  }

  async function openDataDirectory() {
    if (mode !== 'desktop') return failure('DESKTOP_REQUIRED', '浏览器模式没有本机数据目录');
    const api = bridge();
    if (!api || typeof api.openDataDirectory !== 'function') {
      return failure('DESKTOP_REQUIRED', '当前版本不支持打开数据目录');
    }
    const result = await api.openDataDirectory();
    if (!result || result.ok !== true) return desktopFailure(result, '打开数据目录失败');
    return { status: 'ok' };
  }

  async function pickImages(max) {
    if (mode !== 'desktop') return failure('DESKTOP_REQUIRED', '浏览器模式不支持图片落盘');
    const result = await bridge().pickImages({ max });
    if (!result || result.ok !== true) return desktopFailure(result, '选择图片失败');
    return { status: 'ok', items: result.data?.items || [] };
  }

  async function attachImages(projectId, tokens) {
    if (mode !== 'desktop') return failure('DESKTOP_REQUIRED', '浏览器模式不支持图片落盘');
    const result = await bridge().attachImages({ projectId, tokens });
    if (!result || result.ok !== true) return desktopFailure(result, '导入图片失败');
    return { status: 'ok', assets: result.data?.assets || [] };
  }

  async function readAsset(projectId, assetId, maxWidth) {
    if (mode !== 'desktop') return failure('DESKTOP_REQUIRED', '浏览器模式不支持图片落盘');
    const result = await bridge().readAsset({ projectId, assetId, maxWidth });
    if (!result || result.ok !== true) return desktopFailure(result, '图片读取失败');
    return { status: 'ok', asset: result.data };
  }

  async function removeAsset(projectId, assetId) {
    if (mode !== 'desktop') return failure('DESKTOP_REQUIRED', '浏览器模式不支持图片落盘');
    const result = await bridge().removeAsset({ projectId, assetId });
    if (!result || result.ok !== true) return desktopFailure(result, '图片删除失败');
    return { status: 'ok', ...(result.data || {}) };
  }

  return {
    mode,
    capabilities: projectCapabilities(),
    list,
    create,
    load,
    save: scheduleSave,
    flush,
    cancelPending,
    onFlushRequest,
    reportFlushDone,
    openDataDirectory,
    remove,
    reveal,
    pickImages,
    attachImages,
    readAsset,
    removeAsset,
    setDebounce,
    getDebounce: () => debounceMs,
    getLastResult: () => lastResult,
    isPending: () => Boolean(pending || inflight),
  };
}

export const projectService = createProjectService();
export { BROWSER_PREFIX, BROWSER_MAX_BYTES, browserDocument };