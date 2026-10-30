const store = require('./config/store.generated');

App({
  globalData: { store },
  onLaunch() { wx.setNavigationBarTitle({ title: store.store.name }); },
});
