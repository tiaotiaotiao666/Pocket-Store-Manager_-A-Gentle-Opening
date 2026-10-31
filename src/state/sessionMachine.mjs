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
import {
  createEmptyDeployState,
  createEmptyPreflight,
  fromDocument,
} from '../domain/projectSnapshot.mjs';

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
  };
  return {
    view: 'workbench',
    seq: 0,
    phase: PHASES.HOME,
    activeSessionId: mainSession.id,
    sessions: [mainSession],
    store: { name: '', type: STORE_TYPES[0], notes: '', address: '', phone: '', logoAssetId: null, imageAssetIds: [] },
    features: { selected: [...REQUIRED_FEATURE_IDS], custom: '' },
    build: { status: 'idle', candidates: [], selectedId: null },
    visual: { styleId: STYLE_PRESETS[0].id, promptRounds: [], imageRounds: [], image: null, prompt: '', imageAssetId: null, imageMeta: null },
    deploy: createInitialDeploySlice(),
    agentDraft: createEmptyAgentDraft(),
    agent: createInitialAgentSlice(),
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
      return {
        ...state,
        view: 'flow',
        phase: action.phase,
        activeSessionId: hasSession ? targetSession : state.activeSessionId,
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
      return { ...state, project: { ...state.project, status: 'loading', openError: null } };

    case 'PROJECT_OPEN_SUCCESS': {
      const hydrated = fromDocument(action.doc);
      return {
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

    case 'PROJECT_NEW_SUCCESS': {
      const blank = createInitialState();
      return {
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
        return {
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
        project: {
          ...state.project,
          appid: typeof snapshot.appid === 'string' ? snapshot.appid : state.project.appid,
          dirty: true,
        },
      };
    }

    case 'RESET_PROJECT': {
      const blank = createInitialState();
      return {
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
    }

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

    case 'APPROVE_IMAGE': {
      const entered = createStepSession(state, {
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
      return { ...entered, deploy: createInitialDeploySlice() };
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

    case 'DEPLOY_FAILURE':
      return {
        ...state,
        deploy: {
          ...state.deploy,
          status: DEPLOY_STATUS.FAILED,
          error: action.error || { code: 'COMPOSE_FAILED', message: '导出失败，请重试。' },
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

    case 'SWITCH_SESSION':
      return { ...state, activeSessionId: action.id };

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
    appid: (state.project && state.project.appid) || '',
  };
}

/**
 * reducer 包装：在语义动作前压快照，支持撤销/重做。
 * 合并策略：同一动作名 + 同一字段连续触发只压第一次，避免每次按键都占一格。
 * 栈不持久化（重启清空）。
 */
export function reducer(state, action) {
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
    const key = `${action.type}:${action.field || action.id || ''}`;
    const snapshot = undoSnapshot(state);
    const next = baseReducer(state, action);
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

export function selectCanExport(state) {
  const preflight = (state.deploy && state.deploy.preflight) || { status: 'idle', errors: [], warns: [], acknowledged: [] };
  if ((state.project || {}).mode === 'browser') {
    return { can: false, reason: '浏览器预览不能写出工程，请在桌面应用中导出' };
  }
  if (preflight.status === 'checking') return { can: false, reason: '正在体检，请稍候' };
  if (preflight.status === 'failed') return { can: false, reason: '体检未完成，请重试' };
  if ((preflight.errors || []).length > 0) {
    return { can: false, reason: `有 ${preflight.errors.length} 项需要先修正` };
  }
  const acknowledged = new Set(preflight.acknowledged || []);
  const unacked = (preflight.warns || []).filter((warn) => !acknowledged.has(warn.ruleId));
  if (unacked.length > 0) return { can: false, reason: `还有 ${unacked.length} 项提示需要确认` };
  if (preflight.status !== 'done') return { can: false, reason: '请先完成导出前体检' };
  return { can: true, reason: '可以导出' };
}

/**
 * 是否允许“选择/更换导出位置”。
 *
 * 与 selectCanExport 的区别：目标同名冲突时不允许直接导出，但必须允许用户换目录，
 * 否则唯一解冲突的入口会被门禁锁死。其他 error 或未确认 warn 仍然阻断。
 */
export function selectCanChooseDirectory(state) {
  const preflight = (state.deploy && state.deploy.preflight) || { status: 'idle', errors: [], warns: [], acknowledged: [] };
  if ((state.project || {}).mode === 'browser') {
    return { can: false, reason: '浏览器预览不能写出工程，请在桌面应用中导出' };
  }
  if (preflight.status === 'checking') return { can: false, reason: '正在体检，请稍候' };
  if (preflight.status === 'failed') return { can: false, reason: '体检未完成，请重试' };
  if (preflight.status !== 'done') return { can: false, reason: '请先完成导出前体检' };

  const errors = preflight.errors || [];
  const otherErrors = errors.filter((item) => item && item.ruleId !== 'E-TARGET-EXISTS');
  if (otherErrors.length > 0) {
    return { can: false, reason: `有 ${otherErrors.length} 项需要先修正` };
  }
  const acknowledged = new Set(preflight.acknowledged || []);
  const unacked = (preflight.warns || []).filter((warn) => !acknowledged.has(warn.ruleId));
  if (unacked.length > 0) return { can: false, reason: `还有 ${unacked.length} 项提示需要确认` };

  const hasConflict = errors.some((item) => item && item.ruleId === 'E-TARGET-EXISTS');
  return {
    can: true,
    reason: hasConflict ? '可更换导出位置以解除同名冲突' : '可以导出',
  };
}

/**
 * “轻启”入口的下一步：
 * - 没有活动项目：直接进入命名引导。
 * - 已有活动项目：必须先确认并新建项目，不能直接把当前 phase 改回引导，
 *   否则会把正在部署/装修的项目拉回功能选择页。
 */
export function selectOnboardingStart(state) {
  const project = state && state.project ? state.project : {};
  return project.activeId ? 'confirm-create' : 'start';
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
