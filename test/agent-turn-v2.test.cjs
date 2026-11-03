const test = require('node:test');
const assert = require('node:assert/strict');

const V1 = 'agent-turn.v1';
const V2 = 'agent-turn.v2';
const KiB = 1024;

function emptyContractDraft() {
  return {
    storeName: '',
    category: '',
    businessHours: '',
    fulfillment: { dineIn: false, takeaway: false },
    dishes: [],
  };
}

function validResponse(overrides = {}) {
  return {
    contractVersion: V1,
    turnId: 'turn-http-1',
    status: 'collecting',
    reply: '已记录。',
    draft: {
      ...emptyContractDraft(),
      storeName: '松月食堂',
    },
    missingFields: [{ field: 'category', label: '品类', detail: '例如：社区餐馆' }],
    errors: [],
    nextQuestion: { field: 'category', label: '品类', text: '主要做什么品类？' },
    meta: {
      transport: 'http',
      provider: 'future-provider',
      mock: false,
      model: 'future-model',
      latencyMs: 12,
    },
    ...overrides,
  };
}

function validV2Response(vision = null, overrides = {}) {
  return validResponse({
    contractVersion: V2,
    vision,
    ...overrides,
  });
}

function responseStub(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function base64Of(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

/** 合法的 AgentImageDraft（体积很小，方便做 count/type 校验用例）。 */
function imageDraft(kind = 'menu', payload = 'hello', overrides = {}) {
  const dataBase64 = base64Of(payload);
  return {
    id: `${kind}-1`,
    kind,
    name: `${kind}-1.jpg`,
    mediaType: 'image/jpeg',
    dataBase64,
    previewDataUrl: `data:image/jpeg;base64,${dataBase64}`,
    bytes: Buffer.byteLength(payload),
    ...overrides,
  };
}

function makeFakeCanvasRecorder() {
  const recorder = {
    widths: [],
    heights: [],
    draws: [],
  };
  recorder.createCanvas = (width, height) => {
    recorder.widths.push(width);
    recorder.heights.push(height);
    return {
      width,
      height,
      getContext: () => ({
        drawImage: (drawable, x, y, targetWidth, targetHeight) => {
          recorder.draws.push({ drawable, x, y, targetWidth, targetHeight });
        },
      }),
    };
  };
  return recorder;
}

async function load(path) {
  return import(path);
}

// ---------------------------------------------------------------------------
// HTTP transport：v1 兼容与 v2 多模态
// ---------------------------------------------------------------------------

test('V2-01 未传 images 时 HTTP v1 请求体与响应形状完全不变', async () => {
  const { createHttpTransport } = await load('../src/services/agentTurn/httpAgentTransport.js');
  let captured = null;
  const transport = createHttpTransport({
    endpoint: '/api/v1/agent/turn',
    timeoutMs: 500,
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return responseStub(validResponse());
    },
  });

  const request = {
    contractVersion: V1,
    utterance: '店名叫松月食堂',
    draft: emptyContractDraft(),
    client: { surface: 'desktop', phase: 'store-info' },
    projectId: null,
  };
  const result = await transport.send(request);

  assert.equal(captured.init.headers['X-Agent-Contract'], V1);
  const body = JSON.parse(captured.init.body);
  assert.deepEqual(body, request);
  assert.equal(Object.prototype.hasOwnProperty.call(body, 'images'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'vision'), false);
});

test('V2-02 HTTP v2 请求携带 contractVersion、X-Agent-Contract 与 images', async () => {
  const { createHttpTransport } = await load('../src/services/agentTurn/httpAgentTransport.js');
  let captured = null;
  const transport = createHttpTransport({
    endpoint: '/api/v1/agent/turn',
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return responseStub(validV2Response({
        menuImages: 1,
        storeImages: 1,
        analyzed: true,
        degraded: false,
      }));
    },
  });

  const images = [
    { kind: 'menu', mediaType: 'image/jpeg', data: base64Of('menu-image') },
    { kind: 'store', mediaType: 'image/jpeg', data: base64Of('store-image') },
  ];
  const result = await transport.send({
    contractVersion: V2,
    utterance: '看看这两张图',
    draft: emptyContractDraft(),
    images,
    client: { surface: 'desktop', phase: 'store-info' },
    projectId: null,
  });

  assert.equal(captured.init.headers['X-Agent-Contract'], V2);
  const body = JSON.parse(captured.init.body);
  assert.equal(body.contractVersion, V2);
  assert.deepEqual(body.images, images);
  assert.deepEqual(result.vision, {
    menuImages: 1,
    storeImages: 1,
    analyzed: true,
    degraded: false,
  });
});

test('V2-03 v2 请求收到 v1 响应判定为 AGENT_CONTRACT_MISMATCH', async () => {
  const { createHttpTransport } = await load('../src/services/agentTurn/httpAgentTransport.js');
  const transport = createHttpTransport({
    fetchImpl: async () => responseStub(validResponse()),
  });

  await assert.rejects(
    transport.send({
      contractVersion: V2,
      utterance: 'x',
      draft: emptyContractDraft(),
      images: [{ kind: 'menu', mediaType: 'image/jpeg', data: base64Of('a') }],
    }),
    (error) => error.code === 'AGENT_CONTRACT_MISMATCH',
  );
});

test('V2-04 v2 响应缺少 vision 或 vision 字段非法时判为 AGENT_RESPONSE_INVALID', async () => {
  const { createHttpTransport } = await load('../src/services/agentTurn/httpAgentTransport.js');
  const missingVision = validV2Response(null);
  delete missingVision.vision;
  const brokenBodies = [
    missingVision,
    validV2Response({ menuImages: -1, storeImages: 0, analyzed: true, degraded: false }),
    validV2Response({ menuImages: 1, storeImages: 0, analyzed: 'yes', degraded: false }),
  ];

  for (const body of brokenBodies) {
    const transport = createHttpTransport({ fetchImpl: async () => responseStub(body) });
    await assert.rejects(
      transport.send({
        contractVersion: V2,
        utterance: 'x',
        draft: emptyContractDraft(),
        images: [{ kind: 'menu', mediaType: 'image/jpeg', data: base64Of('a') }],
      }),
      (error) => error.code === 'AGENT_RESPONSE_INVALID',
      JSON.stringify(body.vision),
    );
  }
});

test('V2-05 HTTP 413 映射为“图片过大，请压缩后重试”', async () => {
  const { createHttpTransport } = await load('../src/services/agentTurn/httpAgentTransport.js');
  const transport = createHttpTransport({
    fetchImpl: async () => responseStub({ code: 'AGENT_BODY_TOO_LARGE' }, 413),
  });

  await assert.rejects(
    transport.send({
      contractVersion: V2,
      utterance: 'x',
      draft: emptyContractDraft(),
      images: [{ kind: 'menu', mediaType: 'image/jpeg', data: base64Of('a') }],
    }),
    (error) => error.code === 'AGENT_HTTP_4XX'
      && error.httpStatus === 413
      && error.message === '图片过大，请压缩后重试。',
  );
});

// ---------------------------------------------------------------------------
// Service：images 参数、超限拦截、vision 透传
// ---------------------------------------------------------------------------

test('V2-06 service 把 images 转成 v2 请求并透传 vision', async () => {
  const { createAgentTurnService } = await load('../src/services/agentTurn/agentTurnService.js');
  let captured = null;
  const transport = {
    name: 'stub',
    async send(request) {
      captured = request;
      return validV2Response({
        menuImages: 1,
        storeImages: 0,
        analyzed: true,
        degraded: false,
      });
    },
  };
  const service = createAgentTurnService({ transport });
  const draft = imageDraft('menu', 'menu-bytes');

  const result = await service.requestAgentTurn({
    utterance: '这是菜单',
    draft: {},
    images: [draft],
  });

  assert.equal(captured.contractVersion, V2);
  assert.deepEqual(captured.images, [{
    kind: 'menu',
    mediaType: 'image/jpeg',
    data: draft.dataBase64,
  }]);
  assert.deepEqual(result.vision, {
    menuImages: 1,
    storeImages: 0,
    analyzed: true,
    degraded: false,
  });
  assert.equal(result.draft.storeName, '松月食堂');
});

test('V2-07 service 未传 images 时仍发 v1 请求且结果没有 vision 字段', async () => {
  const { createAgentTurnService } = await load('../src/services/agentTurn/agentTurnService.js');
  let captured = null;
  const transport = {
    name: 'stub',
    async send(request) {
      captured = request;
      return validResponse();
    },
  };
  const service = createAgentTurnService({ transport });

  const result = await service.requestAgentTurn({ utterance: '店名叫松月食堂', draft: {} });

  assert.equal(captured.contractVersion, V1);
  assert.equal(Object.prototype.hasOwnProperty.call(captured, 'images'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'vision'), false);
});

test('V2-08 service 菜单照超 2 张时返回结构化错误且不发请求', async () => {
  const { createAgentTurnService } = await load('../src/services/agentTurn/agentTurnService.js');
  let sendCount = 0;
  const transport = {
    name: 'stub',
    async send() {
      sendCount += 1;
      return validV2Response(null);
    },
  };
  const service = createAgentTurnService({ transport });

  await assert.rejects(
    service.requestAgentTurn({
      utterance: '三张菜单照',
      draft: {},
      images: [
        imageDraft('menu', 'a', { id: 'menu-1' }),
        imageDraft('menu', 'b', { id: 'menu-2' }),
        imageDraft('menu', 'c', { id: 'menu-3' }),
      ],
    }),
    (error) => error.code === 'AGENT_IMAGE_COUNT_EXCEEDED'
      && error.ok === false
      && error.structured === true
      && error.retryable === false,
  );
  assert.equal(sendCount, 0);
});

test('V2-09 service 遇到非白名单 MIME 时返回结构化错误且不发请求', async () => {
  const { createAgentTurnService } = await load('../src/services/agentTurn/agentTurnService.js');
  let sendCount = 0;
  const transport = {
    name: 'stub',
    async send() {
      sendCount += 1;
      return validV2Response(null);
    },
  };
  const service = createAgentTurnService({ transport });

  await assert.rejects(
    service.requestAgentTurn({
      utterance: '一张 GIF',
      draft: {},
      images: [imageDraft('menu', 'gif', { mediaType: 'image/gif' })],
    }),
    (error) => error.code === 'AGENT_IMAGE_TYPE_UNSUPPORTED' && error.ok === false,
  );
  assert.equal(sendCount, 0);
});

// ---------------------------------------------------------------------------
// Mock transport：v1 形状不变，v2 不伪造视觉识别
// ---------------------------------------------------------------------------

test('V2-10 Mock v1 响应没有 vision 字段', async () => {
  const { createMockTransport } = await load('../src/services/agentTurn/mockAgentTransport.js');
  const transport = createMockTransport();
  const response = await transport.send({
    contractVersion: V1,
    utterance: '店名叫松月食堂',
    draft: emptyContractDraft(),
  });

  assert.equal(response.contractVersion, V1);
  assert.equal(Object.prototype.hasOwnProperty.call(response, 'vision'), false);
});

test('V2-11 Mock v2 统计图片张数但 analyzed=false，无图片时 vision=null', async () => {
  const { createMockTransport } = await load('../src/services/agentTurn/mockAgentTransport.js');
  const transport = createMockTransport();

  const withImages = await transport.send({
    contractVersion: V2,
    utterance: '店名叫松月食堂，看看图片',
    draft: emptyContractDraft(),
    images: [
      { kind: 'menu', mediaType: 'image/jpeg', data: base64Of('a') },
      { kind: 'menu', mediaType: 'image/jpeg', data: base64Of('b') },
      { kind: 'store', mediaType: 'image/jpeg', data: base64Of('c') },
    ],
  });
  assert.equal(withImages.contractVersion, V2);
  assert.deepEqual(withImages.vision, {
    menuImages: 2,
    storeImages: 1,
    analyzed: false,
    degraded: false,
  });

  const withoutImages = await transport.send({
    contractVersion: V2,
    utterance: '店名叫松月食堂',
    draft: emptyContractDraft(),
  });
  assert.equal(withoutImages.vision, null);
});

// ---------------------------------------------------------------------------
// prepareImageFile：注入 DOM 适配器验证三个错误码与压缩行为
// ---------------------------------------------------------------------------

test('V2-12 prepareImageFile 非白名单 MIME 报 AGENT_IMAGE_TYPE_UNSUPPORTED', async () => {
  const { prepareImageFile } = await load('../src/services/agentTurn/agentImageUpload.js');

  await assert.rejects(
    prepareImageFile({ type: 'image/gif', name: 'anim.gif' }, { kind: 'menu' }, {}),
    (error) => error.code === 'AGENT_IMAGE_TYPE_UNSUPPORTED' && error.retryable === false,
  );
});

test('V2-13 prepareImageFile 解码失败报 AGENT_IMAGE_DECODE_FAILED', async () => {
  const { prepareImageFile } = await load('../src/services/agentTurn/agentImageUpload.js');

  await assert.rejects(
    prepareImageFile(
      { type: 'image/jpeg', name: 'broken.jpg' },
      { kind: 'menu' },
      { loadBitmap: async () => { throw new Error('decode boom'); } },
    ),
    (error) => error.code === 'AGENT_IMAGE_DECODE_FAILED',
  );
});

test('V2-14 prepareImageFile 压缩后仍超 400 KiB 报 AGENT_IMAGE_TOO_LARGE，并遍历 0.72→0.55', async () => {
  const { prepareImageFile } = await load('../src/services/agentTurn/agentImageUpload.js');
  const canvasRecorder = makeFakeCanvasRecorder();
  const qualities = [];
  const oversized = 500 * KiB;

  await assert.rejects(
    prepareImageFile(
      { type: 'image/jpeg', name: 'huge.jpg' },
      { kind: 'menu' },
      {
        loadBitmap: async () => ({ width: 800, height: 800, drawable: {}, close() {} }),
        createCanvas: canvasRecorder.createCanvas,
        canvasToBlob: async (canvas, type, quality) => {
          qualities.push({ type, quality, size: oversized });
          return { size: oversized, type: 'image/jpeg' };
        },
        readAsDataUrl: async () => 'data:image/jpeg;base64,YWJj',
      },
    ),
    (error) => error.code === 'AGENT_IMAGE_TOO_LARGE' && error.retryable === false,
  );

  assert.deepEqual(qualities.map((item) => item.quality), [0.72, 0.64, 0.55]);
  assert.equal(qualities.every((item) => item.type === 'image/jpeg'), true);
});

test('V2-15 prepareImageFile 长边缩到 1280 并以 0.72 首档压缩，输出纯 base64', async () => {
  const { prepareImageFile } = await load('../src/services/agentTurn/agentImageUpload.js');
  const canvasRecorder = makeFakeCanvasRecorder();
  const qualities = [];

  const draft = await prepareImageFile(
    { type: 'image/png', name: 'menu.png', size: 4096 },
    { kind: 'menu', id: 'img-1', name: '菜单.png' },
    {
      loadBitmap: async () => ({ width: 4000, height: 2000, drawable: {}, close() {} }),
      createCanvas: canvasRecorder.createCanvas,
      canvasToBlob: async (canvas, type, quality) => {
        qualities.push(quality);
        return { size: 2 * KiB, type: 'image/jpeg' };
      },
      readAsDataUrl: async () => 'data:image/jpeg;base64,YWJjZA==',
    },
  );

  assert.deepEqual(qualities, [0.72]);
  assert.equal(canvasRecorder.widths[0], 1280);
  assert.equal(canvasRecorder.heights[0], 640);
  assert.deepEqual(canvasRecorder.draws[0], {
    drawable: {},
    x: 0,
    y: 0,
    targetWidth: 1280,
    targetHeight: 640,
  });
  assert.equal(draft.id, 'img-1');
  assert.equal(draft.kind, 'menu');
  assert.equal(draft.name, '菜单.png');
  assert.equal(draft.mediaType, 'image/jpeg');
  assert.equal(draft.dataBase64, 'YWJjZA==');
  assert.equal(draft.previewDataUrl, 'data:image/jpeg;base64,YWJjZA==');
  assert.equal(draft.bytes, 2 * KiB);
});

test('V2-16 prepareImageFile 首档超限时降到 0.64 并接受更小结果', async () => {
  const { prepareImageFile } = await load('../src/services/agentTurn/agentImageUpload.js');
  const canvasRecorder = makeFakeCanvasRecorder();
  const qualities = [];
  const sizes = [500 * KiB, 300 * KiB, 100 * KiB];

  const draft = await prepareImageFile(
    { type: 'image/webp', name: 'store.webp' },
    { kind: 'store', id: 'store-1' },
    {
      loadBitmap: async () => ({ width: 1000, height: 1500, drawable: {}, close() {} }),
      createCanvas: canvasRecorder.createCanvas,
      canvasToBlob: async () => {
        const size = sizes[qualities.length];
        qualities.push(size);
        return { size, type: 'image/jpeg' };
      },
      readAsDataUrl: async () => 'data:image/jpeg;base64,YWJj',
    },
  );

  assert.deepEqual(qualities, [500 * KiB, 300 * KiB]);
  assert.equal(draft.bytes, 300 * KiB);
  // 长边 1500 > 1280，等比缩放后 853x1280。
  assert.equal(canvasRecorder.widths[0], 853);
  assert.equal(canvasRecorder.heights[0], 1280);
});

test('V2-17 toAgentTurnImages 只保留 kind/mediaType/data，不泄漏预览地址', async () => {
  const { toAgentTurnImages } = await load('../src/services/agentTurn/agentImageUpload.js');
  const draft = imageDraft('menu', 'payload');
  const wire = toAgentTurnImages([draft]);

  assert.deepEqual(wire, [{
    kind: 'menu',
    mediaType: 'image/jpeg',
    data: draft.dataBase64,
  }]);
  assert.equal(Object.prototype.hasOwnProperty.call(wire[0], 'previewDataUrl'), false);
  assert.deepEqual(toAgentTurnImages(null), []);
});