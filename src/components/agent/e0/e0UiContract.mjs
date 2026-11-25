/**
 * E0-U1：Workspace Agent 单页输入 / 进度 / 候选摘要的**唯一** UI 口径来源。
 *
 * 为什么单独一个纯模块：
 * - 旧链存在三份阶段标签副本（`desktop/frontend-reconstruct-ipc.cjs#STAGE_LABELS`、
 *   `src/domain/frontendReconstruct.mjs#FRONTEND_STAGE_LABELS`、`src/domain/agentRunProcess.mjs`
 *   `#FRONTEND_STAGE_STEP_LABELS`，见冻结 §10 D-UI-3）。E0 新链**不得**再加第三/第四份，
 *   所以阶段白名单、四态词、8 页枚举、缺图口径全部只在这里定义一次，组件只 import。
 * - 本模块**纯函数、无 IO、无 React、不读 window.smartStore**，可被 `node --test` 直接 import；
 *   组件只吃 props，接线留给 E3 走 `src/services/workspaceAgent/**` facade。
 *
 * 口径来源（只读，不改冻结）：
 * - `docs/handoff/Workspace-Agent-B阶段接口冻结.md` §9.1（progress stage 清单）+ §14.9（追加
 *   `queue/image/bundle/submit`，`adopt` 原文已有，不重复）；
 * - §14.5（8 页目标枚举单一来源、`enabled` 由事实派生，不得硬编码 8 个 true）；
 * - §14.4 / §14.5（检查四态 `PASS/FAIL/BLOCKED/NOT_RUN`、静态门禁、`partial` ≠ 通过）；
 * - §14.8（E0 只接受 1 张参考图、单张 ≤2 MiB，缺图必须明确失败，不得当纯文本）。
 */

export const E0_CONTRACT_ID = 'workspace-agent-e0-u1.v1';

/** 冻结 §14.5：8 页目标枚举（顺序即契约顺序，UI 不得自行增减或重排）。 */
export const E0_TARGET_PAGE_IDS = Object.freeze([
  'home',
  'menu',
  'product-detail',
  'checkout',
  'orders',
  'order-detail',
  'mine',
  'merchant-orders',
]);

export const E0_TARGET_PAGE_LABELS = Object.freeze({
  home: '首页',
  menu: '菜单页',
  'product-detail': '菜品详情页',
  checkout: '结算页',
  orders: '订单列表页',
  'order-detail': '订单详情页',
  mine: '我的（门店资料）页',
  'merchant-orders': '店主接单页',
});

/** 非 enabled 页的默认原因（真实原因由平台 `get-context.targetPages[].reasons` 给）。 */
export const E0_TARGET_PAGE_DISABLED_REASON = '当前项目没有该页面的能力事实（page-contract 未派生），不能选择';

export const E0_ERROR_CODES = Object.freeze({
  targetPageUnsupported: 'AGENT_TARGET_PAGE_UNSUPPORTED',
  visionUnavailable: 'AGENT_VISION_UNAVAILABLE',
  imageInvalid: 'AGENT_IMAGE_INVALID',
  staticGateFailed: 'AGENT_STATIC_GATE_FAILED',
});

/**
 * 冻结 §9.1 + §14.9 追加项：`agent:progress.stage` 白名单（并发事实见 §14.6，不在 UI 侧限流）。
 * 遇到未知 stage 必须显示「未知阶段（x）」并保留该步，禁止静默丢弃（rev2 F5 / rev15 §14.9）。
 */
export const E0_PROGRESS_STAGES = Object.freeze([
  'analyze',
  'read-context',
  'plan',
  'edit',
  'write',
  'materialize',
  'validate',
  'render',
  'workspace',
  'verify',
  'compose',
  'mini-check',
  'consistency',
  'observable',
  'wechat',
  'repair',
  'adopt',
  'done',
  // rev15 §14.9 追加（不改 §9.1 原文）
  'queue',
  'image',
  'bundle',
  'submit',
]);

export const E0_STAGE_LABELS = Object.freeze({
  analyze: '识别参考图与页面能力',
  'read-context': '读取页面与组件事实',
  plan: '制定改造计划',
  edit: '调整源码',
  write: '写入候选文件',
  materialize: '准备候选工作区',
  validate: '校验草稿与事实',
  render: '生成候选页面',
  workspace: '准备私有工作区',
  verify: '校验注册与覆盖',
  compose: 'Composer 组装校验',
  'mini-check': '小程序静态校验',
  consistency: '产物一致性检查',
  observable: '可观察项对照',
  wechat: '微信真实编译',
  repair: '定向修复',
  adopt: '采用候选',
  done: '完成',
  queue: '等待模型槽位',
  image: '读取参考图资产',
  bundle: '派生来源清单',
  submit: '提交候选',
});

export const E0_UNKNOWN_STAGE_LABEL_PREFIX = '未知阶段';

/** §3.2：progress 事件 status 枚举（与检查四态是两套口径，不得混用）。 */
export const E0_PROGRESS_EVENT_STATUSES = Object.freeze(['running', 'succeeded', 'failed', 'cancelled']);

export const E0_PROGRESS_EVENT_STATUS_LABELS = Object.freeze({
  running: '进行中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
});

/** §14.4 / §14.5：唯一四态。`partial` 不是第五个状态，只是一条显式标记。 */
export const E0_CHECK_STATUSES = Object.freeze(['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN']);

export const E0_STATUS_LABELS = Object.freeze({
  PASS: '通过',
  FAIL: '失败',
  BLOCKED: '受阻',
  NOT_RUN: '未运行',
});

export const E0_LIMITS = Object.freeze({
  maxUtteranceChars: 500,
  maxImages: 1,
  maxImageBytes: 2 * 1024 * 1024,
  maxSummaryChars: 240,
  maxProgressSteps: 200,
});

/** 参考图状态（UI 侧口径；`MISSING` 与 `BLOCKED` 必须同时可见，不许静默降级成纯文本）。 */
export const E0_IMAGE_STATES = Object.freeze(['MISSING', 'READY', 'BLOCKED']);

export const E0_CONSENT_TEXT = '我同意把这张参考图发给模型，仅用于识别页面结构与视觉风格';

export const E0_CONSENT_LABEL = '同意把参考图发给模型';

const STAGE_SET = new Set(E0_PROGRESS_STAGES);
const PAGE_SET = new Set(E0_TARGET_PAGE_IDS);
const STATUS_SET = new Set(E0_CHECK_STATUSES);
const EVENT_STATUS_SET = new Set(E0_PROGRESS_EVENT_STATUSES);

function boundedText(value, max) {
  if (typeof value !== 'string') return '';
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max) : text;
}

function readStringList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const text = boundedText(item, 120);
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

export function isKnownStage(stage) {
  return typeof stage === 'string' && STAGE_SET.has(stage);
}

/**
 * 未知 stage 一律显示「未知阶段（x）」，绝不返回空串、也绝不悄悄替换成上一阶段或 `done`。
 */
export function formatStageLabel(stage) {
  if (typeof stage !== 'string' || stage === '') {
    return `${E0_UNKNOWN_STAGE_LABEL_PREFIX}（空）`;
  }
  if (STAGE_SET.has(stage)) return E0_STAGE_LABELS[stage] || stage;
  return `${E0_UNKNOWN_STAGE_LABEL_PREFIX}（${boundedText(stage, 60)}）`;
}

export function isKnownEventStatus(status) {
  return typeof status === 'string' && EVENT_STATUS_SET.has(status);
}

export function formatEventStatusLabel(status) {
  if (EVENT_STATUS_SET.has(status)) return E0_PROGRESS_EVENT_STATUS_LABELS[status];
  return '未知状态（' + boundedText(status, 40) + '）';
}

/**
 * 把主进程 `agent:progress` payload 归一成一个可渲染的步骤。
 * 只保留有界字段（§3.2：不含路径/源码/base64/prompt）。
 */
export function normalizeProgressEvent(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const stage = typeof source.stage === 'string' ? source.stage : '';
  const status = typeof source.status === 'string' ? source.status : '';
  return Object.freeze({
    stage,
    stageLabel: formatStageLabel(stage),
    knownStage: isKnownStage(stage),
    status: isKnownEventStatus(status) ? status : 'running',
    statusLabel: formatEventStatusLabel(status),
    statusKnown: isKnownEventStatus(status),
    attemptId: typeof source.attemptId === 'string' ? source.attemptId : null,
    at: typeof source.at === 'string' ? source.at : null,
    message: boundedText(source.message, 120),
  });
}

/**
 * 追加一步进度。**无论 stage 是否白名单内都追加**（未知 stage 不丢步）。
 * 只有完全重复的相邻事件（同 stage + 同 status + 同 message）才合并，避免刷屏。
 */
export function appendProgressStep(steps, payload) {
  const list = Array.isArray(steps) ? steps.slice() : [];
  const step = normalizeProgressEvent(payload);
  const last = list[list.length - 1];
  if (last && last.stage === step.stage && last.status === step.status && last.message === step.message) {
    return list;
  }
  list.push(step);
  return list;
}

/** 展示时最多保留最近 N 步，但**不隐藏未知阶段**：末步用提示说明已折叠多少步。 */
export function windowProgressSteps(steps, maxSteps = E0_LIMITS.maxProgressSteps) {
  const list = Array.isArray(steps) ? steps : [];
  const limit = Number.isFinite(maxSteps) && maxSteps > 0 ? Math.floor(maxSteps) : E0_LIMITS.maxProgressSteps;
  if (list.length <= limit) return { steps: list.slice(), hiddenCount: 0 };
  const unknown = list.filter((step) => !step || step.knownStage !== true);
  const recent = list.slice(list.length - limit);
  const merged = [];
  for (const step of unknown.concat(recent)) {
    if (!merged.includes(step)) merged.push(step);
  }
  merged.sort((a, b) => list.indexOf(a) - list.indexOf(b));
  return { steps: merged, hiddenCount: Math.max(0, list.length - merged.length) };
}

/**
 * 检查四态归一口径：只认 PASS/FAIL/BLOCKED/NOT_RUN（大小写不敏感）。
 * 非法值**不假装通过**：降级成 NOT_RUN 并标 `unknown:true`，UI 必须同时显示原始值。
 */
export function normalizeCheckStatus(raw) {
  if (typeof raw !== 'string') return { status: 'NOT_RUN', unknown: true, raw: '' };
  const upper = raw.trim().toUpperCase();
  if (STATUS_SET.has(upper)) return { status: upper, unknown: false, raw: upper };
  return { status: 'NOT_RUN', unknown: true, raw: boundedText(raw, 40) };
}

export function formatCheckStatusLabel(status) {
  const normalized = normalizeCheckStatus(status);
  const label = E0_STATUS_LABELS[normalized.status];
  return normalized.unknown ? `${normalized.status}（原始值未被冻结口径接受：${normalized.raw || '空'}）` : label;
}

/**
 * 8 页枚举归一：始终按冻结顺序回 8 项；`enabled` **只认平台事实**（`raw.enabled === true`），
 * 不是 `raw.enabled` 缺失时默认 false，绝不硬编码 8 个 true（§14.5）。
 * 平台多给的未知页 id 不进 UI 列表，但记进 `rejected` 便于 E3 报口径偏差。
 */
export function normalizeTargetPages(raw) {
  const input = Array.isArray(raw) ? raw : [];
  const byId = new Map();
  const rejected = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const id = typeof item.id === 'string' ? item.id : '';
    if (!PAGE_SET.has(id)) {
      if (id) rejected.push(id);
      continue;
    }
    byId.set(id, item);
  }
  const pages = E0_TARGET_PAGE_IDS.map((id) => {
    const item = byId.get(id) || null;
    const enabled = Boolean(item && item.enabled === true);
    const reasons = readStringList(item && item.reasons);
    return Object.freeze({
      id,
      label: E0_TARGET_PAGE_LABELS[id],
      enabled,
      reasons: enabled ? reasons : (reasons.length ? reasons : [E0_TARGET_PAGE_DISABLED_REASON]),
    });
  });
  return Object.freeze({ pages: Object.freeze(pages), rejected: Object.freeze(rejected) });
}

/** 页面选择校验：非法/未启用页一律给 `AGENT_TARGET_PAGE_UNSUPPORTED`，不静默回落。 */
export function pickTargetPage(raw, id) {
  const { pages } = normalizeTargetPages(raw);
  const page = pages.find((entry) => entry.id === id) || null;
  if (!page) {
    return { ok: false, code: E0_ERROR_CODES.targetPageUnsupported, message: '目标页面不在 8 页枚举内' };
  }
  if (!page.enabled) {
    return {
      ok: false,
      code: E0_ERROR_CODES.targetPageUnsupported,
      message: page.reasons[0] || E0_TARGET_PAGE_DISABLED_REASON,
      page,
    };
  }
  return { ok: true, page };
}

/**
 * 参考图状态：缺图必须同时露出 MISSING 与 BLOCKED，且明确“视觉分析不可执行”，
 * 不许静默退化成纯文本生成（§14.8 第 5 条）。
 */
export function describeReferenceImage(image) {
  if (!image || typeof image !== 'object' || !image.assetId) {
    return Object.freeze({
      state: 'MISSING',
      visionStatus: 'BLOCKED',
      canRunVision: false,
      text: '未选择参考图（MISSING）：参考图缺失导致视觉分析 BLOCKED，本轮不能声称按图改造',
    });
  }
  const bytes = Number(image.bytes);
  if (Number.isFinite(bytes) && bytes > E0_LIMITS.maxImageBytes) {
    return Object.freeze({
      state: 'BLOCKED',
      visionStatus: 'BLOCKED',
      canRunVision: false,
      text: `参考图超过 ${Math.floor(E0_LIMITS.maxImageBytes / 1024)} KiB 上限（MISSING 可用像素）：视觉分析 BLOCKED`,
    });
  }
  return Object.freeze({
    state: 'READY',
    visionStatus: 'NOT_RUN',
    canRunVision: true,
    text: '参考图已选中，尚未读取像素（视觉分析 NOT_RUN）',
  });
}

/** consent 只表达“用户明确同意把图发给模型”，不读文件、不写盘。 */
export function describeConsent(value) {
  const granted = Boolean(value && typeof value === 'object' ? value.granted : value);
  return Object.freeze({
    granted,
    text: E0_CONSENT_TEXT,
    state: granted ? 'READY' : 'BLOCKED',
    note: granted ? '已记录用户同意（仅表示同意发图给模型）' : '未同意（BLOCKED）：没有 consent 不允许把图发给模型',
  });
}

export function formatTreeDigest(digest) {
  if (typeof digest !== 'string' || !digest) return { full: '', short: '未知 digest' };
  const short = digest.length > 20 ? `${digest.slice(0, 15)}…${digest.slice(-4)}` : digest;
  return { full: digest, short };
}

function normalizeChecks(raw) {
  const input = Array.isArray(raw) ? raw : [];
  const items = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const checkId = boundedText(item.checkId, 60);
    if (!checkId) continue;
    const status = normalizeCheckStatus(item.status);
    const reason = boundedText(item.reason, 160)
      || readStringList(item.reasons).join('；')
      || '';
    items.push(Object.freeze({
      checkId,
      status: status.status,
      statusUnknown: status.unknown,
      rawStatus: status.raw,
      reason,
      treeDigest: typeof item.treeDigest === 'string' ? item.treeDigest : '',
      exportTreeDigest: typeof item.exportTreeDigest === 'string' ? item.exportTreeDigest : '',
    }));
  }
  return items;
}

const AGGREGATE_PRIORITY = Object.freeze(['FAIL', 'BLOCKED', 'NOT_RUN', 'PASS']);

function aggregate(items) {
  if (!items.length) {
    return Object.freeze({ status: 'NOT_RUN', count: 0, items: Object.freeze([]) });
  }
  const statuses = items.map((item) => item.status);
  const status = AGGREGATE_PRIORITY.find((candidate) => statuses.includes(candidate)) || 'NOT_RUN';
  return Object.freeze({ status, count: items.length, items: Object.freeze(items) });
}

/**
 * 候选摘要卡的数据口径（E3 直接渲染）：
 * - 修改文件数、treeDigest、静态四态汇总、运行时四态汇总；
 * - BLOCKED / NOT_RUN 必须带原因（没有原因也要如实写“平台未给出原因”）；
 * - `submitReady` 只表示“静态门禁是否满足”，**不等于**已采用/已通过（§14.5 + §14.7 X9）。
 */
export function buildCandidateSummary(input) {
  const source = input && typeof input === 'object' ? input : {};
  const staticItems = normalizeChecks(source.staticChecks ?? source.checks);
  const runtimeItems = normalizeChecks(source.runtimeChecks);
  const staticAgg = aggregate(staticItems);
  const runtimeAgg = aggregate(runtimeItems);

  let changedFileCount = 0;
  if (Array.isArray(source.changedFiles)) changedFileCount = source.changedFiles.length;
  else if (Number.isFinite(Number(source.changedFileCount))) changedFileCount = Math.max(0, Math.floor(Number(source.changedFileCount)));

  const collecting = (items) => items
    .filter((item) => item.status === 'BLOCKED' || item.status === 'NOT_RUN')
    .map((item) => Object.freeze({
      checkId: item.checkId,
      status: item.status,
      reason: item.reason || '平台未给出原因（不得据此视为通过）',
    }));

  const blockedReasons = Object.freeze(collecting(staticItems).filter((item) => item.status === 'BLOCKED')
    .concat(collecting(runtimeItems).filter((item) => item.status === 'BLOCKED')));
  const notRunReasons = Object.freeze(collecting(staticItems).filter((item) => item.status === 'NOT_RUN')
    .concat(collecting(runtimeItems).filter((item) => item.status === 'NOT_RUN')));

  const treeDigest = formatTreeDigest(typeof source.treeDigest === 'string' ? source.treeDigest : '');

  return Object.freeze({
    attemptId: typeof source.attemptId === 'string' ? source.attemptId : '',
    revision: Number.isFinite(Number(source.revision)) ? Number(source.revision) : null,
    targetPage: PAGE_SET.has(source.targetPage) ? source.targetPage : null,
    changedFileCount,
    changedFiles: Object.freeze(readStringList(source.changedFiles).slice(0, 64)),
    treeDigest: treeDigest.full,
    treeDigestShort: treeDigest.short,
    static: staticAgg,
    runtime: runtimeAgg,
    blockedReasons,
    notRunReasons,
    // 静态门禁：FAIL 一律拒绝；BLOCKED/NOT_RUN 允许但只能是 partial，不是通过。
    submitReady: staticAgg.status === 'PASS' && staticAgg.count > 0 && runtimeAgg.status !== 'FAIL',
    partial: runtimeAgg.status === 'BLOCKED' || runtimeAgg.status === 'NOT_RUN'
      || staticAgg.status === 'BLOCKED' || staticAgg.status === 'NOT_RUN',
  });
}

/** 候选摘要为空时的如实文案（没有候选就显示没有，不画占位“通过”）。 */
export const E0_EMPTY_SUMMARY_TEXT = '还没有候选（候选状态 NOT_RUN）：先完成写入与检查才会有摘要';

/** 供测试与 E3 用的只读口径快照（键集合固定，新增需 rev）。 */
export const E0_UI_CONTRACT_SNAPSHOT = Object.freeze({
  contractId: E0_CONTRACT_ID,
  targetPages: E0_TARGET_PAGE_IDS,
  stages: E0_PROGRESS_STAGES,
  checkStatuses: E0_CHECK_STATUSES,
  eventStatuses: E0_PROGRESS_EVENT_STATUSES,
  imageStates: E0_IMAGE_STATES,
});
