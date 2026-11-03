const features = [
  { id: 'scan-order', label: '扫码点餐', group: '点餐', required: true, description: '扫码直达门店与餐桌，开始点餐' },
  { id: 'product-catalog', label: '商品与菜单', group: '点餐', required: true, description: '分类浏览、价格与售卖状态' },
  { id: 'cart-checkout', label: '购物车结算', group: '点餐', required: true, description: '选择堂食或自取，整理下单信息' },
  { id: 'order-tracking', label: '订单进度', group: '点餐', required: true, description: '顾客查看制作与取餐状态' },
  { id: 'table-dining', label: '堂食桌号', group: '门店服务', required: false, description: '桌码带入桌号，订单发送至店内' },
  { id: 'takeaway', label: '到店自取', group: '门店服务', required: false, description: '顾客下单后到店内取餐' },
  { id: 'merchant-orders', label: '店主接单', group: '门店管理', required: false, description: '查看新订单并推进制作状态' },
  { id: 'product-availability', label: '商品上下架', group: '门店管理', required: false, description: '忙碌时快速停售暂时卖完的商品' },
  { id: 'store-profile', label: '门店介绍', group: '经营资料', required: false, description: '营业时间、地址与联系方式' },
  { id: 'store-gallery', label: '门店环境', group: '经营资料', required: false, description: '在页面上展示门店实拍照片' },
  { id: 'loyalty-membership', label: '会员积分', group: '扩展功能', required: false, description: '会员成长、积分和优惠设计' },
];

const templates = [
  { id: 'warm-bistro', name: '街巷食集', category: '日常餐饮', badge: '人气样板', summary: '菜单优先，适合家常菜、轻食和社区餐馆。', layout: 'menu', features: ['scan-order', 'product-catalog', 'cart-checkout', 'order-tracking', 'table-dining', 'takeaway', 'merchant-orders', 'product-availability', 'store-profile'], keywords: ['家常', '家常菜', '社区', '街坊', '街巷', '小吃', '小馆', '菜单', '平价', '实惠', '烟火', '盖饭', '快餐', '分量', '下饭', '早餐', '面馆'] },
  { id: 'modern-coffee', name: '一杯日常', category: '咖啡茶饮', badge: '简洁清单', summary: '高效选购与轻量分类，适合咖啡、烘焙和茶饮。', layout: 'catalog', features: ['scan-order', 'product-catalog', 'cart-checkout', 'order-tracking', 'takeaway', 'merchant-orders', 'product-availability', 'store-profile'], keywords: ['咖啡', '咖啡厅', '茶饮', '奶茶', '烘焙', '面包', '甜品', '轻食', '简洁', '清爽', '高效', '快取', '外带', '自取', '清单', '极简'] },
  { id: 'signature-kitchen', name: '主厨推荐', category: '特色餐馆', badge: '推荐精选', summary: '大幅菜单主图和门店故事，适合有招牌菜的店铺。', layout: 'editorial', features: ['scan-order', 'product-catalog', 'cart-checkout', 'order-tracking', 'table-dining', 'takeaway', 'merchant-orders', 'store-profile', 'store-gallery'], keywords: ['招牌', '招牌菜', '主厨', '大图', '大片', '故事', '门店故事', '精致', '特色', '高级', '宴请', '品牌', '摄影', '氛围', '图片'] },
];

const themes = [
  { id: 'citrus', name: '柑橘清晨', caption: '清爽明亮 · 适合日常餐食', preview: ['#FAF7F1', '#E78A35', '#286957', '#29332F'] },
  { id: 'jade', name: '青瓷新叶', caption: '沉静自然 · 适合茶饮轻食', preview: ['#F0F4EF', '#47745D', '#D7A24D', '#24342D'] },
  { id: 'cherry', name: '樱桃午后', caption: '温暖醒目 · 适合特色餐馆', preview: ['#FCF4F0', '#C96049', '#E1AB62', '#312C2A'] },
  { id: 'ink', name: '白瓷墨色', caption: '清楚克制 · 适合咖啡烘焙', preview: ['#F5F5F2', '#334F59', '#BB7049', '#242825'] },
];

const iconCatalog = [
  { id: 'home', label: '门店首页', icon: 'House', tint: '#e8efe9' },
  { id: 'menu', label: '美味菜单', icon: 'CookingPot', tint: '#f5e7db' },
  { id: 'orders', label: '订单进度', icon: 'ClipboardList', tint: '#e6ebf4' },
  { id: 'merchant', label: '店主接单', icon: 'Store', tint: '#f3e8ec' },
  { id: 'profile', label: '门店资料', icon: 'BadgeInfo', tint: '#ece8f3' },
];

const templateModel = {
  baseFeatures: ['scan-order', 'product-catalog', 'cart-checkout', 'order-tracking'],
  moduleCoverage: { dining: ['table-dining'], pickup: ['takeaway'], merchant: ['merchant-orders', 'product-availability'], storeProfile: ['store-profile'], storeGallery: ['store-gallery'], membership: ['loyalty-membership'] },
};

/**
 * 找出自然语言描述里命中的模板关键词。
 * 长词优先去重：描述含「家常菜」时不再重复计「家常」。
 */
function matchedKeywordsFor(source, template) {
  const found = (template.keywords || []).filter((keyword) => source.includes(keyword));
  return found.filter((keyword) => !found.some((other) => (
    other !== keyword && other.length > keyword.length && other.includes(keyword)
  )));
}

/**
 * 按自然语言描述给模板关键词打分。
 *
 * 作用范围仅是「排序提示」：命中越多越靠前，未识别到任何关键词时
 * 返回 recognized=false，调用方应退回按功能清单匹配的顺序，不要假装理解了描述。
 *
 * @param {string} brief 用户的自然语言描述
 * @returns {{ recognized:boolean, order:string[], hits:Record<string,number>, matchedKeywords:Record<string,string[]>, topKeywords:string[] }}
 */
function rankTemplatesByBrief(brief) {
  const source = String(brief ?? '').trim();
  const hits = {};
  const matchedKeywords = {};
  templates.forEach((template) => {
    const matched = source ? matchedKeywordsFor(source, template) : [];
    hits[template.id] = matched.length;
    matchedKeywords[template.id] = matched;
  });
  const recognized = templates.some((template) => hits[template.id] > 0);
  const order = [...templates]
    .sort((a, b) => {
      const diff = hits[b.id] - hits[a.id];
      if (diff !== 0) return diff;
      return templates.indexOf(a) - templates.indexOf(b);
    })
    .map((template) => template.id);
  const topId = order[0];
  return {
    recognized,
    order: recognized ? order : templates.map((template) => template.id),
    hits,
    matchedKeywords,
    topKeywords: recognized && topId ? matchedKeywords[topId] : [],
  };
}

function matchTemplate(selectedFeatureIds) {
  const requested = new Set([...templateModel.baseFeatures, ...selectedFeatureIds]);
  const exactMatches = templates.map((template) => ({ template, matched: [...requested].filter((id) => template.features.includes(id)).length }));
  exactMatches.sort((a, b) => b.matched - a.matched || a.template.name.localeCompare(b.template.name, 'zh-CN'));
  const best = exactMatches[0];
  const provided = new Set(best.template.features);
  const modules = Object.entries(templateModel.moduleCoverage)
    .filter(([, moduleFeatures]) => moduleFeatures.every((feature) => requested.has(feature)))
    .filter(([, moduleFeatures]) => moduleFeatures.some((feature) => !provided.has(feature)))
    .map(([id]) => ({ dining: '堂食桌号', pickup: '到店自取', merchant: '店主接单', storeProfile: '门店介绍', storeGallery: '门店相册', membership: '会员积分' })[id]);
  const unsupported = [...requested].filter((id) => !provided.has(id) && !Object.values(templateModel.moduleCoverage).some((group) => group.includes(id)));
  return {
    template: best.template,
    score: requested.size ? Math.round((best.matched / requested.size) * 100) : 100,
    missing: [...requested].filter((id) => !provided.has(id) && !unsupported.includes(id)),
    addons: [...new Set(modules)],
    unsupported: unsupported.map((id) => features.find((item) => item.id === id)?.label ?? id),
  };
}

function makeProjectConfig({ storeName, selectedFeatures, templateId, themeId, selectedStyleIcons, images = [] }) {
  const selectedTemplate = templates.find((item) => item.id === templateId) ?? templates[0];
  const selectedTheme = themes.find((item) => item.id === themeId) ?? themes[0];
  const selectedFeaturesWithBase = [...new Set([...templateModel.baseFeatures, ...selectedFeatures])];
  const templatesFeatures = new Set(selectedTemplate.features);
  const match = matchTemplate(selectedFeatures);
  const todoFeatures = selectedFeaturesWithBase.filter((id) => !templatesFeatures.has(id));
  const templateNameMap = Object.fromEntries(features.map(({ id, label }) => [id, label]));
  return {
    schemaVersion: 1,
    productMode: 'independent-mini-program',
    storeName: storeName.trim().slice(0, 48) || '我的餐馆',
    features: selectedFeaturesWithBase,
    selectedFeatureNames: selectedFeaturesWithBase.map((id) => templateNameMap[id] ?? id),
    template: { id: selectedTemplate.id, name: selectedTemplate.name, layout: selectedTemplate.layout, fitScore: match.score },
    generatedModules: selectedFeaturesWithBase.filter((id) => templatesFeatures.has(id) && !templateModel.baseFeatures.includes(id)),
    pendingFeatures: todoFeatures,
    theme: { id: selectedTheme.id, name: selectedTheme.name, colors: [...selectedTheme.preview] },
    icons: selectedStyleIcons.map((icon) => ({ id: icon.id, label: icon.label, tint: icon.tint, source: 'local-placeholder', dataUrl: null })),
    media: images.slice(0, 6).map(({ name }) => ({ name })),
    paymentMode: 'demo',
    hasIndependentWechatIdentity: false,
  };
}

export { features, templates, themes, iconCatalog, templateModel, matchTemplate, makeProjectConfig, rankTemplatesByBrief };
