const data = require('../../config/store.generated');
Page({ data: { store: data.store, products: data.catalog[0].products }, onMenu(){ wx.switchTab({url:'/pages/menu/index'}); } });
