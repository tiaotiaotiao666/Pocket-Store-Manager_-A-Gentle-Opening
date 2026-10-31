// 运行时配置：导出工程只允许公开 API 地址、storeId 与公开配置。
// 优先级：config/store.generated.js 的 api.baseUrl > 进程环境变量 > 本地默认值。
// 生产模式下 store.generated.js 必须写入 HTTPS 地址；本地默认值仅用于 development。

const runtimeEnv = typeof process !== 'undefined' && process && process.env ? process.env : null;

function readEnv(key, fallback) {
  if (runtimeEnv && typeof runtimeEnv[key] === 'string' && runtimeEnv[key].trim()) {
    return runtimeEnv[key].trim();
  }
  return fallback;
}

let storeConfig = null;
try {
  storeConfig = require('./store.generated.js');
} catch (error) {
  storeConfig = null;
}

if (storeConfig && storeConfig.schemaVersion !== 2) {
  storeConfig = null;
}

function readStoreConfig(path) {
  if (!storeConfig) return '';
  return path.split('.').reduce((value, key) => (value && typeof value === 'object' ? value[key] : ''), storeConfig) || '';
}

const configBaseUrl = readStoreConfig('api.baseUrl');
const configStoreId = readStoreConfig('store.id');
const API_BASE_URL = configBaseUrl || readEnv('MINIPROGRAM_API_BASE_URL', 'http://127.0.0.1:3000/api/v1');
const DEFAULT_STORE_ID = configStoreId || readEnv('MINIPROGRAM_STORE_ID', 'store-demo-001');
const REQUEST_TIMEOUT_MS = Number(readStoreConfig('api.timeoutMs')) || 10000;
const STORAGE_PREFIX = 'smart_store_v1';

const USE_WECHAT_CODE_LOGIN = readEnv('MINIPROGRAM_USE_WECHAT_CODE', 'false') === 'true';

const DEMO_IDENTITIES = {
  customer: {
    key: 'customer',
    label: '演示顾客',
    demoOpenId: 'demo-customer-001',
    description: '浏览菜单、下单与模拟支付',
  },
  owner: {
    key: 'owner',
    label: '演示店主',
    demoOpenId: 'demo-owner-001',
    description: '接单、推进状态与商品上下架',
  },
  staff: {
    key: 'staff',
    label: '演示店员',
    demoOpenId: 'demo-staff-001',
    description: '与店主相同的门店操作权限',
  },
};

const DEFAULT_IDENTITY = 'customer';

const DEMO_TABLES = [
  { id: 'tbl_A01', name: 'A01' },
  { id: 'tbl_A02', name: 'A02' },
];

const FULFILLMENT_TYPES = {
  DINE_IN: 'DINE_IN',
  TAKEAWAY: 'TAKEAWAY',
};

const FULFILLMENT_TEXT = {
  DINE_IN: '堂食',
  TAKEAWAY: '到店自取',
};

module.exports = {
  API_BASE_URL,
  DEFAULT_STORE_ID,
  REQUEST_TIMEOUT_MS,
  STORAGE_PREFIX,
  USE_WECHAT_CODE_LOGIN,
  DEMO_IDENTITIES,
  DEFAULT_IDENTITY,
  DEMO_TABLES,
  FULFILLMENT_TYPES,
  FULFILLMENT_TEXT,
  STORE_CONFIG: storeConfig,
};