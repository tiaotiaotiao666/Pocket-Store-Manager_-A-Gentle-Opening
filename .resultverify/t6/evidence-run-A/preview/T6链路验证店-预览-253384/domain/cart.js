const money = require('./money.js');

const MAX_QUANTITY = 99;
const MIN_QUANTITY = 1;

function emptyCart() {
  return {};
}

function cloneCart(cart) {
  const source = cart && typeof cart === 'object' ? cart : {};
  const next = {};
  Object.keys(source).forEach((productId) => {
    const item = source[productId];
    if (!item) {
      return;
    }
    next[productId] = {
      productId: item.productId || productId,
      name: item.name || '',
      unitPriceCents: money.toSafeCents(item.unitPriceCents),
      quantity: normalizeQuantity(item.quantity),
    };
  });
  return next;
}

function normalizeQuantity(quantity) {
  const number = Math.floor(Number(quantity));
  if (!Number.isFinite(number) || number < MIN_QUANTITY) {
    return 0;
  }
  return Math.min(number, MAX_QUANTITY);
}

function toCartItem(product, quantity) {
  return {
    productId: product.id,
    name: typeof product.name === 'string' ? product.name : '',
    unitPriceCents: money.toSafeCents(product.priceCents),
    quantity,
  };
}

function addItem(cart, product) {
  const source = cloneCart(cart);
  if (!product || !product.id) {
    return { cart: source, added: false, limited: false, reason: 'INVALID_PRODUCT' };
  }
  if (product.available === false) {
    return { cart: source, added: false, limited: false, reason: 'UNAVAILABLE' };
  }
  const current = source[product.id];
  const nextQuantity = (current ? current.quantity : 0) + 1;
  if (nextQuantity > MAX_QUANTITY) {
    return { cart: source, added: false, limited: true, reason: 'MAX_QUANTITY' };
  }
  source[product.id] = toCartItem(product, nextQuantity);
  return { cart: source, added: true, limited: false, reason: '' };
}

function removeItem(cart, productId) {
  const source = cloneCart(cart);
  if (!productId || !source[productId]) {
    return source;
  }
  delete source[productId];
  return source;
}

function decreaseItem(cart, productId) {
  const source = cloneCart(cart);
  if (!productId || !source[productId]) {
    return source;
  }
  const nextQuantity = source[productId].quantity - 1;
  if (nextQuantity < MIN_QUANTITY) {
    delete source[productId];
    return source;
  }
  source[productId] = Object.assign({}, source[productId], { quantity: nextQuantity });
  return source;
}

function setQuantity(cart, productId, quantity) {
  const source = cloneCart(cart);
  if (!productId || !source[productId]) {
    return source;
  }
  const nextQuantity = normalizeQuantity(quantity);
  if (nextQuantity === 0) {
    delete source[productId];
    return source;
  }
  source[productId] = Object.assign({}, source[productId], { quantity: nextQuantity });
  return source;
}

function hasItem(cart, productId) {
  return Boolean(cart && productId && cart[productId]);
}

function quantityOf(cart, productId) {
  if (!cart || !productId || !cart[productId]) {
    return 0;
  }
  return normalizeQuantity(cart[productId].quantity);
}

function cartItems(cart) {
  const source = cloneCart(cart);
  return Object.keys(source).map((productId) => {
    const item = source[productId];
    return {
      productId: item.productId,
      name: item.name,
      unitPriceCents: item.unitPriceCents,
      quantity: item.quantity,
      lineTotalCents: item.unitPriceCents * item.quantity,
    };
  });
}

function cartSummary(cart) {
  const items = cartItems(cart);
  const totalCents = money.sumCents(items.map((item) => item.lineTotalCents));
  const totalQuantity = items.reduce((total, item) => total + item.quantity, 0);
  return {
    items,
    totalCents,
    totalQuantity,
    isEmpty: items.length === 0,
  };
}

function toOrderItems(cart) {
  return cartItems(cart).map((item) => ({
    productId: item.productId,
    quantity: item.quantity,
  }));
}

function mergeCatalogAvailability(cart, catalog) {
  const source = cloneCart(cart);
  const available = {};
  const categories = catalog && Array.isArray(catalog.categories) ? catalog.categories : [];
  categories.forEach((category) => {
    const products = Array.isArray(category.products) ? category.products : [];
    products.forEach((product) => {
      available[product.id] = product;
    });
  });

  const next = {};
  const removed = [];
  Object.keys(source).forEach((productId) => {
    const item = source[productId];
    const product = available[productId];
    if (!product || product.available === false) {
      removed.push(item);
      return;
    }
    next[productId] = Object.assign({}, item, {
      name: product.name || item.name,
      unitPriceCents: money.toSafeCents(product.priceCents),
    });
  });
  return { cart: next, removed };
}

module.exports = {
  MAX_QUANTITY,
  MIN_QUANTITY,
  emptyCart,
  cloneCart,
  normalizeQuantity,
  addItem,
  removeItem,
  decreaseItem,
  setQuantity,
  hasItem,
  quantityOf,
  cartItems,
  cartSummary,
  toOrderItems,
  mergeCatalogAvailability,
};