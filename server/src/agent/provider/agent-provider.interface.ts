import type { ContractDraft } from '../agent.types';

/** 校验通过后交给 Provider 的图片描述（纯 base64，不含 data: 前缀）。 */
export interface AgentProviderImage {
  kind: 'menu' | 'store';
  mediaType: string;
  data: string;
  /** 解码后的真实字节数，仅用于日志计数。 */
  bytes: number;
}

export interface AgentProviderExtractInput {
  utterance: string;
  draft: ContractDraft;
  requestId?: string;
  /**
   * v2 才可能非空。有图片时 Provider 必须把用户消息构造成
   * `[{type:'text'}, {type:'image_url'}, ...]` 多模态数组，
   * 并使用视觉模型；没有图片时必须保持字符串，与 v1 请求完全一致。
   */
  images?: AgentProviderImage[];
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
  /** 本次是否真的发起了视觉模型请求（用于 v2 响应的 vision.analyzed）。 */
  visionAnalyzed?: boolean;
}

export interface AgentProvider {
  readonly name: string;
  extractTurn(input: AgentProviderExtractInput): Promise<AgentProviderExtractResult>;
}

export type AgentFetch = (input: string, init?: RequestInit) => Promise<Response>;