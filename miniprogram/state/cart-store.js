const config = require('../config/env.js');
const platform = require('../services/platform.js');
const cart = require('../domain/cart.js');

function storageKey(storeId) {
  return config.STORAGE_PREFIX + '_cart:' + (storeId || config.DEFAULT_STORE_ID);
}

function load(storeId) {
  const raw = platform.storage.get(storageKey(storeId));
  if (!raw || typeof raw !== 'object') {
    return cart.emptyCart();
  }
  return cart.cloneCart(raw);
}

function save(storeId, nextCart) {
  const safe = cart.cloneCart(nextCart);
  platform.storage.set(storageKey(storeId), safe);
  return safe;
}

function add(storeId, product) {
  const result = cart.addItem(load(storeId), product);
  save(storeId, result.cart);
  return result;
}

function decrease(storeId, productId) {
  return save(storeId, cart.decreaseItem(load(storeId), productId));
}

function remove(storeId, productId) {
  return save(storeId, cart.removeItem(load(storeId), productId));
}

function setQuantity(storeId, productId, quantity) {
  return save(storeId, cart.setQuantity(load(storeId), productId, quantity));
}

function clear(storeId) {
  platform.storage.remove(storageKey(storeId));
  return cart.emptyCart();
}

function summary(storeId) {
  return cart.cartSummary(load(storeId));
}

function quantityOf(storeId, productId) {
  return cart.quantityOf(load(storeId), productId);
}

function toOrderItems(storeId) {
  return cart.toOrderItems(load(storeId));
}

function applyCatalog(storeId, catalog) {
  const merged = cart.mergeCatalogAvailability(load(storeId), catalog);
  save(storeId, merged.cart);
  return merged;
}

module.exports = {
  storageKey,
  load,
  save,
  add,
  decrease,
  remove,
  setQuantity,
  clear,
  summary,
  quantityOf,
  toOrderItems,
  applyCatalog,
};