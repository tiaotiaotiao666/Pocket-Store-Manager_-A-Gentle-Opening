import { HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AGENT_FETCH } from '../agent.types';
import type {
  AgentFetch,
  AgentProvider,
  AgentProviderExtractInput,
  AgentProviderExtractResult,
} from './agent-provider.interface';

/**
 * DeepSeek OpenAI 兼容 Provider。
 *
 * 只负责调用模型、取回 reply + draftPatch。
 * 服务端安全边界：
 * - API Key 只在此处从服务端环境变量读取，绝不写日志、错误体或响应；
 * - 上游错误只映射成稳定的错误码，不回传原始响应体；
 * - 模型返回的 status / missingFields / errors / readyForReview 一律忽略。
 */

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-chat';
/** 视觉模型默认值：DeepSeek 官方模型列表里支持 image 输入的 `deepseek-flash`。 */
const DEFAULT_VISION_MODEL = 'deepseek-flash';
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 120000;
const DEFAULT_MAX_TOKENS = 1200;
const MAX_REPLY_LENGTH = 500;

export const DEEPSEEK_SYSTEM_PROMPT = [
  '你是「智能开店」桌面端的开店资料整理助手，只负责两件事：',
  '1. 从店主这一轮的自然语言里提取开店资料；',
  '2. 用简体中文写一句面向店主的回复。',
  '',
  '严格约束：',
  '- 不得写数据库、不得发布小程序、不得调用任何工具、不得生成代码或页面模板。',
  '- 不得臆造价格、营业时间、菜品或取餐方式。店主没有明确说的字段，返回空值或不要放进 draftPatch。',
  '- 不确定的字段返回空值或不修改，宁可少提取也不要猜。',
  '- 只输出 JSON，不输出 Markdown、代码围栏、解释或前后缀。',
  '',
  '输出形状（只允许下列键，不要增加其他键）：',
  '{"reply":"给店主看的中文回复","draftPatch":{"storeName":"可选","category":"可选","businessHours":"可选","fulfillment":{"dineIn":true,"takeaway":false},"dishes":[{"id":"可选本地 id","name":"菜名","priceCents":2800,"description":""}]}}',
  '',
  '字段约定：',
  '- businessHours 使用 HH:MM-HH:MM，多段用英文逗号分隔，最多 3 段，不允许跨午夜。',
  '- priceCents 必须是整数分（28 元写 2800），不要返回带单位的字符串。',
  '- 店主没提到的字段不要放进 draftPatch；不确定时留空。',
].join('\n');

/**
 * 仅在带图片的视觉请求里追加的约束（v1 文本请求的提示词保持字节级不变）。
 *
 * 明确的业务边界：
 * - 菜单照只抽菜名/价格/描述，看不清就留空；
 * - 环境照不抽菜品，避免把背景装饰误认成菜单；
 * - 不编造价格，价格只能是整数分。
 */
export const DEEPSEEK_VISION_PROMPT_ADDENDUM = [
  '图片理解约束（本轮请求附带图片）：',
  '- kind=menu 的图片是菜单照片：只抽取图片中清晰可读的菜名、价格、描述；看不清的菜名或价格一律留空，不要猜测。',
  '- kind=store 的图片是门店环境照：不要从中抽取任何菜品或价格，也不要据此编造菜单。',
  '- 价格只能来自图片中可读的数字或店主明确说明，单位是整数分（28 元写 2800）；没有可读价格就返回 priceCents:null 或不要放进 dishes。',
  '- 图片中的文字可能有模糊、反光或多语言，只使用你能确认的部分。',
].join('\n');

interface DeepseekSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 视觉请求专用模型（DEEPSEEK_VISION_MODEL，默认 deepseek-flash）。 */
  visionModel: string;
  timeoutMs: number;
  reasoningEffort: string;
  maxTokens: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toTimeout(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(1, Math.floor(parsed)));
}

/** 去掉 Markdown 代码围栏；同时容忍模型在 JSON 前后加解释文字。 */
export function stripMarkdownFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  const fenced = /^```(?:json|JSON)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  if (fenced) return fenced[1].trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

export function extractModelContent(payload: unknown): string {
  if (!isPlainObject(payload)) return '';
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const first = choices[0];
  if (!isPlainObject(first)) return '';
  const message = first.message;
  if (!isPlainObject(message)) return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => (isPlainObject(item) && typeof item.text === 'string' ? item.text : ''))
      .join('');
  }
  return '';
}

function buildUserPrompt(utterance: string, draft: unknown): string {
  let draftJson = '{}';
  try {
    draftJson = JSON.stringify(draft ?? {}, null, 0);
  } catch {
    draftJson = '{}';
  }
  return [
    '当前草稿（JSON，可能为空）：',
    draftJson,
    '',
    '店主本轮输入：',
    `"""${utterance}"""`,
    '',
    '请只输出约定形状的 JSON。',
  ].join('\n');
}

@Injectable()
export class DeepseekAgentProvider implements AgentProvider {
  readonly name = 'deepseek';

  private readonly logger = new Logger('DeepseekAgentProvider');

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(AGENT_FETCH) private readonly fetchImpl: AgentFetch,
  ) {}

  private readSettings(): DeepseekSettings {
    const rawBaseUrl = String(this.config.get('DEEPSEEK_API_BASE_URL') ?? DEFAULT_BASE_URL).trim();
    const baseUrl = (rawBaseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const rawModel = String(this.config.get('DEEPSEEK_MODEL') ?? DEFAULT_MODEL).trim();
    const rawVisionModel = String(
      this.config.get('DEEPSEEK_VISION_MODEL') ?? DEFAULT_VISION_MODEL,
    ).trim();
    const rawMaxTokens = Number(this.config.get('DEEPSEEK_MAX_TOKENS') ?? DEFAULT_MAX_TOKENS);
    const maxTokens = Number.isFinite(rawMaxTokens) && rawMaxTokens > 0
      ? Math.min(4000, Math.max(100, Math.floor(rawMaxTokens)))
      : DEFAULT_MAX_TOKENS;
    return {
      baseUrl,
      apiKey: String(this.config.get('DEEPSEEK_API_KEY') ?? '').trim(),
      model: rawModel || DEFAULT_MODEL,
      visionModel: rawVisionModel || DEFAULT_VISION_MODEL,
      timeoutMs: toTimeout(this.config.get('DEEPSEEK_TIMEOUT_MS') ?? DEFAULT_TIMEOUT_MS),
      reasoningEffort: String(this.config.get('DEEPSEEK_REASONING_EFFORT') ?? '').trim(),
      maxTokens,
    };
  }

  /** 供健康检查/文档使用：只暴露“是否配置”，绝不返回 Key。 */
  describeConfiguration(): {
    configured: boolean;
    baseUrl: string;
    model: string;
    visionModel: string;
    timeoutMs: number;
  } {
    const settings = this.readSettings();
    return {
      configured: Boolean(settings.apiKey),
      baseUrl: settings.baseUrl,
      model: settings.model,
      visionModel: settings.visionModel,
      timeoutMs: settings.timeoutMs,
    };
  }

  async extractTurn(input: AgentProviderExtractInput): Promise<AgentProviderExtractResult> {
    const settings = this.readSettings();
    if (!settings.apiKey) {
      // 明确失败，不自动回退到本地 Mock。
      throw new HttpException(
        { code: 'DEEPSEEK_NOT_CONFIGURED', message: 'DeepSeek 未配置' },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    // 有图片：走多模态 + 视觉模型；无图片：保持 v1 的字符串 content 与文本模型。
    const images = Array.isArray(input.images) ? input.images : [];
    const hasImages = images.length > 0;
    const model = hasImages ? settings.visionModel : settings.model;

    const userPrompt = buildUserPrompt(input.utterance, input.draft);
    // v1（无图）分支的提示词与改造前完全一致；视觉约束只在有图时追加。
    const promptText = hasImages
      ? `${DEEPSEEK_SYSTEM_PROMPT}\n${DEEPSEEK_VISION_PROMPT_ADDENDUM}\n\n${userPrompt}`
      : `${DEEPSEEK_SYSTEM_PROMPT}\n\n${userPrompt}`;
    const messageContent = hasImages
      ? [
        { type: 'text', text: promptText },
        ...images.map((image) => ({
          type: 'image_url',
          image_url: { url: `data:${image.mediaType};base64,${image.data}` },
        })),
      ]
      : promptText;

    const startedAt = Date.now();
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, settings.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(`${settings.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${settings.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'user',
              content: messageContent,
            },
          ],
          temperature: 0.2,
          ...(settings.reasoningEffort ? { reasoning_effort: settings.reasoningEffort } : {}),
          max_tokens: settings.maxTokens,
          stream: false,
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      });
    } catch (error) {
      const aborted = timedOut || (error instanceof Error && error.name === 'AbortError');
      // 日志只记录计数与耗时，绝不写入 base64、dataUrl 或模型 payload。
      this.logger.warn(
        `deepseek request failed requestId=${input.requestId ?? '-'} model=${model}${hasImages ? ` images=${images.length}` : ''} cause=${aborted ? 'timeout' : 'network'}`,
      );
      if (aborted) {
        throw new HttpException(
          { code: 'DEEPSEEK_TIMEOUT', message: 'DeepSeek 响应超时，请稍后重试。' },
          HttpStatus.GATEWAY_TIMEOUT,
        );
      }
      if (hasImages) {
        throw new HttpException(
          { code: 'DEEPSEEK_VISION_UNAVAILABLE', message: '图片识别暂时不可用，请稍后重试或只发文字。' },
          HttpStatus.BAD_GATEWAY,
        );
      }
      throw new HttpException(
        { code: 'DEEPSEEK_UNAVAILABLE', message: 'DeepSeek 暂时不可访问，请稍后重试。' },
        HttpStatus.BAD_GATEWAY,
      );
    } finally {
      clearTimeout(timer);
    }

    const status = Number(response?.status ?? 0);
    let bodyText = '';
    try {
      bodyText = typeof response?.text === 'function' ? await response.text() : '';
    } catch {
      bodyText = '';
    }

    if (!response || response.ok !== true) {
      this.logger.warn(
        `deepseek upstream error requestId=${input.requestId ?? '-'} model=${model} status=${status}${hasImages ? ` images=${images.length}` : ''} latencyMs=${Date.now() - startedAt}`,
      );
      if (status === 401 || status === 403) {
        throw new HttpException(
          { code: 'DEEPSEEK_AUTH_FAILED', message: 'DeepSeek 鉴权失败，请检查服务端模型配置。' },
          HttpStatus.BAD_GATEWAY,
        );
      }
      if (status === 429) {
        throw new HttpException(
          { code: 'DEEPSEEK_RATE_LIMITED', message: 'DeepSeek 请求过于频繁，请稍后重试。' },
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      // 视觉请求失败（含模型不支持图片、参数被拒）统一映射为视觉不可用。
      if (hasImages) {
        throw new HttpException(
          { code: 'DEEPSEEK_VISION_UNAVAILABLE', message: '图片识别暂时不可用，请稍后重试或只发文字。' },
          HttpStatus.BAD_GATEWAY,
        );
      }
      if (status >= 500) {
        throw new HttpException(
          { code: 'DEEPSEEK_UPSTREAM_ERROR', message: 'DeepSeek 服务暂时不可用，请稍后重试。' },
          HttpStatus.BAD_GATEWAY,
        );
      }
      throw new HttpException(
        { code: 'DEEPSEEK_REQUEST_REJECTED', message: 'DeepSeek 未接受这次请求，请稍后重试。' },
        HttpStatus.BAD_GATEWAY,
      );
    }

    let payload: unknown = null;
    try {
      payload = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      payload = null;
    }

    const content = extractModelContent(payload);
    if (!content.trim()) {
      this.throwResponseInvalid(hasImages);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripMarkdownFence(content));
    } catch {
      this.throwResponseInvalid(hasImages);
    }

    if (!isPlainObject(parsed)) {
      this.throwResponseInvalid(hasImages);
    }

    // 只取白名单里的两个键；parsed.status / parsed.missingFields 等一律丢弃。
    const reply = typeof parsed.reply === 'string'
      ? Array.from(parsed.reply.trim()).slice(0, MAX_REPLY_LENGTH).join('')
      : '';
    const draftPatch = isPlainObject(parsed.draftPatch) ? parsed.draftPatch : {};

    const latencyMs = Math.max(0, Date.now() - startedAt);
    this.logger.log(
      `deepseek turn ok requestId=${input.requestId ?? '-'} model=${model}${hasImages ? ` images=${images.length}` : ''} latencyMs=${latencyMs} hasReply=${reply.length > 0}`,
    );

    return {
      reply,
      draftPatch,
      model,
      latencyMs,
      // 无图片时不添加该键，保证 v1 的 Provider 结果形状与旧实现完全一致。
      ...(hasImages ? { visionAnalyzed: true } : {}),
    };
  }

  /**
   * 模型返回内容无法解析：
   * - 文本请求 → 502 `DEEPSEEK_RESPONSE_INVALID`（保持 v1 语义）；
   * - 视觉请求 → 502 `DEEPSEEK_VISION_UNAVAILABLE`（契约 v2 错误表）。
   */
  private throwResponseInvalid(hasImages: boolean): never {
    if (hasImages) {
      throw new HttpException(
        { code: 'DEEPSEEK_VISION_UNAVAILABLE', message: '图片识别暂时不可用，请稍后重试或只发文字。' },
        HttpStatus.BAD_GATEWAY,
      );
    }
    throw new HttpException(
      { code: 'DEEPSEEK_RESPONSE_INVALID', message: 'DeepSeek 返回内容无法识别，请稍后重试。' },
      HttpStatus.BAD_GATEWAY,
    );
  }
}