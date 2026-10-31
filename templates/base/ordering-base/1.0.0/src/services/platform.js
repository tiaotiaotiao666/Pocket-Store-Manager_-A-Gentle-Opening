const memoryStorage = new Map();

function hasWx() {
  return typeof wx !== 'undefined' && wx && typeof wx.getStorageSync === 'function';
}

const storage = {
  get(key) {
    if (hasWx()) {
      try {
        const value = wx.getStorageSync(key);
        return value === '' || value === undefined ? null : value;
      } catch (error) {
        return null;
      }
    }
    return memoryStorage.has(key) ? memoryStorage.get(key) : null;
  },
  set(key, value) {
    if (hasWx()) {
      try {
        wx.setStorageSync(key, value);
        return true;
      } catch (error) {
        return false;
      }
    }
    memoryStorage.set(key, value);
    return true;
  },
  remove(key) {
    if (hasWx()) {
      try {
        wx.removeStorageSync(key);
        return true;
      } catch (error) {
        return false;
      }
    }
    memoryStorage.delete(key);
    return true;
  },
  clearMemory() {
    memoryStorage.clear();
  },
};

function sendWithFetch(options, callback) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), options.timeout || 10000)
    : null;
  const init = {
    method: options.method || 'GET',
    headers: options.header || {},
  };
  if (options.data !== undefined && options.data !== null && init.method !== 'GET') {
    init.body = JSON.stringify(options.data);
  }
  if (controller) {
    init.signal = controller.signal;
  }

  fetch(options.url, init)
    .then(async (response) => {
      const text = await response.text();
      let body = text;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch (error) {
          body = text;
        }
      } else {
        body = {};
      }
      if (timer) {
        clearTimeout(timer);
      }
      callback({
        statusCode: response.status,
        data: body,
        header: {},
      });
    })
    .catch((error) => {
      if (timer) {
        clearTimeout(timer);
      }
      const aborted = error && (error.name === 'AbortError' || error.name === 'TimeoutError');
      callback({
        error: {
          errMsg: aborted ? 'request:fail timeout' : 'request:fail ' + (error && error.message ? error.message : 'network error'),
          timeout: aborted,
        },
      });
    });
}

function sendRequest(options, callback) {
  if (hasWx() && typeof wx.request === 'function') {
    wx.request({
      url: options.url,
      method: options.method || 'GET',
      header: options.header || {},
      data: options.data,
      timeout: options.timeout || 10000,
      success(response) {
        callback({
          statusCode: response.statusCode,
          data: response.data,
          header: response.header || {},
        });
      },
      fail(error) {
        callback({
          error: {
            errMsg: error && error.errMsg ? error.errMsg : 'request:fail',
            timeout: Boolean(error && /timeout/i.test(error.errMsg || '')),
          },
        });
      },
    });
    return;
  }

  if (typeof fetch === 'function') {
    sendWithFetch(options, callback);
    return;
  }

  callback({ error: { errMsg: 'request:fail transport unavailable', timeout: false } });
}

function loginWithWechatCode() {
  return new Promise((resolve, reject) => {
    if (!hasWx() || typeof wx.login !== 'function') {
      reject(new Error('wx.login 不可用'));
      return;
    }
    wx.login({
      success(result) {
        if (result && result.code) {
          resolve(result.code);
          return;
        }
        reject(new Error('微信登录未返回 code'));
      },
      fail(error) {
        reject(new Error(error && error.errMsg ? error.errMsg : 'wx.login 失败'));
      },
    });
  });
}

function toast(title, icon) {
  if (hasWx() && typeof wx.showToast === 'function') {
    wx.showToast({ title, icon: icon || 'none', duration: 2000 });
    return;
  }
  if (typeof console !== 'undefined' && console.log) {
    console.log('[toast] ' + title);
  }
}

function modal(options) {
  return new Promise((resolve) => {
    if (hasWx() && typeof wx.showModal === 'function') {
      wx.showModal({
        title: options.title || '提示',
        content: options.content || '',
        confirmText: options.confirmText || '确定',
        cancelText: options.cancelText || '取消',
        editable: Boolean(options.editable),
        placeholderText: options.placeholderText || '',
        success(result) {
          resolve({
            confirm: Boolean(result.confirm),
            cancel: Boolean(result.cancel),
            content: result.content || '',
          });
        },
        fail() {
          resolve({ confirm: false, cancel: true, content: '' });
        },
      });
      return;
    }
    resolve({ confirm: true, cancel: false, content: options.defaultContent || '' });
  });
}

module.exports = {
  hasWx,
  storage,
  sendRequest,
  loginWithWechatCode,
  toast,
  modal,
  memoryStorage,
};