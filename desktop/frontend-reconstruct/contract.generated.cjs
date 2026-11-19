/**
 * 由 `scripts/frontend-contract.cjs` 从 `contracts/frontend-reconstruct.v1.json` 生成，**不要手改**。
 * 使用者：desktop/frontend-reconstruct（Electron 主进程）与 scripts（Composer/能力快照）
 * 契约版本：frontend-reconstruct.v1 / draft：frontend-pack-draft.v1
 * 契约摘要：sha256:eef3076d50392fe9ecfa0d3787647c0844607f05863b11a39c25c7cb3f90d6bd
 * 重新生成：node scripts/frontend-contract.cjs --write
 */
'use strict';

const CONTRACT_VERSION = "frontend-reconstruct.v1";
const DRAFT_SCHEMA_VERSION = "frontend-pack-draft.v1";
const FACTS_VERSION = "frontend-facts.v1";
const PAGE_FACTS_VERSION = "frontend-page-facts.v1";

const TARGET_PAGES = Object.freeze(["home", "menu"]);
const DRAFT_NODE_TYPES = Object.freeze(["component", "slot", "container", "text", "button"]);
const THEME_TOKEN_KEYS = Object.freeze(["pageBackground", "primaryColor", "accentColor", "textColor", "tabBarBackground", "tabBarColor", "tabBarSelectedColor"]);
const SIZE_STEPS = Object.freeze(["sm", "md", "lg"]);
const SIZE_KEYS = Object.freeze(["homeHero", "productCard", "carousel"]);
const REPAIR_ISSUE_CODES = Object.freeze(["DRAFT_SCHEMA_INVALID", "DRAFT_UNKNOWN_COMPONENT", "DRAFT_UNKNOWN_EVENT", "DRAFT_UNKNOWN_DATA_PATH", "DRAFT_STYLE_INVALID", "DRAFT_PAGE_JSON_INVALID", "SLOT_ANCHOR_MISSING", "DRY_RUN_FAILED", "MINI_CHECK_FAILED", "CONSISTENCY_FAILED"]);

const LIMITS = Object.freeze({
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
});

const DRAFT_ERROR_CODES = Object.freeze({
  SCHEMA: "DRAFT_SCHEMA_INVALID",
  COMPONENT: "DRAFT_UNKNOWN_COMPONENT",
  EVENT: "DRAFT_UNKNOWN_EVENT",
  DATA_PATH: "DRAFT_UNKNOWN_DATA_PATH",
  STYLE: "DRAFT_STYLE_INVALID",
  PAGE_JSON: "DRAFT_PAGE_JSON_INVALID",
});

const REQUEST_ID_PATTERN = new RegExp("^fr-[A-Za-z0-9][A-Za-z0-9._-]{0,60}$");
const RUN_ID_PATTERN = new RegExp("^frun-[A-Za-z0-9][A-Za-z0-9._-]{0,60}$");
const PROJECT_ID_PATTERN = new RegExp("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$");
const PACK_ID_PATTERN = new RegExp("^[a-z][a-z0-9-]{1,63}$");
const VERSION_PATTERN = new RegExp("^\\d+\\.\\d+\\.\\d+$");
const REGION_ID_PATTERN = new RegExp("^[a-z][a-z0-9-]{0,31}$");
const LOWERCASE_ID_PATTERN = new RegExp("^[a-z][a-z0-9-]{0,63}$");
const PROP_ID_PATTERN = new RegExp("^[A-Za-z][A-Za-z0-9-]{0,63}$");
const EVENT_ID_PATTERN = new RegExp("^[A-Za-z][A-Za-z0-9-]{0,31}$");
const ACTION_PATTERN = new RegExp("^[a-z][a-z0-9-]*\\.[A-Za-z][A-Za-z0-9]{0,31}$");
const DATA_PATH_PATTERN = new RegExp("^[A-Za-z][A-Za-z0-9]*(?:\\.[A-Za-z][A-Za-z0-9]*){1,7}$");
const CAPABILITY_PATTERN = new RegExp("^(page|component|slot|action|data):[A-Za-z0-9][A-Za-z0-9._-]{0,63}$");
const QUESTION_FIELD_PATTERN = new RegExp("^[a-z][A-Za-z0-9.]{0,63}$");
const PROVIDER_PATTERN = new RegExp("^[a-z][a-z0-9-]{0,39}$");
const MODEL_PATTERN = new RegExp("^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$");
const HEX_COLOR_PATTERN = new RegExp("^#[0-9A-Fa-f]{6}$");
const CONTROL_CHAR_PATTERN = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f]");
const CONTROL_CHAR_NARROW_PATTERN = new RegExp("[\\u0000-\\u001f\\u007f]");

const INFERRED_FORBIDDEN_TOKENS = Object.freeze(["action:", "page:", "route:", "/pages/"]);

const FORBIDDEN_TEXT_PATTERNS = Object.freeze([
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

const DRAFT_KEYS = Object.freeze(["schemaVersion", "displayName", "pages"]);
const DRAFT_PAGE_KEYS = Object.freeze(["pageId", "nodes", "styles", "pageJson"]);
const COMPONENT_KEYS = Object.freeze(["type", "componentId", "props", "events"]);
const SLOT_KEYS = Object.freeze(["type", "slotId"]);
const CONTAINER_KEYS = Object.freeze(["type", "style", "children"]);
const TEXT_KEYS = Object.freeze(["type", "textToken", "style"]);
const BUTTON_KEYS = Object.freeze(["type", "label", "action", "style"]);
const DATA_PROP_KEYS = Object.freeze(["kind", "dataPath"]);
const LITERAL_PROP_KEYS = Object.freeze(["kind", "value"]);
const LAYOUT_STYLE_KEYS = Object.freeze(["direction", "align", "justify", "gap", "padding", "radius", "width", "minHeight", "backgroundColorToken", "borderColorToken"]);
const TEXT_STYLE_KEYS = Object.freeze(["size", "weight", "colorToken"]);
const PAGE_JSON_KEYS = Object.freeze(["navigationBarTitleText", "navigationBarBackgroundColor", "navigationBarTextStyle", "backgroundColor", "enablePullDownRefresh"]);
const PACK_PAGE_JSON_KEYS = Object.freeze(["navigationBarTitleText", "enablePullDownRefresh", "disableScroll", "backgroundColor", "backgroundTextStyle", "usingComponents"]);
const PACK_PAGE_JSON_EMIT_KEYS = Object.freeze(["navigationBarTitleText", "enablePullDownRefresh", "backgroundColor"]);

module.exports = {
  CONTRACT_VERSION,
  DRAFT_SCHEMA_VERSION,
  FACTS_VERSION,
  PAGE_FACTS_VERSION,
  TARGET_PAGES,
  DRAFT_NODE_TYPES,
  THEME_TOKEN_KEYS,
  SIZE_STEPS,
  SIZE_KEYS,
  REPAIR_ISSUE_CODES,
  LIMITS,
  DRAFT_ERROR_CODES,
  INFERRED_FORBIDDEN_TOKENS,
  FORBIDDEN_TEXT_PATTERNS,
  REQUEST_ID_PATTERN,
  RUN_ID_PATTERN,
  PROJECT_ID_PATTERN,
  PACK_ID_PATTERN,
  VERSION_PATTERN,
  REGION_ID_PATTERN,
  LOWERCASE_ID_PATTERN,
  PROP_ID_PATTERN,
  EVENT_ID_PATTERN,
  ACTION_PATTERN,
  DATA_PATH_PATTERN,
  CAPABILITY_PATTERN,
  QUESTION_FIELD_PATTERN,
  PROVIDER_PATTERN,
  MODEL_PATTERN,
  HEX_COLOR_PATTERN,
  CONTROL_CHAR_PATTERN,
  CONTROL_CHAR_NARROW_PATTERN,
  DRAFT_KEYS,
  DRAFT_PAGE_KEYS,
  COMPONENT_KEYS,
  SLOT_KEYS,
  CONTAINER_KEYS,
  TEXT_KEYS,
  BUTTON_KEYS,
  DATA_PROP_KEYS,
  LITERAL_PROP_KEYS,
  LAYOUT_STYLE_KEYS,
  TEXT_STYLE_KEYS,
  PAGE_JSON_KEYS,
  PACK_PAGE_JSON_KEYS,
  PACK_PAGE_JSON_EMIT_KEYS,
  CONTRACT_HASH: "sha256:eef3076d50392fe9ecfa0d3787647c0844607f05863b11a39c25c7cb3f90d6bd",
};
