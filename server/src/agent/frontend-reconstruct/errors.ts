import { HttpException } from '@nestjs/common';

/**
 * `frontend-reconstruct.v1` 稳定错误码表。
 *
 * 约定：
 * - code 是机器可读的稳定事实，客户端/测试只认 code，不解析中文文案；
 * - message 是固定文案，**绝不回填用户输入、base64、模型原文、路径或堆栈**；
 * - `details` 只允许放结构化定位信息（如 `$.images`），由调用方显式传入；
 * - `retryable` 只表示“同一请求重试是否可能成功”，不触发自动重试。
 */

export interface FrontendErrorDefinition {
  httpStatus: number;
  retryable: boolean;
  message: string;
}

export const FRONTEND_ERROR_DEFINITIONS = {
  FRONTEND_REQUEST_INVALID: {
    httpStatus: 400,
    retryable: false,
    message: '请求格式不符合 frontend-reconstruct.v1 契约。',
  },
  FRONTEND_CONTRACT_MISMATCH: {
    httpStatus: 400,
    retryable: false,
    message: 'contractVersion 必须是 frontend-reconstruct.v1。',
  },
  FRONTEND_UTTERANCE_INVALID: {
    httpStatus: 400,
    retryable: false,
    message: 'utterance 超过长度上限或包含控制字符。',
  },
  FRONTEND_IMAGE_REQUIRED: {
    httpStatus: 400,
    retryable: false,
    message: '必须提供恰好一张 kind="reference" 的参考截图。',
  },
  FRONTEND_IMAGE_COUNT_INVALID: {
    httpStatus: 400,
    retryable: false,
    message: '参考截图必须且只能有 1 张。',
  },
  FRONTEND_IMAGE_KIND_INVALID: {
    httpStatus: 400,
    retryable: false,
    message: 'frontend-reconstruct.v1 只接受 kind="reference" 的图片。',
  },
  FRONTEND_IMAGE_TYPE_UNSUPPORTED: {
    httpStatus: 422,
    retryable: false,
    message: '参考截图仅支持 JPEG、PNG、WebP。',
  },
  FRONTEND_IMAGE_INVALID: {
    httpStatus: 422,
    retryable: false,
    message: '参考截图不是合法 base64 或与声明的 mediaType 不符。',
  },
  FRONTEND_IMAGE_TOO_LARGE: {
    httpStatus: 422,
    retryable: false,
    message: '参考截图超过体积上限，请压缩后重试。',
  },
  FRONTEND_TARGET_PAGES_UNSUPPORTED: {
    httpStatus: 422,
    retryable: false,
    message: 'targetPages 首期仅支持 home/menu。',
  },
  FRONTEND_REQUIREMENT_INVALID: {
    httpStatus: 422,
    retryable: false,
    message: 'UiRequirement/VisualSpec 不符合契约或引用了未注入的事实。',
  },
  FRONTEND_COVERAGE_INVALID: {
    httpStatus: 422,
    retryable: false,
    message: 'CapabilityCoverageReport 与服务端能力事实不一致。',
  },
  FRONTEND_COVERAGE_REJECTED: {
    httpStatus: 422,
    retryable: false,
    message: '缺少必需的页面、组件、数据或控制器动作，不能生成候选。',
  },
  FRONTEND_DRAFT_INVALID: {
    httpStatus: 422,
    retryable: false,
    message: 'FrontendPackDraft 不符合受控 DSL 契约。',
  },
  FRONTEND_RESPONSE_INVALID: {
    httpStatus: 502,
    retryable: false,
    message: '服务端响应不符合 frontend-reconstruct.v1 契约。',
  },
  FRONTEND_STATE_TRANSITION_INVALID: {
    httpStatus: 409,
    retryable: false,
    message: '当前运行状态不允许该状态迁移。',
  },
  FRONTEND_REPAIR_ISSUES_INVALID: {
    httpStatus: 422,
    retryable: false,
    message: 'repair 只接受有界的结构化 issues（path + code）。',
  },
  FRONTEND_REPAIR_LIMIT_EXCEEDED: {
    httpStatus: 409,
    retryable: false,
    message: '本 run 的修复次数已达上限（最多 2 轮）。',
  },
  FRONTEND_FACTS_INVALID: {
    httpStatus: 500,
    retryable: false,
    message: '服务端注入的能力事实快照不合法。',
  },
  FRONTEND_ABORTED: {
    httpStatus: 499,
    retryable: false,
    message: '本次重构运行已取消。',
  },
  FRONTEND_TIME_LIMIT: {
    httpStatus: 504,
    retryable: true,
    message: '本次重构运行超过时间上限。',
  },
  FRONTEND_MODEL_CALL_LIMIT: {
    httpStatus: 429,
    retryable: false,
    message: '本次重构运行的模型调用次数已达上限。',
  },
  FRONTEND_TOOL_CALL_LIMIT: {
    httpStatus: 429,
    retryable: false,
    message: '本次重构运行的工具调用次数已达上限。',
  },
  FRONTEND_MODEL_RESPONSE_INVALID: {
    httpStatus: 502,
    retryable: true,
    message: '模型返回不是合法、完整的 JSON，未产出任何候选。',
  },
  FRONTEND_INTERNAL_ERROR: {
    httpStatus: 500,
    retryable: false,
    message: '前端重构链路内部错误。',
  },
} as const satisfies Record<string, FrontendErrorDefinition>;

export type FrontendErrorCode = keyof typeof FRONTEND_ERROR_DEFINITIONS;

/**
 * 契约错误。schema/state 层只抛这一种错误，便于 Controller 统一映射。
 * `toHttpException()` 只输出 `{ code, message }`，不携带 details 与堆栈。
 */
export class FrontendReconstructError extends Error {
  readonly code: FrontendErrorCode;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(code: FrontendErrorCode, details?: Record<string, unknown>) {
    const definition: FrontendErrorDefinition = FRONTEND_ERROR_DEFINITIONS[code];
    super(definition.message);
    this.name = 'FrontendReconstructError';
    this.code = code;
    this.httpStatus = definition.httpStatus;
    this.retryable = definition.retryable;
    if (details !== undefined) this.details = details;
  }

  toHttpException(): HttpException {
    return new HttpException({ code: this.code, message: this.message }, this.httpStatus);
  }
}

export function frontendError(
  code: FrontendErrorCode,
  details?: Record<string, unknown>,
): FrontendReconstructError {
  return new FrontendReconstructError(code, details);
}

const LOG_PATH_PATTERN = /^\$(?:\.[A-Za-z][A-Za-z0-9]{0,63}|\[\d{1,3}\]){1,12}$/;
const LOG_TOKEN_PATTERN = /^[a-z][a-z0-9_-]{0,39}$/;
const MAX_LOG_PATH_CHARS = 200;

/**
 * 日志安全投影：只允许稳定的 code/reason/stopReason 与经过白名单校验的 DSL path。
 *
 * `details.path` 可能由请求/模型的未知字段名拼接（例如超长 base64 片段），
 * 直接写入日志会破坏“日志不含 base64/大文本”的边界。日志只用这里的投影；
 * 返回给模型/客户端的错误体仍由调用方单独构造。
 */
export function sanitizeFrontendLogDetails(
  details: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (details === undefined) return {};
  const out: Record<string, unknown> = {};
  if (typeof details.path === 'string') {
    out.path = LOG_PATH_PATTERN.test(details.path) && details.path.length <= MAX_LOG_PATH_CHARS
      ? details.path
      : '<invalid-path>';
  }
  if (typeof details.reason === 'string' && LOG_TOKEN_PATTERN.test(details.reason)) {
    out.reason = details.reason;
  }
  if (typeof details.stopReason === 'string' && LOG_TOKEN_PATTERN.test(details.stopReason)) {
    out.stopReason = details.stopReason;
  }
  if (Array.isArray(details.issues)) {
    out.issueCount = Math.min(details.issues.length, 8);
  }
  return out;
}
