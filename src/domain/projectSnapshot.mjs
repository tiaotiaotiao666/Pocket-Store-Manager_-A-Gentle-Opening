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
  'agentDraft',
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
    dishes: normalized.dishes.slice(0, 5).map((dish) => ({
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
 * 内存 state → project.json 文档。
 * meta: { projectId, createdAt, updatedAt, appid }
 */
export function toDocument(state, meta) {
  const input = isPlainObject(state) ? state : {};
  const project = isPlainObject(input.project) ? input.project : {};
  const deploy = isPlainObject(input.deploy) ? input.deploy : {};
  const options = isPlainObject(meta) ? meta : {};
  const projectId = options.projectId || project.activeId;
  const agent = isPlainObject(input.agent) ? input.agent : {};
  const store = pickStore(input.store);
  const agentDraft = pickAgentDraft(input.agentDraft);
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
    build: pickBuild(input.build),
    visual: pickVisual(input.visual),
    agentDraft,
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
  if (phase === PHASES.IMAGE_REVIEW && (!visual.prompt || !visual.imageAssetId)) return PHASES.STORE_INFO;
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
    }];
  }
  return sessions.map((session) => ({
    ...session,
    revealFlush: 0,
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
 */
export function fromDocument(doc) {
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

  return {
    phase,
    activeSessionId,
    sessions: resolveSessions(sessions, activeSessionId),
    seq: Number.isInteger(source.seq) && source.seq >= 0 ? source.seq : 0,
    store,
    features,
    build: { ...buildSource, status: buildSource.candidates.length > 0 ? 'ready' : 'idle' },
    visual: { ...visual, image: null },
    agentDraft: draft,
    agent,
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