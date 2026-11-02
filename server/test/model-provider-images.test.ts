import { HttpException, RequestMethod } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { GenerationController } from '../src/generation/generation.controller';
import { ModelProviderService } from '../src/generation/model-provider.service';

type FetchStub = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type ImageResult = { dataUrl: string; provider: string; disclaimer: string };

const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
let fetchMock: Mock<FetchStub>;

function responseStub(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

function imageResponse(image: unknown): Response {
  return responseStub({ data: [{ b64_json: image }] });
}

function visionResponse(content: unknown, status = 200): Response {
  return responseStub({ choices: [{ message: { content } }] }, status);
}

function referenceImage(mimeType = 'png'): string {
  return `data:image/${mimeType};base64,${Buffer.from([1, 2, 3]).toString('base64')}`;
}

async function expectHttpFailure(promise: Promise<unknown>, status: number, code: string): Promise<HttpException> {
  let caught: unknown = null;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(HttpException);
  const error = caught as HttpException;
  expect(error.getStatus()).toBe(status);
  const payload = error.getResponse() as Record<string, unknown>;
  expect(payload.code).toBe(code);
  expect(JSON.stringify(payload)).not.toContain('test-image-key');
  expect(JSON.stringify(payload)).not.toContain('upstream-private-body');
  return error;
}

describe('ModelProviderServiceTest', () => {
  beforeEach(() => {
    vi.stubEnv('IMAGE_API_BASE_URL', 'https://images.example.test/');
    vi.stubEnv('IMAGE_API_KEY', 'test-image-key');
    vi.stubEnv('IMAGE_MODEL_NAME', 'test-image-model');
    vi.stubEnv('VISION_MODEL_NAME', 'test-vision-model');
    vi.stubEnv('IMAGE_PROVIDER_NAME', 'test-image-provider');
    vi.stubEnv('IMAGE_API_TIMEOUT_MS', '5000');
    fetchMock = vi.fn<FetchStub>();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('发送完整生图字段并返回现有图片响应形状', async () => {
    fetchMock.mockResolvedValue(imageResponse(pngBase64));
    const service = new ModelProviderService();

    const result = await service.generateImage({ prompt: '  生成门店海报  ', size: '1536x1024' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('https://images.example.test/images/generations', expect.objectContaining({
      method: 'POST',
      headers: { Authorization: 'Bearer test-image-key', 'Content-Type': 'application/json' },
      signal: expect.any(AbortSignal),
    }));
    const init = fetchMock.mock.calls[0][1];
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'test-image-model',
      prompt: '生成门店海报',
      size: '1536x1024',
      n: 1,
      response_format: 'b64_json',
      quality: 'low',
    });
    expect(result).toEqual({
      dataUrl: `data:image/png;base64,${pngBase64}`,
      provider: 'test-image-provider',
      disclaimer: '该图像由已配置的图像模型生成。',
    });
  });

  it.each([
    { size: undefined, expected: '1024x1024' },
    { size: '512x512', expected: '512x512' },
    { size: '1024x1024', expected: '1024x1024' },
    { size: '1536x1024', expected: '1536x1024' },
    { size: '1024x1536', expected: '1024x1536' },
  ])('接受尺寸 $size 并使用预期请求尺寸 $expected', async ({ size, expected }) => {
    fetchMock.mockResolvedValue(imageResponse(pngBase64));
    const service = new ModelProviderService();
    const prompt = 'a'.repeat(1200);

    await service.generateImage({ prompt, size });

    const init = fetchMock.mock.calls[0][1];
    expect(JSON.parse(String(init?.body))).toMatchObject({ prompt, size: expected });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['', '   ', 'a'.repeat(1201)])('拒绝无效提示词且不请求上游', async (prompt) => {
    const service = new ModelProviderService();

    await expectHttpFailure(service.generateImage({ prompt }), 422, 'IMAGE_PROMPT_INVALID');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['', '512x513', '2048x2048'])('拒绝无效尺寸 %s 且不请求上游', async (size) => {
    const service = new ModelProviderService();

    await expectHttpFailure(service.generateImage({ prompt: '门店海报', size }), 422, 'IMAGE_SIZE_INVALID');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('未配置图像模型时返回现有异常且不发请求', async () => {
    vi.stubEnv('IMAGE_API_KEY', '');
    const service = new ModelProviderService();

    await expectHttpFailure(service.generateImage({ prompt: '门店海报' }), 503, 'MODEL_PROVIDER_NOT_CONFIGURED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('非 200 响应不自动重试且不泄漏上游响应', async () => {
    fetchMock.mockResolvedValue(responseStub({ error: 'upstream-private-body' }, 502));
    const service = new ModelProviderService();

    await expectHttpFailure(service.generateImage({ prompt: '门店海报' }), 503, 'IMAGE_PROVIDER_FAILED');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('网络失败不自动重试并隐藏上游错误细节', async () => {
    fetchMock.mockRejectedValue(new Error('upstream-private-body'));
    const service = new ModelProviderService();

    await expectHttpFailure(service.generateImage({ prompt: '门店海报' }), 503, 'IMAGE_PROVIDER_UNAVAILABLE');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    Buffer.from('not-a-png').toString('base64'),
    'not-base64!',
    '',
  ])('拒绝非法 base64 或非 PNG 响应', async (image) => {
    fetchMock.mockResolvedValue(imageResponse(image));
    const service = new ModelProviderService();

    await expectHttpFailure(service.generateImage({ prompt: '门店海报' }), 503, 'IMAGE_RESPONSE_INVALID');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('拒绝超过 5 MB 的 PNG 数据', async () => {
    const data = Buffer.alloc(5 * 1024 * 1024 + 1);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(data);
    fetchMock.mockResolvedValue(imageResponse(data.toString('base64')));
    const service = new ModelProviderService();

    await expectHttpFailure(service.generateImage({ prompt: '门店海报' }), 503, 'IMAGE_RESPONSE_INVALID');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('响应缺少图片数据时返回非法响应异常', async () => {
    fetchMock.mockResolvedValue(responseStub({ data: [] }));
    const service = new ModelProviderService();

    await expectHttpFailure(service.generateImage({ prompt: '门店海报' }), 503, 'IMAGE_RESPONSE_INVALID');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('保留模型配置状态与未配置回退行为', () => {
    const service = new ModelProviderService();
    expect(service.status()).toMatchObject({
      provider: 'test-image-provider',
      configured: true,
      imageModel: true,
      visionModel: true,
    });

    vi.stubEnv('IMAGE_PROVIDER_NAME', '');
    vi.stubEnv('IMAGE_API_KEY', '');
    vi.stubEnv('IMAGE_MODEL_NAME', '');
    vi.stubEnv('VISION_MODEL_NAME', '');
    expect(service.status()).toMatchObject({
      provider: 'not-configured',
      configured: false,
      imageModel: false,
      visionModel: false,
    });
  });

  it('拒绝无效模型地址且不请求上游', async () => {
    vi.stubEnv('IMAGE_API_BASE_URL', 'not-a-valid-url');
    const service = new ModelProviderService();

    await expectHttpFailure(service.generateImage({ prompt: '门店海报' }), 503, 'MODEL_PROVIDER_URL_INVALID');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['', 'not-json'])('空响应或非法 JSON 按非法图片响应处理', async (body) => {
    fetchMock.mockResolvedValue(responseStub(body));
    const service = new ModelProviderService();

    await expectHttpFailure(service.generateImage({ prompt: '门店海报' }), 503, 'IMAGE_RESPONSE_INVALID');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('保留图标名称与主题校验', async () => {
    const service = new ModelProviderService();

    await expectHttpFailure(service.generateIcon({ name: ' ', theme: 'citrus' }), 422, 'ICON_NAME_REQUIRED');
    await expectHttpFailure(service.generateIcon({ name: '菜单', theme: ' ' }), 422, 'THEME_REQUIRED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('保留无参考图图标生成请求与结果', async () => {
    fetchMock.mockResolvedValue(imageResponse(pngBase64));
    const service = new ModelProviderService();

    const result = await service.generateIcon({ name: ' 菜单 ', theme: ' citrus ', seed: 7 });

    expect(result.dataUrl).toBe(`data:image/png;base64,${pngBase64}`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://images.example.test/images/generations');
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ model: 'test-image-model', size: '512x512', n: 1, response_format: 'b64_json' });
    expect(body.prompt).toContain('菜单');
    expect(body.prompt).toContain('citrus');
    expect(body.prompt).toContain('Variation seed: 7');
  });

  it('保留参考图图标编辑请求', async () => {
    fetchMock.mockResolvedValue(imageResponse(pngBase64));
    const service = new ModelProviderService();

    await service.generateIcon({ name: '菜单', theme: 'citrus', referenceImages: [referenceImage('jpeg')] });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://images.example.test/images/edits');
    expect(init?.body).toBeInstanceOf(FormData);
    const form = init?.body as FormData;
    expect(form.get('model')).toBe('test-image-model');
    expect(form.get('size')).toBe('512x512');
    expect(form.get('response_format')).toBe('b64_json');
    const upload = form.get('image[]') as File;
    expect(upload.type).toBe('image/jpeg');
    expect(upload.name).toBe('store-reference.jpeg');
  });

  it('保留参考图数量、格式与空内容校验', async () => {
    const service = new ModelProviderService();
    const input = { name: '菜单', theme: 'citrus' };

    await expectHttpFailure(service.generateIcon({ ...input, referenceImages: Array<string>(6).fill(referenceImage()) }), 422, 'REFERENCE_LIMIT_EXCEEDED');
    await expectHttpFailure(service.generateIcon({ ...input, referenceImages: ['invalid-image'] }), 422, 'REFERENCE_IMAGE_INVALID');
    await expectHttpFailure(service.generateIcon({ ...input, referenceImages: ['data:image/png;base64,='] }), 422, 'REFERENCE_IMAGE_TOO_LARGE');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('保留图标生成上游失败、非法响应与网络异常映射', async () => {
    const service = new ModelProviderService();
    const input = { name: '菜单', theme: 'citrus' };
    fetchMock.mockResolvedValueOnce(responseStub({}, 500));
    fetchMock.mockResolvedValueOnce(responseStub({}));
    fetchMock.mockRejectedValueOnce(new Error('upstream-private-body'));

    await expectHttpFailure(service.generateIcon(input), 503, 'IMAGE_PROVIDER_FAILED');
    await expectHttpFailure(service.generateIcon(input), 503, 'IMAGE_RESPONSE_INVALID');
    await expectHttpFailure(service.generateIcon(input), 503, 'IMAGE_PROVIDER_UNAVAILABLE');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('保留视觉分析参考图必填与视觉模型配置校验', async () => {
    const service = new ModelProviderService();
    await expectHttpFailure(service.recommendStyle({}), 422, 'STYLE_REFERENCE_REQUIRED');

    vi.stubEnv('VISION_MODEL_NAME', '');
    vi.stubEnv('IMAGE_MODEL_NAME', '');
    await expectHttpFailure(service.recommendStyle({ referenceImages: [referenceImage()] }), 503, 'MODEL_PROVIDER_NOT_CONFIGURED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('保留字符串视觉建议解析与请求结构', async () => {
    fetchMock.mockResolvedValue(visionResponse('说明 {"templateId":"warm-bistro","reason":"暖色空间"} 后记'));
    const service = new ModelProviderService();

    const result = await service.recommendStyle({ storeName: '松月食堂', referenceImages: [referenceImage('webp')] });

    expect(result).toEqual({
      templateId: 'warm-bistro',
      reason: '暖色空间',
      disclaimer: '这是模型建议，不会直接修改已选功能或生成代码。',
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://images.example.test/chat/completions');
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ model: 'test-vision-model', temperature: 0.2, max_tokens: 320 });
    expect(body.messages[0].content[0].text).toContain('松月食堂');
    expect(body.messages[0].content[1]).toMatchObject({ type: 'image_url', image_url: { detail: 'low' } });
  });

  it('保留数组视觉内容解析、默认理由与图像模型回退', async () => {
    vi.stubEnv('VISION_MODEL_NAME', '');
    fetchMock.mockResolvedValue(visionResponse([{ text: '{"templateId":"modern-coffee",' }, { text: '"reason":""}' }, {}]));
    const service = new ModelProviderService();

    const result = await service.recommendStyle({ referenceImages: [referenceImage()] });

    expect(result.templateId).toBe('modern-coffee');
    expect(result.reason).toBe('根据门店资料提出建议。');
    const init = fetchMock.mock.calls[0][1];
    expect(JSON.parse(String(init?.body)).model).toBe('test-image-model');
  });

  it('保留视觉分析失败、非法响应、无效模板与解析异常映射', async () => {
    const service = new ModelProviderService();
    const input = { referenceImages: [referenceImage()] };
    fetchMock.mockResolvedValueOnce(visionResponse('error', 500));
    fetchMock.mockResolvedValueOnce(visionResponse(0));
    fetchMock.mockResolvedValueOnce(visionResponse('{"templateId":"unknown"}'));
    fetchMock.mockResolvedValueOnce(visionResponse('{bad}'));

    await expectHttpFailure(service.recommendStyle(input), 503, 'VISION_PROVIDER_FAILED');
    await expectHttpFailure(service.recommendStyle(input), 503, 'VISION_RESPONSE_INVALID');
    await expectHttpFailure(service.recommendStyle(input), 503, 'VISION_TEMPLATE_INVALID');
    await expectHttpFailure(service.recommendStyle(input), 503, 'VISION_PROVIDER_UNAVAILABLE');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

describe('GenerationControllerTest', () => {
  it('POST images 路由将请求转发给生图方法', async () => {
    const result: ImageResult = { dataUrl: `data:image/png;base64,${pngBase64}`, provider: 'test-image-provider', disclaimer: '测试说明' };
    const generateImage = vi.fn<(input: { prompt?: string; size?: string }) => Promise<ImageResult>>().mockResolvedValue(result);
    const provider = { generateImage } as unknown as ModelProviderService;
    const controller = new GenerationController(provider);
    const request = { prompt: '门店海报', size: '512x512' };

    await expect(controller.generateImage(request)).resolves.toBe(result);
    expect(generateImage).toHaveBeenCalledWith(request);
    expect(Reflect.getMetadata('path', GenerationController.prototype.generateImage)).toBe('images');
    expect(Reflect.getMetadata('method', GenerationController.prototype.generateImage)).toBe(RequestMethod.POST);
  });

  it('保留健康检查、图标生成与风格推荐路由转发', async () => {
    const statusResult = { provider: 'test-image-provider', configured: true, imageModel: true, visionModel: true, disclaimer: '状态说明' };
    const iconResult: ImageResult = { dataUrl: `data:image/png;base64,${pngBase64}`, provider: 'test-image-provider', disclaimer: '图标说明' };
    const styleResult = { templateId: 'warm-bistro', reason: '适合门店', disclaimer: '风格说明' };
    const status = vi.fn().mockReturnValue(statusResult);
    const generateIcon = vi.fn<(input: { name?: string; theme?: string; seed?: number; referenceImages?: string[] }) => Promise<ImageResult>>().mockResolvedValue(iconResult);
    const recommendStyle = vi.fn<(input: { storeName?: string; storeType?: string; notes?: string; referenceImages?: string[] }) => Promise<typeof styleResult>>().mockResolvedValue(styleResult);
    const provider = { status, generateIcon, recommendStyle } as unknown as ModelProviderService;
    const controller = new GenerationController(provider);
    const iconRequest = { name: '菜单', theme: 'citrus' };
    const styleRequest = { referenceImages: [referenceImage()] };

    expect(controller.status()).toBe(statusResult);
    await expect(controller.generateIcon(iconRequest)).resolves.toBe(iconResult);
    await expect(controller.recommendStyle(styleRequest)).resolves.toBe(styleResult);
    expect(generateIcon).toHaveBeenCalledWith(iconRequest);
    expect(recommendStyle).toHaveBeenCalledWith(styleRequest);
    expect(Reflect.getMetadata('path', GenerationController.prototype.status)).toBe('health');
    expect(Reflect.getMetadata('method', GenerationController.prototype.status)).toBe(RequestMethod.GET);
  });
});