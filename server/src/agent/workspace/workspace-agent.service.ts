/**
 * workspace-agent.v1 服务：复用 runtime 的模型↔工具循环。
 *
 * 边界：
 * - 工具执行只经注入的 WorkspaceRpcProxy；服务端不读本机磁盘、不执行命令；
 * - 响应只含 reply/plan/trace/stopReason/meta；采用/导出/验证状态只由本地事实与用户操作决定，
 *   模型回复（reply）只是参考文本——服务端**只脱敏敏感信息**（本机绝对路径、file:// 引用），
 *   不用正则把模型的「已采用/已验证」措辞改写成别的说法（rev15 §14.12-3）；
 * - mock:true 显式走离线模型与 mock 代理；真实路径使用注入的 DEEPSEEK ChatModel；
 * - 所有请求上限来自 contracts/workspace-agent.v1.json。
 */

import { HttpException, HttpStatus, Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { AGENT_CHAT_MODEL } from '../agent.types';
import {
  AgentAbortedError,
  AgentConfigurationError,
  AgentLimitError,
  AgentModelError,
  runAgent,
} from '../runtime';
import type { AgentRunResult, ChatModel } from '../runtime';
import type {
  WorkspaceAgentContract,
  WorkspaceAgentPlan,
  WorkspaceAgentRequest,
  WorkspaceAgentResponse,
  WorkspaceAgentToolTrace,
  WorkspaceOperation,
  WorkspaceRpcProxy,
} from './workspace-agent.types';
import { WORKSPACE_AGENT_RPC_PROXY } from './workspace-agent.types';
import { loadWorkspaceAgentContract } from './workspace-agent.contract';
import { createWorkspaceToolRegistry } from './workspace-agent.tools';
import { isWorkspaceRpcProxy, UnavailableWorkspaceRpcProxy } from './workspace-agent.rpc';
import { MockWorkspaceChatModel, MockWorkspaceRpcProxy } from './workspace-agent.mock';

interface WorkspaceRunContext {
  requestId: string;
  signal?: AbortSignal;
}

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

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function codepointLength(value: string): number {
  return Array.from(value).length;
}

function reject(code: string, message: string, status = HttpStatus.BAD_REQUEST): never {
  throw new HttpException({ code, message }, status);
}

function patternFor(contract: WorkspaceAgentContract, key: string): RegExp | null {
  const property = contract.request.properties[key];
  if (!isPlainObject(property) || typeof property.pattern !== 'string') return null;
  return new RegExp(property.pattern);
}

/** 只脱敏「敏感信息」（本机绝对路径 / file:// 引用）；**不改写模型措辞**。 */
function sanitizeReply(reply: string): string {
  const text = typeof reply === 'string' ? reply.trim() : '';
  return text
    .replace(/[A-Za-z]:[\\/][^\s，。；、]+/g, '[path]')
    .replace(/file:\/\/[^\s，。；、]+/gi, '[path]');
}

function buildSystemPrompt(request: WorkspaceAgentRequest): string {
  const lines = [
    '你是「口袋店长·轻启」的 Workspace Agent，只负责当前项目的受控源码工作区。',
    '操作：' + request.operation + '；项目：' + request.projectId + '。',
    '必须通过工具读取/写入/检查项目；工具执行由桌面受控代理完成，你不得假设文件系统、命令或网络可用。',
    '只可提出或执行与当前操作相关的改动；不得编造文件内容、检查结果、截图或版本状态。',
    '绝不声称 applied / adopted / exported / verified；采用、导出与最终验证只能由本地事实和用户操作决定。',
    '最终用简体中文简洁说明你做了什么、还缺什么；不要输出 JSON、源码全文或绝对路径。',
  ];
  if (request.images && request.images.length > 0) {
    lines.push('参考图片引用（只作为附件 ID，不是可访问 URL）：' + request.images.map((image) => image.assetId + (image.caption ? '(' + image.caption + ')' : '')).join('、'));
  }
  if (request.toolResults && request.toolResults.length > 0) {
    lines.push('已有工具结果引用：' + request.toolResults.map((item) => item.name + '=' + (item.ok ? 'ok' : 'failed')).join('、'));
  }
  return lines.join('\n');
}

export function parseWorkspaceRequest(raw: unknown, contract: WorkspaceAgentContract): WorkspaceAgentRequest {
  if (!isPlainObject(raw)) reject('WORKSPACE_REQUEST_INVALID', '请求体必须是 JSON 对象。');
  const serialized = JSON.stringify(raw);
  if (byteLength(serialized) > contract.limits.maxRequestBytes) {
    reject('WORKSPACE_BODY_TOO_LARGE', '请求体超过上限。', HttpStatus.PAYLOAD_TOO_LARGE);
  }
  for (const key of Object.keys(raw)) {
    if (!contract.request.allowedKeys.includes(key)) {
      reject('WORKSPACE_REQUEST_INVALID', '请求体包含未知字段：' + key);
    }
  }
  for (const key of contract.request.requiredKeys) {
    if (!(key in raw)) reject('WORKSPACE_REQUEST_INVALID', '缺少必填字段：' + key);
  }
  if (raw.contractVersion !== contract.contractVersion) {
    reject('WORKSPACE_CONTRACT_MISMATCH', 'contractVersion 必须为 ' + contract.contractVersion + '。');
  }
  const projectId = typeof raw.projectId === 'string' ? raw.projectId : '';
  const projectPattern = patternFor(contract, 'projectId');
  if (!projectId || (projectPattern && !projectPattern.test(projectId))) {
    reject('WORKSPACE_REQUEST_INVALID', 'projectId 格式非法。');
  }
  for (const key of ['runId', 'turnId'] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== 'string' || (patternFor(contract, key) && !patternFor(contract, key)!.test(raw[key] as string))) {
      reject('WORKSPACE_REQUEST_INVALID', key + ' 格式非法。');
    }
  }
  const operation = raw.operation;
  if (typeof operation !== 'string' || !contract.operations.includes(operation as WorkspaceOperation)) {
    reject('WORKSPACE_OPERATION_UNSUPPORTED', 'operation 必须是 ' + contract.operations.join('|') + '。');
  }
  const utterance = typeof raw.utterance === 'string' ? raw.utterance.trim() : '';
  const utteranceLength = codepointLength(utterance);
  if (utteranceLength < 1 || utteranceLength > contract.limits.maxUtteranceCharacters) {
    reject('WORKSPACE_REQUEST_INVALID', 'utterance 必须是 1–' + contract.limits.maxUtteranceCharacters + ' 字的文本。');
  }
  if (raw.mock !== undefined && typeof raw.mock !== 'boolean') {
    reject('WORKSPACE_REQUEST_INVALID', 'mock 必须是布尔值。');
  }

  let images: WorkspaceAgentRequest['images'];
  if (raw.images !== undefined) {
    if (!Array.isArray(raw.images)) reject('WORKSPACE_REQUEST_INVALID', 'images 必须是数组。');
    if (raw.images.length > contract.limits.maxImages) {
      reject('WORKSPACE_IMAGE_LIMIT', '图片引用不能超过 ' + contract.limits.maxImages + ' 个。');
    }
    images = raw.images.map((item) => {
      if (!isPlainObject(item)) reject('WORKSPACE_REQUEST_INVALID', '图片引用必须是对象。');
      for (const key of Object.keys(item)) {
        if (key !== 'assetId' && key !== 'caption') reject('WORKSPACE_REQUEST_INVALID', '图片引用包含未知字段。');
      }
      const assetId = typeof item.assetId === 'string' ? item.assetId : '';
      if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(assetId) || /^data:/i.test(assetId) || /^https?:/i.test(assetId)) {
        reject('WORKSPACE_REQUEST_INVALID', '图片 assetId 非法（只接受附件 ID，不接受 URL/base64）。');
      }
      if (item.caption !== undefined) {
        if (typeof item.caption !== 'string' || codepointLength(item.caption) > contract.limits.maxImageCaptionCharacters) {
          reject('WORKSPACE_REQUEST_INVALID', '图片 caption 过长。');
        }
      }
      return { assetId, ...(item.caption === undefined ? {} : { caption: item.caption }) };
    });
  }

  let toolResults: WorkspaceAgentRequest['toolResults'];
  if (raw.toolResults !== undefined) {
    if (!Array.isArray(raw.toolResults)) reject('WORKSPACE_REQUEST_INVALID', 'toolResults 必须是数组。');
    if (raw.toolResults.length > contract.limits.maxToolResults) {
      reject('WORKSPACE_TOOL_RESULT_LIMIT', '工具结果引用不能超过 ' + contract.limits.maxToolResults + ' 个。');
    }
    const toolNames = new Set(contract.tools.map((tool) => tool.name));
    toolResults = raw.toolResults.map((item) => {
      if (!isPlainObject(item)) reject('WORKSPACE_REQUEST_INVALID', 'toolResults 条目必须是对象。');
      for (const key of Object.keys(item)) {
        if (!['callId', 'name', 'ok', 'dataRef'].includes(key)) reject('WORKSPACE_REQUEST_INVALID', 'toolResults 条目包含未知字段。');
      }
      if (typeof item.callId !== 'string' || item.callId.length < 1 || item.callId.length > 120) reject('WORKSPACE_REQUEST_INVALID', 'toolResults.callId 非法。');
      if (typeof item.name !== 'string' || !toolNames.has(item.name)) reject('WORKSPACE_REQUEST_INVALID', 'toolResults.name 不是注册工具。');
      if (typeof item.ok !== 'boolean') reject('WORKSPACE_REQUEST_INVALID', 'toolResults.ok 必须是布尔值。');
      if (item.dataRef !== undefined) {
        if (typeof item.dataRef !== 'string' || byteLength(item.dataRef) > contract.limits.maxToolResultReferenceBytes) {
          reject('WORKSPACE_TOOL_RESULT_LIMIT', 'toolResults.dataRef 超过上限。');
        }
      }
      return {
        callId: item.callId,
        name: item.name,
        ok: item.ok,
        ...(item.dataRef === undefined ? {} : { dataRef: item.dataRef }),
      };
    });
  }

  return {
    contractVersion: contract.contractVersion,
    projectId,
    ...(typeof raw.runId === 'string' ? { runId: raw.runId } : {}),
    ...(typeof raw.turnId === 'string' ? { turnId: raw.turnId } : {}),
    operation: operation as WorkspaceOperation,
    utterance,
    ...(images === undefined ? {} : { images }),
    ...(toolResults === undefined ? {} : { toolResults }),
    ...(raw.mock === true ? { mock: true } : {}),
  };
}

@Injectable()
export class WorkspaceAgentService {
  private readonly logger = new Logger('WorkspaceAgent');
  private readonly contract: WorkspaceAgentContract;

  constructor(
    @Optional() @Inject(AGENT_CHAT_MODEL) private readonly model: ChatModel | null,
    @Optional() @Inject(WORKSPACE_AGENT_RPC_PROXY) private readonly proxy: WorkspaceRpcProxy | null,
  ) {
    this.contract = loadWorkspaceAgentContract();
  }

  async run(raw: unknown, context: WorkspaceRunContext): Promise<WorkspaceAgentResponse> {
    const startedAt = Date.now();
    const request = parseWorkspaceRequest(raw, this.contract);
    const mock = request.mock === true;
    const model = mock ? new MockWorkspaceChatModel(request.operation, this.contract) : this.model;
    if (!model) {
      reject('DEEPSEEK_NOT_CONFIGURED', '模型未配置，无法运行 Workspace Agent。', HttpStatus.SERVICE_UNAVAILABLE);
    }
    const proxy = mock
      ? new MockWorkspaceRpcProxy()
      : (isWorkspaceRpcProxy(this.proxy) ? this.proxy : new UnavailableWorkspaceRpcProxy());

    let result: AgentRunResult;
    try {
      result = await runAgent({
        model,
        registry: createWorkspaceToolRegistry(proxy, this.contract),
        systemPrompt: buildSystemPrompt(request),
        userMessage: request.utterance,
        tools: this.contract.operationTools[request.operation],
        limits: {
          maxModelCalls: this.contract.limits.maxModelCalls,
          maxToolCalls: this.contract.limits.maxToolCalls,
          maxWallClockMs: this.contract.limits.maxWallClockMs,
          maxParallelToolCalls: this.contract.limits.maxParallelToolCalls,
          maxReplyCharacters: this.contract.limits.maxReplyCharacters,
          maxToolResultBytes: this.contract.limits.maxToolResultBytes,
          modelMaxAttempts: this.contract.limits.modelMaxAttempts,
          modelRetryBackoffMs: this.contract.limits.modelRetryBackoffMs,
          toolTimeoutMs: this.contract.limits.toolTimeoutMs,
        },
        maxTokens: this.contract.limits.maxReplyCharacters,
        runId: request.runId,
        requestId: context.requestId,
        signal: context.signal,
        metadata: {
          projectId: request.projectId,
          turnId: request.turnId ?? '',
          operation: request.operation,
          mock: mock ? 'true' : 'false',
        },
      });
    } catch (error) {
      throw this.toHttpException(error, context.requestId);
    }

    const toolCalls: WorkspaceAgentToolTrace[] = result.toolCalls.map((trace) => ({
      name: trace.name,
      ok: trace.ok,
      latencyMs: trace.latencyMs,
      attempts: trace.attempts,
      bytes: trace.outputBytes,
      truncated: trace.truncated,
    }));
    const failedTools = toolCalls.filter((trace) => !trace.ok).length;
    const steps = toolCalls.map((trace) => ({ name: trace.name, status: trace.ok ? 'done' as const : 'failed' as const }));
    const plan: WorkspaceAgentPlan = { operation: request.operation, targetPage: null, steps };
    const degraded = result.degraded || failedTools > 0;
    const reply = sanitizeReply(result.reply) || (degraded ? '这次没有完成可用的工作区操作，请补充信息或重试。' : '已完成。');
    const latencyMs = Math.max(0, Date.now() - startedAt);

    this.logger.log(
      'workspace run requestId=' + context.requestId + ' runId=' + result.runId + ' operation=' + request.operation +
      ' mock=' + mock + ' stopReason=' + result.stopReason + ' modelCalls=' + result.modelCalls +
      ' toolCalls=' + toolCalls.length + ' failedTools=' + failedTools + ' latencyMs=' + latencyMs,
    );

    return {
      contractVersion: this.contract.contractVersion,
      runId: result.runId,
      operation: request.operation,
      reply,
      plan,
      trace: {
        modelCalls: result.modelCalls,
        toolCalls,
        stopReason: result.stopReason,
        degraded,
      },
      stopReason: result.stopReason,
      meta: {
        mock,
        model: mock ? 'workspace-mock' : result.model,
        latencyMs,
      },
    };
  }

  private toHttpException(error: unknown, requestId: string): HttpException {
    if (error instanceof AgentModelError) {
      const status = MODEL_ERROR_STATUS[error.code] ?? HttpStatus.BAD_GATEWAY;
      return new HttpException({ code: error.code, message: error.message }, status);
    }
    if (error instanceof AgentAbortedError) {
      return new HttpException({ code: 'AGENT_ABORTED', message: '本次请求已取消。' }, HttpStatus.REQUEST_TIMEOUT);
    }
    if (error instanceof AgentConfigurationError || error instanceof AgentLimitError) {
      this.logger.error('workspace run failed requestId=' + requestId + ' code=' + error.code);
      return new HttpException({ code: 'AGENT_INTERNAL_ERROR', message: 'Workspace Agent 暂时不可用。' }, HttpStatus.INTERNAL_SERVER_ERROR);
    }
    const name = error instanceof Error ? error.name : typeof error;
    this.logger.error('workspace run failed requestId=' + requestId + ' name=' + name);
    return new HttpException({ code: 'AGENT_INTERNAL_ERROR', message: 'Workspace Agent 暂时不可用。' }, HttpStatus.INTERNAL_SERVER_ERROR);
  }
}
