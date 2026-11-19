/**
 * 由 `scripts/frontend-contract.cjs` 从 `contracts/frontend-reconstruct.v1.json` 生成，**不要手改**。
 * 使用者：server/src/agent/frontend-reconstruct（NestJS 契约与校验）
 * 契约版本：frontend-reconstruct.v1 / draft：frontend-pack-draft.v1
 * 契约摘要：sha256:eef3076d50392fe9ecfa0d3787647c0844607f05863b11a39c25c7cb3f90d6bd
 * 重新生成：node scripts/frontend-contract.cjs --write
 */

export const FRONTEND_RECONSTRUCT_CONTRACT_VERSION = "frontend-reconstruct.v1";
export const FRONTEND_PACK_DRAFT_SCHEMA_VERSION = "frontend-pack-draft.v1";
export const FRONTEND_FACTS_VERSION = "frontend-facts.v1";
export const FRONTEND_PAGE_FACTS_VERSION = "frontend-page-facts.v1";

export const FRONTEND_TARGET_PAGES = ["home", "menu"] as const;
export const FRONTEND_CLIENT_SURFACES = ["desktop"] as const;
export const FRONTEND_CLIENT_PHASES = ["template-pick", "frontend-reconstruct"] as const;
export const FRONTEND_THEME_TOKEN_KEYS = ["pageBackground", "primaryColor", "accentColor", "textColor", "tabBarBackground", "tabBarColor", "tabBarSelectedColor"] as const;
export const FRONTEND_SIZE_STEPS = ["sm", "md", "lg"] as const;
export const FRONTEND_SIZE_KEYS = ["homeHero", "productCard", "carousel"] as const;
export const FRONTEND_REGION_TYPES = ["header", "hero", "nav", "list", "grid", "card", "form", "banner", "footer", "other"] as const;
export const FRONTEND_LAYOUT_KINDS = ["single-column", "two-column", "grid", "list", "poster"] as const;
export const FRONTEND_DRAFT_NODE_TYPES = ["component", "slot", "container", "text", "button"] as const;
export const FRONTEND_TOOL_NAMES = ["get_frontend_capabilities", "check_frontend_coverage", "propose_frontend_draft", "repair_frontend_draft"] as const;
export const FRONTEND_STOP_REASONS = ["final_answer", "needs_input", "rejected", "max_model_calls", "max_tool_calls", "loop_detected", "time_limit", "aborted"] as const;
export const FRONTEND_RESPONSE_STATUSES = ["planned", "needs-input", "rejected"] as const;
export const FRONTEND_STATES = ["idle", "analyzing", "planning", "awaiting-capability-confirmation", "generating", "validating", "verifying-runtime", "ready", "partial", "rejected", "failed", "adopted", "cancelled"] as const;
export const FRONTEND_REPAIR_ISSUE_CODES = ["DRAFT_SCHEMA_INVALID", "DRAFT_UNKNOWN_COMPONENT", "DRAFT_UNKNOWN_EVENT", "DRAFT_UNKNOWN_DATA_PATH", "DRAFT_STYLE_INVALID", "DRAFT_PAGE_JSON_INVALID", "SLOT_ANCHOR_MISSING", "DRY_RUN_FAILED", "MINI_CHECK_FAILED", "CONSISTENCY_FAILED"] as const;

/** 本地结构化错误码（与 enums.draftErrorCodes 同源）。 */
export const FRONTEND_DRAFT_ERROR_CODES = Object.freeze({
  schema: "DRAFT_SCHEMA_INVALID",
  component: "DRAFT_UNKNOWN_COMPONENT",
  event: "DRAFT_UNKNOWN_EVENT",
  dataPath: "DRAFT_UNKNOWN_DATA_PATH",
  style: "DRAFT_STYLE_INVALID",
  pageJson: "DRAFT_PAGE_JSON_INVALID",
});

/** 所有硬边界集中在这里；服务端与此契约共用同一组数字。 */
export const FRONTEND_LIMITS = Object.freeze({
  maxBodyBytes: 2097152,
  maxUtteranceChars: 500,
  maxPresentationPatchBytes: 16384,
  maxPages: 2,
  maxRegionsPerPage: 32,
  maxRegionDepth: 3,
  maxRegionChildren: 12,
  maxMustKeep: 32,
  maxBindings: 64,
  maxUnknownRegions: 24,
  maxLowConfidence: 24,
  maxInferredInteractions: 16,
  maxUnsupported: 16,
  maxDegradations: 16,
  maxQuestions: 8,
  maxQuestionChars: 200,
  maxSummaryChars: 240,
  maxReasonChars: 200,
  maxLabelChars: 64,
  maxDraftPages: 2,
  maxDraftNodesPerPage: 48,
  maxDraftDepth: 4,
  maxContainerChildren: 12,
  maxComponentProps: 8,
  maxComponentEvents: 8,
  maxDraftStringChars: 120,
  maxDisplayNameChars: 40,
  maxButtonLabelChars: 16,
  maxNavTitleChars: 20,
  maxRepairRounds: 2,
  maxRepairIssues: 8,
  maxModelCalls: 8,
  maxToolCalls: 16,
  maxWallClockMs: 120000,
  maxTraceToolCalls: 16,
  maxRequiredCapabilities: 32,
  maxCoverageRisks: 16,
  maxFactsEntries: 128,
} as const);

/** 标识符/文本正则；全部来自契约 patterns。 */
export const REQUEST_ID_PATTERN = new RegExp("^fr-[A-Za-z0-9][A-Za-z0-9._-]{0,60}$");
export const RUN_ID_PATTERN = new RegExp("^frun-[A-Za-z0-9][A-Za-z0-9._-]{0,60}$");
export const PROJECT_ID_PATTERN = new RegExp("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$");
export const PACK_ID_PATTERN = new RegExp("^[a-z][a-z0-9-]{1,63}$");
export const VERSION_PATTERN = new RegExp("^\\d+\\.\\d+\\.\\d+$");
export const REGION_ID_PATTERN = new RegExp("^[a-z][a-z0-9-]{0,31}$");
export const LOWERCASE_ID_PATTERN = new RegExp("^[a-z][a-z0-9-]{0,63}$");
export const PROP_ID_PATTERN = new RegExp("^[A-Za-z][A-Za-z0-9-]{0,63}$");
export const EVENT_ID_PATTERN = new RegExp("^[A-Za-z][A-Za-z0-9-]{0,31}$");
export const ACTION_PATTERN = new RegExp("^[a-z][a-z0-9-]*\\.[A-Za-z][A-Za-z0-9]{0,31}$");
export const DATA_PATH_PATTERN = new RegExp("^[A-Za-z][A-Za-z0-9]*(?:\\.[A-Za-z][A-Za-z0-9]*){1,7}$");
export const CAPABILITY_PATTERN = new RegExp("^(page|component|slot|action|data):[A-Za-z0-9][A-Za-z0-9._-]{0,63}$");
export const QUESTION_FIELD_PATTERN = new RegExp("^[a-z][A-Za-z0-9.]{0,63}$");
export const PROVIDER_PATTERN = new RegExp("^[a-z][a-z0-9-]{0,39}$");
export const MODEL_PATTERN = new RegExp("^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$");
export const HEX_COLOR_PATTERN = new RegExp("^#[0-9A-Fa-f]{6}$");
export const CONTROL_CHAR_PATTERN = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f]");
export const CONTROL_CHAR_NARROW_PATTERN = new RegExp("[\\u0000-\\u001f\\u007f]");

/** inferredInteractions 不得携带的动作/路由能力名。 */
export const INFERRED_FORBIDDEN_TOKENS: readonly string[] = Object.freeze(["action:", "page:", "route:", "/pages/"]);

/** 纯文本黑名单：模板/脚本 scheme/URL/绝对路径/反斜杠/路径穿越。 */
export const FORBIDDEN_TEXT_PATTERNS: ReadonlyArray<RegExp> = Object.freeze([
  new RegExp("[<>]"),
  new RegExp("\\{\\{|\\}\\}"),
  new RegExp("javascript:", "i"),
  new RegExp("vbscript:", "i"),
  new RegExp("data:", "i"),
  new RegExp("https?://", "i"),
  new RegExp("^//"),
  new RegExp("^/"),
  new RegExp("\\\\"),
  new RegExp("\\.\\."),
]);

/** 严格对象键白名单（未知键一律拒绝）。 */
export const FRONTEND_DRAFT_KEYS = ["schemaVersion", "displayName", "pages"] as const;
export const FRONTEND_DRAFT_PAGE_KEYS = ["pageId", "nodes", "styles", "pageJson"] as const;
export const FRONTEND_COMPONENT_KEYS = ["type", "componentId", "props", "events"] as const;
export const FRONTEND_SLOT_KEYS = ["type", "slotId"] as const;
export const FRONTEND_CONTAINER_KEYS = ["type", "style", "children"] as const;
export const FRONTEND_TEXT_KEYS = ["type", "textToken", "style"] as const;
export const FRONTEND_BUTTON_KEYS = ["type", "label", "action", "style"] as const;
export const FRONTEND_DATA_PROP_KEYS = ["kind", "dataPath"] as const;
export const FRONTEND_LITERAL_PROP_KEYS = ["kind", "value"] as const;
export const FRONTEND_LAYOUT_STYLE_KEYS = ["direction", "align", "justify", "gap", "padding", "radius", "width", "minHeight", "backgroundColorToken", "borderColorToken"] as const;
export const FRONTEND_TEXT_STYLE_KEYS = ["size", "weight", "colorToken"] as const;
export const FRONTEND_DRAFT_PAGE_JSON_KEYS = ["navigationBarTitleText", "navigationBarBackgroundColor", "navigationBarTextStyle", "backgroundColor", "enablePullDownRefresh"] as const;
export const FRONTEND_PACK_PAGE_JSON_KEYS = ["navigationBarTitleText", "enablePullDownRefresh", "disableScroll", "backgroundColor", "backgroundTextStyle", "usingComponents"] as const;
export const FRONTEND_PACK_PAGE_JSON_EMIT_KEYS = ["navigationBarTitleText", "enablePullDownRefresh", "backgroundColor"] as const;
