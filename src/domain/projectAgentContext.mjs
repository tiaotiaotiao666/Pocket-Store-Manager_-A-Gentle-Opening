import { validateAgentDraft, buildNextQuestion, toContractDraft } from './agentDraft.mjs';
import { APP_CAPABILITIES_VERSION } from './appCapabilities.mjs';

/**
 * 安全项目上下文（供统一会话 Agent 与 contentRevision 使用）。
 *
 * 硬边界（与 `docs/app-assistant-contract.md` 一致）：
 * - 不输出 settings、API Key、绝对路径、base64、完整会话、模型原始响应、完整 prompt；
 * - `deploy.directory` 永不出现在上下文里；
 * - `phase` 只用于理解，不参与「能不能写」的判断。
 *
 * `buildProjectAgentContext` 给模型看；`buildProjectContextSnapshot` 只用于比较
 * 「项目业务内容有没有变化」，两者都不读 DOM。
 */

export const PROJECT_CONTEXT_VERSION = 'project-agent-context.v1';
export const PROJECT_CONTEXT_MAX_BYTES = 65536;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value, maxChars) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  return maxChars && Array.from(trimmed).length > maxChars
    ? Array.from(trimmed).slice(0, maxChars).join('')
    : trimmed;
}

function stringList(value, limit = 12) {
  if (!Array.isArray(value)) return [];
  const result = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item) continue;
    result.push(item);
    if (result.length >= limit) break;
  }
  return result;
}

function pickStore(store) {
  const source = isPlainObject(store) ? store : {};
  return {
    name: text(source.name, 48),
    type: text(source.type, 32),
    // 兼容旧项目只写 intro 的读取；新写入一律用 notes。
    notes: text(source.notes ?? source.intro, 200),
    address: text(source.address, 120),
    phone: text(source.phone, 32),
    imageAssetIds: stringList(source.imageAssetIds, 6),
    hasLogo: typeof source.logoAssetId === 'string' && Boolean(source.logoAssetId),
  };
}

function pickAssets(assets) {
  const images = Array.isArray(assets?.images) ? assets.images : [];
  return images
    .filter((item) => isPlainObject(item) && typeof item.assetId === 'string')
    .slice(-12)
    .map((item) => ({
      assetId: text(item.assetId, 80),
      fileName: text(item.fileName, 40),
      mime: ['image/png', 'image/jpeg', 'image/webp'].includes(item.mime) ? item.mime : 'image/png',
      width: Number.isFinite(item.width) ? item.width : undefined,
      height: Number.isFinite(item.height) ? item.height : undefined,
      source: item.source === 'ai-generated' ? 'ai-generated' : 'user-upload',
    }));
}

function pickCandidates(build) {
  const candidates = Array.isArray(build?.candidates) ? build.candidates : [];
  return candidates
    .filter((item) => isPlainObject(item) && typeof item.id === 'string')
    .slice(0, 5)
    .map((item) => ({
      id: text(item.id, 40),
      name: text(item.name, 40),
      layout: text(item.layout, 24),
      score: Number.isFinite(item.score) ? Math.round(item.score) : 0,
    }));
}

/**
 * 构造模型可见的安全项目上下文。
 *
 * @param {object} state 桌面 reducer 状态
 * @returns {object} 有界 JSON（可直接放进请求）
 */
export function buildProjectAgentContext(state) {
  const input = isPlainObject(state) ? state : {};
  const project = isPlainObject(input.project) ? input.project : {};
  const draft = input.agentDraft;
  const contractDraft = toContractDraft(draft);
  const validation = validateAgentDraft(draft);
  const visual = isPlainObject(input.visual) ? input.visual : {};
  const build = isPlainObject(input.build) ? input.build : {};
  const features = isPlainObject(input.features) ? input.features : {};
  const screenRef = isPlainObject(input.screenRef) ? input.screenRef : {};
  const frontendCandidate = isPlainObject(input.frontendCandidate) ? input.frontendCandidate : {};
  const deploy = isPlainObject(input.deploy) ? input.deploy : {};

  return {
    contextVersion: PROJECT_CONTEXT_VERSION,
    capabilitiesVersion: APP_CAPABILITIES_VERSION,
    projectId: text(project.activeId, 120) || null,
    contentRevision: Number.isInteger(project.contentRevision) ? project.contentRevision : 0,
    // 仅供理解；不参与写入权限判断。
    phase: text(input.phase, 40) || null,
    fields: {
      'store.name': contractDraft.storeName,
      'store.category': contractDraft.category,
      'store.businessHours': contractDraft.businessHours,
      'store.fulfillment': { ...contractDraft.fulfillment },
      'store.dishes': contractDraft.dishes.map((dish) => ({
        id: dish.id,
        name: dish.name,
        priceCents: dish.priceCents,
        description: dish.description,
      })),
      'store.address': pickStore(input.store).address,
      'store.phone': pickStore(input.store).phone,
      'store.notes': pickStore(input.store).notes,
      'store.imageAssetIds': pickStore(input.store).imageAssetIds,
      'visual.styleId': text(visual.styleId, 24),
      'visual.prompt': text(visual.prompt, 2000),
      'visual.imageAssetId': text(visual.imageAssetId, 80) || null,
      'features.selected': stringList(features.selected, 24),
      'features.custom': text(features.custom, 500),
      'project.appid': text(project.appid, 20),
    },
    validation: {
      missingFields: validation.missingFields.map((item) => ({ field: item.field, label: item.label })),
      errors: validation.errors.map((item) => ({ field: item.field, code: item.code, message: item.message })),
      readyForReview: validation.readyForReview,
      nextQuestion: buildNextQuestion(validation),
    },
    build: {
      candidates: pickCandidates(build),
      selectedId: text(build.selectedId, 40) || null,
    },
    assets: { images: pickAssets(input.assets) },
    screenRef: {
      status: text(screenRef.status, 24) || 'idle',
      hasImage: Boolean(screenRef.image),
      adopted: screenRef.adopted === true,
    },
    frontendCandidate: {
      status: text(frontendCandidate.status, 24) || 'none',
      adopted: frontendCandidate.adopted === true,
      templateId: text(frontendCandidate.selectedTemplateId, 40) || null,
    },
    deploy: {
      status: text(deploy.status, 24) || 'idle',
      appidFilled: Boolean(text(project.appid, 20)),
      preflightReady: deploy.preflight?.status === 'ok',
    },
  };
}

/**
 * 业务上下文快照：只用于判断「项目业务内容是否变化」。
 *
 * 包含：门店/草稿/功能/模板选择/视觉/素材引用/展示补丁/AppID/参考图与候选摘要。
 * 排除：phase、view、会话与输入草稿、请求态、设置、绝对路径、base64。
 *
 * @param {object} state
 * @returns {string} 稳定 JSON 字符串
 */
export function buildProjectContextSnapshot(state) {
  const input = isPlainObject(state) ? state : {};
  const project = isPlainObject(input.project) ? input.project : {};
  const visual = isPlainObject(input.visual) ? input.visual : {};
  const build = isPlainObject(input.build) ? input.build : {};
  const features = isPlainObject(input.features) ? input.features : {};
  const presentation = isPlainObject(input.presentation) ? input.presentation : {};
  const screenRef = isPlainObject(input.screenRef) ? input.screenRef : {};
  const frontendCandidate = isPlainObject(input.frontendCandidate) ? input.frontendCandidate : {};
  const assets = Array.isArray(input.assets?.images) ? input.assets.images : [];

  return JSON.stringify({
    store: pickStore(input.store),
    agentDraft: toContractDraft(input.agentDraft),
    features: { selected: stringList(features.selected, 24), custom: text(features.custom, 500) },
    build: {
      selectedId: text(build.selectedId, 40) || null,
      candidateIds: pickCandidates(build).map((item) => item.id),
    },
    visual: {
      styleId: text(visual.styleId, 24),
      prompt: text(visual.prompt, 2000),
      imageAssetId: text(visual.imageAssetId, 80) || null,
    },
    presentation: {
      templateId: text(presentation.templateId, 40) || null,
      patch: isPlainObject(presentation.patch) ? presentation.patch : null,
    },
    assets: assets
      .filter((item) => isPlainObject(item) && typeof item.assetId === 'string')
      .map((item) => item.assetId),
    screenRef: {
      status: text(screenRef.status, 24) || 'idle',
      imageAssetId: text(screenRef.image?.assetId, 80) || null,
      adopted: screenRef.adopted === true,
    },
    frontendCandidate: {
      status: text(frontendCandidate.status, 24) || 'none',
      adopted: frontendCandidate.adopted === true,
      templateId: text(frontendCandidate.selectedTemplateId, 40) || null,
    },
    appid: text(project.appid, 20),
  });
}

/** 序列化后的上下文字节数（用于 fail closed 的大小限制）。 */
export function measureProjectContextBytes(context) {
  try {
    return Buffer.byteLength(JSON.stringify(context), 'utf8');
  } catch (error) {
    return Number.MAX_SAFE_INTEGER;
  }
}