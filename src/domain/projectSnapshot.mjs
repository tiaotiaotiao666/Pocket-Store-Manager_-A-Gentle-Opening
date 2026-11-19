/**
 * project.json 快照序列化（纯函数，可在 Node 中测试）。
 *
 * 这是「什么进磁盘 / 什么只是内存投影」的唯一实现：
 * - toDocument(state) 剥离全部 transient（动画、进度、错误、派生 agent 字段）；
 * - fromDocument(doc) 重建派生状态，并对损坏/越界数据做降级；
 * - 未知字段原样保留在 unmappedFields，旧版本打开新项目再保存不丢数据。
 *
 * 契约来源：docs/2026-10-31-P0工作台与交接-实现方案.md 4.1、4.4、7.3。
 */

import { PHASES } from '../state/constants.mjs';
import { features as catalogFeatures } from './catalog.mjs';
import { STYLE_PRESETS } from './storeBrief.mjs';
import { normalizeAgentDraft, validateAgentDraft, buildNextQuestion } from './agentDraft.mjs';
import { validatePresentationPatch } from './presentationPatch.mjs';
import { resolveRecipe } from './recipeCatalog.mjs';
import { buildScreenRefView } from './screenReference.mjs';

export const SNAPSHOT_SCHEMA_VERSION = 1;
export const MAX_SESSIONS = 20;
export const MAX_MESSAGES = 200;
export const MAX_PROMPT_ROUNDS = 12;
export const MAX_IMAGE_ROUNDS = 12;

export const KNOWN_TOP_KEYS = Object.freeze([
  'schemaVersion',
  'projectId',
  'createdAt',
  'updatedAt',
  'name',
  'phase',
  'activeSessionId',
  'store',
  'features',
  'build',
  'visual',
  'presentation',
  'agentDraft',
  'screenRef',
  'frontendCandidate',
  'agentConfirmedSeq',
  'assets',
  'sessions',
  'seq',
  'deploy',
  'appid',
  'lastExportParent',
]);

const REQUIRED_FEATURE_IDS = catalogFeatures.filter((feature) => feature.required).map((feature) => feature.id);
const PHASE_VALUES = new Set(Object.values(PHASES));
const STYLE_IDS = new Set(STYLE_PRESETS.map((preset) => preset.id));
const HANDOFF_STEP_IDS = new Set(['prepare', 'import', 'appid', 'domain', 'preview', 'next']);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value, maxLength) {
  const result = typeof value === 'string' ? value : '';
  return maxLength ? result.slice(0, maxLength) : result;
}

function integerOrNull(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function arrayOf(value) {
  return Array.isArray(value) ? value : [];
}

export function createEmptyPreflight() {
  return {
    status: 'idle',
    errors: [],
    warns: [],
    infos: [],
    acknowledged: [],
    planDigest: null,
    checkedAt: null,
    error: null,
  };
}

export function createEmptyDeployState() {
  return {
    status: 'idle',
    stage: 0,
    step: 0,
    progress: 0,
    taskId: null,
    directory: '',
    projectName: '',
    result: null,
    error: null,
    previewOnly: [],
    versionGaps: [],
    warnings: [],
    stageMessage: '',
    busy: false,
    resultDigest: null,
    preflight: createEmptyPreflight(),
    handoff: null,
    import: {
      status: 'idle',
      preview: null,
      confirmations: [],
      busy: false,
      error: null,
      result: null,
    },
  };
}

export function createEmptyAgentState() {
  return {
    status: 'idle',
    lastUtterance: '',
    lastError: null,
    attempts: 0,
    missingFields: [],
    errors: [],
    nextQuestion: null,
    reply: '',
    meta: null,
    simulateFailure: false,
    turnId: null,
    confirmedAtSeq: null,
  };
}

/**
 * 展示补丁进磁盘的白名单键（W0 / P0-2）。
 *
 * 只持久化「已确认的展示结果」：模板身份 + 过校验的补丁本体。
 * `status` / `requestId` / `error` / `lastUtterance` / 撤销栈都属于请求期状态，
 * 一律不落盘，重开项目时按 idle 重新构造。
 */
export const PRESENTATION_SNAPSHOT_KEYS = Object.freeze(['templateId', 'patch']);

/**
 * `C-SESSION-PRESENTATION@1` 的持久化友好初始切片。
 *
 * 字段与 `sessionMachine.createInitialPresentationSlice()` 严格一致（plan.md 2.2.3），
 * 不额外加字段：切片形状本身是被测试锁住的契约。
 * 恢复阶段的异常原因走 `fromDocument().presentationRestore`，不塞进切片。
 */
export function createEmptyPresentationSlice() {
  return {
    templateId: null,
    patch: {},
    changes: [],
    status: 'idle',
    requestId: null,
    lastUtterance: '',
    error: null,
  };
}

const PRESENTATION_FEATURE_KIND = Object.freeze({ 'poster-carousel': 'feature-pack' });

/**
 * 构造展示补丁校验上下文。
 *
 * 与 `sessionMachine.presentationContext` 口径一致：已占用 feature 来自当前模板的
 * Recipe 投影，`baseDraft.dishes` 决定菜品文案能否按 id 落位。
 *
 * @param {string|null} templateId
 * @param {Array} dishes
 */
export function buildPresentationContext(templateId, dishes) {
  const { recipe } = resolveRecipe(templateId ?? null);
  const features = Array.isArray(recipe && recipe.features) ? recipe.features : [];
  const occupiedFeatures = features.map((feature) => ({
    id: feature.id,
    kind: PRESENTATION_FEATURE_KIND[feature.id] ?? 'feature-pack',
  }));
  return {
    occupiedFeatures,
    hasCarousel: occupiedFeatures.some((feature) => feature.id === 'poster-carousel'),
    baseDraft: { dishes: Array.isArray(dishes) ? dishes : [] },
  };
}

/** 内存 → 磁盘：只留 templateId 与通过校验的 patch。 */
function pickPresentation(presentation, selectedId, dishes) {
  const source = isPlainObject(presentation) ? presentation : {};
  const templateId = typeof source.templateId === 'string' && source.templateId
    ? source.templateId
    : (typeof selectedId === 'string' && selectedId ? selectedId : null);
  const raw = isPlainObject(source.patch) ? source.patch : {};
  if (Object.keys(raw).length === 0) return { templateId, patch: {} };
  const validated = validatePresentationPatch(raw, buildPresentationContext(templateId, dishes));
  // 落盘只存规范化后的补丁；校验不过就不写，避免把非法内容固化进项目文件。
  return { templateId, patch: validated.ok ? validated.patch : {} };
}

/**
 * 磁盘 → 内存：旧快照兼容 + 非法内容安全回退。
 *
 * - 文档里没有 `presentation`（旧项目）：返回空补丁，模板身份取当前选中模板。
 * - 补丁属于另一个模板：丢弃补丁并给出 notice，绝不错配应用。
 * - 补丁校验不通过：丢弃补丁并给出 notice。
 *
 * @returns {{presentation: object, notice: null|{code: string, message: string}}}
 */
export function restorePresentationSlice(saved, selectedId, dishes) {
  const slice = createEmptyPresentationSlice();
  const source = isPlainObject(saved) ? saved : {};
  const fallbackTemplateId = typeof selectedId === 'string' && selectedId ? selectedId : null;
  const savedTemplateId = typeof source.templateId === 'string' && source.templateId ? source.templateId : null;
  const raw = isPlainObject(source.patch) ? source.patch : {};

  if (Object.keys(raw).length === 0) {
    return { presentation: { ...slice, templateId: savedTemplateId ?? fallbackTemplateId }, notice: null };
  }
  if (savedTemplateId && fallbackTemplateId && savedTemplateId !== fallbackTemplateId) {
    return {
      presentation: { ...slice, templateId: fallbackTemplateId },
      notice: {
        code: 'PRESENTATION_PATCH_TEMPLATE_MISMATCH',
        message: '保存的展示修改属于另一个模板，已忽略；当前模板沿用默认外观。',
      },
    };
  }

  const templateId = savedTemplateId ?? fallbackTemplateId;
  const validated = validatePresentationPatch(raw, buildPresentationContext(templateId, dishes));
  if (!validated.ok) {
    const first = Array.isArray(validated.details) && validated.details.length > 0 ? validated.details[0] : null;
    return {
      presentation: { ...slice, templateId },
      notice: {
        code: 'PRESENTATION_PATCH_DISCARDED',
        message: `保存的展示修改无法应用（${first && first.code ? first.code : 'PRESENTATION_PATCH_INVALID'}），已回退到默认外观。`,
      },
    };
  }

  return {
    presentation: {
      ...slice,
      templateId,
      patch: validated.patch,
      changes: Array.isArray(validated.changes) ? validated.changes : [],
    },
    notice: null,
  };
}

function pickStore(store) {
  const source = isPlainObject(store) ? store : {};
  return {
    name: text(source.name, 48),
    type: text(source.type, 32),
    notes: text(source.notes ?? source.intro, 200),
    address: text(source.address, 120),
    phone: text(source.phone, 32),
    logoAssetId: typeof source.logoAssetId === 'string' ? source.logoAssetId : null,
    imageAssetIds: arrayOf(source.imageAssetIds)
      .filter((item) => typeof item === 'string')
      .slice(0, 6),
  };
}

function pickFeatures(features) {
  const source = isPlainObject(features) ? features : {};
  const selected = [...new Set([...REQUIRED_FEATURE_IDS, ...arrayOf(source.selected).filter((item) => typeof item === 'string')])];
  return { selected, custom: text(source.custom, 500) };
}

function pickCandidates(candidates) {
  return arrayOf(candidates)
    .filter((item) => isPlainObject(item) && typeof item.id === 'string')
    .slice(0, 5)
    .map((item) => ({
      id: item.id,
      name: text(item.name, 40),
      layout: text(item.layout, 24),
      score: Number.isFinite(item.score) ? Math.round(item.score) : 0,
      summary: text(item.summary, 160),
    }));
}

function pickBuild(build) {
  const source = isPlainObject(build) ? build : {};
  const candidates = pickCandidates(source.candidates);
  const selectedId = candidates.some((item) => item.id === source.selectedId)
    ? source.selectedId
    : (candidates[0] ? candidates[0].id : null);
  // 模板页「重新描述」的累积文本要能随项目保存，打开项目后还能继续沿用；
  // 只留最近 8 条、每条 300 字，避免 project.json 被无意义的长文本撑大。
  const feedback = arrayOf(source.feedback)
    .map((item) => text(item, 300))
    .filter(Boolean)
    .slice(-8);
  return { candidates, selectedId, feedback };
}

function pickRounds(rounds, withAsset) {
  return arrayOf(rounds)
    .filter((round) => isPlainObject(round))
    .slice(-MAX_PROMPT_ROUNDS)
    .map((round) => {
      const item = { text: text(round.text, 500), reply: text(round.reply, 500) };
      if (withAsset && typeof round.assetId === 'string') item.assetId = round.assetId;
      return item;
    });
}

function pickVisual(visual) {
  const source = isPlainObject(visual) ? visual : {};
  const imageMeta = isPlainObject(source.imageMeta)
    ? {
      provider: text(source.imageMeta.provider, 40),
      note: text(source.imageMeta.note, 200),
      width: Number.isFinite(source.imageMeta.width) ? source.imageMeta.width : undefined,
      height: Number.isFinite(source.imageMeta.height) ? source.imageMeta.height : undefined,
    }
    : null;
  return {
    styleId: STYLE_IDS.has(source.styleId) ? source.styleId : STYLE_PRESETS[0].id,
    prompt: text(source.prompt, 2000),
    promptRounds: pickRounds(source.promptRounds, false),
    imageAssetId: typeof source.imageAssetId === 'string' ? source.imageAssetId : null,
    imageMeta,
    imageRounds: pickRounds(source.imageRounds, true),
  };
}

function pickAgentDraft(draft) {
  const normalized = normalizeAgentDraft(draft);
  return {
    storeName: text(normalized.storeName, 48),
    category: text(normalized.category, 24),
    businessHours: text(normalized.businessHours, 120),
    fulfillment: { dineIn: Boolean(normalized.fulfillment.dineIn), takeaway: Boolean(normalized.fulfillment.takeaway) },
    dishes: normalized.dishes.map((dish) => ({
      id: text(dish.id, 24),
      name: text(dish.name, 24),
      priceCents: Number.isInteger(dish.priceCents) ? dish.priceCents : null,
      priceText: text(dish.priceText, 16),
      description: text(dish.description, 60),
    })),
  };
}

function pickHandoff(handoff) {
  if (!isPlainObject(handoff)) return null;
  const stepId = HANDOFF_STEP_IDS.has(handoff.stepId) ? handoff.stepId : 'prepare';
  return {
    stepId,
    completedStepIds: arrayOf(handoff.completedStepIds)
      .filter((id) => HANDOFF_STEP_IDS.has(id))
      .filter((id, index, list) => list.indexOf(id) === index),
    appidApplied: handoff.appidApplied === true,
    appidDigestBefore: typeof handoff.appidDigestBefore === 'string' ? handoff.appidDigestBefore : null,
    appidDigestAfter: typeof handoff.appidDigestAfter === 'string' ? handoff.appidDigestAfter : null,
    devtoolsDetected: handoff.devtoolsDetected === true,
    updatedAt: text(handoff.updatedAt, 40),
  };
}

function pickDeploy(deploy) {
  const source = isPlainObject(deploy) ? deploy : {};
  return {
    directory: text(source.directory, 1200),
    projectName: text(source.projectName, 60),
    resultDigest: typeof source.resultDigest === 'string' ? source.resultDigest : null,
    handoff: pickHandoff(source.handoff),
  };
}

function trimMessages(messages) {
  const source = arrayOf(messages).filter((message) => isPlainObject(message));
  let trimmed = source;
  if (source.length > MAX_MESSAGES) {
    // 保留第一条（通常是命名引导）与最近 199 条，避免重启后语义断裂。
    trimmed = [source[0], ...source.slice(-(MAX_MESSAGES - 1))];
  }
  return trimmed.map((message) => ({
    id: text(message.id, 24),
    role: message.role === 'user' || message.role === 'system' ? message.role : 'agent',
    text: text(message.text, 4000),
    meta: isPlainObject(message.meta) ? message.meta : null,
  }));
}

function pickSessions(sessions) {
  return arrayOf(sessions)
    .filter((session) => isPlainObject(session) && typeof session.id === 'string')
    .slice(0, MAX_SESSIONS)
    .map((session) => ({
      id: session.id,
      title: text(session.title, 60) || '会话',
      kind: session.kind === 'step' ? 'step' : 'main',
      status: text(session.status, 16) || 'active',
      messages: trimMessages(session.messages),
      handoff: isPlainObject(session.handoff) ? session.handoff : null,
    }));
}

function pickImages(images) {
  return arrayOf(images)
    .filter((item) => isPlainObject(item) && typeof item.assetId === 'string')
    .map((item) => ({
      assetId: item.assetId,
      fileName: text(item.fileName, 40),
      originalName: text(item.originalName, 120),
      mime: ['image/png', 'image/jpeg', 'image/webp'].includes(item.mime) ? item.mime : 'image/png',
      bytes: Number.isInteger(item.bytes) ? item.bytes : 0,
      width: Number.isFinite(item.width) ? item.width : undefined,
      height: Number.isFinite(item.height) ? item.height : undefined,
      sha256: text(item.sha256, 80),
      createdAt: text(item.createdAt, 40),
    }));
}

/**
 * P3：参考截图切片（`state.screenRef`）的空实现与持久化。
 *
 * 口径与 assets 一致：**base64 与预览 dataURL 一律不落盘**，只存 assetId 等白名单字段；
 * `recognizing` 是非稳定状态，重开后按「未完成」处理，绝不假装识别结果还在。
 */
export const SCREEN_REF_DOC_STATUSES = Object.freeze(['idle', 'ready', 'degraded', 'failed']);

export function createEmptyScreenRefState() {
  const slice = {
    status: 'idle',
    image: null,
    imageRevision: 0,
    requestId: null,
    requestImageRevision: null,
    recognition: null,
    confirmedAt: null,
    candidate: null,
    adopted: false,
    previousSelection: null,
    lastDiscarded: null,
    error: null,
    attempt: 0,
    meta: null,
  };
  return { ...slice, view: buildScreenRefView(slice) };
}

function pickScreenRefImage(image) {
  if (!isPlainObject(image)) return null;
  return {
    assetId: typeof image.assetId === 'string' ? image.assetId.slice(0, 120) : null,
    name: text(image.name, 120),
    mediaType: text(image.mediaType, 40),
    bytes: integerOrNull(image.bytes),
  };
}

function pickScreenRefItems(items, limit) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, limit).map((item) => ({
    label: text(item?.label ?? item?.id, 120),
    reason: text(item?.reason, 120),
  }));
}

function pickScreenRefRecognition(recognition) {
  if (!isPlainObject(recognition)) return null;
  const theme = {};
  const rawTheme = isPlainObject(recognition.style?.theme) ? recognition.style.theme : {};
  Object.keys(rawTheme).forEach((key) => {
    const value = rawTheme[key];
    if (typeof value === 'string' && /^#[0-9A-Fa-f]{6}$/.test(value)) theme[key] = value.toUpperCase();
  });
  const sizes = {};
  const rawSizes = isPlainObject(recognition.style?.sizes) ? recognition.style.sizes : {};
  Object.keys(rawSizes).forEach((key) => {
    if (['sm', 'md', 'lg'].includes(rawSizes[key])) sizes[key] = rawSizes[key];
  });
  return {
    layouts: arrayOf(recognition.layouts).filter((item) => isPlainObject(item) && typeof item.id === 'string')
      .slice(0, 4)
      .map((item) => ({ id: text(item.id, 60), label: text(item.label, 60) })),
    components: arrayOf(recognition.components).filter((item) => isPlainObject(item) && typeof item.id === 'string')
      .slice(0, 16)
      .map((item) => ({ id: text(item.id, 60), label: text(item.label, 60) })),
    style: { theme, sizes },
    approximate: pickScreenRefItems(recognition.approximate, 6),
    unsupported: pickScreenRefItems(recognition.unsupported, 8),
    rejected: [],
    notes: text(recognition.notes, 240),
  };
}

function pickScreenRefCandidate(candidate) {
  if (!isPlainObject(candidate)) return null;
  const store = isPlainObject(candidate.storeSnapshot) ? candidate.storeSnapshot : {};
  return {
    id: text(candidate.id, 80),
    recipeId: text(candidate.recipeId, 60),
    recipeLabel: text(candidate.recipeLabel, 60),
    featureIds: arrayOf(candidate.featureIds).filter((id) => typeof id === 'string').slice(0, 16),
    presentation: pickScreenRefRecognition({ style: candidate.presentation })?.style
      ?? { theme: {}, sizes: {} },
    storeSnapshot: {
      storeName: text(store.storeName, 120),
      category: text(store.category, 60),
      businessHours: text(store.businessHours, 120),
      dishes: arrayOf(store.dishes).slice(0, 40).map((dish) => ({
        id: text(dish?.id, 60),
        name: text(dish?.name, 80),
        priceCents: Number.isInteger(dish?.priceCents) ? dish.priceCents : null,
        description: text(dish?.description, 200),
      })),
    },
    approximate: pickScreenRefItems(candidate.approximate, 6),
    unsupported: pickScreenRefItems(candidate.unsupported, 8),
    source: 'screen-reference',
    createdAt: text(candidate.createdAt, 40),
  };
}

function pickScreenRefPreviousSelection(selection) {
  if (!isPlainObject(selection)) return null;
  return {
    selectedId: typeof selection.selectedId === 'string' ? selection.selectedId.slice(0, 60) : null,
    candidateIds: arrayOf(selection.candidateIds).filter((id) => typeof id === 'string').slice(0, 8),
    features: arrayOf(selection.features).filter((id) => typeof id === 'string').slice(0, 32),
    presentation: {
      templateId: typeof selection.presentation?.templateId === 'string'
        ? selection.presentation.templateId.slice(0, 60)
        : null,
      patch: isPlainObject(selection.presentation?.patch)
        ? JSON.parse(JSON.stringify(selection.presentation.patch))
        : {},
    },
  };
}

/** 内存切片 → project.json 的 `screenRef`（白名单字段）。 */
export function pickScreenRef(screenRef) {
  const source = isPlainObject(screenRef) ? screenRef : {};
  const status = SCREEN_REF_DOC_STATUSES.includes(source.status) ? source.status : 'idle';
  return {
    status,
    image: pickScreenRefImage(source.image),
    imageRevision: integerOrNull(source.imageRevision) ?? 0,
    recognition: pickScreenRefRecognition(source.recognition),
    confirmedAt: typeof source.confirmedAt === 'string' ? source.confirmedAt.slice(0, 40) : null,
    candidate: pickScreenRefCandidate(source.candidate),
    adopted: source.adopted === true,
    previousSelection: pickScreenRefPreviousSelection(source.previousSelection),
    lastDiscarded: pickScreenRefDiscarded(source.lastDiscarded),
    attempt: integerOrNull(source.attempt) ?? 0,
  };
}

/** 放弃参考候选的痕迹（只留模板 id 与时间，不含任何内容）。 */
function pickScreenRefDiscarded(value) {
  if (!isPlainObject(value)) return null;
  const templateId = typeof value.templateId === 'string' ? value.templateId.slice(0, 60) : null;
  if (!templateId) return null;
  return {
    templateId,
    recipeId: typeof value.recipeId === 'string' ? value.recipeId.slice(0, 60) : null,
    label: text(value.label, 60),
    at: typeof value.at === 'string' ? value.at.slice(0, 40) : null,
  };
}

/** project.json 的 `screenRef` → 内存切片（含视图模型）。 */
export function restoreScreenRef(saved) {
  const empty = createEmptyScreenRefState();
  if (!isPlainObject(saved)) return empty;
  const image = pickScreenRefImage(saved.image);
  const recognition = pickScreenRefRecognition(saved.recognition);
  // 识别中的状态不落盘：没有结果就当没做过，避免重开后出现「假结果」。
  const status = SCREEN_REF_DOC_STATUSES.includes(saved.status) && recognition ? saved.status : 'idle';
  const slice = {
    ...empty,
    status,
    image,
    imageRevision: integerOrNull(saved.imageRevision) ?? 0,
    recognition,
    confirmedAt: typeof saved.confirmedAt === 'string' ? saved.confirmedAt.slice(0, 40) : null,
    candidate: pickScreenRefCandidate(saved.candidate),
    adopted: saved.adopted === true,
    previousSelection: pickScreenRefPreviousSelection(saved.previousSelection),
    lastDiscarded: pickScreenRefDiscarded(saved.lastDiscarded),
    attempt: integerOrNull(saved.attempt) ?? 0,
  };
  return { ...slice, view: buildScreenRefView(slice) };
}

// ---------------------------------------------------------------------------
// P5：已采用候选前端（项目私有 FrontendPack overlay）的持久化
// ---------------------------------------------------------------------------

export const FRONTEND_CANDIDATE_SCHEMA_VERSION = 'frontend-candidate-adoption.v1';
export const FRONTEND_CANDIDATE_STATUSES = Object.freeze(['none', 'adopted', 'unavailable']);
export const FRONTEND_CANDIDATE_LIMITS = Object.freeze({
  maxText: 120,
  maxId: 80,
  maxVersion: 24,
  maxPath: 240,
  maxIssueChars: 160,
  maxScreenshots: 24,
  maxPreviousDepth: 1,
});

const FRONTEND_RUNTIME_STATUSES = Object.freeze(['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN']);
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const DRIVE_PATTERN = /^[A-Za-z]:/;

/** overlay/证据路径只接受规范 POSIX 相对路径：绝对路径、盘符、`..`、反斜杠一律丢弃。 */
function canonicalRelativePath(value) {
  if (typeof value !== 'string' || !value || value.length > FRONTEND_CANDIDATE_LIMITS.maxPath) return null;
  if (value !== value.trim() || value.includes('\\') || value.includes('\0')) return null;
  if (value.startsWith('/') || DRIVE_PATTERN.test(value)) return null;
  const segments = value.split('/');
  if (!segments.every((segment) => segment && segment !== '.' && segment !== '..')) return null;
  return value;
}

/** 长 base64/dataURL 正文一律不落盘：长度异常且字符集像 blob 的值直接判空。 */
function looksLikeBlob(value) {
  return typeof value === 'string' && value.length > 400 && /^[A-Za-z0-9+/=\s]+$/.test(value);
}

function candidateText(value, maxLength) {
  if (typeof value !== 'string' || looksLikeBlob(value)) return '';
  return value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function candidateDigest(value) {
  return typeof value === 'string' && SHA256_PATTERN.test(value) ? value : null;
}

function candidateAttempt(value) {
  return Number.isInteger(value) && value >= 1 && value <= 9999 ? value : null;
}

function candidateRunId(value) {
  const text = candidateText(value, 80);
  return /^frun-[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/.test(text) ? text : null;
}

function pickFrontendCandidatePlan(raw) {
  const plan = isPlainObject(raw) ? raw : {};
  const pack = isPlainObject(plan.frontendPack) ? plan.frontendPack : {};
  const base = isPlainObject(plan.baseTemplate) ? plan.baseTemplate : {};
  return {
    planId: candidateText(plan.planId, 60) || null,
    planVersion: candidateText(plan.planVersion, 24) || null,
    frontendPack: {
      id: candidateText(pack.id, FRONTEND_CANDIDATE_LIMITS.maxId) || null,
      version: candidateText(pack.version, FRONTEND_CANDIDATE_LIMITS.maxVersion) || null,
    },
    baseTemplate: {
      id: candidateText(base.id, 40) || 'ordering-base',
      version: candidateText(base.version, FRONTEND_CANDIDATE_LIMITS.maxVersion) || null,
    },
  };
}

function pickFrontendCandidateVerification(raw) {
  const source = isPlainObject(raw) ? raw : {};
  return {
    static: source.static === 'pass' ? 'pass' : (source.static === 'fail' ? 'fail' : 'unknown'),
    runtime: FRONTEND_RUNTIME_STATUSES.includes(source.runtime) ? source.runtime : 'NOT_RUN',
    repairs: Number.isInteger(source.repairs) && source.repairs >= 0 && source.repairs <= 2 ? source.repairs : 0,
    screenshots: Number.isInteger(source.screenshots) && source.screenshots >= 0
      ? Math.min(source.screenshots, FRONTEND_CANDIDATE_LIMITS.maxScreenshots)
      : 0,
    checkedAt: candidateText(source.checkedAt, 40) || null,
  };
}

function pickFrontendCandidateEvidence(raw) {
  const source = isPlainObject(raw) ? raw : {};
  return {
    dryRunRelative: canonicalRelativePath(source.dryRunRelative),
    runtimeRelative: canonicalRelativePath(source.runtimeRelative),
  };
}

function pickFrontendCandidateIssue(raw) {
  if (!isPlainObject(raw)) return null;
  const code = candidateText(raw.code, 60);
  const message = candidateText(raw.message, FRONTEND_CANDIDATE_LIMITS.maxIssueChars);
  if (!code && !message) return null;
  return {
    code: code || 'FRONTEND_CANDIDATE_INVALID',
    message: message || '已采用的候选前端当前不可用，已回退到 Base 页面。',
  };
}

export function createEmptyFrontendCandidateState() {
  return {
    schemaVersion: FRONTEND_CANDIDATE_SCHEMA_VERSION,
    status: 'none',
    candidateId: null,
    candidateVersion: null,
    integrity: null,
    runId: null,
    projectId: null,
    attempt: null,
    overlayRelative: null,
    attemptRelative: null,
    registryDigest: null,
    plan: pickFrontendCandidatePlan(null),
    verification: pickFrontendCandidateVerification(null),
    evidence: pickFrontendCandidateEvidence(null),
    adoptedAt: null,
    previous: null,
    issue: null,
    // verified 只存在于内存：重开项目后由桌面层校验 overlay 摘要再置 true。
    verified: false,
  };
}

function unavailableCandidate(code, message, extra) {
  const empty = createEmptyFrontendCandidateState();
  return {
    ...empty,
    ...(isPlainObject(extra) ? extra : {}),
    status: 'unavailable',
    issue: { code, message },
  };
}

/**
 * 已采用候选 → project.json 白名单字段。
 *
 * 只保留 id/version/摘要/相对引用/Plan 引用/验证状态；base64、绝对路径、
 * 原始 trace、大错误文本与未知字段一律丢弃。缺 overlay 引用或摘要时失败关闭
 * （status=unavailable），避免「看起来已采用、实际没有 overlay」的假状态。
 */
export function pickFrontendCandidate(raw, options = {}) {
  const empty = createEmptyFrontendCandidateState();
  if (!isPlainObject(raw)) return empty;
  const depth = Number.isInteger(options.depth) && options.depth >= 0 ? options.depth : 0;
  const declared = FRONTEND_CANDIDATE_STATUSES.includes(raw.status) ? raw.status : 'none';
  if (declared === 'none') return empty;

  const candidateId = candidateText(raw.candidateId, FRONTEND_CANDIDATE_LIMITS.maxId);
  const candidateVersion = candidateText(raw.candidateVersion, FRONTEND_CANDIDATE_LIMITS.maxVersion);
  const integrity = candidateDigest(raw.integrity);
  const overlayRelative = canonicalRelativePath(raw.overlayRelative);
  const attemptRelative = canonicalRelativePath(raw.attemptRelative);
  const registryDigest = candidateDigest(raw.registryDigest);
  const plan = pickFrontendCandidatePlan(raw.plan);
  const verification = pickFrontendCandidateVerification(raw.verification);
  const evidence = pickFrontendCandidateEvidence(raw.evidence);
  const adoptedAt = candidateText(raw.adoptedAt, 40) || null;
  const identity = {
    candidateId: candidateId || null,
    candidateVersion: candidateVersion || null,
    integrity,
    runId: candidateRunId(raw.runId),
    projectId: candidateText(raw.projectId, FRONTEND_CANDIDATE_LIMITS.maxId) || null,
    attempt: candidateAttempt(raw.attempt),
    plan,
    verification,
    evidence,
    adoptedAt,
  };

  if (!candidateId || !candidateVersion) {
    return unavailableCandidate('FRONTEND_CANDIDATE_INVALID', '候选记录缺少 id/version，已回退到 Base 页面。', identity);
  }
  if (declared === 'adopted') {
    if (!overlayRelative) {
      return unavailableCandidate('FRONTEND_OVERLAY_MISSING', '候选 overlay 引用缺失，已回退到 Base 页面。', { ...identity, integrity, registryDigest });
    }
    if (!integrity) {
      return unavailableCandidate('FRONTEND_DIGEST_MISSING', '候选摘要缺失，已回退到 Base 页面。', { ...identity, overlayRelative, attemptRelative, registryDigest });
    }
  }

  return {
    schemaVersion: FRONTEND_CANDIDATE_SCHEMA_VERSION,
    status: declared,
    ...identity,
    overlayRelative,
    attemptRelative,
    registryDigest,
    // 只保留一层「上一版本」，撤销恢复上一个采用记录；不递归保存历史。
    previous: depth < FRONTEND_CANDIDATE_LIMITS.maxPreviousDepth && isPlainObject(raw.previous)
      ? pickFrontendCandidate(raw.previous, { depth: depth + 1 })
      : null,
    issue: declared === 'unavailable'
      ? (pickFrontendCandidateIssue(raw.issue) || { code: 'FRONTEND_CANDIDATE_UNAVAILABLE', message: '已采用的候选前端当前不可用，已回退到 Base 页面。' })
      : null,
    verified: false,
  };
}

/**
 * project.json → 内存切片。
 *
 * `check` 是重开项目时桌面层对私有 overlay 的校验结论：
 * - `{ok:true, verification?}`：确认摘要一致，允许导出；
 * - `{ok:false, code, message}`：缺失/漂移 → 安全回退到 Base 并给出提示；
 * - 未提供：保留 adopted 但标 verified=false（导出前必须再校验，不允许静默回退）。
 */
export function restoreFrontendCandidate(saved, check) {
  const base = pickFrontendCandidate(saved);
  if (base.status === 'none') return base;
  if (!isPlainObject(check)) {
    if (base.status === 'unavailable') return base;
    return {
      ...base,
      status: 'adopted',
      verified: false,
      issue: {
        code: 'FRONTEND_CANDIDATE_UNVERIFIED',
        message: '重开项目后还没有校验候选完整性；导出前会再次校验，不会静默回退 Base。',
      },
    };
  }
  if (check.ok === true) {
    return {
      ...base,
      status: 'adopted',
      verified: true,
      issue: null,
      verification: isPlainObject(check.verification)
        ? pickFrontendCandidateVerification({ ...base.verification, ...check.verification })
        : base.verification,
    };
  }
  return {
    ...base,
    status: 'unavailable',
    verified: false,
    issue: {
      code: candidateText(check.code, 60) || 'FRONTEND_CANDIDATE_INVALID',
      message: candidateText(check.message, FRONTEND_CANDIDATE_LIMITS.maxIssueChars)
        || '候选完整性校验未通过，已回退到 Base 页面。',
    },
  };
}

/**
 * 构造「已采用候选」快照记录（采用动作由上层调用；本函数只负责形状与白名单）。
 * `previous` 传采用前的记录，用于撤销与重开后恢复上一版本。
 */
export function buildFrontendAdoption(input = {}) {
  const source = isPlainObject(input) ? input : {};
  const candidate = isPlainObject(source.candidate) ? source.candidate : {};
  return pickFrontendCandidate({
    schemaVersion: FRONTEND_CANDIDATE_SCHEMA_VERSION,
    status: 'adopted',
    candidateId: candidate.candidateId,
    candidateVersion: candidate.candidateVersion,
    integrity: candidate.integrity,
    runId: candidate.runId,
    projectId: candidate.projectId ?? source.projectId,
    attempt: candidate.attempt,
    overlayRelative: candidate.overlayRelative,
    attemptRelative: candidate.attemptRelative,
    registryDigest: candidate.registryDigest ?? (isPlainObject(source.plan) ? source.plan.registryDigest : null),
    plan: source.plan,
    verification: source.verification,
    evidence: source.evidence ?? candidate.evidence,
    adoptedAt: source.adoptedAt,
    previous: source.previous ?? null,
  });
}

/**
 * 撤销：返回上一版本记录（没有则为 none）与被撤销的记录。
 * 完整 Plan 与展示补丁由会话状态/快照的 `presentation` 承担，这里只恢复候选引用。
 */
export function undoFrontendAdoption(current) {
  const record = pickFrontendCandidate(current);
  if (record.status === 'none') {
    return { restored: false, reason: 'no-candidate', adoption: record, undone: null };
  }
  const previous = isPlainObject(record.previous) ? pickFrontendCandidate({ ...record.previous, previous: null }) : null;
  return {
    restored: true,
    adoption: previous || createEmptyFrontendCandidateState(),
    undone: record,
  };
}

/** 面板/执行层可用的只读摘要（不含路径）。 */
export function describeFrontendCandidate(record) {
  const source = pickFrontendCandidate(record);
  if (source.status === 'none') {
    return { status: 'none', label: '', planRef: null, runtimeStatus: 'NOT_RUN', repairs: 0, notice: null, verified: false };
  }
  return {
    status: source.status,
    label: source.candidateId ? `${source.candidateId}@${source.candidateVersion}` : '',
    planRef: {
      planId: source.plan.planId,
      planVersion: source.plan.planVersion,
      frontendPack: source.plan.frontendPack,
    },
    runtimeStatus: source.verification.runtime,
    repairs: source.verification.repairs,
    notice: source.issue ? source.issue.message : null,
    verified: source.verified === true,
  };
}

/**
 * 内存 state → project.json 文档。
 * meta: { projectId, createdAt, updatedAt, appid }
 */
export function toDocument(state, meta) {  const input = isPlainObject(state) ? state : {};
  const project = isPlainObject(input.project) ? input.project : {};
  const deploy = isPlainObject(input.deploy) ? input.deploy : {};
  const options = isPlainObject(meta) ? meta : {};
  const projectId = options.projectId || project.activeId;
  const agent = isPlainObject(input.agent) ? input.agent : {};
  const store = pickStore(input.store);
  const agentDraft = pickAgentDraft(input.agentDraft);
  const build = pickBuild(input.build);
  const visual = pickVisual(input.visual);
  const presentation = pickPresentation(input.presentation, build.selectedId, agentDraft.dishes);
  const sessions = pickSessions(input.sessions);
  const activeSessionId = sessions.some((session) => session.id === input.activeSessionId)
    ? input.activeSessionId
    : (sessions.find((session) => session.kind === 'main')?.id ?? sessions[0]?.id ?? 'session-main');
  const doc = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    projectId,
    createdAt: text(options.createdAt || project.createdAt || '', 40),
    updatedAt: text(options.updatedAt || '', 40),
    name: (store.name || agentDraft.storeName || '待命名项目').slice(0, 60),
    phase: PHASE_VALUES.has(input.phase) ? input.phase : PHASES.ONBOARDING,
    activeSessionId,
    store,
    features: pickFeatures(input.features),
    build,
    visual,
    presentation,
    agentDraft,
    screenRef: pickScreenRef(input.screenRef),
    frontendCandidate: pickFrontendCandidate(input.frontendCandidate),
    agentConfirmedSeq: agent.status === 'confirmed' ? integerOrNull(agent.confirmedAtSeq) : null,
    assets: { images: pickImages(input.assets?.images ?? input.assetImages) },
    sessions: sessions.length > 0
      ? sessions
      : [{ id: 'session-main', title: docTitle(store, agentDraft), kind: 'main', status: 'active', messages: [], handoff: null }],
    seq: Number.isInteger(input.seq) && input.seq >= 0 ? input.seq : 0,
    deploy: pickDeploy(deploy),
    appid: typeof options.appid === 'string' ? options.appid : text(project.appid, 20),
    lastExportParent: text(deploy.directory, 1200),
  };
  if (isPlainObject(input.unmappedFields) && Object.keys(input.unmappedFields).length > 0) {
    doc.unmappedFields = input.unmappedFields;
  }
  return doc;
}

function docTitle(store, agentDraft) {
  return store.name || agentDraft.storeName || '待命名项目';
}

export function estimateBytes(doc) {
  try {
    return Buffer.byteLength(`${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  } catch (error) {
    return Number.MAX_SAFE_INTEGER;
  }
}

/** 收集文档中所有未知的顶层键。 */
export function collectUnknown(doc) {
  const source = isPlainObject(doc) ? doc : {};
  const unknown = {};
  for (const key of Object.keys(source)) {
    if (key === 'unmappedFields') continue;
    if (!KNOWN_TOP_KEYS.includes(key)) unknown[key] = source[key];
  }
  if (isPlainObject(source.unmappedFields)) Object.assign(unknown, source.unmappedFields);
  return unknown;
}

function resolvePhase(phase, candidates, visual) {
  if (!PHASE_VALUES.has(phase)) return PHASES.ONBOARDING;
  if (phase === PHASES.BUILDING) return PHASES.FEATURES;
  if (phase === PHASES.TEMPLATE_PICK && candidates.length === 0) return PHASES.FEATURES;
  if (phase === PHASES.PROMPT_STUDIO && !visual.prompt) return PHASES.STORE_INFO;
  // UX0b：海报素材是可选项，"跳过海报"的项目也必须能恢复到 IMAGE_REVIEW；
  // 因此这里只要求提示词存在，不再要求 imageAssetId。
  if (phase === PHASES.IMAGE_REVIEW && !visual.prompt) return PHASES.STORE_INFO;
  return phase;
}

function resolveSessions(sessions, activeSessionId) {
  if (sessions.length === 0) {
    return [{
      id: 'session-main',
      title: '待命名项目',
      kind: 'main',
      status: 'active',
      messages: [],
      handoff: null,
      revealFlush: 0,
      revealAll: true,
    }];
  }
  return sessions.map((session) => ({
    ...session,
    revealFlush: 0,
    // 打开项目时这些消息都是历史：进入任意会话都直接整段显示，不重播交接对白。
    revealAll: true,
    messages: session.messages.map((message) => ({
      ...message,
      staged: false,
      delay: 0,
      instant: true,
    })),
  }));
}

/**
 * project.json 文档 → 可 dispatch 的 hydration 切片。
 * 返回 { phase, activeSessionId, sessions, seq, store, features, build, visual,
 *        agentDraft, agent, deploy, project }。
 *
 * options.candidateCheck（可选）是桌面层在加载后对私有 overlay 的校验结论；
 * 缺失/漂移时 `frontendCandidate` 回退为 unavailable 并通过
 * `frontendCandidateNotice` 提示，绝不静默把 Base 页面当成候选。
 */
export function fromDocument(doc, options = {}) {
  const source = isPlainObject(doc) ? doc : {};
  const draft = normalizeAgentDraft(source.agentDraft);
  const validation = validateAgentDraft(draft);
  const confirmedSeq = integerOrNull(source.agentConfirmedSeq);
  const confirmed = confirmedSeq !== null && validation.readyForReview;

  const store = pickStore(source.store);
  const features = pickFeatures(source.features);
  const buildSource = pickBuild(source.build);
  const visual = pickVisual(source.visual);
  const phase = resolvePhase(source.phase, buildSource.candidates, visual);
  const restoredPresentation = restorePresentationSlice(source.presentation, buildSource.selectedId, draft.dishes);

  const sessions = pickSessions(source.sessions);
  const activeSessionId = sessions.some((session) => session.id === source.activeSessionId)
    ? source.activeSessionId
    : (sessions.find((session) => session.kind === 'main')?.id ?? sessions[0]?.id ?? 'session-main');

  const agent = {
    ...createEmptyAgentState(),
    status: confirmed ? 'confirmed' : (validation.readyForReview ? 'reviewing' : 'collecting'),
    confirmedAtSeq: confirmed ? confirmedSeq : null,
    missingFields: validation.missingFields,
    errors: validation.errors,
    nextQuestion: buildNextQuestion(validation),
  };

  const deploySource = pickDeploy(source.deploy);
  const deploy = {
    ...createEmptyDeployState(),
    directory: deploySource.directory,
    projectName: deploySource.projectName,
    resultDigest: deploySource.resultDigest,
    handoff: deploySource.handoff,
  };

  const frontendCandidate = restoreFrontendCandidate(
    source.frontendCandidate,
    isPlainObject(options.candidateCheck) ? options.candidateCheck : null,
  );
  const frontendCandidateNotice = frontendCandidate.status === 'unavailable'
    ? (frontendCandidate.issue?.message || '候选前端当前不可用，已回退到 Base 页面。')
    : (frontendCandidate.status === 'adopted' && frontendCandidate.verified !== true
      ? (frontendCandidate.issue?.message || '重开项目后还没有校验候选完整性；导出前会再次校验。')
      : null);

  return {
    phase,
    activeSessionId,
    sessions: resolveSessions(sessions, activeSessionId),
    seq: Number.isInteger(source.seq) && source.seq >= 0 ? source.seq : 0,
    store,
    features,
    build: { ...buildSource, status: buildSource.candidates.length > 0 ? 'ready' : 'idle' },
    visual: { ...visual, image: null },
    presentation: restoredPresentation.presentation,
    // 恢复期的异常原因（模板错配 / 补丁被丢弃），交给 UI 提示；不进 project.json。
    presentationRestore: restoredPresentation.notice,
    agentDraft: draft,
    agent,
    screenRef: restoreScreenRef(source.screenRef),
    frontendCandidate,
    frontendCandidateNotice,
    deploy,
    assets: { images: pickImages(source.assets?.images) },
    project: {
      activeId: typeof source.projectId === 'string' ? source.projectId : null,
      createdAt: typeof source.createdAt === 'string' ? source.createdAt : null,
      appid: typeof source.appid === 'string' ? source.appid : '',
      lastExportParent: typeof source.lastExportParent === 'string' ? source.lastExportParent : '',
    },
    unmappedFields: collectUnknown(source),
    futureVersion: Number(source.schemaVersion) > SNAPSHOT_SCHEMA_VERSION,
  };
}