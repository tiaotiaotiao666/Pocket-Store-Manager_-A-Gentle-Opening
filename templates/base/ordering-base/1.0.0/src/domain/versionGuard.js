/**
 * 导出配置版本守卫。
 *
 * 在线数据为准：本地 store.generated.js 的版本只用于提示，不覆盖在线结果。
 */

function normalizeVersion(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function compareVersions(localVersion, onlineVersion) {
  const local = normalizeVersion(localVersion);
  const online = normalizeVersion(onlineVersion);
  if (online === null) {
    return { stale: false, shouldRefresh: false, unknown: true, message: '' };
  }
  if (local === null) {
    return { stale: false, shouldRefresh: false, unknown: true, message: '' };
  }
  if (local < online) {
    return {
      stale: true,
      shouldRefresh: true,
      unknown: false,
      message: '菜单配置已更新，请下拉刷新后再点餐。',
    };
  }
  return { stale: false, shouldRefresh: false, unknown: false, message: '' };
}

function resolveTables(remoteTables, demoFallback) {
  if (Array.isArray(remoteTables) && remoteTables.length > 0) {
    return { tables: remoteTables, source: 'remote', message: '' };
  }
  return {
    tables: Array.isArray(demoFallback) ? demoFallback : [],
    source: 'demo',
    message: '桌号接口暂不可用，当前显示演示桌号。',
  };
}

module.exports = {
  compareVersions,
  resolveTables,
};