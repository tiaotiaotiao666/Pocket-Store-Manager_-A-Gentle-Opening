'use strict';

/**
 * 结构化生图提示词测试（契约 `image-prompt-spec.v1`，plan.md 2.2.10 / T13）。
 *
 * 覆盖：
 * 1. 三种 layout 的结构化约束确实不同；
 * 2. 任意 layout 的 prompt 都 ≤1200 码点；
 * 3. 4 条硬性禁止项在 spec 与 prompt 中都完整存在（超长截断后也不丢）；
 * 4. 尺寸档位附加比例提示（并复用 preview-size-tokens.v1）；
 * 5. layout 缺省推导与非法值回落；
 * 6. reviseImagePrompt 把反馈写入 extraRequirement 且保留禁止项；
 * 7. composePrompt 使用 spec、保留 tips、不发起网络请求。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

async function loadDomain() {
  return import('../src/domain/imagePromptSpec.mjs');
}

async function loadAgentService() {
  return import('../src/services/agentService.js');
}

const LAYOUTS = ['menu', 'catalog', 'editorial'];

const SAMPLE_STORE = {
  name: '松月食堂',
  type: '社区餐馆',
  notes: '慢炖两小时的家常菜，晚上七点后最热闹',
  dishes: [
    { id: 'dish-1', name: '红烧肉' },
    { id: 'dish-2', name: '清炒时蔬' },
    { id: 'dish-3', name: '桂花酒酿' },
  ],
};

const codePoints = (text) => [...String(text)].length;

test('I1 三种 layout 返回不同的结构化约束（构图/主体/色调/光源/留白/模板 ID）', async () => {
  const { buildImagePromptSpec } = await loadDomain();

  const specs = LAYOUTS.map((layout) => buildImagePromptSpec({ layout }).spec);
  assert.deepEqual(specs.map((spec) => spec.layout), LAYOUTS);
  assert.deepEqual(specs.map((spec) => spec.templateId), ['warm-bistro', 'modern-coffee', 'signature-kitchen']);

  for (const field of ['composition', 'subject', 'lighting', 'whiteSpace']) {
    const values = specs.map((spec) => spec[field]);
    assert.equal(new Set(values).size, values.length, `${field} 在三种 layout 之间应各不相同`);
  }
  const palettes = specs.map((spec) => spec.palette.join('|'));
  assert.equal(new Set(palettes).size, palettes.length, 'palette 在三种 layout 之间应各不相同');
  assert.ok(specs[0].palette.length >= 3 && specs[1].palette.length >= 3 && specs[2].palette.length >= 3);
});

test('I2 三种 layout 的 prompt 都 ≤1200 码点，且段落顺序固定', async () => {
  const { buildImagePromptSpec, IMAGE_PROMPT_MAX_LENGTH } = await loadDomain();
  assert.equal(IMAGE_PROMPT_MAX_LENGTH, 1200);

  for (const layout of LAYOUTS) {
    const { prompt, spec } = buildImagePromptSpec({
      layout,
      storeProfile: SAMPLE_STORE,
      styleId: 'warm',
    });
    assert.ok(codePoints(prompt) <= 1200, `${layout} prompt 超长：${codePoints(prompt)}`);
    assert.equal(spec.promptLength, codePoints(prompt));
    assert.equal(spec.maxPromptLength, 1200);

    const order = ['主体：', '构图：', '色调：', '光源：', '留白：', '禁止项：', '门店事实：', '风格：'];
    let cursor = -1;
    for (const marker of order) {
      const index = prompt.indexOf(marker);
      assert.ok(index > cursor, `${layout} 的 ${marker} 段落缺失或顺序错误`);
      cursor = index;
    }
  }
});

test('I3 4 条硬性禁止项在 spec 与 prompt 中都完整存在', async () => {
  const { buildImagePromptSpec, IMAGE_PROMPT_NEGATIVE_REQUIRED } = await loadDomain();
  const required = [
    '不得出现文字/水印',
    '不得出现可识别真人正脸',
    '不得生成二维码',
    '不得出现平台 Logo',
  ];
  assert.deepEqual([...IMAGE_PROMPT_NEGATIVE_REQUIRED], required);

  for (const layout of LAYOUTS) {
    const { prompt, spec } = buildImagePromptSpec({ layout, storeProfile: SAMPLE_STORE });
    for (const item of required) {
      assert.ok(spec.negative.includes(item), `${layout} spec 缺少禁止项：${item}`);
      assert.ok(prompt.includes(item), `${layout} prompt 缺少禁止项：${item}`);
    }
  }
});

test('I4 超长补充要求只截断 extraRequirement，禁止项一条不少且长度仍 ≤1200', async () => {
  const { buildImagePromptSpec } = await loadDomain();
  const longExtra = '希望画面更精致'.repeat(400); // 约 2800 码点

  const { prompt, spec } = buildImagePromptSpec({
    layout: 'editorial',
    storeProfile: SAMPLE_STORE,
    extraRequirement: longExtra,
  });

  assert.ok(codePoints(prompt) <= 1200, `截断后仍超长：${codePoints(prompt)}`);
  assert.equal(spec.extraClipped, true, '原始补充要求超过 200 码点应被裁剪');
  assert.ok(codePoints(spec.extraRequirement) <= 200, 'extraRequirement 本身也应有上限');
  for (const item of spec.negative.filter((text) => text.startsWith('不得出现文字/水印') || text.startsWith('不得出现可识别真人正脸') || text.startsWith('不得生成二维码') || text.startsWith('不得出现平台 Logo'))) {
    assert.ok(prompt.includes(item), `截断后禁止项丢失：${item}`);
  }

  // 未超长时不应误标裁剪
  const normal = buildImagePromptSpec({ layout: 'menu', extraRequirement: '加一点蒸汽' }).spec;
  assert.equal(normal.extraClipped, false);
  assert.equal(normal.extraTruncated, false);
});

test('I5 尺寸档位附加比例提示：sm→1:1、md→4:3、lg→16:9，并复用共享尺寸表', async () => {
  const { buildImagePromptSpec } = await loadDomain();

  const cases = [
    { step: 'sm', expect: '1:1', px: 72, rpx: 150 },
    { step: 'md', expect: '4:3', px: 92, rpx: 190 },
    { step: 'lg', expect: '16:9', px: 120, rpx: 250 },
  ];

  for (const item of cases) {
    const { prompt, spec } = buildImagePromptSpec({
      layout: 'menu',
      storeProfile: SAMPLE_STORE,
      sizeTokens: { homeHero: item.step },
    });
    assert.equal(spec.aspect.value, item.expect);
    assert.equal(spec.aspect.step, item.step);
    assert.equal(spec.aspect.px, item.px, 'px 必须取自 preview-size-tokens.v1');
    assert.equal(spec.aspect.rpx, item.rpx, 'rpx 必须取自 preview-size-tokens.v1');
    assert.ok(prompt.includes(item.expect), `prompt 未包含比例 ${item.expect}`);
  }

  // 兼容 CompositionPlan 的 presentationTokens 命名。
  const fromPlan = buildImagePromptSpec({ layout: 'menu', sizeTokens: { homeHeroSize: 'lg' } }).spec;
  assert.equal(fromPlan.aspect.value, '16:9');
});

test('I6 carousel 档位明确给出时才附加轮播比例，缺省不编造', async () => {
  const { buildImagePromptSpec } = await loadDomain();

  const without = buildImagePromptSpec({ layout: 'catalog', sizeTokens: { homeHero: 'md' } });
  assert.equal(without.spec.carouselAspect, null);
  assert.ok(!without.prompt.includes('轮播比例'));

  const withCarousel = buildImagePromptSpec({
    layout: 'catalog',
    sizeTokens: { homeHero: 'md', carousel: 'lg' },
  });
  assert.equal(withCarousel.spec.carouselAspect.value, '21:9');
  assert.ok(withCarousel.prompt.includes('轮播比例'));
});

test('I7 layout 缺省按门店类型推导；非法 layout 回落 menu 并标记 layoutFallback', async () => {
  const { buildImagePromptSpec } = await loadDomain();

  assert.equal(buildImagePromptSpec({ storeProfile: { type: '咖啡茶饮' } }).spec.layout, 'catalog');
  assert.equal(buildImagePromptSpec({ storeProfile: { type: '特色餐馆' } }).spec.layout, 'editorial');
  assert.equal(buildImagePromptSpec({ storeProfile: { type: '社区餐馆' } }).spec.layout, 'menu');

  const fallback = buildImagePromptSpec({ layout: '不存在的布局', storeProfile: SAMPLE_STORE }).spec;
  assert.equal(fallback.layout, 'menu');
  assert.equal(fallback.layoutFallback, true);
});

test('I8 reviseImagePrompt：反馈写入 extraRequirement，layout 与禁止项保持不变', async () => {
  const { buildImagePromptSpec, reviseImagePrompt } = await loadDomain();
  const base = buildImagePromptSpec({ layout: 'catalog', storeProfile: SAMPLE_STORE, styleId: 'minimal' });

  const revised = reviseImagePrompt({
    basePrompt: base.prompt,
    baseSpec: base.spec,
    feedback: '桌面上加一杯拉花拿铁，光线再亮一点',
  });

  assert.equal(revised.spec.layout, 'catalog');
  assert.match(revised.spec.extraRequirement, /拉花拿铁/);
  assert.ok(codePoints(revised.prompt) <= 1200);
  assert.ok(revised.prompt.includes('拉花拿铁'));
  for (const item of ['不得出现文字/水印', '不得出现可识别真人正脸', '不得生成二维码', '不得出现平台 Logo']) {
    assert.ok(revised.prompt.includes(item), `修订后禁止项丢失：${item}`);
  }
});

test('I9 reviseImagePrompt 缺少 baseSpec 时退回字符串拼接，仍受 1200 码点约束', async () => {
  const { reviseImagePrompt } = await loadDomain();
  const legacy = reviseImagePrompt({
    basePrompt: '一家社区餐馆的招牌菜',
    baseSpec: null,
    feedback: '加一点蒸汽',
  });
  assert.match(legacy.prompt, /一家社区餐馆的招牌菜/);
  assert.match(legacy.prompt, /加一点蒸汽/);
  assert.ok(codePoints(legacy.prompt) <= 1200);
  assert.equal(legacy.spec.legacy, true);
});

test('I10 composePrompt 使用 spec 生成文本、保留 tips（含真实生图接入说明）且不发网络请求', async () => {
  const { composePrompt } = await loadAgentService();
  const { IMAGE_PROMPT_PROVIDER_TIP } = await loadDomain();

  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (...args) => {
    fetchCalls += 1;
    return originalFetch(...args);
  };

  try {
    const result = await composePrompt({ store: SAMPLE_STORE, styleId: 'warm' });
    assert.equal(fetchCalls, 0, 'composePrompt 不得调用网络');
    assert.equal(typeof result.prompt, 'string');
    assert.ok(codePoints(result.prompt) <= 1200);
    assert.equal(result.spec.contract, 'image-prompt-spec.v1');
    assert.equal(result.spec.layout, 'menu');
    assert.ok(result.tips.includes(IMAGE_PROMPT_PROVIDER_TIP));
    assert.ok(result.prompt.includes('松月食堂'));
    assert.ok(result.prompt.includes('红烧肉'));
    for (const item of ['不得出现文字/水印', '不得出现可识别真人正脸', '不得生成二维码', '不得出现平台 Logo']) {
      assert.ok(result.prompt.includes(item));
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('I11 composePrompt 读取门店 presentationTokens 尺寸并写入比例提示', async () => {
  const { composePrompt } = await loadAgentService();
  const store = { ...SAMPLE_STORE, presentationTokens: { homeHeroSize: 'lg', productCardSize: 'sm' } };

  const result = await composePrompt({ store, styleId: 'fresh' });
  assert.equal(result.spec.aspect.value, '16:9');
  assert.ok(result.prompt.includes('16:9'));
});

test('I12 revisePrompt 兼容旧调用方（返回字符串），revisePromptDetailed 返回结构化 spec', async () => {
  const { revisePrompt, revisePromptDetailed } = await loadAgentService();
  const base = '主体：家常菜。禁止项：不得出现文字/水印。';

  const plain = await revisePrompt({ base, feedback: '更暖一点' });
  assert.equal(typeof plain, 'string');
  assert.ok(codePoints(plain) <= 1200);

  // plan.md 2.2.10 声明的是 basePrompt，两种参数名都要能接。
  const fromBasePrompt = await revisePrompt({ basePrompt: base, feedback: '再暗一点' });
  assert.match(fromBasePrompt, /再暗一点/);

  const detailed = await revisePromptDetailed({ base, feedback: '更暖一点' });
  assert.equal(typeof detailed.prompt, 'string');
  assert.equal(detailed.spec.contract, 'image-prompt-spec.v1');
  assert.match(detailed.spec.extraRequirement, /更暖一点/);
});