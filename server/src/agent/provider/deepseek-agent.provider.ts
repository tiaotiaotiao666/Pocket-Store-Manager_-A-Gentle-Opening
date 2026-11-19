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
/**
 * 视觉请求的 max_tokens 下限。
 * 推理型视觉模型会把输出预算先花在内部思考上，实测 max_tokens=160 时返回
 * finish_reason=length 且 content 为空串，上层只能看到「识别失败」。
 */
const VISION_MIN_MAX_TOKENS = 2000;
/** 视觉请求最多尝试次数（上游 5xx/429、空回复、半截 JSON 时可再要一次）。 */
const VISION_MAX_ATTEMPTS = 2;
/** 参考截图的识别结果键：模型写在顶层时折叠进 draftPatch。 */
const REFERENCE_TOP_LEVEL_KEYS: readonly string[] = Object.freeze([
  'layouts',
  'components',
  'style',
  'approximate',
  'unsupported',
  'notes',
]);
const MAX_REPLY_LENGTH = 500;

export const DEEPSEEK_SYSTEM_PROMPT = [
  '你是「口袋店长·轻启」桌面端的开店资料整理助手，只负责两件事：',
  '1. 从店主这一轮的自然语言里提取开店资料；',
  '2. 用简体中文写一句面向店主的回复。',
  '',
  '严格约束：',
  '- 不得写数据库、不得发布小程序、不得调用任何工具、不得生成代码或页面模板。',
  '- 不得臆造价格、营业时间、菜品或取餐方式。店主没有明确说的字段，返回空值或不要放进 draftPatch。例外：店主明确授权你代拟（如“随便填”“你定”“给点建议”“帮我定价”）时，可代填常见菜名与常见价位（整数分），并在 reply 里点明是建议值。',
  '- dishes[].description 可以代写，最多 60 字，只写口味、做法、口感；不得使用“最”“第一”“纯天然”“零添加”“养生”“治疗”等绝对化或功效性表述，不得编造产地或获奖荣誉。',
  '- 除上述两条例外，不确定的字段返回空值或不修改，宁可少提取也不要猜。',
  '- 只输出 JSON，不输出 Markdown、代码围栏、解释或前后缀。',
  '',
  '输出形状（只允许下列键，不要增加其他键）：',
  '{"reply":"给店主看的中文回复","draftPatch":{"storeName":"可选","category":"可选","businessHours":"可选","fulfillment":{"dineIn":true,"takeaway":false},"dishes":[{"id":"可选本地 id","name":"菜名","priceCents":2800,"description":""}]}}',
  '',
  '字段约定：',
  '- businessHours 使用 HH:MM-HH:MM，多段用英文逗号分隔，最多 3 段，不允许跨午夜。',
  '- priceCents 必须是整数分（28 元写 2800），不要返回带单位的字符串。',
  '- 店主没提到的字段不要放进 draftPatch；不确定时留空（description 与“店主明确授权代拟”的情形除外，见上）。',
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

/**
 * `kind=reference`（别人的小程序首页截图）专用的输出契约。
 *
 * 背景（P5b）：`screen-reference.v1` 的 utterance 要求模型把 layouts/components/style
 * 放在**顶层**，但本 Provider 只白名单透出 `reply` 与 `draftPatch`，而服务端又是从
 * `draftPatch` 里读识别结果 —— 于是模型答对了也会被裁成空，界面显示「没能完成识别」。
 * 这里把识别结果的形状固定写进 draftPatch，保证两侧契约一致。
 */
export const DEEPSEEK_REFERENCE_PROMPT_ADDENDUM = [
  '本轮附加了一张参考截图（kind=reference）：这是别人小程序的首页截图，只借鉴布局与组件组合。',
  '禁止：复制对方源码、文案、品牌名、Logo、插画或配色方案；不要输出任何代码或 WXML/WXSS。',
  '',
  '输出形状（必须全部放在 draftPatch 里，键名逐字一致）：',
  '{"reply":"给店主看的一句中文说明","draftPatch":{"layouts":["布局 id"],"components":["组件 id"],"style":{"theme":{"主题色键":"#RRGGBB"},"sizes":{"homeHero":"sm|md|lg","productCard":"sm|md|lg","carousel":"sm|md|lg"}},"approximate":[{"id":"id","reason":"为什么只能近似"}],"unsupported":[{"id":"能力名","reason":"为什么做不到"}],"notes":"一句话总结"}}',
  '',
  '规则：',
  '- layouts / components 只能取店主消息里列出的 id，绝不新造 id；一个都匹配不上就返回空数组。',
  '- style.theme 只能用给定的主题色键，值必须是 #RRGGBB；sizes 只能是 sm/md/lg。',
  '- 截图里有但现有组件表达不了的部分放 unsupported；能对上但只能近似的放 approximate。',
  '- draftPatch 里不要放店名、菜品、价格等开店资料字段。',
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
    // 参考截图（kind=reference）走独立的输出契约：识别结果必须落在 draftPatch 里。
    const hasReference = images.some((image) => image.kind === 'reference');
    const visionAddendum = hasReference
      ? DEEPSEEK_REFERENCE_PROMPT_ADDENDUM
      : DEEPSEEK_VISION_PROMPT_ADDENDUM;
    // v1（无图）分支的提示词与改造前完全一致；视觉约束只在有图时追加。
    const promptText = hasImages
      ? `${DEEPSEEK_SYSTEM_PROMPT}\n${visionAddendum}\n\n${userPrompt}`
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
    // 视觉请求用独立预算：推理型模型会先花 token 思考，max_tokens 太小会出现
    // finish_reason=length 且 content 为空（P5b 实测复现）。
    const maxTokens = hasImages
      ? Math.max(settings.maxTokens, VISION_MIN_MAX_TOKENS)
      : settings.maxTokens;
    const requestBody: Record<string, unknown> = {
      model,
      messages: [
        {
          role: 'user',
          content: messageContent,
        },
      ],
      temperature: 0.2,
      ...(settings.reasoningEffort ? { reasoning_effort: settings.reasoningEffort } : {}),
      max_tokens: maxTokens,
      stream: false,
      response_format: { type: 'json_object' },
    };

    // 视觉请求允许一次重试：上游偶发 5xx/429、空回复或半截 JSON 都值得再要一次。
    // 文本请求保持单次，v1 语义不变。
    const maxAttempts = hasImages ? VISION_MAX_ATTEMPTS : 1;
    let parsed: unknown = null;
    let lastCause = 'unknown';

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const outcome = await this.callCompletion(
        requestBody,
        settings,
        input.requestId,
        model,
        hasImages ? images.length : 0,
        startedAt,
      );
      if (!outcome.ok) {
        lastCause = outcome.failure;
        if (outcome.retryable && attempt < maxAttempts) {
          this.logger.warn(
            `deepseek vision retry requestId=${input.requestId ?? '-'} model=${model} attempt=${attempt} cause=${lastCause}`,
          );
          continue;
        }
        throw this.toHttpException(lastCause, hasImages);
      }

      const content = extractModelContent(outcome.payload);
      if (!content.trim()) {
        // 模型没吐出正文，多半是推理占满了输出预算（finish_reason=length）。
        lastCause = outcome.finishReason === 'length' ? 'empty_content_truncated' : 'empty_content';
        if (attempt < maxAttempts) {
          this.logger.warn(
            `deepseek vision retry requestId=${input.requestId ?? '-'} model=${model} attempt=${attempt} cause=${lastCause} maxTokens=${maxTokens}`,
          );
          continue;
        }
        throw this.toHttpException(lastCause, hasImages);
      }

      let candidate: unknown;
      try {
        candidate = JSON.parse(stripMarkdownFence(content));
      } catch {
        lastCause = 'invalid_json';
        if (attempt < maxAttempts) {
          this.logger.warn(
            `deepseek vision retry requestId=${input.requestId ?? '-'} model=${model} attempt=${attempt} cause=${lastCause} contentLen=${content.length}`,
          );
          continue;
        }
        throw this.toHttpException(lastCause, hasImages);
      }

      if (!isPlainObject(candidate)) {
        lastCause = 'invalid_shape';
        if (attempt < maxAttempts) {
          this.logger.warn(
            `deepseek vision retry requestId=${input.requestId ?? '-'} model=${model} attempt=${attempt} cause=${lastCause}`,
          );
          continue;
        }
        throw this.toHttpException(lastCause, hasImages);
      }

      parsed = candidate;
      break;
    }

    if (!isPlainObject(parsed)) {
      // 循环内必然已抛出，这里只用于类型收窄。
      throw this.toHttpException(lastCause, hasImages);
    }

    // 只取白名单里的两个键；parsed.status / parsed.missingFields 等一律丢弃。
    const reply = typeof parsed.reply === 'string'
      ? Array.from(parsed.reply.trim()).slice(0, MAX_REPLY_LENGTH).join('')
      : '';
    // 参考截图时容忍模型把识别结果写在顶层（它是 utterance 里要求的形状）：
    // 折叠进 draftPatch，后续仍要过 catalog 白名单裁剪，不会放行未知 id。
    const draftPatch = isPlainObject(parsed.draftPatch) ? { ...parsed.draftPatch } : {};
    if (hasReference) {
      for (const key of REFERENCE_TOP_LEVEL_KEYS) {
        if (!(key in draftPatch) && parsed[key] !== undefined) {
          draftPatch[key] = parsed[key];
        }
      }
    }

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
   * 发一次 /chat/completions。
   * 只回传判定所需的最小信息（状态、失败原因、finish_reason），
   * 绝不把 base64、dataUrl 或完整 payload 写进日志或异常。
   */
  private async callCompletion(
    requestBody: Record<string, unknown>,
    settings: DeepseekSettings,
    requestId: string | undefined,
    model: string,
    imageCount: number,
    startedAt: number,
  ): Promise<
    | { ok: true; payload: unknown; finishReason: string }
    | { ok: false; failure: string; retryable: boolean }
  > {
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
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
    } catch (error) {
      const aborted = timedOut || (error instanceof Error && error.name === 'AbortError');
      this.logger.warn(
        `deepseek request failed requestId=${requestId ?? '-'} model=${model}${imageCount > 0 ? ` images=${imageCount}` : ''} cause=${aborted ? 'timeout' : 'network'} latencyMs=${Date.now() - startedAt}`,
      );
      // 超时与网络错误不再重试：让调用方立刻拿到 504/502，避免把用户等待翻倍。
      return { ok: false, failure: aborted ? 'timeout' : 'network', retryable: false };
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
        `deepseek upstream error requestId=${requestId ?? '-'} model=${model} status=${status}${imageCount > 0 ? ` images=${imageCount}` : ''} latencyMs=${Date.now() - startedAt}`,
      );
      const failure = status === 401 || status === 403
        ? 'auth'
        : status === 429
          ? 'rate_limited'
          : status >= 500
            ? `upstream_${status}`
            : `rejected_${status}`;
      // 只有 5xx / 429 值得重试；400（如上游 image_invalid）重试也是同样结果。
      const retryable = imageCount > 0 && (status === 429 || status >= 500);
      return { ok: false, failure, retryable };
    }

    let payload: unknown = null;
    try {
      payload = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      payload = null;
    }

    const choices = isPlainObject(payload) ? payload.choices : null;
    const first = Array.isArray(choices) && isPlainObject(choices[0]) ? choices[0] : null;
    const finishReason = first && typeof first.finish_reason === 'string' ? first.finish_reason : '';
    return { ok: true, payload, finishReason };
  }

  /**
   * 失败原因 → 对外 HTTP 异常。
   *
   * 视觉请求统一落在 502 `DEEPSEEK_VISION_UNAVAILABLE`（客户端据此走「明确降级、
   * 不覆盖项目」的路径），但消息里写清真实原因，便于排障时区分：
   * 上游 5xx / 空回复 / 半截 JSON / 上游拒图。
   */
  private toHttpException(cause: string, hasImages: boolean): HttpException {
    if (cause === 'timeout') {
      return new HttpException(
        { code: 'DEEPSEEK_TIMEOUT', message: 'DeepSeek 响应超时，请稍后重试。' },
        HttpStatus.GATEWAY_TIMEOUT,
      );
    }
    if (cause === 'auth') {
      return new HttpException(
        { code: 'DEEPSEEK_AUTH_FAILED', message: 'DeepSeek 鉴权失败，请检查服务端模型配置。' },
        HttpStatus.BAD_GATEWAY,
      );
    }
    if (cause === 'rate_limited') {
      return new HttpException(
        { code: 'DEEPSEEK_RATE_LIMITED', message: 'DeepSeek 请求过于频繁，请稍后重试。' },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    if (hasImages) {
      const reason = cause === 'empty_content_truncated'
        ? '模型把输出预算花在推理上，没有返回识别内容'
        : cause === 'empty_content'
          ? '模型没有返回识别内容'
          : cause === 'invalid_json'
            ? '模型返回的不是合法 JSON'
            : cause === 'invalid_shape'
              ? '模型返回的 JSON 不是对象'
              : cause === 'network'
                ? '网络不可达'
                : cause.startsWith('upstream_')
                  ? `上游返回 ${cause.slice('upstream_'.length)}`
                  : cause === 'rejected_400'
                    ? '上游拒绝了这次图片请求'
                    : cause;
      return new HttpException(
        {
          code: 'DEEPSEEK_VISION_UNAVAILABLE',
          message: `图片识别暂时不可用（${reason}），请稍后重试或只发文字。`,
          cause,
        },
        HttpStatus.BAD_GATEWAY,
      );
    }
    if (cause === 'network') {
      return new HttpException(
        { code: 'DEEPSEEK_UNAVAILABLE', message: 'DeepSeek 暂时不可访问，请稍后重试。' },
        HttpStatus.BAD_GATEWAY,
      );
    }
    if (cause.startsWith('upstream_')) {
      return new HttpException(
        { code: 'DEEPSEEK_UPSTREAM_ERROR', message: 'DeepSeek 服务暂时不可用，请稍后重试。' },
        HttpStatus.BAD_GATEWAY,
      );
    }
    this.throwResponseInvalid(hasImages);
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