import { HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DeepseekPresentationProvider } from './template-revise.provider';
import type { PresentationCandidatesInput } from './template-revise.provider';
import { countCodePoints } from './presentation-patch';
import { TEMPLATE_IDS } from './template-revise.service';
import type { TemplateId } from './template-revise.service';

/**
 * `agent-template-candidates.v1` 服务（plan.md 2.2.9）。
 *
 * 服务端只决定排序与理由：
 * - 强制返回 3 个已知模板 ID、互不重复；
 * - 每个 ID 一条 ≤80 码点的中文理由；
 * - 模型不可用/超时/非 JSON/输出非法 → 502/503/504，不返回部分成功。
 *
 * score / source / note 仍由前端基于功能覆盖确定性计算，服务端不返回数字。
 * 本服务不写数据库、不发布会话状态。
 */

export const TEMPLATE_CANDIDATES_CONTRACT_VERSION = 'agent-template-candidates.v1';

const MAX_SELECTED_FEATURES = 11;
const MAX_BRIEF_LENGTH = 500;
const MAX_REASON_LENGTH = 80;
const EXPECTED_TEMPLATE_COUNT = 3;

const REQUEST_KEYS = new Set<string>([
  'contractVersion',
  'selectedFeatures',
  'brief',
  'client',
  'projectId',
]);

export interface TemplateCandidatesRequest {
  contractVersion: typeof TEMPLATE_CANDIDATES_CONTRACT_VERSION;
  selectedFeatures: string[];
  brief: string;
  client: { surface: 'desktop'; phase: 'template-pick' };
  projectId: null;
}

export interface TemplateCandidatesResponse {
  contractVersion: typeof TEMPLATE_CANDIDATES_CONTRACT_VERSION;
  turnId: string;
  orderedTemplateIds: [string, string, string];
  reasons: Record<string, string>;
  meta: {
    transport: 'http';
    provider: string;
    mock: false;
    model: string | null;
    latencyMs: number;
  };
}

export interface TemplateCandidatesContext {
  requestId: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function reject(path: string, message: string): never {
  throw new HttpException(
    {
      code: 'AGENT_REQUEST_INVALID',
      message,
      details: [{ path, code: 'AGENT_REQUEST_INVALID', message }],
    },
    HttpStatus.BAD_REQUEST,
  );
}

function rejectModelOutput(): never {
  throw new HttpException(
    { code: 'DEEPSEEK_RESPONSE_INVALID', message: '模型返回内容无法识别，请稍后重试。' },
    HttpStatus.BAD_GATEWAY,
  );
}

function truncateCodePoints(text: string, max: number): string {
  return Array.from(text).slice(0, max).join('');
}

/** 严格解析请求；任一失败 → 400，不调用模型。 */
export function parseTemplateCandidatesRequest(raw: unknown): TemplateCandidatesRequest {
  if (!isPlainObject(raw)) reject('', '请求体必须是 JSON 对象。');

  for (const key of Object.keys(raw)) {
    if (!REQUEST_KEYS.has(key)) reject(key, `未知的请求字段：${key}。`);
  }

  if (raw.contractVersion !== TEMPLATE_CANDIDATES_CONTRACT_VERSION) {
    reject('contractVersion', `contractVersion 必须为 ${TEMPLATE_CANDIDATES_CONTRACT_VERSION}。`);
  }

  if (!Array.isArray(raw.selectedFeatures)) {
    reject('selectedFeatures', 'selectedFeatures 必须是数组。');
  }
  if (raw.selectedFeatures.length > MAX_SELECTED_FEATURES) {
    reject('selectedFeatures', `selectedFeatures 最多 ${MAX_SELECTED_FEATURES} 项。`);
  }
  const selectedFeatures: string[] = [];
  const seen = new Set<string>();
  raw.selectedFeatures.forEach((feature, index) => {
    if (typeof feature !== 'string') reject(`selectedFeatures[${index}]`, '功能 ID 必须是字符串。');
    const id = feature.trim();
    if (!id) reject(`selectedFeatures[${index}]`, '功能 ID 不能为空。');
    if (seen.has(id)) return;
    seen.add(id);
    selectedFeatures.push(id);
  });

  const brief = typeof raw.brief === 'string' ? raw.brief.trim() : raw.brief === undefined ? '' : null;
  if (brief === null) reject('brief', 'brief 必须是字符串。');
  const briefLength = countCodePoints(brief);
  if (briefLength > MAX_BRIEF_LENGTH) {
    reject('brief', `brief 最多 ${MAX_BRIEF_LENGTH} 个字符。`);
  }

  if (!isPlainObject(raw.client) || raw.client.surface !== 'desktop' || raw.client.phase !== 'template-pick') {
    reject('client', 'client 必须为 {"surface":"desktop","phase":"template-pick"}。');
  }

  if (raw.projectId !== null && raw.projectId !== undefined) {
    reject('projectId', '本轮 projectId 固定为 null。');
  }

  return {
    contractVersion: TEMPLATE_CANDIDATES_CONTRACT_VERSION,
    selectedFeatures,
    brief,
    client: { surface: 'desktop', phase: 'template-pick' },
    projectId: null,
  };
}

/** 把模型输出收敛为恰好 3 个已知模板；任何偏离都视为 502。 */
export function normalizeCandidateOutput(
  orderedTemplateIds: unknown,
  rawReasons: unknown,
): { orderedTemplateIds: [string, string, string]; reasons: Record<string, string> } {
  if (!Array.isArray(orderedTemplateIds) || orderedTemplateIds.length !== EXPECTED_TEMPLATE_COUNT) {
    rejectModelOutput();
  }

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const rawId of orderedTemplateIds) {
    if (typeof rawId !== 'string') rejectModelOutput();
    const id = rawId.trim();
    if (!TEMPLATE_IDS.includes(id as TemplateId)) rejectModelOutput();
    if (seen.has(id)) rejectModelOutput();
    seen.add(id);
    ids.push(id);
  }

  if (ids.length !== EXPECTED_TEMPLATE_COUNT) rejectModelOutput();

  const reasonsSource = isPlainObject(rawReasons) ? rawReasons : {};
  const reasons: Record<string, string> = {};
  for (const id of ids) {
    const rawReason = reasonsSource[id];
    if (typeof rawReason !== 'string') rejectModelOutput();
    const reason = truncateCodePoints(rawReason.normalize('NFC').trim(), MAX_REASON_LENGTH);
    if (!reason) rejectModelOutput();
    reasons[id] = reason;
  }

  return {
    orderedTemplateIds: [ids[0], ids[1], ids[2]] as [string, string, string],
    reasons,
  };
}

@Injectable()
export class TemplateCandidatesService {
  private readonly logger = new Logger('TemplateCandidatesService');

  constructor(@Inject(DeepseekPresentationProvider) private readonly provider: DeepseekPresentationProvider) {}

  async recommend(raw: unknown, context: TemplateCandidatesContext): Promise<TemplateCandidatesResponse> {
    const startedAt = Date.now();
    const request = parseTemplateCandidatesRequest(raw);

    const providerInput: PresentationCandidatesInput = {
      requestId: context.requestId,
      selectedFeatures: request.selectedFeatures,
      brief: request.brief,
    };
    const providerResult = await this.provider.recommendCandidates(providerInput);
    const normalized = normalizeCandidateOutput(
      providerResult.orderedTemplateIds,
      providerResult.reasons,
    );

    const turnId = `turn-${randomUUID()}`;
    const latencyMs = Math.max(0, Date.now() - startedAt);
    this.logger.log(
      `template candidates requestId=${context.requestId} turnId=${turnId} model=${providerResult.model} latencyMs=${latencyMs} selectedFeatureCount=${request.selectedFeatures.length} briefLength=${countCodePoints(request.brief)}`,
    );

    return {
      contractVersion: TEMPLATE_CANDIDATES_CONTRACT_VERSION,
      turnId,
      orderedTemplateIds: normalized.orderedTemplateIds as [string, string, string],
      reasons: normalized.reasons,
      meta: {
        transport: 'http',
        provider: this.provider.name,
        mock: false,
        model: providerResult.model,
        latencyMs,
      },
    };
  }
}