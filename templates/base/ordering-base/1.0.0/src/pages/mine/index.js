const config = require('../../config/env.js');
const errorText = require('../../domain/errorText.js');
const platform = require('../../services/platform.js');
const storeService = require('../../services/store.js');
const auth = require('../../services/auth.js');
const session = require('../../services/session.js');
const visitStore = require('../../state/visit-store.js');

const identityKeys = Object.keys(config.DEMO_IDENTITIES);
const IDENTITY_OPTIONS = identityKeys
  .map((key) => config.DEMO_IDENTITIES[key])
  .filter((preset) => preset && preset.key);

Page({
  data: {
    loading: true,
    loggedIn: false,
    user: null,
    identity: config.DEMO_IDENTITIES[config.DEFAULT_IDENTITY],
    identityOptions: IDENTITY_OPTIONS,
    memberships: [],
    merchantEntries: [],
    switching: '',
    error: '',
    storeName: '',
    demoMode: !config.USE_WECHAT_CODE_LOGIN,
    expiresText: '',
    avatarText: '客',
  },

  onShow() {
    this.refresh();
  },

  async refresh() {
    this.setData({ loading: true, error: '' });
    try {
      await auth.ensureLogin();
      this.applyUser();
      const visit = visitStore.load();
      try {
        const store = await storeService.getStore(visit.storeId);
        this.setData({ storeName: store.name });
      } catch (error) {
        this.setData({ storeName: '' });
      }
    } catch (error) {
      const described = errorText.describeError(error);
      this.setData({
        loading: false,
        loggedIn: false,
        error: described.message,
        identity: config.DEMO_IDENTITIES[config.DEFAULT_IDENTITY],
      });
    }
  },

  applyUser() {
    const user = session.getUser();
    const memberships = session.memberships();
    const merchantEntries = memberships
      .filter((item) => item && (item.role === 'OWNER' || item.role === 'STAFF'))
      .map((item) => ({
        storeId: item.storeId,
        role: item.role,
        roleLabel: item.role === 'OWNER' ? '店主' : '店员',
      }));
    const expiresAt = session.getExpiresAt();
    this.setData({
      loading: false,
      loggedIn: session.isLoggedIn(),
      user,
      identity: auth.currentIdentity(),
      memberships,
      merchantEntries,
      expiresText: expiresAt ? new Date(expiresAt).toLocaleDateString() : '',
      avatarText: user && user.displayName ? String(user.displayName).slice(0, 1) : '客',
    });
  },

  async onSwitchIdentity(event) {
    const key = event.currentTarget.dataset.key;
    if (!key || this.data.switching) {
      return;
    }
    const preset = config.DEMO_IDENTITIES[key];
    if (!preset) {
      return;
    }
    if (this.data.identity && this.data.identity.key === key && this.data.loggedIn) {
      platform.toast('当前已是' + preset.label);
      return;
    }
    const confirmed = await platform.modal({
      title: '切换演示身份',
      content: '将切换为「' + preset.label + '」，并重新建立会话。演示身份仅用于本地演示。',
      confirmText: '切换',
    });
    if (!confirmed.confirm) {
      return;
    }
    this.setData({ switching: key, error: '' });
    try {
      await auth.switchIdentity(key);
      this.applyUser();
      platform.toast('已切换为' + preset.label);
    } catch (error) {
      const described = errorText.describeError(error);
      this.setData({ error: described.message });
    } finally {
      this.setData({ switching: '' });
    }
  },

  onOpenMerchant(event) {
    const storeId = event.currentTarget.dataset.store;
    if (!storeId || typeof wx === 'undefined' || !wx.navigateTo) {
      return;
    }
    wx.navigateTo({ url: '/pages/merchant-orders/index?storeId=' + encodeURIComponent(storeId) });
  },

  onRefreshMe() {
    this.refresh();
  },

  goOrders() {
    if (typeof wx !== 'undefined' && wx.switchTab) {
      wx.switchTab({ url: '/pages/orders/index' });
    }
  },

  goHome() {
    if (typeof wx !== 'undefined' && wx.switchTab) {
      wx.switchTab({ url: '/pages/home/index' });
    }
  },
});