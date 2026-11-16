/**
 * 桌号数据源（首页 / 菜单 / 结算三处共用）。
 *
 * 唯一真源是后端 `GET /stores/:id/tables`：
 * - 成功：映射成 `{ id, name }` 列表；
 * - 空列表：保持空态，交给页面渲染「门店还没有可用桌号」；
 * - 请求失败：清空列表并给出可展示的错误文案（由页面提供重试入口）。
 *
 * 任何情况下都不回退到本地固定桌号（历史实现里的 DEMO_TABLES 已移除）。
 */

const storeService = require('../services/store.js');
const errorText = require('./errorText.js');

function mapTables(payload) {
  const list = payload && Array.isArray(payload.tables) ? payload.tables : [];
  return list
    .filter((item) => item && typeof item.id === 'string' && item.id)
    .map((item) => ({ id: item.id, name: String(item.name || item.id) }));
}

function errorPatch(error) {
  let message = '桌号加载失败';
  try {
    const described = errorText.describeError(error);
    if (described && described.message) {
      message = described.message;
    }
  } catch {
    // describeError 自身异常时保留兜底文案
  }
  return { tableOptions: [], tablesLoading: false, tablesError: message };
}

/**
 * 读取门店桌号，返回可直接 setData 的状态补丁：
 * `{ tableOptions, tablesLoading, tablesError }`。
 */
async function loadTableOptions(storeId) {
  if (!storeId) {
    return { tableOptions: [], tablesLoading: false, tablesError: '缺少门店标识，无法读取桌号' };
  }
  try {
    const payload = await storeService.getTables(storeId);
    return { tableOptions: mapTables(payload), tablesLoading: false, tablesError: '' };
  } catch (error) {
    return errorPatch(error);
  }
}

/**
 * 扫码等入口只带 tableId 时，用刚拉到的门店桌号列表翻译出桌号名称。
 * 列表里没有该桌号就返回空字符串（由页面提示用户重新选桌）。
 */
function nameOfTable(list, tableId) {
  if (!tableId || !Array.isArray(list)) return '';
  const matched = list.filter((item) => item && item.id === tableId)[0];
  return matched ? matched.name : '';
}

module.exports = {
  mapTables,
  nameOfTable,
  loadTableOptions,
};
