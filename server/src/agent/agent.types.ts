/**
 * agent-turn.v1 契约类型。
 *
 * 约定：
 * - 对外只暴露 priceCents（整数分），绝不出现 priceText。
 * - 服务端内部用 InternalDraft 承载“尚未校验”的价格值，便于把非法值报告成错误，
 *   而不是静默丢弃或臆造价格。
 */

export const AGENT_TURN_CONTRACT_VERSION = 'agent-turn.v1';

/**
 * v2 契约版本标识（C-AGENT-TURN-V2@1）。
 *
 * 与 v1 共用 `POST /api/v1/agent/turn`，由 service 按 `contractVersion` 分派：
 * - 缺省 / `agent-turn.v1` → v1 逻辑，响应字段与既有实现完全一致（不含 vision）；
 * - 仅当显式传 `agent-turn.v2` 时才进入 v2 校验与多模态路径，绝不静默升级；
 * - 其他取值 → 400 `AGENT_CONTRACT_MISMATCH`。
 */
export const AGENT_TURN_V2_CONTRACT_VERSION = 'agent-turn.v2';

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

/** v1 响应的显式别名：v1 请求的响应里永远不会出现 `vision` 键。 */
export type AgentTurnV1Response = AgentTurnResponse;

/** v2 视觉摘要（只报计数与状态，绝不携带图片内容）。 */
export interface AgentTurnVisionSummary {
  menuImages: number;
  storeImages: number;
  /** 是否真的发起了视觉模型请求。 */
  analyzed: boolean;
  /** 视觉降级标记；当前实现“失败即失败”，恒为 false。 */
  degraded: boolean;
}

export interface AgentTurnV2Response extends AgentTurnV1Response {
  contractVersion: 'agent-turn.v2';
  vision: AgentTurnVisionSummary | null;
}

export interface AgentTurnContext {
  requestId: string;
}