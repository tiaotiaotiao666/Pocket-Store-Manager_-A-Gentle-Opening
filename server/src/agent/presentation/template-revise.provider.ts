import { HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AGENT_FETCH } from '../agent.types';
import type { AgentFetch } from '../provider/agent-provider.interface';
import type { ContractDraft } from '../agent.types';
import type { PresentationPatch, SlotPlacementPatch } from './presentation-patch';
import { countCodePoints } from './presentation-patch';

/**
 * DeepSeek OpenAI 兼容 Provider（展示域）。
 *
 * 只负责两件事：
 * 1. `agent-template-revise.v1`：返回模型给出的 reply + presentationPatch；
 * 2. `agent-template-candidates.v1`：返回模型给出的排序与理由。
 *
 * 安全边界：
 * - API Key 只从服务端环境变量读取，绝不写日志、错误体或响应；
 * - 上游错误只映射成稳定的错误码，不回传原始响应体；
 * - 日志只记录计数与耗时，绝不记录 base64、Key 或完整模型 payload；
 * - 带图片时使用 DEEPSEEK_VISION_MODEL 并构造 OpenAI 多模态 content parts。
 */

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-chat';
/** 视觉模型默认值（C-SERVER-ENV@1）。 */
const DEFAULT_VISION_MODEL = 'deepseek-flash';
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 120000;
const DEFAULT_MAX_TOKENS = 1200;
const MAX_REPLY_LENGTH = 200;

export const TEMPLATE_REVISE_SYSTEM_PROMPT = [
  '你是「智能开店」桌面端的模板展示修改助手，只负责把店主的一句话翻译成一份受控的展示补丁。',
  '',
  '严格约束：',
  '- 不得写数据库、不得发布小程序、不得调用任何工具、不得生成代码、HTML 或 CSS。',
  '- 只输出 JSON，不输出 Markdown、代码围栏、解释或前后缀。',
  '- 输出形状固定为 {"reply":"给店主看的中文回复","presentationPatch":{...}}，不得增加其他顶层键。',
  '- presentationPatch 顶层只允许 theme、sizes、slotOrder、copy 四个键；没有可修改内容时返回 {}。',
  '',
  'presentationPatch 字段约束：',
  '- theme：只允许 pageBackground、primaryColor、accentColor、textColor、tabBarBackground、tabBarColor、tabBarSelectedColor；值必须是 #RRGGBB 十六进制颜色。',
  '- sizes：只允许 homeHero、productCard、carousel；值只能是 sm、md、lg；只有当前 Plan 含 poster-carousel 时才允许改 carousel。',
  '- slotOrder：必须是当前 Plan 已占用区块的完整排列，每个 featureId 恰好出现一次；目标插槽与页面必须匹配：',
  '  home-hero→home、home-marketing→home、menu-aside→menu、menu-hero→menu；',
  '  menu-hero 与 home-hero 接受 feature-pack 与 ui-block，home-marketing 只接受 feature-pack，menu-aside 只接受 ui-block。',
  '- copy：只允许 storeName、category、tagline、dishes；店名 1..48 个字符、品类 1..24、口号 0..40；',
  '  dishes 每项只允许 id、name、description，id 必须来自当前草稿，不得改价（禁止 priceCents / priceText）。',
  '- 不得输出 layout、组件增删、样式文本、URL、脚本或原型相关键。',
  '',
  '回复要求：reply 用简体中文，最多 200 字，只描述这次改动；不要声称修改了未包含在补丁里的内容。',
].join('\n');

export const TEMPLATE_CANDIDATES_SYSTEM_PROMPT = [
  '你是「智能开店」桌面端的模板推荐助手，只负责在 3 套固定模板中排序并给出理由。',
  '',
  '固定模板（不得新增、不得遗漏）：',
  '- warm-bistro：暖色小馆，适合家常菜、社区餐馆；',
  '- modern-coffee：现代咖啡，适合咖啡、茶饮、轻食；',
  '- signature-kitchen：招牌厨房，适合主打招牌菜与视觉陈列的门店。',
  '',
  '严格约束：',
  '- 不得写数据库、不得发布小程序、不得调用任何工具、不得生成代码。',
  '- 只输出 JSON，不输出 Markdown、代码围栏、解释或前后缀。',
  '- 输出形状固定为 {"orderedTemplateIds":["...","...","..."],"reasons":{"warm-bistro":"...","modern-coffee":"...","signature-kitchen":"..."}}。',
  '- orderedTemplateIds 必须恰好包含 3 个 ID、互不重复，且全部来自上面的固定模板。',
  '- reasons 必须为每个模板给出一条简体中文理由，最多 80 个字，不得评价未选择的模板。',
].join('\n');

export interface PresentationImageInput {
  kind: 'store';
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp';
  /** 纯 base64，不含 data: 前缀。 */
  data: string;
}

export interface PresentationReviseInput {
  requestId?: string;
  utterance: string;
  candidate: { templateId: string; layout: string };
  planFeatures: SlotPlacementPatch[];
  basePatch: PresentationPatch;
  baseDraft: ContractDraft;
  images: PresentationImageInput[];
}

export interface PresentationReviseResult {
  reply: string;
  /** 模型给出的补丁（未校验）；调用方必须合并并重新校验。 */
  modelPatch: unknown;
  model: string;
  latencyMs: number;
}

export interface PresentationCandidatesInput {
  requestId?: string;
  selectedFeatures: string[];
  brief: string;
}

export interface PresentationCandidatesResult {
  /** 未经校验的模型输出，由 Service 强制收敛为 3 个已知模板。 */
  orderedTemplateIds: unknown;
  reasons: unknown;
  model: string;
  latencyMs: number;
}

interface DeepseekSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
  visionModel: string;
  timeoutMs: number;
  maxTokens: number;
}

type ChatContent = string | Array<Record<string, unknown>>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toTimeout(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(1, Math.floor(parsed)));
}

function toMaxTokens(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_TOKENS;
  return Math.min(4000, Math.max(100, Math.floor(parsed)));
}

/** 去掉 Markdown 代码围栏；同时容忍模型在 JSON 前后加解释文字。 */
export function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  const fenced = /^```(?:json|JSON)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  if (fenced) return fenced[1].trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

/** 从 OpenAI 兼容响应里取出 assistant content（支持字符串与分段数组）。 */
export function extractAssistantContent(payload: unknown): string {
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

function truncateCodePoints(text: string, max: number): string {
  return Array.from(text).slice(0, max).join('');
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}) ?? '{}';
  } catch {
    return '{}';
  }
}

/** 构造 revise 的用户消息：结构化上下文，不含任何密钥。 */
function buildReviseUserPrompt(input: PresentationReviseInput): string {
  return [
    '当前候选模板：',
    safeJson(input.candidate),
    '',
    '当前 Plan 已占用区块：',
    safeJson(input.planFeatures),
    '',
    '当前已接受补丁（basePatch，请在其基础上修改）：',
    safeJson(input.basePatch),
    '',
    '当前草稿（baseDraft）：',
    safeJson(input.baseDraft),
    '',
    '店主本轮修改描述：',
    `"""${input.utterance}"""`,
    '',
    '只输出约定形状的 JSON；没有可修改内容时 presentationPatch 返回 {}。',
  ].join('\n');
}

function buildCandidatesUserPrompt(input: PresentationCandidatesInput): string {
  return [
    '店主已选择的页面功能 ID：',
    safeJson(input.selectedFeatures),
    '',
    '店主补充描述：',
    `"""${input.brief}"""`,
    '',
    '请只输出约定形状的 JSON。',
  ].join('\n');
}

@Injectable()
export class DeepseekPresentationProvider {
  readonly name = 'deepseek';

  private readonly logger = new Logger('DeepseekPresentationProvider');

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(AGENT_FETCH) private readonly fetchImpl: AgentFetch,
  ) {}

  private readSettings(): DeepseekSettings {
    const rawBaseUrl = String(this.config.get('DEEPSEEK_API_BASE_URL') ?? DEFAULT_BASE_URL).trim();
    const baseUrl = (rawBaseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const rawModel = String(this.config.get('DEEPSEEK_MODEL') ?? DEFAULT_MODEL).trim();
    const rawVisionModel = String(this.config.get('DEEPSEEK_VISION_MODEL') ?? DEFAULT_VISION_MODEL).trim();
    return {
      baseUrl,
      apiKey: String(this.config.get('DEEPSEEK_API_KEY') ?? '').trim(),
      model: rawModel || DEFAULT_MODEL,
      visionModel: rawVisionModel || DEFAULT_VISION_MODEL,
      timeoutMs: toTimeout(this.config.get('DEEPSEEK_TIMEOUT_MS') ?? DEFAULT_TIMEOUT_MS),
      maxTokens: toMaxTokens(this.config.get('DEEPSEEK_MAX_TOKENS') ?? DEFAULT_MAX_TOKENS),
    };
  }

  /** 供健康检查/文档使用：只暴露“是否配置”，绝不返回 Key。 */
  describeConfiguration(): { configured: boolean; baseUrl: string; model: string; visionModel: string; timeoutMs: number } {
    const settings = this.readSettings();
    return {
      configured: Boolean(settings.apiKey),
      baseUrl: settings.baseUrl,
      model: settings.model,
      visionModel: settings.visionModel,
      timeoutMs: settings.timeoutMs,
    };
  }

  /**
   * 调用模型生成展示补丁。
   *
   * 带图片时使用视觉模型 + 多模态 content parts；无图片时使用文本模型。
   * 模型输出必须是 JSON 对象且包含 presentationPatch；否则 502。
   */
  async revisePatch(input: PresentationReviseInput): Promise<PresentationReviseResult> {
    const settings = this.readSettings();
    if (!settings.apiKey) {
      // 明确失败，不自动回退到本地 Mock。
      throw new HttpException(
        { code: 'DEEPSEEK_NOT_CONFIGURED', message: 'DeepSeek 未配置' },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const hasImages = input.images.length > 0;
    const model = hasImages ? settings.visionModel : settings.model;
    const text = `${TEMPLATE_REVISE_SYSTEM_PROMPT}\n\n${buildReviseUserPrompt(input)}`;
    const content: ChatContent = hasImages
      ? [
          { type: 'text', text },
          ...input.images.map((image) => ({
            type: 'image_url',
            image_url: { url: `data:${image.mediaType};base64,${image.data}`, detail: 'low' },
          })),
        ]
      : text;

    const startedAt = Date.now();
    const parsed = await this.requestJson({
      model,
      content,
      maxTokens: settings.maxTokens,
      settings,
      requestId: input.requestId,
      operation: 'template-revise',
      imageCount: input.images.length,
    });

    if (!isPlainObject(parsed) || !Object.prototype.hasOwnProperty.call(parsed, 'presentationPatch')) {
      throw new HttpException(
        { code: 'DEEPSEEK_RESPONSE_INVALID', message: '模型返回内容无法识别，请稍后重试。' },
        HttpStatus.BAD_GATEWAY,
      );
    }
    if (!isPlainObject(parsed.presentationPatch)) {
      throw new HttpException(
        { code: 'DEEPSEEK_RESPONSE_INVALID', message: '模型返回内容无法识别，请稍后重试。' },
        HttpStatus.BAD_GATEWAY,
      );
    }

    const rawReply = typeof parsed.reply === 'string' ? parsed.reply.trim() : '';
    const reply = truncateCodePoints(rawReply, MAX_REPLY_LENGTH);
    const latencyMs = Math.max(0, Date.now() - startedAt);

    this.logger.log(
      `deepseek template-revise ok requestId=${input.requestId ?? '-'} model=${model} latencyMs=${latencyMs} imageCount=${input.images.length} replyLength=${countCodePoints(reply)}`,
    );

    return {
      reply,
      modelPatch: parsed.presentationPatch,
      model,
      latencyMs,
    };
  }

  /**
   * 调用模型给出 3 套模板的排序与理由。
   * 返回未校验字段，由 Service 强制收敛；非法输出在 Service 侧映射为 502。
   */
  async recommendCandidates(input: PresentationCandidatesInput): Promise<PresentationCandidatesResult> {
    const settings = this.readSettings();
    if (!settings.apiKey) {
      throw new HttpException(
        { code: 'DEEPSEEK_NOT_CONFIGURED', message: 'DeepSeek 未配置' },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const startedAt = Date.now();
    const parsed = await this.requestJson({
      model: settings.model,
      content: `${TEMPLATE_CANDIDATES_SYSTEM_PROMPT}\n\n${buildCandidatesUserPrompt(input)}`,
      maxTokens: Math.min(settings.maxTokens, 600),
      settings,
      requestId: input.requestId,
      operation: 'template-candidates',
      imageCount: 0,
    });

    if (!isPlainObject(parsed)) {
      throw new HttpException(
        { code: 'DEEPSEEK_RESPONSE_INVALID', message: '模型返回内容无法识别，请稍后重试。' },
        HttpStatus.BAD_GATEWAY,
      );
    }

    const latencyMs = Math.max(0, Date.now() - startedAt);
    this.logger.log(
      `deepseek template-candidates ok requestId=${input.requestId ?? '-'} model=${settings.model} latencyMs=${latencyMs} selectedFeatureCount=${input.selectedFeatures.length}`,
    );

    return {
      orderedTemplateIds: parsed.orderedTemplateIds,
      reasons: parsed.reasons,
      model: settings.model,
      latencyMs,
    };
  }

  /**
   * 统一的 OpenAI 兼容 /chat/completions 调用。
   * 只返回解析后的 JSON 对象；任何失败都抛出稳定的错误码。
   */
  private async requestJson(options: {
    model: string;
    content: ChatContent;
    maxTokens: number;
    settings: DeepseekSettings;
    requestId?: string;
    operation: string;
    imageCount: number;
  }): Promise<unknown> {
    const { settings, requestId, operation } = options;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, settings.timeoutMs);

    let response: Response;
    const startedAt = Date.now();
    try {
      response = await this.fetchImpl(`${settings.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${settings.apiKey}`,
        },
        body: JSON.stringify({
          model: options.model,
          messages: [{ role: 'user', content: options.content }],
          temperature: 0.2,
          max_tokens: options.maxTokens,
          stream: false,
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      });
    } catch (error) {
      const aborted = timedOut || (error instanceof Error && error.name === 'AbortError');
      this.logger.warn(
        `deepseek ${operation} failed requestId=${requestId ?? '-'} model=${options.model} cause=${aborted ? 'timeout' : 'network'} imageCount=${options.imageCount}`,
      );
      if (aborted) {
        throw new HttpException(
          { code: 'DEEPSEEK_TIMEOUT', message: 'DeepSeek 响应超时，请稍后重试。' },
          HttpStatus.GATEWAY_TIMEOUT,
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
        `deepseek ${operation} upstream error requestId=${requestId ?? '-'} model=${options.model} status=${status} latencyMs=${Date.now() - startedAt}`,
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

    const content = extractAssistantContent(payload);
    if (!content.trim()) {
      throw new HttpException(
        { code: 'DEEPSEEK_RESPONSE_INVALID', message: '模型返回内容无法识别，请稍后重试。' },
        HttpStatus.BAD_GATEWAY,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripJsonFence(content));
    } catch {
      throw new HttpException(
        { code: 'DEEPSEEK_RESPONSE_INVALID', message: '模型返回内容无法识别，请稍后重试。' },
        HttpStatus.BAD_GATEWAY,
      );
    }

    if (!isPlainObject(parsed)) {
      throw new HttpException(
        { code: 'DEEPSEEK_RESPONSE_INVALID', message: '模型返回内容无法识别，请稍后重试。' },
        HttpStatus.BAD_GATEWAY,
      );
    }

    return parsed;
  }
}