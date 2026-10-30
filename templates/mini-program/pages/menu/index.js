const config = require('../../config/store.generated');
Page({ data: { catalog: config.catalog }, onLoad(){ const pages=getCurrentPages(); if(pages.length===1) wx.setNavigationBarTitle({title:config.store.name}); } });
