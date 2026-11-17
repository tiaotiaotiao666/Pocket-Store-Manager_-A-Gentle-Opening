/**
 * `frontend-reconstruct.v1` 契约类型（P0 冻结）。
 *
 * 设计边界：
 * - 这是“单张参考图 → 受控 FrontendPack 候选”的**服务端契约**，不是执行器；
 *   真正的私有 workspace / Registry overlay / Composer 在桌面主进程（后续阶段）。
 * - 模型只能产出本文件声明的有界 JSON DSL；任意 WXML/WXSS/JS/WXS、外部 URL、
 *   绝对路径、动态组件都不在契约内。
 * - `FrontendFacts` 是**服务端注入**的只读能力事实（页面/组件/props/events/slots/
 *   dataPath/action/theme token/size key）。模型输出里的任何引用都必须命中事实，
 *   否则校验直接失败；模型无权决定“能力已覆盖”。
 * - 本文件只有类型/常量，不含运行时逻辑，也不 import Nest。
 */

/** 契约版本；不兼容变更必须升 v2，不得静默改语义。 */
export const FRONTEND_RECONSTRUCT_CONTRACT_VERSION = 'frontend-reconstruct.v1';

/** FrontendPackDraft DSL 版本。 */
export const FRONTEND_PACK_DRAFT_SCHEMA_VERSION = 'frontend-pack-draft.v1';

/** 服务端注入事实快照的版本。 */
export const FRONTEND_FACTS_VERSION = 'frontend-facts.v1';

/** 首期仅支持 Base 的 home/menu 两页；扩页必须补页面卡、布局卡与运行时测试。 */
export const FRONTEND_TARGET_PAGES = ['home', 'menu'] as const;
export type FrontendTargetPageId = (typeof FRONTEND_TARGET_PAGES)[number];

/** 允许的客户端调用面与阶段（严格枚举，不做模糊匹配）。 */
export const FRONTEND_CLIENT_SURFACES = ['desktop'] as const;
export const FRONTEND_CLIENT_PHASES = ['template-pick', 'frontend-reconstruct'] as const;

/** Base `theme.tokens.json` 的七类颜色 token：只允许这些键。 */
export const FRONTEND_THEME_TOKEN_KEYS = [
  'pageBackground',
  'primaryColor',
  'accentColor',
  'textColor',
  'tabBarBackground',
  'tabBarColor',
  'tabBarSelectedColor',
] as const;
export type FrontendThemeTokenKey = (typeof FRONTEND_THEME_TOKEN_KEYS)[number];

/** 现有尺寸档位；不接受 px/rem 等自由值。 */
export const FRONTEND_SIZE_STEPS = ['sm', 'md', 'lg'] as const;
export type FrontendSizeStep = (typeof FRONTEND_SIZE_STEPS)[number];

/** 现有尺寸键（与 screen-reference.v1 保持一致）。 */
export const FRONTEND_SIZE_KEYS = ['homeHero', 'productCard', 'carousel'] as const;

/** 分区类型：只表达近似布局，不推断业务含义。 */
export const FRONTEND_REGION_TYPES = [
  'header',
  'hero',
  'nav',
  'list',
  'grid',
  'card',
  'form',
  'banner',
  'footer',
  'other',
] as const;
export type FrontendRegionType = (typeof FRONTEND_REGION_TYPES)[number];

/** 近似布局：只允许离线渲染器能确定性表达的形状。 */
export const FRONTEND_LAYOUT_KINDS = [
  'single-column',
  'two-column',
  'grid',
  'list',
  'poster',
] as const;
export type FrontendLayoutKind = (typeof FRONTEND_LAYOUT_KINDS)[number];

/** DSL 节点类型：仅五类。 */
export const FRONTEND_DRAFT_NODE_TYPES = [
  'component',
  'slot',
  'container',
  'text',
  'button',
] as const;
export type FrontendDraftNodeType = (typeof FRONTEND_DRAFT_NODE_TYPES)[number];

/** 允许模型调用的四个前端重构工具（trace 只允许这些名字）。 */
export const FRONTEND_TOOL_NAMES = [
  'get_frontend_capabilities',
  'check_frontend_coverage',
  'propose_frontend_draft',
  'repair_frontend_draft',
] as const;
export type FrontendToolName = (typeof FRONTEND_TOOL_NAMES)[number];

/** 响应 trace.stopReason 白名单（沿用 runtime 语义 + 本链路业务终止原因）。 */
export const FRONTEND_STOP_REASONS = [
  'final_answer',
  'needs_input',
  'rejected',
  'max_model_calls',
  'max_tool_calls',
  'loop_detected',
  'time_limit',
  'aborted',
] as const;
export type FrontendStopReason = (typeof FRONTEND_STOP_REASONS)[number];

/** 响应状态：与服务端计划 §3.1 完全一致。 */
export const FRONTEND_RESPONSE_STATUSES = ['planned', 'needs-input', 'rejected'] as const;
export type FrontendResponseStatus = (typeof FRONTEND_RESPONSE_STATUSES)[number];

/** 全链路状态机状态（P0 冻结；`partial` 不等于验收通过）。 */
export const FRONTEND_STATES = [
  'idle',
  'analyzing',
  'planning',
  'awaiting-capability-confirmation',
  'generating',
  'validating',
  'verifying-runtime',
  'ready',
  'partial',
  'rejected',
  'failed',
  'adopted',
  'cancelled',
] as const;
export type FrontendState = (typeof FRONTEND_STATES)[number];

/** 结构化 repair issue 的 code 白名单：只允许本地门禁产生的固定错误。 */
export const FRONTEND_REPAIR_ISSUE_CODES = [
  'DRAFT_SCHEMA_INVALID',
  'DRAFT_UNKNOWN_COMPONENT',
  'DRAFT_UNKNOWN_EVENT',
  'DRAFT_UNKNOWN_DATA_PATH',
  'DRAFT_STYLE_INVALID',
  'DRAFT_PAGE_JSON_INVALID',
  'SLOT_ANCHOR_MISSING',
  'DRY_RUN_FAILED',
  'MINI_CHECK_FAILED',
  'CONSISTENCY_FAILED',
] as const;
export type FrontendRepairIssueCode = (typeof FRONTEND_REPAIR_ISSUE_CODES)[number];

/** 所有硬边界集中在这里，测试与文档共用同一组数字。 */
export const FRONTEND_LIMITS = Object.freeze({
  /** 请求体（JSON 文本）上限，与既有 Agent 图片通路同量级。 */
  maxBodyBytes: 2 * 1024 * 1024,
  maxUtteranceChars: 500,
  maxPresentationPatchBytes: 16 * 1024,
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

/** 服务端注入的只读能力事实（能力快照的最小投影）。 */
export interface FrontendFactsComponent {
  props: string[];
  events: string[];
}

export interface FrontendFacts {
  version: typeof FRONTEND_FACTS_VERSION;
  pageIds: string[];
  components: Record<string, FrontendFactsComponent>;
  slots: string[];
  actions: string[];
  dataPaths: string[];
  themeTokens: string[];
  sizeKeys: string[];
}

/** 已通过图片校验的参考图（只保留服务端需要的字段，不含原始请求对象）。 */
export interface FrontendRequestImage {
  mediaType: string;
  dataBase64: string;
  /** 真实解码字节数，绝不信任客户端声明。 */
  bytes: number;
}

export interface FrontendBaseTemplateRef {
  id: 'ordering-base';
  version: string;
}

export interface FrontendPackRef {
  id: string;
  version: string;
}

export interface FrontendRequestCurrent {
  baseTemplate: FrontendBaseTemplateRef;
  /** null 表示当前没有已采用的 FrontendPack 候选。 */
  frontendPack: FrontendPackRef | null;
  /** 既有 presentation patch 结构保持原样，仅做体积/JSON 约束，不在本契约内解释。 */
  presentationPatch: Record<string, unknown>;
}

export interface FrontendRequestClient {
  surface: 'desktop';
  phase: (typeof FRONTEND_CLIENT_PHASES)[number];
}

/** 线上请求（`POST /api/v1/agent/frontend-reconstruct`）。 */
export interface FrontendReconstructRequest {
  contractVersion: typeof FRONTEND_RECONSTRUCT_CONTRACT_VERSION;
  requestId: string;
  utterance: string;
  images: Array<{
    kind: 'reference';
    mediaType: string;
    dataBase64: string;
  }>;
  targetPages: FrontendTargetPageId[];
  current: FrontendRequestCurrent;
  client: FrontendRequestClient;
  projectId: string | null;
}

/** `parseFrontendReconstructRequest` 的规范化结果。 */
export interface ParsedFrontendReconstructRequest {
  contractVersion: typeof FRONTEND_RECONSTRUCT_CONTRACT_VERSION;
  requestId: string;
  utterance: string;
  targetPages: FrontendTargetPageId[];
  current: FrontendRequestCurrent;
  client: FrontendRequestClient;
  projectId: string | null;
  image: FrontendRequestImage;
}

/** 0–1 归一化矩形；x+w、y+h 不得超过 1（容忍 1e-6 浮点误差）。 */
export interface NormalizedRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RegionNode {
  id: string;
  type: FrontendRegionType;
  order: number;
  rect?: NormalizedRect;
  children: RegionNode[];
  /** 0–1；低置信度项另行进入 lowConfidence。 */
  confidence: number;
}

export interface RequirementPage {
  pageId: FrontendTargetPageId;
  order: number;
  layout: FrontendLayoutKind;
  targetSize: { width: number; height: number };
  regions: RegionNode[];
}

export type MustKeepKind = 'page' | 'action' | 'data';

export interface MustKeep {
  kind: MustKeepKind;
  /** 形如 `page:home` / `action:home.goMenu` / `data:store.name`，必须命中事实。 */
  ref: string;
}

export interface VisualTheme {
  pageBackground?: string;
  primaryColor?: string;
  accentColor?: string;
  textColor?: string;
  tabBarBackground?: string;
  tabBarColor?: string;
  tabBarSelectedColor?: string;
}

export interface VisualSizes {
  homeHero?: FrontendSizeStep;
  productCard?: FrontendSizeStep;
  carousel?: FrontendSizeStep;
}

export type Density = 'compact' | 'comfortable';

/** 视觉规格：只允许现有颜色 token、sm/md/lg 与有界 density。 */
export interface VisualSpec {
  theme: VisualTheme;
  sizes: VisualSizes;
  density: Density;
}

export type BindingStatus = 'bound' | 'unknown';

/**
 * 分区到页面事实的绑定。
 * `status='bound'` 时必须且只能带 dataPath 或 eventName 之一；`unknown` 时两者都不能有。
 */
export interface RequirementBinding {
  regionId: string;
  dataPath?: string;
  eventName?: string;
  status: BindingStatus;
}

export interface UnknownRegion {
  regionId?: string;
  label: string;
  reason: string;
}

export interface LowConfidenceRegion {
  regionId: string;
  confidence: number;
  reason: string;
}

export interface InferredInteraction {
  regionId: string;
  label: string;
  reason: string;
}

export interface UnsupportedRequirement {
  capability?: string;
  label: string;
  reason: string;
}

export type DegradationSeverity = 'info' | 'warn';

export interface Degradation {
  regionId?: string;
  label: string;
  reason: string;
  severity: DegradationSeverity;
}

/** 截图理解结果：结构 + 视觉规格 + 不确定项。 */
export interface UiRequirement {
  summary: string;
  mustKeep: MustKeep[];
  pages: RequirementPage[];
  visual: VisualSpec;
  bindings: RequirementBinding[];
  unknownRegions: UnknownRegion[];
  lowConfidence: LowConfidenceRegion[];
  inferredInteractions: InferredInteraction[];
  unsupported: UnsupportedRequirement[];
  degradations: Degradation[];
}

export type CapabilityCoverageStatus = 'covered' | 'partial' | 'rejected';

export interface CoverageRisk {
  capability: string;
  reason: string;
}

export interface CoverageDegradation {
  label: string;
  reason: string;
  severity: DegradationSeverity;
}

/**
 * 能力覆盖报告：**只能由服务端根据真实事实计算**，模型无权给出 covered。
 * `coveredBy` 当前要求自映射（required capability → 同 id 的事实能力）。
 */
export interface CapabilityCoverageReport {
  status: CapabilityCoverageStatus;
  requiredCapabilities: string[];
  missingCapabilities: string[];
  coveredBy: Record<string, string>;
  risks: CoverageRisk[];
  degradations: CoverageDegradation[];
}

export type JsonPrimitive = string | number | boolean | null;

export interface DraftDataProp {
  kind: 'data';
  dataPath: string;
}

export interface DraftLiteralProp {
  kind: 'literal';
  value: JsonPrimitive;
}

export type DraftPropBinding = DraftDataProp | DraftLiteralProp;

/** 组件节点：props 必须命中部件的 prop 白名单，events 的值必须是真实控制器动作。 */
export interface DraftComponentNode {
  type: 'component';
  componentId: string;
  props: Record<string, DraftPropBinding>;
  events: Record<string, string>;
}

/** 插槽节点：renderer 负责补完整 fallback 锚点，DSL 不携带 WXML。 */
export interface DraftSlotNode {
  type: 'slot';
  slotId: string;
}

export interface DraftContainerStyle {
  direction?: 'row' | 'column';
  align?: 'start' | 'center' | 'end' | 'stretch';
  justify?: 'start' | 'center' | 'end' | 'between' | 'around';
  gap?: 'none' | 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  padding?: 'none' | 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  radius?: 'none' | 'sm' | 'md' | 'lg' | 'full';
  /** 只允许 auto / full / 有界整数，不接受任意 CSS。 */
  width?: 'auto' | 'full' | number;
  minHeight?: number;
  backgroundColorToken?: FrontendThemeTokenKey;
  borderColorToken?: FrontendThemeTokenKey;
}

export interface DraftTextStyle {
  size?: FrontendSizeStep;
  weight?: 400 | 500 | 600 | 700;
  colorToken?: FrontendThemeTokenKey;
}

export interface DraftContainerNode {
  type: 'container';
  style?: DraftContainerStyle;
  children: FrontendDraftNode[];
}

export interface DraftTextNode {
  type: 'text';
  /** 只能绑定真实 dataPath，不接受任意 WXML 表达式或字面量。 */
  textToken: string;
  style?: DraftTextStyle;
}

export interface DraftButtonNode {
  type: 'button';
  label: string;
  /** 只能绑定真实控制器动作。 */
  action: string;
  style?: DraftTextStyle;
}

export type FrontendDraftNode =
  | DraftComponentNode
  | DraftSlotNode
  | DraftContainerNode
  | DraftTextNode
  | DraftButtonNode;

/** page JSON 白名单子集；禁止 usingComponents 等任意键。 */
export interface DraftPageJson {
  navigationBarTitleText?: string;
  navigationBarBackgroundColor?: string;
  navigationBarTextStyle?: 'black' | 'white';
  backgroundColor?: string;
  enablePullDownRefresh?: boolean;
}

export interface DraftPage {
  pageId: FrontendTargetPageId;
  nodes: FrontendDraftNode[];
  /** 保留字段：首期必须为空，CSS 由确定性 renderer 输出。 */
  styles: never[];
  pageJson: DraftPageJson;
}

/** FrontendPackDraft：模型可产出的唯一前端形态（JSON DSL）。 */
export interface FrontendPackDraft {
  schemaVersion: typeof FRONTEND_PACK_DRAFT_SCHEMA_VERSION;
  displayName: string;
  pages: DraftPage[];
}

export interface FrontendQuestion {
  field: string;
  label: string;
  text: string;
}

export interface FrontendTraceToolCall {
  name: FrontendToolName;
  ok: boolean;
}

export interface FrontendTrace {
  modelCalls: number;
  toolCalls: FrontendTraceToolCall[];
  stopReason: FrontendStopReason;
  degraded: boolean;
}

export interface FrontendMeta {
  provider: string;
  model: string | null;
  mock: boolean;
  latencyMs: number;
}

/** 端点响应：`draft` 仅在 planned 时非空。 */
export interface FrontendReconstructResponse {
  contractVersion: typeof FRONTEND_RECONSTRUCT_CONTRACT_VERSION;
  runId: string;
  status: FrontendResponseStatus;
  requirement: UiRequirement;
  coverage: CapabilityCoverageReport;
  draft: FrontendPackDraft | null;
  questions: FrontendQuestion[];
  trace: FrontendTrace;
  meta: FrontendMeta;
}

export interface FrontendRepairIssue {
  /** 稳定 DSL 路径，例如 `$.pages[0].nodes[2]`。 */
  path: string;
  code: FrontendRepairIssueCode;
}

export interface FrontendRunState {
  runId: string;
  revision: number;
  status: FrontendState;
  repairAttempts: number;
  /** 最近一次结构化 repair issue；只保留有界结构，不保留自由文本日志。 */
  issues: FrontendRepairIssue[];
}
