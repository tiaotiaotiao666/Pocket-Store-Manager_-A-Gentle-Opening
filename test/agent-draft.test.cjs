const test = require('node:test');
const assert = require('node:assert/strict');

async function loadDraft() {
  return import('../src/domain/agentDraft.mjs');
}

function dish(name, priceCents, description = '') {
  return { name, priceCents, description };
}

function validDraft(overrides = {}) {
  return {
    storeName: '松月食堂',
    category: '社区餐馆',
    businessHours: '10:00-21:00',
    fulfillment: { dineIn: true, takeaway: true },
    dishes: [
      dish('宫保鸡丁', 2800),
      dish('番茄炒蛋', 1600),
      dish('米饭', 300),
    ],
    ...overrides,
  };
}

function codes(validation) {
  return validation.errors.map((error) => error.code);
}

function missingFields(validation) {
  return validation.missingFields.map((item) => item.field);
}

test('D1 空草稿形状与缺项顺序：店名 → 品类 → 营业时间 → 取餐方式 → 菜品', async () => {
  const draft = await loadDraft();
  const empty = draft.createEmptyAgentDraft();
  assert.deepEqual(empty, {
    storeName: '',
    category: '',
    businessHours: '',
    fulfillment: { dineIn: false, takeaway: false },
    dishes: [],
  });
  const first = draft.createEmptyAgentDraft();
  first.storeName = '改动';
  assert.equal(draft.createEmptyAgentDraft().storeName, '');

  const validation = draft.validateAgentDraft(empty);
  assert.deepEqual(missingFields(validation), ['storeName', 'category', 'businessHours', 'fulfillment', 'dishes']);
  assert.equal(validation.readyForReview, false);
  assert.equal(validation.missingFields[0].label, '店名');
});

test('D2 店名 1 字与 48 字合法', async () => {
  const draft = await loadDraft();
  assert.ok(!missingFields(draft.validateAgentDraft(validDraft({ storeName: '店' }))).includes('storeName'));
  assert.ok(!codes(draft.validateAgentDraft(validDraft({ storeName: '店'.repeat(48) }))).includes('NAME_TOO_LONG'));
});

test('D3 49 字店名报 NAME_TOO_LONG', async () => {
  const draft = await loadDraft();
  assert.ok(codes(draft.validateAgentDraft(validDraft({ storeName: '店'.repeat(49) }))).includes('NAME_TOO_LONG'));
});

test('D4 店名按 Unicode 码点计数：48 个 emoji 合法', async () => {
  const draft = await loadDraft();
  const emoji = '😀'.repeat(48);
  assert.equal(Array.from(emoji).length, 48);
  assert.equal(emoji.length, 96);
  assert.ok(!codes(draft.validateAgentDraft(validDraft({ storeName: emoji }))).includes('NAME_TOO_LONG'));
  assert.ok(codes(draft.validateAgentDraft(validDraft({ storeName: `${emoji}店` }))).includes('NAME_TOO_LONG'));
});

test('D5 品类空值缺项、24 字合法、25 字报 CATEGORY_TOO_LONG', async () => {
  const draft = await loadDraft();
  assert.ok(missingFields(draft.validateAgentDraft(validDraft({ category: '' }))).includes('category'));
  assert.ok(!codes(draft.validateAgentDraft(validDraft({ category: '菜'.repeat(24) }))).includes('CATEGORY_TOO_LONG'));
  assert.ok(codes(draft.validateAgentDraft(validDraft({ category: '菜'.repeat(25) }))).includes('CATEGORY_TOO_LONG'));
});

test('D6 单段营业时间合法', async () => {
  const draft = await loadDraft();
  const validation = draft.validateAgentDraft(validDraft({ businessHours: '10:00-21:00' }));
  assert.equal(validation.readyForReview, true);
});

test('D7 多段营业时间合法且连续时段允许', async () => {
  const draft = await loadDraft();
  for (const hours of ['10:00-14:00,16:00-21:00', '10:00-14:00,14:00-21:00']) {
    const validation = draft.validateAgentDraft(validDraft({ businessHours: hours }));
    assert.equal(validation.readyForReview, true, hours);
  }
});

test('D8 起止相同报 HOURS_RANGE', async () => {
  const draft = await loadDraft();
  assert.ok(codes(draft.validateAgentDraft(validDraft({ businessHours: '10:00-10:00' }))).includes('HOURS_RANGE'));
});

test('D9 倒置与跨午夜报 HOURS_RANGE', async () => {
  const draft = await loadDraft();
  assert.ok(codes(draft.validateAgentDraft(validDraft({ businessHours: '21:00-10:00' }))).includes('HOURS_RANGE'));
  assert.ok(codes(draft.validateAgentDraft(validDraft({ businessHours: '22:00-02:00' }))).includes('HOURS_RANGE'));
});

test('D10 营业时间格式错误报 HOURS_FORMAT', async () => {
  const draft = await loadDraft();
  for (const hours of ['10:00', '10:0-21:00', '24:00-25:00', 'abc', '10:00-']) {
    assert.ok(codes(draft.validateAgentDraft(validDraft({ businessHours: hours }))).includes('HOURS_FORMAT'), hours);
  }
});

test('D11 多段重叠报 HOURS_OVERLAP', async () => {
  const draft = await loadDraft();
  assert.ok(codes(draft.validateAgentDraft(validDraft({
    businessHours: '10:00-14:00,13:00-21:00',
  }))).includes('HOURS_OVERLAP'));
});

test('D12 超过 3 段报 HOURS_TOO_MANY', async () => {
  const draft = await loadDraft();
  assert.ok(codes(draft.validateAgentDraft(validDraft({
    businessHours: '06:00-08:00,10:00-14:00,16:00-21:00,22:00-23:00',
  }))).includes('HOURS_TOO_MANY'));
});

test('D13 取餐方式双 false 缺项、单 true 与双 true 合法', async () => {
  const draft = await loadDraft();
  const none = draft.validateAgentDraft(validDraft({ fulfillment: { dineIn: false, takeaway: false } }));
  assert.ok(missingFields(none).includes('fulfillment'));
  for (const fulfillment of [
    { dineIn: true, takeaway: false },
    { dineIn: false, takeaway: true },
    { dineIn: true, takeaway: true },
  ]) {
    assert.equal(draft.validateAgentDraft(validDraft({ fulfillment })).readyForReview, true);
  }
});

test('D14 菜品 2 道缺项、3/5 道合法、6 道报 DISHES_TOO_MANY', async () => {
  const draft = await loadDraft();
  const two = draft.validateAgentDraft(validDraft({ dishes: [dish('甲', 100), dish('乙', 200)] }));
  assert.ok(missingFields(two).includes('dishes'));
  assert.ok(two.missingFields.find((item) => item.field === 'dishes').detail.includes('还差 1 道'));
  for (const count of [3, 5]) {
    const dishes = Array.from({ length: count }, (_, index) => dish(`菜${index + 1}`, 100 + index));
    assert.equal(draft.validateAgentDraft(validDraft({ dishes })).readyForReview, true, String(count));
  }
  const six = Array.from({ length: 6 }, (_, index) => dish(`菜${index + 1}`, 100 + index));
  assert.ok(codes(draft.validateAgentDraft(validDraft({ dishes: six }))).includes('DISHES_TOO_MANY'));
});

test('D15 菜名 1/24 字合法、25 字报 DISH_NAME_TOO_LONG、空菜名缺项', async () => {
  const draft = await loadDraft();
  const long = validDraft();
  long.dishes[0].name = '菜'.repeat(25);
  assert.ok(codes(draft.validateAgentDraft(long)).includes('DISH_NAME_TOO_LONG'));

  const short = validDraft();
  short.dishes[0].name = '菜'.repeat(24);
  assert.equal(draft.validateAgentDraft(short).readyForReview, true);

  const empty = validDraft();
  empty.dishes[1].name = '';
  assert.ok(missingFields(draft.validateAgentDraft(empty)).includes('dishes[1].name'));
});

test('D16 价格 1/999999 合法；0 与 1000000 报 PRICE_RANGE', async () => {
  const draft = await loadDraft();
  const one = validDraft();
  one.dishes[0].priceCents = 1;
  assert.equal(draft.validateAgentDraft(one).readyForReview, true);

  const max = validDraft();
  max.dishes[0].priceCents = 999999;
  assert.equal(draft.validateAgentDraft(max).readyForReview, true);

  for (const price of [0, 1000000]) {
    const target = validDraft();
    target.dishes[0].priceCents = price;
    assert.ok(codes(draft.validateAgentDraft(target)).includes('PRICE_RANGE'), String(price));
  }
});

test('D17 非整数价格报 PRICE_INVALID，空价格缺项', async () => {
  const draft = await loadDraft();
  const decimal = validDraft();
  decimal.dishes[0].priceCents = 28.5;
  assert.ok(codes(draft.validateAgentDraft(decimal)).includes('PRICE_INVALID'));

  const text = validDraft();
  text.dishes[0].priceCents = '2800';
  assert.ok(codes(draft.validateAgentDraft(text)).includes('PRICE_INVALID'));

  const empty = validDraft();
  empty.dishes[0].priceCents = null;
  assert.ok(missingFields(draft.validateAgentDraft(empty)).includes('dishes[0].priceCents'));
});

test('D18 描述 60 字合法、61 字报 DESCRIPTION_TOO_LONG', async () => {
  const draft = await loadDraft();
  const ok = validDraft();
  ok.dishes[0].description = '述'.repeat(60);
  assert.equal(draft.validateAgentDraft(ok).readyForReview, true);
  const tooLong = validDraft();
  tooLong.dishes[0].description = '述'.repeat(61);
  assert.ok(codes(draft.validateAgentDraft(tooLong)).includes('DESCRIPTION_TOO_LONG'));
});

test('D19 价格文本解析支持整数、小数、货币符号与全角', async () => {
  const draft = await loadDraft();
  const cases = [
    ['28', 2800],
    ['28.5', 2850],
    ['28.50', 2850],
    ['¥28', 2800],
    ['￥28', 2800],
    ['28元', 2800],
    ['28块', 2800],
    ['28块钱', 2800],
    ['２８．５', 2850],
    [' 28 ', 2800],
  ];
  for (const [text, cents] of cases) {
    const parsed = draft.parsePriceTextToCents(text);
    assert.equal(parsed.ok, true, text);
    assert.equal(parsed.cents, cents, text);
  }
});

test('D20 非法价格文本返回 PRICE_INVALID 或 PRICE_REQUIRED', async () => {
  const draft = await loadDraft();
  assert.equal(draft.parsePriceTextToCents('').code, 'PRICE_REQUIRED');
  assert.equal(draft.parsePriceTextToCents('   ').code, 'PRICE_REQUIRED');
  for (const text of ['abc', '-1', '28.999', '28.5.0', '28元5角', '0x28']) {
    const parsed = draft.parsePriceTextToCents(text);
    assert.equal(parsed.ok, false, text);
    assert.equal(parsed.cents, null, text);
    assert.equal(parsed.code, 'PRICE_INVALID', text);
  }
});

test('D21 formatCents 边界', async () => {
  const draft = await loadDraft();
  assert.equal(draft.formatCents(2800), '28.00');
  assert.equal(draft.formatCents(0), '0.00');
  assert.equal(draft.formatCents(1), '0.01');
  assert.equal(draft.formatCents(999999), '9999.99');
  assert.equal(draft.formatCents(2850), '28.50');
  for (const value of [null, undefined, -1, 28.5, '2800', NaN]) {
    assert.equal(draft.formatCents(value), '', String(value));
  }
});

test('D22 applyDraftPatch 只覆盖白名单字段，忽略未知字段', async () => {
  const draft = await loadDraft();
  const base = validDraft({ storeName: '旧店名', category: '社区餐馆' });
  const next = draft.applyDraftPatch(base, {
    storeName: '  新店名  ',
    unknown: '忽略我',
    dishes: undefined,
  });
  assert.equal(next.storeName, '新店名');
  assert.equal(next.category, '社区餐馆');
  assert.equal(Object.prototype.hasOwnProperty.call(next, 'unknown'), false);
  assert.equal(base.storeName, '旧店名');
});

test('D23 菜品按 id/名称合并去重，已有价格不被空值覆盖', async () => {
  const draft = await loadDraft();
  const base = validDraft();
  const withIds = draft.normalizeAgentDraft(base);
  const firstId = withIds.dishes[0].id;
  const next = draft.applyDraftPatch(withIds, {
    dishes: [
      { id: firstId, priceText: '30' },
      { name: '番茄炒蛋', priceCents: null },
      { name: '酸辣汤', priceText: '18元' },
      { name: '酸辣汤', priceText: '20元' },
    ],
  });
  assert.equal(next.dishes.length, 4);
  assert.equal(next.dishes[0].priceCents, 3000);
  assert.equal(next.dishes[0].priceText, '30');
  assert.equal(next.dishes[1].priceCents, 1600);
  assert.equal(next.dishes[3].priceCents, 1800);
  assert.equal(next.dishes[3].name, '酸辣汤');
});

test('D24 toContractDraft 不包含 priceText，金额为整数或 null', async () => {
  const draft = await loadDraft();
  const contract = draft.toContractDraft(validDraft());
  const serialized = JSON.stringify(contract);
  assert.equal(serialized.includes('priceText'), false);
  for (const item of contract.dishes) {
    assert.ok(item.priceCents === null || Number.isInteger(item.priceCents));
  }
  assert.deepEqual(Object.keys(contract), ['storeName', 'category', 'businessHours', 'fulfillment', 'dishes']);
  assert.deepEqual(Object.keys(contract.dishes[0]), ['id', 'name', 'priceCents', 'description']);
});

test('D25 fromContractDraft 补齐缺失 id，非法价格归 null 并交由校验报错', async () => {
  const draft = await loadDraft();
  const local = draft.fromContractDraft({
    storeName: '松月食堂',
    category: '社区餐馆',
    businessHours: '10:00-21:00',
    fulfillment: { dineIn: true, takeaway: false },
    dishes: [
      { name: '甲', priceCents: 1000, description: '' },
      { name: '乙', priceCents: '1800', description: '' },
      { name: '丙', priceCents: 28.5, description: '' },
    ],
  });
  assert.equal(local.dishes[0].id, 'dish-1');
  assert.equal(local.dishes[1].id, 'dish-2');
  assert.equal(local.dishes[0].priceText, '10.00');
  assert.equal(local.dishes[1].priceCents, null);
  const validation = draft.validateAgentDraft(local);
  assert.ok(missingFields(validation).includes('dishes[1].priceCents'));

  const roundTrip = draft.fromContractDraft(draft.toContractDraft(validDraft()));
  assert.equal(roundTrip.dishes[0].priceCents, 2800);
  assert.equal(roundTrip.dishes[0].priceText, '28.00');
});

test('D26 readyForReview 仅在缺项与错误都为空时为 true', async () => {
  const draft = await loadDraft();
  assert.equal(draft.validateAgentDraft(validDraft()).readyForReview, true);
  const missing = validDraft();
  missing.category = '';
  assert.equal(draft.validateAgentDraft(missing).readyForReview, false);
  const error = validDraft();
  error.storeName = '店'.repeat(49);
  assert.equal(draft.validateAgentDraft(error).readyForReview, false);
});

test('D27 同时缺店名与营业时间时先追问店名', async () => {
  const draft = await loadDraft();
  const validation = draft.validateAgentDraft(validDraft({ storeName: '', businessHours: '' }));
  const question = draft.buildNextQuestion(validation);
  assert.equal(question.field, 'storeName');
  assert.ok(question.text.includes('名字'));
});

test('D28 领域函数是纯函数：同一输入两次结果深相等且不修改入参', async () => {
  const draft = await loadDraft();
  const input = validDraft();
  const snapshot = JSON.parse(JSON.stringify(input));
  assert.deepEqual(draft.normalizeAgentDraft(input), draft.normalizeAgentDraft(input));
  assert.deepEqual(draft.validateAgentDraft(input), draft.validateAgentDraft(input));
  assert.deepEqual(draft.toContractDraft(input), draft.toContractDraft(input));
  const patch = { storeName: '新名', dishes: [{ name: '新菜', priceText: '9.9' }] };
  const patchSnapshot = JSON.parse(JSON.stringify(patch));
  assert.deepEqual(draft.applyDraftPatch(input, patch), draft.applyDraftPatch(input, patch));
  assert.deepEqual(input, snapshot);
  assert.deepEqual(patch, patchSnapshot);
  assert.deepEqual(draft.parsePriceTextToCents('28.5'), { ok: true, cents: 2850, code: null });
});

test('D29 非法输入不抛异常：null、数组、字符串安全降级', async () => {
  const draft = await loadDraft();
  for (const value of [null, undefined, [], 'abc', 42]) {
    assert.doesNotThrow(() => draft.normalizeAgentDraft(value));
    assert.doesNotThrow(() => draft.validateAgentDraft(value));
    assert.doesNotThrow(() => draft.toContractDraft(value));
    assert.doesNotThrow(() => draft.fromContractDraft(value));
    assert.doesNotThrow(() => draft.buildNextQuestion(value));
    assert.doesNotThrow(() => draft.applyDraftPatch(value, value));
  }
});

test('D30 createDishId 不复用已删除的编号', async () => {
  const draft = await loadDraft();
  assert.equal(draft.createDishId([]), 'dish-1');
  assert.equal(draft.createDishId([{ id: 'dish-1' }, { id: 'dish-3' }]), 'dish-4');
  assert.equal(draft.createDishId([{ id: 'dish-2' }]), 'dish-3');
});

test('D31 营业时间文本归一化支持点、半、全角与中文分隔', async () => {
  const draft = await loadDraft();
  const cases = [
    ['10点到21点', '10:00-21:00'],
    ['10点半到21点', '10:30-21:00'],
    ['10:00至21:00', '10:00-21:00'],
    ['１０：００－２１：００', '10:00-21:00'],
    ['10:00~14:00，16:00~21:00', '10:00-14:00,16:00-21:00'],
    ['9:00-21:00', '09:00-21:00'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(draft.normalizeBusinessHoursText(input), expected, input);
  }
  assert.equal(draft.normalizeBusinessHoursText('10:00'), '10:00');
});