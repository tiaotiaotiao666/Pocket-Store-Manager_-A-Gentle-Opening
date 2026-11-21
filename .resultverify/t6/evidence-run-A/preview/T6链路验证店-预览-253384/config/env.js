// 由 Composer 生成，勿手改。导出工程不得读取宿主环境变量。
const storeConfig = require('./store.generated.js');

function readConfig(path) {
  if (!storeConfig) return '';
  return path.split('.').reduce((value, key) => (value && typeof value === 'object' ? value[key] : ''), storeConfig) || '';
}

const API_BASE_URL = readConfig('api.baseUrl') || 'http://127.0.0.1:3000/api/v1';
const DEFAULT_STORE_ID = readConfig('store.id') || 'store-demo-001';
const REQUEST_TIMEOUT_MS = Number(readConfig('api.timeoutMs')) || 10000;
const STORAGE_PREFIX = 'smart_store_v1';
const USE_WECHAT_CODE_LOGIN = false;

const DEMO_IDENTITIES = {
  customer: { key: 'customer', label: '演示顾客', demoOpenId: 'demo-customer-001', description: '浏览菜单、下单与模拟支付' },
  owner: { key: 'owner', label: '演示店主', demoOpenId: 'demo-owner-001', description: '接单、推进状态与商品上下架' },
  staff: { key: 'staff', label: '演示店员', demoOpenId: 'demo-staff-001', description: '与店主相同的门店操作权限' },
};

const DEFAULT_IDENTITY = 'customer';

const DEMO_TABLES = [
  { id: 'tbl_A01', name: 'A01' },
  { id: 'tbl_A02', name: 'A02' },
];

const FULFILLMENT_TYPES = { DINE_IN: 'DINE_IN', TAKEAWAY: 'TAKEAWAY' };
const FULFILLMENT_TEXT = { DINE_IN: '堂食', TAKEAWAY: '到店自取' };

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
