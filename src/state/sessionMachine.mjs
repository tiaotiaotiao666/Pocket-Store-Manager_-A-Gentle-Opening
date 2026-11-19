import {
  PHASES,
  PHASE_META,
  ROLES,
  SESSION_KIND,
  NEW_PROJECT_LABEL,
  AGENT_STATUS,
  AGENT_STORE_INFO_HINT,
  COMPOSER_PLACEHOLDER,
  COMPOSER_SUBMIT_LABEL,
  DEPLOY_STATUS,
} from './constants.mjs';
import { features as catalogFeatures } from '../domain/catalog.mjs';
import {
  applyDraftPatch,
  buildNextQuestion,
  createDishId,
  createEmptyAgentDraft,
  normalizeAgentDraft,
  toContractDraft,
  validateAgentDraft,
} from '../domain/agentDraft.mjs';
import {
  PROCESS_HISTORY_LIMIT,
  buildProcessView,
  compactProcessRound,
} from '../domain/agentRunProcess.mjs';
import {
  INTRO_SCRIPT,
  FEATURE_INTRO,
  BUILDING_INTRO,
  TEMPLATE_INTRO,
  TEMPLATE_REFINE,
  STORE_INTRO,
  PROMPT_INTRO,
  REVIEW_INTRO,
  DEPLOY_INTRO,
  NAMING_GUIDANCE,
} from '../domain/onboardingScript.mjs';
import { buildHandoff } from '../domain/handoff.mjs';
import { STORE_TYPES, STYLE_PRESETS } from '../domain/storeBrief.mjs';
import {
  diffPresentationPatch,
  validatePresentationPatch,
} from '../domain/presentationPatch.mjs';
import { resolveRecipe } from '../domain/recipeCatalog.mjs';
import {
  SCREEN_REF_STATUS,
  buildCandidateRecipe,
  buildScreenRefView,
  candidateToSessionPatch,
  recognitionUsable,
} from '../domain/screenReference.mjs';
import {
  createEmptyDeployState,
  createEmptyPreflight,
  createEmptyScreenRefState,
  fromDocument,
} from '../domain/projectSnapshot.mjs';
import { MAX_DISHES } from '../domain/storeLimits.mjs';
import {
  CHAT_ACTION_KINDS,
  CHAT_MESSAGE_MAX_CHARS,
  CHAT_STATUS,
  appendChatMessage,
  buildAgentChatSubmitPlan,
  chatAssistantMessageId,
  chatUserMessageId,
  createChatMessage,
  createEmptyAgentChat,
  isChatResponseAcceptable,
  isValidChatDraft,
  normalizeChatError,
  normalizeChatMessages,
  normalizeChatRun,
} from '../domain/agentSidebar.mjs';

const REQUIRED_FEATURE_IDS = catalogFeatures.filter((feature) => feature.required).map((feature) => feature.id);

/** 展示修改清单最多保留的条数（plan.md 2.2.3「changes 截断 20」）。 */
const MAX_PRESENTATION_CHANGES = 20;

/**
 * 可移动区块的类型。
 *
 * 与 `templates/registry/registry.v1.json` 的 `kind` 声明保持一致；
 * 状态机同构运行在浏览器与 Node，不读模板文件，因此在此保留最小映射。
 * 未列出的区块按 `feature-pack` 处理（当前唯一的可移动区块是 poster-carousel）。
 */
const FEATURE_KIND_BY_ID = Object.freeze({
  'poster-carousel': 'feature-pack',
});

/**
 * `C-SESSION-PRESENTATION@1` 的初始切片（plan.md 2.2.3）。
 *
 * @returns {{templateId: string|null, patch: object, changes: Array, status: 'idle',
 *   requestId: null, lastUtterance: string, error: null}}
 */
function createInitialPresentationSlice() {
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

/**
 * 构造补丁校验上下文（plan.md 2.2.4）。
 *
 * 已占用 feature 来自当前模板的 Recipe 投影，保证与 Plan 的 `features[]` 口径一致；
 * `hasCarousel` 决定 `sizes.carousel` 是否允许；`baseDraft` 决定菜品文案能否按 id 落位。
 *
 * @param {object} state 会话状态
 * @param {string|null|undefined} templateId 补丁所属模板（缺省回落当前选中模板）
 */
function presentationContext(state, templateId) {
  const selectedId = templateId ?? state.build?.selectedId ?? null;
  const { recipe } = resolveRecipe(selectedId);
  const features = Array.isArray(recipe?.features) ? recipe.features : [];
  const occupiedFeatures = features.map((feature) => ({
    id: feature.id,
    kind: FEATURE_KIND_BY_ID[feature.id] ?? 'feature-pack',
  }));
  return {
    occupiedFeatures,
    hasCarousel: occupiedFeatures.some((feature) => feature.id === 'poster-carousel'),
    baseDraft: {
      dishes: Array.isArray(state.agentDraft?.dishes) ? state.agentDraft.dishes : [],
    },
  };
}

/** 把任意来源的错误对象收敛成 `{ code, message }`。 */
function normalizePresentationError(error, fallbackCode, fallbackMessage) {
  const source = error && typeof error === 'object' ? error : {};
  const code = typeof source.code === 'string' && source.code ? source.code : fallbackCode;
  const message = typeof source.message === 'string' && source.message ? source.message : fallbackMessage;
  return { code, message };
}

/** 变更清单只保留 path/label/before/after，并截断到 20 条。 */
function normalizePresentationChanges(changes) {
  if (!Array.isArray(changes)) return null;
  return changes.slice(0, MAX_PRESENTATION_CHANGES).map((item) => {
    const source = item && typeof item === 'object' ? item : {};
    return {
      path: typeof source.path === 'string' ? source.path : '',
      label: typeof source.label === 'string' ? source.label : '',
      before: typeof source.before === 'string' ? source.before : null,
      after: typeof source.after === 'string' ? source.after : null,
    };
  });
}

/**
 * 把已接受的 `copy` 补丁映射到门店资料与 Agent 草稿（plan.md 2.2.3）。
 *
 * - `storeName` → `store.name` + `agentDraft.storeName`
 * - `category`  → `store.type` + `agentDraft.category`
 * - `tagline`   → `store.notes`（Plan 的 `storeProfile.notes`）
 * - `dishes[]`  → 按 id 更新 `agentDraft.dishes[]` 的 name/description，**价格保持不变**
 *
 * @returns {{store: object, draft: object}|null} 无 copy 时返回 null
 */
function applyPresentationCopy(state, copy) {
  if (!copy || typeof copy !== 'object') return null;
  const store = { ...(state.store || {}) };
  let storeTouched = false;
  const draft = { ...(state.agentDraft || {}) };
  let draftTouched = false;

  if (typeof copy.storeName === 'string') {
    store.name = copy.storeName;
    draft.storeName = copy.storeName;
    storeTouched = true;
    draftTouched = true;
  }
  if (typeof copy.category === 'string') {
    store.type = copy.category;
    draft.category = copy.category;
    storeTouched = true;
    draftTouched = true;
  }
  if (typeof copy.tagline === 'string') {
    store.notes = copy.tagline;
    storeTouched = true;
  }
  if (Array.isArray(copy.dishes) && copy.dishes.length > 0) {
    const patchesById = new Map();
    for (const dish of copy.dishes) {
      if (dish && typeof dish.id === 'string') patchesById.set(dish.id, dish);
    }
    const dishes = Array.isArray(draft.dishes) ? draft.dishes : [];
    draft.dishes = dishes.map((dish) => {
      const patch = dish && patchesById.get(dish.id);
      if (!patch) return dish;
      const next = { ...dish };
      if (typeof patch.name === 'string') next.name = patch.name;
      if (typeof patch.description === 'string') next.description = patch.description;
      // 价格不在补丁契约内（plan.md 2.2.4 第 8 条），这里刻意不复制 priceCents/priceText。
      draftTouched = true;
      return next;
    });
  }
  if (!storeTouched && !draftTouched) return null;
  return { store: storeTouched ? store : state.store, draft: draftTouched ? draft : state.agentDraft };
}

/** P3：参考截图 → 候选模板 的会话切片（空实现在 projectSnapshot，便于重开恢复）。 */
export function createInitialScreenRefSlice() {
  return createEmptyScreenRefState();
}

function withScreenRefView(slice) {
  return { ...slice, view: buildScreenRefView(slice) };
}

/** 采用候选时保存现场：放弃候选必须能回到原样。 */
function snapshotSelection(state) {
  return {
    selectedId: state.build?.selectedId ?? null,
    candidateIds: Array.isArray(state.build?.candidates)
      ? state.build.candidates.map((item) => item && item.id).filter(Boolean)
      : [],
    features: Array.isArray(state.features?.selected) ? [...state.features.selected] : [],
    presentation: {
      templateId: state.presentation?.templateId ?? null,
      patch: JSON.parse(JSON.stringify(state.presentation?.patch ?? {})),
    },
  };
}

function createInitialAgentSlice() {
  return {
    status: AGENT_STATUS.IDLE,
    lastUtterance: '',
    lastError: null,
    attempts: 0,
    activeRequestId: null,
    missingFields: [],
    errors: [],
    nextQuestion: null,
    reply: '',
    meta: null,
    simulateFailure: false,
    turnId: null,
    confirmedAtSeq: null,
    // W2：草稿版本号 + 冻结的请求基线，用于「只有 revision 未变才整份应用」。
    draftRevision: 0,
    requestDraftRevision: null,
    // W2：agent-run.v1 的运行可观测信息，留给后续过程面板展示。
    runId: null,
    trace: null,
    degraded: false,
    degradation: null,
    stopReason: null,
    // 手改草稿后收到的迟到回复：只提示，不改草稿。
    staleDraftNotice: null,
    // 请求期间新增图片等一次性提示。
    hint: null,
    // W3：本轮过程卡视图模型（唯一主卡）+ 历史轮次摘要（默认折叠）。
    process: null,
    processHistory: [],
  };
}

/** 把上一轮过程卡压成历史摘要，最多保留 PROCESS_HISTORY_LIMIT 条。 */
function archiveProcessHistory(agent) {
  const previous = compactProcessRound(agent?.process, new Date().toISOString());
  if (!previous) return Array.isArray(agent?.processHistory) ? agent.processHistory : [];
  const rest = Array.isArray(agent?.processHistory) ? agent.processHistory : [];
  return [previous, ...rest].slice(0, PROCESS_HISTORY_LIMIT);
}

function isCurrentAgentTurnCompletion(state, action) {
  return state.agent.status === AGENT_STATUS.REQUESTING
    && state.agent.activeRequestId === (action.requestId ?? null);
}

/**
 * 展示修改的结果是否属于当前挂起的请求（plan.md 2.2.3）。
 *
 * 条件：处于 `revising`、`requestId` 一致；若动作携带 `templateId`，还必须与补丁所属模板一致。
 * 任一不满足即「整包忽略」——连撤销元数据与 changes 都不能碰。
 */
function isCurrentPresentationCompletion(state, action) {
  const presentation = state.presentation;
  if (!presentation || presentation.status !== 'revising') return false;
  const requestId = typeof action.requestId === 'string' ? action.requestId.trim() : '';
  if (!requestId || requestId !== presentation.requestId) return false;
  const templateId = typeof action.templateId === 'string' ? action.templateId : '';
  if (templateId && presentation.templateId && templateId !== presentation.templateId) return false;
  return true;
}

/**
 * 项目级 Agent 会话切片的初始值。
 *
 * 口径唯一来自 `domain/agentSidebar.mjs`：状态层不复制消息结构与上限，
 * 这样快照持久化（T2）与状态层用的是同一份裁剪实现。
 */
export function createInitialAgentChatSlice() {
  return createEmptyAgentChat();
}

function chatRevision(chat) {
  return Number.isInteger(chat?.revision) && chat.revision >= 0 ? chat.revision : 0;
}

function nextChatRevision(chat) {
  return chatRevision(chat) + 1;
}

function chatIdText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function currentProjectId(state, explicit) {
  return chatIdText(explicit) || chatIdText(state?.project?.activeId);
}

/** 在途请求一律放弃：状态归 idle、清空 requestId，迟到响应随后会被四元组守卫拒收。 */
function abandonAgentChatRequest(chat) {
  const slice = chat ?? createEmptyAgentChat();
  if (slice.status !== CHAT_STATUS.REQUESTING && !slice.activeRequestId) return slice;
  return {
    ...slice,
    status: CHAT_STATUS.IDLE,
    activeRequestId: null,
    requestDraftRevision: null,
    requestPhase: null,
    revision: nextChatRevision(slice),
  };
}

/**
 * 把会话切到某个项目，并归一为「没有在途请求」的空闲态。
 *
 * 打开/新建/重置/删除项目都要经过这里：
 * - 遗留的 `status='requesting'` 与 `activeRequestId` 必须丢弃，否则重开项目会永久转圈；
 * - 消息只用调用方显式给的那份（打开项目时来自快照恢复），绝不把上一个项目的消息带过来；
 * - 其他项目的历史仍在各自的 project.json 里，这里不销毁任何持久化口径。
 */
function withAgentChatProject(state, projectId, messages) {
  const chat = state.agentChat ?? createEmptyAgentChat();
  const nextProjectId = chatIdText(projectId) || null;
  return {
    ...state,
    agentChat: {
      ...createEmptyAgentChat(),
      messages: normalizeChatMessages(Array.isArray(messages) ? messages : []),
      activeProjectId: nextProjectId,
      revision: nextChatRevision(chat),
    },
  };
}

/**
 * 迟到响应要校验的四元组：`projectId + requestId + draftRevision + phase`。
 *
 * 动作没带的可选位沿用切片里冻结的值（集成层不必重复传参），
 * 一旦显式携带就必须与冻结值一致——判断本身仍然只在 `isChatResponseAcceptable` 里。
 */
function resolveAgentChatIdentity(state, action) {
  const chat = state.agentChat ?? createEmptyAgentChat();
  return {
    chat,
    projectId: chatIdText(action?.projectId) || chat.activeProjectId,
    requestId: chatIdText(action?.requestId) || chat.activeRequestId,
    draftRevision: Number.isInteger(action?.draftRevision) ? action.draftRevision : chat.requestDraftRevision,
    phase: chatIdText(action?.phase) || chat.requestPhase,
  };
}

function isCurrentAgentChatCompletion(state, action) {
  return isChatResponseAcceptable(resolveAgentChatIdentity(state, action));
}

function validationStatus(status, validation) {
  if (status === AGENT_STATUS.REQUESTING) return AGENT_STATUS.REQUESTING;
  if (status === AGENT_STATUS.FAILED) return AGENT_STATUS.FAILED;
  return validation.readyForReview ? AGENT_STATUS.REVIEWING : AGENT_STATUS.COLLECTING;
}

function withValidatedDraft(state, draft) {
  const normalized = normalizeAgentDraft(draft);
  const validation = validateAgentDraft(normalized);
  return {
    ...state,
    agentDraft: normalized,
    agent: {
      ...state.agent,
      status: validationStatus(state.agent.status, validation),
      missingFields: validation.missingFields,
      errors: validation.errors,
      nextQuestion: buildNextQuestion(validation),
      // 任何手改/增删菜品都会推进版本号，让在途请求无法整份覆盖用户现稿。
      draftRevision: state.agent.draftRevision + 1,
      staleDraftNotice: null,
      hint: null,
    },
  };
}

function fulfillmentLabel(fulfillment) {
  if (fulfillment.dineIn && fulfillment.takeaway) return '堂食和自取';
  if (fulfillment.dineIn) return '仅堂食';
  if (fulfillment.takeaway) return '仅自取';
  return '取餐方式未定';
}

function withAgentStoreName(state, storeName) {
  const draft = normalizeAgentDraft({ ...state.agentDraft, storeName: storeName ?? '' });
  const validation = validateAgentDraft(draft);
  return {
    ...state,
    agentDraft: draft,
    agent: {
      ...state.agent,
      missingFields: validation.missingFields,
      errors: validation.errors,
      nextQuestion: buildNextQuestion(validation),
    },
  };
}

function createInitialDeploySlice() {
  return createEmptyDeployState();
}

function createInitialProjectSlice() {
  return {
    mode: 'desktop',
    status: 'idle',
    list: [],
    activeId: null,
    createdAt: null,
    appid: '',
    dirty: false,
    saving: false,
    lastSavedAt: null,
    lastSavedBytes: 0,
    saveError: null,
    openError: null,
    deleteTarget: null,
    search: '',
  };
}

function createInitialSettingsSlice() {
  return {
    status: 'idle',
    config: null,
    diagnostics: {
      status: 'idle',
      checkedAt: null,
      lines: [],
      error: null,
    },
  };
}

const VIEWS = Object.freeze(['workbench', 'flow', 'settings']);

export function createInitialState() {
  const mainSession = {
    id: 'session-main',
    title: NEW_PROJECT_LABEL,
    kind: SESSION_KIND.MAIN,
    status: 'active',
    messages: [],
    handoff: null,
    revealFlush: 0,
    revealAll: false,
  };
  return {
    view: 'workbench',
    seq: 0,
    phase: PHASES.HOME,
    phaseReturn: null,
    activeSessionId: mainSession.id,
    sessions: [mainSession],
    store: { name: '', type: STORE_TYPES[0], notes: '', address: '', phone: '', logoAssetId: null, imageAssetIds: [] },
    features: { selected: [...REQUIRED_FEATURE_IDS], custom: '' },
    build: { status: 'idle', candidates: [], selectedId: null, feedback: [], refineError: null },
    visual: { styleId: STYLE_PRESETS[0].id, promptRounds: [], imageRounds: [], image: null, prompt: '', imageAssetId: null, imageMeta: null },
    deploy: createInitialDeploySlice(),
    agentDraft: createEmptyAgentDraft(),
    agent: createInitialAgentSlice(),
    // 项目级 Agent 会话（右侧栏「Agent 对话」）：一个项目一个长会话，跟项目一起切换。
    agentChat: createInitialAgentChatSlice(),
    screenRef: createInitialScreenRefSlice(),
    presentation: createInitialPresentationSlice(),
    assets: { images: [] },
    unmappedFields: {},
    project: createInitialProjectSlice(),
    settings: createInitialSettingsSlice(),
    undo: { past: [], future: [], lastKey: null },
  };
}

function appendMessages(state, sessionId, drafts) {
  let seq = state.seq;
  const created = drafts.map((draft) => {
    seq += 1;
    const staged = Boolean(draft.staged);
    return {
      id: `m${seq}`,
      role: draft.role ?? ROLES.AGENT,
      text: draft.text,
      staged,
      delay: draft.delay ?? (staged ? 720 : 0),
      instant: Boolean(draft.instant),
      meta: draft.meta ?? null,
    };
  });
  return {
    ...state,
    seq,
    sessions: state.sessions.map((session) => (
      session.id === sessionId ? { ...session, messages: [...session.messages, ...created] } : session
    )),
  };
}

function appendMessagesWithSeq(state, sessionId, handoffText, drafts, handoffMeta = null) {
  const nextSeq = state.seq + 1;
  const session = state.sessions.find((item) => item.id === sessionId);
  if (!session) return state;
  const handoffMessage = {
    id: `m${nextSeq}`,
    role: ROLES.SYSTEM,
    text: handoffText,
    staged: false,
    delay: 0,
    instant: true,
    meta: { kind: 'handoff', ...(handoffMeta || {}) },
  };
  const withHandoff = {
    ...state,
    seq: nextSeq,
    sessions: state.sessions.map((item) => (item.id === sessionId ? { ...item, messages: [...item.messages, handoffMessage] } : item)),
  };
  return appendMessages(withHandoff, sessionId, drafts);
}

function markAllDone(sessions) {
  return sessions.map((session) => ({ ...session, status: 'done' }));
}

// 会话离开后标记为「已展示过」：再次进入时直接显示全部历史，不再逐条重播。
// 新建会话不带这个标记，因此交接后的开场白仍然有逐条展示的动画。
function markSessionSettled(sessions, sessionId) {
  return sessions.map((session) => (
    session.id === sessionId ? { ...session, revealAll: true } : session
  ));
}

function createStepSession(state, { id, title, summary, payload, phase, intro, followUp, fields = [] }) {
  const from = state.store.name || NEW_PROJECT_LABEL;
  const handoff = buildHandoff({ from, to: title, summary, payload });
  const session = {
    id,
    title,
    kind: SESSION_KIND.STEP,
    status: 'active',
    messages: [],
    handoff,
    revealFlush: 0,
    revealAll: false,
  };
  const opening = intro ?? (title === '店铺装修' ? STORE_INTRO : DEPLOY_INTRO);
  const after = followUp ?? (
    title === '店铺装修'
      ? '选好风格后，你写下想要的视觉偏好；这一步不生成图片。'
      : title === '部署小程序'
        ? '这是演示环境，不含真实发布。'
        : ''
  );
  const leaving = markSessionSettled(state.sessions.filter((item) => item.id !== id), state.activeSessionId);
  const base = { ...state, phase, sessions: [...markAllDone(leaving), session], activeSessionId: id };
  return appendMessagesWithSeq({ ...base, sessions: base.sessions.map((item) => item.id === id ? { ...item, messages: [] } : item) }, id, handoff, [
    { text: opening, staged: true },
    ...(after ? [{ text: after, staged: false, instant: true, meta: { kind: 'muted' } }] : []),
  ], { to: title, fields });
}

function enterFeatures(state) {
  const next = appendMessages(state, state.activeSessionId, [{ text: FEATURE_INTRO, staged: true, meta: { kind: 'feature-intro' } }]);
  return { ...next, phase: PHASES.FEATURES };
}

function baseReducer(state, action) {
  switch (action.type) {
    case 'VIEW_SET':
      return VIEWS.includes(action.view) ? { ...state, view: action.view } : state;

    case 'PHASE_GOTO': {
      if (!Object.values(PHASES).includes(action.phase)) return state;
      const sessionByPhase = {
        [PHASES.STORE_INFO]: 'session-store',
        [PHASES.PROMPT_STUDIO]: 'session-visual',
        [PHASES.IMAGE_REVIEW]: 'session-visual',
        [PHASES.DEPLOY]: 'session-deploy',
      };
      const targetSession = sessionByPhase[action.phase];
      const hasSession = state.sessions.some((session) => session.id === targetSession);
      const nextSessionId = hasSession ? targetSession : state.activeSessionId;
      const leavingDeploy = state.phase === PHASES.DEPLOY && action.phase !== PHASES.DEPLOY;
      return {
        ...state,
        view: 'flow',
        phase: action.phase,
        activeSessionId: nextSessionId,
        sessions: nextSessionId !== state.activeSessionId
          ? markSessionSettled(state.sessions, state.activeSessionId)
          : state.sessions,
        // 离开部署页去改能力勾选时留一条回路：回来时不需要重走整条流程。
        phaseReturn: leavingDeploy
          ? { phase: state.phase, sessionId: state.activeSessionId || 'session-deploy' }
          : (action.phase === PHASES.DEPLOY ? null : (state.phaseReturn ?? null)),
      };
    }

    case 'PHASE_RETURN': {
      const back = state.phaseReturn;
      if (!back) return state;
      const hasSession = state.sessions.some((session) => session.id === back.sessionId);
      const nextSessionId = hasSession ? back.sessionId : state.activeSessionId;
      return {
        ...state,
        view: 'flow',
        phase: back.phase,
        activeSessionId: nextSessionId,
        sessions: nextSessionId !== state.activeSessionId
          ? markSessionSettled(state.sessions, state.activeSessionId)
          : state.sessions,
        phaseReturn: null,
      };
    }

    case 'PROJECT_LIST_REQUEST':
      return { ...state, project: { ...state.project, status: 'loading', openError: null } };

    case 'PROJECT_LIST_SUCCESS':
      return {
        ...state,
        project: {
          ...state.project,
          status: 'ready',
          list: Array.isArray(action.list) ? action.list : [],
          openError: null,
        },
      };

    case 'PROJECT_LIST_FAILURE':
      return {
        ...state,
        project: {
          ...state.project,
          status: 'error',
          openError: action.error || { code: 'PROJECT_READ_FAILED', message: '项目列表读取失败' },
        },
      };

    case 'PROJECT_OPEN_REQUEST':
      return {
        ...state,
        project: { ...state.project, status: 'loading', openError: null },
        // 切项目即放弃在途会话请求：加载期间不该继续显示「正在等待」，重开也不会转圈。
        agentChat: abandonAgentChatRequest(state.agentChat),
      };

    case 'PROJECT_OPEN_SUCCESS': {
      const hydrated = fromDocument(action.doc);
      const opened = {
        ...state,
        ...hydrated,
        view: 'flow',
        project: {
          ...state.project,
          status: 'ready',
          activeId: action.projectId,
          createdAt: hydrated.project.createdAt,
          appid: hydrated.project.appid,
          dirty: false,
          saving: false,
          lastSavedAt: action.savedAt || null,
          lastSavedBytes: action.bytes || 0,
          saveError: null,
          openError: null,
          deleteTarget: null,
        },
      };
      // 会话切到目标项目：消息优先用快照恢复（T2 口径），没有就是空会话；
      // 上一个项目的消息不会被带过来，遗留的 requesting 也在这里归一为 idle。
      const restoredChat = hydrated.agentChat;
      const restoredMessages = Array.isArray(restoredChat?.messages)
        ? restoredChat.messages
        : (Array.isArray(restoredChat) ? restoredChat : []);
      return withAgentChatProject(opened, action.projectId, restoredMessages);
    }

    case 'PROJECT_OPEN_FAILURE':
      return {
        ...state,
        project: {
          ...state.project,
          status: (state.project.list || []).length > 0 ? 'ready' : 'error',
          saving: false,
          openError: action.error || { code: 'PROJECT_READ_FAILED', message: '项目读取失败' },
        },
      };

    case 'PROJECT_OPEN_ERROR_CLEAR':
      return { ...state, project: { ...state.project, openError: null } };

    case 'ADD_PROJECT_IMAGES': {
      const incoming = Array.isArray(action.images) ? action.images : [];
      if (incoming.length === 0) return state;
      const current = state.assets && Array.isArray(state.assets.images) ? state.assets.images : [];
      const seen = new Set(current.map((item) => item && item.assetId).filter(Boolean));
      const merged = [...current];
      incoming.forEach((item) => {
        if (!item || typeof item.assetId !== 'string' || seen.has(item.assetId)) return;
        seen.add(item.assetId);
        merged.push(item);
      });
      if (merged.length > 6) merged.length = 6;
      if (merged.length === current.length) return state;
      return { ...state, assets: { ...(state.assets || {}), images: merged } };
    }

    case 'REMOVE_PROJECT_IMAGE': {
      const current = state.assets && Array.isArray(state.assets.images) ? state.assets.images : [];
      const images = current.filter((item) => item && item.assetId !== action.assetId);
      if (images.length === current.length) return state;
      return { ...state, assets: { ...(state.assets || {}), images } };
    }

    case 'PROJECT_NEW_SUCCESS': {
      const blank = createInitialState();
      const created = {
        ...blank,
        view: 'flow',
        settings: state.settings,
        project: {
          ...state.project,
          ...blank.project,
          status: 'ready',
          activeId: action.projectId,
          createdAt: action.createdAt || null,
          appid: typeof action.appid === 'string' ? action.appid : '',
          dirty: false,
          saving: false,
          lastSavedAt: null,
          saveError: null,
          openError: null,
          deleteTarget: null,
        },
      };
      // 新项目：会话换到新项目且没有消息（上一项目的历史留在它自己的 project.json 里）。
      return withAgentChatProject(created, action.projectId, []);
    }

    case 'PROJECT_MARK_DIRTY':
      return state.project.dirty ? state : { ...state, project: { ...state.project, dirty: true } };

    case 'PROJECT_SAVE_REQUEST':
      return { ...state, project: { ...state.project, saving: true } };

    case 'PROJECT_SAVED':
      return {
        ...state,
        project: {
          ...state.project,
          saving: false,
          dirty: false,
          lastSavedAt: action.savedAt || null,
          lastSavedBytes: Number.isFinite(action.bytes) ? action.bytes : state.project.lastSavedBytes,
          saveError: null,
        },
      };

    case 'PROJECT_SAVE_FAILED':
      return {
        ...state,
        project: {
          ...state.project,
          saving: false,
          saveError: action.error || { code: 'PROJECT_WRITE_FAILED', message: '保存失败' },
        },
      };

    case 'PROJECT_DELETE_REQUEST':
      return { ...state, project: { ...state.project, deleteTarget: { projectId: action.projectId, name: action.name } } };

    case 'PROJECT_DELETE_CANCEL':
      return { ...state, project: { ...state.project, deleteTarget: null } };

    case 'PROJECT_DELETE_SUCCESS': {
      const remaining = state.project.list.filter((item) => item.projectId !== action.projectId);
      if (state.project.activeId === action.projectId) {
        const blank = createInitialState();
        const cleared = {
          ...blank,
          view: 'workbench',
          settings: state.settings,
          project: {
            ...blank.project,
            list: remaining,
            status: 'ready',
            search: state.project.search,
            deleteTarget: null,
            mode: state.project.mode,
          },
        };
        // 活动项目被删除：会话跟着清空，任何在途请求都作废（迟到响应会被四元组守卫拒收）。
        return withAgentChatProject(cleared, null, []);
      }
      return {
        ...state,
        project: { ...state.project, list: remaining, status: 'ready', deleteTarget: null },
      };
    }

    case 'PROJECT_DELETE_FAILURE':
      return {
        ...state,
        project: { ...state.project, deleteTarget: null, saveError: action.error || { code: 'PROJECT_WRITE_FAILED', message: '删除项目失败' } },
      };

    case 'PROJECT_SEARCH_SET':
      return { ...state, project: { ...state.project, search: String(action.value || '') } };

    case 'PROJECT_SET_APPID':
      return { ...state, project: { ...state.project, appid: String(action.appid || ''), dirty: true } };

    case 'PROJECT_SET_MODE':
      return { ...state, project: { ...state.project, mode: action.mode === 'browser' ? 'browser' : 'desktop' } };

    case 'PROJECT_SET_LAST_SAVED':
      return {
        ...state,
        project: { ...state.project, lastSavedAt: action.savedAt || null, lastSavedBytes: action.bytes || 0 },
      };

    case 'SETTINGS_LOAD_SUCCESS':
      return {
        ...state,
        settings: {
          ...state.settings,
          status: 'ready',
          config: action.config || null,
        },
      };

    case 'SETTINGS_SAVE_SUCCESS':
      return {
        ...state,
        settings: { ...state.settings, status: 'ready', config: action.config || state.settings.config },
      };

    case 'SETTINGS_PATCH': {
      const patch = action.patch && typeof action.patch === 'object' ? action.patch : {};
      return {
        ...state,
        settings: { ...state.settings, config: { ...(state.settings.config || {}), ...patch } },
      };
    }

    case 'DIAGNOSTICS_START':
      return {
        ...state,
        settings: {
          ...state.settings,
          diagnostics: { status: 'running', checkedAt: null, lines: [], error: null },
        },
      };

    case 'DIAGNOSTICS_LINE': {
      const line = action.line;
      if (!line || !line.id) return state;
      const lines = state.settings.diagnostics.lines.filter((item) => item.id !== line.id);
      return {
        ...state,
        settings: {
          ...state.settings,
          diagnostics: { ...state.settings.diagnostics, lines: [...lines, line] },
        },
      };
    }

    case 'DIAGNOSTICS_DONE':
      return {
        ...state,
        settings: {
          ...state.settings,
          diagnostics: {
            status: 'done',
            checkedAt: action.checkedAt || null,
            lines: Array.isArray(action.lines) ? action.lines : state.settings.diagnostics.lines,
            error: null,
          },
        },
      };

    case 'DIAGNOSTICS_FAILURE':
      return {
        ...state,
        settings: {
          ...state.settings,
          diagnostics: {
            ...state.settings.diagnostics,
            status: 'failed',
            error: action.error || { code: 'DIAGNOSTICS_FAILED', message: '自检未完成' },
          },
        },
      };

    case 'PREFLIGHT_START':
      return {
        ...state,
        deploy: {
          ...state.deploy,
          preflight: { ...createEmptyPreflight(), status: 'checking' },
        },
      };

    case 'PREFLIGHT_RESULT':
      return {
        ...state,
        deploy: {
          ...state.deploy,
          preflight: {
            status: action.error ? 'failed' : 'done',
            errors: Array.isArray(action.errors) ? action.errors : [],
            warns: Array.isArray(action.warns) ? action.warns : [],
            infos: Array.isArray(action.infos) ? action.infos : [],
            acknowledged: state.deploy.preflight.acknowledged || [],
            planDigest: action.planDigest || null,
            signature: action.signature || null,
            recipe: action.recipe || null,
            checkedAt: action.checkedAt || null,
            error: action.error || null,
          },
        },
      };

    case 'PREFLIGHT_RESET':
      return { ...state, deploy: { ...state.deploy, preflight: createEmptyPreflight() } };

    case 'PREFLIGHT_ACK_TOGGLE': {
      const ruleId = String(action.ruleId || '');
      if (!ruleId) return state;
      const current = new Set(state.deploy.preflight.acknowledged || []);
      if (current.has(ruleId)) current.delete(ruleId); else current.add(ruleId);
      return {
        ...state,
        deploy: {
          ...state.deploy,
          preflight: { ...state.deploy.preflight, acknowledged: [...current].sort() },
        },
      };
    }

    case 'HANDOFF_OPEN': {
      const existing = state.deploy.handoff;
      const handoff = existing || {
        stepId: 'prepare',
        completedStepIds: [],
        appidApplied: false,
        appidDigestBefore: null,
        appidDigestAfter: null,
        devtoolsDetected: false,
        updatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      };
      return { ...state, deploy: { ...state.deploy, handoff } };
    }

    case 'HANDOFF_STEP_SET': {
      if (!state.deploy.handoff) return state;
      return {
        ...state,
        deploy: {
          ...state.deploy,
          handoff: { ...state.deploy.handoff, stepId: action.stepId, updatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') },
        },
      };
    }

    case 'HANDOFF_STEP_COMPLETE': {
      if (!state.deploy.handoff) return state;
      const completed = [...new Set([...(state.deploy.handoff.completedStepIds || []), action.stepId])];
      return {
        ...state,
        deploy: {
          ...state.deploy,
          handoff: { ...state.deploy.handoff, completedStepIds: completed, updatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') },
        },
      };
    }

    case 'HANDOFF_APPID_RESULT':
      if (!state.deploy.handoff) return state;
      return {
        ...state,
        deploy: {
          ...state.deploy,
          handoff: {
            ...state.deploy.handoff,
            appidApplied: Boolean(action.applied),
            appidDigestBefore: action.digestBefore ?? state.deploy.handoff.appidDigestBefore,
            appidDigestAfter: action.digestAfter ?? state.deploy.handoff.appidDigestAfter,
            updatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
          },
        },
      };

    case 'HANDOFF_CLOSE':
      return { ...state, deploy: { ...state.deploy, handoff: null } };

    case 'HANDOFF_DEVTOOLS_RESULT':
      if (!state.deploy.handoff) return state;
      return {
        ...state,
        deploy: { ...state.deploy, handoff: { ...state.deploy.handoff, devtoolsDetected: Boolean(action.detected) } },
      };

    case 'UNDO_APPLY':
    case 'REDO_APPLY': {
      const snapshot = action.snapshot;
      if (!snapshot) return state;
      const draft = normalizeAgentDraft(snapshot.agentDraft ?? state.agentDraft);
      const validation = validateAgentDraft(draft);
      const status = state.agent.status === AGENT_STATUS.CONFIRMED && validation.readyForReview
        ? AGENT_STATUS.CONFIRMED
        : (validation.readyForReview ? AGENT_STATUS.REVIEWING : AGENT_STATUS.COLLECTING);
      return {
        ...state,
        store: snapshot.store ? { ...state.store, ...snapshot.store } : state.store,
        features: snapshot.features ? { ...state.features, ...snapshot.features } : state.features,
        build: snapshot.build ? { ...state.build, selectedId: snapshot.build.selectedId } : state.build,
        visual: snapshot.visual ? { ...state.visual, ...snapshot.visual, image: state.visual.image } : state.visual,
        agentDraft: draft,
        agent: {
          ...state.agent,
          status,
          missingFields: validation.missingFields,
          errors: validation.errors,
          nextQuestion: buildNextQuestion(validation),
        },
        presentation: restorePresentation(snapshot, state),
        project: {
          ...state.project,
          appid: typeof snapshot.appid === 'string' ? snapshot.appid : state.project.appid,
          dirty: true,
        },
      };
    }

    case 'RESET_PROJECT': {
      const blank = createInitialState();
      const reset = {
        ...blank,
        view: 'flow',
        project: {
          ...blank.project,
          list: state.project.list,
          status: state.project.status,
          search: state.project.search,
          mode: state.project.mode,
          activeId: state.project.activeId,
          createdAt: state.project.createdAt,
          appid: state.project.appid,
          dirty: true,
          lastSavedAt: state.project.lastSavedAt,
        },
        settings: state.settings,
      };
      // 重置项目内容：会话也回到空项目会话，作废在途请求（历史仍由快照层按项目保存）。
      return withAgentChatProject(reset, state.project.activeId, []);
    }

    case 'RESET':
      return createInitialState();

    case 'START_ONBOARDING': {
      if (state.phase !== PHASES.HOME) return { ...state, phase: PHASES.ONBOARDING, view: 'flow' };
      const next = appendMessages(state, state.activeSessionId, [{ text: NAMING_GUIDANCE.title, meta: { kind: 'naming' } }]);
      return { ...next, phase: PHASES.ONBOARDING, view: 'flow' };
    }

    case 'SUBMIT_NAME': {
      const name = String(action.name || '').trim().slice(0, 48);
      if (!name) return state;
      let next = appendMessages(state, state.activeSessionId, [{ role: ROLES.USER, text: name, instant: true }]);
      // UX0-3：自我介绍不再逐句气泡弹出，合并成一张欢迎卡（内容仍来自 INTRO_SCRIPT）。
      next = appendMessages(next, state.activeSessionId, [{
        text: INTRO_SCRIPT.join('\n\n'),
        staged: true,
        meta: { kind: 'welcome', title: '欢迎使用轻启', items: INTRO_SCRIPT },
      }]);
      return {
        ...next,
        store: { ...next.store, name },
        sessions: next.sessions.map((session) => (session.id === state.activeSessionId ? { ...session, title: name } : session)),
      };
    }

    case 'SKIP_INTRO': {
      const flushed = {
        ...state,
        sessions: state.sessions.map((session) => (
          session.id === state.activeSessionId
            ? { ...session, revealFlush: (session.revealFlush ?? 0) + 1 }
            : session
        )),
      };
      // 顺序调整：命名之后先填写门店资料，再进入能力与定制。
      // 店名已在命名阶段确定，这里预填进资料草稿，避免重复询问。
      return withAgentStoreName({ ...flushed, view: 'flow', phase: PHASES.STORE_INFO }, state.store.name);
    }

    case 'ENTER_FEATURES':
      return enterFeatures(state);

    case 'TOGGLE_FEATURE': {
      if (REQUIRED_FEATURE_IDS.includes(action.id)) return state;
      const set = new Set(state.features.selected);
      if (set.has(action.id)) set.delete(action.id); else set.add(action.id);
      return { ...state, features: { ...state.features, selected: [...set] } };
    }

    case 'SET_FEATURES_CUSTOM':
      return { ...state, features: { ...state.features, custom: action.value } };

    case 'SUBMIT_CUSTOMIZE': {
      const custom = String(action.value ?? state.features.custom ?? '').trim();
      let next = custom ? { ...state, features: { ...state.features, custom } } : state;
      if (custom) next = appendMessages(next, state.activeSessionId, [{ role: ROLES.USER, text: custom, instant: true }]);
      next = appendMessages(next, state.activeSessionId, [{ text: BUILDING_INTRO, staged: true }]);
      return {
        ...next,
        phase: PHASES.BUILDING,
        phaseReturn: null,
        build: { ...next.build, status: 'building', candidates: [], selectedId: null, feedback: [], refineError: null },
      };
    }

    case 'BUILD_READY': {
      const candidates = action.candidates || [];
      let next = appendMessages(state, state.activeSessionId, [{ text: TEMPLATE_INTRO, staged: true, meta: { kind: 'template-pick' } }]);
      return {
        ...next,
        phase: PHASES.TEMPLATE_PICK,
        build: { ...next.build, status: 'ready', candidates, selectedId: candidates[0]?.id ?? null, refineError: null },
      };
    }

    /**
     * 模板页「不满意 → 重新用语言描述」。
     *
     * 语义约束：不离开 TEMPLATE_PICK、不清空已选功能、不覆盖已有候选——
     * 输入的消息进入当前会话，build.status 切到 building，由 App 层重新生成候选，
     * 生成完成后用 TEMPLATE_REBUILD_READY 原地替换候选（不再追加一遍开场白）。
     */
    case 'SUBMIT_TEMPLATE_FEEDBACK': {
      if (state.phase !== PHASES.TEMPLATE_PICK) return state;
      if (state.build.status === 'building') return state;
      const text = String(action.value ?? '').trim().slice(0, TEMPLATE_REFINE.maxLength);
      if (!text) return state;
      const feedback = [...(state.build.feedback || []), text].slice(-8);
      let next = appendMessages(state, state.activeSessionId, [{ role: ROLES.USER, text, instant: true }]);
      next = appendMessages(next, next.activeSessionId, [{
        text: TEMPLATE_REFINE.reply,
        staged: true,
        meta: { kind: 'template-refine' },
      }]);
      return {
        ...next,
        build: { ...next.build, status: 'building', feedback, refineError: null },
      };
    }

    case 'TEMPLATE_REBUILD_READY': {
      const candidates = Array.isArray(action.candidates) ? action.candidates : [];
      if (candidates.length === 0) {
        return {
          ...state,
          build: {
            ...state.build,
            status: 'ready',
            refineError: { code: 'TEMPLATE_REBUILD_EMPTY', message: '这一版没有可用的页面骨架，请换个说法再试。' },
          },
        };
      }
      return {
        ...state,
        build: {
          ...state.build,
          status: 'ready',
          candidates,
          selectedId: candidates[0].id,
          refineError: null,
        },
      };
    }

    case 'TEMPLATE_REBUILD_FAILED': {
      const withMessage = appendMessages(state, state.activeSessionId, [{
        text: TEMPLATE_REFINE.failed,
        staged: true,
        meta: { kind: 'template-refine-failed' },
      }]);
      const source = action.error ?? {};
      return {
        ...withMessage,
        build: {
          ...withMessage.build,
          status: 'ready',
          refineError: {
            code: source.code ?? 'TEMPLATE_REBUILD_FAILED',
            message: source.message ?? TEMPLATE_REFINE.failed,
          },
        },
      };
    }

    /**
     * 模板切换（plan.md 2.2.3）。
     *
     * 换到不同模板时旧补丁不再适用：清空 `patch/changes`、丢弃挂起请求（requestId=null），
     * 避免旧模板的晚响应落到新模板上。重复选择同一模板不重置任何东西。
     */
    case 'SELECT_TEMPLATE': {
      const id = action.id;
      const build = { ...state.build, selectedId: id };
      const presentation = state.presentation ?? createInitialPresentationSlice();
      if (presentation.templateId === id) return { ...state, build };
      const patchEmpty = !presentation.patch || Object.keys(presentation.patch).length === 0;
      return {
        ...state,
        build,
        presentation: {
          ...presentation,
          templateId: id,
          ...(patchEmpty ? {} : { patch: {}, changes: [] }),
          status: 'idle',
          requestId: null,
          error: null,
        },
      };
    }

    /**
     * 模板页「对话修改当前模板」：发出修改请求（plan.md 2.2.3）。
     *
     * 单飞：`status === 'revising'` 时忽略；`build.status !== 'ready'` 时没有可改的模板。
     * `patch` 保持不变——多轮累积由 T4 在请求里带上当前已接受补丁、服务端返回合并结果完成。
     */
    case 'TEMPLATE_REVISE_REQUEST': {
      if (state.phase !== PHASES.TEMPLATE_PICK) return state;
      if (state.build.status !== 'ready') return state;
      const presentation = state.presentation ?? createInitialPresentationSlice();
      if (presentation.status === 'revising') return state;
      const utterance = String(action.utterance ?? '').trim();
      const requestId = typeof action.requestId === 'string' ? action.requestId.trim() : '';
      if (!utterance || !requestId) return state;
      // 右侧会话发起的修订只在侧栏消息列表里出现；中间主会话不重复渲染。
      const fromSidebar = action.origin === 'sidebar';
      const withMessage = fromSidebar ? state : appendMessages(state, state.activeSessionId, [{
        role: ROLES.USER,
        text: utterance,
        instant: true,
        meta: { kind: 'template-revise-request' },
      }]);
      return {
        ...withMessage,
        presentation: {
          ...presentation,
          templateId: presentation.templateId ?? state.build.selectedId ?? null,
          status: 'revising',
          requestId,
          lastUtterance: utterance,
          error: null,
        },
      };
    }

    /**
     * 修改成功（plan.md 2.2.3）。
     *
     * `requestId` / `templateId` 必须与当前挂起请求一致，否则整包忽略（含 changes 与撤销压栈）。
     * 服务端结果先过 `validatePresentationPatch` 兜底，非法则进入失败态、保留上一版补丁。
     */
    case 'TEMPLATE_REVISE_SUCCESS': {
      const presentation = state.presentation ?? createInitialPresentationSlice();
      const requestId = typeof action.requestId === 'string' ? action.requestId.trim() : '';
      if (!requestId || presentation.status !== 'revising' || requestId !== presentation.requestId) {
        return state;
      }
      const templateId = typeof action.templateId === 'string' && action.templateId
        ? action.templateId
        : (presentation.templateId ?? state.build.selectedId ?? null);
      if (presentation.templateId && templateId !== presentation.templateId) return state;

      const context = presentationContext(state, templateId);
      const validated = validatePresentationPatch(action.patch ?? {}, context);
      if (!validated.ok) {
        const detail = Array.isArray(validated.details) ? validated.details[0] : null;
        return {
          ...state,
          presentation: {
            ...presentation,
            status: 'failed',
            error: {
              code: validated.code,
              message: detail?.message ? `展示修改未通过校验：${detail.message}` : '展示修改未通过校验，请再试一次。',
            },
          },
        };
      }

      const nextPatch = validated.patch;
      const providedChanges = normalizePresentationChanges(action.changes);
      const changes = providedChanges
        ?? diffPresentationPatch(presentation.patch ?? {}, nextPatch, context);
      const reply = typeof action.reply === 'string' ? action.reply.trim() : '';

      const withMessage = action.origin === 'sidebar'
        ? state
        : appendMessages(state, state.activeSessionId, [{
          text: reply || `已更新 ${changes.length} 项`,
          staged: true,
          meta: { kind: 'template-revise' },
        }]);

      const applied = applyPresentationCopy(withMessage, nextPatch.copy);
      let next = {
        ...withMessage,
        presentation: {
          ...presentation,
          templateId,
          patch: nextPatch,
          changes,
          status: 'idle',
          error: null,
        },
      };
      if (applied) {
        // 只同步资料与草稿，不改变 agent.status（模板页修改展示不应把抽帧状态推成 collecting）。
        const draft = normalizeAgentDraft(applied.draft);
        const validation = validateAgentDraft(draft);
        next = {
          ...next,
          store: applied.store,
          agentDraft: draft,
          agent: {
            ...next.agent,
            missingFields: validation.missingFields,
            errors: validation.errors,
            nextQuestion: buildNextQuestion(validation),
          },
        };
      }
      return next;
    }

    /**
     * 修改失败（plan.md 2.2.3）：保留上一版 `patch/changes`，不追加成功消息。
     * 与 SUCCESS 一样，非当前请求的失败结果整包忽略。
     */
    case 'TEMPLATE_REVISE_FAILURE': {
      const presentation = state.presentation ?? createInitialPresentationSlice();
      const requestId = typeof action.requestId === 'string' ? action.requestId.trim() : '';
      if (!requestId || presentation.status !== 'revising' || requestId !== presentation.requestId) {
        return state;
      }
      const error = normalizePresentationError(
        action.error,
        'TEMPLATE_REVISE_FAILED',
        '展示修改失败，请稍后再试。',
      );
      return { ...state, presentation: { ...presentation, status: 'failed', error } };
    }

    case 'TEMPLATE_REVISE_CLEAR': {
      const presentation = state.presentation ?? createInitialPresentationSlice();
      if (presentation.status === 'idle' && presentation.error === null) return state;
      return { ...state, presentation: { ...presentation, status: 'idle', error: null } };
    }

    case 'CONFIRM_TEMPLATE': {
      const chosen = state.build.candidates.find((item) => item.id === state.build.selectedId) ?? state.build.candidates[0];
      const style = STYLE_PRESETS.find((item) => item.id === state.visual.styleId) ?? STYLE_PRESETS[0];
      // 顺序调整：生成框架、选完骨架后进入装修与视觉，而不是回头补门店资料。
      const entered = createStepSession(state, {
        phase: PHASES.PROMPT_STUDIO,
        id: 'session-visual',
        title: '视觉生成',
        intro: PROMPT_INTRO,
        followUp: '偏好记下后，可以上传一张海报素材，也可以直接跳过。',
        summary: [
          `店铺名称：${state.store.name || NEW_PROJECT_LABEL}`,
          `页面骨架：${chosen?.name ?? '默认骨架'}`,
          `功能能力：共 ${state.features.selected.length} 项`,
          state.features.custom ? `定制要求：${state.features.custom}` : '未提出额外定制要求',
          `装修风格：${style.name}`,
        ],
        payload: { template: chosen?.id ?? null, styleId: style.id, store: state.store, agentDraft: toContractDraft(state.agentDraft) },
        fields: [
          { label: '店铺名', value: state.store.name || NEW_PROJECT_LABEL },
          { label: '装修风格', value: style.name, note: style.caption },
        ],
      });
      return withAgentStoreName(entered, entered.store.name);
    }

    case 'SET_STORE_FIELD': {
      const store = { ...state.store, [action.field]: action.value };
      if (state.agent.status !== AGENT_STATUS.CONFIRMED) return { ...state, store };
      if (action.field !== 'name' && action.field !== 'type') return { ...state, store };
      const patch = action.field === 'name'
        ? { storeName: action.value }
        : { category: action.value };
      const draft = applyDraftPatch(state.agentDraft, patch);
      const validation = validateAgentDraft(draft);
      return {
        ...state,
        store,
        agentDraft: draft,
        agent: {
          ...state.agent,
          missingFields: validation.missingFields,
          errors: validation.errors,
          nextQuestion: buildNextQuestion(validation),
        },
      };
    }

    // ---- P3：参考截图 → 识别 → 确认 → 候选 → 采用 ----
    case 'SCREEN_REF_IMAGE_SET': {
      const image = action.image && typeof action.image === 'object' ? action.image : null;
      if (!image) return state;
      const next = {
        ...state.screenRef,
        image,
        imageRevision: (state.screenRef.imageRevision || 0) + 1,
        status: SCREEN_REF_STATUS.IDLE,
        requestId: null,
        requestImageRevision: null,
        recognition: null,
        confirmedAt: null,
        candidate: null,
        adopted: false,
        error: null,
        meta: null,
      };
      return { ...state, screenRef: withScreenRefView(next) };
    }

    case 'SCREEN_REF_IMAGE_HYDRATE': {
      const current = state.screenRef.image;
      const image = action.image && typeof action.image === 'object' ? action.image : null;
      if (!current?.assetId || !image || current.assetId !== image.assetId) return state;
      const next = {
        ...state.screenRef,
        image: { ...current, ...image, assetId: current.assetId },
      };
      return { ...state, screenRef: withScreenRefView(next) };
    }

    case 'SCREEN_REF_REQUEST': {
      // 识别中不重复发请求：与 Agent 的防重口径一致。
      if (state.screenRef.status === SCREEN_REF_STATUS.RECOGNIZING) return state;
      if (!state.screenRef.image) return state;
      const next = {
        ...state.screenRef,
        status: SCREEN_REF_STATUS.RECOGNIZING,
        requestId: action.requestId ?? null,
        // 冻结本次识别对应的截图版本：换图后到达的旧结果一律丢弃。
        requestImageRevision: state.screenRef.imageRevision,
        attempt: (state.screenRef.attempt || 0) + 1,
        // 重新识别等于推翻上次确认，确认必须重来。
        confirmedAt: null,
        candidate: null,
        adopted: false,
        error: null,
        meta: null,
      };
      return { ...state, screenRef: withScreenRefView(next) };
    }

    case 'SCREEN_REF_SUCCESS': {
      const slice = state.screenRef;
      if (slice.status !== SCREEN_REF_STATUS.RECOGNIZING) return state;
      if (!action.requestId || action.requestId !== slice.requestId) return state;
      if (Number.isInteger(action.imageRevision) && action.imageRevision !== slice.imageRevision) return state;
      const recognition = action.recognition ?? null;
      const usable = recognitionUsable(recognition);
      const next = {
        ...slice,
        status: usable ? SCREEN_REF_STATUS.READY : SCREEN_REF_STATUS.DEGRADED,
        recognition,
        confirmedAt: null,
        error: usable ? null : (action.message || '这张截图没有得到可用识别结果，可以换一张再试。'),
        meta: action.meta ?? null,
      };
      return { ...state, screenRef: withScreenRefView(next) };
    }

    case 'SCREEN_REF_FAILURE': {
      const slice = state.screenRef;
      if (slice.status !== SCREEN_REF_STATUS.RECOGNIZING) return state;
      if (!action.requestId || action.requestId !== slice.requestId) return state;
      const next = {
        ...slice,
        status: SCREEN_REF_STATUS.FAILED,
        recognition: null,
        confirmedAt: null,
        candidate: null,
        error: action.message || '识别没有成功，可以直接重试。',
        degraded: Boolean(action.degraded),
      };
      return { ...state, screenRef: withScreenRefView(next) };
    }

    case 'SCREEN_REF_CONFIRM': {
      const slice = state.screenRef;
      if (slice.status !== SCREEN_REF_STATUS.READY) return state;
      if (!recognitionUsable(slice.recognition)) return state;
      if (slice.confirmedAt) return state;
      const next = { ...slice, confirmedAt: action.at ?? null, error: null };
      return { ...state, screenRef: withScreenRefView(next) };
    }

    case 'SCREEN_REF_CREATE_CANDIDATE': {
      const slice = state.screenRef;
      if (slice.candidate) return state;
      const result = buildCandidateRecipe({
        recognition: slice.recognition,
        confirmedAt: slice.confirmedAt,
        baseRecipeId: action.baseRecipeId,
        draft: state.agentDraft,
        createdAt: action.at ?? null,
      });
      if (!result.ok) {
        return { ...state, screenRef: withScreenRefView({ ...slice, error: result.message }) };
      }
      const next = { ...slice, candidate: result.candidate, adopted: false, error: null };
      return { ...state, screenRef: withScreenRefView(next) };
    }

    case 'SCREEN_REF_ADOPT': {
      const slice = state.screenRef;
      if (!slice.candidate || slice.adopted) return state;
      const patch = candidateToSessionPatch(slice.candidate);
      if (!patch || !patch.selectedId) return state;
      const currentFeatures = Array.isArray(state.features?.selected) ? state.features.selected : [];
      // 候选组件只做并集：基础必需能力与用户已选能力不会被候选顺手删掉。
      const mergedFeatures = [...currentFeatures];
      patch.featureIds.forEach((id) => {
        if (!mergedFeatures.includes(id)) mergedFeatures.push(id);
      });
      const presentationPatch = {};
      if (Object.keys(patch.presentation.theme).length) presentationPatch.theme = patch.presentation.theme;
      if (Object.keys(patch.presentation.sizes).length) presentationPatch.sizes = patch.presentation.sizes;
      // 候选必须进入模板候选列表：模板页与 project.json 都以 candidates 为准，
      // 否则重开项目会把「已采用的候选」丢掉，退回门店资料页。
      const candidates = Array.isArray(state.build.candidates) ? [...state.build.candidates] : [];
      if (!candidates.some((item) => item && item.id === patch.selectedId)) {
        candidates.unshift({
          id: patch.selectedId,
          name: String(slice.candidate.recipeLabel || '参考截图候选').slice(0, 40),
          layout: 'reference',
          score: 80,
          summary: `参考截图生成：${patch.featureIds.length} 个组件，可继续在下一步微调。`.slice(0, 160),
        });
      }
      return {
        ...state,
        build: { ...state.build, selectedId: patch.selectedId, candidates, status: 'ready' },
        features: { ...state.features, selected: mergedFeatures },
        presentation: {
          ...state.presentation,
          templateId: patch.selectedId,
          patch: presentationPatch,
        },
        screenRef: withScreenRefView({
          ...slice,
          adopted: true,
          previousSelection: slice.previousSelection ?? snapshotSelection(state),
          error: null,
        }),
      };
    }

    case 'SCREEN_REF_DISCARD': {
      const slice = state.screenRef;
      if (!slice.candidate) return state;
      const restore = slice.adopted ? slice.previousSelection : null;
      const discardedPatch = candidateToSessionPatch(slice.candidate);
      const base = {
        ...state,
        screenRef: withScreenRefView({
          ...slice,
          candidate: null,
          adopted: false,
          previousSelection: null,
          // P2：放弃后留一条痕迹，模板页要说清「已放弃，当前版本没变」。
          lastDiscarded: discardedPatch
            ? {
              templateId: discardedPatch.selectedId,
              recipeId: discardedPatch.recipeId,
              label: slice.candidate.recipeLabel || null,
              at: typeof action.at === 'string' ? action.at : new Date().toISOString(),
            }
            : null,
          error: null,
        }),
      };
      if (!restore) return base;
      const keptIds = new Set(Array.isArray(restore.candidateIds) ? restore.candidateIds : []);
      const candidates = (Array.isArray(base.build.candidates) ? base.build.candidates : [])
        .filter((item) => item && keptIds.has(item.id));
      return {
        ...base,
        build: { ...base.build, selectedId: restore.selectedId, candidates },
        features: { ...base.features, selected: [...restore.features] },
        presentation: {
          ...base.presentation,
          templateId: restore.presentation.templateId,
          patch: JSON.parse(JSON.stringify(restore.presentation.patch ?? {})),
        },
      };
    }

    case 'SCREEN_REF_RESET':
      return { ...state, screenRef: createInitialScreenRefSlice() };

    case 'AGENT_TURN_REQUEST': {
      const utterance = String(action.utterance ?? '').trim();
      if (!utterance) return state;
      if (state.agent.status === AGENT_STATUS.REQUESTING) return state;
      // 右侧会话发起的轮次只记进 agentChat；中间主会话只保留阶段切换提示，
      // 不再把同一句原话重复渲染一次。
      const fromSidebar = action.origin === 'sidebar';
      const withMessage = fromSidebar ? state : appendMessages(state, state.activeSessionId, [{
        role: ROLES.USER,
        text: utterance,
        instant: true,
      }]);
      return {
        ...withMessage,
        agent: {
          ...withMessage.agent,
          status: AGENT_STATUS.REQUESTING,
          attempts: withMessage.agent.attempts + 1,
          activeRequestId: action.requestId ?? null,
          // 冻结发送时刻的草稿版本：回复到达时只有版本未变才允许整份应用。
          requestDraftRevision: Number.isInteger(action.draftRevision)
            ? action.draftRevision
            : withMessage.agent.draftRevision,
          lastUtterance: utterance,
          lastError: null,
          staleDraftNotice: null,
          hint: null,
          processHistory: archiveProcessHistory(withMessage.agent),
          process: buildProcessView({ status: AGENT_STATUS.REQUESTING }),
        },
      };
    }

    case 'AGENT_TURN_RETRY': {
      if (state.agent.status !== AGENT_STATUS.FAILED) return state;
      if (!state.agent.lastUtterance) return state;
      return {
        ...state,
        agent: {
          ...state.agent,
          status: AGENT_STATUS.REQUESTING,
          attempts: state.agent.attempts + 1,
          activeRequestId: action.requestId ?? null,
          // 重试用最新草稿 + 新 requestId：版本号同样重新冻结。
          requestDraftRevision: Number.isInteger(action.draftRevision)
            ? action.draftRevision
            : state.agent.draftRevision,
          lastError: null,
          staleDraftNotice: null,
          hint: null,
          processHistory: archiveProcessHistory(state.agent),
          process: buildProcessView({ status: AGENT_STATUS.REQUESTING }),
        },
      };
    }

    case 'AGENT_TURN_SUCCESS': {
      if (!isCurrentAgentTurnCompletion(state, action)) return state;
      const runFields = {
        runId: action.runId ?? null,
        trace: action.trace ?? null,
        degraded: action.degraded === true,
        degradation: action.degradation && typeof action.degradation === 'object' ? action.degradation : null,
        stopReason: action.stopReason ?? null,
      };
      const frozenRevision = Number.isInteger(action.draftRevision) ? action.draftRevision : null;
      const revisionChanged = frozenRevision !== null && frozenRevision !== state.agent.draftRevision;

      // 手改/增删菜品已经推进版本号：保留用户现稿，只提示，不应用服务端草稿。
      if (revisionChanged) {
        const currentValidation = validateAgentDraft(state.agentDraft);
        return {
          ...state,
          agent: {
            ...state.agent,
            ...runFields,
            status: currentValidation.readyForReview ? AGENT_STATUS.REVIEWING : AGENT_STATUS.COLLECTING,
            activeRequestId: null,
            requestDraftRevision: null,
            lastError: null,
            simulateFailure: false,
            staleDraftNotice: {
              code: 'AGENT_DRAFT_CHANGED',
              message: '你在等待回复期间改动了资料，已保留你现在的草稿。需要合并服务端的整理结果，可以再发一次这条消息。',
            },
            hint: null,
            // 过程卡按真实 trace 展示，但明确草稿没有被应用。
            process: buildProcessView({
              trace: action.trace ?? null,
              degradation: runFields.degradation,
              changeSummary: [],
              runId: runFields.runId,
            }),
          },
        };
      }

      const draft = normalizeAgentDraft(action.draft);
      const validation = validateAgentDraft(draft);
      const reply = String(action.reply ?? '').trim();
      const withMessage = reply && action.origin !== 'sidebar'
        ? appendMessages(state, state.activeSessionId, [{
          text: reply,
          staged: true,
          meta: { kind: 'agent-turn' },
        }])
        : state;
      return {
        ...withMessage,
        agentDraft: draft,
        agent: {
          ...withMessage.agent,
          ...runFields,
          status: validation.readyForReview ? AGENT_STATUS.REVIEWING : AGENT_STATUS.COLLECTING,
          missingFields: validation.missingFields,
          errors: validation.errors,
          nextQuestion: buildNextQuestion(validation),
          reply,
          meta: action.meta ?? null,
          turnId: action.turnId ?? null,
          activeRequestId: null,
          requestDraftRevision: null,
          lastError: null,
          simulateFailure: false,
          staleDraftNotice: null,
          hint: action.imagesAddedDuringRequest
            ? {
              code: 'AGENT_IMAGES_PENDING',
              message: '请求期间新增了图片，这次回复没有使用它们；发送下一条消息时会带上图片走多模态链路。',
            }
            : null,
          // W3：本轮过程卡（步骤只来自真实 trace；降级时不得显示全绿）。
          process: buildProcessView({
            trace: action.trace ?? null,
            degradation: runFields.degradation,
            changeSummary: Array.isArray(action.changeSummary) ? action.changeSummary : [],
            runId: runFields.runId,
          }),
        },
      };
    }

    case 'AGENT_TURN_FAILURE': {
      if (!isCurrentAgentTurnCompletion(state, action)) return state;
      const source = action.error ?? {};
      const lastError = {
        code: source.code ?? 'AGENT_NETWORK',
        message: source.message ?? '请求失败，请重试。',
        retryable: source.retryable !== false,
        httpStatus: source.httpStatus ?? null,
        serverCode: source.serverCode ?? null,
        requestId: source.requestId ?? null,
      };
      return {
        ...state,
        agent: {
          ...state.agent,
          status: AGENT_STATUS.FAILED,
          activeRequestId: null,
          requestDraftRevision: null,
          lastError,
          simulateFailure: false,
          staleDraftNotice: null,
          hint: null,
          // 失败态也只用一张主卡：说明这一步没走完，并给出是否可以重试。
          process: buildProcessView({ status: AGENT_STATUS.FAILED, lastError }),
        },
      };
    }

    case 'AGENT_SIMULATE_FAILURE':
      return {
        ...state,
        agent: { ...state.agent, simulateFailure: Boolean(action.value) },
      };

    // ---- 项目级 Agent 会话（右侧栏「Agent 对话」）：一个项目一个长会话 ----
    // 业务消息只存在 state.agentChat 里，不进任何组件 useState，也不另建 localStorage。
    case 'AGENT_CHAT_DRAFT_SET': {
      const chat = state.agentChat ?? createEmptyAgentChat();
      const raw = typeof action.value === 'string' ? action.value : String(action.value ?? '');
      // 输入框允许先粘一大段再修剪，但状态里的草稿同样设上限，避免无界增长。
      const draft = raw.length > CHAT_MESSAGE_MAX_CHARS ? raw.slice(0, CHAT_MESSAGE_MAX_CHARS) : raw;
      if (draft === chat.draft) return state;
      return { ...state, agentChat: { ...chat, draft, revision: nextChatRevision(chat) } };
    }

    /**
     * 侧栏发出一次请求：记录请求身份并写入一条用户消息。
     *
     * 单飞：`status === 'requesting'` 时重复提交（快速双击 / 连按 Enter）直接忽略。
     * 冻结 `requestDraftRevision` 与 `requestPhase`，与 projectId/requestId 一起构成四元组。
     */
    case 'AGENT_CHAT_REQUEST_START': {
      const chat = state.agentChat ?? createEmptyAgentChat();
      if (chat.status === CHAT_STATUS.REQUESTING) return state;
      const utterance = typeof action.utterance === 'string' ? action.utterance.trim() : '';
      if (!isValidChatDraft(utterance, { maxChars: CHAT_MESSAGE_MAX_CHARS })) return state;
      const requestId = chatIdText(action.requestId);
      if (!requestId) return state;
      const projectId = currentProjectId(state, action.projectId);
      // 没有活动项目就不发：侧栏这时只给「先打开项目」的本地指引。
      if (!projectId) return state;
      const plan = buildAgentChatSubmitPlan({ projectId, phase: state.phase, hasProject: true });
      const actionKind = CHAT_ACTION_KINDS.includes(action.actionKind) ? action.actionKind : plan.actionKind;
      const userMessage = createChatMessage({
        // 同一 requestId 固定同一 id：重试与 StrictMode 双调用都不会产生第二条用户消息。
        id: chatUserMessageId(requestId),
        role: 'user',
        text: utterance,
        status: 'done',
        actionKind,
        context: { phase: state.phase, sessionId: state.activeSessionId },
        createdAt: action.createdAt,
      });
      return {
        ...state,
        agentChat: {
          ...chat,
          messages: userMessage ? appendChatMessage(chat.messages, userMessage) : chat.messages,
          status: CHAT_STATUS.REQUESTING,
          activeProjectId: projectId,
          activeRequestId: requestId,
          requestDraftRevision: Number.isInteger(action.draftRevision) ? action.draftRevision : chatRevision(chat),
          requestPhase: state.phase,
          lastUtterance: userMessage ? userMessage.text : utterance,
          lastError: null,
          revision: nextChatRevision(chat),
        },
      };
    }

    /**
     * 侧栏请求成功：写一条助手消息 + 一份安全过程卡视图。
     *
     * 只有四元组全部匹配（`isChatResponseAcceptable`）才写入；切换项目、重置、删除后的
     * 迟到响应在这里被整包丢弃，既不碰消息也不碰其它切片的撤销元数据。
     */
    case 'AGENT_CHAT_SUCCESS': {
      const identity = resolveAgentChatIdentity(state, action);
      const chat = identity.chat;
      if (!isChatResponseAcceptable(identity)) return state;
      const reply = typeof action.reply === 'string' ? action.reply.trim() : '';
      const requestMessage = chat.messages.find((item) => item.id === chatUserMessageId(identity.requestId));
      const plan = buildAgentChatSubmitPlan({ projectId: identity.projectId, phase: identity.phase, hasProject: true });
      const actionKind = CHAT_ACTION_KINDS.includes(action.actionKind)
        ? action.actionKind
        : (requestMessage?.actionKind ?? plan.actionKind);
      const assistantMessage = reply
        ? createChatMessage({
          // 固定 id：重复/迟到的成功回调不会追加第二条助手消息。
          id: chatIdText(action.messageId) || chatAssistantMessageId(identity.requestId),
          role: 'assistant',
          text: reply,
          status: 'done',
          actionKind,
          context: { phase: identity.phase, sessionId: state.activeSessionId },
          createdAt: action.createdAt,
        })
        : null;
      return {
        ...state,
        agentChat: {
          ...chat,
          messages: assistantMessage ? appendChatMessage(chat.messages, assistantMessage) : chat.messages,
          status: CHAT_STATUS.IDLE,
          activeRequestId: null,
          requestDraftRevision: null,
          requestPhase: null,
          lastError: null,
          // 过程卡只留状态/耗时/工具标签（normalizeChatRun 已经按白名单裁剪过）。
          lastRun: normalizeChatRun({
            ...(action.run && typeof action.run === 'object' ? action.run : {}),
            requestId: identity.requestId,
            actionKind,
          }),
          revision: nextChatRevision(chat),
        },
      };
    }

    /** 侧栏请求失败：置失败态并保留草稿与已发消息，重试只需要重放 lastUtterance。 */
    case 'AGENT_CHAT_FAILURE': {
      const identity = resolveAgentChatIdentity(state, action);
      const chat = identity.chat;
      if (!isChatResponseAcceptable(identity)) return state;
      return {
        ...state,
        agentChat: {
          ...chat,
          status: CHAT_STATUS.FAILED,
          activeRequestId: null,
          requestDraftRevision: null,
          requestPhase: null,
          lastError: normalizeChatError(action.error),
          revision: nextChatRevision(chat),
        },
      };
    }

    /**
     * 重试上一轮：只允许从失败态重试，且不重复追加用户消息。
     *
     * 新的 requestId 与重新冻结的 draftRevision/phase 让「上一轮的迟到响应」继续被拒收。
     */
    case 'AGENT_CHAT_RETRY_PREPARE': {
      const chat = state.agentChat ?? createEmptyAgentChat();
      if (chat.status !== CHAT_STATUS.FAILED) return state;
      if (!isValidChatDraft(chat.lastUtterance, { maxChars: CHAT_MESSAGE_MAX_CHARS })) return state;
      const requestId = chatIdText(action.requestId);
      if (!requestId) return state;
      const projectId = currentProjectId(state, action.projectId) || chatIdText(chat.activeProjectId);
      if (!projectId) return state;
      return {
        ...state,
        agentChat: {
          ...chat,
          status: CHAT_STATUS.REQUESTING,
          activeProjectId: projectId,
          activeRequestId: requestId,
          requestDraftRevision: Number.isInteger(action.draftRevision) ? action.draftRevision : chatRevision(chat),
          requestPhase: state.phase,
          lastError: null,
          revision: nextChatRevision(chat),
        },
      };
    }

    case 'AGENT_CHAT_CLEAR_ERROR': {
      const chat = state.agentChat ?? createEmptyAgentChat();
      if (chat.status !== CHAT_STATUS.FAILED && !chat.lastError) return state;
      return {
        ...state,
        agentChat: { ...chat, status: CHAT_STATUS.IDLE, lastError: null, revision: nextChatRevision(chat) },
      };
    }

    /**
     * 从快照恢复会话消息（T2 口径）：恢复后一律 idle。
     *
     * 快照里从不保存 activeRequestId / requesting，这里再强制归一一次，
     * 保证「重开项目不会永久转圈」。用户正在输入的草稿不被覆盖。
     */
    case 'AGENT_CHAT_HYDRATE': {
      const chat = state.agentChat ?? createEmptyAgentChat();
      const source = action.chat && typeof action.chat === 'object' ? action.chat : {};
      const messages = normalizeChatMessages(action.messages ?? source.messages);
      return {
        ...state,
        agentChat: {
          ...createEmptyAgentChat(),
          messages,
          draft: chat.draft,
          activeProjectId: currentProjectId(state, action.projectId) || null,
          status: CHAT_STATUS.IDLE,
          revision: nextChatRevision(chat),
        },
      };
    }

    case 'EDIT_AGENT_DRAFT_FIELD': {
      if (!['storeName', 'category', 'businessHours'].includes(action.field)) return state;
      return withValidatedDraft(state, applyDraftPatch(state.agentDraft, { [action.field]: action.value }));
    }

    case 'EDIT_AGENT_FULFILLMENT': {
      if (!['dineIn', 'takeaway'].includes(action.field)) return state;
      return withValidatedDraft(state, applyDraftPatch(state.agentDraft, {
        fulfillment: { [action.field]: Boolean(action.value) },
      }));
    }

    case 'EDIT_AGENT_DISH': {
      if (!['name', 'priceText', 'description'].includes(action.field)) return state;
      if (!state.agentDraft.dishes.some((dish) => dish.id === action.id)) return state;
      const dishes = state.agentDraft.dishes.map((dish) => (
        dish.id === action.id
          ? { ...dish, [action.field]: String(action.value ?? '') }
          : dish
      ));
      return withValidatedDraft(state, applyDraftPatch(state.agentDraft, { dishes }));
    }

    case 'ADD_AGENT_DISH': {
      if (state.agentDraft.dishes.length >= MAX_DISHES) return state;
      const dish = {
        id: createDishId(state.agentDraft.dishes),
        name: '',
        priceCents: null,
        priceText: '',
        description: '',
      };
      return withValidatedDraft(state, {
        ...state.agentDraft,
        dishes: [...state.agentDraft.dishes, dish],
      });
    }

    case 'REMOVE_AGENT_DISH': {
      if (!state.agentDraft.dishes.some((dish) => dish.id === action.id)) return state;
      return withValidatedDraft(state, {
        ...state.agentDraft,
        dishes: state.agentDraft.dishes.filter((dish) => dish.id !== action.id),
      });
    }

    case 'CONFIRM_AGENT_DRAFT': {
      if (state.agent.status !== AGENT_STATUS.REVIEWING) return state;
      const validation = validateAgentDraft(state.agentDraft);
      if (!validation.readyForReview) return state;
      const confirmedAtSeq = state.seq;
      const draft = state.agentDraft;
      const withUserMessage = appendMessages(state, state.activeSessionId, [{
        role: ROLES.USER,
        text: '资料已确认',
        instant: true,
      }]);
      const withSummary = appendMessages(withUserMessage, withUserMessage.activeSessionId, [{
        text: `资料已确认：${draft.storeName}，${draft.category}，${draft.businessHours}，${fulfillmentLabel(draft.fulfillment)}，${draft.dishes.length} 道菜。接下来补充装修风格与地址。`,
        staged: true,
        meta: { kind: 'agent-confirm' },
      }]);
      return {
        ...withSummary,
        store: { ...withSummary.store, name: draft.storeName, type: draft.category },
        agent: {
          ...withSummary.agent,
          status: AGENT_STATUS.CONFIRMED,
          confirmedAtSeq,
          missingFields: validation.missingFields,
          errors: validation.errors,
          nextQuestion: null,
        },
      };
    }

    case 'REOPEN_AGENT_DRAFT': {
      if (state.agent.status !== AGENT_STATUS.CONFIRMED) return state;
      const withMessage = appendMessages(state, state.activeSessionId, [{
        text: '已返回资料编辑，修改后需要再次确认。',
        staged: true,
        meta: { kind: 'agent-reopen' },
      }]);
      return {
        ...withMessage,
        agent: { ...withMessage.agent, status: AGENT_STATUS.REVIEWING },
      };
    }

    /**
     * 切换装修风格（plan.md 2.2.3 契约补充）。
     *
     * 换风格等价于换一套配色意图：清除 `presentation.patch.theme`，
     * 保留 `sizes` / `slotOrder` / `copy`（版面与文案与风格无关）。
     * `changes` 中属于 `theme.*` 的条目同时移除，避免变更清单与补丁不一致。
     */
    case 'SET_STYLE': {
      const visual = { ...state.visual, styleId: action.id };
      const presentation = state.presentation;
      const patch = presentation?.patch;
      if (!patch || !patch.theme) return { ...state, visual };
      const nextPatch = { ...patch };
      delete nextPatch.theme;
      const changes = (Array.isArray(presentation.changes) ? presentation.changes : [])
        .filter((item) => !String(item?.path ?? '').startsWith('theme.'));
      return {
        ...state,
        visual,
        presentation: { ...presentation, patch: nextPatch, changes },
      };
    }

    case 'SUBMIT_STORE_INFO': {
      if (state.agent.status !== AGENT_STATUS.IDLE && state.agent.status !== AGENT_STATUS.CONFIRMED) {
        return state;
      }
      const style = STYLE_PRESETS.find((item) => item.id === (action.styleId ?? state.visual.styleId)) ?? STYLE_PRESETS[0];
      const withConfirmation = appendMessages(state, state.activeSessionId, [{ role: ROLES.USER, text: action.summary, instant: true }]);
      // 顺序调整：门店资料确认后进入能力选择，而不是直接跳到视觉。
      const base = { ...withConfirmation, visual: { ...withConfirmation.visual, styleId: style.id } };
      return enterFeatures(base);
    }

    case 'SET_PROMPT':
      return { ...state, visual: { ...state.visual, prompt: action.prompt } };

    case 'ADD_PROMPT_ROUND': {
      let next = appendMessages(state, state.activeSessionId, [
        { role: ROLES.USER, text: action.text, instant: true },
        { text: action.reply, staged: true },
      ]);
      return {
        ...next,
        visual: {
          ...next.visual,
          prompt: action.prompt ?? next.visual.prompt,
          promptRounds: [...next.visual.promptRounds, { text: action.text, reply: action.reply }],
        },
      };
    }

    case 'CONFIRM_PROMPT': {
      let next = appendMessages(state, state.activeSessionId, [
        { role: ROLES.USER, text: action.text ?? '这版视觉偏好可以了，继续下一步。', instant: true },
        { text: REVIEW_INTRO, staged: true },
      ]);
      return { ...next, phase: PHASES.IMAGE_REVIEW };
    }

    case 'SET_IMAGE':
      // UX0a 遗留入口：只放预览，不声称素材已选用（没有 assetId 就不算上传成功）。
      return {
        ...state,
        visual: { ...state.visual, image: action.image, imageAssetId: null, imageMeta: null },
      };

    case 'SET_POSTER_ASSET': {
      // UX0b：资产已在桌面端落盘成功后才走这里。
      // - imageAssetId 是真实资产 ID，会进 project.json；
      // - imageMeta 只保存来源/尺寸等必要信息；
      // - image.dataUrl 仅供运行中预览，projectSnapshot 不落盘。
      const assetId = typeof action.assetId === 'string' && action.assetId ? action.assetId : null;
      if (!assetId) return state;
      const meta = action.meta && typeof action.meta === 'object' ? action.meta : {};
      // G1：素材来源由主进程资产元数据决定，AI 生成与用户上传必须区分开。
      const provider = meta.provider === 'ai-generated' ? 'ai-generated' : 'user-upload';
      const defaultNote = provider === 'ai-generated'
        ? '这张图由第三方生图服务真实生成'
        : '你上传的图片，不是模型生成结果';
      const note = typeof meta.note === 'string' && meta.note ? meta.note : defaultNote;
      return {
        ...state,
        visual: {
          ...state.visual,
          imageAssetId: assetId,
          imageMeta: {
            provider,
            note,
            width: Number.isFinite(meta.width) ? meta.width : undefined,
            height: Number.isFinite(meta.height) ? meta.height : undefined,
            ...(typeof meta.model === 'string' && meta.model ? { model: meta.model } : {}),
          },
          image: typeof action.preview === 'string' && action.preview
            ? { dataUrl: action.preview, provider, note }
            : state.visual.image,
        },
      };
    }

    case 'SET_POSTER_PREVIEW':
      // 重开项目后按已保存的 imageAssetId 回读预览；不改动资产引用本身。
      if (!state.visual.imageAssetId) return state;
      if (typeof action.dataUrl !== 'string' || !action.dataUrl) return state;
      {
        const provider = action.provider === 'ai-generated' ? 'ai-generated' : 'user-upload';
        const note = action.provider === 'ai-generated'
          ? '这张图由第三方生图服务真实生成'
          : '你上传的图片，不是模型生成结果';
        return {
          ...state,
          visual: {
            ...state.visual,
            imageMeta: state.visual.imageMeta ? { ...state.visual.imageMeta, provider } : state.visual.imageMeta,
            image: { dataUrl: action.dataUrl, provider, note },
          },
        };
      }

    case 'ADD_IMAGE_ROUND': {
      let next = appendMessages(state, state.activeSessionId, [
        { role: ROLES.USER, text: action.text, instant: true },
        { text: action.reply, staged: true },
      ]);
      return {
        ...next,
        visual: {
          ...next.visual,
          image: action.image ?? next.visual.image,
          imageRounds: [...next.visual.imageRounds, { text: action.text, reply: action.reply }],
        },
      };
    }

    case 'APPROVE_IMAGE': {
      const deployStyle = STYLE_PRESETS.find((item) => item.id === state.visual.styleId) ?? STYLE_PRESETS[0];
      // UX0a-3 / UX0b：区分「已选用上传图片」与「未添加海报素材」。
      // 只有资产已真实落盘（imageAssetId）且预览来源为 user-upload 才算已选用；
      // 单凭一段 dataUrl 不足以声称素材已选用。
      const provider = state.visual.image && state.visual.image.provider ? state.visual.image.provider : null;
      const chosen = Boolean(state.visual.imageAssetId && provider);
      const wanted = action.material === 'uploaded' || action.material === 'ai-generated';
      const material = !wanted || !chosen
        ? 'skipped'
        : (provider === 'ai-generated' ? 'ai-generated' : 'uploaded');
      const materialLine = material === 'ai-generated'
        ? '海报素材：已选用 AI 生成图片（第三方生图服务真实生成）'
        : (material === 'uploaded'
          ? '海报素材：已选用上传图片（用户提供，不是模型生成结果）'
          : '海报素材：未添加（已跳过，不影响小程序生成）');
      const entered = createStepSession(state, {
        phase: PHASES.DEPLOY,
        id: 'session-deploy',
        title: '部署小程序',
        summary: [
          `店铺名称：${state.store.name || NEW_PROJECT_LABEL}`,
          `装修风格：${deployStyle.name}`,
          `视觉偏好已记录，共 ${state.visual.promptRounds.length + 1} 次`,
          materialLine,
        ],
        payload: { styleId: state.visual.styleId, prompt: state.visual.prompt, material },
        fields: [
          { label: '店铺名', value: state.store.name || NEW_PROJECT_LABEL },
          { label: '装修风格', value: deployStyle.name, note: deployStyle.caption },
        ],
      });
      return {
        ...entered,
        // 跳过海报就明确解除引用：导出不会偷偷带上用户没选用的图片。
        visual: material === 'skipped'
          ? { ...entered.visual, image: null, imageAssetId: null, imageMeta: null }
          : entered.visual,
        deploy: createInitialDeploySlice(),
      };
    }

    case 'DEPLOY_START':
      return {
        ...state,
        deploy: {
          ...state.deploy,
          status: DEPLOY_STATUS.CHOOSING,
          taskId: action.taskId || null,
          directory: action.directory || state.deploy.directory,
          projectName: action.projectName || state.deploy.projectName,
          stageMessage: '等待选择导出位置',
          error: null,
          result: null,
          busy: false,
        },
      };

    case 'DEPLOY_DIRECTORY_CHOSEN':
      return {
        ...state,
        deploy: {
          ...state.deploy,
          status: DEPLOY_STATUS.VALIDATING,
          directory: action.directory || state.deploy.directory,
          projectName: action.projectName || state.deploy.projectName,
          step: 0,
          progress: 0,
          stageMessage: '正在校验配置',
          error: null,
          busy: true,
        },
      };

    case 'DEPLOY_STAGE': {
      const stageStep = {
        validate: 0,
        registry: 0,
        resolve: 0,
        lock: 0,
        preflight: 0,
        emit: 1,
        verify: 2,
        commit: 1,
        report: 2,
      }[action.stage];
      const step = stageStep === undefined ? state.deploy.step : stageStep;
      const status = step === 0
        ? DEPLOY_STATUS.VALIDATING
        : (step === 1 ? DEPLOY_STATUS.GENERATING : DEPLOY_STATUS.VERIFYING);
      return {
        ...state,
        deploy: {
          ...state.deploy,
          status,
          stage: action.stage || state.deploy.stage,
          step,
          progress: action.progress === undefined ? Math.round((step / 4) * 100) : action.progress,
          stageMessage: action.message || state.deploy.stageMessage,
          busy: true,
        },
      };
    }

    case 'DEPLOY_SUCCESS':
      return {
        ...state,
        deploy: {
          ...state.deploy,
          status: DEPLOY_STATUS.DONE,
          step: 4,
          progress: 100,
          result: action.result || null,
          resultDigest: (action.result && action.result.lockDigest) || state.deploy.resultDigest || null,
          previewOnly: action.previewOnly || [],
          versionGaps: action.versionGaps || [],
          warnings: action.warnings || [],
          error: null,
          stageMessage: '工程已生成',
          busy: false,
          preflight: createEmptyPreflight(),
          handoff: null,
        },
      };

    case 'DEPLOY_FORGET_DIRECTORY':
      // P5c：记住的目录已不可用，回到「使用默认位置」的状态。
      return {
        ...state,
        deploy: {
          ...state.deploy,
          directory: '',
          resultDigest: null,
        },
      };

    case 'DEPLOY_FAILURE':
      return {
        ...state,
        deploy: {
          ...state.deploy,
          status: DEPLOY_STATUS.FAILED,
          error: action.error || { code: 'COMPOSE_FAILED', message: '导出失败，请重试。' },
          // P5c：位置不可用（老路径不存在、不可写、未确认）时忘掉这个目录，
          // 下次点「导出到默认位置」就走当前可用的默认位置，而不是反复撞同一个坏路径。
          directory: forgetDirectoryOnFailure(state.deploy, action.error) ? '' : state.deploy.directory,
          busy: false,
        },
      };

    case 'DEPLOY_CONFLICT':
      return {
        ...state,
        deploy: {
          ...state.deploy,
          status: DEPLOY_STATUS.CONFLICT,
          error: action.error || { code: 'TARGET_EXISTS', message: '同名目录已存在，请换一个项目名。' },
          busy: false,
        },
      };

    case 'DEPLOY_CANCELLED':
      return {
        ...state,
        deploy: {
          ...state.deploy,
          status: DEPLOY_STATUS.CANCELLED,
          step: 0,
          progress: 0,
          error: null,
          stageMessage: '已取消，没有生成任何文件',
          busy: false,
        },
      };

    case 'DEPLOY_RESET':
      return {
        ...state,
        deploy: {
          ...createInitialDeploySlice(),
          directory: state.deploy.directory,
          projectName: state.deploy.projectName,
          resultDigest: state.deploy.resultDigest,
        },
      };

    case 'IMPORT_PREVIEW_START':
      return {
        ...state,
        deploy: {
          ...state.deploy,
          import: { status: 'checking', preview: null, confirmations: [], busy: true, error: null, result: null },
        },
      };

    case 'IMPORT_PREVIEW_SUCCESS':
      return {
        ...state,
        deploy: {
          ...state.deploy,
          import: {
            status: 'reviewing',
            preview: action.preview || null,
            confirmations: [],
            busy: false,
            error: null,
            result: null,
          },
        },
      };

    case 'IMPORT_PREVIEW_FAILURE':
      return {
        ...state,
        deploy: {
          ...state.deploy,
          import: {
            ...state.deploy.import,
            status: action.status === 'auth-unavailable' ? 'auth-unavailable' : 'failed',
            busy: false,
            error: action.error || { code: 'IMPORT_FAILED', message: '检查差异失败。' },
          },
        },
      };

    case 'IMPORT_CONFIRM_TOGGLE': {
      const key = String(action.key || '');
      if (!key) return state;
      const current = new Set(state.deploy.import.confirmations || []);
      if (current.has(key)) current.delete(key); else current.add(key);
      return {
        ...state,
        deploy: {
          ...state.deploy,
          import: { ...state.deploy.import, confirmations: [...current].sort() },
        },
      };
    }

    case 'IMPORT_APPLY_START':
      return {
        ...state,
        deploy: {
          ...state.deploy,
          import: { ...state.deploy.import, status: 'applying', busy: true, error: null },
        },
      };

    case 'IMPORT_SUCCESS':
      return {
        ...state,
        deploy: {
          ...state.deploy,
          import: {
            ...state.deploy.import,
            status: 'done',
            busy: false,
            result: action.result || null,
            error: null,
          },
        },
      };

    case 'IMPORT_FAILURE':
      return {
        ...state,
        deploy: {
          ...state.deploy,
          import: {
            ...state.deploy.import,
            status: action.status === 'auth-unavailable' ? 'auth-unavailable' : 'failed',
            busy: false,
            error: action.error || { code: 'IMPORT_FAILED', message: '导入失败，请重试。' },
          },
        },
      };

    case 'IMPORT_RESET':
      return {
        ...state,
        deploy: {
          ...state.deploy,
          import: { status: 'idle', preview: null, confirmations: [], busy: false, error: null, result: null },
        },
      };

    case 'DEPLOY_PROGRESS':
      return { ...state, deploy: { ...state.deploy, status: 'running', step: action.step, progress: action.progress } };

    case 'DEPLOY_DONE':
      return { ...state, deploy: { ...state.deploy, status: 'done', step: 4, progress: 100 } };

    case 'SWITCH_SESSION': {
      if (action.id === state.activeSessionId) return state;
      if (!state.sessions.some((session) => session.id === action.id)) return state;
      return {
        ...state,
        activeSessionId: action.id,
        sessions: markSessionSettled(state.sessions, state.activeSessionId),
      };
    }

    default:
      return state;
  }
}

const UNDOABLE_ACTIONS = new Set([
  'SUBMIT_NAME',
  'TOGGLE_FEATURE',
  'SET_FEATURES_CUSTOM',

  'SET_STORE_FIELD',
  'SET_STYLE',
  'EDIT_AGENT_DRAFT_FIELD',
  'EDIT_AGENT_FULFILLMENT',
  'EDIT_AGENT_DISH',
  'ADD_AGENT_DISH',
  'REMOVE_AGENT_DISH',
  'CONFIRM_AGENT_DRAFT',
  'REOPEN_AGENT_DRAFT',
  'SET_PROMPT',
  'CONFIRM_PROMPT',
  'APPROVE_IMAGE',
  'PROJECT_SET_APPID',
  // C-SESSION-PRESENTATION@1：只有成功的展示修改可撤销；请求/失败/清错不压栈。
  'TEMPLATE_REVISE_SUCCESS',
]);

const UNDO_RESET_ACTIONS = new Set(['RESET', 'RESET_PROJECT', 'PROJECT_OPEN_SUCCESS', 'PROJECT_NEW_SUCCESS', 'PROJECT_DELETE_SUCCESS']);
const UNDO_DEPTH = 20;

function cloneJson(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    return value;
  }
}

/** 撤销快照只包含业务切片；phase/view/会话/deploy 不回退。 */
function undoSnapshot(state) {
  const visual = state.visual || {};
  return {
    store: cloneJson(state.store || {}),
    features: cloneJson(state.features || {}),
    build: { selectedId: state.build ? state.build.selectedId : null },
    visual: {
      styleId: visual.styleId,
      prompt: visual.prompt,
      promptRounds: cloneJson(visual.promptRounds || []),
      imageAssetId: visual.imageAssetId ?? null,
      imageMeta: cloneJson(visual.imageMeta ?? null),
      imageRounds: cloneJson(visual.imageRounds || []),
    },
    agentDraft: cloneJson(state.agentDraft || {}),
    // 展示切片必须进快照，否则展示修改无法撤销/重做。
    presentation: cloneJson(state.presentation || createInitialPresentationSlice()),
    appid: (state.project && state.project.appid) || '',
  };
}

/**
 * 撤销快照里的展示切片：撤销要回到「上一版已接受的展示」，而不是停在请求态。
 *
 * `TEMPLATE_REVISE_SUCCESS` 压栈时，当前 state 的 `presentation` 还带着
 * `status='revising'`；若不处理，撤销后会卡在「修改中」。这里只改状态位，
 * 补丁与变更仍是上一版（本动作尚未写入）。
 *
 * @param {object} snapshot undoSnapshot() 的结果
 * @returns {object} 修正后的快照
 */
function withPresentationUndoView(snapshot) {
  const presentation = snapshot.presentation;
  if (!presentation) return snapshot;
  return {
    ...snapshot,
    presentation: { ...presentation, status: 'idle', error: null },
  };
}

/**
 * 从撤销快照恢复展示切片，并保证补丁与当前模板不错配。
 *
 * 快照同时保存了 `build.selectedId` 与 `presentation.templateId`；
 * 若两者不一致（例如切模板后又撤销），以 `build.selectedId` 为准丢弃旧补丁，
 * 避免出现「补丁属于 A 模板、当前模板却是 B」。
 *
 * @param {object} snapshot 撤销快照
 * @param {object} state 当前状态（用于兜底）
 * @returns {object} 恢复后的 presentation 切片
 */
function restorePresentation(snapshot, state) {
  const fallback = state.presentation ?? createInitialPresentationSlice();
  const source = snapshot.presentation;
  if (!source) return fallback;
  const restored = cloneJson(source);
  const selectedId = snapshot.build ? snapshot.build.selectedId : (state.build?.selectedId ?? null);
  if (selectedId && restored.templateId && restored.templateId !== selectedId) {
    return { ...createInitialPresentationSlice(), templateId: selectedId };
  }
  return restored;
}

/**
 * reducer 包装：在语义动作前压快照，支持撤销/重做。
 * 合并策略：同一动作名 + 同一字段连续触发只压第一次，避免每次按键都占一格。
 * 栈不持久化（重启清空）。
 */
/**
 * P5c：导出失败时，哪些错误码说明「这个目录本身已经不能用了」。
 *
 * 命中时清空记住的目录，让下一次「导出到默认位置」使用当前可用的默认位置；
 * 同名冲突（TARGET_EXISTS）不在其中——用户可能就想换项目名重试同一目录。
 */
const DIRECTORY_FORGOTTEN_CODES = new Set([
  'TARGET_PARENT_MISSING',
  'TARGET_NOT_WRITABLE',
  'TARGET_CHECK_FAILED',
  'TARGET_PATH_INVALID',
  'TARGET_CHECK_TIMEOUT',
]);

function forgetDirectoryOnFailure(deploy, error) {
  if (!deploy || !deploy.directory) return false;
  const code = error && error.code;
  return DIRECTORY_FORGOTTEN_CODES.has(code);
}

export function reducer(state, action) {
  // 晚响应必须连 undo 元数据也不触碰，严格保持原 state 引用。
  if ((action.type === 'AGENT_TURN_SUCCESS' || action.type === 'AGENT_TURN_FAILURE')
    && !isCurrentAgentTurnCompletion(state, action)) {
    return state;
  }
  // 展示修改的晚响应同样整包忽略：不写补丁/changes，也不产生撤销历史。
  if ((action.type === 'TEMPLATE_REVISE_SUCCESS' || action.type === 'TEMPLATE_REVISE_FAILURE')
    && !isCurrentPresentationCompletion(state, action)) {
    return state;
  }
  // 侧栏会话的迟到响应同理：四元组不匹配就整包忽略（切换/重置/删除项目后的旧回调）。
  if ((action.type === 'AGENT_CHAT_SUCCESS' || action.type === 'AGENT_CHAT_FAILURE')
    && !isCurrentAgentChatCompletion(state, action)) {
    return state;
  }
  const undo = state.undo || { past: [], future: [], lastKey: null };

  if (action.type === 'UNDO_APPLY' || action.type === 'REDO_APPLY') {
    const isUndo = action.type === 'UNDO_APPLY';
    const source = isUndo ? undo.past : undo.future;
    if (!Array.isArray(source) || source.length === 0) return state;
    const snapshot = source[source.length - 1];
    const rest = source.slice(0, -1);
    const redoOrUndo = isUndo
      ? [...undo.future, undoSnapshot(state)].slice(-UNDO_DEPTH)
      : [...undo.past, undoSnapshot(state)].slice(-UNDO_DEPTH);
    const nextUndo = isUndo
      ? { past: rest, future: redoOrUndo, lastKey: null }
      : { past: redoOrUndo, future: rest, lastKey: null };
    return baseReducer({ ...state, undo: nextUndo }, { type: action.type, snapshot });
  }

  if (UNDO_RESET_ACTIONS.has(action.type)) {
    const next = baseReducer(state, action);
    return { ...next, undo: { past: [], future: [], lastKey: null } };
  }

  if (UNDOABLE_ACTIONS.has(action.type)) {
    // 合并键：同一动作 + 同一字段连续触发只占一格。
    // TEMPLATE_REVISE_SUCCESS 没有 field/id，用 requestId 区分，保证多轮修改各自可撤销。
    const key = `${action.type}:${action.field || action.id || action.requestId || ''}`;
    const rawSnapshot = undoSnapshot(state);
    // 成功的展示修改：撤销要回到「上一版已接受展示」，而不是停留在 revising 请求态。
    const snapshot = action.type === 'TEMPLATE_REVISE_SUCCESS'
      ? withPresentationUndoView(rawSnapshot)
      : rawSnapshot;
    const next = baseReducer(state, action);
    // 展示补丁未通过兜底校验时进入失败态，失败不压栈。
    if (action.type === 'TEMPLATE_REVISE_SUCCESS' && next.presentation?.status === 'failed') {
      return next;
    }
    // 被 reducer 拒绝的动作（例如锁定 required 功能）不应产生历史记录。
    const changed = JSON.stringify(undoSnapshot(next)) !== JSON.stringify(snapshot);
    if (!changed) return next;
    let past = undo.past;
    if (undo.lastKey !== key) {
      past = [...past, snapshot].slice(-UNDO_DEPTH);
    }
    return { ...next, undo: { past, future: [], lastKey: key } };
  }

  const next = baseReducer(state, action);
  if (undo.lastKey !== null) {
    return { ...next, undo: { ...undo, lastKey: null } };
  }
  return next;
}

export function selectUndoState(state) {
  const undo = state.undo || { past: [], future: [] };
  return {
    canUndo: Array.isArray(undo.past) && undo.past.length > 0,
    canRedo: Array.isArray(undo.future) && undo.future.length > 0,
    undoCount: Array.isArray(undo.past) ? undo.past.length : 0,
    redoCount: Array.isArray(undo.future) ? undo.future.length : 0,
  };
}

export function selectActiveSession(state) {
  return state.sessions.find((session) => session.id === state.activeSessionId) ?? state.sessions[0];
}

/**
 * `C-SESSION-PRESENTATION@1` 选择器（plan.md 2.2.3）。
 *
 * 只暴露渲染层需要的字段：`requestId`/`templateId` 仍然不外泄；
 * B3 起额外暴露 `lastUtterance`，让修改面板把「你刚才要求：原话」显示在输入框旁边。
 *
 * @param {object} state 会话状态
 * @returns {{canRevise: boolean, patch: object, changes: Array, status: 'idle'|'revising'|'failed',
 *   error: {code: string, message: string}|null}}
 */
export function selectPresentationState(state) {
  const presentation = state?.presentation ?? createInitialPresentationSlice();
  return {
    canRevise: state?.phase === PHASES.TEMPLATE_PICK && state?.build?.status === 'ready',
    patch: presentation.patch ?? {},
    changes: Array.isArray(presentation.changes) ? presentation.changes : [],
    status: presentation.status ?? 'idle',
    error: presentation.error ?? null,
    lastUtterance: typeof presentation.lastUtterance === 'string' ? presentation.lastUtterance : '',
    hasPatch: Object.keys(presentation.patch ?? {}).length > 0,
  };
}

export function selectSelectedFeatures(state) {
  return [...new Set([...REQUIRED_FEATURE_IDS, ...state.features.selected])];
}
export function selectAgentComposerState(state) {
  const fallback = {
    visible: false,
    placeholder: '',
    submitLabel: '',
    hint: '',
    submitDisabled: false,
    editable: false,
  };
  if (!state || state.phase !== PHASES.STORE_INFO || !state.agent) return fallback;
  if (state.agent.status === AGENT_STATUS.CONFIRMED) return fallback;
  return {
    visible: true,
    placeholder: COMPOSER_PLACEHOLDER[PHASES.STORE_INFO],
    submitLabel: COMPOSER_SUBMIT_LABEL[PHASES.STORE_INFO],
    hint: AGENT_STORE_INFO_HINT,
    submitDisabled: state.agent.status === AGENT_STATUS.REQUESTING,
    editable: true,
  };
}

/**
 * 侧栏「Agent 对话」的视图模型（供 App 计算 props、T3 渲染复用）。
 *
 * 只暴露渲染需要的字段；`activeRequestId` 与 `requestDraftRevision` 不外泄。
 * 阶段路由、能否发送、能否重试都来自 `domain/agentSidebar.mjs`，不在这里另写一套判断。
 *
 * @param {object} state 会话状态
 * @returns {{projectId: string|null, phase: string|null, messages: Array, draft: string,
 *   status: string, busy: boolean, lastUtterance: string, lastError: object|null,
 *   lastRun: object|null, plan: object, canSend: boolean, canRetry: boolean}}
 */
export function selectAgentChatState(state) {
  const chat = state?.agentChat ?? createEmptyAgentChat();
  const projectId = typeof state?.project?.activeId === 'string' && state.project.activeId
    ? state.project.activeId
    : null;
  const phase = typeof state?.phase === 'string' ? state.phase : null;
  const status = typeof chat.status === 'string' ? chat.status : CHAT_STATUS.IDLE;
  const plan = buildAgentChatSubmitPlan({ projectId, phase, hasProject: Boolean(projectId) });
  return {
    projectId,
    phase,
    messages: normalizeChatMessages(chat.messages),
    draft: typeof chat.draft === 'string' ? chat.draft : '',
    status,
    busy: status === CHAT_STATUS.REQUESTING,
    lastUtterance: typeof chat.lastUtterance === 'string' ? chat.lastUtterance : '',
    lastError: chat.lastError ?? null,
    lastRun: chat.lastRun ?? null,
    plan,
    canSend: plan.allowed && status !== CHAT_STATUS.REQUESTING && isValidChatDraft(chat.draft),
    canRetry: status === CHAT_STATUS.FAILED && isValidChatDraft(chat.lastUtterance, { maxChars: CHAT_MESSAGE_MAX_CHARS }),
  };
}

const HANDOFF_STEP_ORDER = Object.freeze(['prepare', 'import', 'appid', 'domain', 'preview', 'next']);

function formatClock(iso) {
  if (typeof iso !== 'string' || !iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

export function selectVisibleProjects(state) {
  const project = state.project || {};
  const list = Array.isArray(project.list) ? project.list : [];
  const query = String(project.search || '').trim().toLowerCase();
  if (!query) return list;
  return list.filter((item) => {
    const meta = PHASE_META[item.phase] || {};
    return String(item.name || '').toLowerCase().includes(query)
      || String(meta.label || '').toLowerCase().includes(query)
      || String(meta.caption || '').toLowerCase().includes(query);
  });
}

export function selectWorkbenchState(state) {
  const project = state.project || {};
  if (project.deleteTarget) return 'deleting';
  if (project.status === 'loading') return 'loading';
  if (project.status === 'error') return 'error';
  if (project.status === 'idle') return 'idle';
  if ((project.list || []).length === 0) return 'empty';
  if (selectVisibleProjects(state).length === 0 && String(project.search || '').trim()) return 'search-empty';
  return 'list';
}

export function selectSaveLabel(state) {
  const project = state.project || {};
  if (project.saveError) return { tone: 'error', text: '保存失败 · 点击重试' };
  if (project.saving) return { tone: 'saving', text: '保存中…' };
  if (project.dirty) return { tone: 'dirty', text: '有未保存更改' };
  if (project.lastSavedAt) return { tone: 'saved', text: `已保存 ${formatClock(project.lastSavedAt)}` };
  return { tone: 'saved', text: '尚未保存' };
}

/**
 * 是否允许导出。
 *
 * B4 规则 6：体检结果绑定导出签名。调用方把「当前 Plan + 素材 + 目标位置」的签名传进来，
 * 与落库的签名不一致时，旧的「可以导出」立即失效。
 *
 * @param {object} state
 * @param {string|null} [currentSignature] 当前导出签名（`buildSignatureParts().signature`）
 */
export function selectCanExport(state, currentSignature = null) {
  const preflight = (state.deploy && state.deploy.preflight) || { status: 'idle', errors: [], warns: [], acknowledged: [] };
  if ((state.project || {}).mode === 'browser') {
    return { can: false, reason: '浏览器预览不能写出工程，请在桌面应用中导出' };
  }
  if (preflight.status === 'checking') return { can: false, reason: '正在体检，请稍候' };
  if (preflight.status === 'failed') return { can: false, reason: '体检未完成，请重试' };
  if (preflight.status !== 'done') return { can: false, reason: '请先完成导出前体检' };
  const stale = isPreflightStale(preflight, currentSignature);
  if (stale) return { can: false, stale: true, reason: '资料或导出位置已变化，请重新体检后再导出' };
  if ((preflight.errors || []).length > 0) {
    return { can: false, reason: `有 ${preflight.errors.length} 项需要先修正` };
  }
  const acknowledged = new Set(preflight.acknowledged || []);
  // B4 规则 8：只有「需要确认后果」的提示才阻断导出；纯披露类（缺 AppID、自带能力说明）不拦。
  const unacked = (preflight.warns || []).filter((warn) => warn
    && warn.requiresAck !== false
    && !acknowledged.has(warn.ruleId));
  if (unacked.length > 0) return { can: false, reason: `还有 ${unacked.length} 项提示需要确认` };
  return { can: true, reason: '可以导出' };
}

/** 落库签名与当前签名是否不一致（任一为空时按「无绑定」处理，不误判为过期）。 */
function isPreflightStale(preflight, currentSignature) {
  if (!currentSignature) return false;
  const stored = preflight && preflight.signature;
  const storedText = stored && typeof stored === 'object' ? stored.signature : stored;
  if (!storedText) return false;
  return storedText !== currentSignature;
}

/**
 * 是否允许“选择/更换导出位置”。
 *
 * 与 selectCanExport 的区别：目标同名冲突时不允许直接导出，但必须允许用户换目录，
 * 否则唯一解冲突的入口会被门禁锁死。其他 error 或未确认 warn 仍然阻断。
 */
export function selectCanChooseDirectory(state, currentSignature = null) {
  const preflight = (state.deploy && state.deploy.preflight) || { status: 'idle', errors: [], warns: [], acknowledged: [] };
  if ((state.project || {}).mode === 'browser') {
    return { can: false, reason: '浏览器预览不能写出工程，请在桌面应用中导出' };
  }
  if (preflight.status === 'checking') return { can: false, reason: '正在体检，请稍候' };
  if (preflight.status === 'failed') return { can: false, reason: '体检未完成，请重试' };
  if (preflight.status !== 'done') return { can: false, reason: '请先完成导出前体检' };
  if (isPreflightStale(preflight, currentSignature)) {
    return { can: false, stale: true, reason: '资料或导出位置已变化，请重新体检后再导出' };
  }

  const errors = preflight.errors || [];
  const otherErrors = errors.filter((item) => item && item.ruleId !== 'E-TARGET-EXISTS');
  if (otherErrors.length > 0) {
    return { can: false, reason: `有 ${otherErrors.length} 项需要先修正` };
  }
  const acknowledged = new Set(preflight.acknowledged || []);
  const unacked = (preflight.warns || []).filter((warn) => warn
    && warn.requiresAck !== false
    && !acknowledged.has(warn.ruleId));
  if (unacked.length > 0) return { can: false, reason: `还有 ${unacked.length} 项提示需要确认` };

  const hasConflict = errors.some((item) => item && item.ruleId === 'E-TARGET-EXISTS');
  return {
    can: true,
    reason: hasConflict ? '可更换导出位置以解除同名冲突' : '可以导出',
  };
}

/**
 * 项目是否已经有实质内容。
 * 只看业务数据，不用 activeId 或消息条数代理：刚创建、刚打开的空项目不算有内容。
 */
export function hasProjectContent(state) {
  if (!state) return false;
  const store = state.store || {};
  if (typeof store.name === 'string' && store.name.trim()) return true;
  if (typeof store.notes === 'string' && store.notes.trim()) return true;
  if (typeof store.address === 'string' && store.address.trim()) return true;
  if (typeof store.phone === 'string' && store.phone.trim()) return true;
  if (store.logoAssetId) return true;
  if (Array.isArray(store.imageAssetIds) && store.imageAssetIds.length > 0) return true;

  const build = state.build || {};
  if (build.selectedId) return true;

  const visual = state.visual || {};
  if (typeof visual.prompt === 'string' && visual.prompt.trim()) return true;
  if (visual.image) return true;
  if (visual.imageAssetId) return true;
  if (Array.isArray(visual.promptRounds) && visual.promptRounds.length > 0) return true;
  if (Array.isArray(visual.imageRounds) && visual.imageRounds.length > 0) return true;

  const draft = state.agentDraft || {};
  if (typeof draft.storeName === 'string' && draft.storeName.trim()) return true;
  if (typeof draft.category === 'string' && draft.category.trim()) return true;
  if (typeof draft.businessHours === 'string' && draft.businessHours.trim()) return true;
  if (Array.isArray(draft.dishes) && draft.dishes.length > 0) return true;
  const fulfillment = draft.fulfillment || {};
  if (fulfillment.dineIn || fulfillment.takeaway) return true;

  const deploy = state.deploy || {};
  if (deploy.result) return true;
  if (deploy.directory) return true;
  if (deploy.status && deploy.status !== DEPLOY_STATUS.IDLE) return true;

  return false;
}

/**
 * “轻启”入口的下一步：
 * - 没有活动项目：直接进入命名引导。
 * - 有活动项目但没有实质内容：直接进入命名引导并复用该空项目，不弹确认、不新建。
 * - 已有内容：必须先确认并新建项目，不能直接把当前 phase 改回引导，
 *   否则会把正在部署/装修的项目拉回功能选择页。
 */
export function selectOnboardingStart(state) {
  const project = state && state.project ? state.project : {};
  if (!project.activeId) return 'start';
  return hasProjectContent(state) ? 'confirm-create' : 'start';
}

export function selectDiagnosticsSummary(state) {
  const diagnostics = (state.settings && state.settings.diagnostics) || { status: 'idle', lines: [] };
  const lines = Array.isArray(diagnostics.lines) ? diagnostics.lines : [];
  const passed = lines.filter((line) => line.result === 'pass').length;
  const failed = lines.filter((line) => line.result === 'fail').length;
  const warned = lines.filter((line) => line.result === 'warn').length;
  let headline = '尚未自检';
  if (diagnostics.status === 'running') headline = '正在自检…';
  else if (diagnostics.status === 'failed') headline = '自检未完成';
  else if (diagnostics.status === 'done') {
    if (failed > 0) headline = `有 ${failed} 项未通过`;
    else if (warned > 0) headline = `通过，有 ${warned} 项提醒`;
    else headline = '全部通过';
  }
  return { status: diagnostics.status, passed, failed, warned, checkedAt: diagnostics.checkedAt, headline };
}

export function selectHandoffProgress(state) {
  const handoff = state.deploy && state.deploy.handoff;
  const total = HANDOFF_STEP_ORDER.length;
  if (!handoff) return { currentIndex: 0, total, completedCount: 0, canContinue: true, blockingReason: '' };
  const index = HANDOFF_STEP_ORDER.indexOf(handoff.stepId);
  const canContinue = state.deploy.status === DEPLOY_STATUS.DONE;
  return {
    currentIndex: index === -1 ? 0 : index,
    total,
    completedCount: (handoff.completedStepIds || []).length,
    canContinue,
    blockingReason: canContinue ? '' : '重新导出后可继续交接',
  };
}

export function selectHydrationSource(state) {
  const project = state.project || {};
  if (!project.activeId) return 'none';
  return project.mode === 'browser' ? 'browser' : 'desktop';
}
