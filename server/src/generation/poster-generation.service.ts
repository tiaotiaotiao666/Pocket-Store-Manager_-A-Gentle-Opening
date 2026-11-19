import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AppError } from '../common/http/app-error';
import { normalizePosterPrompt } from './poster-prompt';

/**
 * G1：第三方生图适配器（真实调用，不做任何 Mock 回退）。
 *
 * 已实测（2026-11-19，imagelfk.cc.cd）：
 * - POST {base}/images/generations，Bearer 鉴权；同步返回体里同时给 b64_json 与 url；
 * - 模型名必须精确匹配 /models 返回的 id，例如 `gpt-image-2.6`；
 * - 单张耗时 32~36 秒，响应体 1.5~3.1 MB；
 * - 匿名调用返回 401 invalid_api_key；
 * - 错误模型名会经上游网关直接返回 HTML 502（不是 JSON）。
 *
 * 因此这里做四件事：超时、并发与限流、上游错误映射、响应体积与图片格式校验。
 * 只有校验通过才算成功；任何一步不过都抛错，绝不返回占位图。
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const SUPPORTED_SIZES = Object.freeze(['1024x1024', '1536x1024', '1024x1536']);
const DEFAULT_MODEL = 'gpt-image-2.6';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_EDGE = 4096;
const MIN_IMAGE_EDGE = 256;

export interface PosterGenerationResult {
  mimeType: 'image/png';
  base64: string;
  bytes: number;
  width: number;
  height: number;
  sha256: string;
  provider: string;
  model: string;
  latencyMs: number;
  requestedSize: string;
  usage: { inputTokens: number; outputTokens: number } | null;
}

interface PosterConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxConcurrent: number;
  windowLimit: number;
  windowMs: number;
}

function readConfig(): PosterConfig {
  const clamp = (value: unknown, min: number, max: number, fallback: number): number => {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.min(max, Math.max(min, Math.round(num)));
  };
  return {
    baseUrl: (process.env.IMAGE_API_BASE_URL || '').replace(/\/+$/, ''),
    apiKey: process.env.IMAGE_API_KEY || '',
    // 真实模型名以 /models 校验为准（gpt-image-2.6），环境变量可覆盖但只用于已确认存在的 id。
    model: (process.env.POSTER_IMAGE_MODEL || process.env.IMAGE_MODEL_NAME || DEFAULT_MODEL).trim() || DEFAULT_MODEL,
    timeoutMs: clamp(process.env.POSTER_IMAGE_TIMEOUT_MS || process.env.IMAGE_API_TIMEOUT_MS, 5000, 120_000, 90_000),
    maxConcurrent: clamp(process.env.POSTER_IMAGE_MAX_CONCURRENT, 1, 4, 1),
    windowLimit: clamp(process.env.POSTER_IMAGE_WINDOW_LIMIT, 1, 50, 6),
    windowMs: clamp(process.env.POSTER_IMAGE_WINDOW_MS, 60_000, 3_600_000, 600_000),
  };
}

function readPngSize(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 24) return null;
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  if (width < MIN_IMAGE_EDGE || height < MIN_IMAGE_EDGE) return null;
  if (width > MAX_IMAGE_EDGE || height > MAX_IMAGE_EDGE) return null;
  return { width, height };
}

function invalid(message: string): AppError {
  return new AppError(502, 'POSTER_IMAGE_INVALID', message);
}

@Injectable()
export class PosterGenerationService {
  private readonly logger = new Logger('PosterGeneration');

  private inFlight = 0;

  private readonly windows = new Map<string, number[]>();

  status(): {
    configured: boolean;
    provider: string;
    model: string;
    supportedSizes: readonly string[];
    maxConcurrent: number;
    windowLimit: number;
    windowMs: number;
    timeoutMs: number;
    disclosure: string;
  } {
    const config = readConfig();
    return {
      configured: Boolean(config.baseUrl && config.apiKey),
      provider: process.env.IMAGE_PROVIDER_NAME || 'third-party-image-api',
      model: config.model,
      supportedSizes: SUPPORTED_SIZES,
      maxConcurrent: config.maxConcurrent,
      windowLimit: config.windowLimit,
      windowMs: config.windowMs,
      timeoutMs: config.timeoutMs,
      disclosure: '提示词与文字需求会发送到该第三方生图服务；服务端只保存脱敏摘要，不保存密钥与图片 base64。',
    };
  }

  private requireConfig(): PosterConfig {
    const config = readConfig();
    if (!config.baseUrl || !config.apiKey) {
      throw new AppError(503, 'POSTER_IMAGE_NOT_CONFIGURED', '服务端还没有配置可用的第三方生图服务。');
    }
    return config;
  }

  /** 每个本地会话一个滑动窗口，避免重复点击把额度打穿。 */
  private takeQuota(config: PosterConfig, sessionId: string): void {
    const key = sessionId || 'anonymous';
    const now = Date.now();
    const stamps = (this.windows.get(key) || []).filter((at) => now - at < config.windowMs);
    if (stamps.length >= config.windowLimit) {
      this.windows.set(key, stamps);
      throw new AppError(429, 'POSTER_IMAGE_RATE_LIMITED', '生成太频繁了，请稍后再试。');
    }
    stamps.push(now);
    this.windows.set(key, stamps);
  }

  async generate(input: { prompt?: unknown; size?: unknown; sessionId?: string }): Promise<PosterGenerationResult> {
    const prompt = normalizePosterPrompt(input.prompt);
    if (!prompt) {
      throw new AppError(422, 'POSTER_PROMPT_INVALID', '提示词需要 1 到 1200 个字符，且不能包含控制字符。');
    }
    const size = typeof input.size === 'string' && input.size.trim() ? input.size.trim() : '1024x1024';
    if (!SUPPORTED_SIZES.includes(size)) {
      throw new AppError(422, 'POSTER_SIZE_INVALID', `生图尺寸只支持 ${SUPPORTED_SIZES.join('、')}。`);
    }

    const config = this.requireConfig();
    this.takeQuota(config, String(input.sessionId || ''));
    if (this.inFlight >= config.maxConcurrent) {
      throw new AppError(429, 'POSTER_IMAGE_BUSY', '上一张还在生成，请等它结束再试。');
    }

    this.inFlight += 1;
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const response = await fetch(`${config.baseUrl}/images/generations`, {
        method: 'POST',
        signal: controller.signal,
        headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: config.model,
          prompt,
          size,
          n: 1,
          response_format: 'b64_json',
          quality: 'low',
        }),
      });
      const latencyMs = Date.now() - startedAt;
      const raw = await response.text();
      const payload = safeJson(raw);

      if (!response.ok) {
        this.logger.warn(`upstream status=${response.status} model=${config.model} ms=${latencyMs} json=${payload ? 'yes' : 'no'}`);
        throw mapUpstreamError(response.status, payload);
      }
      if (!payload) throw invalid('生图服务返回了无法解析的内容。');

      const item = Array.isArray(payload.data) ? payload.data[0] : null;
      const base64 = await this.resolveImageBase64(item, controller.signal, config.baseUrl);
      const buffer = decodeBase64(base64);
      const dimensions = readPngSize(buffer);
      if (!dimensions) throw invalid('生图服务返回的不是有效的 PNG 图片。');

      const sha256 = createHash('sha256').update(buffer).digest('hex');
      const usageRecord = payload.usage && typeof payload.usage === 'object'
        ? payload.usage as { input_tokens?: unknown; output_tokens?: unknown }
        : null;
      const usage = usageRecord
        ? {
          inputTokens: Number(usageRecord.input_tokens) || 0,
          outputTokens: Number(usageRecord.output_tokens) || 0,
        }
        : null;

      this.logger.log(`ok model=${config.model} size=${size} actual=${dimensions.width}x${dimensions.height} bytes=${buffer.length} ms=${latencyMs}`);

      return {
        mimeType: 'image/png',
        base64,
        bytes: buffer.length,
        width: dimensions.width,
        height: dimensions.height,
        sha256,
        provider: process.env.IMAGE_PROVIDER_NAME || 'third-party-image-api',
        model: config.model,
        latencyMs,
        requestedSize: size,
        usage,
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error && (error as { name?: string }).name === 'AbortError') {
        throw new AppError(504, 'POSTER_IMAGE_TIMEOUT', '生图服务响应超时，请稍后重试。');
      }
      this.logger.warn(`failed model=${config.model} ms=${Date.now() - startedAt}`);
      throw new AppError(502, 'POSTER_IMAGE_UNAVAILABLE', '暂时无法连接生图服务，请稍后重试。');
    } finally {
      clearTimeout(timer);
      this.inFlight -= 1;
    }
  }

  /** 上游同时会给 b64_json 与 url；优先用 base64，只有给 url 时才去下载（带上限）。 */
  private async resolveImageBase64(item: unknown, signal: AbortSignal, baseUrl: string): Promise<string> {
    const record = (item || {}) as { b64_json?: unknown; url?: unknown };
    if (typeof record.b64_json === 'string' && record.b64_json.trim()) {
      const value = record.b64_json.trim();
      // 约 5 MB 图片的 base64 长度上限，先挡住明显超限的响应再解码。
      if (value.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw invalid('生图服务返回的图片超过体积上限。');
      if (!BASE64_RE.test(value)) throw invalid('生图服务返回的图片数据格式不正确。');
      return value;
    }
    if (typeof record.url === 'string' && /^https:\/\//i.test(record.url)) {
      // 只接受与配置端点同源的图片地址，避免被上游带去任意主机取图。
      const origin = new URL(baseUrl).origin;
      if (new URL(record.url).origin !== origin) throw invalid('生图服务返回了不在预期域名下的图片地址。');
      const downloaded = await fetch(record.url, { signal });
      if (!downloaded.ok) throw invalid('生图服务返回的图片无法下载。');
      const buffer = Buffer.from(await downloaded.arrayBuffer());
      if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) throw invalid('生图服务返回的图片超过体积上限。');
      return buffer.toString('base64');
    }
    throw invalid('生图服务没有返回图片数据。');
  }
}

function safeJson(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch (error) {
    return null;
  }
}

function decodeBase64(value: string): Buffer {
  const buffer = Buffer.from(value, 'base64');
  if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) throw invalid('生图服务返回的图片超过体积上限。');
  return buffer;
}

/**
 * 上游错误映射。注意 502 可能是网关 HTML 页（模型名不存在时就是这种），
 * 所以这里不区分“上游说自己错”还是“网关挡下来”，一律给可读、可重试的提示。
 */
function mapUpstreamError(status: number, payload: Record<string, unknown> | null): AppError {
  const upstreamCode = payload && payload.error && typeof payload.error === 'object'
    ? String((payload.error as { code?: unknown }).code || '')
    : '';
  if (status === 401 || status === 403 || upstreamCode === 'invalid_api_key') {
    return new AppError(503, 'POSTER_IMAGE_AUTH_FAILED', '生图服务鉴权失败，请检查服务端密钥配置。');
  }
  if (status === 429) {
    return new AppError(429, 'POSTER_IMAGE_RATE_LIMITED', '生图服务限流，请稍后再试。');
  }
  if (status === 400 || status === 422) {
    return new AppError(422, 'POSTER_IMAGE_REJECTED', '生图服务拒绝了这次请求，请调整提示词后重试。');
  }
  return new AppError(502, 'POSTER_IMAGE_UNAVAILABLE', '生图服务暂时不可用，请稍后重试。');
}
