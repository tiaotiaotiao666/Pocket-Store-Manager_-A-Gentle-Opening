import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { PosterGenerationService } from '../src/generation/poster-generation.service';
import { buildPosterPrompt, normalizePosterPrompt, POSTER_PROMPT_MAX_LENGTH } from '../src/generation/poster-prompt';

type FetchStub = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** 只要符合 PNG 签名 + IHDR 的头部就可以通过服务端校验（真实图片来自上游，这里构造等长头部）。 */
function pngHeader(width: number, height: number, padding = 64): Buffer {
  const buffer = Buffer.alloc(24 + padding);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function pngBase64(width = 1024, height = 1024): string {
  return pngHeader(width, height).toString('base64');
}

function responseStub(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    arrayBuffer: async () => new Uint8Array(),
  } as unknown as Response;
}

async function expectFailure(promise: Promise<unknown>, status: number, code: string) {
  let caught: any = null;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).not.toBeNull();
  expect(caught.status).toBe(status);
  expect(caught.code).toBe(code);
  // 错误信息里绝不出现密钥
  expect(JSON.stringify({ code: caught.code, message: caught.message })).not.toContain('poster-test-key');
  return caught;
}

describe('PosterPromptBuilder', () => {
  it('用已确认的店名、品类、风格、菜品生成提示词', () => {
    const prompt = buildPosterPrompt({
      storeName: '云栖小馆',
      storeType: '社区面馆',
      styleLabel: '温暖小店',
      dishes: ['雪菜肉丝面', '葱油拌面', '卤蛋'],
    });
    expect(prompt).toContain('云栖小馆');
    expect(prompt).toContain('社区面馆');
    expect(prompt).toContain('温暖小店');
    expect(prompt).toContain('雪菜肉丝面');
    expect(prompt).toContain('不要出现任何文字');
    expect(prompt.length).toBeLessThanOrEqual(POSTER_PROMPT_MAX_LENGTH);
  });

  it('不把地址、电话等隐私字段拼进提示词', () => {
    const prompt = buildPosterPrompt({
      storeName: '云栖小馆',
      storeType: '社区面馆',
      dishes: ['雪菜肉丝面'],
      // 这三个字段不在入参里；即使调用方多传也不会被使用
      ...{ address: '某某路 1 号', phone: '13800000000', notes: '内部备注' },
    } as unknown as Parameters<typeof buildPosterPrompt>[0]);
    expect(prompt).not.toContain('某某路');
    expect(prompt).not.toContain('13800000000');
    expect(prompt).not.toContain('内部备注');
  });

  it('提示词长度与字符校验', () => {
    expect(normalizePosterPrompt('   ')).toBeNull();
    expect(normalizePosterPrompt('x'.repeat(POSTER_PROMPT_MAX_LENGTH + 1))).toBeNull();
    expect(normalizePosterPrompt('a\u0001b')).toBeNull();
    expect(normalizePosterPrompt(' 一张暖色面馆海报 ')).toBe('一张暖色面馆海报');
  });
});

describe('PosterGenerationService', () => {
  let fetchMock: Mock<FetchStub>;

  beforeEach(() => {
    vi.stubEnv('IMAGE_API_BASE_URL', 'https://images.example.test/v1');
    vi.stubEnv('IMAGE_API_KEY', 'poster-test-key');
    vi.stubEnv('POSTER_IMAGE_MODEL', 'gpt-image-2.6');
    vi.stubEnv('POSTER_IMAGE_TIMEOUT_MS', '5000');
    vi.stubEnv('POSTER_IMAGE_WINDOW_LIMIT', '6');
    vi.stubEnv('POSTER_IMAGE_MAX_CONCURRENT', '1');
    vi.stubEnv('IMAGE_PROVIDER_NAME', 'test-poster-provider');
    fetchMock = vi.fn<FetchStub>();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('未配置端点或密钥时直接失败，不发请求', async () => {
    vi.stubEnv('IMAGE_API_KEY', '');
    const service = new PosterGenerationService();
    await expectFailure(service.generate({ prompt: '海报', sessionId: 's1' }), 503, 'POSTER_IMAGE_NOT_CONFIGURED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('真实返回合法 PNG 时才算成功，并把模型名与摘要带回', async () => {
    fetchMock.mockResolvedValue(responseStub({ data: [{ b64_json: pngBase64(1024, 1024) }], usage: { input_tokens: 22, output_tokens: 425 } }));
    const service = new PosterGenerationService();
    const result = await service.generate({ prompt: '一张暖色面馆海报', sessionId: 's1' });

    expect(result.width).toBe(1024);
    expect(result.height).toBe(1024);
    expect(result.model).toBe('gpt-image-2.6');
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.usage).toEqual({ inputTokens: 22, outputTokens: 425 });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://images.example.test/v1/images/generations');
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe('gpt-image-2.6');
    expect(body.n).toBe(1);
    expect(body.response_format).toBe('b64_json');
    expect(String((init?.headers as Record<string, string>).Authorization)).toContain('poster-test-key');
  });

  it('上游返回的不是合法 PNG 时报错，不返回任何图片', async () => {
    fetchMock.mockResolvedValue(responseStub({ data: [{ b64_json: Buffer.from('not-a-png').toString('base64') }] }));
    const service = new PosterGenerationService();
    await expectFailure(service.generate({ prompt: '海报', sessionId: 's2' }), 502, 'POSTER_IMAGE_INVALID');
  });

  it('鉴权失败、限流、网关 HTML 502 都有独立错误码', async () => {
    const service = new PosterGenerationService();

    fetchMock.mockResolvedValueOnce(responseStub({ error: { code: 'invalid_api_key' } }, 401));
    await expectFailure(service.generate({ prompt: '海报', sessionId: 'a' }), 503, 'POSTER_IMAGE_AUTH_FAILED');

    fetchMock.mockResolvedValueOnce(responseStub({ error: { code: 'rate_limited' } }, 429));
    await expectFailure(service.generate({ prompt: '海报', sessionId: 'b' }), 429, 'POSTER_IMAGE_RATE_LIMITED');

    fetchMock.mockResolvedValueOnce(responseStub('<html>502 Bad gateway</html>', 502));
    await expectFailure(service.generate({ prompt: '海报', sessionId: 'c' }), 502, 'POSTER_IMAGE_UNAVAILABLE');
  });

  it('同一会话超出窗口额度后不再调用上游', async () => {
    vi.stubEnv('POSTER_IMAGE_WINDOW_LIMIT', '1');
    fetchMock.mockResolvedValue(responseStub({ data: [{ b64_json: pngBase64(1024, 1024) }] }));
    const service = new PosterGenerationService();
    await service.generate({ prompt: '海报', sessionId: 'window' });
    await expectFailure(service.generate({ prompt: '海报', sessionId: 'window' }), 429, 'POSTER_IMAGE_RATE_LIMITED');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('并发上限：上一张没结束时不发第二个请求', async () => {
    let release: (() => void) | null = null;
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => {
      release = () => resolve(responseStub({ data: [{ b64_json: pngBase64(1024, 1024) }] }));
    }));
    const service = new PosterGenerationService();
    const first = service.generate({ prompt: '海报', sessionId: 'x' });
    await expectFailure(service.generate({ prompt: '海报', sessionId: 'y' }), 429, 'POSTER_IMAGE_BUSY');
    release!();
    await expect(first).resolves.toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('只给 url 时下载同源图片；跨域地址直接拒绝', async () => {
    fetchMock.mockResolvedValueOnce(responseStub({ data: [{ url: 'https://images.example.test/files/a.png' }] }));
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      arrayBuffer: async () => pngHeader(1024, 1024),
    } as unknown as Response);
    const service = new PosterGenerationService();
    const result = await service.generate({ prompt: '海报', sessionId: 'u1' });
    expect(result.bytes).toBeGreaterThan(0);

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(responseStub({ data: [{ url: 'https://evil.example.com/a.png' }] }));
    await expectFailure(service.generate({ prompt: '海报', sessionId: 'u2' }), 502, 'POSTER_IMAGE_INVALID');
  });

  it('尺寸白名单与提示词长度都会被校验', async () => {
    const service = new PosterGenerationService();
    await expectFailure(service.generate({ prompt: '海报', size: '64x64', sessionId: 'z' }), 422, 'POSTER_SIZE_INVALID');
    await expectFailure(service.generate({ prompt: '', sessionId: 'z' }), 422, 'POSTER_PROMPT_INVALID');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('status 只暴露是否配置，不泄露密钥', () => {
    const status = new PosterGenerationService().status();
    expect(status.configured).toBe(true);
    expect(status.model).toBe('gpt-image-2.6');
    expect(status.supportedSizes).toContain('1024x1024');
    expect(JSON.stringify(status)).not.toContain('poster-test-key');
  });
});
