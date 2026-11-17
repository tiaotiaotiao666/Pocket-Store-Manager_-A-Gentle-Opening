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
import { buildPlanFromSession, buildExportPlanFromSession } from './composition/planFromSession.mjs';
import { buildSessionPreviewViewModels } from './composition/previewViewModel.mjs';
import { buildConversationStream } from './state/conversationStream.mjs';
import {
  isDesktopExportAvailable,
  subscribeProgress,
  chooseDirectory,
  fetchDefaultTarget,
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
import { analyzeComposerInput, createSubmitGuard } from './domain/composerInput.mjs';
import { toDocument, fromDocument } from './domain/projectSnapshot.mjs';
import { evaluateLocal, mergeComposerResult, mergeTargetPreflight } from './domain/preflightRules.mjs';
import { createProjectService } from './services/projectService.js';
import { createProjectThumbnailLoader } from './services/projectThumbnailLoader.js';
import { createSettingsService } from './services/settingsService.js';
import { createDiagnosticsService } from './services/diagnosticsService.js';
import { createAppidService } from './services/appidService.js';
import { createDevtoolsService } from './services/devtoolsService.js';
import { requestAgentTurn, describeAgentTransport, configureAgentRuntime, getAgentTransportConfig } from './services/agentTurn/agentTurnService.js';
import { requestAgentRun, isAgentRunRoute, resolveAgentRequestRoute } from './services/agentTurn/agentRunService.js';
import { requestScreenReference, createScreenReferenceRequestId } from './services/agentTurn/screenReferenceService.js';
import { validateReferenceImage, candidateToSessionPatch } from './domain/screenReference.mjs';
// P4：图片驱动前端重构（受控候选前端）——状态机在 domain，服务调用在 services。
import {
  FRONTEND_STATUS,
  buildFrontendReconstructView,
  createFrontendRunId,
  createInitialFrontendReconstructState,
  frontendReducer,
  isFrontendBusy,
} from './domain/frontendReconstruct.mjs';
import { buildFrontendProcessView } from './domain/agentRunProcess.mjs';
import { createFrontendReconstructService } from './services/frontendReconstruct/frontendReconstructService.js';
import {
  adoptionNotice,
  adoptionStateSlice,
  buildAdoptionRecord,
  candidateOverlayFromAdoption,
  undoAdoptionRecord,
} from './services/frontendReconstruct/adoptionBridge.js';
import { describeFlow } from './domain/flowStages.mjs';
import { describeGalleryLegend, describeTemplateStatus } from './domain/templateStatus.mjs';
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
// UX0a-3：生图能力开关。没有真实服务时既不调用 generateImage，也不显示"重新生成"。
import {
  canGenerateImage,
  shouldAutoGenerateImage,
  IMAGE_GENERATION_BLOCKED_REASON,
} from './services/imageCapability.js';

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
import FlowStepper from './components/flow/FlowStepper.jsx';
import AttachGroup from './components/flow/AttachGroup.jsx';
import RealPreviewPanel from './components/preview/RealPreviewPanel.jsx';
import StoreInfoStep from './components/build/StoreInfoStep.jsx';
import PromptStudio from './components/build/PromptStudio.jsx';
import ImageReview from './components/build/ImageReview.jsx';
import DeployStep from './components/build/DeployStep.jsx';
import ImportDiffCard from './components/build/ImportDiffCard.jsx';
import AgentIntakePanel from './components/agent/AgentIntakePanel.jsx';
import VisionImageUploader from './components/agent/VisionImageUploader.jsx';
import ScreenReferencePanel from './components/screenRef/ScreenReferencePanel.jsx';
import FrontendCandidatePanel from './components/screenRef/FrontendCandidatePanel.jsx';
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
// UX0a-3：海报素材上传的 UI 侧上限；不替代导出链路的媒体校验，只是先挡住明显过大的文件。
const MAX_POSTER_UPLOAD_BYTES = 2 * 1024 * 1024;
const COMPOSER_PHASES = [PHASES.ONBOARDING, PHASES.STORE_INFO, PHASES.TEMPLATE_PICK, PHASES.PROMPT_STUDIO, PHASES.IMAGE_REVIEW];

/**
 * P6：候选前端「本轮结束」的状态集合。
 *
 * 只有到达这些状态才把耗时定格；planning/idle 不是结束（用户还会继续构建/验证，
 * 提前定格会把真实耗时显示小，等于伪造进度）。
 */
const FRONTEND_TERMINAL_STATUSES = new Set([
  FRONTEND_STATUS.READY,
  FRONTEND_STATUS.PARTIAL,
  FRONTEND_STATUS.FAILED,
  FRONTEND_STATUS.CANCELLED,
  FRONTEND_STATUS.ADOPTED,
  FRONTEND_STATUS.REJECTED,
  FRONTEND_STATUS.NEEDS_INPUT,
]);

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
  [PHASES.PROMPT_STUDIO]: '满意后点下方「确认这版提示词」进入海报素材。',
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
      // UX0-6：中间已经是实时预览，右栏不再重复渲染同一张图。
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
        // UX0-6：右栏改为「当前门店配置 + 完成进度」摘要，不再重复中间的效果图/预览。
        cards.push({
          id: 'store-config',
          type: 'status',
          icon: 'store',
          title: '当前门店配置',
          items: [
            `店名：${state.agentDraft.storeName || state.store.name || '待填写'}`,
            `品类：${state.agentDraft.category || '待填写'}`,
            `营业时间：${state.agentDraft.businessHours || '待填写'}`,
            `取餐方式：${fulfillmentLabel(state.agentDraft.fulfillment)}`,
            `菜品：${state.agentDraft.dishes.length} 道`,
          ],
        });
        cards.push({
          id: 'store-progress',
          type: 'progress',
          icon: 'list',
          tone: filled >= 5 ? 'success' : 'accent',
          title: `资料完成度 ${filled}/5`,
          body: filled >= 5 ? '资料已齐全，可以继续选风格与部署。' : '还差的部分补完即可继续；随时可以回头修改。',
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
        id: 'image-status',
        type: 'status',
        icon: 'image',
        tone: 'accent',
        title: '海报素材（可选）',
        body: state.visual.imageAssetId && state.visual.image?.provider === 'user-upload'
          ? '已选用你上传的图片（已保存到项目），可以直接继续。'
          : '未添加素材：可以上传一张 PNG 图，或直接跳过；不影响小程序生成。',
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
  // P4：候选前端的独立状态机（不塞进 sessionMachine，避免与 P5 持久化改造互相踩踏）。
  const [frontendState, frontendDispatch] = useReducer(
    frontendReducer,
    undefined,
    createInitialFrontendReconstructState,
  );
  const frontendServiceRef = useRef(null);
  if (!frontendServiceRef.current) frontendServiceRef.current = createFrontendReconstructService();
  const frontendService = frontendServiceRef.current;
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
  // UX0b：海报素材落盘/回读进行中（避免重复上传）。
  const [posterBusy, setPosterBusy] = useState(false);
  const [draftEditorOpen, setDraftEditorOpen] = useState(false);
  const [thumbnails, setThumbnails] = useState({});
  const [storeImageBusy, setStoreImageBusy] = useState(false);
  // P5c：默认导出位置（主进程给路径，界面负责显示；点按钮才真正写盘）。
  const [defaultTarget, setDefaultTarget] = useState({ status: 'loading', path: '', token: '', message: '' });
  const [onboardingConfirmOpen, setOnboardingConfirmOpen] = useState(false);
  const [onboardingCreating, setOnboardingCreating] = useState(false);
  const [templateRefineText, setTemplateRefineText] = useState('');
  // 模板并排对比：只在模板页有效，最多 2 个模板 id。
  const [compareIds, setCompareIds] = useState(null);
  // 多模态上传的本地状态：只存在于内存，随请求透传给 agent turn。
  const [agentImages, setAgentImages] = useState({ menu: [], store: [] });
  const [agentImageError, setAgentImageError] = useState(null);
  // P3：参考截图流程的即时错误与「是否已落盘」提示（都不进持久化文档）。
  const [screenRefError, setScreenRefError] = useState(null);
  const [screenRefPersisted, setScreenRefPersisted] = useState(true);
  // P4：候选前端链路的即时错误（同样只存在内存里，不写项目快照）。
  const [frontendLocalError, setFrontendLocalError] = useState(null);
  // P5：已采用候选前端的项目快照记录。它跟随 project.json 生命周期，
  // 与 P4 的候选构建状态（frontendState）分开，避免重开项目后把两者混在一起。
  const [frontendCandidateRecord, setFrontendCandidateRecord] = useState(null);
  // P6：候选前端本轮的真实耗时（只在真实 runId 下累计；没有就显示不了，不伪造）。
  const [frontendTiming, setFrontendTiming] = useState({ runId: null, startedAt: null, endedAt: null });
  // 真实截图回传面板状态（工程目录来自 deploy.result，不复制到持久化文档）。
  const [realPreview, setRealPreview] = useState({ screenshots: [], busy: false, error: null });
  const templateReviseBusy = useRef(false);
  const buildStarted = useRef(false);
  const templateRefineStarted = useRef(false);
  const promptStarted = useRef(false);
  const imageStarted = useRef(false);
  const deployStarted = useRef(false);
  const preflightStarted = useRef(false);
  const deployBusy = useRef(false);
  const agentBusy = useRef(false);
  // P3：识别请求的并发门禁，避免同一时刻发两次识别。
  const screenRefBusy = useRef(false);
  // W4：连续点击/连按回车只放行一次同一段文字，避免重复请求与重复消息。
  const submitGuardRef = useRef(createSubmitGuard());
  // 在途请求期间用户可能新增图片：用 ref 记录最新数量，避免闭包读到旧 state。
  const agentImagesRef = useRef(0);
  agentImagesRef.current = agentImages.menu.length + agentImages.store.length;
  const previousPhase = useRef(state.phase);
  const previousAgentStatus = useRef(state.agent.status);

  const phase = state.phase;
  const meta = PHASE_META[phase];
  const activeSession = selectActiveSession(state);
  // UX0a-1：统一对话流使用稳定的展示语义 —— revealKey 恒为常量、revealAll 恒为真。
  // 这样 useSequentialReveal 不会因为"新增了一个会话"把 visibleCount 重置成 0：
  // 历史消息始终可见，新回复立即出现，也不重播历史入场动画。
  const conversationMessages = useMemo(
    () => buildConversationStream(state.sessions),
    [state.sessions],
  );
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
  // P4：候选前端视图模型只在 domain 里算，组件与 App 都不重复判断门槛。
  const frontendView = useMemo(() => buildFrontendReconstructView(frontendState), [frontendState]);
  // P6：候选前端的真实过程视图（工具标签/runId/attempt/状态/耗时）。
  // 只有真实 trace（模型调用或工具调用）或主进程真实进度时才生成；没有证据返回 null，
  // ChatStream 的 ProcessSummary 也只在有 title 时渲染——绝不用固定假步骤冒充运行。
  const frontendProcessSummary = useMemo(() => {
    const trace = frontendState.analysis && frontendState.analysis.trace ? frontendState.analysis.trace : null;
    const progress = frontendState.progress && frontendState.progress.stage
      ? {
        stage: frontendState.progress.stage,
        attempt: Number.isInteger(frontendState.progress.attempt) ? frontendState.progress.attempt : null,
        runId: frontendState.runId,
        at: null,
      }
      : null;
    const hasTrace = Boolean(trace && (
      (Number.isFinite(trace.modelCalls) && trace.modelCalls > 0)
      || (Array.isArray(trace.toolCalls) && trace.toolCalls.length > 0)
    ));
    if (!hasTrace && !progress) return null;
    const timing = frontendTiming.runId && frontendTiming.runId === frontendState.runId ? frontendTiming : null;
    const view = buildFrontendProcessView({
      status: frontendState.status,
      trace,
      progress,
      runId: frontendState.runId,
      attempt: frontendState.candidate ? frontendState.candidate.attempt : null,
      startedAt: timing ? timing.startedAt : null,
      endedAt: timing ? timing.endedAt : null,
      lastError: frontendState.error,
    });
    return view && view.title ? view : null;
  }, [frontendState, frontendTiming]);
  // P5：Plan/导出必须看到「项目里已采用的候选」；没有记录时保持原 state 形状。
  const frontendStateWithCandidate = useMemo(
    () => (frontendCandidateRecord ? { ...state, frontendCandidate: frontendCandidateRecord } : state),
    [state, frontendCandidateRecord],
  );
  const frontendCandidateOverlay = useMemo(
    () => candidateOverlayFromAdoption(frontendCandidateRecord),
    [frontendCandidateRecord],
  );

  // P2：主线步骤条只是只读投影，不改任何业务动作；构建中不提供返回入口。
  const flowDescriptor = useMemo(
    () => describeFlow(state.phase, {
      busy: state.phase === PHASES.BUILDING || state.agent.status === 'requesting',
    }),
    [state.phase, state.agent.status],
  );

  // P2：模板卡状态（当前使用 / 候选模板 / 已采用），参考候选的来源始终标注。
  const templateStatus = useMemo(() => {
    const screenRef = state.screenRef;
    const selectedId = state.build.selectedId ?? null;
    const referenceTemplateId = screenRef && screenRef.candidate
      ? (candidateToSessionPatch(screenRef.candidate)?.selectedId ?? null)
      : null;
    const context = {
      selectedId,
      screenRef: referenceTemplateId
        ? {
          adopted: screenRef.adopted === true,
          // 候选还在但没采用时既不是「已采用」也不是「已放弃」。
          discarded: false,
          templateId: referenceTemplateId,
        }
        : null,
    };
    const byId = {};
    for (const item of state.build.candidates ?? []) {
      byId[item.id] = describeTemplateStatus(item, context);
    }
    const selectedName = (state.build.candidates ?? []).find((item) => item.id === selectedId)?.name ?? null;
    const lastDiscarded = screenRef ? screenRef.lastDiscarded : null;
    const legend = describeGalleryLegend({
      selectedName,
      referencePending: Boolean(screenRef && screenRef.candidate && !screenRef.adopted),
    });
    return {
      byId,
      hint: legend.hint,
      discardedNote: lastDiscarded && lastDiscarded.templateId !== selectedId
        ? `参考候选「${lastDiscarded.label || '截图生成'}」已放弃，当前使用 ${selectedName || '原模板'}，版本未改动。`
        : null,
    };
  }, [state.build.candidates, state.build.selectedId, state.screenRef]);
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
        setNotice('设置没读出来，已先用默认值。可以点右上角「设置与自检」再读取一次；还是不行就重启应用，或在那里导出日志给我们看。');
      });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    // P5c：先拿到默认导出位置，让「导出到默认位置」在界面上可见、可确认。
    let alive = true;
    if (!isDesktopExportAvailable()) {
      setDefaultTarget({
        status: 'desktop-required',
        path: '',
        token: '',
        message: '浏览器预览不能写出工程；请在桌面应用里导出。',
      });
      return () => { alive = false; };
    }
    fetchDefaultTarget().then((result) => {
      if (!alive) return;
      if (result.status === 'ok') {
        setDefaultTarget({ status: 'ok', path: result.path, token: result.token, message: '' });
        return;
      }
      setDefaultTarget({
        status: result.status,
        path: '',
        token: '',
        message: result.message || '读不到默认导出位置，可以点「选择其他目录」自己指定。',
      });
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
    const doc = toDocument(
      { ...state, frontendCandidate: adoptionStateSlice(frontendCandidateRecord) },
      {
        projectId,
        createdAt: state.project.createdAt,
        appid: state.project.appid,
      },
    );
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
        // P5：候选已采用但快照没写进去时，必须明确告诉用户「界面仍是已采用、磁盘还没落盘」。
        if (frontendCandidateRecord && frontendCandidateRecord.status !== 'none') {
          setNotice('候选已采用，但项目保存失败（' + (result.message || result.code || '未知原因')
            + '）。界面保持已采用状态，恢复磁盘权限/空间后会自动重试保存。');
        }
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
    // 展示补丁（templateId + patch）现在会进 project.json，必须参与自动保存触发，
    // 否则「只改主题色/文案/尺寸」不会落盘，重开就丢。
    state.presentation,
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
    frontendCandidateRecord,
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
    // UX0a-3：没有真实生图服务时，既不调用 generateImage，也不制造"生成中"状态与占位图。
    if (!shouldAutoGenerateImage({
      phase,
      hasImage: Boolean(state.visual.image && state.visual.image.dataUrl),
      imageReviewPhase: PHASES.IMAGE_REVIEW,
    })) return undefined;
    if (imageStarted.current) return undefined;
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

    const hydrated = fromDocument(result.doc, { candidateCheck: result.candidateCheck });
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
    // P5：项目里的候选采用记录 + 主进程对 overlay 的校验结论。
    // 校验通过 → verified（导出放行）；缺失/漂移 → unavailable（安全回退 + 提示 + 导出阻断）。
    const openedCandidate = hydrated.frontendCandidate && hydrated.frontendCandidate.status !== 'none'
      ? hydrated.frontendCandidate
      : null;
    setFrontendCandidateRecord(openedCandidate);
    // 切换项目时清空上一项目的候选构建状态，避免旧候选串到新项目。
    frontendDispatch({ type: 'FRONTEND_RESET', keepImage: false });
    setFrontendLocalError(null);
    const candidateNotice = adoptionNotice(openedCandidate) || hydrated.frontendCandidateNotice;
    if (candidateNotice) setNotice(candidateNotice);
    const presentationNotice = hydrated.presentationRestore;
    if (presentationNotice && presentationNotice.message) setNotice(presentationNotice.message);
    if (result.recoveredFrom) {
      setNotice('项目文件损坏，已从最近一次备份恢复。原文件已保留在项目目录内。');
    } else if (result.corrupt) {
      setNotice('项目文件已损坏且没有可用备份，已以空白项目打开；损坏文件保留在项目目录内。');
    }

    const posterAssetId = result.doc && result.doc.visual && result.doc.visual.imageAssetId;
    if (posterAssetId && service.mode === 'desktop') {
      // UX0b：按已保存的资产 ID 回读预览；读取失败要明确提示，不静默变成"已选好"。
      const asset = await service.readAsset(projectId, posterAssetId, 720).catch(() => null);
      if (asset && asset.status === 'ok' && asset.asset && asset.asset.dataUrl) {
        dispatch({ type: 'SET_POSTER_PREVIEW', dataUrl: asset.asset.dataUrl });
      } else {
        setNotice('海报素材预览读取失败，可以重新选择图片或跳过这一步');
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
    // 新项目没有候选采用记录：清空上一项目的快照记录与候选构建状态。
    setFrontendCandidateRecord(null);
    frontendDispatch({ type: 'FRONTEND_RESET', keepImage: false });
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
      // 删除的正是当前项目：候选采用记录一并清空，避免指向已删除项目。
      if (state.project.activeId === target.projectId) setFrontendCandidateRecord(null);
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

  /**
   * P5：撤销候选采用。
   *
   * 只切换项目快照里的候选记录（上一版 / Base），展示补丁由 presentation 原样保留；
   * 写盘仍走同一条自动保存链路，失败时界面保持撤销后的状态并提示。
   */
  const handleFrontendUndoAdoption = () => {
    if (!frontendCandidateRecord || frontendCandidateRecord.status === 'none') return false;
    const undone = undoAdoptionRecord(frontendCandidateRecord);
    if (!undone.restored) return false;
    setFrontendCandidateRecord(undone.adoption);
    // 撤销后旧的候选构建状态已不代表当前版本：清掉它，避免面板继续显示「已采用」。
    frontendDispatch({ type: 'FRONTEND_RESET', keepImage: true });
    setFrontendLocalError(null);
    const restored = undone.adoption;
    if (!restored) {
      setNotice('已撤销候选采用，当前版本回到 Base 页面（展示补丁保持不变）。');
    } else if (restored.status !== 'adopted') {
      setNotice('已撤销候选采用，恢复到上一版 '
        + restored.candidateId + '@' + restored.candidateVersion
        + '；' + ((restored.issue && restored.issue.message) || '该版本当前不可用')
        + '（展示补丁保持不变）。');
    } else if (restored.verified !== true) {
      // 上一版没有通过校验：撤销只恢复引用，不放行导出；由导出入口继续阻断并提示。
      setNotice('已撤销候选采用，恢复到上一版 '
        + restored.candidateId + '@' + restored.candidateVersion
        + '；该版本还没有校验 overlay 摘要，导出会被阻断（不会静默回退 Base，展示补丁保持不变）。');
    } else {
      setNotice('已撤销候选采用，恢复上一版候选 '
        + restored.candidateId + '@' + restored.candidateVersion + '（展示补丁保持不变）。');
    }
    return true;
  };

  const handleUndo = () => {
    // 候选采用优先撤销：它不在 sessionMachine 的撤销栈里，必须单独处理。
    if (handleFrontendUndoAdoption()) return;
    dispatch({ type: 'UNDO_APPLY' });
  };
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
    // P5：重置项目同时清掉候选采用记录（跟随当前项目，不跨项目残留）。
    setFrontendCandidateRecord(null);
    frontendDispatch({ type: 'FRONTEND_RESET', keepImage: false });
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
    // UX0a-3：没有真实生图服务时不存在"重新生成"，只如实说明。
    if (!canGenerateImage()) {
      setNotice(IMAGE_GENERATION_BLOCKED_REASON);
      return;
    }
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

    const previewPlan = buildExportPlanFromSession(frontendStateWithCandidate);
    if (!previewPlan.ok) {
      // P5：已采用候选但 overlay 缺失/漂移/未校验 → 预览也阻断，不静默用 Base 顶替。
      return { ok: false, message: previewPlan.message || '候选前端 overlay 未确认，已阻止生成预览工程。' };
    }
    const { plan, warnings } = previewPlan;
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
      candidateOverlay: frontendCandidateOverlay,
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
  }, [state, frontendStateWithCandidate, frontendCandidateOverlay]);

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
        const shot = {
          dataUrl: result.dataUrl,
          name: typeof result.name === 'string' && result.name ? result.name : '未命名截图',
          bytes: Number.isFinite(result.bytes) ? result.bytes : undefined,
        };
        setRealPreview((prev) => ({
          busy: false,
          error: null,
          screenshots: prev.screenshots.length >= 4
            ? [...prev.screenshots.slice(1), shot]
            : [...prev.screenshots, shot],
        }));
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
    setRealPreview({ screenshots: [], busy: false, error: null });
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
    // 冻结发送时刻的草稿与版本号：回复到达时两项都匹配才允许整份应用。
    const frozenDraft = state.agentDraft;
    const frozenRevision = state.agent.draftRevision;
    const frozenImageCount = images.length;
    const route = resolveAgentRequestRoute({
      phase: 'store-info',
      imageCount: frozenImageCount,
      transportMode: describeAgentTransport().mode,
    });
    dispatch(retry
      ? { type: 'AGENT_TURN_RETRY', requestId, draftRevision: frozenRevision }
      : { type: 'AGENT_TURN_REQUEST', utterance: text, requestId, draftRevision: frozenRevision });
    try {
      const result = isAgentRunRoute(route)
        ? await requestAgentRun({ utterance: text, draft: frozenDraft, requestId })
        : await requestAgentTurn({
          utterance: text,
          draft: frozenDraft,
          ...(images.length ? { images } : {}),
          simulateFailureOnce: state.agent.simulateFailure,
        });
      const imagesAddedDuringRequest = agentImagesRef.current > frozenImageCount;
      dispatch({
        type: 'AGENT_TURN_SUCCESS',
        ...result,
        requestId,
        draftRevision: frozenRevision,
        imagesAddedDuringRequest,
      });
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

  // ---- P3：参考截图 → 识别 → 确认 → 候选模板 ----

  const readFileAsDataUrl = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(new Error('SCREEN_REF_READ_FAILED'));
    reader.readAsDataURL(file);
  });

  /** 上传入口：桌面模式走主进程选图并落盘；浏览器模式回落到 file input。 */
  const handleScreenRefPick = async (openFileInput) => {
    setScreenRefError(null);
    const service = projectServiceRef.current;
    if (service.mode !== 'desktop') {
      setScreenRefPersisted(false);
      if (typeof openFileInput === 'function') openFileInput();
      return;
    }
    if (!projectId) {
      setScreenRefError('请先在工作台新建或打开一个项目，再上传参考截图。');
      return;
    }
    try {
      const picked = await service.pickImages(1);
      if (picked.status !== 'ok') {
        setScreenRefError(picked.message || '选择图片失败，请重试。');
        return;
      }
      const item = Array.isArray(picked.items) ? picked.items[0] : null;
      // 用户取消选图：保持现状。
      if (!item) return;
      const attached = await service.attachImages(projectId, [item.token]);
      if (attached.status !== 'ok') {
        setScreenRefError(attached.message || '保存截图失败，请重试。');
        return;
      }
      const asset = Array.isArray(attached.assets) ? attached.assets[0] : null;
      if (!asset || !asset.assetId) {
        setScreenRefError('保存截图失败，请重试。');
        return;
      }
      const read = await service.readAsset(projectId, asset.assetId, 1280);
      const dataUrl = read && read.status === 'ok' && read.asset ? read.asset.dataUrl : '';
      const dataBase64 = typeof dataUrl === 'string' && dataUrl.includes(',') ? dataUrl.split(',')[1] : '';
      const image = {
        assetId: asset.assetId,
        name: asset.originalName || item.name || '参考截图',
        mediaType: asset.mime || item.mime,
        bytes: Number.isFinite(asset.bytes) ? asset.bytes : item.bytes,
        dataBase64,
        previewUrl: dataUrl,
      };
      const check = validateReferenceImage(image);
      if (!check.ok) {
        setScreenRefError(check.message);
        return;
      }
      setScreenRefPersisted(true);
      dispatch({ type: 'SCREEN_REF_IMAGE_SET', image });
    } catch (error) {
      setScreenRefError('上传截图失败，请重试。');
    }
  };

  /** 浏览器模式：直接从 file input 读成 dataURL（只在内存里，不落盘）。 */
  const handleScreenRefFile = async (file) => {
    setScreenRefError(null);
    if (!file) return;
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const dataBase64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : '';
      const image = {
        assetId: null,
        name: file.name || '参考截图',
        mediaType: file.type,
        bytes: file.size,
        dataBase64,
        previewUrl: dataUrl,
      };
      const check = validateReferenceImage(image);
      if (!check.ok) {
        setScreenRefError(check.message);
        return;
      }
      dispatch({ type: 'SCREEN_REF_IMAGE_SET', image });
    } catch (error) {
      setScreenRefError('读取截图失败，请重新选择。');
    }
  };

  const handleScreenRefRecognize = async () => {
    if (screenRefBusy.current) return;
    const current = state.screenRef.image;
    if (!current) return;
    screenRefBusy.current = true;
    setScreenRefError(null);
    const requestId = createScreenReferenceRequestId();
    const imageRevision = state.screenRef.imageRevision;
    dispatch({ type: 'SCREEN_REF_REQUEST', requestId });
    try {
      const result = await requestScreenReference({
        image: current,
        draft: state.agentDraft,
        requestId,
      });
      if (result.ok) {
        dispatch({
          type: 'SCREEN_REF_SUCCESS',
          requestId,
          imageRevision,
          recognition: result.recognition,
          meta: result.meta,
        });
      } else {
        dispatch({
          type: 'SCREEN_REF_FAILURE',
          requestId,
          message: result.message,
          degraded: result.degraded,
        });
      }
    } catch (error) {
      dispatch({
        type: 'SCREEN_REF_FAILURE',
        requestId,
        message: '识别没有成功，可以直接重试。',
        degraded: false,
      });
    } finally {
      screenRefBusy.current = false;
    }
  };

  const handleScreenRefConfirm = () => dispatch({
    type: 'SCREEN_REF_CONFIRM',
    at: new Date().toISOString(),
  });

  const handleScreenRefCreateCandidate = () => dispatch({
    type: 'SCREEN_REF_CREATE_CANDIDATE',
    baseRecipeId: state.build.selectedId ?? null,
    at: new Date().toISOString(),
  });

  const handleScreenRefAdopt = () => dispatch({ type: 'SCREEN_REF_ADOPT' });
  const handleScreenRefDiscard = () => dispatch({ type: 'SCREEN_REF_DISCARD' });
  const handleScreenRefRetry = () => handleScreenRefRecognize();
  const handleScreenRefReset = () => {
    setScreenRefError(null);
    dispatch({ type: 'SCREEN_REF_RESET' });
  };

  // ---- P4：参考截图 → 受控候选前端（生成候选前端主链） ----
  // 业务判断都在 src/domain/frontendReconstruct.mjs，这里只做「调用 + 派发」。
  const frontendProjectId = () => state.project.activeId || 'unscoped-project';

  const handleFrontendUtterance = (value) => {
    frontendDispatch({ type: 'FRONTEND_INPUT_SET', utterance: value });
  };

  const handleFrontendTargetPages = (pages) => {
    frontendDispatch({ type: 'FRONTEND_INPUT_SET', targetPages: pages });
  };

  const handleFrontendAnalyze = async () => {
    // 重复点击：忙碌时直接忽略（reducer 也会拒绝第二次 REQUEST）。
    if (isFrontendBusy(frontendState)) return;
    const image = state.screenRef.image;
    if (!image) {
      setFrontendLocalError('请先上传一张参考截图，再生成候选前端。');
      return;
    }
    setFrontendLocalError(null);
    const runId = createFrontendRunId();
    const revision = frontendState.revision;
    frontendDispatch({ type: 'FRONTEND_ANALYZE_REQUEST', runId, revision });
    const result = await frontendService.analyze({
      runId,
      projectId: frontendProjectId(),
      utterance: frontendState.request.utterance,
      image,
      targetPages: frontendState.request.targetPages,
      baseTemplate: frontendState.request.baseTemplate,
    });
    if (!result.ok) {
      if (result.code === 'FRONTEND_CANCELLED') {
        frontendDispatch({ type: 'FRONTEND_CANCELLED', runId, revision });
      } else {
        frontendDispatch({
          type: 'FRONTEND_ANALYZE_FAILURE',
          runId,
          revision,
          error: { code: result.code, message: result.message },
        });
      }
      return;
    }
    frontendDispatch({ type: 'FRONTEND_ANALYZE_SUCCESS', runId, revision, response: result.response });
  };

  const handleFrontendBuild = async () => {
    if (isFrontendBusy(frontendState)) return;
    const draft = frontendState.analysis && frontendState.analysis.draft ? frontendState.analysis.draft : null;
    if (!draft || !frontendState.runId) {
      setFrontendLocalError('没有可构建的草稿，请先重新生成候选前端。');
      return;
    }
    setFrontendLocalError(null);
    const runId = frontendState.runId;
    const revision = frontendState.revision;
    frontendDispatch({ type: 'FRONTEND_BUILD_REQUEST' });
    const result = await frontendService.buildCandidate({
      projectId: frontendProjectId(),
      runId,
      draft,
    });
    if (!result.ok) {
      if (result.code === 'FRONTEND_CANCELLED') {
        frontendDispatch({ type: 'FRONTEND_CANCELLED', runId, revision });
      } else {
        frontendDispatch({
          type: 'FRONTEND_BUILD_FAILURE',
          runId,
          revision,
          error: { code: result.code, message: result.message },
        });
      }
      return;
    }
    frontendDispatch({ type: 'FRONTEND_BUILD_SUCCESS', runId, revision, result });
  };

  const handleFrontendVerify = async () => {
    if (isFrontendBusy(frontendState) || !frontendState.candidate) return;
    const { runId, revision, candidate } = frontendState;
    const identity = { runId, revision, candidateId: candidate.candidateId, attempt: candidate.attempt };
    frontendDispatch({ type: 'FRONTEND_VERIFY_REQUEST', ...identity });
    const result = await frontendService.verifyCandidate({
      projectId: frontendProjectId(),
      runId,
      attempt: candidate.attempt,
    });
    if (!result.ok) {
      if (result.code === 'FRONTEND_CANCELLED') {
        frontendDispatch({ type: 'FRONTEND_CANCELLED', runId, revision });
      } else {
        frontendDispatch({
          type: 'FRONTEND_VERIFY_FAILURE',
          ...identity,
          error: { code: result.code, message: result.message },
        });
      }
      return;
    }
    frontendDispatch({ type: 'FRONTEND_VERIFY_SUCCESS', ...identity, result });
  };

  // 复核（只读重查 dry-run 证据与 overlay）：同样是候选级动作，必须带身份。
  const handleFrontendValidate = async () => {
    if (isFrontendBusy(frontendState) || !frontendState.candidate) return;
    const { runId, revision, candidate } = frontendState;
    const identity = { runId, revision, candidateId: candidate.candidateId, attempt: candidate.attempt };
    frontendDispatch({ type: 'FRONTEND_VALIDATE_REQUEST', ...identity });
    const result = await frontendService.validateCandidate({
      projectId: frontendProjectId(),
      runId,
      attempt: candidate.attempt,
    });
    if (!result.ok) {
      if (result.code === 'FRONTEND_CANCELLED') {
        frontendDispatch({ type: 'FRONTEND_CANCELLED', runId, revision });
      } else {
        frontendDispatch({
          type: 'FRONTEND_VALIDATE_FAILURE',
          ...identity,
          error: { code: result.code, message: result.message },
        });
      }
      return;
    }
    frontendDispatch({ type: 'FRONTEND_VALIDATE_SUCCESS', ...identity, result });
  };

  const handleFrontendAdopt = async (partialConfirmed) => {
    if (!frontendView.canAdopt || !frontendState.candidate) return;
    const { runId, revision, candidate } = frontendState;
    const identity = { runId, revision, candidateId: candidate.candidateId, attempt: candidate.attempt };
    if (frontendView.adoptNeedsPartialConfirm && partialConfirmed !== true) {
      // 让 reducer 给出「需要单独确认 partial」的明确错误，而不是静默无反应。
      frontendDispatch({ type: 'FRONTEND_ADOPT_REQUEST', ...identity, partialConfirmed: false });
      return;
    }
    const confirmed = partialConfirmed === true;
    frontendDispatch({ type: 'FRONTEND_ADOPT_REQUEST', ...identity, partialConfirmed: confirmed });
    const result = await frontendService.adoptCandidate({
      projectId: frontendProjectId(),
      runId,
      attempt: candidate.attempt,
      partialConfirmed: confirmed,
    });
    if (!result.ok) {
      frontendDispatch({
        type: 'FRONTEND_ADOPT_FAILURE',
        ...identity,
        error: { code: result.code, message: result.message },
      });
      // 采用失败：不清空输入/候选，只提示；项目快照保持不变。
      setNotice(result.message || '采用候选前端没有成功，当前版本保持不变。');
      return;
    }
    // P5：采用成功 → 立刻把「同一个候选 overlay」写进项目快照（含上一版一层）。
    // Plan 引用用 domain 的 buildPlanFromSession 现算，避免 App 自己拼 Plan。
    const projectId = frontendProjectId();
    const runtimeStatus = (frontendState.runtimeVerification && frontendState.runtimeVerification.status)
      || (result.adoption && result.adoption.runtimeStatus)
      || 'NOT_RUN';
    let planRef = null;
    try {
      planRef = buildPlanFromSession({
        ...state,
        frontendCandidate: {
          status: 'adopted',
          candidateId: candidate.candidateId,
          candidateVersion: candidate.candidateVersion,
          integrity: candidate.digest || null,
          runId,
          projectId,
          attempt: candidate.attempt,
          verified: true,
          verification: {
            static: 'pass',
            runtime: runtimeStatus,
            repairs: frontendState.runtimeVerification && Number.isInteger(frontendState.runtimeVerification.repairs)
              ? frontendState.runtimeVerification.repairs
              : 0,
          },
        },
      }).plan;
    } catch (error) {
      planRef = null;
    }
    const record = buildAdoptionRecord({
      candidate,
      runId,
      projectId,
      adoptionResult: result.adoption,
      runtimeVerification: frontendState.runtimeVerification,
      plan: planRef,
      previous: frontendCandidateRecord,
    });
    if (record) setFrontendCandidateRecord(record);
    setNotice(record && record.status === 'adopted'
      ? '已采用候选前端，项目快照已更新；重开项目会自动校验 overlay 摘要。'
      : '已采用候选前端，但快照记录不完整（缺少 overlay 引用或摘要），导出会被阻断；请重新构建/采用一次。');
    frontendDispatch({ type: 'FRONTEND_ADOPT_SUCCESS', ...identity, adoption: result.adoption });
  };

  const handleFrontendDiscard = async () => {
    if (isFrontendBusy(frontendState) || !frontendState.candidate) return;
    const { runId, revision, candidate } = frontendState;
    const identity = { runId, revision, candidateId: candidate.candidateId, attempt: candidate.attempt };
    frontendDispatch({ type: 'FRONTEND_DISCARD_REQUEST', ...identity });
    const result = await frontendService.discardCandidate({
      projectId: frontendProjectId(),
      runId,
      attempt: candidate.attempt,
    });
    if (!result.ok) {
      frontendDispatch({
        type: 'FRONTEND_DISCARD_FAILURE',
        ...identity,
        error: { code: result.code, message: result.message },
      });
      return;
    }
    frontendDispatch({ type: 'FRONTEND_DISCARD_SUCCESS', ...identity });
  };

  const handleFrontendCancel = async () => {
    if (!isFrontendBusy(frontendState)) return;
    const { runId, revision } = frontendState;
    frontendDispatch({ type: 'FRONTEND_CANCEL_REQUEST', runId, revision });
    const result = await frontendService.cancelRun({ projectId: frontendProjectId(), runId });
    if (result.ok) frontendDispatch({ type: 'FRONTEND_CANCELLED', runId, revision });
  };

  const handleFrontendRetry = () => {
    setFrontendLocalError(null);
    frontendDispatch({ type: 'FRONTEND_RETRY' });
  };

  const handleFrontendReset = () => {
    setFrontendLocalError(null);
    frontendDispatch({ type: 'FRONTEND_RESET', keepImage: true });
  };

  useEffect(() => {
    const unsubscribe = frontendService.onProgress((payload) => {
      frontendDispatch({
        type: 'FRONTEND_PROGRESS',
        runId: payload.runId,
        stage: payload.stage,
        attempt: payload.attempt,
      });
    });
    return unsubscribe;
  }, [frontendService]);

  // P6：只记录「真实发生」的候选前端耗时：新 runId 开始计时，到终态定格一次。
  // 不按渲染次数/固定步数估算，也不在 runId 缺失时编一个开始时间。
  useEffect(() => {
    const runId = frontendState.runId;
    setFrontendTiming((prev) => {
      if (!runId) {
        return prev.runId === null ? prev : { runId: null, startedAt: null, endedAt: null };
      }
      if (prev.runId !== runId) {
        return { runId, startedAt: Date.now(), endedAt: null };
      }
      if (prev.endedAt === null && FRONTEND_TERMINAL_STATUSES.has(frontendState.status)) {
        return { ...prev, endedAt: Date.now() };
      }
      return prev;
    });
  }, [frontendState.runId, frontendState.status]);

  // 参考截图只有一份：旧识别区选了图，候选前端主链立刻能看到同一张图。
  // reducer 对同一张图是 no-op，不会引起重复渲染或额外 revision。
  useEffect(() => {
    if (!state.screenRef.image) return;
    frontendDispatch({ type: 'FRONTEND_INPUT_SET', image: state.screenRef.image });
  }, [state.screenRef.image]);

  const handleComposerSubmit = (value) => {
    // W4：空白/超长在 Composer 已拦住，这里再兜一层；连续点击/连按回车只放行一次。
    const analysis = analyzeComposerInput(value);
    if (!analysis.canSubmit) return;
    if (!submitGuardRef.current.accept(analysis.text)) return;
    const text = analysis.text;
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
      // UX0a-3：该阶段不提供生成/重新生成入口，这里只兜底说明，不再触发任何生成。
      setNotice(IMAGE_GENERATION_BLOCKED_REASON);
      setDraft('');
    }
  };

  // UX0b：海报素材走已有本地资产链路 ——
  // 主进程选图(pickImages) → 落盘(attachImages) → 回读预览(readAsset)。
  // 渲染进程不读磁盘、不拼 dataUrl；只有资产真的保存成功才允许"使用此图并继续"。
  const handlePickPoster = async () => {
    if (posterBusy) return;
    const service = projectServiceRef.current;
    const projectId = state.project.activeId;
    if (service.mode !== 'desktop') {
      setNotice('浏览器模式不会把图片写进项目，请在桌面应用中上传海报素材');
      return;
    }
    if (!projectId) {
      setNotice('请先在工作台新建或打开项目，再上传海报素材');
      return;
    }
    setPosterBusy(true);
    try {
      const picked = await service.pickImages(1);
      if (picked.status !== 'ok') {
        setNotice(picked.message || '选择图片失败，请重试');
        return;
      }
      const item = Array.isArray(picked.items) ? picked.items[0] : null;
      // 用户取消选择：保持现状（已有素材不动）。
      if (!item) return;
      if (item.mime !== 'image/png') {
        setNotice('海报素材目前只支持 PNG 图片，请重新选择');
        return;
      }
      if (Number.isFinite(item.bytes) && item.bytes > MAX_POSTER_UPLOAD_BYTES) {
        // 超限直接不上传：之前已选的素材保持不变。
        setNotice('图片超过 2 MB，请压缩后再上传');
        return;
      }
      const attached = await service.attachImages(projectId, [item.token]);
      if (attached.status !== 'ok') {
        setNotice(attached.message || '保存图片失败，请重试');
        return;
      }
      const asset = Array.isArray(attached.assets) ? attached.assets[0] : null;
      if (!asset || !asset.assetId) {
        setNotice('保存图片失败，请重试');
        return;
      }
      if (asset.mime !== 'image/png') {
        setNotice('海报素材目前只支持 PNG 图片，请重新选择');
        return;
      }
      if (Number.isFinite(asset.bytes) && asset.bytes > MAX_POSTER_UPLOAD_BYTES) {
        setNotice('图片超过 2 MB，请压缩后再上传');
        return;
      }
      const preview = await service.readAsset(projectId, asset.assetId, 720);
      if (preview.status !== 'ok' || !preview.asset || !preview.asset.dataUrl) {
        // 资产可能已落盘，但预览读不出来：明确提示，不假装成功、也不改已有素材。
        setNotice('图片已保存，但预览读取失败，请重新选择图片');
        return;
      }
      dispatch({
        type: 'SET_POSTER_ASSET',
        assetId: asset.assetId,
        meta: {
          provider: 'user-upload',
          width: asset.width,
          height: asset.height,
          note: '你上传的图片，不是模型生成结果',
        },
        preview: preview.asset.dataUrl,
      });
      setNotice('海报素材已保存到项目');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '保存图片失败，请重试');
    } finally {
      setPosterBusy(false);
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
      // UX0b：海报素材只传受控引用（项目 ID + 资产 ID），字节由主进程读取。
      const result = await exportProject({
        parentDir: directory,
        plan,
        projectName,
        mode: 'development',
        projectId: state.project.activeId || null,
        posterAssetId: state.visual.imageAssetId || null,
        candidateOverlay: frontendCandidateOverlay,
      });
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
    const exportPlan = buildExportPlanFromSession(frontendStateWithCandidate);
    if (!exportPlan.ok) {
      // P5：已采用候选但 overlay 缺失/漂移/未校验 → 阻断导出，绝不静默回落 Base。
      dispatch({
        type: 'DEPLOY_FAILURE',
        error: { code: exportPlan.code || 'FRONTEND_OVERLAY_MISSING', message: exportPlan.message || '候选前端 overlay 未确认，已阻止导出。' },
      });
      setNotice(exportPlan.message || '候选前端 overlay 未确认，已阻止导出（不会静默回退 Base）。');
      return;
    }
    const { plan, warnings } = exportPlan;
    const projectName = sanitizeProjectName(state.store.name || state.agentDraft.storeName);
    await runDeployExport(chosen.path, plan, projectName, warnings);
  };

  const handleDeployExportDefault = async () => {
    if (deployBusy.current) return;
    const gate = selectCanChooseDirectory(state);
    if (!gate.can) {
      setNotice(`还不能导出：${gate.reason}`);
      return;
    }
    if (!isDesktopExportAvailable()) {
      dispatch({
        type: 'DEPLOY_FAILURE',
        error: { code: 'DESKTOP_REQUIRED', message: DESKTOP_REQUIRED_MESSAGE },
      });
      return;
    }

    // 默认位置只由主进程提供；这里再取一次是为了防止启动时那次读取失败。
    let parentDir = defaultTarget.status === 'ok' ? defaultTarget.path : '';
    if (!parentDir) {
      const fetched = await fetchDefaultTarget();
      if (fetched.status !== 'ok') {
        dispatch({
          type: 'DEPLOY_FAILURE',
          error: {
            code: fetched.code || 'TARGET_PARENT_MISSING',
            message: fetched.message || '读不到默认导出位置，请点「选择其他目录」指定一个。',
          },
        });
        return;
      }
      parentDir = fetched.path;
      setDefaultTarget({ status: 'ok', path: fetched.path, token: fetched.token, message: '' });
    }

    dispatch({ type: 'DEPLOY_START' });
    const exportPlan = buildExportPlanFromSession(frontendStateWithCandidate);
    if (!exportPlan.ok) {
      dispatch({
        type: 'DEPLOY_FAILURE',
        error: { code: exportPlan.code || 'FRONTEND_OVERLAY_MISSING', message: exportPlan.message || '候选前端 overlay 未确认，已阻止导出。' },
      });
      setNotice(exportPlan.message || '候选前端 overlay 未确认，已阻止导出（不会静默回退 Base）。');
      return;
    }
    const { plan, warnings } = exportPlan;
    const projectName = sanitizeProjectName(state.store.name || state.agentDraft.storeName);
    await runDeployExport(parentDir, plan, projectName, warnings);
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
    const exportPlan = buildExportPlanFromSession(frontendStateWithCandidate);
    if (!exportPlan.ok) {
      dispatch({
        type: 'DEPLOY_FAILURE',
        error: { code: exportPlan.code || 'FRONTEND_OVERLAY_MISSING', message: exportPlan.message || '候选前端 overlay 未确认，已阻止导出。' },
      });
      setNotice(exportPlan.message || '候选前端 overlay 未确认，已阻止导出（不会静默回退 Base）。');
      return;
    }
    await runDeployExport(directory, exportPlan.plan, projectName, exportPlan.warnings);
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
        const exportPlan = buildExportPlanFromSession(frontendStateWithCandidate);
        if (!exportPlan.ok) {
          // P5：候选缺失/漂移/未校验时，体检也必须报错（导出会被阻断）。
          merged = mergeComposerResult(local, {
            ok: false,
            code: exportPlan.code || 'FRONTEND_OVERLAY_MISSING',
            message: exportPlan.message || '候选前端 overlay 未确认，已阻止导出。',
          });
        } else {
          const result = await validatePlan(exportPlan.plan, { candidateOverlay: frontendCandidateOverlay });
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
      }
      // 已有导出位置时提前暴露同名冲突；没有任何位置信息时不伪造目标路径。
      // P5c：用户没手动选目录时，用主进程给的默认位置做同一套只读检查。
      const rawTargetName = String(state.deploy.projectName || state.store.name || state.agentDraft.storeName || '').trim();
      const preflightParent = state.deploy.directory
        || (defaultTarget.status === 'ok' ? (defaultTarget.token || defaultTarget.path) : '');
      if (desktop && preflightParent && rawTargetName) {
        const projectNameForCheck = sanitizeProjectName(rawTargetName);
        let target = await preflightTarget({ parentDir: preflightParent, projectName: projectNameForCheck });
        // P5c：记住的老目录已经不可用时，自动改查默认位置；
        // 默认位置可用就忘掉老目录，别让用户点着一个永远失败的按钮。
        if (
          target.status === 'failed'
          && state.deploy.directory
          && defaultTarget.status === 'ok'
        ) {
          const fallback = await preflightTarget({
            parentDir: defaultTarget.token || defaultTarget.path,
            projectName: projectNameForCheck,
          });
          if (fallback.status === 'ok' || fallback.status === 'conflict') {
            dispatch({ type: 'DEPLOY_FORGET_DIRECTORY' });
            target = fallback;
          }
        }
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
          <>
            {state.phaseReturn && state.phaseReturn.phase === PHASES.DEPLOY ? (
              <div className="phase-return-banner" role="note">
                <span>你正在从部署页查看能力勾选。确认完可直接返回部署，已确认的提示与导出记录都会保留。</span>
                <button type="button" className="ghost" onClick={() => dispatch({ type: 'PHASE_RETURN' })}>
                  返回部署
                </button>
              </div>
            ) : null}
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
          </>
        );
      case PHASES.TEMPLATE_PICK:
        return (
          <>
            {templateStatus.discardedNote ? (
              <p className="template-discarded-note" role="status">{templateStatus.discardedNote}</p>
            ) : null}
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
              statusById={templateStatus.byId}
              statusHint={templateStatus.hint}
            />
          </>
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
        // P3：参考截图 → 候选模板。识别/确认/候选都在这一步完成，不覆盖当前版本。
        // P4：同屏再挂「生成候选前端」主链（截图共享，状态各管各的）。
        const frontendCandidatePanel = (
          <FrontendCandidatePanel
            view={frontendView}
            imageReady={Boolean(state.screenRef.image)}
            desktopMode={frontendService.mode === 'desktop'}
            localError={frontendLocalError}
            onUtteranceChange={handleFrontendUtterance}
            onTargetPagesChange={handleFrontendTargetPages}
            onAnalyze={handleFrontendAnalyze}
            onBuild={handleFrontendBuild}
            onVerify={handleFrontendVerify}
            onValidate={handleFrontendValidate}
            onAdopt={handleFrontendAdopt}
            onDiscard={handleFrontendDiscard}
            onCancel={handleFrontendCancel}
            onRetry={handleFrontendRetry}
            onReset={handleFrontendReset}
          />
        );
        const screenRefPanel = (
          <ScreenReferencePanel
            view={state.screenRef.view}
            busy={state.screenRef.status === 'recognizing'}
            localError={screenRefError}
            persisted={screenRefPersisted}
            frontendPanel={frontendCandidatePanel}
            onPick={handleScreenRefPick}
            onPickFile={handleScreenRefFile}
            onRecognize={handleScreenRefRecognize}
            onConfirm={handleScreenRefConfirm}
            onCreateCandidate={handleScreenRefCreateCandidate}
            onAdopt={handleScreenRefAdopt}
            onDiscard={handleScreenRefDiscard}
            onRetry={handleScreenRefRetry}
            onReset={handleScreenRefReset}
          />
        );
        if (agent.status === 'confirmed') {
          // 资料已确认：附加材料默认折叠，避免「摘要卡 + 上传卡 + 表单卡」三层堆叠。
          const attachOpen = Boolean(
            state.screenRef.candidate
            || state.screenRef.image
            || agentImages.length > 0,
          );
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
              <AttachGroup
                defaultOpen={attachOpen}
                hint="资料已确认。需要换骨架或补充图片时再展开，不会自动改动当前版本。"
              >
                {screenRefPanel}
                {visionUploader}
              </AttachGroup>
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
              process={agent.process}
              processHistory={agent.processHistory}
              staleDraftNotice={agent.staleDraftNotice}
              hint={agent.hint}
              onRetry={handleAgentRetry}
              onToggleSimulateFailure={handleSimulateFailure}
            />
            <AttachGroup defaultOpen>
              {screenRefPanel}
              {visionUploader}
            </AttachGroup>
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
            assetId={state.visual.imageAssetId ?? null}
            busy={posterBusy}
            onPick={handlePickPoster}
            onUse={() => {
              if (!state.visual.imageAssetId) {
                setNotice('图片还没有保存到项目，请重新选择图片');
                return;
              }
              dispatch({ type: 'APPROVE_IMAGE', material: 'uploaded' });
            }}
            onSkip={() => dispatch({ type: 'APPROVE_IMAGE', material: 'skipped' })}
            canGenerate={canGenerateImage()}
            generateBlockedReason={IMAGE_GENERATION_BLOCKED_REASON}
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
              projectName={state.deploy.projectName || sanitizeProjectName(state.store.name || state.agentDraft.storeName)}
              result={state.deploy.result}
              error={state.deploy.error}
              previewOnly={state.deploy.previewOnly}
              versionGaps={state.deploy.versionGaps}
              warnings={state.deploy.warnings}
              busy={state.deploy.busy}
              blockedReason={chooseGate.can ? null : chooseGate.reason}
              defaultDirectory={defaultTarget.status === 'ok' ? defaultTarget.path : ''}
              defaultDirectoryError={defaultTarget.status === 'ok' ? null : (defaultTarget.message || null)}
              onExportDefault={handleDeployExportDefault}
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
                screenshots={realPreview.screenshots}
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
  // UX0a-3：海报素材（可选）阶段没有真实生图服务，不再提供"重新生成"输入区。
  const composerVisible = phase === PHASES.STORE_INFO
    ? agentComposer.visible
    : (phase === PHASES.IMAGE_REVIEW ? false : COMPOSER_PHASES.includes(phase));
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
                    messages={conversationMessages.messages}
                    revealKey={conversationMessages.revealKey}
                    flushKey={activeSession.revealFlush ?? 0}
                    revealAll={conversationMessages.revealAll}
                    // P6：候选前端流程的过程卡（安全视图）。只在「开店资料」阶段、且有真实
                    // trace/进度时传入；null 时 ChatStream 不渲染任何过程区块，避免假进度。
                    process={phase === PHASES.STORE_INFO ? frontendProcessSummary : null}
                  >
                    {phase !== PHASES.BUILDING ? (
                      <>
                        <FlowStepper
                          flow={flowDescriptor}
                          onBack={(target) => dispatch({ type: 'PHASE_GOTO', phase: target.phase })}
                        />
                        {renderStage()}
                      </>
                    ) : null}
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