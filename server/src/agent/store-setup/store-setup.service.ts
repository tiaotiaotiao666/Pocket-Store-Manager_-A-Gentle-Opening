/**
 * 开店资料多轮 Agent。
 *
 * 与单轮 AgentService 的分工：
 * - AgentService（agent-turn.v1）由 Provider 一次性抽取 draftPatch；
 * - 本服务（agent-run.v1）让模型通过 get_store_draft / update_store_draft 多轮读写草稿，
 *   最终响应仍由服务端重新校验，模型无权决定 missingFields / errors / nextQuestion。
 */

import { HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  buildNextQuestion,
  normalizeInternalDraft,
  projectContractDraft,
  validateInternalDraft,
} from '../agent-draft.validator';
import type { AgentTurnContext, DraftValidation, InternalDraft } from '../agent.types';
import { AGENT_CHAT_MODEL } from '../agent.types';
import { createAgentLogSink } from '../agent-runtime.logger';
import {
  AgentAbortedError,
  AgentConfigurationError,
  AgentLimitError,
  AgentModelError,
  runAgent,
  ToolRegistry,
} from '../runtime';
import type { AgentRunResult, ChatModel } from '../runtime';
import { STORE_SETUP_SYSTEM_PROMPT } from './store-setup.prompt';
import {
  createStoreSetupSession,
  createStoreSetupTools,
  STORE_SETUP_TOOL_NAMES,
} from './store-setup.tools';
import { AGENT_RUN_CONTRACT_VERSION } from './store-setup.types';
import type { StoreSetupRunResponse, StoreSetupToolTrace } from './store-setup.types';

const MAX_UTTERANCE_LENGTH = 500;
const MAX_REPLY_LENGTH = 500;

const RUN_ALLOWED_KEYS: readonly string[] = Object.freeze([
  'contractVersion',
  'utterance',
  'draft',
  'client',
  'projectId',
]);

const MODEL_ERROR_STATUS: Readonly<Record<string, number>> = Object.freeze({
  DEEPSEEK_NOT_CONFIGURED: HttpStatus.SERVICE_UNAVAILABLE,
  DEEPSEEK_TIMEOUT: HttpStatus.GATEWAY_TIMEOUT,
  DEEPSEEK_UNAVAILABLE: HttpStatus.BAD_GATEWAY,
  DEEPSEEK_AUTH_FAILED: HttpStatus.BAD_GATEWAY,
  DEEPSEEK_RATE_LIMITED: HttpStatus.SERVICE_UNAVAILABLE,
  DEEPSEEK_UPSTREAM_ERROR: HttpStatus.BAD_GATEWAY,
  DEEPSEEK_REQUEST_REJECTED: HttpStatus.BAD_GATEWAY,
  DEEPSEEK_RESPONSE_INVALID: HttpStatus.BAD_GATEWAY,
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function reject(code: string, message: string): never {
  throw new HttpException({ code, message }, HttpStatus.BAD_REQUEST);
}

interface ParsedRunRequest {
  utterance: string;
  draft: InternalDraft;
}

/** 与 agent-turn.v1 相同的字段校验；额外拒绝未知顶层字段。 */
function parseRunRequest(raw: unknown): ParsedRunRequest {
  if (!isPlainObject(raw)) {
    reject('AGENT_REQUEST_INVALID', '请求体必须是 JSON 对象。');
  }
  if (raw.contractVersion !== AGENT_RUN_CONTRACT_VERSION) {
    reject('AGENT_CONTRACT_MISMATCH', `contractVersion 必须为 ${AGENT_RUN_CONTRACT_VERSION}。`);
  }
  for (const key of Object.keys(raw)) {
    if (!RUN_ALLOWED_KEYS.includes(key)) {
      reject('AGENT_REQUEST_INVALID', '请求体包含未知字段。');
    }
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

  return { utterance, draft: normalizeInternalDraft(raw.draft) };
}

function composeReply(reply: string, validation: DraftValidation): string {
  const text = typeof reply === 'string' ? reply.trim() : '';
  if (text) return Array.from(text).slice(0, MAX_REPLY_LENGTH).join('');
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
export class StoreSetupAgentService {
  private readonly logger = new Logger('StoreSetupAgent');
  private readonly logSink = createAgentLogSink(this.logger);

  constructor(
    @Inject(AGENT_CHAT_MODEL) private readonly model: ChatModel,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}

  async run(raw: unknown, context: AgentTurnContext): Promise<StoreSetupRunResponse> {
    const startedAt = Date.now();
    const request = parseRunRequest(raw);

    const session = createStoreSetupSession(request.draft);
    const registry = new ToolRegistry();
    registry.registerAll(createStoreSetupTools(session));

    let result: AgentRunResult;
    try {
      result = await runAgent({
        model: this.model,
        registry,
        systemPrompt: STORE_SETUP_SYSTEM_PROMPT,
        userMessage: request.utterance,
        tools: STORE_SETUP_TOOL_NAMES,
        limits: {
          maxModelCalls: this.readInt('AGENT_RUN_MAX_STEPS', 6),
          maxToolCalls: this.readInt('AGENT_RUN_MAX_TOOL_CALLS', 12),
          maxWallClockMs: this.readInt('AGENT_RUN_TIMEOUT_MS', 60_000),
        },
        requestId: context.requestId,
        logger: this.logSink,
      });
    } catch (error) {
      throw this.toHttpException(error, context.requestId);
    }

    const validation = validateInternalDraft(session.draft);
    const toolCalls: StoreSetupToolTrace[] = result.toolCalls.map((trace) => ({
      callId: trace.callId,
      name: trace.name,
      ok: trace.ok,
      ...(trace.errorCode === undefined ? {} : { errorCode: trace.errorCode }),
      latencyMs: trace.latencyMs,
      attempts: trace.attempts,
      truncated: trace.truncated,
    }));
    const failedTools = toolCalls.filter((call) => !call.ok).length;
    const latencyMs = Math.max(0, Date.now() - startedAt);
    const status = validation.readyForReview ? 'reviewing' : 'collecting';

    this.logger.log(
      `agent run requestId=${context.requestId} runId=${result.runId} status=${status} stopReason=${result.stopReason} modelCalls=${result.modelCalls} toolCalls=${toolCalls.length} failedTools=${failedTools} latencyMs=${latencyMs}`,
    );

    return {
      contractVersion: AGENT_RUN_CONTRACT_VERSION,
      runId: result.runId,
      status,
      reply: composeReply(result.reply, validation),
      draft: projectContractDraft(session.draft),
      missingFields: validation.missingFields,
      errors: validation.errors,
      nextQuestion: buildNextQuestion(validation),
      trace: {
        modelCalls: result.modelCalls,
        toolCalls,
        stopReason: result.stopReason,
        degraded: result.degraded || failedTools > 0,
      },
      meta: {
        transport: 'http',
        provider: 'deepseek',
        mock: false,
        model: result.model,
        latencyMs,
        runId: result.runId,
      },
    };
  }

  private readInt(key: string, fallback: number): number {
    const raw = this.config.get<unknown>(key);
    const value = Number(raw);
    return Number.isInteger(value) && value > 0 ? value : fallback;
  }

  private toHttpException(error: unknown, requestId: string): HttpException {
    if (error instanceof AgentModelError) {
      const status = MODEL_ERROR_STATUS[error.code] ?? HttpStatus.BAD_GATEWAY;
      return new HttpException({ code: error.code, message: error.message }, status);
    }
    if (error instanceof AgentAbortedError) {
      return new HttpException(
        { code: 'AGENT_ABORTED', message: '本次请求已取消。' },
        HttpStatus.REQUEST_TIMEOUT,
      );
    }
    if (error instanceof AgentConfigurationError || error instanceof AgentLimitError) {
      this.logger.error(
        `agent run failed requestId=${requestId} code=${error.code} name=${error.name}`,
      );
      return new HttpException(
        { code: error.code, message: '开店助手暂时不可用，请稍后重试。' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    const name = error instanceof Error ? error.name : typeof error;
    this.logger.error(`agent run failed requestId=${requestId} name=${name}`);
    return new HttpException(
      { code: 'AGENT_INTERNAL_ERROR', message: '开店助手暂时不可用，请稍后重试。' },
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }
}
