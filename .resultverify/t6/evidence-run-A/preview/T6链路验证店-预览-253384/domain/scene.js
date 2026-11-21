function safeDecode(value) {
  if (typeof value !== 'string') {
    return '';
  }
  try {
    return decodeURIComponent(value);
  } catch (error) {
    return value;
  }
}

function trimValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseQueryString(input) {
  const text = trimValue(input);
  if (!text) {
    return {};
  }
  const source = text.indexOf('?') >= 0 ? text.slice(text.indexOf('?') + 1) : text;
  const result = {};
  source.split('&').forEach((pair) => {
    if (!pair) {
      return;
    }
    const separator = pair.indexOf('=');
    const rawKey = separator >= 0 ? pair.slice(0, separator) : pair;
    const rawValue = separator >= 0 ? pair.slice(separator + 1) : '';
    const key = safeDecode(rawKey).trim();
    if (!key) {
      return;
    }
    result[key] = safeDecode(rawValue).trim();
  });
  return result;
}

function parseScene(scene) {
  const text = trimValue(scene);
  if (!text) {
    return { storeId: '', tableId: '', raw: '' };
  }

  const decoded = safeDecode(text);
  if (decoded.indexOf('=') < 0) {
    return { storeId: decoded.trim(), tableId: '', raw: text };
  }

  const query = parseQueryString(decoded);
  return {
    storeId: trimValue(query.storeId || query.store || query.s),
    tableId: trimValue(query.tableId || query.table || query.tid || query.t),
    raw: text,
  };
}

function readQueryValue(options, keys) {
  if (!options || typeof options !== 'object') {
    return '';
  }
  for (let index = 0; index < keys.length; index += 1) {
    const value = trimValue(options[keys[index]]);
    if (value) {
      return safeDecode(value);
    }
  }
  return '';
}

function resolveEntry(options, fallbackStoreId) {
  const safeOptions = options && typeof options === 'object' ? options : {};
  const scene = parseScene(readQueryValue(safeOptions, ['scene', 'q']));
  const queryStoreId = readQueryValue(safeOptions, ['storeId', 'store']);
  const queryTableId = readQueryValue(safeOptions, ['tableId', 'table']);
  const storeId = queryStoreId || scene.storeId || trimValue(fallbackStoreId);
  const tableId = queryTableId || scene.tableId;
  return {
    storeId,
    tableId,
    scene: scene.raw,
    fromScene: Boolean(scene.storeId || scene.tableId),
  };
}

function buildShareQuery(storeId, tableId) {
  const params = [];
  if (storeId) {
    params.push('storeId=' + encodeURIComponent(storeId));
  }
  if (tableId) {
    params.push('tableId=' + encodeURIComponent(tableId));
  }
  return params.join('&');
}

module.exports = {
  parseQueryString,
  parseScene,
  resolveEntry,
  buildShareQuery,
};