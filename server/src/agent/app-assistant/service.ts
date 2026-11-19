/**
 * `POST /api/v1/agent/app-assistant`（app-assistant.v1）的业务编排。
 *
 * 分工：
 * - Runtime（既有 agent-loop / ToolExecutor）负责多轮调用、schema、超时、重试、并发、
 *   循环检测、调用上限与取消，本服务不另写 loop；
 * - 本服务负责请求契约解析、能力目录校验、五个工具的单次请求会话、状态与响应组装；
 * - 所有写工具只改内存 proposal buffer；服务端不碰数据库、文件与桌面 IPC。
 */

import { HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { createAgentLogSink } from '../agent-runtime.logger';
import { AGENT_CHAT_MODEL } from '../agent.types';
import {
  AgentAbortedError,
  AgentConfigurationError,
  AgentLimitError,
  AgentModelError,
  ToolRegistry,
  runAgent,
} from '../runtime';
import type { AgentRunResult, ChatContentPart, ChatModel } from '../runtime';
import { buildAppAssistantSystemPrompt } from './prompt';
import { collectAppAssistantResponseIssues, parseAppAssistantRequest } from './schema';
import {
  APP_ASSISTANT_CATALOG_VERSION,
  APP_ASSISTANT_CONTRACT_VERSION,
  APP_ASSISTANT_LIMITS,
  APP_ASSISTANT_TOOL_NAMES,
} from './types';
import type {
  AppAssistantResponse,
  AppAssistantStatus,
  AppAssistantToolTrace,
  ParsedAppAssistantRequest,
} from './types';
import { createAppAssistantSession, createAppAssistantTools } from './tools';

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

/** 只有“越出目录或安全边界”的工具错误才把整轮标成 rejected；可重试的参数错误不算。 */
const DENIAL_ERROR_CODES: ReadonlySet<string> = new Set([
  'APP_ASSISTANT_FIELD_UNKNOWN',
  'APP_ASSISTANT_FIELD_READ_ONLY',
  'APP_ASSISTANT_OPERATION_DENIED',
  'APP_ASSISTANT_ACTION_UNAVAILABLE',
]);

const FALLBACK_REPLY: Readonly<Record<AppAssistantStatus, string>> = Object.freeze({
  proposal: '这次没有整理出可写入的修改，请补充更明确的要求。',
  'needs-input': '还需要你补充一些信息才能继续，请回答下面的问题。',
  rejected: '这次请求超出我可以修改的项目范围，我没有生成任何写入。',
});

export interface AppAssistantRunContext {
  requestId: string;
  /** 原始 `X-Agent-Request-Id`；与 body.requestId 不一致时 fail closed。 */
  agentRequestIdHeader?: unknown;
  /** 原始 `X-Agent-Contract`；存在时必须等于 app-assistant.v1。 */
  agentContractHeader?: unknown;
  signal?: AbortSignal;
}

function clipChars(value: string, maxChars: number): string {
  return Array.from(value).slice(0, maxChars).join('');
}

function composeReply(raw: string, status: AppAssistantStatus): string {
  const text = typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim() : '';
  if (text) return clipChars(text, APP_ASSISTANT_LIMITS.maxReplyChars);
  return FALLBACK_REPLY[status];
}

function resolveStatus(
  changes: number,
  actionRequests: number,
  questions: number,
  result: AgentRunResult,
): AppAssistantStatus {
  if (changes > 0 || actionRequests > 0) return 'proposal';
  if (questions > 0) return 'needs-input';
  const denied = result.toolCalls.some(
    (trace) => !trace.ok && trace.errorCode !== undefined && DENIAL_ERROR_CODES.has(trace.errorCode),
  );
  return denied ? 'rejected' : 'proposal';
}

/** 附件与用户文字一起进入多模态 user 消息；图片只作为内联 data URL 传给模型。 */
function buildUserMessage(request: ParsedAppAssistantRequest): string | ChatContentPart[] {
  const instruction =
    request.utterance ||
    '请判断这些图片的用途；不确定时先追问是识别菜单、提取门店氛围，还是参考界面重构。';

  if (request.attachments.length === 0) return instruction;

  const labels = request.attachments
    .map((attachment) => `${attachment.id}（用途 ${attachment.kind}，${attachment.mediaType}）`)
    .join('；');
  const parts: ChatContentPart[] = [
    {
      type: 'text',
      text: `${instruction}\n\n本轮附件：${labels}。图片只用于理解，不要回传图片数据、URL 或路径。`,
    },
  ];
  for (const attachment of request.attachments) {
    parts.push({
      type: 'image_url',
      imageUrl: { url: `data:${attachment.mediaType};base64,${attachment.data}` },
    });
  }
  return parts;
}

@Injectable()
export class AppAssistantService {
  private readonly logger = new Logger('AppAssistant');
  private readonly logSink = createAgentLogSink(this.logger);

  constructor(
    @Inject(AGENT_CHAT_MODEL) private readonly model: ChatModel,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}

  async run(raw: unknown, context: AppAssistantRunContext): Promise<AppAssistantResponse> {
    const startedAt = Date.now();
    const request = parseAppAssistantRequest(raw, {
      agentRequestId: context.agentRequestIdHeader,
      agentContract: context.agentContractHeader,
    });

    const session = createAppAssistantSession({
      projectId: request.projectId,
      contextRevision: request.contextRevision,
      phase: request.client.phase,
      context: request.context,
      attachments: request.attachments,
    });
    const registry = new ToolRegistry();
    registry.registerAll(createAppAssistantTools(session));

    let result: AgentRunResult;
    try {
      result = await runAgent({
        model: this.model,
        registry,
        systemPrompt: buildAppAssistantSystemPrompt({ history: request.history }),
        userMessage: buildUserMessage(request),
        tools: APP_ASSISTANT_TOOL_NAMES,
        limits: {
          maxModelCalls: this.readLimit('AGENT_RUN_MAX_STEPS', APP_ASSISTANT_LIMITS.maxModelCalls),
          maxToolCalls: this.readLimit('AGENT_RUN_MAX_TOOL_CALLS', APP_ASSISTANT_LIMITS.maxToolCalls),
          maxWallClockMs: this.readLimit('AGENT_RUN_TIMEOUT_MS', APP_ASSISTANT_LIMITS.maxWallClockMs),
          maxReplyCharacters: APP_ASSISTANT_LIMITS.maxReplyChars,
        },
        requestId: context.requestId,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
        logger: this.logSink,
      });
    } catch (error) {
      throw this.toHttpException(error, context.requestId);
    }

    if (result.truncated) {
      // 截断的输出不是完整提案，绝不解析残片。
      this.logger.warn(
        `app-assistant truncated requestId=${context.requestId} runId=${result.runId} stopReason=${result.stopReason}`,
      );
      throw new HttpException(
        { code: 'APP_ASSISTANT_RESPONSE_INVALID', message: '模型输出被截断，本次提案不可用，请重试。' },
        HttpStatus.BAD_GATEWAY,
      );
    }

    const status = resolveStatus(
      session.changes.length,
      session.actionRequests.length,
      session.questions.length,
      result,
    );
    const failedTools = result.toolCalls.filter((trace) => !trace.ok).length;
    const toolCalls: AppAssistantToolTrace[] = result.toolCalls.map((trace) => ({
      name: trace.name,
      ok: trace.ok,
      latencyMs: trace.latencyMs,
    }));
    const latencyMs = Math.max(0, Date.now() - startedAt);
    const runId = result.runId;

    const response: AppAssistantResponse = {
      contractVersion: APP_ASSISTANT_CONTRACT_VERSION,
      requestId: request.requestId,
      runId,
      catalogVersion: APP_ASSISTANT_CATALOG_VERSION,
      contextRevision: request.contextRevision,
      status,
      reply: composeReply(result.reply, status),
      proposalId: `proposal_${randomUUID()}`,
      changes: session.changes,
      questions: session.questions,
      actionRequests: session.actionRequests,
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
        model: result.model || this.model.name,
        latencyMs,
        runId,
      },
    };

    // 自检：任何越界字段/值都不出服务端。
    const issues = collectAppAssistantResponseIssues(response, {
      requestId: request.requestId,
      contextRevision: request.contextRevision,
      attachmentIds: session.attachmentIds,
    });
    if (issues.length > 0) {
      this.logger.error(
        `app-assistant response invalid requestId=${context.requestId} runId=${runId} issues=${issues.length}`,
      );
      throw new HttpException(
        { code: 'APP_ASSISTANT_RESPONSE_INVALID', message: '模型输出无法整理成合法提案，请重试。' },
        HttpStatus.BAD_GATEWAY,
      );
    }

    this.logger.log(
      `app-assistant requestId=${context.requestId} runId=${runId} status=${status} stopReason=${result.stopReason} modelCalls=${result.modelCalls} toolCalls=${toolCalls.length} failedTools=${failedTools} changes=${session.changes.length} actions=${session.actionRequests.length} questions=${session.questions.length} latencyMs=${latencyMs}`,
    );

    return response;
  }

  /** 契约上限是硬上限：env 只能调低，不能突破。 */
  private readLimit(key: string, contractLimit: number): number {
    const raw = this.config.get<unknown>(key);
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) return contractLimit;
    return Math.min(value, contractLimit);
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
        `app-assistant failed requestId=${requestId} code=${error.code} name=${error.name}`,
      );
      return new HttpException(
        { code: error.code, message: '项目助手暂时不可用，请稍后重试。' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    const name = error instanceof Error ? error.name : typeof error;
    this.logger.error(`app-assistant failed requestId=${requestId} name=${name}`);
    return new HttpException(
      { code: 'AGENT_INTERNAL_ERROR', message: '项目助手暂时不可用，请稍后重试。' },
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }
}