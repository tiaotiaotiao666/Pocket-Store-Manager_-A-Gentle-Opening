import type { ContractDraft } from '../agent.types';

export interface AgentProviderExtractInput {
  utterance: string;
  draft: ContractDraft;
  requestId?: string;
}

/**
 * Provider 只返回“模型说了什么”。
 * status / missingFields / errors / readyForReview 一律由后端校验器生成，
 * 模型返回的同名字段会被忽略。
 */
export interface AgentProviderExtractResult {
  reply: string;
  draftPatch: unknown;
  model?: string | null;
  latencyMs?: number;
}

export interface AgentProvider {
  readonly name: string;
  extractTurn(input: AgentProviderExtractInput): Promise<AgentProviderExtractResult>;
}

export type AgentFetch = (input: string, init?: RequestInit) => Promise<Response>;