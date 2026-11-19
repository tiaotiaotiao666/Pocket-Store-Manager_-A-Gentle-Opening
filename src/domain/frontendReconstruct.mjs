/**
 * P4：「参考截图 → 受控候选前端」的领域层（纯函数，无 IO、无 React）。
 *
 * 为什么单独一个模块：P4 的难点不是界面，而是**状态机**。一条链路上有
 * 分析（模型）、物化（本地文件）、静态门禁、微信验证、采用/放弃/取消/重试，
 * 每一步都可能被用户的新输入、切页、取消或一次迟到的旧响应打断。
 * 这里把全部判断收进 reducer，组件只负责展示 `buildFrontendReconstructView`
 * 算好的视图模型，App.jsx 只做组合根接线。
 *
 * 硬约束：
 * 1. 旧响应必须整包丢弃：每次发起新任务都会 `revision + 1`，响应必须带回
 *    当前 `runId + revision`，否则 reducer 原样返回同一个 state（不改任何字段）。
 * 2. 重复点击不产生第二个请求：忙碌状态下 request 动作是 no-op。
 * 3. 取消是显式终态 `cancelled`；取消后迟到的成功响应一律丢弃。
 * 4. 失败/取消**不清空输入**（截图、文字要求、目标页都留着），也绝不把
 *    「候选」标记成已采用 —— 当前版本由项目快照自己保管，P4 不越权改写。
 * 5. 只有静态门禁通过才允许采用；`partial` 表示微信验证未完成，必须单独确认。
 */

import { validateReferenceImage } from './screenReference.mjs';

export const FRONTEND_RECONSTRUCT_CONTRACT = 'frontend-reconstruct.v1';
export const FRONTEND_DRAFT_SCHEMA_VERSION = 'frontend-pack-draft.v1';

export const FRONTEND_TARGET_PAGES = Object.freeze(['home', 'menu']);
export const FRONTEND_TARGET_PAGE_LABELS = Object.freeze({ home: '首页', menu: '菜单页' });

export const FRONTEND_LIMITS = Object.freeze({
  maxUtteranceChars: 500,
  maxImages: 1,
  maxImageBytes: 400 * 1024,
  maxTargetPages: 2,
  maxQuestions: 8,
  maxSectionsPerPage: 16,
  maxRegionChildren: 12,
  maxApproximate: 8,
  maxUnsupported: 8,
  maxUnknownRegions: 12,
  maxLowConfidence: 12,
  maxInferred: 8,
  maxChecks: 12,
  maxIssues: 8,
  maxScreenshots: 24,
  maxHistory: 12,
  maxTextChars: 200,
  maxRepairRounds: 2,
});

export const FRONTEND_STATUS = Object.freeze({
  IDLE: 'idle',
  ANALYZING: 'analyzing',
  PLANNING: 'planning',
  GENERATING: 'generating',
  VALIDATING: 'validating',
  VERIFYING: 'verifying',
  READY: 'ready',
  PARTIAL: 'partial',
  NEEDS_INPUT: 'needs_input',
  REJECTED: 'rejected',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  ADOPTED: 'adopted',
});

/** 忙碌态：这些状态下按钮只提供「取消」，request 动作一律被忽略。 */
export const FRONTEND_BUSY_STATUSES = Object.freeze([
  FRONTEND_STATUS.ANALYZING,
  FRONTEND_STATUS.GENERATING,
  FRONTEND_STATUS.VALIDATING,
  FRONTEND_STATUS.VERIFYING,
]);

export const FRONTEND_PROGRESS_STAGES = Object.freeze([
  'analyze',
  'materialize',
  'compose',
  'mini-check',
  'consistency',
  'observable',
  'verify',
  'adopt',
  'done',
]);

export const FRONTEND_STAGE_LABELS = Object.freeze({
  analyze: '识别截图与能力覆盖',
  materialize: '准备私有候选工作区',
  compose: 'Composer P0–P6 校验',
  'mini-check': '小程序静态校验',
  consistency: '产物一致性检查',
  observable: '可观察项对照',
  verify: '微信真实编译与截图',
  adopt: '写入采用记录',
  done: '完成',
});

export const FRONTEND_REGION_LABELS = Object.freeze({
  header: '顶部信息',
  hero: '首屏主视觉',
  nav: '导航',
  list: '列表',
  grid: '栅格',
  card: '卡片',
  form: '表单',
  banner: '横幅',
  footer: '底部',
  other: '其它区域',
});

export const FRONTEND_LAYOUT_LABELS = Object.freeze({
  'single-column': '单列',
  'two-column': '双列',
  grid: '网格',
  list: '列表',
  poster: '海报',
});

export const FRONTEND_RUNTIME_STATUS = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  BLOCKED: 'BLOCKED',
  NOT_RUN: 'NOT_RUN',
});

export const FRONTEND_RUNTIME_LABELS = Object.freeze({
  PASS: '微信真实编译与关键页面通过',
  FAIL: '微信验证未通过',
  BLOCKED: '微信验证未完成（工具/证据不可用）',
  NOT_RUN: '微信验证未执行',
});

export const FRONTEND_ERROR_TEXT = Object.freeze({
  DESKTOP_REQUIRED: '生成候选前端需要在桌面应用里运行（主进程负责写私有工作区）。',
  FRONTEND_IMAGE_INVALID: '截图为空或无法解析，请重新选择一张图片。',
  FRONTEND_IMAGE_TYPE: '只支持 JPG / PNG / WebP 截图。',
  FRONTEND_IMAGE_TOO_LARGE: '截图太大了，请压到 400KB 以内再上传。',
  // B5：截图外发确认。没确认 / 确认过期 / 图或接收方变了，都要重新问、且不发请求。
  FRONTEND_CONSENT_REQUIRED: '这次发送还没有得到你的确认，截图没有发出去。',
  FRONTEND_CONSENT_EXPIRED: '确认已经过期，请重新确认后再发送。',
  FRONTEND_CONSENT_SCOPE_MISMATCH: '图片或接收方变了，这次发送需要重新确认。',
  FRONTEND_CONSENT_UNRECORDED: '没能记录这次发送确认，为安全起见没有调用模型。',
  FRONTEND_UTTERANCE_TOO_LONG: '要求文字超过 500 字，请精简后再试。',
  FRONTEND_TARGET_PAGES_INVALID: '目标页面只能是首页或菜单页（首期不支持其它页面）。',
  FRONTEND_BUSY: '已有候选前端任务正在运行，请等它结束或先取消。',
  FRONTEND_CANCELLED: '任务已取消，输入与当前版本都没有变化。',
  FRONTEND_NO_ACTIVE_RUN: '没有可取消的任务（可能已经结束）。',
  FRONTEND_STATIC_GATES_FAILED: '静态门禁未通过，不能采用这个候选。',
  FRONTEND_PARTIAL_CONFIRM_REQUIRED: '微信验证未完成，需要你单独确认后才能采用。',
  FRONTEND_VERIFICATION_MISSING: '没有找到候选的验证证据，请重新构建候选。',
  FRONTEND_ANALYZE_FAILED: '没能拿到截图识别结果，可以稍后重试；当前版本没有变化。',
  FRONTEND_ANALYZE_TIMEOUT: '识别超时，可以稍后重试；当前版本没有变化。',
  FRONTEND_ANALYZE_UNAVAILABLE: '后端或图片识别模型当前不可用，这次没有生成候选。',
  // B2：会话问题与「模型不可用」分开说；401/429 都明确可重试。
  FRONTEND_ANALYZE_AUTH_REQUIRED: '本地会话已失效或需要重新连接，请重连本地服务后重试；这次没有调用模型。',
  FRONTEND_ANALYZE_RATE_LIMITED: '识别请求太频繁了，稍等一会儿再试；这次没有重复调用模型。',
  ANALYZE_AUTH_REQUIRED: '本地会话已失效或需要重新连接，请重连本地服务后重试；这次没有调用模型。',
  ANALYZE_RATE_LIMITED: '识别请求太频繁了，稍等一会儿再试；这次没有重复调用模型。',
  FRONTEND_CONTRACT_MISMATCH: '服务端返回的契约版本不一致，请升级后再试。',
  FRONTEND_DRAFT_MISSING: '这次识别没有产出可物化的草稿，请补充要求后重试。',
  FRONTEND_BUILD_FAILED: '候选构建失败，已保留输入；当前版本没有被改动。',
  FRONTEND_VERIFY_FAILED: '微信验证未完成，候选只能作为 partial 处理。',
  FRONTEND_ADOPT_FAILED: '采用没有成功，当前版本保持不变。',
  FRONTEND_DISCARD_FAILED: '放弃没有成功，候选仍然保留。',
  UNTRUSTED_SENDER: '请求来源不受信任。',
  PAYLOAD_TOO_LARGE: '请求内容超过上限。',
  FRONTEND_PAYLOAD_INVALID: '请求参数不合法。',
});

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export function describeFrontendError(code, fallback) {
  const text = FRONTEND_ERROR_TEXT[code];
  if (typeof text === 'string') return text;
  return typeof fallback === 'string' && fallback.trim() ? fallback.trim().slice(0, FRONTEND_LIMITS.maxTextChars) : '操作没有成功，请稍后重试。';
}

function cleanText(value, maxChars) {
  const source = typeof value === 'string' ? value : '';
  return source
    .replace(CONTROL_CHARS, '')
    .replace(/<[^>]*>/g, '')
    .replace(/[`*_#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value, limit) {
  return (Array.isArray(value) ? value : []).slice(0, limit);
}

/** 错误码是机器标识符：只允许 [A-Za-z0-9_.:-]，绝不能像展示文案那样吃掉下划线。 */
function cleanCode(value, limit = 60) {
  const source = typeof value === 'string' ? value.replace(CONTROL_CHARS, '').trim() : '';
  if (!source || source.length > limit) return '';
  return /^[A-Za-z0-9_.:-]+$/.test(source) ? source : '';
}

function isTargetPage(value) {
  return FRONTEND_TARGET_PAGES.includes(value);
}

export function isFrontendBusy(state) {
  return Boolean(state && FRONTEND_BUSY_STATUSES.includes(state.status));
}

/** 生成本地 runId；格式必须与主进程 workspace 的 RUN_ID_PATTERN 一致。 */
export function createFrontendRunId(now = Date.now(), random = Math.random) {
  const tail = Math.floor((Number.isFinite(random()) ? random() : 0.5) * 1e9).toString(36).replace(/[^a-z0-9]/g, '') || '0';
  return `frun-${Number(now).toString(36)}-${tail}`;
}

export function createInitialFrontendReconstructState(overrides = {}) {
  const base = {
    status: FRONTEND_STATUS.IDLE,
    runId: null,
    revision: 0,
    request: {
      utterance: '',
      image: null,
      targetPages: ['home'],
      baseTemplate: { id: 'ordering-base', version: '1.0.0' },
      frontendPack: null,
      presentationPatch: {},
    },
    analysis: null,
    candidate: null,
    staticVerification: null,
    runtimeVerification: null,
    // 采用/放弃/复核都会把状态置为 VALIDATING：必须记住是哪一条在途，
    // 否则迟到回包会互相串台（旧 cand-A 的采用结果套到新 cand-B 上）。
    pendingOp: null,
    progress: null,
    history: [],
    error: null,
    notice: null,
    cancelRequested: false,
    adoption: null,
    discardedAt: null,
  };
  return { ...base, ...overrides };
}

// ---------------------------------------------------------------------------
// 输入归一化
// ---------------------------------------------------------------------------

export function normalizeTargetPages(pages) {
  const out = [];
  asArray(pages, FRONTEND_LIMITS.maxTargetPages + 4).forEach((page) => {
    if (isTargetPage(page) && !out.includes(page)) out.push(page);
  });
  if (out.length === 0) out.push('home');
  return out.slice(0, FRONTEND_LIMITS.maxTargetPages);
}

export function normalizeUtterance(value) {
  return cleanText(value, FRONTEND_LIMITS.maxUtteranceChars);
}

/**
 * 截图的本地校验：与旧 screen-reference 使用同一套媒体/体积/格式口径，
 * 区别只在这里额外保留 `name`/`assetId` 供界面展示。
 */
export function normalizeFrontendImage(image) {
  if (image === null || image === undefined) return { ok: true, image: null, code: null, message: '' };
  const checked = validateReferenceImage(image);
  if (!checked.ok) {
    return { ok: false, image: null, code: checked.code, message: checked.message };
  }
  return {
    ok: true,
    code: null,
    message: '',
    image: {
      name: cleanText(image.name, 80) || '参考截图',
      mediaType: image.mediaType,
      dataBase64: image.dataBase64,
      bytes: checked.bytes,
      assetId: typeof image.assetId === 'string' ? image.assetId : null,
      previewUrl: typeof image.previewUrl === 'string' ? image.previewUrl.slice(0, 4096) : '',
    },
  };
}

/** 发起分析前的整体合法性判断（不联网）。 */
export function validateFrontendRequest(request) {
  const source = plainObject(request) ? request : {};
  const utterance = typeof source.utterance === 'string' ? source.utterance : '';
  if (utterance.length > FRONTEND_LIMITS.maxUtteranceChars) {
    return { ok: false, code: 'FRONTEND_UTTERANCE_TOO_LONG', message: FRONTEND_ERROR_TEXT.FRONTEND_UTTERANCE_TOO_LONG };
  }
  const image = normalizeFrontendImage(source.image);
  if (!image.ok) return { ok: false, code: image.code, message: image.message };
  if (!image.image) {
    return { ok: false, code: 'FRONTEND_IMAGE_INVALID', message: '请先上传一张参考截图。' };
  }
  const pages = normalizeTargetPages(source.targetPages);
  if (pages.length === 0) {
    return { ok: false, code: 'FRONTEND_TARGET_PAGES_INVALID', message: FRONTEND_ERROR_TEXT.FRONTEND_TARGET_PAGES_INVALID };
  }
  return {
    ok: true,
    code: null,
    message: '',
    value: {
      utterance: normalizeUtterance(utterance),
      image: image.image,
      targetPages: pages,
      baseTemplate: {
        id: 'ordering-base',
        version: cleanText(source.baseTemplate && source.baseTemplate.version, 24) || '1.0.0',
      },
      frontendPack: null,
      presentationPatch: plainObject(source.presentationPatch) ? source.presentationPatch : {},
    },
  };
}

// ---------------------------------------------------------------------------
// 服务端 / 本地结果归一化（只保留有界、可展示字段）
// ---------------------------------------------------------------------------

function normalizeCoverage(raw) {
  const source = plainObject(raw) ? raw : {};
  const status = ['covered', 'partial', 'rejected'].includes(source.status) ? source.status : 'rejected';
  const coveredBy = {};
  if (plainObject(source.coveredBy)) {
    Object.keys(source.coveredBy).slice(0, 32).forEach((key) => {
      const value = source.coveredBy[key];
      if (typeof value === 'string') coveredBy[cleanText(key, 80)] = cleanText(value, 80);
    });
  }
  return {
    status,
    requiredCapabilities: asArray(source.requiredCapabilities, 32).map((item) => cleanText(item, 80)).filter(Boolean),
    missingCapabilities: asArray(source.missingCapabilities, 16).map((item) => cleanText(item, 80)).filter(Boolean),
    coveredBy,
    risks: asArray(source.risks, 16).map((item) => ({
      capability: cleanText(item && item.capability, 80),
      reason: cleanText(item && item.reason, FRONTEND_LIMITS.maxTextChars),
    })),
    degradations: asArray(source.degradations, 16).map((item) => ({
      label: cleanText(item && (item.label ?? item.capability), 80),
      reason: cleanText(item && item.reason, FRONTEND_LIMITS.maxTextChars),
    })),
  };
}

function normalizeRegion(node, depth) {
  const source = plainObject(node) ? node : {};
  const type = typeof source.type === 'string' ? source.type : 'other';
  return {
    id: cleanText(source.id, 64),
    type,
    label: FRONTEND_REGION_LABELS[type] || '其它区域',
    order: Number.isFinite(source.order) ? source.order : 0,
    confidence: Number.isFinite(source.confidence) ? source.confidence : 0,
    children: depth >= 2 ? [] : asArray(source.children, FRONTEND_LIMITS.maxRegionChildren).map((child) => normalizeRegion(child, depth + 1)),
  };
}

function normalizePages(raw) {
  return asArray(raw, FRONTEND_LIMITS.maxTargetPages).map((page) => {
    const source = plainObject(page) ? page : {};
    const regions = asArray(source.regions, FRONTEND_LIMITS.maxSectionsPerPage)
      .map((region) => normalizeRegion(region, 0))
      .sort((a, b) => a.order - b.order);
    const layout = typeof source.layout === 'string' ? source.layout : 'single-column';
    return {
      pageId: isTargetPage(source.pageId) ? source.pageId : 'home',
      pageLabel: FRONTEND_TARGET_PAGE_LABELS[source.pageId] || '页面',
      layout,
      layoutLabel: FRONTEND_LAYOUT_LABELS[layout] || '近似布局',
      targetSize: plainObject(source.targetSize)
        ? { width: Number(source.targetSize.width) || 0, height: Number(source.targetSize.height) || 0 }
        : null,
      regions,
      sectionCount: regions.length,
    };
  });
}

function normalizeList(raw, limit, mapEntry) {
  return asArray(raw, limit).map(mapEntry).filter((entry) => entry.label || entry.reason);
}

function normalizeDraft(raw) {
  if (!plainObject(raw)) return null;
  if (raw.schemaVersion !== FRONTEND_DRAFT_SCHEMA_VERSION) return null;
  return raw;
}

/**
 * 把 `frontend-reconstruct.v1` 响应归一化成面板可用的分析结果。
 * 只做**展示与门槛**需要的字段，不重写服务端已经校验过的 DSL。
 */
export function parseFrontendAnalyzeResponse(raw) {
  const source = plainObject(raw) ? raw : {};
  if (source.contractVersion !== FRONTEND_RECONSTRUCT_CONTRACT) {
    return {
      ok: false,
      code: 'FRONTEND_CONTRACT_MISMATCH',
      message: FRONTEND_ERROR_TEXT.FRONTEND_CONTRACT_MISMATCH,
    };
  }
  const status = ['planned', 'needs-input', 'rejected'].includes(source.status) ? source.status : 'rejected';
  const requirement = plainObject(source.requirement) ? source.requirement : {};
  const coverage = normalizeCoverage(source.coverage);
  const pages = normalizePages(requirement.pages);
  const analysis = {
    status,
    runId: cleanText(source.runId, 80),
    summary: cleanText(requirement.summary, FRONTEND_LIMITS.maxTextChars),
    pages,
    visual: {
      theme: plainObject(requirement.visual && requirement.visual.theme) ? requirement.visual.theme : {},
      sizes: plainObject(requirement.visual && requirement.visual.sizes) ? requirement.visual.sizes : {},
      density: requirement.visual && requirement.visual.density === 'compact' ? 'compact' : 'comfortable',
    },
    mustKeep: asArray(requirement.mustKeep, 32)
      .map((item) => ({ kind: cleanText(item && item.kind, 16), ref: cleanText(item && item.ref, 80) }))
      .filter((item) => item.ref),
    approximate: normalizeList(requirement.degradations, FRONTEND_LIMITS.maxApproximate, (item) => ({
      label: cleanText(item && (item.label ?? item.capability), 80) || '只能近似的部分',
      reason: cleanText(item && item.reason, FRONTEND_LIMITS.maxTextChars),
    })),
    unsupported: normalizeList(requirement.unsupported, FRONTEND_LIMITS.maxUnsupported, (item) => ({
      label: cleanText(item && (item.label ?? item.capability), 80) || '暂不支持的部分',
      reason: cleanText(item && item.reason, FRONTEND_LIMITS.maxTextChars),
    })),
    unknownRegions: normalizeList(requirement.unknownRegions, FRONTEND_LIMITS.maxUnknownRegions, (item) => ({
      label: cleanText(item && (item.label ?? item.regionId), 80) || '未识别区域',
      reason: cleanText(item && item.reason, FRONTEND_LIMITS.maxTextChars),
    })),
    lowConfidence: normalizeList(requirement.lowConfidence, FRONTEND_LIMITS.maxLowConfidence, (item) => ({
      label: cleanText(item && item.regionId, 80) || '低置信度区域',
      reason: cleanText(item && item.reason, FRONTEND_LIMITS.maxTextChars),
    })),
    inferredInteractions: normalizeList(requirement.inferredInteractions, FRONTEND_LIMITS.maxInferred, (item) => ({
      label: cleanText(item && item.label, 80) || '推断的交互',
      reason: cleanText(item && item.reason, FRONTEND_LIMITS.maxTextChars),
    })),
    questions: asArray(source.questions, FRONTEND_LIMITS.maxQuestions).map((item) => ({
      field: cleanText(item && item.field, 40),
      label: cleanText(item && item.label, 40),
      text: cleanText(item && item.text, FRONTEND_LIMITS.maxTextChars),
    })).filter((item) => item.text),
    coverage,
    draft: status === 'planned' ? normalizeDraft(source.draft) : null,
    trace: {
      modelCalls: Number.isFinite(source.trace && source.trace.modelCalls) ? source.trace.modelCalls : 0,
      toolCalls: asArray(source.trace && source.trace.toolCalls, 16).map((item) => ({
        name: cleanText(item && item.name, 40),
        ok: Boolean(item && item.ok),
      })).filter((item) => item.name),
      stopReason: cleanText(source.trace && source.trace.stopReason, 40),
      degraded: Boolean(source.trace && source.trace.degraded),
    },
    meta: {
      provider: cleanText(source.meta && source.meta.provider, 40),
      model: cleanText(source.meta && source.meta.model, 80),
      mock: Boolean(source.meta && source.meta.mock),
      latencyMs: Number.isFinite(source.meta && source.meta.latencyMs) ? source.meta.latencyMs : null,
    },
  };
  if (status === 'planned' && !analysis.draft) {
    return {
      ok: false,
      code: 'FRONTEND_DRAFT_MISSING',
      message: '服务端说可以生成，但没有给出可物化的草稿；这版不会被采用。',
      analysis,
    };
  }
  return { ok: true, code: null, message: '', analysis };
}

function normalizeChecks(raw) {
  return asArray(raw, FRONTEND_LIMITS.maxChecks).map((item) => ({
    id: cleanText(item && item.id, 60),
    status: ['pass', 'fail', 'not_run', 'not_checked', 'not_applicable'].includes(item && item.status)
      ? item.status
      : 'not_run',
    message: cleanText(item && item.message, FRONTEND_LIMITS.maxTextChars),
  }));
}

function normalizeIssues(raw) {
  return asArray(raw, FRONTEND_LIMITS.maxIssues).map((item) => ({
    code: cleanCode(item && item.code) || 'DRY_RUN_FAILED',
    path: typeof (item && item.path) === 'string' ? item.path.slice(0, 200) : null,
    field: cleanText(item && item.field, 60),
    message: cleanText(item && item.message, FRONTEND_LIMITS.maxTextChars),
  }));
}

/** 本地 buildCandidate 的返回值 → 面板可用的静态验证结论。 */
export function parseFrontendBuildResult(raw) {
  const source = plainObject(raw) ? raw : {};
  if (source.ok !== true && source.ok !== false) {
    return { ok: false, code: 'FRONTEND_BUILD_FAILED', message: FRONTEND_ERROR_TEXT.FRONTEND_BUILD_FAILED };
  }
  const candidateSource = plainObject(source.candidate) ? source.candidate : null;
  const verificationSource = plainObject(source.verification) ? source.verification : {};
  const staticSource = plainObject(verificationSource.static) ? verificationSource.static : {};
  return {
    ok: source.ok === true && Boolean(candidateSource),
    code: cleanCode(source.code) || (source.ok === true ? null : 'FRONTEND_BUILD_FAILED'),
    message: cleanText(source.message, FRONTEND_LIMITS.maxTextChars),
    candidate: candidateSource
      ? {
        candidateId: cleanText(candidateSource.candidateId, 80),
        candidateVersion: cleanText(candidateSource.candidateVersion, 24),
        attempt: Number.isInteger(candidateSource.attempt) ? candidateSource.attempt : null,
        status: cleanText(candidateSource.status, 24),
        pages: asArray(candidateSource.pages, FRONTEND_LIMITS.maxTargetPages).map((page) => cleanText(page, 24)).filter(Boolean),
        files: Number.isFinite(candidateSource.files) ? candidateSource.files : null,
        digest: cleanText(candidateSource.digest, 80),
        degradations: asArray(candidateSource.degradations, FRONTEND_LIMITS.maxApproximate).map((item) => ({
          label: cleanText(item && (item.label ?? item.capability), 80),
          reason: cleanText(item && item.reason, FRONTEND_LIMITS.maxTextChars),
        })),
      }
      : null,
    staticVerification: {
      ok: staticSource.ok === true,
      code: cleanCode(staticSource.code) || null,
      summary: cleanText(staticSource.summary, FRONTEND_LIMITS.maxTextChars),
      checks: normalizeChecks(staticSource.checks),
      issues: normalizeIssues(staticSource.issues),
      repairs: Number.isInteger(verificationSource.repairs) ? Math.min(verificationSource.repairs, FRONTEND_LIMITS.maxRepairRounds) : 0,
      repairStatus: ['applied', 'not_needed', 'exhausted', 'not_available', 'failed'].includes(verificationSource.repairStatus)
        ? verificationSource.repairStatus
        : 'not_available',
    },
    artifacts: {
      attemptRelative: cleanText(source.artifacts && source.artifacts.attemptRelative, 200),
      outputRelative: cleanText(source.artifacts && source.artifacts.outputRelative, 200),
    },
  };
}

/** 本地 verifyCandidate（微信真实验证包装）的返回值 → 面板可用结论。 */
export function parseFrontendVerifyResult(raw) {
  const source = plainObject(raw) ? raw : {};
  const status = Object.values(FRONTEND_RUNTIME_STATUS).includes(source.status)
    ? source.status
    : FRONTEND_RUNTIME_STATUS.BLOCKED;
  return {
    ok: status === FRONTEND_RUNTIME_STATUS.PASS,
    status,
    code: cleanCode(source.code) || null,
    summary: cleanText(source.summary, FRONTEND_LIMITS.maxTextChars),
    screenshots: asArray(source.screenshots, FRONTEND_LIMITS.maxScreenshots).map((item) => ({
      name: cleanText(item && item.name, 80),
      bytes: Number.isFinite(item && item.bytes) ? item.bytes : 0,
    })).filter((item) => item.name),
    pages: asArray(source.pages, 24).map((page) => ({
      route: cleanText(page && page.route, 80),
      label: cleanText(page && page.label, 40),
      status: cleanText(page && page.status, 12),
    })).filter((page) => page.route || page.label),
    interactions: asArray(source.interactions, 32).map((item) => ({
      label: cleanText(item && item.label, 60),
      status: cleanText(item && item.status, 12),
      detail: cleanText(item && item.detail, FRONTEND_LIMITS.maxTextChars),
    })).filter((item) => item.label),
    at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

function sameState(state) {
  return state;
}

function withViewState(state, patch) {
  return { ...state, ...patch };
}

function pushHistory(state, entry) {
  const history = Array.isArray(state.history) ? state.history : [];
  return [entry, ...history].slice(0, FRONTEND_LIMITS.maxHistory);
}

function runMatches(state, action) {
  if (!state.runId || typeof action.runId !== 'string' || action.runId !== state.runId) return false;
  if (Number.isInteger(action.revision) && action.revision !== state.revision) return false;
  return true;
}

/**
 * 采用/放弃/复核的严格身份校验：runId + revision 必须齐全且一致。
 *
 * 与 `runMatches` 的区别：这里**不允许省略 revision**。旧实现里没有 revision
 * 的动作会被当成「当前这次」，正是 t10-F1 里迟到回包能串台的原因。
 */
function strictRunMatches(state, action) {
  if (!state.runId || typeof action.runId !== 'string' || action.runId !== state.runId) return false;
  return Number.isInteger(action.revision) && action.revision === state.revision;
}

/** 候选身份（candidateId + attempt）必须与当前候选完全一致。 */
function candidateIdentityMatches(state, action) {
  const candidate = state.candidate;
  if (!candidate) return false;
  if (typeof action.candidateId !== 'string' || action.candidateId !== candidate.candidateId) return false;
  if (!Number.isInteger(action.attempt) || action.attempt !== candidate.attempt) return false;
  return true;
}

/** 请求/终态动作的完整身份：runId + revision + candidateId + attempt。 */
function sameCandidateIdentity(state, action) {
  return strictRunMatches(state, action) && candidateIdentityMatches(state, action);
}

/** 采用/放弃/复核共用 VALIDATING：只有对应 pendingOp 的回包才允许落地。 */
function pendingMatches(state, action, op) {
  if (state.status !== FRONTEND_STATUS.VALIDATING) return false;
  if (state.pendingOp !== op) return false;
  return sameCandidateIdentity(state, action);
}

function requestInFlight(state) {
  return isFrontendBusy(state) || state.cancelRequested === true;
}

function failureOf(action, fallbackCode) {
  const error = plainObject(action && action.error) ? action.error : {};
  const code = cleanCode(error.code) || fallbackCode;
  return {
    code,
    message: cleanText(error.message, FRONTEND_LIMITS.maxTextChars) || describeFrontendError(code),
    code2: null,
  };
}

function keepInput(state) {
  return state.request;
}

export function frontendReducer(state, action) {
  const current = state || createInitialFrontendReconstructState();
  const act = plainObject(action) ? action : {};

  switch (act.type) {
    // ---- 输入 ----
    case 'FRONTEND_INPUT_SET': {
      // 运行中改输入 = 立刻让在途任务作废（revision 前进），而不是排队第二次请求。
      const patch = {};
      const request = { ...current.request };
      let changed = false;
      if (act.utterance !== undefined) {
        const next = String(act.utterance ?? '');
        const clamped = next.slice(0, FRONTEND_LIMITS.maxUtteranceChars);
        if (clamped !== request.utterance) {
          request.utterance = clamped;
          changed = true;
        }
      }
      if (act.targetPages !== undefined) {
        const pages = normalizeTargetPages(act.targetPages);
        if (pages.join(',') !== request.targetPages.join(',')) {
          request.targetPages = pages;
          changed = true;
        }
      }
      if (act.image !== undefined) {
        const normalized = normalizeFrontendImage(act.image);
        if (!normalized.ok) {
          return withViewState(current, {
            error: { code: normalized.code, message: normalized.message },
          });
        }
        const previousKey = request.image ? `${request.image.mediaType}:${request.image.bytes}` : '';
        const nextKey = normalized.image ? `${normalized.image.mediaType}:${normalized.image.bytes}` : '';
        if (previousKey !== nextKey || (normalized.image && request.image && normalized.image.name !== request.image.name)) {
          request.image = normalized.image;
          changed = true;
        }
      }
      if (!changed) return sameState(current);
      patch.request = request;
      patch.revision = current.revision + 1;
      patch.runId = null;
      patch.analysis = null;
      patch.candidate = null;
      patch.staticVerification = null;
      patch.runtimeVerification = null;
      patch.pendingOp = null;
      patch.adoption = null;
      patch.progress = null;
      patch.error = null;
      patch.notice = null;
      patch.cancelRequested = false;
      patch.status = FRONTEND_STATUS.IDLE;
      return withViewState(current, patch);
    }

    // ---- 分析（服务端视觉 + 能力覆盖 + DSL） ----
    case 'FRONTEND_ANALYZE_REQUEST': {
      if (requestInFlight(current)) return sameState(current);
      // revision 只由「输入/切页/重置」推进：请求沿用当前 revision，
      // 因此途中改输入会让这轮响应自然失效；新一轮用新 runId 与旧响应区分。
      const revision = Number.isInteger(act.revision) ? act.revision : current.revision;
      if (revision !== current.revision) return sameState(current);
      const runId = cleanText(act.runId, 80);
      if (!runId) return sameState(current);
      return withViewState(current, {
        status: FRONTEND_STATUS.ANALYZING,
        runId,
        revision,
        analysis: null,
        candidate: null,
        staticVerification: null,
        runtimeVerification: null,
        pendingOp: null,
        adoption: null,
        progress: { stage: 'analyze', label: FRONTEND_STAGE_LABELS.analyze },
        error: null,
        notice: null,
        cancelRequested: false,
        history: pushHistory(current, { at: Date.now(), stage: 'analyze', status: 'running' }),
      });
    }

    case 'FRONTEND_ANALYZE_SUCCESS': {
      if (current.status !== FRONTEND_STATUS.ANALYZING) return sameState(current);
      if (!runMatches(current, act)) return sameState(current);
      const parsed = parseFrontendAnalyzeResponse(act.response);
      if (!parsed.ok) {
        return withViewState(current, {
          status: FRONTEND_STATUS.FAILED,
          error: { code: parsed.code, message: parsed.message },
          progress: null,
          history: pushHistory(current, { at: Date.now(), stage: 'analyze', status: 'failed', code: parsed.code }),
        });
      }
      const analysis = parsed.analysis;
      const nextStatus = analysis.status === 'planned'
        ? FRONTEND_STATUS.PLANNING
        : analysis.status === 'rejected'
          ? FRONTEND_STATUS.REJECTED
          : FRONTEND_STATUS.NEEDS_INPUT;
      return withViewState(current, {
        status: nextStatus,
        analysis,
        error: null,
        progress: null,
        request: keepInput(current),
        history: pushHistory(current, { at: Date.now(), stage: 'analyze', status: 'done' }),
      });
    }

    case 'FRONTEND_ANALYZE_FAILURE': {
      if (current.status !== FRONTEND_STATUS.ANALYZING) return sameState(current);
      if (!runMatches(current, act)) return sameState(current);
      const failure = failureOf(act, 'FRONTEND_ANALYZE_FAILED');
      return withViewState(current, {
        status: FRONTEND_STATUS.FAILED,
        analysis: null,
        error: failure,
        progress: null,
        history: pushHistory(current, { at: Date.now(), stage: 'analyze', status: 'failed', code: failure.code }),
      });
    }

    // ---- 构建（本地物化 + 静态门禁） ----
    case 'FRONTEND_BUILD_REQUEST': {
      if (requestInFlight(current)) return sameState(current);
      if (!current.analysis || current.analysis.status !== 'planned') return sameState(current);
      return withViewState(current, {
        status: FRONTEND_STATUS.GENERATING,
        candidate: null,
        staticVerification: null,
        runtimeVerification: null,
        pendingOp: null,
        adoption: null,
        progress: { stage: 'materialize', label: FRONTEND_STAGE_LABELS.materialize },
        error: null,
        notice: null,
        cancelRequested: false,
        history: pushHistory(current, { at: Date.now(), stage: 'build', status: 'running' }),
      });
    }

    case 'FRONTEND_PROGRESS': {
      if (!runMatches(current, act)) return sameState(current);
      if (current.cancelRequested) return sameState(current);
      const stage = FRONTEND_PROGRESS_STAGES.includes(act.stage) ? act.stage : null;
      if (!stage) return sameState(current);
      if (isFrontendBusy(current) === false) return sameState(current);
      return withViewState(current, {
        progress: {
          stage,
          label: FRONTEND_STAGE_LABELS[stage] || stage,
          attempt: Number.isInteger(act.attempt) ? act.attempt : null,
        },
      });
    }

    case 'FRONTEND_BUILD_SUCCESS': {
      if (current.status !== FRONTEND_STATUS.GENERATING) return sameState(current);
      if (!runMatches(current, act)) return sameState(current);
      const parsed = parseFrontendBuildResult(act.result);
      const staticOk = parsed.ok && parsed.staticVerification.ok;
      return withViewState(current, {
        status: staticOk ? FRONTEND_STATUS.PARTIAL : FRONTEND_STATUS.FAILED,
        candidate: parsed.candidate,
        staticVerification: parsed.staticVerification,
        runtimeVerification: null,
        progress: null,
        error: staticOk
          ? null
          : {
            code: parsed.code || 'FRONTEND_BUILD_FAILED',
            message: parsed.message || describeFrontendError(parsed.code || 'FRONTEND_BUILD_FAILED'),
            issues: parsed.staticVerification.issues,
          },
        notice: staticOk
          ? '静态门禁已通过；微信验证还没跑，采用前需要你单独确认。'
          : null,
        history: pushHistory(current, {
          at: Date.now(),
          stage: 'build',
          status: staticOk ? 'done' : 'failed',
          code: staticOk ? null : parsed.code,
        }),
      });
    }

    case 'FRONTEND_BUILD_FAILURE': {
      if (current.status !== FRONTEND_STATUS.GENERATING) return sameState(current);
      if (!runMatches(current, act)) return sameState(current);
      const failure = failureOf(act, 'FRONTEND_BUILD_FAILED');
      return withViewState(current, {
        status: FRONTEND_STATUS.FAILED,
        candidate: null,
        staticVerification: null,
        progress: null,
        error: failure,
        history: pushHistory(current, { at: Date.now(), stage: 'build', status: 'failed', code: failure.code }),
      });
    }

    case 'FRONTEND_VALIDATE_REQUEST': {
      if (requestInFlight(current)) return sameState(current);
      // 复核是「针对当前这个候选」的动作：身份不符说明是旧候选/旧 run 的遗留点击。
      if (!sameCandidateIdentity(current, act)) return sameState(current);
      return withViewState(current, {
        status: FRONTEND_STATUS.VALIDATING,
        pendingOp: 'validate',
        error: null,
        notice: null,
        cancelRequested: false,
        progress: { stage: 'compose', label: FRONTEND_STAGE_LABELS.compose },
        history: pushHistory(current, { at: Date.now(), stage: 'validate', status: 'running' }),
      });
    }

    case 'FRONTEND_VALIDATE_SUCCESS': {
      if (!pendingMatches(current, act, 'validate')) return sameState(current);
      const parsed = parseFrontendBuildResult(act.result);
      const staticOk = parsed.ok && parsed.staticVerification.ok;
      return withViewState(current, {
        status: staticOk
          ? (current.runtimeVerification && current.runtimeVerification.status === FRONTEND_RUNTIME_STATUS.PASS
            ? FRONTEND_STATUS.READY
            : FRONTEND_STATUS.PARTIAL)
          : FRONTEND_STATUS.FAILED,
        pendingOp: null,
        staticVerification: parsed.staticVerification,
        progress: null,
        error: staticOk ? null : { code: parsed.code, message: parsed.message || describeFrontendError(parsed.code) },
        history: pushHistory(current, { at: Date.now(), stage: 'validate', status: staticOk ? 'done' : 'failed' }),
      });
    }

    case 'FRONTEND_VALIDATE_FAILURE': {
      if (!pendingMatches(current, act, 'validate')) return sameState(current);
      const failure = failureOf(act, 'FRONTEND_VERIFICATION_MISSING');
      return withViewState(current, {
        status: current.candidate ? FRONTEND_STATUS.PARTIAL : FRONTEND_STATUS.FAILED,
        pendingOp: null,
        progress: null,
        error: failure,
        history: pushHistory(current, { at: Date.now(), stage: 'validate', status: 'failed', code: failure.code }),
      });
    }

    // ---- 微信真实验证 ----
    case 'FRONTEND_VERIFY_REQUEST': {
      if (requestInFlight(current)) return sameState(current);
      if (!current.candidate) return sameState(current);
      if (!current.staticVerification || current.staticVerification.ok !== true) return sameState(current);
      return withViewState(current, {
        status: FRONTEND_STATUS.VERIFYING,
        runtimeVerification: null,
        pendingOp: null,
        error: null,
        notice: null,
        cancelRequested: false,
        progress: { stage: 'verify', label: FRONTEND_STAGE_LABELS.verify },
        history: pushHistory(current, { at: Date.now(), stage: 'verify', status: 'running' }),
      });
    }

    case 'FRONTEND_VERIFY_SUCCESS': {
      if (current.status !== FRONTEND_STATUS.VERIFYING) return sameState(current);
      if (!runMatches(current, act)) return sameState(current);
      const parsed = parseFrontendVerifyResult(act.result);
      const pass = parsed.status === FRONTEND_RUNTIME_STATUS.PASS;
      return withViewState(current, {
        status: pass ? FRONTEND_STATUS.READY : FRONTEND_STATUS.PARTIAL,
        runtimeVerification: parsed,
        progress: null,
        error: pass ? null : {
          code: parsed.code || 'FRONTEND_VERIFY_FAILED',
          message: FRONTEND_RUNTIME_LABELS[parsed.status] || FRONTEND_ERROR_TEXT.FRONTEND_VERIFY_FAILED,
        },
        notice: pass
          ? '微信真实编译与关键页面验证通过，可以采用了。'
          : '微信验证没有拿到 PASS：候选仍可查看，但采用前需要你单独确认。',
        history: pushHistory(current, { at: Date.now(), stage: 'verify', status: pass ? 'done' : 'failed', code: parsed.code }),
      });
    }

    case 'FRONTEND_VERIFY_FAILURE': {
      if (current.status !== FRONTEND_STATUS.VERIFYING) return sameState(current);
      if (!runMatches(current, act)) return sameState(current);
      const failure = failureOf(act, 'FRONTEND_VERIFY_FAILED');
      return withViewState(current, {
        status: FRONTEND_STATUS.PARTIAL,
        runtimeVerification: null,
        progress: null,
        error: failure,
        notice: '微信验证没有完成，候选不会被自动采用。',
        history: pushHistory(current, { at: Date.now(), stage: 'verify', status: 'failed', code: failure.code }),
      });
    }

    // ---- 采用 / 放弃 ----
    case 'FRONTEND_ADOPT_REQUEST': {
      if (requestInFlight(current)) return sameState(current);
      // 采用必须绑定到「当前候选 + 当前 run/revision」：旧候选的点击不能落到新候选上。
      if (!sameCandidateIdentity(current, act)) return sameState(current);
      if (!current.staticVerification || current.staticVerification.ok !== true) return sameState(current);
      const runtimeStatus = current.runtimeVerification ? current.runtimeVerification.status : FRONTEND_RUNTIME_STATUS.NOT_RUN;
      if (runtimeStatus !== FRONTEND_RUNTIME_STATUS.PASS && act.partialConfirmed !== true) {
        return withViewState(current, {
          error: {
            code: 'FRONTEND_PARTIAL_CONFIRM_REQUIRED',
            message: FRONTEND_ERROR_TEXT.FRONTEND_PARTIAL_CONFIRM_REQUIRED,
          },
        });
      }
      return withViewState(current, {
        status: FRONTEND_STATUS.VALIDATING,
        pendingOp: 'adopt',
        error: null,
        notice: null,
        cancelRequested: false,
        progress: { stage: 'adopt', label: FRONTEND_STAGE_LABELS.adopt },
        history: pushHistory(current, { at: Date.now(), stage: 'adopt', status: 'running' }),
      });
    }

    case 'FRONTEND_ADOPT_SUCCESS': {
      if (!pendingMatches(current, act, 'adopt')) return sameState(current);
      const adoption = plainObject(act.adoption) ? act.adoption : {};
      return withViewState(current, {
        status: FRONTEND_STATUS.ADOPTED,
        pendingOp: null,
        adoption: {
          candidateId: cleanText(adoption.candidateId, 80) || current.candidate.candidateId,
          attempt: Number.isInteger(adoption.attempt) ? adoption.attempt : current.candidate.attempt,
          runtimeStatus: cleanText(adoption.runtimeStatus, 12) || FRONTEND_RUNTIME_STATUS.NOT_RUN,
          partialConfirmed: adoption.partialConfirmed === true,
          adoptedAt: cleanText(adoption.adoptedAt, 40) || new Date().toISOString(),
        },
        progress: null,
        error: null,
        notice: '已采用候选前端；当前版本已更新，可在项目里继续预览或撤销（撤销由项目快照负责）。',
        history: pushHistory(current, { at: Date.now(), stage: 'adopt', status: 'done' }),
      });
    }

    case 'FRONTEND_ADOPT_FAILURE': {
      if (!pendingMatches(current, act, 'adopt')) return sameState(current);
      const failure = failureOf(act, 'FRONTEND_ADOPT_FAILED');
      return withViewState(current, {
        status: current.candidate ? FRONTEND_STATUS.PARTIAL : FRONTEND_STATUS.FAILED,
        pendingOp: null,
        progress: null,
        error: failure,
        history: pushHistory(current, { at: Date.now(), stage: 'adopt', status: 'failed', code: failure.code }),
      });
    }

    case 'FRONTEND_DISCARD_REQUEST': {
      if (requestInFlight(current)) return sameState(current);
      if (!sameCandidateIdentity(current, act)) return sameState(current);
      return withViewState(current, {
        status: FRONTEND_STATUS.VALIDATING,
        pendingOp: 'discard',
        error: null,
        notice: null,
        progress: { stage: 'adopt', label: '放弃候选' },
      });
    }

    case 'FRONTEND_DISCARD_SUCCESS': {
      if (!pendingMatches(current, act, 'discard')) return sameState(current);
      return withViewState(current, {
        status: FRONTEND_STATUS.IDLE,
        pendingOp: null,
        candidate: null,
        staticVerification: null,
        runtimeVerification: null,
        adoption: null,
        progress: null,
        error: null,
        notice: '已放弃这个候选前端，当前版本没有被改动。',
        discardedAt: new Date().toISOString(),
      });
    }

    case 'FRONTEND_DISCARD_FAILURE': {
      if (!pendingMatches(current, act, 'discard')) return sameState(current);
      const failure = failureOf(act, 'FRONTEND_DISCARD_FAILED');
      return withViewState(current, {
        status: current.staticVerification && current.staticVerification.ok
          ? FRONTEND_STATUS.PARTIAL
          : FRONTEND_STATUS.FAILED,
        pendingOp: null,
        progress: null,
        error: failure,
      });
    }

    // ---- 取消 / 重试 ----
    case 'FRONTEND_CANCEL_REQUEST': {
      // 取消也必须绑定到当前 runId+revision：旧任务/旧输入的取消不能作用到新任务上。
      if (!strictRunMatches(current, act)) return sameState(current);
      if (!isFrontendBusy(current)) {
        return withViewState(current, {
          notice: FRONTEND_ERROR_TEXT.FRONTEND_NO_ACTIVE_RUN,
        });
      }
      return withViewState(current, {
        cancelRequested: true,
        notice: '正在取消候选前端任务…',
        progress: current.progress,
      });
    }

    case 'FRONTEND_CANCELLED': {
      // current.runId 为空（例如改图/切页后）时，旧 CANCELLED 必须整包忽略。
      if (!strictRunMatches(current, act)) return sameState(current);
      const keepCandidate = Boolean(current.candidate) && current.staticVerification && current.staticVerification.ok;
      return withViewState(current, {
        status: FRONTEND_STATUS.CANCELLED,
        pendingOp: null,
        candidate: keepCandidate ? current.candidate : null,
        staticVerification: keepCandidate ? current.staticVerification : null,
        runtimeVerification: null,
        progress: null,
        cancelRequested: false,
        error: null,
        notice: FRONTEND_ERROR_TEXT.FRONTEND_CANCELLED,
        history: pushHistory(current, { at: Date.now(), stage: 'cancel', status: 'done' }),
      });
    }

    case 'FRONTEND_RETRY': {
      if (isFrontendBusy(current)) return sameState(current);
      let status = FRONTEND_STATUS.IDLE;
      if (current.candidate && current.staticVerification && current.staticVerification.ok) status = FRONTEND_STATUS.PARTIAL;
      else if (current.analysis && current.analysis.status === 'planned') status = FRONTEND_STATUS.PLANNING;
      else if (current.analysis && current.analysis.status === 'needs-input') status = FRONTEND_STATUS.NEEDS_INPUT;
      return withViewState(current, {
        status,
        pendingOp: null,
        error: null,
        notice: null,
        cancelRequested: false,
        discardedAt: null,
      });
    }

    case 'FRONTEND_RESET': {
      const keepImage = act.keepImage !== false;
      return withViewState(createInitialFrontendReconstructState(), {
        revision: current.revision + 1,
        history: [],
        request: {
          ...createInitialFrontendReconstructState().request,
          utterance: keepImage ? current.request.utterance : '',
          image: keepImage ? current.request.image : null,
          targetPages: current.request.targetPages,
        },
      });
    }

    default:
      return sameState(current);
  }
}

// ---------------------------------------------------------------------------
// 视图模型
// ---------------------------------------------------------------------------

const STATUS_COPY = Object.freeze({
  idle: { tone: 'idle', title: '还没生成候选前端', body: '上传一张参考截图并补充要求，先看能力覆盖，确认后再生成候选。' },
  analyzing: { tone: 'running', title: '正在识别截图', body: '正在做视觉分析与能力覆盖；识别完成前不会写任何候选文件。' },
  planning: { tone: 'ready', title: '识别完成，可以生成候选', body: '分区与能力覆盖已给出；点「构建候选工程」后才会在私有工作区生成文件。' },
  generating: { tone: 'running', title: '正在构建候选工程', body: '正在写入私有工作区并跑 Composer 与小程序静态门禁；当前版本不会被改动。' },
  validating: { tone: 'running', title: '正在复核候选', body: '正在复核候选的静态门禁与验证证据。' },
  verifying: { tone: 'running', title: '正在做微信真实验证', body: '正在用微信开发者工具编译候选工程并截图；这一步可能比较慢，可随时取消。' },
  ready: { tone: 'ready', title: '候选通过静态与微信验证', body: '静态门禁与微信关键页面验证都通过，可以采用。' },
  partial: { tone: 'degraded', title: '静态门禁通过，微信验证未完成', body: '候选可以构建，但微信真实编译/截图还没有 PASS；采用前需要你单独确认。' },
  needs_input: { tone: 'degraded', title: '还缺一些信息', body: '识别到不确定项，回答下面的问题后再生成；什么都不改。' },
  rejected: { tone: 'failed', title: '这个需求当前不支持', body: '缺少必需能力，不会生成候选、也不会写文件；可以换一张更接近现有能力的截图。' },
  failed: { tone: 'failed', title: '这次没有成功', body: '输入都保留着，可以直接重试；当前版本没有被覆盖。' },
  cancelled: { tone: 'idle', title: '已取消', body: '任务已取消，输入与当前版本都没有变化。' },
  adopted: { tone: 'ready', title: '已采用候选前端', body: '当前版本已切换到候选；撤销由项目快照负责，候选文件仍保留在私有工作区。' },
});

export function describeFrontendStatus(status) {
  return STATUS_COPY[status] || STATUS_COPY.idle;
}

function progressView(state) {
  if (state.progress && state.progress.stage) {
    const stage = state.progress.stage;
    const total = FRONTEND_PROGRESS_STAGES.length;
    const index = Math.max(0, FRONTEND_PROGRESS_STAGES.indexOf(stage));
    return {
      stage,
      label: state.progress.label || FRONTEND_STAGE_LABELS[stage] || stage,
      step: index + 1,
      total,
      percent: Math.round(((index + 1) / total) * 100),
    };
  }
  if (isFrontendBusy(state)) {
    const fallback = state.status === FRONTEND_STATUS.ANALYZING ? 'analyze' : 'materialize';
    return {
      stage: fallback,
      label: FRONTEND_STAGE_LABELS[fallback],
      step: Math.max(1, FRONTEND_PROGRESS_STAGES.indexOf(fallback) + 1),
      total: FRONTEND_PROGRESS_STAGES.length,
      percent: Math.round(((FRONTEND_PROGRESS_STAGES.indexOf(fallback) + 1) / FRONTEND_PROGRESS_STAGES.length) * 100),
    };
  }
  return null;
}

function analysisView(analysis) {
  if (!analysis) return null;
  return {
    status: analysis.status,
    statusLabel: analysis.status === 'planned'
      ? '可以生成候选'
      : analysis.status === 'needs-input'
        ? '需要补充信息'
        : '当前不支持',
    summary: analysis.summary,
    pages: analysis.pages.map((page) => ({
      pageId: page.pageId,
      pageLabel: page.pageLabel,
      layout: page.layout,
      layoutLabel: page.layoutLabel,
      sectionCount: page.sectionCount,
      sections: page.regions.map((region) => ({
        id: region.id,
        type: region.type,
        label: region.label,
        order: region.order,
        confidence: Math.round((Number(region.confidence) || 0) * 100),
        children: region.children.map((child) => ({ id: child.id, label: child.label })),
      })),
    })),
    sectionCount: analysis.pages.reduce((sum, page) => sum + page.sectionCount, 0),
    mustKeep: analysis.mustKeep,
    approximate: analysis.approximate,
    unsupported: analysis.unsupported,
    unknownRegions: analysis.unknownRegions,
    lowConfidence: analysis.lowConfidence,
    inferredInteractions: analysis.inferredInteractions,
    questions: analysis.questions,
    coverage: {
      status: analysis.coverage.status,
      statusLabel: analysis.coverage.status === 'covered'
        ? '能力已覆盖'
        : analysis.coverage.status === 'partial'
          ? '只能部分覆盖'
          : '缺必需能力',
      requiredCount: analysis.coverage.requiredCapabilities.length,
      missingCount: analysis.coverage.missingCapabilities.length,
      missing: analysis.coverage.missingCapabilities,
      risks: analysis.coverage.risks,
      degradations: analysis.coverage.degradations,
    },
    style: {
      densityLabel: analysis.visual.density === 'compact' ? '紧凑' : '舒展',
      themeCount: Object.keys(analysis.visual.theme || {}).length,
      sizeCount: Object.keys(analysis.visual.sizes || {}).length,
    },
    meta: analysis.meta,
    trace: analysis.trace,
    hasDraft: Boolean(analysis.draft),
  };
}

function candidateView(candidate) {
  if (!candidate) return null;
  return {
    candidateId: candidate.candidateId,
    label: candidate.candidateId ? `候选 ${candidate.candidateId}（v${candidate.candidateVersion || '1.0.0'}）` : '候选前端',
    attempt: candidate.attempt,
    pages: candidate.pages,
    files: candidate.files,
    digestShort: candidate.digest ? String(candidate.digest).replace(/^sha256:/, '').slice(0, 12) : '',
    degradations: candidate.degradations,
  };
}

function verificationView(state) {
  const staticV = state.staticVerification;
  const runtimeV = state.runtimeVerification;
  if (!staticV && !runtimeV) return null;
  const staticOk = Boolean(staticV && staticV.ok);
  const runtimeStatus = runtimeV ? runtimeV.status : FRONTEND_RUNTIME_STATUS.NOT_RUN;
  return {
    static: staticV
      ? {
        ok: staticV.ok,
        code: staticV.code,
        summary: staticV.summary,
        checks: staticV.checks,
        issues: staticV.issues,
        failedCount: staticV.checks.filter((item) => item.status === 'fail').length,
      }
      : null,
    repairs: staticV ? staticV.repairs : 0,
    repairLimit: FRONTEND_LIMITS.maxRepairRounds,
    repairStatus: staticV ? staticV.repairStatus : 'not_available',
    repairNote: staticV && staticV.repairStatus === 'not_available'
      ? `本次没有执行自动修复（本机未接入受控修复通道），修复次数 0 / ${FRONTEND_LIMITS.maxRepairRounds} 轮。`
      : `自动修复 ${staticV ? staticV.repairs : 0} 轮，上限 ${FRONTEND_LIMITS.maxRepairRounds} 轮。`,
    runtime: runtimeV
      ? {
        status: runtimeV.status,
        statusLabel: FRONTEND_RUNTIME_LABELS[runtimeV.status] || runtimeV.status,
        code: runtimeV.code,
        summary: runtimeV.summary,
        screenshots: runtimeV.screenshots,
        pages: runtimeV.pages,
        interactions: runtimeV.interactions,
        verifiedAt: runtimeV.at,
      }
      : {
        status: FRONTEND_RUNTIME_STATUS.NOT_RUN,
        statusLabel: FRONTEND_RUNTIME_LABELS.NOT_RUN,
        code: null,
        summary: staticOk ? '微信验证还没执行；采用前需要你单独确认。' : '',
        screenshots: [],
        pages: [],
        interactions: [],
        verifiedAt: null,
      },
    staticOk,
    runtimeStatus,
    runtimePass: runtimeStatus === FRONTEND_RUNTIME_STATUS.PASS,
    requiresPartialConfirmation: staticOk && runtimeStatus !== FRONTEND_RUNTIME_STATUS.PASS,
  };
}

export function buildFrontendReconstructView(state) {
  const s = state || createInitialFrontendReconstructState();
  const busy = isFrontendBusy(s);
  const copy = describeFrontendStatus(s.status);
  const analysis = analysisView(s.analysis);
  const candidate = candidateView(s.candidate);
  const verification = verificationView(s);
  const staticOk = Boolean(verification && verification.staticOk);
  const runtimePass = Boolean(verification && verification.runtimePass);
  const hasCandidate = Boolean(candidate);
  const adopted = s.status === FRONTEND_STATUS.ADOPTED;
  const requiresPartialConfirmation = Boolean(verification && verification.requiresPartialConfirmation);
  const canAdopt = hasCandidate && staticOk && !busy && !adopted;
  let adoptBlockedReason = null;
  if (!hasCandidate) adoptBlockedReason = '还没有可采用的候选。';
  else if (!staticOk) adoptBlockedReason = FRONTEND_ERROR_TEXT.FRONTEND_STATIC_GATES_FAILED;
  else if (adopted) adoptBlockedReason = '这个候选已经采用过了。';
  else if (busy) adoptBlockedReason = '任务正在运行，等它结束再采用。';

  const error = s.error
    ? {
      code: s.error.code || 'FRONTEND_FAILED',
      message: s.error.message || describeFrontendError(s.error.code),
      issues: Array.isArray(s.error.issues) ? s.error.issues : [],
    }
    : null;

  return {
    status: s.status,
    tone: copy.tone,
    busy,
    title: copy.title,
    body: copy.body,
    request: {
      utterance: s.request.utterance,
      image: s.request.image
        ? { name: s.request.image.name, mediaType: s.request.image.mediaType, previewUrl: s.request.image.previewUrl, bytes: s.request.image.bytes }
        : null,
      targetPages: s.request.targetPages,
      targetPageOptions: FRONTEND_TARGET_PAGES.map((pageId) => ({
        id: pageId,
        label: FRONTEND_TARGET_PAGE_LABELS[pageId],
        checked: s.request.targetPages.includes(pageId),
      })),
    },
    progress: progressView(s),
    analysis,
    candidate,
    verification,
    adoption: s.adoption,
    error,
    notice: s.notice,
    history: Array.isArray(s.history) ? s.history.slice(0, FRONTEND_LIMITS.maxHistory) : [],
    canAnalyze: Boolean(s.request.image) && !busy && !adopted,
    canBuild: Boolean(analysis && analysis.status === 'planned' && analysis.hasDraft) && !busy && !hasCandidate,
    canVerify: Boolean(hasCandidate && staticOk) && !busy,
    // 复核（只读重查 dry-run 证据/overlay）也是候选级动作，必须绑定同一个候选。
    canValidate: hasCandidate && !busy,
    canAdopt,
    adoptNeedsPartialConfirm: requiresPartialConfirmation,
    adoptBlockedReason,
    canDiscard: hasCandidate && !busy,
    canCancel: busy,
    canRetry: !busy && !adopted && [FRONTEND_STATUS.FAILED, FRONTEND_STATUS.CANCELLED, FRONTEND_STATUS.REJECTED, FRONTEND_STATUS.NEEDS_INPUT].includes(s.status),
    canReset: !busy,
    modeNote: '候选只在桌面应用的私有工作区生成；这里不做像素级复刻承诺，也不复制对方的品牌素材。',
    partialNote: requiresPartialConfirmation
      ? '微信验证未完成：静态门禁已通过，但真实编译/截图没有 PASS。采用这个候选需要你单独确认。'
      : null,
  };
}
