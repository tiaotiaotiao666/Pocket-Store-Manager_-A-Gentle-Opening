import { HttpException, Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { AgentService } from '../src/agent/agent.service';
import {
  SCREEN_REFERENCE_CONTRACT_VERSION,
  buildScreenReferenceUtterance,
  parseScreenReferenceRequest,
  validateScreenReferenceRecognition,
} from '../src/agent/screen-reference';
import type { AgentProvider } from '../src/agent/provider/agent-provider.interface';

/**
 * screen-reference.v1（P3）后端测试。
 *
 * 约束：
 * - 模型调用一律走 stub Provider，绝不真实访问 DeepSeek；
 * - 断言「白名单裁剪」「视觉不可用不编造」「日志不含图片数据」；
 * - 断言参考截图不能与门店照/菜单照混发。
 */

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/wF9HQAAAABJRU5ErkJggg==';

const CATALOG = {
  version: '2026.11.0',
  recipeIds: ['order-classic', 'order-poster'],
  featureIds: ['scan-order', 'product-catalog', 'cart-checkout', 'store-gallery'],
  themeKeys: ['primaryColor', 'pageBackground', 'accentColor'],
};

function makeRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: SCREEN_REFERENCE_CONTRACT_VERSION,
    utterance: '参考截图分析',
    draft: {
      storeName: '',
      category: '',
      businessHours: '',
      fulfillment: { dineIn: false, takeaway: false },
      dishes: [],
    },
    client: { surface: 'desktop', phase: 'store-info' },
    projectId: null,
    catalog: CATALOG,
    catalogVersion: '2026.11.0',
    images: [{ kind: 'reference', mediaType: 'image/png', dataBase64: PNG_BASE64 }],
    ...overrides,
  };
}

function captureRejection(fn: () => unknown): { status: number; code: string } {
  try {
    fn();
  } catch (error) {
    if (error instanceof HttpException) {
      const body = error.getResponse() as { code?: string };
      return { status: error.getStatus(), code: body.code ?? '' };
    }
    throw error;
  }
  throw new Error('期望抛出 HttpException，但函数正常返回');
}

function stubProvider(result: Partial<{ draftPatch: unknown; visionAnalyzed: boolean; reply: string }>): AgentProvider {
  return {
    name: 'stub',
    async extractTurn() {
      return {
        reply: result.reply ?? '',
        draftPatch: result.draftPatch ?? {},
        model: 'stub-model',
        latencyMs: 12,
        visionAnalyzed: result.visionAnalyzed === true,
      };
    },
  };
}

describe('screen-reference.v1 请求校验', () => {
  it('S1 接受「恰好一张参考截图 + 白名单目录」的合法请求', () => {
    const parsed = parseScreenReferenceRequest(makeRequest());
    expect(parsed.images.referenceImages).toBe(1);
    expect(parsed.images.images[0].kind).toBe('reference');
    expect(parsed.catalog.recipeIds).toEqual(['order-classic', 'order-poster']);
    expect(parsed.catalog.featureIds).toContain('scan-order');
  });

  it('S2 未知顶层字段整包拒绝（400 AGENT_REQUEST_INVALID）', () => {
    const outcome = captureRejection(() =>
      parseScreenReferenceRequest(makeRequest({ script: 'eval("x")' })),
    );
    expect(outcome.status).toBe(400);
    expect(outcome.code).toBe('AGENT_REQUEST_INVALID');
  });

  it('S3 contractVersion 不匹配直接拒绝，不静默降级到 v1', () => {
    const outcome = captureRejection(() =>
      parseScreenReferenceRequest(makeRequest({ contractVersion: 'agent-turn.v2' })),
    );
    expect(outcome.status).toBe(400);
    expect(outcome.code).toBe('AGENT_REQUEST_INVALID');
  });

  it('S4 缺少 catalog 拒绝（没有白名单就不做识别）', () => {
    const body = makeRequest();
    delete (body as Record<string, unknown>).catalog;
    const outcome = captureRejection(() => parseScreenReferenceRequest(body));
    expect(outcome.code).toBe('AGENT_REQUEST_INVALID');
  });

  it('S5 参考截图与门店照混发直接拒绝', () => {
    const outcome = captureRejection(() =>
      parseScreenReferenceRequest(makeRequest({
        images: [
          { kind: 'reference', mediaType: 'image/png', dataBase64: PNG_BASE64 },
          { kind: 'menu', mediaType: 'image/png', dataBase64: PNG_BASE64 },
        ],
      })),
    );
    expect(outcome.status).toBe(400);
    expect(outcome.code).toBe('AGENT_IMAGE_KIND_MIXED');
  });

  it('S6 两张参考截图超过上限被拒（422 AGENT_IMAGE_COUNT_EXCEEDED）', () => {
    const outcome = captureRejection(() =>
      parseScreenReferenceRequest(makeRequest({
        images: [
          { kind: 'reference', mediaType: 'image/png', dataBase64: PNG_BASE64 },
          { kind: 'reference', mediaType: 'image/png', dataBase64: PNG_BASE64 },
        ],
      })),
    );
    expect(outcome.status).toBe(422);
    expect(outcome.code).toBe('AGENT_IMAGE_COUNT_EXCEEDED');
  });
});

describe('screen-reference.v1 识别结果白名单裁剪', () => {
  it('S7 只保留白名单 id，未知 id / 非法颜色进 rejected', () => {
    const { recognition, rejected } = validateScreenReferenceRecognition(
      {
        layouts: ['order-poster', 'video-fullscreen'],
        components: ['store-gallery', 'live-stream', 'scan-order'],
        style: {
          theme: { primaryColor: '#ff5500', brandGradient: 'linear-gradient(red,blue)', accentColor: 'red' },
          sizes: { homeHero: 'lg', poster: 'xl' },
        },
        approximate: [{ id: 'video-hero', reason: '用静态海报近似' }],
        unsupported: [{ id: 'live-stream', reason: '没有直播组件' }],
        notes: '参考截图分析结果',
      },
      CATALOG,
    );

    expect(recognition.layouts).toEqual(['order-poster']);
    expect(recognition.components).toEqual(['store-gallery', 'scan-order']);
    expect(recognition.style.theme).toEqual({ primaryColor: '#FF5500' });
    expect(recognition.style.sizes).toEqual({ homeHero: 'lg' });
    expect(rejected.map((item) => item.id)).toEqual(
      expect.arrayContaining(['video-fullscreen', 'live-stream', 'theme.brandGradient', 'sizes.poster']),
    );
    // 非法颜色不能悄悄改成默认色
    expect(recognition.style.theme.accentColor).toBeUndefined();
  });

  it('S8 模型返回完全不在契约里的结构 → 记一条 recognition rejected，不产出可用 id', () => {
    const { recognition, rejected } = validateScreenReferenceRecognition(
      { storeName: '别人的店', dishes: [{ name: '牛肉面', price: 20 }] },
      CATALOG,
    );
    expect(recognition.layouts).toEqual([]);
    expect(recognition.components).toEqual([]);
    expect(rejected.some((item) => item.source === 'recognition')).toBe(true);
  });
});

describe('screen-reference.v1 服务端编排', () => {
  it('S9 有视觉能力时返回 status=ok 与裁剪后的识别结果', async () => {
    const service = new AgentService(
      stubProvider({
        visionAnalyzed: true,
        draftPatch: {
          layouts: ['order-poster'],
          components: ['scan-order', 'unknown-widget'],
          style: { theme: { primaryColor: '#123456' } },
          unsupported: [{ id: 'live-stream', reason: '没有直播组件' }],
        },
      }),
    );
    const response = await service.handleTurn(makeRequest(), { requestId: 'req_sr_ok' });
    expect(response.contractVersion).toBe(SCREEN_REFERENCE_CONTRACT_VERSION);
    expect((response as { status: string }).status).toBe('ok');
    const recognition = (response as { recognition: { components: string[] } }).recognition;
    expect(recognition.components).toEqual(['scan-order']);
    expect((response as { meta: { analyzed: boolean } }).meta.analyzed).toBe(true);
  });

  it('S10 视觉不可用时返回 unavailable，且不编造任何识别结果', async () => {
    const service = new AgentService(
      stubProvider({ visionAnalyzed: false, draftPatch: { layouts: ['order-poster'] } }),
    );
    const response = await service.handleTurn(makeRequest(), { requestId: 'req_sr_unavailable' });
    expect((response as { status: string }).status).toBe('unavailable');
    expect((response as { recognition: unknown }).recognition).toBeNull();
    expect((response as { meta: { analyzed: boolean } }).meta.analyzed).toBe(false);
  });

  it('S11 日志只含计数，不含 base64 与 API Key', async () => {
    const lines: string[] = [];
    const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => {
      lines.push(String(message));
    });
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => {
      lines.push(String(message));
    });
    try {
      const service = new AgentService(stubProvider({ visionAnalyzed: true, draftPatch: { components: ['scan-order'] } }));
      await service.handleTurn(makeRequest(), { requestId: 'req_sr_log' });
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    }
    const joined = lines.join('\n');
    expect(joined).toContain('screen-reference ok');
    expect(joined).not.toContain(PNG_BASE64.slice(0, 24));
    expect(joined).not.toMatch(/sk-[A-Za-z0-9]/);
  });

  it('S12 提示词只暴露白名单 id，并明确禁止输出代码', () => {
    const utterance = buildScreenReferenceUtterance(CATALOG);
    expect(utterance).toContain('order-poster');
    expect(utterance).toContain('scan-order');
    expect(utterance).toContain('primaryColor');
    expect(utterance).toContain('不要输出任何代码');
  });
});
