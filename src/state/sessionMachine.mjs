import {
  PHASES,
  ROLES,
  SESSION_KIND,
  NEW_PROJECT_LABEL,
  AGENT_STATUS,
  AGENT_STORE_INFO_HINT,
  COMPOSER_PLACEHOLDER,
  COMPOSER_SUBMIT_LABEL,
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
  INTRO_SCRIPT,
  FEATURE_INTRO,
  BUILDING_INTRO,
  TEMPLATE_INTRO,
  STORE_INTRO,
  PROMPT_INTRO,
  REVIEW_INTRO,
  DEPLOY_INTRO,
  NAMING_GUIDANCE,
} from '../domain/onboardingScript.mjs';
import { buildHandoff } from '../domain/handoff.mjs';
import { STORE_TYPES, STYLE_PRESETS } from '../domain/storeBrief.mjs';

const REQUIRED_FEATURE_IDS = catalogFeatures.filter((feature) => feature.required).map((feature) => feature.id);
const MAX_DISHES = 5;

function createInitialAgentSlice() {
  return {
    status: AGENT_STATUS.IDLE,
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

export function createInitialState() {
  const mainSession = {
    id: 'session-main',
    title: NEW_PROJECT_LABEL,
    kind: SESSION_KIND.MAIN,
    status: 'active',
    messages: [],
    handoff: null,
    revealFlush: 0,
  };
  return {
    seq: 0,
    phase: PHASES.HOME,
    activeSessionId: mainSession.id,
    sessions: [mainSession],
    store: { name: '', type: STORE_TYPES[0], notes: '', address: '', phone: '' },
    features: { selected: [...REQUIRED_FEATURE_IDS], custom: '' },
    build: { status: 'idle', candidates: [], selectedId: null },
    visual: { styleId: STYLE_PRESETS[0].id, promptRounds: [], imageRounds: [], image: null, prompt: '' },
    deploy: { status: 'idle', step: 0, progress: 0 },
    agentDraft: createEmptyAgentDraft(),
    agent: createInitialAgentSlice(),
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

function appendMessagesWithSeq(state, sessionId, handoffText, drafts) {
  const nextSeq = state.seq + 1;
  const session = state.sessions.find((item) => item.id === sessionId);
  if (!session) return state;
  const handoffMessage = { id: `m${nextSeq}`, role: ROLES.SYSTEM, text: handoffText, staged: false, delay: 0, instant: true, meta: { kind: 'handoff' } };
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

function createStepSession(state, { id, title, summary, payload, phase, intro, followUp }) {
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
  };
  const opening = intro ?? (title === '店铺装修' ? STORE_INTRO : DEPLOY_INTRO);
  const after = followUp ?? (
    title === '店铺装修'
      ? '选好风格后，我们会一起打磨生图提示词。'
      : title === '部署小程序'
        ? '这是演示环境，不含真实发布。'
        : ''
  );
  const base = { ...state, phase, sessions: [...markAllDone(state.sessions.filter((item) => item.id !== id)), session], activeSessionId: id };
  return appendMessagesWithSeq({ ...base, sessions: base.sessions.map((item) => item.id === id ? { ...item, messages: [] } : item) }, id, handoff, [
    { text: opening, staged: true },
    ...(after ? [{ text: after, staged: false, instant: true, meta: { kind: 'muted' } }] : []),
  ]);
}

function enterFeatures(state) {
  const next = appendMessages(state, state.activeSessionId, [{ text: FEATURE_INTRO, staged: true, meta: { kind: 'feature-intro' } }]);
  return { ...next, phase: PHASES.FEATURES };
}

export function reducer(state, action) {
  switch (action.type) {
    case 'RESET':
      return createInitialState();

    case 'START_ONBOARDING': {
      if (state.phase !== PHASES.HOME) return { ...state, phase: PHASES.ONBOARDING };
      const next = appendMessages(state, state.activeSessionId, [{ text: NAMING_GUIDANCE.title, meta: { kind: 'naming' } }]);
      return { ...next, phase: PHASES.ONBOARDING };
    }

    case 'SUBMIT_NAME': {
      const name = String(action.name || '').trim().slice(0, 48);
      if (!name) return state;
      let next = appendMessages(state, state.activeSessionId, [{ role: ROLES.USER, text: name, instant: true }]);
      next = appendMessages(next, state.activeSessionId, INTRO_SCRIPT.map((text) => ({ text, staged: true })));
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
      return enterFeatures(flushed);
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
      return { ...next, phase: PHASES.BUILDING, build: { ...next.build, status: 'building', candidates: [] } };
    }

    case 'BUILD_READY': {
      const candidates = action.candidates || [];
      let next = appendMessages(state, state.activeSessionId, [{ text: TEMPLATE_INTRO, staged: true, meta: { kind: 'template-pick' } }]);
      return { ...next, phase: PHASES.TEMPLATE_PICK, build: { status: 'ready', candidates, selectedId: candidates[0]?.id ?? null } };
    }

    case 'SELECT_TEMPLATE':
      return { ...state, build: { ...state.build, selectedId: action.id } };

    case 'CONFIRM_TEMPLATE': {
      const chosen = state.build.candidates.find((item) => item.id === state.build.selectedId) ?? state.build.candidates[0];
      const entered = createStepSession(state, {
        phase: PHASES.STORE_INFO,
        id: 'session-store',
        title: '店铺装修',
        summary: [
          `店铺名称：${state.store.name || NEW_PROJECT_LABEL}`,
          `页面骨架：${chosen?.name ?? '默认骨架'}`,
          `功能能力：共 ${state.features.selected.length} 项`,
          state.features.custom ? `定制要求：${state.features.custom}` : '未提出额外定制要求',
        ],
        payload: { template: chosen?.id ?? null, features: state.features.selected, custom: state.features.custom || null },
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

    case 'AGENT_TURN_REQUEST': {
      const utterance = String(action.utterance ?? '').trim();
      if (!utterance) return state;
      if (state.agent.status === AGENT_STATUS.REQUESTING) return state;
      const withMessage = appendMessages(state, state.activeSessionId, [{
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
          lastUtterance: utterance,
          lastError: null,
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
          lastError: null,
        },
      };
    }

    case 'AGENT_TURN_SUCCESS': {
      if (state.agent.status !== AGENT_STATUS.REQUESTING) return state;
      const draft = normalizeAgentDraft(action.draft);
      const validation = validateAgentDraft(draft);
      const reply = String(action.reply ?? '').trim();
      const withMessage = reply
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
          status: validation.readyForReview ? AGENT_STATUS.REVIEWING : AGENT_STATUS.COLLECTING,
          missingFields: validation.missingFields,
          errors: validation.errors,
          nextQuestion: buildNextQuestion(validation),
          reply,
          meta: action.meta ?? null,
          turnId: action.turnId ?? null,
          lastError: null,
          simulateFailure: false,
        },
      };
    }

    case 'AGENT_TURN_FAILURE': {
      if (state.agent.status !== AGENT_STATUS.REQUESTING) return state;
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
          lastError,
          simulateFailure: false,
        },
      };
    }

    case 'AGENT_SIMULATE_FAILURE':
      return {
        ...state,
        agent: { ...state.agent, simulateFailure: Boolean(action.value) },
      };

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

    case 'SET_STYLE':
      return { ...state, visual: { ...state.visual, styleId: action.id } };

    case 'SUBMIT_STORE_INFO': {
      if (state.agent.status !== AGENT_STATUS.IDLE && state.agent.status !== AGENT_STATUS.CONFIRMED) {
        return state;
      }
      const style = STYLE_PRESETS.find((item) => item.id === (action.styleId ?? state.visual.styleId)) ?? STYLE_PRESETS[0];
      const withConfirmation = appendMessages(state, state.activeSessionId, [{ role: ROLES.USER, text: action.summary, instant: true }]);
      const base = { ...withConfirmation, visual: { ...withConfirmation.visual, styleId: style.id } };
      return createStepSession(base, {
        phase: PHASES.PROMPT_STUDIO,
        id: 'session-visual',
        title: '视觉生成',
        intro: PROMPT_INTRO,
        followUp: '确认提示词后，我们会在同一个会话里反复生成与审核效果图。',
        summary: [
          `店铺名称：${state.store.name || NEW_PROJECT_LABEL}`,
          action.summary || '店铺资料已确认',
          `装修风格：${style.name}`,
        ],
        payload: { styleId: style.id, store: state.store, agentDraft: toContractDraft(state.agentDraft) },
      });
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
        { role: ROLES.USER, text: action.text ?? '这版提示词可以了，开始生成效果图。', instant: true },
        { text: REVIEW_INTRO, staged: true },
      ]);
      return { ...next, phase: PHASES.IMAGE_REVIEW };
    }

    case 'SET_IMAGE':
      return { ...state, visual: { ...state.visual, image: action.image } };

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

    case 'APPROVE_IMAGE':
      return createStepSession(state, {
        phase: PHASES.DEPLOY,
        id: 'session-deploy',
        title: '部署小程序',
        summary: [
          `店铺名称：${state.store.name || NEW_PROJECT_LABEL}`,
          `装修风格：${(STYLE_PRESETS.find((item) => item.id === state.visual.styleId) ?? STYLE_PRESETS[0]).name}`,
          `生图提示词已确认，共 ${state.visual.promptRounds.length + 1} 轮打磨`,
          `效果图审核已通过，共 ${state.visual.imageRounds.length} 轮修改`,
        ],
        payload: { styleId: state.visual.styleId, prompt: state.visual.prompt },
      });

    case 'DEPLOY_PROGRESS':
      return { ...state, deploy: { ...state.deploy, status: 'running', step: action.step, progress: action.progress } };

    case 'DEPLOY_DONE':
      return { ...state, deploy: { ...state.deploy, status: 'done', step: 4, progress: 100 } };

    case 'SWITCH_SESSION':
      return { ...state, activeSessionId: action.id };

    default:
      return state;
  }
}

export function selectActiveSession(state) {
  return state.sessions.find((session) => session.id === state.activeSessionId) ?? state.sessions[0];
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