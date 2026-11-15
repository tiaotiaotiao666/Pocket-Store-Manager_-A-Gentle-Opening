/**
 * 能力（capability）id 的唯一来源。
 *
 * 9 个基础能力由 Base 模板（ordering-base 1.0.0）固定实现：
 * 勾选/取消它们只会影响模板推荐与预览展示，不会从导出工程里增删页面或组件。
 * 其余能力（store-gallery / loyalty-membership 等）当前没有对应资产，
 * preflight 用 W-UNMAPPED-FEATURE 如实提示"不会写入导出工程"。
 *
 * 这里只描述"是否由 Base 内置"，不承载任何运行时开关语义：
 * 堂食/自取的真实开关来自门店资料（storeProfile.fulfillment）。
 */

export const BASE_CAPABILITY_IDS = Object.freeze([
  'scan-order',
  'product-catalog',
  'cart-checkout',
  'order-tracking',
  'table-dining',
  'takeaway',
  'merchant-orders',
  'product-availability',
  'store-profile',
]);

const BASE_CAPABILITY_SET = new Set(BASE_CAPABILITY_IDS);

/**
 * @param {unknown} id
 * @returns {boolean}
 */
export function isBaseCapability(id) {
  return typeof id === 'string' && BASE_CAPABILITY_SET.has(id);
}

export const BASE_CAPABILITIES = BASE_CAPABILITY_SET;
