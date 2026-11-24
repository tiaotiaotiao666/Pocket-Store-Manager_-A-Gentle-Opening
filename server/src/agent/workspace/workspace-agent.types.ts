/**
 * workspace-agent.v1 类型与注入令牌。
 *
 * 唯一的机器可读事实源是 `contracts/workspace-agent.v1.json`；
 * 这里只声明 TypeScript 形状与代理接口，不复制 operation/tool/limit 列表。
 */

import type { JsonSchema } from '../runtime';

export type WorkspaceOperation = 'plan' | 'edit' | 'repair' | 'explain';

export interface WorkspaceToolContract {
  name: string;
  rpc: string;
  description: string;
  sideEffect: 'read' | 'write';
  parameters: JsonSchema;
}

export interface WorkspaceAgentLimits {
  maxRequestBytes: number;
  maxUtteranceCharacters: number;
  maxImages: number;
  maxImageCaptionCharacters: number;
  maxToolResults: number;
  maxToolResultReferenceBytes: number;
  maxModelCalls: number;
  maxToolCalls: number;
  maxWallClockMs: number;
  maxParallelToolCalls: number;
  maxReplyCharacters: number;
  maxToolResultBytes: number;
  toolTimeoutMs: number;
  modelMaxAttempts: number;
  modelRetryBackoffMs: number;
  maxFileChanges: number;
  maxFileContentBytes: number;
}

export interface WorkspaceAgentContract {
  schemaVersion: string;
  contractVersion: string;
  endpoint: string;
  operations: WorkspaceOperation[];
  request: {
    allowedKeys: string[];
    requiredKeys: string[];
    properties: Record<string, unknown>;
  };
  response: {
    allowedKeys: string[];
    forbiddenKeys: string[];
    properties: Record<string, unknown>;
  };
  tools: WorkspaceToolContract[];
  operationTools: Record<WorkspaceOperation, string[]>;
  limits: WorkspaceAgentLimits;
  errorCodes: string[];
  mock: { requestKey: string; responseMetaKey: string; tools: string[] };
}

export interface WorkspaceImageReference {
  assetId: string;
  caption?: string;
}

export interface WorkspaceToolResultReference {
  callId: string;
  name: string;
  ok: boolean;
  dataRef?: string;
}

export interface WorkspaceAgentRequest {
  contractVersion: string;
  projectId: string;
  runId?: string;
  turnId?: string;
  operation: WorkspaceOperation;
  utterance: string;
  images?: WorkspaceImageReference[];
  toolResults?: WorkspaceToolResultReference[];
  mock?: boolean;
}

export interface WorkspaceAgentPlanStep {
  name: string;
  status: 'planned' | 'done' | 'failed';
}

export interface WorkspaceAgentPlan {
  operation: WorkspaceOperation;
  targetPage: string | null;
  steps: WorkspaceAgentPlanStep[];
}

export interface WorkspaceAgentToolTrace {
  name: string;
  ok: boolean;
  latencyMs: number;
  attempts: number;
  bytes: number;
  truncated: boolean;
}

export interface WorkspaceAgentTrace {
  modelCalls: number;
  toolCalls: WorkspaceAgentToolTrace[];
  stopReason: string;
  degraded: boolean;
}

export interface WorkspaceAgentMeta {
  mock: boolean;
  model: string;
  latencyMs: number;
}

export interface WorkspaceAgentResponse {
  contractVersion: string;
  runId: string;
  operation: WorkspaceOperation;
  reply: string;
  plan: WorkspaceAgentPlan;
  trace: WorkspaceAgentTrace;
  stopReason: string;
  meta: WorkspaceAgentMeta;
}

export interface WorkspaceRpcCallContext {
  projectId: string;
  runId: string;
  turnId: string | null;
  operation: WorkspaceOperation;
  signal: AbortSignal;
  timeoutMs: number;
}

export interface WorkspaceRpcSuccess {
  ok: true;
  data: unknown;
}

export interface WorkspaceRpcFailure {
  ok: false;
  code: string;
  message: string;
  issues?: Array<{
    code: string;
    severity?: 'low' | 'medium' | 'high';
    file?: string;
    line?: number;
    column?: number;
    message: string;
    source?: string;
  }>;
}

export type WorkspaceRpcResult = WorkspaceRpcSuccess | WorkspaceRpcFailure;

/**
 * 桌面 B3 的受控 RPC 代理；服务端只调用这个接口，绝不直接访问本机磁盘。
 * 生产接线由 D2/桌面进程提供；HTTP 服务未注入时代理确定性返回 WORKSPACE_RPC_UNAVAILABLE。
 */
export interface WorkspaceRpcProxy {
  invoke(
    command: string,
    payload: Record<string, unknown>,
    context: WorkspaceRpcCallContext,
  ): Promise<WorkspaceRpcResult>;
}

export const WORKSPACE_AGENT_RPC_PROXY = 'SMART_STORE_WORKSPACE_RPC_PROXY';
export const WORKSPACE_AGENT_CHAT_MODEL = 'SMART_STORE_WORKSPACE_CHAT_MODEL';
