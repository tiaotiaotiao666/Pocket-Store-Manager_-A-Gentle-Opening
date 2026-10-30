/**
 * agent-turn.v1 契约类型。
 *
 * 约定：
 * - 对外只暴露 priceCents（整数分），绝不出现 priceText。
 * - 服务端内部用 InternalDraft 承载“尚未校验”的价格值，便于把非法值报告成错误，
 *   而不是静默丢弃或臆造价格。
 */

export const AGENT_TURN_CONTRACT_VERSION = 'agent-turn.v1';

/** AgentProvider 的注入令牌（显式 token，避免依赖 emitDecoratorMetadata）。 */
export const AGENT_PROVIDER = 'SMART_STORE_AGENT_PROVIDER';

/** fetch 实现的注入令牌，测试时可替换为 stub，禁止真实请求 DeepSeek。 */
export const AGENT_FETCH = 'SMART_STORE_AGENT_FETCH';

export interface ContractFulfillment {
  dineIn: boolean;
  takeaway: boolean;
}

export interface ContractDish {
  id: string;
  name: string;
  priceCents: number | null;
  description: string;
}

export interface ContractDraft {
  storeName: string;
  category: string;
  businessHours: string;
  fulfillment: ContractFulfillment;
  dishes: ContractDish[];
}

/** 内部草稿：priceCents 可能是任意类型，校验器负责把它报告成 PRICE_INVALID。 */
export interface InternalDraftDish {
  id: string;
  name: string;
  priceCents: unknown;
  description: string;
}

export interface InternalDraft {
  storeName: string;
  category: string;
  businessHours: string;
  fulfillment: ContractFulfillment;
  dishes: InternalDraftDish[];
}

export interface MissingField {
  field: string;
  label: string;
  detail: string;
}

export interface FieldError {
  field: string;
  code: string;
  message: string;
}

export interface AgentQuestion {
  field: string;
  label: string;
  text: string;
}

export interface DraftValidation {
  missingFields: MissingField[];
  errors: FieldError[];
  readyForReview: boolean;
}

export type AgentTurnStatus = 'collecting' | 'reviewing';

export interface AgentTurnRequest {
  contractVersion: string;
  utterance: string;
  draft: ContractDraft;
  client: {
    surface: 'desktop';
    phase: 'store-info';
  };
  projectId: string | null;
}

export interface AgentTurnMeta {
  transport: 'http';
  provider: string;
  mock: false;
  model: string | null;
  latencyMs: number;
}

export interface AgentTurnResponse {
  contractVersion: string;
  turnId: string;
  status: AgentTurnStatus;
  reply: string;
  draft: ContractDraft;
  missingFields: MissingField[];
  errors: FieldError[];
  nextQuestion: AgentQuestion | null;
  meta: AgentTurnMeta;
}

export interface AgentTurnContext {
  requestId: string;
}