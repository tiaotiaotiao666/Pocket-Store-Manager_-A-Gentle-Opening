/**
 * 工作台项目缩略图加载器。
 *
 * 约束：
 * - 只处理合法且非空的 projectId + thumbnailAssetId。
 * - 全局并发默认 4，避免一次列表刷新打出几十个 IPC 读取。
 * - 同键请求去重；成功后缓存，失败不缓存以便下次重试。
 * - 缓存上限默认 100，按最近使用顺序淘汰。
 * - 不直接访问 window.smartStore，readAsset 由调用方注入。
 */

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MAX_CACHE_ENTRIES = 100;
const THUMBNAIL_MAX_WIDTH = 320;

function normalizePositiveInteger(value, fallback, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) return fallback;
  return Math.min(maximum, Math.floor(number));
}

function isValidResult(result) {
  return Boolean(
    result
    && result.status === 'ok'
    && result.asset
    && typeof result.asset.dataUrl === 'string'
    && result.asset.dataUrl.length > 0,
  );
}

function validProject(project) {
  return Boolean(project && project.projectId && project.thumbnailAssetId);
}

/**
 * @param {{
 *   readAsset?: (projectId: string, assetId: string, maxWidth?: number) => Promise<any>,
 *   concurrency?: number,
 *   maxCacheEntries?: number
 * }} options
 */
export function createProjectThumbnailLoader(options) {
  const opts = options || {};
  const readAsset = typeof opts.readAsset === 'function' ? opts.readAsset : null;
  const concurrency = normalizePositiveInteger(opts.concurrency, DEFAULT_CONCURRENCY, 16);
  const maxCacheEntries = normalizePositiveInteger(opts.maxCacheEntries, DEFAULT_MAX_CACHE_ENTRIES, 1000);

  const cache = new Map();
  const inflight = new Map();
  const queue = [];
  let active = 0;
  let generation = 0;

  function cacheGet(key) {
    if (!cache.has(key)) return undefined;
    const value = cache.get(key);
    cache.delete(key);
    cache.set(key, value);
    return value;
  }

  function cacheSet(key, value, requestGeneration) {
    if (requestGeneration !== generation) return;
    cache.delete(key);
    cache.set(key, value);
    while (cache.size > maxCacheEntries) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }

  function drain() {
    while (active < concurrency && queue.length > 0) {
      const item = queue.shift();
      active += 1;
      Promise.resolve()
        .then(item.task)
        .then(item.resolve, () => item.resolve(null))
        .finally(() => {
          active -= 1;
          drain();
        });
    }
  }

  function schedule(task) {
    return new Promise((resolve) => {
      queue.push({ task, resolve });
      drain();
    });
  }

  function request(key, projectId, assetId, requestGeneration) {
    const existing = inflight.get(key);
    if (existing) return existing;

    const promise = schedule(async () => {
      if (!readAsset) return null;
      const result = await readAsset(projectId, assetId, THUMBNAIL_MAX_WIDTH);
      if (!isValidResult(result)) return null;
      cacheSet(key, result.asset.dataUrl, requestGeneration);
      return result.asset.dataUrl;
    }).finally(() => {
      if (inflight.get(key) === promise) inflight.delete(key);
    });

    inflight.set(key, promise);
    return promise;
  }

  async function load(projects) {
    const list = Array.isArray(projects) ? projects : [];
    const requestGeneration = generation;

    const entries = await Promise.all(list.map(async (project) => {
      if (!validProject(project)) {
        return [project && project.projectId ? project.projectId : '', null];
      }
      const projectId = project.projectId;
      const assetId = project.thumbnailAssetId;
      const key = `${projectId}:${assetId}`;
      const cached = cacheGet(key);
      if (cached !== undefined) return [projectId, cached];
      const dataUrl = await request(key, projectId, assetId, requestGeneration);
      return [projectId, dataUrl];
    }));

    const result = {};
    entries.forEach(([projectId, dataUrl]) => {
      if (projectId) result[projectId] = dataUrl;
    });
    return result;
  }

  function clear() {
    generation += 1;
    cache.clear();
    inflight.clear();
  }

  return {
    load,
    clear,
    getCacheSize: () => cache.size,
    getConcurrency: () => concurrency,
  };
}