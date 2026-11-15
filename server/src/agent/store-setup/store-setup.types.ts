/**
 * agent-run.v1 契约类型。
 *
 * 与 agent-turn.v1 的区别：本契约允许模型进行多轮工具调用，
 * 响应中追加 trace，用于观测每一步发生了什么；draft 仍以服务端校验结果为准。
 */

import type { AgentQuestion, ContractDraft, FieldError, MissingField } from '../agent.types';
import type { AgentStopReason } from '../runtime';

export const AGENT_RUN_CONTRACT_VERSION = 'agent-run.v1';

export interface StoreSetupRunRequest {
  contractVersion: string;
  utterance: string;
  draft: ContractDraft;
  client: {
    surface: 'desktop';
    phase: 'store-info';
  };
  projectId: string | null;
}

/** 单次工具调用的可观测信息。刻意不包含参数与结果正文。 */
export interface StoreSetupToolTrace {
  callId: string;
  name: string;
  ok: boolean;
  errorCode?: string;
  latencyMs: number;
  attempts: number;
  truncated: boolean;
}

export interface StoreSetupRunTrace {
  modelCalls: number;
  toolCalls: StoreSetupToolTrace[];
  stopReason: AgentStopReason;
  /** 运行未正常完成、最终回复为空，或存在失败的工具调用。 */
  degraded: boolean;
}

export interface StoreSetupRunMeta {
  transport: 'http';
  provider: 'deepseek';
  mock: false;
  model: string;
  latencyMs: number;
  runId: string;
}

export interface StoreSetupRunResponse {
  contractVersion: 'agent-run.v1';
  runId: string;
  status: 'collecting' | 'reviewing';
  reply: string;
  draft: ContractDraft;
  missingFields: MissingField[];
  errors: FieldError[];
  nextQuestion: AgentQuestion | null;
  trace: StoreSetupRunTrace;
  meta: StoreSetupRunMeta;
}
