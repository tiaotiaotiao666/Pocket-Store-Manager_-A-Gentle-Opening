const config = require('../config/env.js');
const platform = require('../services/platform.js');

const STORAGE_KEY = config.STORAGE_PREFIX + '_visit';

function defaultVisit() {
  return {
    storeId: config.DEFAULT_STORE_ID,
    storeName: '',
    tableId: '',
    tableName: '',
    fulfillmentType: config.FULFILLMENT_TYPES.TAKEAWAY,
    dineInEnabled: true,
    takeawayEnabled: true,
    fromScene: false,
  };
}

function load() {
  const raw = platform.storage.get(STORAGE_KEY);
  if (!raw || typeof raw !== 'object') {
    return defaultVisit();
  }
  return {
    storeId: typeof raw.storeId === 'string' && raw.storeId ? raw.storeId : config.DEFAULT_STORE_ID,
    storeName: typeof raw.storeName === 'string' ? raw.storeName : '',
    tableId: typeof raw.tableId === 'string' ? raw.tableId : '',
    tableName: typeof raw.tableName === 'string' ? raw.tableName : '',
    fulfillmentType:
      raw.fulfillmentType === config.FULFILLMENT_TYPES.DINE_IN
        ? config.FULFILLMENT_TYPES.DINE_IN
        : config.FULFILLMENT_TYPES.TAKEAWAY,
    dineInEnabled: raw.dineInEnabled !== false,
    takeawayEnabled: raw.takeawayEnabled !== false,
    fromScene: Boolean(raw.fromScene),
  };
}

function save(visit) {
  const next = Object.assign(defaultVisit(), visit || {});
  platform.storage.set(STORAGE_KEY, next);
  return next;
}

function resolveTableName(tableId) {
  if (!tableId) {
    return '';
  }
  const matched = config.DEMO_TABLES.filter((table) => table.id === tableId)[0];
  if (matched) {
    return matched.name;
  }
  return tableId;
}

function applyEntry(entry) {
  const input = entry || {};
  const current = load();
  const storeChanged = input.storeId && input.storeId !== current.storeId;

  const next = Object.assign({}, current, {
    storeId: input.storeId || current.storeId,
    fromScene: Boolean(input.fromScene),
  });

  if (storeChanged) {
    next.storeName = '';
    next.tableId = '';
    next.tableName = '';
    next.fulfillmentType = config.FULFILLMENT_TYPES.TAKEAWAY;
  }

  if (input.tableId) {
    next.tableId = input.tableId;
    next.tableName = resolveTableName(input.tableId);
    next.fulfillmentType = config.FULFILLMENT_TYPES.DINE_IN;
  } else if (input.fromScene) {
    next.tableId = '';
    next.tableName = '';
    next.fulfillmentType = config.FULFILLMENT_TYPES.TAKEAWAY;
  }

  return save(next);
}

function applyStore(store) {
  const current = load();
  if (!store || !store.id) {
    return current;
  }
  const fulfillment = store.fulfillment || {};
  const dineInEnabled = fulfillment.dineIn !== false;
  const takeawayEnabled = fulfillment.takeaway !== false;
  let fulfillmentType = current.fulfillmentType;
  if (!dineInEnabled || (fulfillmentType === config.FULFILLMENT_TYPES.DINE_IN && !current.tableId)) {
    fulfillmentType = config.FULFILLMENT_TYPES.TAKEAWAY;
  }
  if (!takeawayEnabled) {
    fulfillmentType = config.FULFILLMENT_TYPES.DINE_IN;
  }
  return save(
    Object.assign({}, current, {
      storeId: store.id,
      storeName: store.name || current.storeName,
      dineInEnabled,
      takeawayEnabled,
      fulfillmentType,
    }),
  );
}

function setFulfillment(fulfillmentType) {
  const current = load();
  if (fulfillmentType !== config.FULFILLMENT_TYPES.DINE_IN && fulfillmentType !== config.FULFILLMENT_TYPES.TAKEAWAY) {
    return current;
  }
  return save(Object.assign({}, current, { fulfillmentType }));
}

function setTable(tableId, tableName) {
  const current = load();
  return save(
    Object.assign({}, current, {
      tableId: tableId || '',
      tableName: tableName || resolveTableName(tableId),
      fulfillmentType: tableId ? config.FULFILLMENT_TYPES.DINE_IN : current.fulfillmentType,
    }),
  );
}

function clearTable() {
  const current = load();
  return save(
    Object.assign({}, current, {
      tableId: '',
      tableName: '',
    }),
  );
}

function reset() {
  platform.storage.remove(STORAGE_KEY);
  return defaultVisit();
}

module.exports = {
  STORAGE_KEY,
  defaultVisit,
  load,
  save,
  applyEntry,
  applyStore,
  setFulfillment,
  setTable,
  clearTable,
  reset,
  resolveTableName,
};