import { HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  applyDraftPatch,
  buildNextQuestion,
  normalizeInternalDraft,
  projectContractDraft,
  validateInternalDraft,
} from './agent-draft.validator';
import { AGENT_PROVIDER, AGENT_TURN_CONTRACT_VERSION } from './agent.types';
import type {
  AgentTurnContext,
  AgentTurnRequest,
  AgentTurnResponse,
  DraftValidation,
} from './agent.types';
import type { AgentProvider } from './provider/agent-provider.interface';

const MAX_UTTERANCE_LENGTH = 500;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function reject(code: string, message: string): never {
  throw new HttpException({ code, message }, HttpStatus.BAD_REQUEST);
}

/**
 * 严格解析请求体。
 *
 * 关键安全点：请求里的 status / missingFields / errors / readyForReview
 * 一律不读取，服务端只相信自己的校验结果。
 */
function parseTurnRequest(raw: unknown): AgentTurnRequest {
  if (!isPlainObject(raw)) {
    reject('AGENT_REQUEST_INVALID', '请求体必须是 JSON 对象。');
  }
  if (raw.contractVersion !== AGENT_TURN_CONTRACT_VERSION) {
    reject('AGENT_CONTRACT_MISMATCH', `contractVersion 必须为 ${AGENT_TURN_CONTRACT_VERSION}。`);
  }

  const utterance = typeof raw.utterance === 'string' ? raw.utterance.trim() : '';
  const utteranceLength = Array.from(utterance).length;
  if (utteranceLength < 1 || utteranceLength > MAX_UTTERANCE_LENGTH) {
    reject('UTTERANCE_INVALID', `utterance 必须是 1–${MAX_UTTERANCE_LENGTH} 字的文本。`);
  }

  if (!isPlainObject(raw.draft)) {
    reject('DRAFT_INVALID', 'draft 必须是 ContractDraft 对象。');
  }

  if (!isPlainObject(raw.client) || raw.client.surface !== 'desktop' || raw.client.phase !== 'store-info') {
    reject('CLIENT_INVALID', 'client 必须为 {"surface":"desktop","phase":"store-info"}。');
  }

  if (raw.projectId !== null && raw.projectId !== undefined) {
    reject('PROJECT_ID_INVALID', '本轮 projectId 固定为 null。');
  }

  return {
    contractVersion: AGENT_TURN_CONTRACT_VERSION,
    utterance,
    draft: projectContractDraft(normalizeInternalDraft(raw.draft)),
    client: { surface: 'desktop', phase: 'store-info' },
    projectId: null,
  };
}

function normalizeReply(reply: unknown, validation: DraftValidation): string {
  const text = typeof reply === 'string' ? reply.trim() : '';
  if (text) {
    return Array.from(text).slice(0, 500).join('');
  }
  // 模型没有给可用回复时，用后端校验结果生成兜底文案（不臆造资料）。
  if (validation.readyForReview) {
    return '这次补充的资料已经整理好，请检查右侧草稿后确认。';
  }
  const question = buildNextQuestion(validation);
  if (question) {
    return `已更新草稿。${question.text}`;
  }
  return '已更新草稿，请检查右侧内容，或再补充一些资料。';
}

@Injectable()
export class AgentService {
  private readonly logger = new Logger('AgentService');

  constructor(@Inject(AGENT_PROVIDER) private readonly provider: AgentProvider) {}

  async handleTurn(raw: unknown, context: AgentTurnContext): Promise<AgentTurnResponse> {
    const startedAt = Date.now();
    const request = parseTurnRequest(raw);

    const baseDraft = normalizeInternalDraft(request.draft);
    const providerResult = await this.provider.extractTurn({
      utterance: request.utterance,
      draft: projectContractDraft(baseDraft),
      requestId: context.requestId,
    });

    // 只合并白名单字段；模型返回的 status / missingFields / errors 全部忽略。
    const mergedDraft = applyDraftPatch(baseDraft, providerResult.draftPatch);
    const validation = validateInternalDraft(mergedDraft);
    const turnId = `turn-${randomUUID()}`;
    const latencyMs = Math.max(0, Date.now() - startedAt);
    const status = validation.readyForReview ? 'reviewing' : 'collecting';

    this.logger.log(
      `agent turn requestId=${context.requestId} turnId=${turnId} status=${status} model=${providerResult.model ?? 'unknown'} latencyMs=${latencyMs} utteranceLength=${Array.from(request.utterance).length} missing=${validation.missingFields.length} errors=${validation.errors.length}`,
    );

    return {
      contractVersion: AGENT_TURN_CONTRACT_VERSION,
      turnId,
      status,
      reply: normalizeReply(providerResult.reply, validation),
      draft: projectContractDraft(mergedDraft),
      missingFields: validation.missingFields,
      errors: validation.errors,
      nextQuestion: buildNextQuestion(validation),
      meta: {
        transport: 'http',
        provider: this.provider.name,
        mock: false,
        model: providerResult.model ?? null,
        latencyMs,
      },
    };
  }
}