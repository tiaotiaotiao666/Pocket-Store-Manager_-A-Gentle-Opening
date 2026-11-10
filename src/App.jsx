import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';

import { features as catalogFeatures } from './domain/catalog.mjs';
import { STORE_TYPES, STYLE_PRESETS } from './domain/storeBrief.mjs';
import { DEPLOY_STEPS, SKIP_HINT } from './domain/onboardingScript.mjs';
import {
  PHASES,
  PHASE_META,
  HOME_GREETING,
  COMPOSER_PLACEHOLDER,
  COMPOSER_SUBMIT_LABEL,
  DEPLOY_STATUS,
} from './state/constants.mjs';
import { buildPlanFromSession } from './composition/planFromSession.mjs';
import { buildSessionPreviewViewModels } from './composition/previewViewModel.mjs';
import {
  isDesktopExportAvailable,
  subscribeProgress,
  chooseDirectory,
  validatePlan,
  preflightTarget,
  exportProject,
  cancelExport,
  openProjectDirectory,
  describeExportError,
  DESKTOP_REQUIRED_MESSAGE,
} from './services/exportService.js';
import { buildImportPayload, previewImport, applyImport, DEFAULT_STORE_ID } from './services/importService.js';
import {
  createInitialState,
  reducer,
  selectActiveSession,
  selectAgentComposerState,
  selectVisibleProjects,
  selectWorkbenchState,
  selectSaveLabel,
  selectDiagnosticsSummary,
  selectCanExport,
  selectCanChooseDirectory,
  selectOnboardingStart,
  selectHandoffProgress,
  selectUndoState,
  selectPresentationState,
} from './state/sessionMachine.mjs';
import { formatCents } from './domain/agentDraft.mjs';
import { toDocument, fromDocument } from './domain/projectSnapshot.mjs';
import { evaluateLocal, mergeComposerResult, mergeTargetPreflight } from './domain/preflightRules.mjs';
import { createProjectService } from './services/projectService.js';
import { createProjectThumbnailLoader } from './services/projectThumbnailLoader.js';
import { createSettingsService } from './services/settingsService.js';
import { createDiagnosticsService } from './services/diagnosticsService.js';
import { createAppidService } from './services/appidService.js';
import { createDevtoolsService } from './services/devtoolsService.js';
import { requestAgentTurn, describeAgentTransport, configureAgentRuntime, getAgentTransportConfig } from './services/agentTurn/agentTurnService.js';
import {
  requestTemplateRevise,
  createReviseRequestId,
  describeTemplateReviseTransport,
} from './services/agentTurn/templateReviseService.js';
import {
  buildTemplateCandidates,
  composePrompt,
  revisePrompt,
  generateImage,
  reviseImage,
} from './services/agentService.js';

import AppShell from './components/layout/AppShell.jsx';
import ConfirmDialog from './components/common/ConfirmDialog.jsx';
import Sidebar from './components/layout/Sidebar.jsx';
import TitleBar from './components/layout/TitleBar.jsx';
import RightPanel from './components/layout/RightPanel.jsx';
import ChatStream from './components/chat/ChatStream.jsx';
import Composer from './components/chat/Composer.jsx';
import SkipNotice from './components/chat/SkipNotice.jsx';
import HomeStage from './components/flow/HomeStage.jsx';
import FeaturePicker from './components/flow/FeaturePicker.jsx';
import BuildLoading from './components/flow/BuildLoading.jsx';
import TemplateGallery from './components/flow/TemplateGallery.jsx';
import MiniProgramPreview from './components/preview/MiniProgramPreview.jsx';
import RealPreviewPanel from './components/preview/RealPreviewPanel.jsx';
import StoreInfoStep from './components/build/StoreInfoStep.jsx';
import PromptStudio from './components/build/PromptStudio.jsx';
import ImageReview from './components/build/ImageReview.jsx';
import DeployStep from './components/build/DeployStep.jsx';
import ImportDiffCard from './components/build/ImportDiffCard.jsx';
import AgentIntakePanel from './components/agent/AgentIntakePanel.jsx';
import VisionImageUploader from './components/agent/VisionImageUploader.jsx';
import DraftEditor from './components/agent/DraftEditor.jsx';
import StoreInfoActionBar from './components/agent/StoreInfoActionBar.jsx';
import AgentDraftSummary from './components/agent/AgentDraftSummary.jsx';
import ProjectWorkbench from './components/workbench/ProjectWorkbench.jsx';
import SettingsPanel from './components/settings/SettingsPanel.jsx';
import PreflightPanel from './components/deploy/PreflightPanel.jsx';
import HandoffWizard from './components/deploy/HandoffWizard.jsx';

const FEATURE_GROUPS = [...new Set(catalogFeatures.map((feature) => feature.group))];
const REQUIRED_IDS = catalogFeatures.filter((feature) => feature.required).map((feature) => feature.id);
const BUILD_STEPS = ['解析功能清单', '匹配页面骨架', '拼装门店页面', '准备预览'];
const INTRO_AUTO_ADVANCE_MS = 5200;
// 模板页也开放输入框：一句话走「对话修改当前模板」，与「重新描述候选」是两个入口。
const COMPOSER_PHASES = [PHASES.ONBOARDING, PHASES.STORE_INFO, PHASES.TEMPLATE_PICK, PHASES.PROMPT_STUDIO, PHASES.IMAGE_REVIEW];

/** 全局 composer 文案表没有模板页条目，这里单独补上，避免改 constants 造成跨任务冲突。 */
const TEMPLATE_PICK_COMPOSER = Object.freeze({
  placeholder: '用一句话描述想怎么改当前模板，例如：主色换成墨绿，首屏再大一点…',
  submitLabel: '修改这版模板',
  hint: '这里改的是当前模板的展示；“重新描述候选”会重新匹配整套骨架。',
});

// 计数器位于模块作用域，RESET、项目切换和 App 重挂载都不会复用请求身份。
let agentRequestSequence = 0;

function createAgentRequestId() {
  agentRequestSequence += 1;
  return `agent-request-${agentRequestSequence}`;
}

function fulfillmentLabel(fulfillment) {
  if (fulfillment.dineIn && fulfillment.takeaway) return '堂食 + 自取';
  if (fulfillment.dineIn) return '仅堂食';
  if (fulfillment.takeaway) return '仅自取';
  return '未选择';
}

const COMPOSER_HINTS = {
  [PHASES.ONBOARDING]: '名字不超过 48 个字符，之后随时可以修改。',
  [PHASES.PROMPT_STUDIO]: '满意后点下方「这版可以了，开始生成」进入效果图。',
  [PHASES.IMAGE_REVIEW]: '满意后点下方「效果满意，去部署」。',
};

/**
 * 把当前 Plan 的真实落位压成 `agent-template-revise.v1` 允许的 `planFeatures`。
 *
 * 契约（plan.md 2.2.8）当前只允许 `poster-carousel`，且同一 feature 只能出现一次；
 * 因此优先取顶层 `slotOrder`（补丁落位），没有时退回 `features[].slots[0]`。
 */
function collectRevisePlanFeatures(plan) {
  const features = Array.isArray(plan?.features) ? plan.features : [];
  const slotOrder = Array.isArray(plan?.slotOrder) ? plan.slotOrder : [];
  const featureIds = new Set(
    features
      .filter((feature) => feature && feature.id === 'poster-carousel')
      .map((feature) => feature.id),
  );
  const result = [];
  const push = (entry) => {
    if (!entry || !entry.featureId || !featureIds.has(entry.featureId)) return;
    if (typeof entry.pageId !== 'string' || typeof entry.slotId !== 'string') return;
    if (result.some((item) => item.featureId === entry.featureId)) return;
    result.push({ featureId: entry.featureId, pageId: entry.pageId, slotId: entry.slotId });
  };
  slotOrder.forEach(push);
  features.forEach((feature) => {
    const slot = Array.isArray(feature?.slots) ? feature.slots[0] : null;
    if (!slot) return;
    push({ featureId: feature.id, pageId: slot.pageId, slotId: slot.slotId });
  });
  return result.slice(0, 3);
}

/**
 * `AgentImageDraft` → 现有 `state.assets.images` 条目形状。
 *
 * 只保留 `projectSnapshot.pickImages` 认识的白名单字段，不把 base64 写进持久化文档。
 */
function toVisionAsset(draft) {
  return {
    assetId: draft.id,
    fileName: draft.name,
    originalName: draft.name,
    mime: draft.mediaType,
    bytes: draft.bytes,
    createdAt: new Date().toISOString(),
  };
}

/** 导出完成后可回传真实截图的工程目录（Composer 的 `outputPath`）。 */
function readExportedProjectPath(result) {
  if (!result || typeof result !== 'object') return null;
  const value = result.outputPath;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function buildPanelCards(state, tips, imageBusy, previewViewModel) {
  const cards = [];
  const style = STYLE_PRESETS.find((item) => item.id === state.visual.styleId) ?? STYLE_PRESETS[0];

  switch (state.phase) {
    case PHASES.HOME:
      cards.push({
        id: 'welcome',
        type: 'guidance',
        icon: 'sparkles',
        tone: 'accent',
        title: '轻启',
        body: '点击左侧「轻启」，我会陪你一步步搭出这家店的小程序。',
      });
      break;
    case PHASES.ONBOARDING:
      cards.push({
        id: 'naming',
        type: 'guidance',
        icon: 'store',
        tone: state.store.name ? 'success' : 'accent',
        title: state.store.name ? `项目：${state.store.name}` : '请给你的店铺小程序命名',
        body: state.store.name
          ? '名字已经记下，接下来我会介绍这个项目怎么用。'
          : '这个名字会出现在小程序标题与分享卡片上，之后随时可以修改。',
      });
      if (state.store.name) {
        cards.push({
          id: 'onboarding-steps',
          type: 'steps',
          icon: 'list',
          title: '接下来的流程',
          items: ['了解项目能力', '选择门店功能', '匹配页面骨架', '店铺装修与视觉', '部署小程序'],
        });
      }
      break;
    case PHASES.FEATURES:
      cards.push({
        id: 'feature-status',
        type: 'status',
        icon: 'list',
        tone: 'accent',
        title: `已选 ${state.features.selected.length} 项能力`,
        body: '带“必选”的基础能力已自动勾选，其余按经营需要增加。',
      });
      cards.push({
        id: 'feature-custom',
        type: 'guidance',
        icon: 'sparkles',
        title: '没有想要的功能？',
        body: '可以在下方输入框直接描述，我会把它加入定制方案。',
      });
      break;
    case PHASES.BUILDING:
      cards.push({
        id: 'pending-app',
        type: 'status',
        icon: 'rocket',
        tone: 'warn',
        title: '待加载小程序',
        body: '正在按你的功能清单拼装页面骨架…',
      });
      break;
    case PHASES.TEMPLATE_PICK:
      cards.push({
        id: 'templates',
        type: 'preview',
        icon: 'list',
        tone: 'accent',
        title: state.build.status === 'building' ? '正在按你的描述重新排骨架' : '候选页面骨架',
        body: state.build.status === 'building' ? '这会覆盖当前候选列表，完成后自动刷新。' : undefined,
        items: state.build.candidates.map((item) => `${item.name} · ${item.score}%`),
      });
      cards.push({
        id: 'template-preview',
        type: 'preview',
        icon: 'image',
        title: '实时预览',
        body: '点选骨架后，这里会按模板结构重新渲染。',
        node: (
          <MiniProgramPreview
            viewModel={previewViewModel}
            size="compact"
          />
        ),
      });
      break;
    case PHASES.STORE_INFO:
      cards.push({
        id: 'store-brief',
        type: 'guidance',
        icon: 'store',
        title: '店铺信息与装修风格',
        body: '先补充门店资料，再挑一个更贴合气质的配色。',
      });
      cards.push({
        id: 'style',
        type: 'status',
        icon: 'palette',
        title: `当前风格：${style.name}`,
        body: `背景 ${style.colors[0]} · 主色 ${style.colors[1]}`,
      });
      cards.push({
        id: 'style-preview',
        type: 'preview',
        icon: 'image',
        title: '装修实时预览',
        body: '切换风格后，预览会立即重新渲染。',
        node: (
          <MiniProgramPreview
            viewModel={previewViewModel}
            size="compact"
          />
        ),
      });
      {
        const transport = describeAgentTransport();
        const agent = state.agent;
        const filled = [
          state.agentDraft.storeName,
          state.agentDraft.category,
          state.agentDraft.businessHours,
          state.agentDraft.fulfillment.dineIn || state.agentDraft.fulfillment.takeaway,
          state.agentDraft.dishes.length >= 3,
        ].filter(Boolean).length;
        cards.push({
          id: 'agent-intake',
          type: 'status',
          icon: 'sparkles',
          tone: agent.status === 'confirmed' ? 'success' : (agent.status === 'failed' ? 'warn' : 'accent'),
          title: `开店资料 · ${transport.label}`,
          body: agent.status === 'confirmed'
            ? '资料已在本地确认，等待补充风格与地址；尚未保存或发布。'
            : `已完成 ${filled}/5 类资料，还差 ${agent.missingFields.length} 项。${agent.nextQuestion?.text ?? '可以直接描述，也可以手动编辑草稿。'}`,
        });
      }
      break;
    case PHASES.PROMPT_STUDIO:
      cards.push({
        id: 'prompt',
        type: 'preview',
        icon: 'sparkles',
        tone: 'accent',
        title: '生图提示词',
        body: state.visual.prompt || '正在生成第一版提示词…',
      });
      if (tips.length) {
        cards.push({
          id: 'prompt-tips',
          type: 'guidance',
          icon: 'list',
          title: '可以这样调整',
          items: tips,
        });
      }
      break;
    case PHASES.IMAGE_REVIEW:
      cards.push({
        id: 'image',
        type: 'preview',
        icon: 'image',
        tone: 'accent',
        title: '待审核效果图',
        body: imageBusy ? '正在生成新的效果图…' : '满意后即可进入部署。',
        image: state.visual.image?.dataUrl,
      });
      break;
    case PHASES.DEPLOY:
      cards.push({
        id: 'deploy',
        type: 'steps',
        icon: 'rocket',
        tone: state.deploy.status === 'done' ? 'success' : 'accent',
        title: state.deploy.status === 'done' ? '工程已生成' : '生成进度',
        body: state.deploy.status === 'done'
          ? '工程已写入本地目录，可在微信开发者工具中导入；不会自动发布。'
          : (state.deploy.stageMessage || '选择导出位置后生成小程序工程。'),
        items: DEPLOY_STEPS.map((label, index) => {
          if (state.deploy.status === 'done' || index < state.deploy.step) return `已完成 · ${label}`;
          if (index === state.deploy.step) return `进行中 · ${label}`;
          return `待执行 · ${label}`;
        }),
      });
      break;
    default:
      break;
  }

  return cards;
}

function sanitizeProjectName(value) {
  const cleaned = String(value || '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .trim()
    .slice(0, 60);
  return cleaned || 'smart-store';
}

// 设置文件不存在时，用当前实际生效的 transport 回填表单，避免显示值与真实请求不一致。
function withRuntimeAgentConfig(config) {
  if (!config || typeof config !== 'object') return config;
  const current = getAgentTransportConfig();
  return {
    ...config,
    apiBaseUrl: current.baseUrl,
    agentTransport: current.mode,
    agentEndpoint: current.endpoint,
    agentTimeoutMs: current.timeoutMs,
  };
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, undefined, createInitialState);
  const projectServiceRef = useRef(null);
  if (!projectServiceRef.current) projectServiceRef.current = createProjectService();
  const projectService = projectServiceRef.current;
  const thumbnailLoaderRef = useRef(null);
  if (!thumbnailLoaderRef.current) {
    thumbnailLoaderRef.current = createProjectThumbnailLoader({
      readAsset: (projectId, assetId, maxWidth) => projectServiceRef.current.readAsset(projectId, assetId, maxWidth),
      concurrency: 4,
      maxCacheEntries: 100,
    });
  }
  const settingsServiceRef = useRef(null);
  if (!settingsServiceRef.current) settingsServiceRef.current = createSettingsService();
  const settingsService = settingsServiceRef.current;
  const diagnosticsServiceRef = useRef(null);
  if (!diagnosticsServiceRef.current) diagnosticsServiceRef.current = createDiagnosticsService();
  const diagnosticsService = diagnosticsServiceRef.current;
  const appidServiceRef = useRef(null);
  if (!appidServiceRef.current) appidServiceRef.current = createAppidService();
  const appidService = appidServiceRef.current;
  const devtoolsServiceRef = useRef(null);
  if (!devtoolsServiceRef.current) devtoolsServiceRef.current = createDevtoolsService();
  const devtoolsService = devtoolsServiceRef.current;
  const skipNextSave = useRef(false);
  const settingsFallbackLoading = useRef(false);
  const lastDiagnostics = useRef({ json: null, copyText: '' });
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [handoffError, setHandoffError] = useState(null);
  const [devtoolsState, setDevtoolsState] = useState({ status: 'idle', found: false, via: 'none', path: null });
  const [settingsError, setSettingsError] = useState(null);
  const [diagnosticsCopyStatus, setDiagnosticsCopyStatus] = useState(null);
  const [diagnosticsSnapshotPath, setDiagnosticsSnapshotPath] = useState(null);
  const [notice, setNotice] = useState(null);
  const [draft, setDraft] = useState('');
  const [buildProgress, setBuildProgress] = useState(0);
  const [promptTips, setPromptTips] = useState([]);
  const [promptBusy, setPromptBusy] = useState(false);
  const [imageBusy, setImageBusy] = useState(false);
  const [draftEditorOpen, setDraftEditorOpen] = useState(false);
  const [thumbnails, setThumbnails] = useState({});
  const [storeImageBusy, setStoreImageBusy] = useState(false);
  const [onboardingConfirmOpen, setOnboardingConfirmOpen] = useState(false);
  const [onboardingCreating, setOnboardingCreating] = useState(false);
  const [templateRefineText, setTemplateRefineText] = useState('');
  // 模板并排对比：只在模板页有效，最多 2 个模板 id。
  const [compareIds, setCompareIds] = useState(null);
  // 多模态上传的本地状态：只存在于内存，随请求透传给 agent turn。
  const [agentImages, setAgentImages] = useState({ menu: [], store: [] });
  const [agentImageError, setAgentImageError] = useState(null);
  // 真实截图回传面板状态（工程目录来自 deploy.result，不复制到持久化文档）。
  const [realPreview, setRealPreview] = useState({ screenshot: null, busy: false, error: null });
  const templateReviseBusy = useRef(false);
  const buildStarted = useRef(false);
  const templateRefineStarted = useRef(false);
  const promptStarted = useRef(false);
  const imageStarted = useRef(false);
  const deployStarted = useRef(false);
  const preflightStarted = useRef(false);
  const deployBusy = useRef(false);
  const agentBusy = useRef(false);
  const previousPhase = useRef(state.phase);
  const previousAgentStatus = useRef(state.agent.status);

  const phase = state.phase;
  const meta = PHASE_META[phase];
  const activeSession = selectActiveSession(state);
  const selectedTemplate = state.build.candidates.find((item) => item.id === state.build.selectedId)
    ?? state.build.candidates[0];
  const currentTheme = STYLE_PRESETS.find((item) => item.id === state.visual.styleId) ?? STYLE_PRESETS[0];
  const styleName = currentTheme.name;
  const selectedLayout = selectedTemplate?.layout ?? null;
  // 选择器只暴露渲染字段；`lastUtterance` 供 TemplateRevisePanel 在成功后清空输入框。
  const presentationState = {
    ...selectPresentationState(state),
    lastUtterance: state.presentation?.lastUtterance ?? '',
  };
  const templateReviseTransport = describeTemplateReviseTransport();
  const exportedProjectPath = readExportedProjectPath(state.deploy?.result);
  const previewViewModels = useMemo(() => buildSessionPreviewViewModels(state), [state]);
  const storeTypesForForm = useMemo(() => {
    const category = state.agentDraft.category;
    if (!category) return STORE_TYPES;
    const exists = STORE_TYPES.some((item) => {
      const value = typeof item === 'string' ? item : (item?.value ?? item?.name ?? '');
      return value === category;
    });
    return exists ? STORE_TYPES : [...STORE_TYPES, { value: category, label: category }];
  }, [state.agentDraft.category]);

  const apiHost = useMemo(() => {
    try {
      const url = new URL(state.settings.config?.apiBaseUrl || 'http://127.0.0.1:3000/api/v1');
      return url.host;
    } catch (error) {
      return '127.0.0.1:3000';
    }
  }, [state.settings.config?.apiBaseUrl]);

  useEffect(() => {
    const service = projectServiceRef.current;
    let alive = true;
    dispatch({ type: 'PROJECT_SET_MODE', mode: service.mode });
    dispatch({ type: 'PROJECT_LIST_REQUEST' });
    service.list()
      .then((result) => {
        if (!alive) return;
        if (result.status === 'ok') {
          dispatch({ type: 'PROJECT_LIST_SUCCESS', list: result.projects });
        } else {
          dispatch({
            type: 'PROJECT_LIST_FAILURE',
            error: { code: result.code, message: result.message },
          });
        }
      })
      .catch((error) => {
        if (!alive) return;
        dispatch({
          type: 'PROJECT_LIST_FAILURE',
          error: { code: 'PROJECT_READ_FAILED', message: error instanceof Error ? error.message : '项目列表读取失败' },
        });
      });
    settingsServiceRef.current.load()
      .then((loaded) => {
        if (!alive) return;
        if (loaded.source === 'file') configureAgentRuntime(loaded.config);
        dispatch({ type: 'SETTINGS_LOAD_SUCCESS', config: withRuntimeAgentConfig(loaded.config) });
        projectServiceRef.current.setDebounce(loaded.config.autoSaveDebounceMs);
        if (loaded.warning) setNotice(loaded.warning);
      })
      .catch(() => {
        if (!alive) return;
        dispatch({ type: 'SETTINGS_LOAD_SUCCESS', config: withRuntimeAgentConfig(settingsServiceRef.current.defaults) });
        setNotice('设置读取失败，已使用默认值');
      });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    // 设置只应加载一次，但新建/重置项目等路径可能清空 settings 切片。
    // 进入设置页时若还没有 config，主动补一次加载，避免永久停在“正在读取应用设置…”。
    if (state.view !== 'settings' || state.settings.config) return undefined;
    if (settingsFallbackLoading.current) return undefined;
    settingsFallbackLoading.current = true;
    let alive = true;
    settingsServiceRef.current.load()
      .then((loaded) => {
        if (!alive) return;
        if (loaded.source === 'file') configureAgentRuntime(loaded.config);
        dispatch({ type: 'SETTINGS_LOAD_SUCCESS', config: withRuntimeAgentConfig(loaded.config) });
        projectServiceRef.current.setDebounce(loaded.config.autoSaveDebounceMs);
        if (loaded.warning) setNotice(loaded.warning);
      })
      .catch(() => {
        if (alive) dispatch({ type: 'SETTINGS_LOAD_SUCCESS', config: withRuntimeAgentConfig(settingsServiceRef.current.defaults) });
      })
      .finally(() => { settingsFallbackLoading.current = false; });
    return () => { alive = false; };
  }, [state.view, state.settings.config]);

  useEffect(() => {
    const projects = Array.isArray(state.project.list) ? state.project.list : [];
    if (projectServiceRef.current.mode !== 'desktop') {
      setThumbnails({});
      return undefined;
    }
    if (projects.length === 0) {
      setThumbnails({});
      return undefined;
    }
    let alive = true;
    thumbnailLoaderRef.current.load(projects)
      .then((map) => {
        if (!alive) return;
        const allowed = new Set(projects.map((project) => project && project.projectId).filter(Boolean));
        const next = {};
        allowed.forEach((projectId) => {
          if (map[projectId]) next[projectId] = map[projectId];
        });
        setThumbnails(next);
      })
      .catch(() => {
        if (alive) setThumbnails({});
      });
    return () => { alive = false; };
  }, [state.project.list]);

  useEffect(() => {
    const service = projectServiceRef.current;
    return service.onFlushRequest(async () => {
      try {
        await service.flush();
      } finally {
        await service.reportFlushDone();
      }
    });
  }, []);

  useEffect(() => {
    const service = projectServiceRef.current;
    const projectId = state.project.activeId;
    if (!projectId || state.project.status !== 'ready') return undefined;
    if (state.settings.config && state.settings.config.autoSaveEnabled === false) return undefined;
    if (skipNextSave.current) {
      skipNextSave.current = false;
      return undefined;
    }
    const doc = toDocument(state, {
      projectId,
      createdAt: state.project.createdAt,
      appid: state.project.appid,
    });
    dispatch({ type: 'PROJECT_MARK_DIRTY' });
    let alive = true;
    service.save(projectId, doc).then((result) => {
      if (!alive) return;
      if (result.status === 'ok') {
        dispatch({ type: 'PROJECT_SAVED', savedAt: result.savedAt, bytes: result.bytes });
      } else if (result.status === 'failed') {
        dispatch({
          type: 'PROJECT_SAVE_FAILED',
          error: { code: result.code, message: result.message },
        });
      }
    });
    return () => { alive = false; };
    // 只依赖可持久化切片；deploy 的进度/错误等 transient 不触发保存。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    state.phase,
    state.activeSessionId,
    state.store,
    state.features,
    state.build,
    state.visual,
    state.agentDraft,
    state.sessions,
    state.seq,
    state.agent.status,
    state.agent.confirmedAtSeq,
    state.assets,
    state.deploy.directory,
    state.deploy.projectName,
    state.deploy.resultDigest,
    state.deploy.handoff,
    state.project.appid,
    state.project.status,
    state.settings.config?.autoSaveEnabled,
    state.settings.config?.autoSaveDebounceMs,
  ]);

  useEffect(() => {
    setDraft('');
    setTemplateRefineText('');
    if (phase !== PHASES.TEMPLATE_PICK) setCompareIds(null);
  }, [phase]);

  // 回到起跑线（新项目/重置）时丢弃上一轮图片与会话级错误，避免把旧图片带进新门店。
  useEffect(() => {
    if (phase !== PHASES.ONBOARDING) return;
    setAgentImages({ menu: [], store: [] });
    setAgentImageError(null);
    setRealPreview({ screenshot: null, busy: false, error: null });
  }, [phase, state.project.activeId]);

  useEffect(() => {
    if (phase !== PHASES.STORE_INFO) {
      setDraftEditorOpen(false);
    } else if (previousPhase.current !== PHASES.STORE_INFO) {
      setDraftEditorOpen(state.agent.status !== 'idle');
    } else if (previousAgentStatus.current === 'idle' && state.agent.status !== 'idle') {
      setDraftEditorOpen(true);
    }
    previousPhase.current = phase;
    previousAgentStatus.current = state.agent.status;
  }, [phase, state.agent.status]);

  useEffect(() => {
    if (phase !== PHASES.BUILDING) {
      buildStarted.current = false;
      setBuildProgress(0);
      return undefined;
    }
    if (buildStarted.current) return undefined;
    buildStarted.current = true;
    let alive = true;
    let value = 0;
    const timer = setInterval(() => {
      value = Math.min(94, value + 9);
      setBuildProgress(value);
    }, 130);
    buildTemplateCandidates({
      selectedFeatures: state.features.selected,
      customPrompt: state.features.custom,
    }).then((candidates) => {
      if (!alive) return;
      clearInterval(timer);
      setBuildProgress(100);
      setTimeout(() => {
        if (alive) dispatch({ type: 'BUILD_READY', candidates });
      }, 460);
    });
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [phase, state.features.selected, state.features.custom]);

  useEffect(() => {
    const isRefining = phase === PHASES.TEMPLATE_PICK && state.build.status === 'building';
    if (!isRefining) {
      templateRefineStarted.current = false;
      return undefined;
    }
    if (templateRefineStarted.current) return undefined;
    templateRefineStarted.current = true;
    let alive = true;
    const brief = (state.build.feedback || []).join('；');
    buildTemplateCandidates({
      selectedFeatures: state.features.selected,
      customPrompt: brief,
    })
      .then((candidates) => {
        if (alive) dispatch({ type: 'TEMPLATE_REBUILD_READY', candidates });
      })
      .catch((error) => {
        if (!alive) return;
        dispatch({
          type: 'TEMPLATE_REBUILD_FAILED',
          error: {
            code: 'TEMPLATE_REBUILD_FAILED',
            message: error instanceof Error ? error.message : '重新匹配失败',
          },
        });
      });
    return () => {
      alive = false;
    };
  }, [phase, state.build.status, state.build.feedback, state.features.selected]);

  useEffect(() => {
    if (phase !== PHASES.PROMPT_STUDIO) {
      promptStarted.current = false;
      return undefined;
    }
    if (promptStarted.current) return undefined;
    promptStarted.current = true;
    let alive = true;
    // layout 取当前选中候选的版式，提示词里的构图约束才会与模板一致。
    composePrompt({ store: state.store, styleId: state.visual.styleId, layout: selectedLayout }).then((result) => {
      if (!alive) return;
      setPromptTips(result.tips);
      dispatch({ type: 'SET_PROMPT', prompt: result.prompt });
    });
    return () => {
      alive = false;
    };
  }, [phase, state.store, state.visual.styleId, selectedLayout]);

  useEffect(() => {
    if (phase !== PHASES.IMAGE_REVIEW) {
      imageStarted.current = false;
      return undefined;
    }
    if (imageStarted.current || state.visual.image) return undefined;
    imageStarted.current = true;
    let alive = true;
    setImageBusy(true);
    generateImage({ prompt: state.visual.prompt, seed: Date.now() }).then((image) => {
      if (!alive) return;
      setImageBusy(false);
      dispatch({ type: 'SET_IMAGE', image });
    });
    return () => {
      alive = false;
    };
  }, [phase, state.visual.image, state.visual.prompt]);

  useEffect(() => {
    if (phase !== PHASES.DEPLOY) return undefined;
    const unsubscribe = subscribeProgress((event) => {
      dispatch({
        type: 'DEPLOY_STAGE',
        stage: event.stage,
        step: event.step,
        progress: event.progress,
        message: event.message,
      });
    });
    return unsubscribe;
  }, [phase]);

  useEffect(() => {
    if (phase !== PHASES.ONBOARDING || !state.store.name) return undefined;
    const timer = setTimeout(() => dispatch({ type: 'SKIP_INTRO' }), INTRO_AUTO_ADVANCE_MS);
    return () => clearTimeout(timer);
  }, [phase, state.store.name]);

  const panelCards = useMemo(
    () => buildPanelCards(state, promptTips, imageBusy, previewViewModels.selected),
    [state, promptTips, imageBusy, previewViewModels.selected],
  );

  const refreshProjectList = async () => {
    const service = projectServiceRef.current;
    dispatch({ type: 'PROJECT_LIST_REQUEST' });
    try {
      const result = await service.list();
      if (result.status === 'ok') {
        dispatch({ type: 'PROJECT_LIST_SUCCESS', list: result.projects });
      } else {
        dispatch({ type: 'PROJECT_LIST_FAILURE', error: { code: result.code, message: result.message } });
      }
    } catch (error) {
      dispatch({
        type: 'PROJECT_LIST_FAILURE',
        error: { code: 'PROJECT_READ_FAILED', message: error instanceof Error ? error.message : '项目列表读取失败' },
      });
    }
  };

  const handleProjectOpen = async (projectId) => {
    const service = projectServiceRef.current;
    if (state.project.activeId && state.project.activeId !== projectId) {
      await service.flush();
    }
    dispatch({ type: 'PROJECT_OPEN_REQUEST', projectId });
    let result;
    try {
      result = await service.load(projectId);
    } catch (error) {
      result = { status: 'failed', code: 'PROJECT_READ_FAILED', message: error instanceof Error ? error.message : '项目读取失败' };
    }
    if (!result || result.status !== 'ok') {
      dispatch({
        type: 'PROJECT_OPEN_FAILURE',
        error: { code: result?.code, message: result?.message || '项目读取失败' },
      });
      return;
    }
    if (result.futureVersion) {
      dispatch({
        type: 'PROJECT_OPEN_FAILURE',
        error: { code: 'PROJECT_FUTURE_VERSION', message: '项目由更高版本创建，请升级应用后再打开' },
      });
      return;
    }

    const hydrated = fromDocument(result.doc);
    if (hydrated.phase === PHASES.PROMPT_STUDIO || hydrated.phase === PHASES.IMAGE_REVIEW) {
      promptStarted.current = true;
    }
    if (hydrated.phase === PHASES.IMAGE_REVIEW) {
      imageStarted.current = true;
    }
    if (hydrated.phase !== PHASES.BUILDING) {
      buildStarted.current = false;
    }
    skipNextSave.current = true;
    dispatch({
      type: 'PROJECT_OPEN_SUCCESS',
      projectId,
      doc: result.doc,
      savedAt: result.savedAt,
      bytes: result.bytes,
    });
    if (result.recoveredFrom) {
      setNotice('项目文件损坏，已从最近一次备份恢复。原文件已保留在项目目录内。');
    } else if (result.corrupt) {
      setNotice('项目文件已损坏且没有可用备份，已以空白项目打开；损坏文件保留在项目目录内。');
    }

    const assetId = result.doc && result.doc.visual && result.doc.visual.imageAssetId;
    if (assetId && service.mode === 'desktop') {
      const asset = await service.readAsset(projectId, assetId, 720).catch(() => null);
      if (asset && asset.status === 'ok') {
        const meta = result.doc.visual.imageMeta || {};
        dispatch({
          type: 'SET_IMAGE',
          image: { dataUrl: asset.asset.dataUrl, provider: meta.provider, note: meta.note },
        });
      }
    }
  };

  const handleProjectCreate = async () => {
    const service = projectServiceRef.current;
    if (state.project.activeId) {
      await service.flush().catch(() => {});
    }
    let result;
    try {
      result = await service.create({ name: '', inheritAppid: true });
    } catch (error) {
      result = { status: 'failed', code: 'PROJECT_WRITE_FAILED', message: error instanceof Error ? error.message : '新建项目失败' };
    }
    if (!result || result.status !== 'ok') {
      dispatch({
        type: 'PROJECT_OPEN_FAILURE',
        error: { code: result?.code || 'PROJECT_WRITE_FAILED', message: result?.message || '新建项目失败' },
      });
      return false;
    }
    buildStarted.current = false;
    promptStarted.current = false;
    imageStarted.current = false;
    skipNextSave.current = true;
    dispatch({
      type: 'PROJECT_NEW_SUCCESS',
      projectId: result.projectId,
      createdAt: result.createdAt,
      appid: result.appid,
    });
    return true;
  };

  const handleProjectReveal = async (projectId) => {
    const result = await projectServiceRef.current.reveal(projectId);
    if (result.status !== 'ok') {
      setNotice(result.message || '无法打开项目目录');
    }
  };

  const handleProjectCopyId = async (projectId) => {
    try {
      await navigator.clipboard.writeText(projectId);
      setNotice(`已复制项目 ID：${projectId}`);
    } catch (error) {
      setNotice(`项目 ID：${projectId}`);
    }
  };

  const handleProjectDeleteRequest = (project) => {
    dispatch({ type: 'PROJECT_DELETE_REQUEST', projectId: project.projectId, name: project.name });
  };

  const handleProjectDeleteCancel = () => dispatch({ type: 'PROJECT_DELETE_CANCEL' });

  const handleProjectDeleteConfirm = async () => {
    const target = state.project.deleteTarget;
    if (!target || deleteBusy) return;
    setDeleteBusy(true);
    const service = projectServiceRef.current;
    if (state.project.activeId === target.projectId) service.cancelPending();
    let result;
    try {
      result = await service.remove(target.projectId, target.name);
    } catch (error) {
      result = { status: 'failed', code: 'PROJECT_WRITE_FAILED', message: error instanceof Error ? error.message : '删除项目失败' };
    }
    setDeleteBusy(false);
    if (result.status === 'ok') {
      dispatch({ type: 'PROJECT_DELETE_SUCCESS', projectId: target.projectId });
    } else {
      dispatch({
        type: 'PROJECT_DELETE_FAILURE',
        error: { code: result.code || 'PROJECT_WRITE_FAILED', message: result.message || '删除项目失败' },
      });
    }
  };

  const handleProjectSearch = (value) => dispatch({ type: 'PROJECT_SEARCH_SET', value });

  const handleOpenWorkbench = async () => {
    if (state.project.activeId) {
      await projectServiceRef.current.flush().catch(() => {});
    }
    setNotice(null);
    dispatch({ type: 'VIEW_SET', view: 'workbench' });
    await refreshProjectList();
  };

  const handleBackToFlow = () => dispatch({ type: 'VIEW_SET', view: 'flow' });

  const handleOpenDataDirectory = async () => {
    const result = await projectServiceRef.current.openDataDirectory();
    if (result.status !== 'ok') setNotice(result.message || '无法打开数据目录');
  };

  const handleOpenSettings = () => dispatch({ type: 'VIEW_SET', view: 'settings' });

  const handleUndo = () => dispatch({ type: 'UNDO_APPLY' });
  const handleRedo = () => dispatch({ type: 'REDO_APPLY' });

  useEffect(() => {
    const onKey = (event) => {
      if (state.view !== 'flow') return;
      if (!(event.ctrlKey || event.metaKey) || String(event.key).toLowerCase() !== 'z') return;
      const tag = event.target && event.target.tagName ? String(event.target.tagName).toLowerCase() : '';
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      event.preventDefault();
      dispatch({ type: event.shiftKey ? 'REDO_APPLY' : 'UNDO_APPLY' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state.view]);

  const handleSettingsBack = () => {
    dispatch({ type: 'VIEW_SET', view: state.project.activeId ? 'flow' : 'workbench' });
  };

  const handleSettingsSave = async (config) => {
    if (settingsSaving) return;
    setSettingsSaving(true);
    setSettingsError(null);
    const result = await settingsService.save(config).catch((error) => ({
      status: 'failed',
      code: 'SETTINGS_INVALID',
      message: error instanceof Error ? error.message : '设置保存失败',
    }));
    setSettingsSaving(false);
    if (result.status === 'ok') {
      const saved = result.config || config;
      dispatch({ type: 'SETTINGS_SAVE_SUCCESS', config: saved });
      configureAgentRuntime(saved);
      projectService.setDebounce(config.autoSaveDebounceMs);
      setNotice('设置已保存');
      return;
    }
    setSettingsError({ code: result.code, message: result.message });
  };

  const handleRunDiagnostics = async () => {
    dispatch({ type: 'DIAGNOSTICS_START' });
    setDiagnosticsSnapshotPath(null);
    const config = state.settings.config || settingsService.defaults;
    try {
      const result = await diagnosticsService.run(config);
      lastDiagnostics.current = { json: result.json, copyText: result.copyText };
      dispatch({
        type: 'DIAGNOSTICS_DONE',
        lines: result.lines,
        checkedAt: result.json.generatedAt || null,
      });
    } catch (error) {
      dispatch({
        type: 'DIAGNOSTICS_FAILURE',
        error: { code: 'DIAGNOSTICS_FAILED', message: error instanceof Error ? error.message : '自检未完成' },
      });
    }
  };

  const handleCopyDiagnostics = async () => {
    const text = lastDiagnostics.current.copyText || '尚未运行自检';
    const copied = await diagnosticsService.copyText(text);
    setDiagnosticsCopyStatus(copied ? 'done' : 'failed');
    setTimeout(() => setDiagnosticsCopyStatus(null), 2200);
  };

  const handleSaveDiagnosticsSnapshot = async () => {
    if (!lastDiagnostics.current.json) {
      setNotice('请先运行自检');
      return;
    }
    const result = await diagnosticsService.saveSnapshot(lastDiagnostics.current.json);
    if (result.status === 'ok') {
      setDiagnosticsSnapshotPath(result.path || '已保存');
    } else {
      setNotice(result.message || '诊断快照保存失败');
    }
  };

  const startOnboarding = () => {
    if (selectOnboardingStart(state) === 'confirm-create') {
      setOnboardingConfirmOpen(true);
      return;
    }
    dispatch({ type: 'START_ONBOARDING' });
  };

  const confirmStartOnboarding = async () => {
    if (onboardingCreating) return;
    setOnboardingCreating(true);
    try {
      const created = await handleProjectCreate();
      if (!created) return;
      setOnboardingConfirmOpen(false);
      dispatch({ type: 'START_ONBOARDING' });
    } finally {
      setOnboardingCreating(false);
    }
  };

  const reset = async () => {
    await projectServiceRef.current.flush().catch(() => {});
    dispatch({ type: 'RESET_PROJECT' });
  };
  const selectSession = (id) => dispatch({ type: 'SWITCH_SESSION', id });

  const handlePromptFeedback = async (text) => {
    if (promptBusy) return;
    setPromptBusy(true);
    // T13 之后 `revisePrompt` 可能返回结构化对象；两种形状都兼容。
    const revised = await revisePrompt({ base: state.visual.prompt, feedback: text });
    const nextPrompt = typeof revised === 'string' ? revised : (revised?.prompt ?? state.visual.prompt);
    setPromptBusy(false);
    dispatch({
      type: 'ADD_PROMPT_ROUND',
      text,
      reply: `好的，我把「${text}」补充进提示词里了。`,
      prompt: nextPrompt,
    });
  };

  const handleImageFeedback = async (text) => {
    if (imageBusy) return;
    setImageBusy(true);
    const image = await reviseImage({
      prompt: `${state.visual.prompt} ${text}`,
      seed: Date.now(),
    });
    setImageBusy(false);
    dispatch({
      type: 'ADD_IMAGE_ROUND',
      text,
      reply: '已经按你的意见重新生成，看看这一版是否更接近你要的感觉。',
      image,
    });
  };

  /**
   * 模板页「对话修改当前模板」。
   *
   * 单飞 + 晚响应丢弃：`requestId` 先写入状态机，结果必须带同一个 id 回来；
   * 用户切模板或发起第二轮后，旧响应会被 reducer 整包忽略（plan.md 2.2.3）。
   */
  const handleTemplateReviseSubmit = async (utterance) => {
    const text = String(utterance ?? '').trim();
    if (!text) return;
    if (phase !== PHASES.TEMPLATE_PICK) return;
    if (templateReviseBusy.current) return;
    if (!presentationState.canRevise) return;
    const templateId = state.build.selectedId;
    const candidate = state.build.candidates.find((item) => item?.id === templateId);
    if (!templateId || !candidate) return;

    const requestId = createReviseRequestId();
    templateReviseBusy.current = true;
    dispatch({ type: 'TEMPLATE_REVISE_REQUEST', utterance: text, requestId });
    try {
      let planFeatures = [];
      try {
        planFeatures = collectRevisePlanFeatures(buildPlanFromSession(state).plan);
      } catch (error) {
        // Plan 推导失败不应阻塞对话修改；服务端会按 0..3 条 planFeatures 处理。
        planFeatures = [];
      }
      const result = await requestTemplateRevise({
        utterance: text,
        requestId,
        candidate: { templateId, layout: candidate.layout },
        planFeatures,
        basePatch: presentationState.patch,
        baseDraft: state.agentDraft,
      });
      dispatch({
        type: 'TEMPLATE_REVISE_SUCCESS',
        requestId,
        templateId: result.templateId,
        patch: result.patch,
        changes: result.changes,
        reply: result.reply,
      });
    } catch (error) {
      dispatch({ type: 'TEMPLATE_REVISE_FAILURE', requestId, error });
    } finally {
      templateReviseBusy.current = false;
    }
  };

  /** VisionImageUploader 已压缩完成，这里只负责写入本地状态（plan.md 2.2.6 行为 5）。 */
  const handleVisionImagesAdd = (kind, drafts) => {
    const incoming = Array.isArray(drafts)
      ? drafts.filter((item) => item && typeof item.id === 'string' && item.id)
      : [];
    if (!incoming.length) return;
    setAgentImageError(null);
    setAgentImages((prev) => {
      const current = Array.isArray(prev[kind]) ? prev[kind] : [];
      const limit = kind === 'store' ? 1 : 2;
      const seen = new Set(current.map((item) => item.id));
      const merged = [...current];
      incoming.forEach((item) => {
        if (seen.has(item.id)) return;
        seen.add(item.id);
        merged.push(item);
      });
      return { ...prev, [kind]: merged.slice(0, limit) };
    });
    // 门店环境照同时进入现有 assets 写入通道；只保存白名单字段，不持久化 base64。
    if (kind === 'store') {
      dispatch({ type: 'ADD_PROJECT_IMAGES', images: incoming.slice(0, 1).map(toVisionAsset) });
    }
  };

  const handleVisionImageRemove = (kind, id) => {
    setAgentImageError(null);
    setAgentImages((prev) => ({
      ...prev,
      [kind]: (Array.isArray(prev[kind]) ? prev[kind] : []).filter((item) => item.id !== id),
    }));
  };

  const handleOpenPreviewProject = async () => {
    const api = typeof window !== 'undefined' ? window.smartStore : null;
    if (!api || typeof api.openPreviewProject !== 'function') {
      setRealPreview((prev) => ({
        ...prev,
        error: {
          code: 'PREVIEW_BRIDGE_UNAVAILABLE',
          message: '浏览器模式下无法打开工程目录，请在桌面应用中操作；下方人工步骤仍可照做。',
        },
      }));
      return;
    }
    if (!exportedProjectPath) {
      setRealPreview((prev) => ({
        ...prev,
        error: { code: 'PATH_MISSING', message: '还没有可打开的导出工程，请先完成导出。' },
      }));
      return;
    }
    setRealPreview((prev) => ({ ...prev, busy: true, error: null }));
    try {
      const result = await api.openPreviewProject({ projectPath: exportedProjectPath });
      if (result && result.ok) {
        setRealPreview((prev) => ({ ...prev, busy: false, error: null }));
        if (typeof result.message === 'string' && result.message) setNotice(result.message);
        return;
      }
      setRealPreview((prev) => ({
        ...prev,
        busy: false,
        error: {
          code: (result && result.code) || 'PATH_INVALID',
          message: (result && result.message) || '打开工程目录失败。',
        },
      }));
    } catch (error) {
      setRealPreview((prev) => ({
        ...prev,
        busy: false,
        error: { code: 'PATH_INVALID', message: error?.message || '打开工程目录失败。' },
      }));
    }
  };

  /**
   * 模板页「预览新模块」：把当前定制需求（presentation patch）导出成真实工程，
   * 再交给微信开发者工具打开。只在桌面端可用。
   */
  const handlePreparePreviewProject = useCallback(async () => {
    const api = typeof window !== 'undefined' ? window.smartStore : null;
    if (!api || api.isDesktop !== true || typeof api.composerExport !== 'function') {
      return { ok: false, message: '需要在桌面应用中生成并预览工程。' };
    }

    const { plan, warnings } = buildPlanFromSession(state);
    const baseName = String(
      (state.store && state.store.name)
      || (state.agentDraft && state.agentDraft.storeName)
      || '小程序预览',
    ).trim() || '小程序预览';
    const projectName = `${baseName}-预览-${Date.now().toString().slice(-6)}`;

    const result = await exportProject({
      parentDir: '__preview__',
      plan,
      projectName,
      mode: 'development',
    });
    if (result.status !== 'ok') {
      return { ok: false, message: result.message || '生成预览工程失败。' };
    }

    const payload = result.result || {};
    return {
      ok: true,
      path: payload.outputPath || '',
      warnings: [...(warnings || []), ...(payload.warnings || [])],
    };
  }, [state]);

  const handlePickPreviewScreenshot = async () => {
    const api = typeof window !== 'undefined' ? window.smartStore : null;
    if (!api || typeof api.pickPreviewScreenshot !== 'function') {
      setRealPreview((prev) => ({
        ...prev,
        error: {
          code: 'PREVIEW_BRIDGE_UNAVAILABLE',
          message: '浏览器模式下不能选择本地截图，请在桌面应用中操作。',
        },
      }));
      return;
    }
    setRealPreview((prev) => ({ ...prev, busy: true, error: null }));
    try {
      const result = await api.pickPreviewScreenshot();
      if (result && result.cancelled) {
        // 取消不是错误：保留上一张截图，只结束忙碌态。
        setRealPreview((prev) => ({ ...prev, busy: false }));
        return;
      }
      if (result && typeof result.dataUrl === 'string' && result.dataUrl) {
        setRealPreview({
          busy: false,
          error: null,
          screenshot: {
            dataUrl: result.dataUrl,
            name: typeof result.name === 'string' && result.name ? result.name : '未命名截图',
            bytes: Number.isFinite(result.bytes) ? result.bytes : undefined,
          },
        });
        return;
      }
      setRealPreview((prev) => ({
        ...prev,
        busy: false,
        error: { code: 'SCREENSHOT_INVALID', message: '没有读到有效截图，请重新选择 PNG / JPEG 文件。' },
      }));
    } catch (error) {
      setRealPreview((prev) => ({
        ...prev,
        busy: false,
        error: { code: 'SCREENSHOT_INVALID', message: error?.message || '选择截图失败。' },
      }));
    }
  };

  const handleClearPreviewScreenshot = () => {
    setRealPreview({ screenshot: null, busy: false, error: null });
  };

  const handleAgentTurn = async (utterance, { retry = false } = {}) => {
    if (agentBusy.current) return;
    if (phase !== PHASES.STORE_INFO) return;
    const text = String(utterance ?? '').trim();
    if (!text) return;
    agentBusy.current = true;
    const requestId = createAgentRequestId();
    // 空数组不传，保持 v1 请求形状；有图片时服务层自动升级到 agent-turn.v2。
    const images = [...agentImages.menu, ...agentImages.store];
    dispatch(retry
      ? { type: 'AGENT_TURN_RETRY', requestId }
      : { type: 'AGENT_TURN_REQUEST', utterance: text, requestId });
    try {
      const result = await requestAgentTurn({
        utterance: text,
        draft: state.agentDraft,
        ...(images.length ? { images } : {}),
        simulateFailureOnce: state.agent.simulateFailure,
      });
      dispatch({ type: 'AGENT_TURN_SUCCESS', ...result, requestId });
      setDraft('');
      setAgentImageError(null);
    } catch (error) {
      if (error && typeof error.code === 'string' && error.code.startsWith('AGENT_IMAGE')) {
        setAgentImageError({ code: error.code, message: error.message || '图片不可用，请重新选择。' });
      }
      dispatch({ type: 'AGENT_TURN_FAILURE', requestId, error });
    } finally {
      agentBusy.current = false;
    }
  };

  const handleAgentRetry = () => {
    if (!state.agent.lastUtterance) return;
    handleAgentTurn(state.agent.lastUtterance, { retry: true });
  };

  const handleAgentConfirm = () => dispatch({ type: 'CONFIRM_AGENT_DRAFT' });
  const handleAgentReopen = () => dispatch({ type: 'REOPEN_AGENT_DRAFT' });
  const handleAgentFieldChange = (field, value) => dispatch({ type: 'EDIT_AGENT_DRAFT_FIELD', field, value });
  const handleAgentFulfillment = (field, value) => dispatch({ type: 'EDIT_AGENT_FULFILLMENT', field, value });
  const handleAgentDishChange = (id, field, value) => dispatch({ type: 'EDIT_AGENT_DISH', id, field, value });
  const handleAgentAddDish = () => dispatch({ type: 'ADD_AGENT_DISH' });
  const handleAgentRemoveDish = (id) => dispatch({ type: 'REMOVE_AGENT_DISH', id });
  const handleSimulateFailure = (value) => dispatch({ type: 'AGENT_SIMULATE_FAILURE', value });

  const handleComposerSubmit = (value) => {
    const text = String(value ?? '').trim();
    if (!text) return;
    if (phase === PHASES.STORE_INFO) {
      handleAgentTurn(text);
      return;
    }
    if (phase === PHASES.TEMPLATE_PICK) {
      // 模板页的输入不再静默落空：走「对话修改当前模板」，不触发重新匹配候选。
      handleTemplateReviseSubmit(text);
      setDraft('');
      return;
    }
    if (phase === PHASES.ONBOARDING) {
      if (!state.store.name) dispatch({ type: 'SUBMIT_NAME', name: text });
      setDraft('');
      return;
    }
    if (phase === PHASES.PROMPT_STUDIO) {
      handlePromptFeedback(text);
      setDraft('');
      return;
    }
    if (phase === PHASES.IMAGE_REVIEW) {
      handleImageFeedback(text);
      setDraft('');
    }
  };

  const handleStoreSubmit = () => {
    const summary = [
      `店铺：${state.store.name || '未命名'}`,
      state.store.type,
      state.store.address || '未填写地址',
    ].join(' · ');
    dispatch({ type: 'SUBMIT_STORE_INFO', summary, styleId: state.visual.styleId });
  };

  const handleFieldChange = (field, value) => {
    dispatch({ type: 'SET_STORE_FIELD', field: field === 'intro' ? 'notes' : field, value });
  };

  const handlePickStoreImages = async () => {
    if (storeImageBusy) return;
    const service = projectServiceRef.current;
    const projectId = state.project.activeId;
    if (service.mode !== 'desktop') {
      setNotice('浏览器模式不支持图片落盘，请在桌面应用中添加门店图片');
      return;
    }
    if (!projectId) {
      setNotice('请先在工作台新建项目，再添加门店图片');
      return;
    }
    const current = Array.isArray(state.assets && state.assets.images) ? state.assets.images : [];
    if (current.length >= 6) {
      setNotice('最多保留 6 张门店图片');
      return;
    }
    setStoreImageBusy(true);
    try {
      const picked = await service.pickImages(6);
      if (picked.status !== 'ok') {
        setNotice(picked.message || '选择图片失败');
        return;
      }
      if (!Array.isArray(picked.items) || picked.items.length === 0) return;
      const attached = await service.attachImages(projectId, picked.items.map((item) => item.token));
      if (attached.status !== 'ok') {
        setNotice(attached.message || '导入图片失败');
        return;
      }
      dispatch({ type: 'ADD_PROJECT_IMAGES', images: attached.assets });
      const known = new Set(current.map((item) => item.assetId));
      const added = attached.assets.filter((item) => !known.has(item.assetId)).length;
      setNotice(added > 0 ? `已添加 ${added} 张门店图片` : '所选图片已在项目中');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '导入图片失败');
    } finally {
      setStoreImageBusy(false);
    }
  };

  const runDeployExport = async (directory, plan, projectName, extraWarnings) => {
    if (deployBusy.current) return;
    deployBusy.current = true;
    dispatch({ type: 'DEPLOY_DIRECTORY_CHOSEN', directory, projectName });
    try {
      // 预检后目录可能被其他进程抢走，因此真正导出前再做一次只读检查；
      // Composer 自身的 TARGET_EXISTS 仍然保留为最后一道保护。
      if (projectServiceRef.current.mode === 'desktop') {
        const target = await preflightTarget({ parentDir: directory, projectName });
        if (target.status === 'conflict') {
          const merged = mergeTargetPreflight(state.deploy.preflight, target);
          dispatch({
            type: 'PREFLIGHT_RESULT',
            errors: merged.errors,
            warns: merged.warns,
            infos: merged.infos,
            planDigest: merged.planDigest,
            checkedAt: merged.checkedAt,
          });
          dispatch({
            type: 'DEPLOY_CONFLICT',
            error: {
              code: 'TARGET_EXISTS',
              message: target.message || describeExportError('TARGET_EXISTS'),
              suggestedName: target.suggestedName,
            },
          });
          return;
        }
        if (target.status !== 'ok') {
          const merged = mergeTargetPreflight(state.deploy.preflight, target);
          dispatch({
            type: 'PREFLIGHT_RESULT',
            errors: merged.errors,
            warns: merged.warns,
            infos: merged.infos,
            planDigest: merged.planDigest,
            checkedAt: merged.checkedAt,
          });
          dispatch({
            type: 'DEPLOY_FAILURE',
            error: {
              code: target.code || 'TARGET_CHECK_FAILED',
              message: target.message || describeExportError('TARGET_CHECK_FAILED'),
            },
          });
          return;
        }
      }
      const result = await exportProject({ parentDir: directory, plan, projectName, mode: 'development' });
      if (result.status === 'ok') {
        const payload = result.result || {};
        const mergedWarnings = [...(extraWarnings || []), ...(payload.warnings || [])];
        dispatch({
          type: 'DEPLOY_SUCCESS',
          result: { ...payload, warnings: mergedWarnings },
          previewOnly: payload.previewOnly || [],
          versionGaps: payload.updatesAvailable || [],
          warnings: mergedWarnings,
        });
        return;
      }
      if (result.status === 'cancelled') {
        dispatch({ type: 'DEPLOY_CANCELLED' });
        return;
      }
      if (result.status === 'conflict') {
        dispatch({
          type: 'DEPLOY_CONFLICT',
          error: {
            code: result.code || 'TARGET_EXISTS',
            message: result.message || describeExportError('TARGET_EXISTS'),
            suggestedName: result.suggestedName,
          },
        });
        return;
      }
      dispatch({
        type: 'DEPLOY_FAILURE',
        error: {
          code: result.code || 'COMPOSE_FAILED',
          message: result.message || describeExportError(result.code),
        },
      });
    } finally {
      deployBusy.current = false;
    }
  };

  const handleDeployChooseDirectory = async () => {
    if (deployBusy.current) return;
    const gate = selectCanChooseDirectory(state);
    if (!gate.can) {
      setNotice(`还不能选择导出位置：${gate.reason}`);
      return;
    }
    if (!isDesktopExportAvailable()) {
      dispatch({
        type: 'DEPLOY_FAILURE',
        error: { code: 'DESKTOP_REQUIRED', message: DESKTOP_REQUIRED_MESSAGE },
      });
      return;
    }
    dispatch({ type: 'DEPLOY_START' });
    const chosen = await chooseDirectory();
    if (chosen.status === 'cancelled') {
      dispatch({ type: 'DEPLOY_CANCELLED' });
      return;
    }
    if (chosen.status !== 'ok') {
      dispatch({ type: 'DEPLOY_FAILURE', error: { code: chosen.status, message: chosen.message } });
      return;
    }
    const { plan, warnings } = buildPlanFromSession(state);
    const projectName = sanitizeProjectName(state.store.name || state.agentDraft.storeName);
    await runDeployExport(chosen.path, plan, projectName, warnings);
  };

  const handleDeployRetry = async () => {
    if (deployBusy.current) return;
    const directory = state.deploy.directory;
    if (!directory) {
      await handleDeployChooseDirectory();
      return;
    }
    const gate = selectCanChooseDirectory(state);
    if (!gate.can) {
      setNotice(`还不能重试导出：${gate.reason}`);
      return;
    }
    const projectName = sanitizeProjectName(
      (state.deploy.error && state.deploy.error.suggestedName) || state.deploy.projectName,
    );
    const { plan, warnings } = buildPlanFromSession(state);
    await runDeployExport(directory, plan, projectName, warnings);
  };

  const handleDeployCancel = async () => {
    await cancelExport(state.deploy.taskId);
    dispatch({ type: 'DEPLOY_CANCELLED' });
  };

  const runPreflight = async () => {
    dispatch({ type: 'PREFLIGHT_START' });
    try {
      const local = evaluateLocal(state, {
        devtoolsDetected: state.deploy.handoff ? state.deploy.handoff.devtoolsDetected : null,
      });
      let merged = { ...local, planDigest: null };
      const desktop = projectServiceRef.current.mode === 'desktop';
      if (desktop && local.errors.length === 0) {
        const { plan } = buildPlanFromSession(state);
        const result = await validatePlan(plan);
        if (result.status === 'ok') {
          merged = mergeComposerResult(local, result.result);
        } else {
          merged = mergeComposerResult(local, {
            ok: false,
            code: result.code || 'COMPOSE_FAILED',
            message: result.message,
          });
        }
      }
      // 已有导出位置时提前暴露同名冲突；未选择目录不伪造目标路径。
      const rawTargetName = String(state.deploy.projectName || state.store.name || state.agentDraft.storeName || '').trim();
      if (desktop && state.deploy.directory && rawTargetName) {
        const target = await preflightTarget({
          parentDir: state.deploy.directory,
          projectName: sanitizeProjectName(rawTargetName),
        });
        merged = mergeTargetPreflight(merged, target);
      }
      dispatch({
        type: 'PREFLIGHT_RESULT',
        errors: merged.errors,
        warns: merged.warns,
        infos: merged.infos,
        planDigest: merged.planDigest,
        checkedAt: merged.checkedAt,
        error: merged.error || null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误';

      dispatch({
        type: 'PREFLIGHT_RESULT',
        errors: [{
          ruleId: 'E-PREFLIGHT-FAILED',
          level: 'error',
          message: `体检未完成：${message}`,
          fieldPath: null,
          action: null,
        }],
        warns: [],
        infos: [],
        planDigest: null,
        checkedAt: new Date().toISOString(),
        error: { code: 'PREFLIGHT_FAILED', message },
      });
    }
  };

  useEffect(() => {
    if (state.view !== 'flow' || phase !== PHASES.DEPLOY) {
      preflightStarted.current = false;
      return undefined;
    }
    if (![DEPLOY_STATUS.IDLE, DEPLOY_STATUS.CANCELLED, DEPLOY_STATUS.FAILED].includes(state.deploy.status)) {
      return undefined;
    }
    if (preflightStarted.current) return undefined;
    preflightStarted.current = true;
    void runPreflight();
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.view, phase, state.deploy.status]);

  const handleDeployOpenPath = async (target) => {
    const resolved = target || (state.deploy.directory && state.deploy.projectName
      ? `${state.deploy.directory}/${state.deploy.projectName}`
      : '');
    if (!resolved) return;
    const result = await openProjectDirectory(resolved);
    if (!result.ok) {
      dispatch({
        type: 'DEPLOY_FAILURE',
        error: { code: 'OPEN_FAILED', message: result.message || '目录不存在，可重新导出。' },
      });
    }
  };

  const handleDeployCopyPath = async (target) => {
    if (!target || typeof navigator === 'undefined' || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(target);
    } catch (error) {
      /* 剪贴板不可用时静默忽略，路径仍可见可手选 */
    }
  };

  const handleProbeDevtools = async () => {
    setDevtoolsState((previous) => ({ ...previous, status: 'checking' }));
    const result = await devtoolsService.probe();
    const next = {
      status: result.found ? 'found' : 'absent',
      found: Boolean(result.found),
      via: result.via || 'none',
      path: result.path || null,
      message: result.message || null,
    };
    setDevtoolsState(next);
    if (state.deploy.handoff) dispatch({ type: 'HANDOFF_DEVTOOLS_RESULT', detected: next.found });
  };

  const handleHandoffOpen = () => {
    dispatch({ type: 'HANDOFF_OPEN' });
    setHandoffOpen(true);
    setHandoffError(null);
    if (devtoolsState.status === 'idle') void handleProbeDevtools();
  };

  const handleHandoffClose = () => setHandoffOpen(false);

  const handleHandoffStepSelect = (stepId) => dispatch({ type: 'HANDOFF_STEP_SET', stepId });

  const handleHandoffComplete = (stepId) => {
    dispatch({ type: 'HANDOFF_STEP_COMPLETE', stepId });
  };

  const handleHandoffApplyAppid = async (appid) => {
    const outputPath = state.deploy.result?.outputPath
      || (state.deploy.directory && state.deploy.projectName
        ? `${state.deploy.directory}/${state.deploy.projectName}`
        : '');
    if (!outputPath) {
      setHandoffError({ code: 'APPID_TARGET_MISSING', message: '找不到产物目录，请重新导出' });
      return;
    }
    setHandoffBusy(true);
    setHandoffError(null);
    const result = await appidService.apply(outputPath, appid);
    setHandoffBusy(false);
    if (result.status === 'ok') {
      dispatch({ type: 'PROJECT_SET_APPID', appid: result.appid });
      dispatch({
        type: 'HANDOFF_APPID_RESULT',
        applied: true,
        digestBefore: result.digestBefore,
        digestAfter: result.digestAfter,
        lockDigestBefore: result.lockDigestBefore,
        lockDigestAfter: result.lockDigestAfter,
      });
      dispatch({ type: 'HANDOFF_STEP_COMPLETE', stepId: 'appid' });
      setNotice(result.unchanged ? 'AppID 已是该值，无需改写' : 'AppID 已写入，产物摘要已重新封存');
      return;
    }
    setHandoffError({ code: result.code, message: result.message });
  };

  const handleHandoffFinish = async () => {
    dispatch({ type: 'HANDOFF_STEP_COMPLETE', stepId: 'next' });
    setHandoffOpen(false);
    await handleOpenWorkbench();
  };

  const handleCopyDevtoolsGuide = async () => {
    const copied = await devtoolsService.copyGuide();
    setNotice(copied ? '安装说明已复制' : '复制失败，请手动打开官方下载页');
  };

  const handleImportPreview = async () => {
    if (state.deploy.import.busy) return;
    dispatch({ type: 'IMPORT_PREVIEW_START' });
    try {
      const payload = await buildImportPayload(state.agentDraft, state.store);
      const result = await previewImport({ storeId: DEFAULT_STORE_ID, payload });
      if (result.status === 'ok') {
        dispatch({ type: 'IMPORT_PREVIEW_SUCCESS', preview: { ...result.data, payload } });
        return;
      }
      dispatch({
        type: 'IMPORT_PREVIEW_FAILURE',
        status: result.status,
        error: { code: result.code, message: result.message },
      });
    } catch (error) {
      dispatch({
        type: 'IMPORT_PREVIEW_FAILURE',
        error: { code: 'IMPORT_FAILED', message: error instanceof Error ? error.message : '检查差异失败。' },
      });
    }
  };

  const handleImportToggle = (key) => dispatch({ type: 'IMPORT_CONFIRM_TOGGLE', key });

  const handleImportApply = async () => {
    const current = state.deploy.import;
    if (current.busy || !current.preview || !current.preview.previewToken) return;
    dispatch({ type: 'IMPORT_APPLY_START' });
    try {
      const result = await applyImport({
        storeId: DEFAULT_STORE_ID,
        payload: current.preview.payload,
        previewToken: current.preview.previewToken,
        confirmations: current.confirmations,
      });
      if (result.status === 'ok') {
        dispatch({ type: 'IMPORT_SUCCESS', result: result.data });
        return;
      }
      dispatch({
        type: 'IMPORT_FAILURE',
        status: result.status,
        error: { code: result.code, message: result.message },
      });
    } catch (error) {
      dispatch({
        type: 'IMPORT_FAILURE',
        error: { code: 'IMPORT_FAILED', message: error instanceof Error ? error.message : '导入失败。' },
      });
    }
  };

  function renderStage() {
    switch (phase) {
      case PHASES.FEATURES:
        return (
          <FeaturePicker
            groups={FEATURE_GROUPS}
            features={catalogFeatures}
            selectedIds={state.features.selected}
            requiredIds={REQUIRED_IDS}
            onToggle={(id) => dispatch({ type: 'TOGGLE_FEATURE', id })}
            custom={state.features.custom}
            onCustomChange={(value) => dispatch({ type: 'SET_FEATURES_CUSTOM', value })}
            onCustomize={(value) => dispatch({ type: 'SUBMIT_CUSTOMIZE', value })}
          />
        );
      case PHASES.TEMPLATE_PICK:
        return (
          <TemplateGallery
            candidates={state.build.candidates}
            selectedId={state.build.selectedId}
            onSelect={(id) => dispatch({ type: 'SELECT_TEMPLATE', id })}
            onConfirm={() => dispatch({ type: 'CONFIRM_TEMPLATE' })}
            viewModelsByTemplateId={previewViewModels.byTemplateId}
            refineText={templateRefineText}
            onRefineChange={setTemplateRefineText}
            onRefine={(value) => {
              dispatch({ type: 'SUBMIT_TEMPLATE_FEEDBACK', value });
              setTemplateRefineText('');
            }}
            refining={state.build.status === 'building'}
            refineError={state.build.refineError}
            presentation={presentationState}
            onRevise={handleTemplateReviseSubmit}
            onClearReviseError={() => dispatch({ type: 'TEMPLATE_REVISE_CLEAR' })}
            compareIds={compareIds}
            onCompareChange={setCompareIds}
            mockRevise={templateReviseTransport.mock}
            previewProjectPath={null}
            onPrepareProject={handlePreparePreviewProject}
          />
        );
      case PHASES.STORE_INFO: {
        const agent = state.agent;
        const transport = describeAgentTransport();
        const canConfirm = agent.status === 'reviewing'
          && agent.missingFields.length === 0
          && agent.errors.length === 0;
        const storeForm = (
          <StoreInfoStep
            store={{ ...state.store, intro: state.store.notes }}
            storeTypes={storeTypesForForm}
            styles={STYLE_PRESETS}
            styleId={state.visual.styleId}
            images={state.assets.images}
            imageBusy={storeImageBusy}
            onFieldChange={handleFieldChange}
            onStyleChange={(id) => dispatch({ type: 'SET_STYLE', id })}
            onPickImages={handlePickStoreImages}
            onSubmit={handleStoreSubmit}
          />
        );
        // 图片识别入口（C-VISION-UPLOADER@1）：菜单照 / 门店环境照分开上传，
        // 组件内部已完成压缩，这里只保存 AgentImageDraft 并在下一次对话时透传。
        const visionUploader = (
          <VisionImageUploader
            images={agentImages}
            busy={agent.status === 'requesting'}
            disabled={agent.status === 'confirmed'}
            error={agentImageError}
            onAdd={handleVisionImagesAdd}
            onRemove={handleVisionImageRemove}
          />
        );
        if (agent.status === 'confirmed') {
          return (
            <>
              <AgentDraftSummary
                storeName={state.agentDraft.storeName}
                category={state.agentDraft.category}
                businessHours={state.agentDraft.businessHours}
                fulfillmentText={fulfillmentLabel(state.agentDraft.fulfillment)}
                dishes={state.agentDraft.dishes.map((dish) => ({
                  id: dish.id,
                  name: dish.name,
                  priceDisplay: dish.priceCents === null ? '待填写' : `¥${formatCents(dish.priceCents)}`,
                  description: dish.description,
                }))}
                onReopen={handleAgentReopen}
              />
              {visionUploader}
              {storeForm}
            </>
          );
        }
        return (
          <>
            <AgentIntakePanel
              status={agent.status}
              transportLabel={transport.label}
              transportMode={transport.mode}
              reply={agent.reply}
              missingFields={agent.missingFields}
              errors={agent.errors}
              nextQuestion={agent.nextQuestion}
              lastError={agent.lastError}
              attempts={agent.attempts}
              simulateFailure={agent.simulateFailure}
              onRetry={handleAgentRetry}
              onToggleSimulateFailure={handleSimulateFailure}
            />
            {visionUploader}
            <DraftEditor
              draft={state.agentDraft}
              validation={{
                missingFields: agent.missingFields,
                errors: agent.errors,
                readyForReview: canConfirm,
              }}
              disabled={agent.status === 'requesting'}
              maxDishes={5}
              minDishes={3}
              open={draftEditorOpen}
              onToggleOpen={() => setDraftEditorOpen((value) => !value)}
              onChangeField={handleAgentFieldChange}
              onToggleFulfillment={handleAgentFulfillment}
              onChangeDish={handleAgentDishChange}
              onRemoveDish={handleAgentRemoveDish}
            />
          </>
        );
      }
      case PHASES.PROMPT_STUDIO:
        return (
          <PromptStudio
            prompt={state.visual.prompt}
            tips={promptTips}
            rounds={state.visual.promptRounds}
            busy={promptBusy}
            onPromptChange={(value) => dispatch({ type: 'SET_PROMPT', prompt: value })}
            onFeedback={handlePromptFeedback}
            onConfirm={() => dispatch({ type: 'CONFIRM_PROMPT' })}
          />
        );
      case PHASES.IMAGE_REVIEW:
        return (
          <ImageReview
            image={state.visual.image}
            rounds={state.visual.imageRounds}
            busy={imageBusy}
            onRegenerate={handleImageFeedback}
            onApprove={() => dispatch({ type: 'APPROVE_IMAGE' })}
          />
        );
case PHASES.DEPLOY: {
        const exportGate = selectCanExport(state);
        const chooseGate = selectCanChooseDirectory(state);
        return (
          <>
            <PreflightPanel
              status={state.deploy.preflight.status}
              errors={state.deploy.preflight.errors}
              warns={state.deploy.preflight.warns}
              infos={state.deploy.preflight.infos}
              acknowledged={state.deploy.preflight.acknowledged}
              planDigest={state.deploy.preflight.planDigest}
              checkedAt={state.deploy.preflight.checkedAt}
              canExport={exportGate}
              onRerun={runPreflight}
              onToggleAck={(ruleId) => dispatch({ type: 'PREFLIGHT_ACK_TOGGLE', ruleId })}
              onGoto={(nextPhase) => dispatch({ type: 'PHASE_GOTO', phase: nextPhase })}
            />
            <DeployStep
              status={state.deploy.status}
              steps={DEPLOY_STEPS}
              step={state.deploy.step}
              progress={state.deploy.progress}
              stageMessage={state.deploy.stageMessage}
              storeName={state.store.name}
              templateName={selectedTemplate?.name ?? '默认骨架'}
              styleName={styleName}
              directory={state.deploy.directory}
              projectName={state.deploy.projectName}
              result={state.deploy.result}
              error={state.deploy.error}
              previewOnly={state.deploy.previewOnly}
              versionGaps={state.deploy.versionGaps}
              warnings={state.deploy.warnings}
              busy={state.deploy.busy}
              blockedReason={chooseGate.can ? null : chooseGate.reason}
              onChooseDirectory={handleDeployChooseDirectory}
              onRetry={handleDeployRetry}
              onCancel={handleDeployCancel}
              onOpenPath={handleDeployOpenPath}
              onCopyPath={handleDeployCopyPath}
              onOpenHandoff={handleHandoffOpen}
            />
            {state.deploy.status === 'done' ? (
              <ImportDiffCard
                status={state.deploy.import.status}
                preview={state.deploy.import.preview}
                confirmations={state.deploy.import.confirmations}
                busy={state.deploy.import.busy}
                result={state.deploy.import.result}
                error={state.deploy.import.error}
                onPreview={handleImportPreview}
                onToggleConfirmation={handleImportToggle}
                onApply={handleImportApply}
              />
            ) : null}
            {state.deploy.status === 'done' ? (
              <RealPreviewPanel
                projectPath={exportedProjectPath}
                screenshot={realPreview.screenshot}
                busy={realPreview.busy}
                error={realPreview.error}
                onOpen={handleOpenPreviewProject}
                onPickScreenshot={handlePickPreviewScreenshot}
                onClear={handleClearPreviewScreenshot}
              />
            ) : null}
          </>
        );
      }
      default:
        return null;
    }
  }

  const agentComposer = selectAgentComposerState(state);
  const undoState = selectUndoState(state);
  const composerVisible = phase === PHASES.STORE_INFO
    ? agentComposer.visible
    : COMPOSER_PHASES.includes(phase);
  const skipVisible = phase === PHASES.ONBOARDING && Boolean(state.store.name);
  // 模板页复用主输入框；文案独立，避免和「重新描述候选」混为一谈。
  const composerPlaceholder = phase === PHASES.STORE_INFO
    ? agentComposer.placeholder
    : (phase === PHASES.TEMPLATE_PICK ? TEMPLATE_PICK_COMPOSER.placeholder : (COMPOSER_PLACEHOLDER[phase] ?? ''));
  const composerSubmitLabel = phase === PHASES.STORE_INFO
    ? agentComposer.submitLabel
    : (phase === PHASES.TEMPLATE_PICK ? TEMPLATE_PICK_COMPOSER.submitLabel : (COMPOSER_SUBMIT_LABEL[phase] ?? '发送'));
  const composerHint = phase === PHASES.STORE_INFO
    ? agentComposer.hint
    : (phase === PHASES.TEMPLATE_PICK ? TEMPLATE_PICK_COMPOSER.hint : COMPOSER_HINTS[phase]);
  const composerDisabled = phase === PHASES.STORE_INFO
    ? !agentComposer.editable
    : (phase === PHASES.TEMPLATE_PICK ? !presentationState.canRevise : false);
  const composerSubmitDisabled = phase === PHASES.STORE_INFO
    ? agentComposer.submitDisabled
    : (phase === PHASES.TEMPLATE_PICK ? (!presentationState.canRevise || presentationState.status === 'revising') : false);

  if (state.view === 'workbench') {
    return (
      <ProjectWorkbench
        status={selectWorkbenchState(state)}
        projects={selectVisibleProjects(state)}
        search={state.project.search}
        mode={state.project.mode}
        thumbnails={thumbnails}
        activeId={state.project.activeId}
        activeName={state.store.name || state.agentDraft.storeName || '当前项目'}
        lastProjectId={state.settings.config?.lastProjectId || null}
        deleteTarget={state.project.deleteTarget}
        deleteBusy={deleteBusy}
        error={state.project.status === 'error' ? state.project.openError : null}
        openError={state.project.status === 'error' ? null : state.project.openError}
        onDismissError={() => dispatch({ type: 'PROJECT_OPEN_ERROR_CLEAR' })}
        onSearch={handleProjectSearch}
        onCreate={handleProjectCreate}
        onOpen={handleProjectOpen}
        onReveal={handleProjectReveal}
        onCopyId={handleProjectCopyId}
        onDeleteRequest={handleProjectDeleteRequest}
        onDeleteCancel={handleProjectDeleteCancel}
        onDeleteConfirm={handleProjectDeleteConfirm}
        onOpenRecent={handleProjectOpen}
        onBackToFlow={handleBackToFlow}
        onRetry={refreshProjectList}
        onOpenDirectory={handleOpenDataDirectory}
        onOpenSettings={handleOpenSettings}
      />
    );
  }

  if (state.view === 'settings') {
    return (
      <SettingsPanel
        config={state.settings.config}
        mode={state.project.mode}
        diagnostics={state.settings.diagnostics}
        summary={selectDiagnosticsSummary(state)}
        copyStatus={diagnosticsCopyStatus}
        snapshotPath={diagnosticsSnapshotPath}
        saving={settingsSaving}
        saveError={settingsError}
        projectCount={state.project.list.length}
        activeProjectId={state.project.activeId}
        onSave={handleSettingsSave}
        onRunDiagnostics={handleRunDiagnostics}
        onCopyDiagnostics={handleCopyDiagnostics}
        onSaveSnapshot={handleSaveDiagnosticsSnapshot}
        onBack={handleSettingsBack}
        onOpenDataDir={handleOpenDataDirectory}
        onOpenProjectDirectory={() => {
          if (state.project.activeId) handleProjectReveal(state.project.activeId);
        }}
      />
    );
  }

  return (
    <>
      <AppShell
      sidebar={(
        <Sidebar
          appName="智能开店"
          sessions={state.sessions}
          activeSessionId={state.activeSessionId}
          currentStoreName={state.store.name}
          saveLabel={selectSaveLabel(state)}
          mode={state.project.mode}
          agentLabel={describeAgentTransport().label}
          onStartOnboarding={startOnboarding}
          onSelectSession={selectSession}
          onOpenWorkbench={handleOpenWorkbench}
          onOpenSettings={handleOpenSettings}
          onReset={reset}
        />
      )}
      panel={<RightPanel meta={meta} cards={panelCards} />}
      main={(
        <>
          <TitleBar
            title={meta.label}
            caption={meta.caption}
            badge={activeSession.title}
            saveLabel={selectSaveLabel(state)}
            canUndo={undoState.canUndo}
            canRedo={undoState.canRedo}
            onUndo={handleUndo}
            onRedo={handleRedo}
            onOpenWorkbench={handleOpenWorkbench}
            onReset={reset}
          />
          {notice ? (
            <div className="app-notice" role="status">
              <span>{notice}</span>
              <button type="button" onClick={() => setNotice(null)}>关闭</button>
            </div>
          ) : null}
          <div className="workspace">
            {phase === PHASES.HOME ? (
              <HomeStage
                greeting={HOME_GREETING}
                hint="点击左侧「轻启」开始，用自然语言描述你想要的店铺小程序。"
                onStart={startOnboarding}
              />
            ) : (
              <>
                <div className={`workspace-conversation${phase === PHASES.BUILDING ? ' is-building' : ''}`}>
                  <ChatStream
                    messages={activeSession.messages}
                    revealKey={activeSession.id}
                    flushKey={activeSession.revealFlush ?? 0}
                  >
                    {phase !== PHASES.BUILDING ? renderStage() : null}
                  </ChatStream>
                  {phase === PHASES.BUILDING ? (
                    <BuildLoading
                      active
                      title="正在构建小程序"
                      message="消息正在上移，新的页面骨架马上呈现。"
                      steps={BUILD_STEPS}
                      progress={buildProgress}
                    />
                  ) : null}
                </div>
                {phase === PHASES.STORE_INFO && state.agent.status !== 'confirmed' ? (
                  <div className="workspace-actions">
                    <StoreInfoActionBar
                      status={state.agent.status}
                      dishCount={state.agentDraft.dishes.length}
                      maxDishes={5}
                      missingCount={state.agent.missingFields.length}
                      errorCount={state.agent.errors.length}
                      editorOpen={draftEditorOpen}
                      onAddDish={handleAgentAddDish}
                      onConfirm={handleAgentConfirm}
                    />
                  </div>
                ) : null}
                {composerVisible ? (
                  <div className="workspace-composer">
                    <Composer
                      value={draft}
                      placeholder={composerPlaceholder}
                      submitLabel={composerSubmitLabel}
                      hint={composerHint}
                      disabled={composerDisabled}
                      submitDisabled={composerSubmitDisabled}
                      onChange={setDraft}
                      onSubmit={handleComposerSubmit}
                    />
                  </div>
                ) : null}
                {skipVisible ? (
                  <div className="workspace-skip">
                    <SkipNotice
                      visible
                      question={SKIP_HINT.question}
                      action={SKIP_HINT.action}
                      onSkip={() => dispatch({ type: 'SKIP_INTRO' })}
                    />
                  </div>
                ) : null}
              </>
            )}
          </div>
        </>
      )}
      />
      <HandoffWizard
        open={handoffOpen}
        handoff={state.deploy.handoff}
        progress={selectHandoffProgress(state)}
        result={state.deploy.result}
        appid={state.project.appid}
        apiHost={apiHost}
        devtools={devtoolsState}
        busy={handoffBusy}
        error={handoffError}
        blockedReason={state.deploy.status === 'done' ? '' : '上一次交接进度已保留；重新导出后可继续写入 AppID'}
        onClose={handleHandoffClose}
        onStepSelect={handleHandoffStepSelect}
        onCompleteStep={handleHandoffComplete}
        onApplyAppid={handleHandoffApplyAppid}
        onOpenPath={handleDeployOpenPath}
        onCopyPath={handleDeployCopyPath}
        onProbeDevtools={handleProbeDevtools}
        onCopyGuide={handleCopyDevtoolsGuide}
        onFinish={handleHandoffFinish}
      />
      <ConfirmDialog
        open={onboardingConfirmOpen}
        title="开始一个新项目？"
        description="当前项目会先保存，然后新建一个待命名项目并进入命名引导。已导出的工程不会受影响。"
        confirmLabel="保存并新建"
        cancelLabel="留在当前项目"
        tone="accent"
        confirmButtonClass="primary-button"
        busy={onboardingCreating}
        onConfirm={confirmStartOnboarding}
        onCancel={() => setOnboardingConfirmOpen(false)}
      />
    </>
  );
}