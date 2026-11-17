/**
 * `POST /api/v1/agent/frontend-reconstruct` 的业务编排（P1）。
 *
 * 分工：
 * - Runtime（既有 agent-loop / ToolExecutor）负责多轮模型调用、工具 schema、超时、重试、
 *   并发、循环检测、调用上限与取消；
 * - 本服务负责：请求契约解析、只读能力事实、四个工具的会话状态、服务端权威覆盖结论、
 *   响应组装与 fail-closed 校验；
 * - 模型输出永远只当“有界 JSON DSL”处理；响应里绝不回传源码、图片 base64、
 *   完整 prompt 或原始模型响应。
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
import type { AgentRunResult, ChatModel } from '../runtime';
import { buildCapabilityCoverage, loadFrontendFacts } from './capabilities';
import { FrontendReconstructError, frontendError, sanitizeFrontendLogDetails } from './errors';
import { loadFrontendPageFacts } from './page-facts';
import { FRONTEND_RECONSTRUCT_SYSTEM_PROMPT, buildFrontendUserContent } from './prompt';
import {
  assertFrontendPlannedConsistency,
  parseFrontendReconstructRequest,
  validateFrontendPackDraftForP1,
  validateFrontendReconstructResponseForP1,
} from './schema';
import {
  FRONTEND_RECONSTRUCT_TOOL_NAMES,
  createFrontendReconstructSession,
  createFrontendReconstructTools,
} from './tools';
import type { FrontendReconstructSession } from './tools';
import { FRONTEND_LIMITS, FRONTEND_RECONSTRUCT_CONTRACT_VERSION, FRONTEND_TOOL_NAMES } from './types';
import type {
  CapabilityCoverageReport,
  FrontendPackDraft,
  FrontendQuestion,
  FrontendReconstructResponse,
  FrontendResponseStatus,
  FrontendStopReason,
  FrontendTargetPageId,
  FrontendToolName,
  FrontendTrace,
  FrontendTraceToolCall,
  UiRequirement,
} from './types';

/** 专用重构模型输出上限：比对话默认值高，但仍有硬上限（适配器再裁剪到 8000）。 */
export const FRONTEND_MODEL_MAX_TOKENS = 6_000;

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

const ALLOWED_TOOL_NAMES: ReadonlySet<string> = new Set(FRONTEND_TOOL_NAMES);
const ALLOWED_STOP_REASONS: ReadonlySet<string> = new Set([
  'final_answer',
  'needs_input',
  'rejected',
  'max_model_calls',
  'max_tool_calls',
  'loop_detected',
  'time_limit',
  'aborted',
]);

export interface FrontendReconstructContext {
  requestId: string;
  /** 客户端断开时由 Controller 触发；runtime 会把取消贯穿到模型与工具。 */
  signal?: AbortSignal;
}

function clipText(value: string, maxCharacters: number): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();
  return Array.from(cleaned).slice(0, maxCharacters).join('').trim();
}

/** needs-input 的追问：只来自结构化不确定项，不解析模型自由文本。 */
export function buildFrontendQuestions(requirement: UiRequirement): FrontendQuestion[] {
  const questions: FrontendQuestion[] = [];
  const push = (field: string, label: string, text: string): void => {
    if (questions.length >= FRONTEND_LIMITS.maxQuestions) return;
    const clippedLabel = clipText(label, FRONTEND_LIMITS.maxLabelChars) || '需要确认';
    const clippedText = clipText(text, FRONTEND_LIMITS.maxQuestionChars);
    if (clippedText.length === 0) return;
    questions.push({ field, label: clippedLabel, text: clippedText });
  };

  for (const region of requirement.unknownRegions) {
    push(
      'requirement.unknownRegions',
      region.label,
      `截图中「${region.label}」的用途无法确定（${region.reason}）。请说明它要保留还是移除。`,
    );
  }
  for (const region of requirement.lowConfidence) {
    push(
      'requirement.lowConfidence',
      '低置信度区域',
      `区域「${region.regionId}」识别置信度较低（${region.reason}）。请确认该区域应保留的布局或数据。`,
    );
  }
  for (const item of requirement.unsupported) {
    push(
      'requirement.unsupported',
      item.label,
      `截图包含 Base 不支持的「${item.label}」（${item.reason}）。请确认接受降级，还是换一张只含受支持能力的截图。`,
    );
  }
  if (questions.length === 0) {
    push(
      'targetPages',
      '目标页面',
      '截图中可识别的内容不足，请补充更清晰的截图，或说明必须保留的页面与关键动作。',
    );
  }
  return questions;
}

@Injectable()
export class FrontendReconstructService {
  private readonly logger = new Logger('FrontendReconstruct');
  private readonly logSink = createAgentLogSink(this.logger);

  constructor(
    @Inject(AGENT_CHAT_MODEL) private readonly model: ChatModel,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}

  async run(raw: unknown, context: FrontendReconstructContext): Promise<FrontendReconstructResponse> {
    const startedAt = Date.now();
    try {
      return await this.execute(raw, context, startedAt);
    } catch (error) {
      throw this.toHttpException(error, context.requestId);
    }
  }

  private async execute(
    raw: unknown,
    context: FrontendReconstructContext,
    startedAt: number,
  ): Promise<FrontendReconstructResponse> {
    const request = parseFrontendReconstructRequest(raw);
    const facts = loadFrontendFacts();
    const pageFacts = loadFrontendPageFacts();
    const runId = `frun-${randomUUID()}`;

    const session = createFrontendReconstructSession({
      runId,
      facts,
      pageFacts,
      targetPages: request.targetPages,
    });
    const registry = new ToolRegistry();
    registry.registerAll(createFrontendReconstructTools(session));

    let result: AgentRunResult;
    try {
      result = await runAgent({
        model: this.model,
        registry,
        systemPrompt: FRONTEND_RECONSTRUCT_SYSTEM_PROMPT,
        userMessage: buildFrontendUserContent({
          utterance: request.utterance,
          targetPages: request.targetPages,
          hasAcceptedFrontendPack: request.current.frontendPack !== null,
          image: request.image,
        }),
        tools: FRONTEND_RECONSTRUCT_TOOL_NAMES,
        maxTokens: this.readInt('FRONTEND_MAX_TOKENS', FRONTEND_MODEL_MAX_TOKENS, 100, FRONTEND_MODEL_MAX_TOKENS),
        limits: {
          maxModelCalls: this.readInt('FRONTEND_MAX_MODEL_CALLS', FRONTEND_LIMITS.maxModelCalls, 1, FRONTEND_LIMITS.maxModelCalls),
          maxToolCalls: this.readInt('FRONTEND_MAX_TOOL_CALLS', FRONTEND_LIMITS.maxToolCalls, 1, FRONTEND_LIMITS.maxToolCalls),
          maxWallClockMs: this.readInt('FRONTEND_TIMEOUT_MS', FRONTEND_LIMITS.maxWallClockMs, 1_000, FRONTEND_LIMITS.maxWallClockMs),
          maxParallelToolCalls: 2,
          maxReplyCharacters: 2_000,
          maxToolResultBytes: 24 * 1024,
          modelMaxAttempts: 2,
          modelRetryBackoffMs: 300,
          toolTimeoutMs: 10_000,
        },
        runId,
        requestId: context.requestId,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
        logger: this.logSink,
        metadata: { surface: request.client.surface, phase: request.client.phase },
      });
    } catch (error) {
      throw this.mapRuntimeError(error);
    }

    if (result.status === 'aborted' || result.stopReason === 'aborted') {
      throw frontendError('FRONTEND_ABORTED');
    }
    if (result.truncated) {
      // 截断/不完整 JSON 一律不解析、不采用。
      throw frontendError('FRONTEND_MODEL_RESPONSE_INVALID', { reason: 'truncated' });
    }

    if (session.requirement === null) {
      throw this.mapMissingRequirement(result);
    }
    const requirement = session.requirement;
    const coverage = buildCapabilityCoverage(requirement, facts, {
      additionalRequiredCapabilities: session.requestedCapabilities,
    });

    let draft: FrontendPackDraft | null = null;
    if (coverage.status !== 'rejected' && session.draft !== null) {
      draft = validateFrontendPackDraftForP1(session.draft, facts, pageFacts);
      assertFrontendPlannedConsistency(requirement, coverage, draft);
    }

    const status: FrontendResponseStatus = coverage.status === 'rejected'
      ? 'rejected'
      : draft !== null
        ? 'planned'
        : 'needs-input';
    const questions = status === 'needs-input' ? buildFrontendQuestions(requirement) : [];
    if (status === 'needs-input' && questions.length === 0) {
      throw frontendError('FRONTEND_MODEL_RESPONSE_INVALID', { reason: 'no_questions' });
    }

    const trace = this.buildTrace(result, coverage, status, requirement);
    const latencyMs = Math.min(
      FRONTEND_LIMITS.maxWallClockMs,
      Math.max(0, Date.now() - startedAt),
    );

    const response: FrontendReconstructResponse = {
      contractVersion: FRONTEND_RECONSTRUCT_CONTRACT_VERSION,
      runId,
      status,
      requirement,
      coverage,
      draft,
      questions,
      trace,
      meta: {
        provider: 'deepseek',
        model: result.model,
        mock: false,
        latencyMs,
      },
    };

    // fail closed：即使内部组装有误，也不把不合契约的响应发出去。
    // pageFacts 与服务端工具/P2 loadPageFacts 同源；响应校验也按页复核 draft。
    validateFrontendReconstructResponseForP1(response, facts, {
      targetPages: request.targetPages,
      pageFacts,
    });

    this.logger.log(
      `frontend reconstruct requestId=${context.requestId} runId=${runId} status=${status} coverage=${coverage.status} stopReason=${trace.stopReason} modelCalls=${trace.modelCalls} toolCalls=${trace.toolCalls.length} latencyMs=${latencyMs}`,
    );

    return response;
  }

  private buildTrace(
    result: AgentRunResult,
    coverage: CapabilityCoverageReport,
    status: FrontendResponseStatus,
    requirement: UiRequirement,
  ): FrontendTrace {
    const toolCalls: FrontendTraceToolCall[] = [];
    let unknownToolAttempted = false;
    for (const trace of result.toolCalls) {
      if (!ALLOWED_TOOL_NAMES.has(trace.name)) {
        // 模型幻觉出的工具名不进入 trace（契约只允许四个工具），但如实标记降级。
        unknownToolAttempted = true;
        continue;
      }
      if (toolCalls.length >= FRONTEND_LIMITS.maxTraceToolCalls) continue;
      toolCalls.push({ name: trace.name as FrontendToolName, ok: trace.ok });
    }

    const stopReason = this.mapStopReason(result.stopReason, status);
    const degraded =
      result.degraded
      || unknownToolAttempted
      || coverage.status === 'partial'
      || requirement.degradations.length > 0
      || coverage.degradations.length > 0;

    return {
      modelCalls: result.modelCalls,
      toolCalls,
      stopReason,
      degraded,
    };
  }

  private mapStopReason(resultStop: string, status: FrontendResponseStatus): FrontendStopReason {
    if (status === 'needs-input') {
      if (resultStop === 'loop_detected' || resultStop === 'time_limit') {
        return resultStop;
      }
      return 'needs_input';
    }
    if (status === 'rejected') {
      return resultStop === 'loop_detected' ? 'loop_detected' : 'rejected';
    }
    if (ALLOWED_STOP_REASONS.has(resultStop) && resultStop !== 'aborted' && resultStop !== 'needs_input' && resultStop !== 'rejected') {
      return resultStop as FrontendStopReason;
    }
    return 'final_answer';
  }

  /** requirement 都没拿到：没有可返回的契约响应，按运行终止原因给稳定错误码。 */
  private mapMissingRequirement(result: AgentRunResult): FrontendReconstructError {
    switch (result.stopReason) {
      case 'time_limit':
        return frontendError('FRONTEND_TIME_LIMIT');
      case 'max_model_calls':
        return frontendError('FRONTEND_MODEL_CALL_LIMIT');
      case 'max_tool_calls':
        return frontendError('FRONTEND_TOOL_CALL_LIMIT');
      default:
        return frontendError('FRONTEND_MODEL_RESPONSE_INVALID', {
          reason: 'requirement_missing',
          stopReason: result.stopReason,
          failedTools: result.toolCalls.filter((call) => !call.ok).length,
        });
    }
  }

  private mapRuntimeError(error: unknown): unknown {
    if (error instanceof AgentAbortedError) return frontendError('FRONTEND_ABORTED');
    if (error instanceof AgentModelError) return error;
    if (error instanceof AgentConfigurationError) return frontendError('FRONTEND_INTERNAL_ERROR');
    if (error instanceof AgentLimitError) return frontendError('FRONTEND_TIME_LIMIT');
    return error;
  }

  private readInt(key: string, fallback: number, min: number, max: number): number {
    const raw = this.config.get<unknown>(key);
    const value = Number(raw);
    return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
  }

  private toHttpException(error: unknown, requestId: string): HttpException {
    if (error instanceof HttpException) return error;
    if (error instanceof FrontendReconstructError) {
      // 只记录稳定 code 与结构化 details（path/reason/stopReason），不记录正文/图片/提示词。
      this.logger.warn(
        `frontend reconstruct rejected requestId=${requestId} code=${error.code} details=${JSON.stringify(sanitizeFrontendLogDetails(error.details))}`,
      );
      return error.toHttpException();
    }
    if (error instanceof AgentAbortedError) return frontendError('FRONTEND_ABORTED').toHttpException();
    if (error instanceof AgentModelError) {
      this.logger.warn(
        `frontend reconstruct model failed requestId=${requestId} code=${error.code} retryable=${error.retryable}`,
      );
      const status = MODEL_ERROR_STATUS[error.code] ?? HttpStatus.BAD_GATEWAY;
      return new HttpException({ code: error.code, message: error.message }, status);
    }
    if (error instanceof AgentConfigurationError || error instanceof AgentLimitError) {
      this.logger.error(
        `frontend reconstruct failed requestId=${requestId} code=${error.code} name=${error.name}`,
      );
      return frontendError('FRONTEND_INTERNAL_ERROR').toHttpException();
    }

    const name = error instanceof Error ? error.name : typeof error;
    this.logger.error(`frontend reconstruct failed requestId=${requestId} name=${name}`);
    return frontendError('FRONTEND_INTERNAL_ERROR').toHttpException();
  }
}

/** 供 Controller / 测试复用：是否为契约目标页（避免把任意字符串当 pageId）。 */
export function isFrontendTargetPage(value: unknown): value is FrontendTargetPageId {
  return value === 'home' || value === 'menu';
}
