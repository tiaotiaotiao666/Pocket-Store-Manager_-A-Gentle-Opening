const config = require('../../config/env.js');
const money = require('../../domain/money.js');
const orderView = require('../../domain/orderView.js');
const errorText = require('../../domain/errorText.js');
const platform = require('../../services/platform.js');
const storeService = require('../../services/store.js');
const merchantService = require('../../services/merchant.js');
const auth = require('../../services/auth.js');
const session = require('../../services/session.js');

const CANCEL_REASONS = ['原料售罄', '顾客要求取消', '门店临时打烊', '其他原因'];
const POLL_INTERVAL_MS = 10000;

const SEGMENTS = [
  { key: 'pending', label: '新订单', status: 'PENDING_ACCEPT', emptyText: '暂时没有新订单' },
  { key: 'preparing', label: '制作中', status: 'PREPARING', emptyText: '暂时没有制作中的订单' },
  { key: 'ready', label: '待取餐', status: 'READY', emptyText: '暂时没有待取餐订单' },
  { key: 'history', label: '历史', status: 'COMPLETED,CANCELLED', emptyText: '暂时没有历史订单' },
];

Page({
  data: {
    storeId: '',
    storeName: '',
    roleLabel: '',
    isOwner: false,
    checking: true,
    allowed: false,
    loading: false,
    ordersLoading: false,
    productsLoading: false,
    postersLoading: false,
    error: '',
    errorAction: '',
    requestId: '',
    tab: 'orders',
    segment: 'pending',
    segments: SEGMENTS.map((item) => ({ key: item.key, label: item.label })),
    orders: [],
    total: 0,
    page: 1,
    hasMore: false,
    emptyText: SEGMENTS[0].emptyText,
    categories: [],
    productsFlat: [],
    availableProducts: [],
    posterProducts: [],
    posters: [],
    productCount: 0,
    availableCount: 0,
    lastUpdated: '',
    polling: true,
    actingId: '',
    orderActingIds: {},
    productWriting: false,
    productAction: '',
    showCategoryForm: false,
    showProductForm: false,
    categoryName: '',
    productCategoryName: '',
    productName: '',
    productCategoryId: '',
    productCategoryIndex: 0,
    productPrice: '',
    productDescription: '',
    productImageUrl: '',
    productAvailable: true,
    priceEditorId: '',
    priceValue: '',
    priceOriginalUpdatedAt: '',
    editProductId: '',
    editProductName: '',
    editProductDescription: '',
    editProductImageUrl: '',
    editProductPrice: '',
    editProductUpdatedAt: '',
    editProductCategoryIndex: 0,
    editProductCategoryId: '',
    posterEditorId: '',
    posterProductId: '',
    posterProductIndex: 0,
    posterTitle: '',
    posterSubtitle: '',
    posterImageUrl: '',
    posterActive: true,
    showPosterForm: false,
    categoryEditorId: '',
    categoryEditorName: '',
    demoMode: !config.USE_WECHAT_CODE_LOGIN,
  },

  onLoad(options) {
    const input = options || {};
    this.timer = null;
    this.pageActive = true;
    this.ordersRequestSerial = 0;
    this.productsRequestSerial = 0;
    this.setData({ storeId: input.storeId ? decodeURIComponent(input.storeId) : '' });
    this.bootstrap();
  },

  onShow() {
    this.pageActive = true;
    if (!this.data.allowed) {
      return;
    }
    if (this.data.tab === 'orders') {
      this.loadOrders(true);
      if (this.data.polling) {
        this.startPolling();
      }
    } else if (this.data.tab === 'products') {
      this.loadProducts();
    } else {
      this.loadPosters();
    }
  },

  onHide() {
    this.pageActive = false;
    this.ordersRequestSerial += 1;
    this.productsRequestSerial += 1;
    this.stopPolling();
  },

  onUnload() {
    this.pageActive = false;
    this.ordersRequestSerial += 1;
    this.productsRequestSerial += 1;
    this.stopPolling();
  },

  onPullDownRefresh() {
    const done = () => {
      if (typeof wx !== 'undefined' && wx.stopPullDownRefresh) {
        wx.stopPullDownRefresh();
      }
    };
    if (this.data.tab === 'products') {
      this.loadProducts(done);
    } else if (this.data.tab === 'posters') {
      this.loadPosters(done);
    } else {
      this.loadOrders(false, done);
    }
  },

  async bootstrap() {
    this.setData({ checking: true, error: '' });
    try {
      await auth.ensureLogin();
      const memberships = session.memberships().filter(
        (item) => item && (item.role === 'OWNER' || item.role === 'STAFF'),
      );
      let storeId = this.data.storeId;
      if (!storeId) {
        storeId = memberships.length > 0 ? memberships[0].storeId : '';
      }
      const membership = memberships.filter((item) => item.storeId === storeId)[0];
      if (!storeId || !membership) {
        this.setData({
          checking: false,
          allowed: false,
          isOwner: false,
          storeId,
          error: '当前身份没有该门店的操作权限',
          errorAction: '切换身份',
        });
        return;
      }
      this.setData({
        checking: false,
        allowed: true,
        isOwner: membership.role === 'OWNER',
        storeId,
        roleLabel: membership.role === 'OWNER' ? '店主' : '店员',
        error: '',
      });
      if (!this.pageActive) {
        return;
      }
      this.loadStoreName(storeId);
      await this.loadOrders(false);
      if (this.data.polling) {
        this.startPolling();
      }
    } catch (error) {
      const described = errorText.describeError(error);
      this.setData({
        checking: false,
        allowed: false,
        isOwner: false,
        error: described.message,
        errorAction: described.action || '重试',
        requestId: described.requestId,
      });
    }
  },

  async loadStoreName(storeId) {
    try {
      const store = await storeService.getStore(storeId);
      this.setData({ storeName: store.name });
    } catch (error) {
      this.setData({ storeName: '' });
    }
  },

  startPolling() {
    this.stopPolling();
    if (!this.pageActive || !this.data.polling || this.data.tab !== 'orders') {
      return;
    }
    this.timer = setInterval(() => {
      this.loadOrders(true);
    }, POLL_INTERVAL_MS);
  },

  stopPolling() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  },

  async loadOrders(silent, done, append) {
    if (!this.data.allowed) {
      if (typeof done === 'function') {
        done();
      }
      return;
    }
    const segment = SEGMENTS.filter((item) => item.key === this.data.segment)[0] || SEGMENTS[0];
    const storeId = this.data.storeId;
    const requestKey = storeId + ':' + segment.key;
    this.ordersInFlight = this.ordersInFlight || {};
    if (this.ordersInFlight[requestKey]) {
      if (typeof done === 'function') {
        done();
      }
      return;
    }
    const requestSerial = ++this.ordersRequestSerial;
    const inFlight = { requestSerial };
    this.ordersInFlight[requestKey] = inFlight;
    const page = append ? this.data.page + 1 : 1;
    if (!silent) {
      this.setData({ ordersLoading: true });
    }
    try {
      const payload = await merchantService.listOrders(storeId, {
        status: segment.status,
        page,
        pageSize: 20,
        order: 'desc',
      });
      if (requestSerial !== this.ordersRequestSerial) {
        return;
      }
      const list = orderView.toOrderListView(payload);
      const incoming = list.items.map((order) => orderView.toMerchantOrderView(order));
      const seen = Object.create(null);
      const orders = (append ? this.data.orders.concat(incoming) : incoming).filter((order) => {
        if (seen[order.id]) {
          return false;
        }
        seen[order.id] = true;
        return true;
      });
      const now = new Date();
      this.setData({
        orders,
        total: list.total,
        page,
        hasMore: orders.length < list.total,
        ordersLoading: false,
        error: '',
        lastUpdated: orderView.formatTime(now) + ' 更新',
      });
    } catch (error) {
      if (requestSerial !== this.ordersRequestSerial) {
        return;
      }
      const described = errorText.describeError(error);
      this.setData({
        ordersLoading: false,
        error: described.message,
        errorAction: described.action || '重新加载',
        requestId: described.requestId,
      });
    } finally {
      if (this.ordersInFlight[requestKey] === inFlight) {
        delete this.ordersInFlight[requestKey];
      }
      if (typeof done === 'function') {
        done();
      }
    }
  },

  onLoadMore() {
    if (this.data.tab !== 'orders' || !this.data.hasMore || this.data.ordersLoading) {
      return;
    }
    return this.loadOrders(false, null, true);
  },

  onReachBottom() {
    return this.onLoadMore();
  },

  async loadProducts(done) {
    if (!this.data.allowed) {
      if (typeof done === 'function') {
        done();
      }
      return;
    }
    const requestSerial = ++this.productsRequestSerial;
    const storeId = this.data.storeId;
    this.setData({ productsLoading: true });
    try {
      const catalog = await merchantService.listProducts(storeId);
      if (requestSerial !== this.productsRequestSerial) {
        return;
      }
      let productCount = 0;
      let availableCount = 0;
      const productsFlat = [];
      const categories = ((catalog && catalog.categories) || []).map((category) => ({
        id: category.id,
        name: category.name,
        sortOrder: category.sortOrder,
        products: (category.products || []).map((product) => {
          productCount += 1;
          if (product.available) {
            availableCount += 1;
          }
          const view = {
            id: product.id,
            name: product.name,
            description: product.description || '',
            priceCents: product.priceCents,
            updatedAt: product.updatedAt,
            sortOrder: product.sortOrder,
            imageUrl: product.imageUrl,
            amountText: money.formatCents(product.priceCents),
            available: product.available,
          };
          productsFlat.push(Object.assign({ categoryId: category.id, categoryName: category.name }, view));
          return view;
        }),
      }));
      this.setData({
        categories,
        productsFlat,
        availableProducts: productsFlat.filter((item) => item.available),
        posterProducts: productsFlat.map((item) => Object.assign({}, item, { amountText: money.formatCents(item.priceCents) })),
        productCount,
        availableCount,
        productsLoading: false,
        error: '',
        errorAction: '',
        requestId: '',
      });
    } catch (error) {
      if (requestSerial !== this.productsRequestSerial) {
        return;
      }
      const described = errorText.describeError(error);
      this.setData({
        productsLoading: false,
        error: described.message,
        errorAction: described.action || '重新加载',
        requestId: described.requestId,
      });
    } finally {
      if (typeof done === 'function') {
        done();
      }
    }
  },

  async loadPosters(done) {
    if (!this.data.allowed) {
      if (typeof done === 'function') done();
      return;
    }
    const serial = (this.postersRequestSerial || 0) + 1;
    this.postersRequestSerial = serial;
    this.setData({ postersLoading: true });
    try {
      const posters = await merchantService.listPosters(this.data.storeId);
      if (serial !== this.postersRequestSerial) return;
      this.setData({ posters: this.mapPosterViews(posters), postersLoading: false, error: '' });
    } catch (error) {
      if (serial !== this.postersRequestSerial) return;
      this.setData({ postersLoading: false });
      this.showProductError(error, '重新加载');
    } finally {
      if (typeof done === 'function') done();
    }
  },

  mapPosterViews(posters) {
    return (Array.isArray(posters) ? posters : []).map((poster) => Object.assign({}, poster, {
      amountText: money.formatCents(poster.product && poster.product.priceCents),
      product: Object.assign({}, poster.product || {}, {
        amountText: money.formatCents(poster.product && poster.product.priceCents),
      }),
    }));
  },

  onChangeTab(event) {
    const tab = event.currentTarget.dataset.tab;
    if (!tab || tab === this.data.tab) {
      return;
    }
    this.setData({ tab, error: '' });
    if (tab === 'products') {
      this.ordersRequestSerial += 1;
      this.stopPolling();
      this.loadProducts();
    } else if (tab === 'posters') {
      this.ordersRequestSerial += 1;
      this.stopPolling();
      this.loadProducts();
      this.loadPosters();
    } else {
      this.productsRequestSerial += 1;
      this.loadOrders(false);
      if (this.data.polling) {
        this.startPolling();
      }
    }
  },

  onChangeSegment(event) {
    const key = event.currentTarget.dataset.key;
    const next = SEGMENTS.filter((item) => item.key === key)[0];
    if (!next || key === this.data.segment) {
      return;
    }
    this.setData({
      segment: key,
      orders: [],
      total: 0,
      page: 1,
      hasMore: false,
      emptyText: next.emptyText,
      error: '',
    });
    return this.loadOrders(false);
  },

  onTogglePolling(event) {
    const enabled = Boolean(event.detail.value);
    this.setData({ polling: enabled });
    if (enabled) {
      platform.toast('已开启 10 秒自动刷新');
      this.startPolling();
    } else {
      platform.toast('已暂停自动刷新');
      this.stopPolling();
    }
  },

  onRefresh() {
    if (this.data.tab === 'products') {
      this.loadProducts();
      return;
    }
    if (this.data.tab === 'posters') {
      this.loadPosters();
      return;
    }
    this.loadOrders(false);
  },

  beginProductWrite(action, actingId) {
    if (this.data.productWriting || this.data.actingId) {
      return false;
    }
    this.setData({
      productWriting: true,
      productAction: action,
      actingId: actingId || '',
      error: '',
      errorAction: '',
      requestId: '',
    });
    return true;
  },

  endProductWrite() {
    this.setData({ productWriting: false, productAction: '', actingId: '' });
  },

  showProductError(error, fallbackAction) {
    const described = errorText.describeError(error);
    this.setData({
      error: described.message,
      errorAction: described.action || fallbackAction || '重新加载',
      requestId: described.requestId,
    });
  },

  findProduct(productId) {
    const categories = this.data.categories || [];
    for (let categoryIndex = 0; categoryIndex < categories.length; categoryIndex += 1) {
      const products = categories[categoryIndex].products || [];
      for (let productIndex = 0; productIndex < products.length; productIndex += 1) {
        if (products[productIndex].id === productId) {
          return products[productIndex];
        }
      }
    }
    return null;
  },

  onOpenProductEditor(event) {
    if (!this.data.isOwner || this.data.productWriting) return;
    const product = (this.data.productsFlat || []).find((item) => item.id === event.currentTarget.dataset.id);
    if (!product) return;
    const categories = this.data.categories || [];
    const categoryIndex = Math.max(0, categories.findIndex((item) => item.id === product.categoryId));
    this.setData({
      editProductId: product.id,
      editProductName: product.name,
      editProductDescription: product.description,
      editProductImageUrl: product.imageUrl || '',
      editProductPrice: money.formatAmount(product.priceCents),
      editProductUpdatedAt: product.updatedAt || '',
      editProductCategoryIndex: categoryIndex,
      editProductCategoryId: product.categoryId,
      error: '',
    });
  },

  onCloseProductEditor() {
    if (this.data.productWriting) return;
    this.setData({ editProductId: '', editProductUpdatedAt: '' });
  },

  onEditProductFieldInput(event) {
    const fields = { name: 'editProductName', description: 'editProductDescription', imageUrl: 'editProductImageUrl', price: 'editProductPrice' };
    const key = fields[event.currentTarget.dataset.field];
    if (key) this.setData({ [key]: event.detail.value });
  },

  onEditProductCategoryChange(event) {
    const index = Number(event.detail.value);
    const category = this.data.categories[index];
    if (category) this.setData({ editProductCategoryIndex: index, editProductCategoryId: category.id });
  },

  async onSaveProductEdit() {
    if (!this.data.isOwner || !this.data.editProductId) return;
    const name = (this.data.editProductName || '').trim();
    const priceCents = money.parseYuanToCents(this.data.editProductPrice);
    if (!name) {
      this.setData({ error: '请输入商品名称', errorAction: '', requestId: '' });
      return;
    }
    if (priceCents === null) {
      this.setData({ error: '价格须为 0.01 至 9999.99 元，最多两位小数', errorAction: '', requestId: '' });
      return;
    }
    if (!this.data.editProductUpdatedAt) {
      this.setData({ error: '商品版本信息缺失，请刷新后重试', errorAction: '重新加载', requestId: '' });
      return;
    }
    if (!this.beginProductWrite('edit-product')) return;
    try {
      await merchantService.updateProduct(this.data.editProductId, {
        expectedUpdatedAt: this.data.editProductUpdatedAt,
        name,
        description: (this.data.editProductDescription || '').trim(),
        imageUrl: (this.data.editProductImageUrl || '').trim(),
        categoryId: this.data.editProductCategoryId,
        priceCents,
      });
      platform.toast('商品资料已更新');
      this.setData({ editProductId: '', editProductUpdatedAt: '' });
      await this.loadProducts();
    } catch (error) {
      if (error && error.code === 'PRODUCT_CONFLICT') {
        this.setData({ editProductId: '', editProductUpdatedAt: '' });
        await this.loadProducts();
        this.setData({ error: '商品资料已被更新，列表已刷新，请重新编辑', errorAction: '重新加载' });
      } else {
        this.showProductError(error, '重新加载');
      }
    } finally {
      this.endProductWrite();
    }
  },

  onOpenPosterForm(event) {
    if (!this.data.isOwner || this.data.productWriting) return;
    const posterId = event && event.currentTarget && event.currentTarget.dataset.id;
    const poster = posterId ? (this.data.posters || []).find((item) => item.id === posterId) : null;
    const products = poster ? (this.data.posterProducts || []) : (this.data.availableProducts || []);
    const productIndex = poster
      ? Math.max(0, products.findIndex((item) => item.id === poster.productId))
      : 0;
    this.setData({
      showPosterForm: true,
      posterEditorId: poster ? poster.id : '',
      posterProductId: poster ? poster.productId : (products[0] ? products[0].id : ''),
      posterProductIndex: productIndex,
      posterTitle: poster ? poster.title : '',
      posterSubtitle: poster ? poster.subtitle : '',
      posterImageUrl: poster ? poster.imageUrl : '',
      posterActive: poster ? poster.active : true,
      error: '',
    });
  },

  onClosePosterForm() {
    if (this.data.productWriting) return;
    this.setData({ showPosterForm: false, posterEditorId: '' });
  },

  onPosterProductChange(event) {
    const index = Number(event.detail.value);
    const products = this.data.posterEditorId
      ? (this.data.posterProducts || [])
      : (this.data.availableProducts || []);
    const product = products[index];
    if (product) this.setData({ posterProductIndex: index, posterProductId: product.id });
  },

  onPosterFieldInput(event) {
    const fields = { title: 'posterTitle', subtitle: 'posterSubtitle', imageUrl: 'posterImageUrl' };
    const key = fields[event.currentTarget.dataset.field];
    if (key) this.setData({ [key]: event.detail.value });
  },

  onPosterActiveChange(event) {
    this.setData({ posterActive: Boolean(event.detail.value) });
  },

  async chooseAndUploadImage(fieldName) {
    if (!this.data.isOwner || this.data.productWriting) return;
    let picked;
    try {
      picked = await platform.chooseImage();
    } catch (error) {
      if (!error || error.code !== 'USER_CANCELLED') platform.toast('无法选择图片，请重试');
      return;
    }
    if (!picked || !picked.tempFilePath || !this.beginProductWrite('upload-image')) return;
    try {
      const uploaded = await merchantService.uploadImage(this.data.storeId, picked.tempFilePath);
      if (!uploaded || !uploaded.url) throw new Error('服务器没有返回图片地址');
      this.setData({ [fieldName]: uploaded.url });
      platform.toast('图片已上传');
    } catch (error) {
      this.showProductError(error, '重新加载');
    } finally {
      this.endProductWrite();
    }
  },

  onChooseProductImage() {
    return this.chooseAndUploadImage('productImageUrl');
  },

  onChooseEditProductImage() {
    return this.chooseAndUploadImage('editProductImageUrl');
  },

  onChoosePosterImage() {
    return this.chooseAndUploadImage('posterImageUrl');
  },

  onClearImage(event) {
    if (!this.data.isOwner || this.data.productWriting) return;
    const field = event.currentTarget.dataset.field;
    const fields = {
      product: 'productImageUrl',
      edit: 'editProductImageUrl',
      poster: 'posterImageUrl',
    };
    const stateKey = fields[field];
    if (stateKey) this.setData({ [stateKey]: '' });
  },

  async onSavePoster() {
    if (!this.data.isOwner) return;
    if (!this.data.posterProductId) {
      this.setData({ error: '请先创建并上架一个商品', errorAction: '', requestId: '' });
      return;
    }
    const selectedProduct = (this.data.posterProducts || []).find((item) => item.id === this.data.posterProductId);
    if (!this.data.posterEditorId && (!selectedProduct || !selectedProduct.available)) {
      this.setData({ error: '新建海报请选择在售商品', errorAction: '', requestId: '' });
      return;
    }
    if (!this.beginProductWrite(this.data.posterEditorId ? 'update-poster' : 'create-poster')) return;
    const payload = {
      productId: this.data.posterProductId,
      title: (this.data.posterTitle || '').trim(),
      subtitle: (this.data.posterSubtitle || '').trim(),
      imageUrl: (this.data.posterImageUrl || '').trim(),
      active: Boolean(this.data.posterActive),
    };
    try {
      if (this.data.posterEditorId) {
        await merchantService.updatePoster(this.data.posterEditorId, payload);
      } else {
        await merchantService.createPoster(this.data.storeId, payload);
      }
      platform.toast(this.data.posterEditorId ? '海报已更新' : '海报已创建');
      this.setData({ showPosterForm: false, posterEditorId: '' });
      await this.loadPosters();
    } catch (error) {
      this.showProductError(error, '重新加载');
    } finally {
      this.endProductWrite();
    }
  },

  async onTogglePoster(event) {
    const posterId = event.currentTarget.dataset.id;
    const active = Boolean(event.detail.value);
    if (!posterId || !this.beginProductWrite('poster-active', posterId)) return;
    try {
      await merchantService.updatePoster(posterId, { active });
      await this.loadPosters();
      platform.toast(active ? '海报已启用' : '海报已停用');
    } catch (error) {
      this.showProductError(error, '重新加载');
    } finally {
      this.endProductWrite();
    }
  },

  async onDeletePoster(event) {
    if (!this.data.isOwner || this.data.productWriting) return;
    const posterId = event.currentTarget.dataset.id;
    const confirmation = await platform.modal({
      title: '删除海报',
      content: '删除后首页轮播中将不再显示这张海报。',
      confirmText: '删除',
    });
    if (!confirmation.confirm || !this.beginProductWrite('delete-poster', posterId)) return;
    try {
      await merchantService.deletePoster(posterId);
      await this.loadPosters();
      platform.toast('海报已删除');
    } catch (error) {
      this.showProductError(error, '重新加载');
    } finally {
      this.endProductWrite();
    }
  },

  async onMovePoster(event) {
    if (!this.data.isOwner || this.data.productWriting) return;
    const index = Number(event.currentTarget.dataset.index);
    const direction = Number(event.currentTarget.dataset.direction);
    const posters = (this.data.posters || []).slice();
    const target = index + direction;
    if (!Number.isInteger(index) || target < 0 || target >= posters.length) return;
    [posters[index], posters[target]] = [posters[target], posters[index]];
    if (!this.beginProductWrite('reorder-posters')) return;
    try {
      const saved = await merchantService.reorderPosters(this.data.storeId, posters.map((item) => item.id));
      this.setData({ posters: this.mapPosterViews(saved) });
    } catch (error) {
      this.showProductError(error, '重新加载');
      await this.loadPosters();
    } finally {
      this.endProductWrite();
    }
  },

  onOpenCategoryForm() {
    if (!this.data.isOwner || this.data.productWriting) {
      return;
    }
    this.setData({ showCategoryForm: true, showProductForm: false, categoryName: '', error: '' });
  },

  onCloseCategoryForm() {
    if (this.data.productWriting) {
      return;
    }
    this.setData({ showCategoryForm: false, categoryName: '' });
  },

  onCategoryNameInput(event) {
    this.setData({ categoryName: event.detail.value });
  },

  async onCreateCategory() {
    if (!this.data.isOwner) {
      return;
    }
    const name = (this.data.categoryName || '').trim();
    if (!name) {
      this.setData({ error: '请输入分类名称', errorAction: '', requestId: '' });
      return;
    }
    if (!this.beginProductWrite('create-category')) {
      return;
    }
    try {
      await merchantService.createCategory(this.data.storeId, { name });
      platform.toast('分类已创建');
      this.setData({ showCategoryForm: false, categoryName: '' });
      await this.loadProducts();
    } catch (error) {
      this.showProductError(error, '重新加载');
    } finally {
      this.endProductWrite();
    }
  },

  onOpenProductForm() {
    if (!this.data.isOwner || this.data.productWriting) {
      return;
    }
    const categories = this.data.categories || [];
    this.setData({
      showProductForm: true,
      showCategoryForm: false,
      productCategoryName: '',
      productName: '',
      productCategoryId: categories.length > 0 ? categories[0].id : '',
      productCategoryIndex: 0,
      productPrice: '',
      productDescription: '',
      productImageUrl: '',
      productAvailable: true,
      error: '',
    });
  },

  onCloseProductForm() {
    if (this.data.productWriting) {
      return;
    }
    this.setData({ showProductForm: false });
  },

  onProductCategoryNameInput(event) {
    this.setData({ productCategoryName: event.detail.value });
  },

  async onCreateProductCategory() {
    if (!this.data.isOwner) {
      return;
    }
    const name = (this.data.productCategoryName || '').trim();
    if (!name) {
      this.setData({ error: '请输入分类名称', errorAction: '', requestId: '' });
      return;
    }
    if (!this.beginProductWrite('create-product-category')) {
      return;
    }
    try {
      const category = await merchantService.createCategory(this.data.storeId, { name });
      platform.toast('分类已创建');
      const categoryId = category && category.id ? category.id : '';
      this.setData({ productCategoryName: '', productCategoryId: categoryId });
      await this.loadProducts();
      const categories = this.data.categories || [];
      let categoryIndex = categories.map((item) => item.id).indexOf(categoryId);
      if (categoryIndex < 0) {
        categoryIndex = categories.length > 0 ? 0 : -1;
      }
      this.setData({
        productCategoryIndex: categoryIndex >= 0 ? categoryIndex : 0,
        productCategoryId: categoryIndex >= 0 ? categories[categoryIndex].id : '',
      });
    } catch (error) {
      this.showProductError(error, '重新加载');
    } finally {
      this.endProductWrite();
    }
  },

  onProductFieldInput(event) {
    const fields = {
      name: 'productName',
      price: 'productPrice',
      description: 'productDescription',
      imageUrl: 'productImageUrl',
    };
    const key = fields[event.currentTarget.dataset.field];
    if (!key) {
      return;
    }
    const patch = {};
    patch[key] = event.detail.value;
    this.setData(patch);
  },

  onProductCategoryChange(event) {
    const categoryIndex = Number(event.detail.value);
    const category = this.data.categories[categoryIndex];
    if (!category) {
      return;
    }
    this.setData({ productCategoryIndex: categoryIndex, productCategoryId: category.id });
  },

  onProductAvailableChange(event) {
    this.setData({ productAvailable: Boolean(event.detail.value) });
  },

  async onCreateProduct() {
    if (!this.data.isOwner) {
      return;
    }
    const name = (this.data.productName || '').trim();
    const categoryId = this.data.productCategoryId;
    const priceCents = money.parseYuanToCents(this.data.productPrice);
    if (!name) {
      this.setData({ error: '请输入商品名称', errorAction: '', requestId: '' });
      return;
    }
    if (!categoryId) {
      this.setData({ error: '请先创建并选择商品分类', errorAction: '', requestId: '' });
      return;
    }
    if (priceCents === null) {
      this.setData({ error: '价格须为 0.01 至 9999.99 元，最多两位小数', errorAction: '', requestId: '' });
      return;
    }
    if (!this.beginProductWrite('create-product')) {
      return;
    }
    try {
      await merchantService.createProduct(this.data.storeId, {
        categoryId,
        name,
        description: (this.data.productDescription || '').trim(),
        imageUrl: (this.data.productImageUrl || '').trim(),
        priceCents,
        available: Boolean(this.data.productAvailable),
      });
      platform.toast('商品已创建');
      this.setData({
        showProductForm: false,
        productName: '',
        productCategoryId: '',
        productPrice: '',
        productDescription: '',
        productImageUrl: '',
        productAvailable: true,
      });
      await this.loadProducts();
    } catch (error) {
      this.showProductError(error, '重新加载');
    } finally {
      this.endProductWrite();
    }
  },

  onOpenPriceEditor(event) {
    if (!this.data.isOwner || this.data.productWriting) {
      return;
    }
    const product = this.findProduct(event.currentTarget.dataset.id);
    if (!product) {
      return;
    }
    this.setData({
      priceEditorId: product.id,
      priceValue: money.formatAmount(product.priceCents),
      priceOriginalUpdatedAt: product.updatedAt || '',
      error: '',
    });
  },

  onClosePriceEditor() {
    if (this.data.productWriting) {
      return;
    }
    this.setData({ priceEditorId: '', priceValue: '', priceOriginalUpdatedAt: '' });
  },

  onPriceValueInput(event) {
    this.setData({ priceValue: event.detail.value });
  },

  async onSavePrice() {
    if (!this.data.isOwner) {
      return;
    }
    const productId = this.data.priceEditorId;
    const expectedUpdatedAt = this.data.priceOriginalUpdatedAt;
    const priceCents = money.parseYuanToCents(this.data.priceValue);
    if (!productId) {
      return;
    }
    if (priceCents === null) {
      this.setData({ error: '价格须为 0.01 至 9999.99 元，最多两位小数', errorAction: '', requestId: '' });
      return;
    }
    if (!expectedUpdatedAt) {
      this.setData({ error: '商品版本信息缺失，请刷新后重试', errorAction: '重新加载', requestId: '' });
      return;
    }
    if (!this.beginProductWrite('update-price')) {
      return;
    }
    try {
      await merchantService.updateProductPrice(productId, { priceCents, expectedUpdatedAt });
      platform.toast('价格已更新');
      this.setData({ priceEditorId: '', priceValue: '', priceOriginalUpdatedAt: '' });
      await this.loadProducts();
    } catch (error) {
      if (error && error.code === 'PRODUCT_CONFLICT') {
        this.setData({ priceEditorId: '', priceValue: '', priceOriginalUpdatedAt: '' });
        await this.loadProducts();
        this.setData({
          error: '商品价格已被其他操作更新，列表已刷新，请重新确认',
          errorAction: '重新加载',
          requestId: error.requestId || '',
        });
      } else {
        this.showProductError(error, '重新加载');
      }
    } finally {
      this.endProductWrite();
    }
  },

  onOpenCategoryEditor(event) {
    if (!this.data.isOwner || this.data.productWriting) {
      return;
    }
    const categoryId = event.currentTarget.dataset.id;
    const category = (this.data.categories || []).filter((item) => item.id === categoryId)[0];
    if (!category) {
      return;
    }
    this.setData({ categoryEditorId: category.id, categoryEditorName: category.name, error: '' });
  },

  onCloseCategoryEditor() {
    if (this.data.productWriting) {
      return;
    }
    this.setData({ categoryEditorId: '', categoryEditorName: '' });
  },

  onCategoryEditorNameInput(event) {
    this.setData({ categoryEditorName: event.detail.value });
  },

  async onRenameCategory() {
    if (!this.data.isOwner) {
      return;
    }
    const categoryId = this.data.categoryEditorId;
    const name = (this.data.categoryEditorName || '').trim();
    if (!categoryId) {
      return;
    }
    if (!name) {
      this.setData({ error: '请输入分类名称', errorAction: '', requestId: '' });
      return;
    }
    if (!this.beginProductWrite('rename-category')) {
      return;
    }
    try {
      await merchantService.updateCategory(categoryId, { name });
      platform.toast('分类已重命名');
      this.setData({ categoryEditorId: '', categoryEditorName: '' });
      await this.loadProducts();
    } catch (error) {
      this.showProductError(error, '重新加载');
    } finally {
      this.endProductWrite();
    }
  },

  async onAdvance(event) {
    const orderId = event.detail.orderId;
    const toStatus = event.detail.toStatus;
    const acting = this.data.orderActingIds || {};
    if (!orderId || !toStatus || acting[orderId]) {
      return;
    }
    const order = this.data.orders.filter((item) => item.id === orderId)[0];
    const action = order
      ? order.actions.filter((item) => item.toStatus === toStatus)[0]
      : null;
    if (!order || !action) {
      return;
    }
    const orderActingIds = Object.assign({}, acting);
    orderActingIds[orderId] = toStatus;
    this.setData({ orderActingIds, error: '' });
    try {
      if (order.status === 'PENDING_ACCEPT' && toStatus === 'PREPARING') {
        const confirmed = await platform.modal({
          title: '确认接单',
          content: '确认接受订单 #' + (order.shortId || orderId) + ' 并开始制作吗？',
          confirmText: '确认接单',
        });
        if (!confirmed.confirm) {
          return;
        }
      }
      let reason = '';
      if (action.requiresReason) {
        reason = await this.pickReason('请选择取消原因');
        if (!reason) {
          return;
        }
      }
      if (toStatus === 'CANCELLED') {
        const confirmed = await platform.modal({
          title: '确认取消订单',
          content: '取消原因：' + reason + '\n确认取消该订单吗？',
          confirmText: '确认取消',
        });
        if (!confirmed.confirm) {
          return;
        }
      }
      await merchantService.updateOrderStatus(orderId, {
        toStatus,
        expectedStatus: order.status,
        reason,
      });
      platform.toast('状态已更新');
      await this.loadOrders(true);
    } catch (error) {
      const described = errorText.describeError(error);
      this.setData({
        error: described.message,
        errorAction: described.action || '刷新订单',
        requestId: described.requestId,
      });
      if (error && (error.code === 'STATUS_CONFLICT' || error.code === 'INVALID_STATUS_TRANSITION')) {
        await this.loadOrders(true);
      }
    } finally {
      const current = Object.assign({}, this.data.orderActingIds || {});
      if (current[orderId] === toStatus) {
        delete current[orderId];
      }
      this.setData({ orderActingIds: current });
    }
  },

  async onToggleProduct(event) {
    const productId = event.currentTarget.dataset.id;
    const productName = event.currentTarget.dataset.name;
    const available = Boolean(event.detail.value);
    if (!productId || !this.beginProductWrite('availability', productId)) {
      return;
    }
    try {
      await merchantService.updateAvailability(productId, available);
      platform.toast((available ? '已上架 ' : '已下架 ') + (productName || '商品'));
      await this.loadProducts();
    } catch (error) {
      await this.loadProducts();
      this.showProductError(error, '重新加载');
    } finally {
      this.endProductWrite();
    }
  },

  onOpenOrder(event) {
    const orderId = event.detail.orderId;
    if (!orderId || typeof wx === 'undefined' || !wx.navigateTo) {
      return;
    }
    wx.navigateTo({ url: '/pages/order-detail/index?id=' + encodeURIComponent(orderId) });
  },

  pickReason(title) {
    return new Promise((resolve) => {
      if (typeof wx === 'undefined' || !wx.showActionSheet) {
        resolve('门店取消');
        return;
      }
      wx.showActionSheet({
        alertText: title,
        itemList: CANCEL_REASONS,
        success(result) {
          resolve(CANCEL_REASONS[Number(result.tapIndex)] || '门店取消');
        },
        fail() {
          resolve('');
        },
      });
    });
  },

  onRetry() {
    if (this.data.errorAction === '切换身份') {
      if (typeof wx !== 'undefined' && wx.switchTab) {
        wx.switchTab({ url: '/pages/mine/index' });
      }
      return;
    }
    if (this.data.tab === 'products' && this.data.allowed) {
      this.loadProducts();
      return;
    }
    if (this.data.tab === 'posters' && this.data.allowed) {
      this.loadPosters();
      return;
    }
    this.bootstrap();
  },

  onCloseError() {
    this.setData({ error: '', errorAction: '', requestId: '' });
  },
});
