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
import { buildExportReview } from './domain/exportReview.mjs';
import { buildSignatureParts, describeSignatureDrift } from './domain/planSignature.mjs';
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
import { buildImportPayload, previewImport, applyImport, prepareProjectPreview, DEFAULT_STORE_ID } from './services/importService.js';
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
  selectAgentChatState,
} from './state/sessionMachine.mjs';
import { formatCents } from './domain/agentDraft.mjs';
import { analyzeComposerInput, createSubmitGuard } from './domain/composerInput.mjs';
// 项目级 Agent 对话（右侧栏）的纯函数口径：能否发送、本轮路由、安全过程视图。
// App 只做接线与派发，判断与文案全部来自 domain/agentSidebar.mjs，不在这里另写一套。
import {
  CHAT_STATUS,
  buildAgentChatSubmitPlan,
  isValidChatDraft,
  normalizeChatRun,
} from './domain/agentSidebar.mjs';
import { toDocument, fromDocument } from './domain/projectSnapshot.mjs';
import { buildProposalApplyPlan } from './domain/appAssistantProposal.mjs';
import { requestAppAssistant } from './services/appAssistant/appAssistantService.js';
import { executeAppAssistantActions, selectUnexecutedActions, APP_ASSISTANT_ACTION_HANDLERS } from './services/appAssistant/actionExecutor.js';
import { describePendingConfirmations } from './domain/agentPendingConfirm.mjs';
import { findAppCapabilityField } from './domain/appCapabilities.mjs';
import { evaluateLocal, mergeComposerResult, mergeTargetPreflight } from './domain/preflightRules.mjs';
import { createProjectService } from './services/projectService.js';
import { createProjectThumbnailLoader } from './services/projectThumbnailLoader.js';
import { createSettingsService } from './services/settingsService.js';
import { createDiagnosticsService } from './services/diagnosticsService.js';
import { createAppidService } from './services/appidService.js';
import { createDevtoolsService } from './services/devtoolsService.js';
import { requestAgentTurn, describeAgentTransport, configureAgentRuntime, getAgentTransportConfig, getModelConfig } from './services/agentTurn/agentTurnService.js';
import { requestAgentRun, isAgentRunRoute, resolveAgentRequestRoute } from './services/agentTurn/agentRunService.js';
import { prepareImageFile, toAgentTurnImages } from './services/agentTurn/agentImageUpload.js';
import { AGENT_IMAGE_LIMITS } from './domain/agentImageInput.mjs';
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
  resolveFrontendGenerationIntent,
} from './domain/frontendReconstruct.mjs';
import { buildFrontendProcessView } from './domain/agentRunProcess.mjs';
// 右侧栏「Agent 对话」的过程卡同样复用既有安全过程视图（工具标签白名单），不另写一份。
import { buildProcessView } from './domain/agentRunProcess.mjs';
import { createFrontendReconstructService } from './services/frontendReconstruct/frontendReconstructService.js';
import {
  adoptionNotice,
  adoptionStateSlice,
  buildAdoptionRecord,
  candidateOverlayFromAdoption,
  undoAdoptionRecord,
} from './services/frontendReconstruct/adoptionBridge.js';
import { describeFlow } from './domain/flowStages.mjs';
import { selectAgentWaitingHint } from './domain/agentWaiting.mjs';
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
// G1：真实 AI 生图（第三方服务，经本地后端适配）。
import {
  fetchPosterStatus,
  fetchPosterPrompt,
  generatePoster,
  describePosterError,
} from './services/posterService.js';

import AppShell from './components/layout/AppShell.jsx';
import ConfirmDialog from './components/common/ConfirmDialog.jsx';
import EnvGuideDialog from './components/onboarding/EnvGuideDialog.jsx';
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
import StoreInfoSections from './components/flow/StoreInfoSections.jsx';
import RealPreviewPanel from './components/preview/RealPreviewPanel.jsx';
import DevtoolsPreviewDock from './components/preview/DevtoolsPreviewDock.jsx';
import StoreInfoStep from './components/build/StoreInfoStep.jsx';
import PromptStudio from './components/build/PromptStudio.jsx';
import ImageReview from './components/build/ImageReview.jsx';
import DeployStep from './components/build/DeployStep.jsx';
import ImportDiffCard from './components/build/ImportDiffCard.jsx';
import AgentIntakePanel from './components/agent/AgentIntakePanel.jsx';
import VisionImageUploader from './components/agent/VisionImageUploader.jsx';
import ScreenReferencePanel from './components/screenRef/ScreenReferencePanel.jsx';
import FrontendCandidatePanel from './components/screenRef/FrontendCandidatePanel.jsx';
import {
  createScreenConsent,
  describeScreenSendNotice,
  endpointHostOf,
  imageDigestOf,
  isScreenConsentUsable,
} from './domain/screenConsent.mjs';
import DraftEditor from './components/agent/DraftEditor.jsx';
import StoreInfoActionBar from './components/agent/StoreInfoActionBar.jsx';
import AgentDraftSummary from './components/agent/AgentDraftSummary.jsx';
import ProjectWorkbench from './components/workbench/ProjectWorkbench.jsx';
import SettingsPanel from './components/settings/SettingsPanel.jsx';
import PreflightPanel from './components/deploy/PreflightPanel.jsx';
import ExportReviewCard from './components/deploy/ExportReviewCard.jsx';
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
 * 候选微信验证与最终预览共用同一个「开发 AppID」解析口径：
 * 项目已有 AppID 就用项目值，否则用本机长期在用的开发测试号；
 * 只有这一处定义回退值，避免两条链路写入不同身份。
 */
const DEFAULT_PREVIEW_APPID = 'wx3b1c04f63cf6cfd0';

function resolvePreviewAppId(project) {
  return String((project && project.appid) || '').trim() || DEFAULT_PREVIEW_APPID;
}


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
  [PHASES.PROMPT_STUDIO]: '这一步只记录视觉偏好，不生成图片；下一步是海报素材（可选），可以真实生成一张、上传自己的图，也可以跳过。',
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


/** 导出完成后可回传真实截图的工程目录（Composer 的 `outputPath`）。 */
function readExportedProjectPath(result) {
  if (!result || typeof result !== 'object') return null;
  const value = result.outputPath;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function dataUrlToBlob(dataUrl) {
  const match = /^data:([^;]+);base64,(.+)$/.exec(String(dataUrl || ''));
  if (!match) throw new Error('图片数据无法解析，请重新选择。');
  const binary = globalThis.atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: match[1] });
}

/**
 * 侧栏 Agent 对话的请求来源。
 *
 * `main` 是原有主输入框（行为完全不变）；`sidebar` 表示这一轮由右侧栏发起：
 * 请求前在会话切片里追加一条用户消息（只追加一次），成功/失败再同步写一条助手消息。
 */
const AGENT_CHAT_ORIGINS = Object.freeze({ MAIN: 'main', SIDEBAR: 'sidebar' });

/** 侧栏请求 id：与主会话的 requestId 各自独立，供四元组守卫比对。 */
function createAgentChatRequestId() {
  return `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 把一轮真实结果压成侧栏的安全过程视图（`normalizeChatRun` 白名单产物）。
 *
 * 只喂工具标签与耗时：`trace` 本身不进状态、也不进消息正文；没有真实 trace 时不补假步骤。
 *
 * @param {{requestId: string, actionKind: string, startedAt?: number|null, result?: object|null,
 *   failed?: boolean, note?: string|null}} input
 */
function buildAgentChatRunSummary({ requestId, actionKind, startedAt = null, result = null, failed = false, note = null }) {
  const source = result && typeof result === 'object' ? result : {};
  const trace = source.trace ?? null;
  const degradation = source.degradation ?? null;
  const runId = typeof source.runId === 'string' && source.runId ? source.runId : null;
  const view = trace || degradation
    ? buildProcessView({ trace, degradation, changeSummary: [], runId })
    : null;
  const toolLabels = Array.isArray(view?.steps)
    ? view.steps
      .filter((step) => step && typeof step.label === 'string' && step.state !== 'pending')
      .map((step) => step.label)
    : [];
  const durationMs = Number.isFinite(startedAt) ? Math.max(0, Date.now() - startedAt) : 0;
  const degraded = source.degraded === true || (trace?.degraded === true);
  return normalizeChatRun({
    requestId,
    actionKind,
    runId,
    durationMs,
    toolLabels,
    degraded,
    status: failed ? 'failed' : (degraded ? 'partial' : 'done'),
    note: note ?? (view?.notice ? view.notice : null),
  });
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
          items: ['填写门店资料', '选择门店功能与定制', '生成并匹配页面骨架', '装修与视觉预览', '部署小程序'],
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
        body: '可以在下方输入框直接描述，我会把它加入定制方案；如果当前能力已经够用，也可以直接跳过定制。',
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
        items: state.build.candidates.map((item) => item.name),
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
          title: '开店资料',
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
        title: '视觉偏好（不生成图片）',
        body: state.visual.prompt
          ? '这一步只记录你的视觉偏好；下一步是海报素材，可以真实生成一张、上传自己的图，也可以跳过。'
          : '先写下想要的视觉偏好；下一步是海报素材，可以真实生成一张、上传自己的图，也可以跳过。',
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

// 设置文件不存在时，用当前实际生效的配置回填表单，避免显示值与真实请求不一致。
function withRuntimeAgentConfig(config) {
  if (!config || typeof config !== 'object') return config;
  const current = getAgentTransportConfig();
  const model = getModelConfig();
  return {
    ...config,
    apiBaseUrl: config.apiBaseUrl || current.baseUrl,
    agentEndpoint: config.agentEndpoint || current.endpoint,
    agentTimeoutMs: Number.isInteger(config.agentTimeoutMs) ? config.agentTimeoutMs : current.timeoutMs,
    modelChannel: config.modelChannel || (current.mode === 'http' ? 'server' : 'deepseek'),
    modelApiBaseUrl: config.modelApiBaseUrl || model.baseUrl,
    modelName: config.modelName || model.model,
    modelTimeoutMs: Number.isInteger(config.modelTimeoutMs) ? config.modelTimeoutMs : model.timeoutMs,
  };
}

/** 侧栏底部只展示「用的是什么模型」，不展示后端/通道/Mock 这类内部术语。 */
function selectModelLabel(state) {
  const config = state.settings.config || {};
  if (config.modelChannel === 'server') return '模型：本机服务';
  const name = String(config.modelName || 'deepseek-flash');
  return `模型：DeepSeek · ${name}`;
}

/**
 * 拖拽落图：只读取文件内容，不向主进程暴露本机路径。
 * 返回纯 base64（不含 `data:` 前缀），交给主进程重新检测类型与体积。
 */
function readImageFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
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
  // 模型与 API：渲染层只保存「是否已保存」等状态，Key 明文只在主进程加密存放。
  const [modelKey, setModelKey] = useState({ status: 'idle', configured: false, updatedAt: null, supported: true });
  const [modelKeySaving, setModelKeySaving] = useState(false);
  const [modelKeyError, setModelKeyError] = useState(null);
  const [modelKeyNotice, setModelKeyNotice] = useState(null);
  const [modelTest, setModelTest] = useState({ status: 'idle', message: '', latencyMs: null, model: '' });
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
  // G1：真实 AI 生图（第三方生图服务）。默认只生成 1 张以控制费用。
  const [posterGen, setPosterGen] = useState({
    status: 'idle',
    configured: false,
    model: '',
    disclosure: '',
    prompt: '',
    busy: false,
    error: '',
    success: null,
  });
  const posterGenSeq = useRef(0);
  const posterPromptLoaded = useRef('');
  const [draftEditorOpen, setDraftEditorOpen] = useState(false);
  const [thumbnails, setThumbnails] = useState({});
  const [storeImageBusy, setStoreImageBusy] = useState(false);
  const [storeImagePreviews, setStoreImagePreviews] = useState({});
  const [selectedStoreImageId, setSelectedStoreImageId] = useState(null);
  const [storeImageAnalysis, setStoreImageAnalysis] = useState({ status: 'idle', assetId: null, message: '' });
  const [menuImageRecognition, setMenuImageRecognition] = useState({ status: 'idle', message: '' });
  // P5c：默认导出位置（主进程给路径，界面负责显示；点按钮才真正写盘）。
  const [defaultTarget, setDefaultTarget] = useState({ status: 'loading', path: '', token: '', message: '' });
  const [onboardingConfirmOpen, setOnboardingConfirmOpen] = useState(false);
  const [onboardingCreating, setOnboardingCreating] = useState(false);
  const [envGuideOpen, setEnvGuideOpen] = useState(false);
  const [envGuideMode, setEnvGuideMode] = useState('first-run');
  const [envGuideDeploymentMode, setEnvGuideDeploymentMode] = useState('local');
  const [envGuideChecks, setEnvGuideChecks] = useState([]);
  const [envGuideBusy, setEnvGuideBusy] = useState(false);
  const envGuideNextRef = useRef(null);

  // 模板并排对比：只在模板页有效，最多 2 个模板 id。
  const [compareIds, setCompareIds] = useState(null);
  // 多模态上传的本地状态：只存在于内存，随请求透传给 agent turn。
  const [agentImages, setAgentImages] = useState({ menu: [], store: [] });
  const [agentImageError, setAgentImageError] = useState(null);
  // 右侧「Agent 对话」的本轮附件：同样只存在内存，随这一轮请求发送；
  // 图片 base64 绝不写进 project.json，也不写进消息正文。
  const [agentChatImages, setAgentChatImages] = useState([]);
  const [agentChatImageError, setAgentChatImageError] = useState(null);
  const [agentChatImageBusy, setAgentChatImageBusy] = useState(false);
  // P3：参考截图流程的即时错误与「是否已落盘」提示（都不进持久化文档）。
  const [screenRefError, setScreenRefError] = useState(null);
  const [screenRefPersisted, setScreenRefPersisted] = useState(true);
  const [screenRefImageStatus, setScreenRefImageStatus] = useState('idle');
  // P4：候选前端链路的即时错误（同样只存在内存里，不写项目快照）。
  const [frontendLocalError, setFrontendLocalError] = useState(null);
  // B5：发图前的告知 / 确认状态。确认只在「这张图 + 这个接收方 + 15 分钟内」有效。
  const [screenConsentPrompt, setScreenConsentPrompt] = useState(null);
  const [screenConsentGrant, setScreenConsentGrant] = useState(null);
  const [screenConsentNotice, setScreenConsentNotice] = useState(null);
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
  // 侧栏对话的同步防重：同一帧内连点/连按 Enter 时 state 还没更新，
  // 因此除了 `status === 'requesting'` 之外再加一道 ref 守卫，保证只发一次。
  const agentChatBusy = useRef(false);
  // P3：识别请求的并发门禁，避免同一时刻发两次识别。
  const screenRefBusy = useRef(false);
  // 侧栏自动编排遇到发图确认时保留同一次 run，确认后继续，不重复写回资料。
  const frontendAutomationPending = useRef(null);
  // W4：连续点击/连按回车只放行一次同一段文字，避免重复请求与重复消息。
  const submitGuardRef = useRef(createSubmitGuard());
  // 在途请求期间用户可能新增图片：用 ref 记录最新数量，避免闭包读到旧 state。
  const agentImagesRef = useRef(0);
  agentImagesRef.current = agentImages.menu.length + agentImages.store.length;
  // 侧栏附件同理：重试与连续提交都读最新值，不依赖闭包里的旧数组。
  const agentChatImagesRef = useRef([]);
  agentChatImagesRef.current = agentChatImages;
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
  // 项目级 Agent 会话视图模型（唯一真相源在 state.agentChat）：侧栏只能读它，组件里没有自己的会话状态。
  const agentChatState = selectAgentChatState(state);
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

  // ——— B4：导出前的「最终生成内容」与导出签名 ———
  // 两者都从同一份 Plan（导出真正用的那份）派生，不另存一份数据副本。
  const exportPlanForReview = useMemo(
    () => buildExportPlanFromSession(frontendStateWithCandidate),
    [frontendStateWithCandidate],
  );
  const exportTargetDirectory = state.deploy.directory
    || (defaultTarget.status === 'ok' ? defaultTarget.path : '');
  const exportProjectName = state.deploy.projectName
    || sanitizeProjectName(state.store.name || state.agentDraft.storeName);
  const exportSignatureParts = useMemo(
    () => buildSignatureParts({
      plan: exportPlanForReview.ok ? exportPlanForReview.plan : null,
      posterAssetId: state.visual.imageAssetId || null,
      directory: exportTargetDirectory,
      projectName: exportProjectName,
    }),
    [exportPlanForReview, state.visual.imageAssetId, exportTargetDirectory, exportProjectName],
  );
  const exportReview = useMemo(() => {
    // 已采用修改 = 当前 Plan 与「同一 builder、去掉展示补丁」的基线 Plan 之差。
    const baselineSource = state.presentation ? { ...frontendStateWithCandidate, presentation: null } : frontendStateWithCandidate;
    const baselineBuilt = buildPlanFromSession(baselineSource);
    return buildExportReview({
      plan: exportPlanForReview.ok ? exportPlanForReview.plan : null,
      baselinePlan: baselineBuilt && baselineBuilt.plan ? baselineBuilt.plan : null,
      templateId: state.build.selectedId ?? null,
      styleName,
      unmappedCapabilities: exportPlanForReview.ok ? exportPlanForReview.unmappedCapabilities : [],
      warnings: exportPlanForReview.ok ? exportPlanForReview.warnings : [],
      target: { directory: exportTargetDirectory, projectName: exportProjectName },
      poster: {
        included: Boolean(state.visual.imageAssetId),
        reason: state.visual.imageAssetId ? null : '没有选海报图，不进工程；基础页面照常生成',
      },
      frontendCandidate: exportPlanForReview.ok ? exportPlanForReview.frontendCandidate : null,
      recipeStage: state.deploy.preflight.recipe || null,
    });
  }, [
    exportPlanForReview,
    frontendStateWithCandidate,
    state.presentation,
    state.build.selectedId,
    state.visual.imageAssetId,
    state.deploy.preflight.recipe,
    styleName,
    exportTargetDirectory,
    exportProjectName,
  ]);
  // 规则 6：体检结果绑定签名；资料/目标一改，旧结果与旧确认立即失效。
  const preflightSignature = state.deploy.preflight.signature || null;
  const preflightSignatureText = preflightSignature && typeof preflightSignature === 'object'
    ? preflightSignature.signature || null
    : (typeof preflightSignature === 'string' ? preflightSignature : null);
  const preflightStale = state.deploy.preflight.status === 'done'
    && Boolean(preflightSignatureText)
    && preflightSignatureText !== exportSignatureParts.signature;
  const preflightStaleReason = preflightStale && preflightSignature && typeof preflightSignature === 'object'
    ? describeSignatureDrift(preflightSignature, exportSignatureParts)
    : null;

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
    // 项目级 Agent 会话：只把消息列进依赖（草稿/在途状态是 transient，不该每次输入都落盘）。
    // 消息变化（发起一轮、成功/失败各一条）就会触发一次保存，重开项目后历史还能回来。
    state.agentChat?.messages,
    frontendCandidateRecord,
    state.settings.config?.autoSaveEnabled,
    state.settings.config?.autoSaveDebounceMs,
  ]);

  useEffect(() => {
    setDraft('');
    if (phase !== PHASES.TEMPLATE_PICK) setCompareIds(null);
  }, [phase]);

  // 回到起跑线（新项目/重置）时丢弃上一轮图片与会话级错误，避免把旧图片带进新门店。
  useEffect(() => {
    if (phase !== PHASES.ONBOARDING) return;
    setAgentImages({ menu: [], store: [] });
    setAgentImageError(null);
    setMenuImageRecognition({ status: 'idle', message: '' });
    setRealPreview({ screenshot: null, busy: false, error: null });
  }, [phase, state.project.activeId]);

  useEffect(() => {
    setStoreImagePreviews({});
    setSelectedStoreImageId(null);
    setStoreImageAnalysis({ status: 'idle', assetId: null, message: '' });
    setMenuImageRecognition({ status: 'idle', message: '' });
    setScreenRefImageStatus('idle');
  }, [state.project.activeId]);

  // 侧栏附件只属于当前阶段/当前项目：切阶段或切项目就丢弃，避免把上一轮的图误发出去。
  useEffect(() => {
    setAgentChatImages([]);
    setAgentChatImageError(null);
    setAgentChatImageBusy(false);
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

    const screenRefImage = hydrated.screenRef?.image;
    if (screenRefImage?.assetId && service.mode === 'desktop') {
      try {
        const asset = await service.readAsset(projectId, screenRefImage.assetId, 1280);
        const dataUrl = asset?.status === 'ok' ? asset.asset?.dataUrl || '' : '';
        const image = await createReferenceImageFromDataUrl(
          dataUrl,
          screenRefImage.name || '参考截图',
          screenRefImage.assetId,
        );
        dispatch({ type: 'SCREEN_REF_IMAGE_HYDRATE', image });
        setScreenRefPersisted(true);
      } catch (error) {
        setScreenRefError('已保存的参考截图读取失败，请换一张后重新识别。');
      }
    }

    const posterAssetId = result.doc && result.doc.visual && result.doc.visual.imageAssetId;
    if (posterAssetId && service.mode === 'desktop') {
      // UX0b：按已保存的资产 ID 回读预览；读取失败要明确提示，不静默变成"已选好"。
      const asset = await service.readAsset(projectId, posterAssetId, 720).catch(() => null);
      if (asset && asset.status === 'ok' && asset.asset && asset.asset.dataUrl) {
        dispatch({ type: 'SET_POSTER_PREVIEW', dataUrl: asset.asset.dataUrl, provider: asset.asset.source });
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

  const refreshModelKeyStatus = useCallback(async () => {
    const result = await settingsServiceRef.current.model.status().catch(() => null);
    setModelKey({
      status: 'ok',
      configured: Boolean(result && result.configured === true),
      updatedAt: result?.updatedAt || null,
      supported: result?.supported !== false,
    });
  }, []);

  useEffect(() => {
    void refreshModelKeyStatus();
  }, [refreshModelKeyStatus]);

  const handleSaveModelKey = async (key, done) => {
    if (modelKeySaving) return;
    setModelKeySaving(true);
    setModelKeyError(null);
    setModelKeyNotice(null);
    const result = await settingsServiceRef.current.model.saveKey(key).catch((error) => ({
      status: 'failed',
      message: error instanceof Error ? error.message : 'API Key 保存失败',
    }));
    setModelKeySaving(false);
    if (result.status === 'ok') {
      setModelKey({ status: 'ok', configured: true, updatedAt: result.updatedAt || null, supported: true });
      setModelKeyNotice('API Key 已加密保存到这台电脑');
      setModelTest({ status: 'idle', message: '', latencyMs: null, model: '' });
      if (typeof done === 'function') done();
      return;
    }
    setModelKeyError(result.message || 'API Key 保存失败');
  };

  const handleClearModelKey = async () => {
    if (modelKeySaving) return;
    setModelKeySaving(true);
    setModelKeyError(null);
    setModelKeyNotice(null);
    const result = await settingsServiceRef.current.model.clearKey().catch(() => ({ status: 'failed', message: '清除失败' }));
    setModelKeySaving(false);
    if (result.status === 'ok') {
      setModelKey({ status: 'ok', configured: false, updatedAt: null, supported: true });
      setModelKeyNotice('已清除本机保存的 API Key');
      setModelTest({ status: 'idle', message: '', latencyMs: null, model: '' });
      return;
    }
    setModelKeyError(result.message || '清除失败');
  };

  const handleTestModel = async (config) => {
    setModelTest({ status: 'testing', message: '', latencyMs: null, model: '' });
    const result = await settingsServiceRef.current.model.test(config || {}).catch(() => ({
      status: 'failed',
      message: '连接失败，请检查网络与 API 地址。',
    }));
    if (result.status === 'ok') {
      setModelTest({
        status: 'ok',
        message: '',
        latencyMs: Number.isFinite(result.latencyMs) ? result.latencyMs : null,
        model: result.model || '',
      });
      return;
    }
    setModelTest({ status: 'failed', message: result.message || '连接失败，请检查网络与 API 地址。', latencyMs: null, model: '' });
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

  const detectDeploymentMode = useCallback(() => {
    const config = getAgentTransportConfig();
    const base = String((config && config.baseUrl) || '');
    let host = '';
    try {
      host = base ? new URL(base).hostname : '';
    } catch (error) {
      host = '';
    }
    if (!host && typeof window !== 'undefined') host = window.location.hostname;
    const localHosts = new Set(['', '127.0.0.1', 'localhost', '::1']);
    return host && !localHosts.has(host) ? 'cloud' : 'local';
  }, []);

  const runEnvChecks = useCallback(async () => {
    setEnvGuideBusy(true);
    const deploymentMode = detectDeploymentMode();
    setEnvGuideDeploymentMode(deploymentMode);
    const isCloud = deploymentMode === 'cloud';

    const checks = [
      {
        id: 'runtime',
        group: 'server',
        title: '运行环境',
        status: 'pass',
        detail: isCloud
          ? '应用已在运行；服务端检查以云端 API 为准。'
          : '应用已在运行，前端依赖已就绪。',
      },
    ];

    try {
      // 8 秒硬超时：探测卡住时清单也要给出结论，不能让用户停在「检测中」。
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), 8000) : null;
      let response;
      try {
        response = await globalThis.fetch('/api/v1/readyz', { cache: 'no-store', signal: controller ? controller.signal : undefined });
      } finally {
        if (timer) clearTimeout(timer);
      }
      const payload = await response.json().catch(() => null);
      const databaseOk = Boolean(payload && payload.database === 'ok');
      checks.push({
        id: 'backend',
        group: 'server',
        title: '后端与数据库',
        status: databaseOk ? 'pass' : 'fail',
        detail: databaseOk
          ? (isCloud ? '云端后端与数据库已就绪。' : '本机模型服务与数据库已就绪。')
          : (isCloud
            ? '云端后端不可达：请检查云端服务状态或联系部署方；本地无需启动数据库。'
            : '本机模型服务或数据库还没就绪：请先启动本机的数据库与应用服务。只用直连 DeepSeek 的话可以跳过这一项。'),
      });
    } catch (error) {
      checks.push({
        id: 'backend',
        group: 'server',
        title: '后端与数据库',
        status: 'fail',
        detail: isCloud
          ? '无法连接云端 API，请检查云端服务状态或网络。'
          : '连不上本机的模型服务（127.0.0.1:3000）。请先启动本机服务；只用直连 DeepSeek 的话可以跳过这一项。',
      });
    }

    let probe;
    try {
      probe = await devtoolsService.probe();
    } catch (error) {
      // 探测失败也要给出结论并结束「检测中」，否则环境清单会永久卡住、连「稍后再做」都点不动。
      probe = { status: 'failed', found: false, message: (error && error.message) || '探测失败' };
    }
    checks.push({
      id: 'devtools',
      group: 'local',
      title: '微信开发者工具',
      status: probe.found ? 'pass' : (probe.status === 'failed' ? 'fail' : 'warn'),
      detail: probe.found
        ? '已检测到微信开发者工具。'
        : (probe.status === 'failed'
          ? '检测微信开发者工具状态失败（' + (probe.message || '未知原因') + '），可点「重新检测」重试。'
          : '本机未检测到，请安装官方开发者工具（见下方详细步骤）。'),
    });
    checks.push({
      id: 'devtools-login',
      group: 'local',
      title: '微信登录与服务端口',
      status: 'manual',
      detail: '需要扫码登录，并在「设置 → 安全设置」开启服务端口。',
    });
    checks.push({
      id: 'preview-settings',
      group: 'local',
      title: '预览设置',
      status: 'manual',
      detail: '代理设置选「不使用代理」；本地设置勾选「不校验合法域名、TLS 与 HTTPS 证书」。',
    });

    setEnvGuideChecks(checks);
    setEnvGuideBusy(false);
  }, [detectDeploymentMode, devtoolsService]);

  const openEnvGuide = useCallback((mode, next) => {
    setEnvGuideMode(mode);
    setEnvGuideDeploymentMode(detectDeploymentMode());
    envGuideNextRef.current = typeof next === 'function' ? next : null;
    setEnvGuideChecks([]);
    setEnvGuideOpen(true);
    // 预览前使用逐项勾选清单，不再自动检测；首次环境准备仍自动检测。
    if (mode !== 'preview') void runEnvChecks();
  }, [detectDeploymentMode, runEnvChecks]);

  const closeEnvGuideAndContinue = useCallback(() => {
    setEnvGuideOpen(false);
    const next = envGuideNextRef.current;
    envGuideNextRef.current = null;
    if (typeof next === 'function') next();
  }, []);

  const closeEnvGuide = useCallback(() => {
    setEnvGuideOpen(false);
    envGuideNextRef.current = null;
  }, []);

  const handleEnvGuideSkip = useCallback(() => {
    // 预览前检查：跳过只关闭，不继续打开工具；
    // 首次环境准备：跳过仍继续创建项目，避免卡在入口。
    if (envGuideMode === 'preview') {
      closeEnvGuide();
      return;
    }
    closeEnvGuideAndContinue();
  }, [envGuideMode, closeEnvGuide, closeEnvGuideAndContinue]);


  const startOnboarding = () => {
    if (selectOnboardingStart(state) === 'confirm-create') {
      setOnboardingConfirmOpen(true);
      return;
    }
    openEnvGuide('first-run', () => dispatch({ type: 'START_ONBOARDING' }));
  };

  const confirmStartOnboarding = async () => {
    if (onboardingCreating) return;
    setOnboardingCreating(true);
    try {
      const created = await handleProjectCreate();
      if (!created) return;
      setOnboardingConfirmOpen(false);
      openEnvGuide('first-run', () => dispatch({ type: 'START_ONBOARDING' }));
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
      reply: `好的，我把「${text}」补充进视觉偏好里了。`,
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
   * 「这一轮模板修订现在能不能真的跑起来」——可执行条件只有这一份。
   *
   * 主输入框（按钮禁用）、侧栏（禁用 + 提示原因）与真正发请求前的守卫都读它，
   * 避免出现「按钮可点、handler 静默 return」的两套口径。
   *
   * @returns {{templateId: string|null, candidate: object|null, blockedReason: string|null}}
   */
  const resolveTemplateReviseContext = () => {
    const templateId = state.build.selectedId || null;
    const candidate = state.build.candidates.find((item) => item.id === templateId) || null;
    let blockedReason = null;
    if (!presentationState.canRevise) {
      blockedReason = '候选模板还没准备好：等这一轮候选生成完成后，才能在这里对话修改模板。';
    } else if (presentationState.status === 'revising') {
      blockedReason = '上一轮模板修订还在进行中，等它结束再发送。';
    } else if (!templateId || !candidate) {
      blockedReason = '还没有选中候选模板：先在下面选一个模板，再回来对话修改。';
    }
    return { templateId, candidate, blockedReason };
  };

  /**
   * 模板页「对话修改当前模板」。
   *
   * 单飞 + 晚响应丢弃：`requestId` 先写入状态机，结果必须带同一个 id 回来；
   * 用户切模板或发起第二轮后，旧响应会被 reducer 整包忽略（plan.md 2.2.3）。
   *
   * `origin === 'sidebar'` 时额外把这一轮记进项目级 Agent 会话（state.agentChat）：
   * 请求前由这里追加唯一一条侧栏用户消息，成功/失败再写一条助手消息，
   * 外层不再重复追加；主会话（origin='main'）行为完全不变。
   */
  const handleTemplateReviseSubmit = async (utterance, {
    origin = AGENT_CHAT_ORIGINS.MAIN,
    retry = false,
    images = null,
  } = {}) => {
    const fromSidebar = origin === AGENT_CHAT_ORIGINS.SIDEBAR;
    const text = String(utterance ?? '').trim();
    if (!text) return;
    if (phase !== PHASES.TEMPLATE_PICK) return;
    if (templateReviseBusy.current) return;
    // 侧栏请求在途时忽略重复提交。用户可见的「为什么发不出去」由
    // `agentChatSendBlockedReason`（App → 面板禁用 + 提示）负责，这里只是兜底。
    if (fromSidebar && (agentChatBusy.current || agentChatState.status === CHAT_STATUS.REQUESTING)) return;
    // 可执行条件与侧栏禁用/提示共用同一份判断；侧栏来源在这里也要给反馈，不静默吞输入。
    const reviseContext = resolveTemplateReviseContext();
    if (reviseContext.blockedReason) {
      if (fromSidebar) setNotice(reviseContext.blockedReason);
      return;
    }
    const { templateId, candidate } = reviseContext;

    const requestId = createReviseRequestId();
    // 侧栏请求身份：项目与阶段在此刻冻结，迟到响应不能串到别的项目/阶段。
    const chatRequestId = createAgentChatRequestId();
    const chatProjectId = state.project.activeId || null;
    const chatPhase = phase;
    const startedAt = Date.now();
    templateReviseBusy.current = true;
    // 只由侧栏请求自己持有/释放这道同步守卫，主输入框（origin='main'）不受影响。
    if (fromSidebar) agentChatBusy.current = true;
    if (fromSidebar) {
      dispatch(retry
        ? { type: 'AGENT_CHAT_RETRY_PREPARE', projectId: chatProjectId, requestId: chatRequestId, phase: chatPhase }
        : {
          type: 'AGENT_CHAT_REQUEST_START',
          projectId: chatProjectId,
          requestId: chatRequestId,
          utterance: text,
          actionKind: 'template-revise',
          phase: chatPhase,
        });
    }
    // origin 让状态层知道这一轮来自右侧会话：中间主会话只保留阶段切换提示，
    // 不再重复显示侧栏发出的用户原话与助手回复。
    dispatch({
      type: 'TEMPLATE_REVISE_REQUEST',
      utterance: text,
      requestId,
      origin: fromSidebar ? AGENT_CHAT_ORIGINS.SIDEBAR : AGENT_CHAT_ORIGINS.MAIN,
    });
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
        // 模板修订后端只接受 1 张门店环境照（kind=store）；没有图片就不传该字段。
        ...(Array.isArray(images) && images.length ? { images } : {}),
      });
      dispatch({
        type: 'TEMPLATE_REVISE_SUCCESS',
        requestId,
        templateId: result.templateId,
        patch: result.patch,
        changes: result.changes,
        reply: result.reply,
        origin: fromSidebar ? AGENT_CHAT_ORIGINS.SIDEBAR : AGENT_CHAT_ORIGINS.MAIN,
      });
      if (fromSidebar) {
        const changes = Array.isArray(result.changes) ? result.changes : [];
        dispatch({
          type: 'AGENT_CHAT_SUCCESS',
          projectId: chatProjectId,
          requestId: chatRequestId,
          phase: chatPhase,
          actionKind: 'template-revise',
          reply: String(result.reply ?? '').trim() || `已更新 ${changes.length} 项展示`,
          run: buildAgentChatRunSummary({ requestId: chatRequestId, actionKind: 'template-revise', startedAt }),
        });
        dispatch({ type: 'AGENT_CHAT_DRAFT_SET', value: '' });
        setAgentChatImages([]);
        setAgentChatImageError(null);
        setAgentChatImageBusy(false);
      }
    } catch (error) {
      dispatch({ type: 'TEMPLATE_REVISE_FAILURE', requestId, error });
      if (fromSidebar) {
        dispatch({
          type: 'AGENT_CHAT_FAILURE',
          projectId: chatProjectId,
          requestId: chatRequestId,
          phase: chatPhase,
          error,
        });
      }
    } finally {
      templateReviseBusy.current = false;
      if (fromSidebar) agentChatBusy.current = false;
    }
  };

  const handleVisionImagesAdd = (kind, drafts) => {
    const incoming = Array.isArray(drafts)
      ? drafts.filter((item) => item && typeof item.id === 'string' && item.id)
      : [];
    if (!incoming.length) return;
    setAgentImageError(null);
    if (kind === 'menu') {
      setMenuImageRecognition({
        status: agentImages.menu.length > 0 || menuImageRecognition.status !== 'idle' ? 'replaced' : 'idle',
        message: '',
      });
    }
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
  };

  const handleVisionImageRemove = (kind, id) => {
    setAgentImageError(null);
    if (kind === 'menu') {
      const remaining = agentImages.menu.filter((item) => item.id !== id).length;
      setMenuImageRecognition({ status: remaining > 0 ? 'replaced' : 'idle', message: '' });
    }
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

  const runPreviewExport = useCallback(async () => {
    const previewPlan = buildExportPlanFromSession(frontendStateWithCandidate);
    if (!previewPlan.ok) {
      return { ok: false, message: previewPlan.message || '候选前端 overlay 未确认，已阻止生成预览工程。' };
    }
    const { plan, warnings } = previewPlan;
    const projectId = state.project.activeId || 'unscoped-project';
    const adopted = frontendCandidateRecord && frontendCandidateRecord.status === 'adopted'
      ? frontendCandidateRecord
      : null;
    const bindingKey = adopted ? `${adopted.projectId}:${adopted.runId}` : `${projectId}:base`;
    const prepared = await prepareProjectPreview({
      bindingKey,
      agentDraft: state.agentDraft,
      store: state.store,
    });
    if (prepared.status !== 'ok') {
      return {
        ok: false,
        code: prepared.code || 'PREVIEW_DATA_FAILED',
        step: 'preview-data',
        // 上游文案自带句号时不要再叠一个「。。」。
        message: `准备预览数据失败：${String(prepared.message || '未知原因').replace(/[。！!.\s]+$/, '')}。尚未导出工程。`,
      };
    }
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
      // 与正式导出走同一份权威素材：海报只传受控引用（项目 ID + 资产 ID），
      // 字节由主进程按资产权限与大小校验后读取，预览副本才不会缺 assets/media。
      projectId: state.project.activeId || null,
      posterAssetId: state.visual.imageAssetId || null,
      storeId: prepared.storeId,
      backendVersions: prepared.backendVersions,
      candidateOverlay: frontendCandidateOverlay,
    });
    if (result.status !== 'ok') {
      return {
        ok: false,
        code: result.code || 'EXPORT_FAILED',
        step: 'export',
        message: `导出预览工程失败：${result.message || '未知原因'}`,
      };
    }

    const payload = result.result || {};
    const outputPath = payload.outputPath || '';
    if (!outputPath) {
      return { ok: false, message: '预览工程已生成，但没有返回工程路径。' };
    }

    // W1 起 AppID 只能通过 appid-postprocess 事务写入；预览工程同样要写正式 AppID，
    // 否则 devtools-launch 会以“仍是测试号 touristappid”拒绝打开。
    const appid = resolvePreviewAppId(state.project);
    const applied = await appidService.apply(outputPath, appid);
    if (applied.status !== 'ok') {
      return {
        ok: false,
        code: applied.code || 'APPID_WRITE_FAILED',
        step: 'appid',
        message: applied.message || 'AppID 写入失败，预览工程仍是测试号，无法用微信开发者工具打开。',
      };
    }

    return {
      ok: true,
      path: outputPath,
      warnings: [...(warnings || []), ...(payload.warnings || [])],
    };
  }, [state, frontendStateWithCandidate, frontendCandidateRecord, frontendCandidateOverlay, appidService]);

  const continuePreviewExport = useCallback(async () => {
    const result = await runPreviewExport();
    if (!result.ok) {
      const message = result.message || '生成预览工程失败。';
      setNotice(message);
      return { ok: false, code: result.code || 'EXPORT_FAILED', message };
    }
    const api = typeof window !== 'undefined' ? window.smartStore : null;
    if (!api || typeof api.openPreviewDevtools !== 'function') {
      const message = '桌面端未提供预览桥接，无法打开微信开发者工具。';
      setNotice(message);
      return { ok: false, code: 'DESKTOP_REQUIRED', message };
    }
    try {
      const opened = await api.openPreviewDevtools({ projectPath: result.path });
      if (opened && opened.ok) {
        const message = opened.message || '已请求微信开发者工具打开工程。';
        setNotice(message);
        return { ok: true, path: result.path, opened: true, message };
      }
      const message = (opened && opened.message) || '未能调起微信开发者工具。';
      setNotice(message);
      return { ok: false, code: (opened && opened.code) || 'LAUNCH_FAILED', message };
    } catch (error) {
      const message = (error && error.message) || '调起微信开发者工具失败。';
      setNotice(message);
      return { ok: false, code: 'LAUNCH_FAILED', message };
    }
  }, [runPreviewExport]);

  /**
   * 模板页「预览新模块」：先弹出环境检查（始终可见），
   * 用户确认「已准备就绪」后再按当前需求导出并打开微信开发者工具。
   */
  const handlePreparePreviewProject = useCallback(async (options = {}) => {
    const api = typeof window !== 'undefined' ? window.smartStore : null;
    if (!api || api.isDesktop !== true || typeof api.composerExport !== 'function') {
      return { ok: false, code: 'DESKTOP_REQUIRED', message: '需要在桌面应用中生成并预览工程。' };
    }

    // 只在工具尚未启动、或工具已启动但还没有打开小程序页面时弹清单；
// 已经展示了小程序页面就直接按当前需求导出。
    const probe = await devtoolsService.probe();
    // 「探测失败」要和「工具没装」分开说：否则一次权限/执行限制就会被说成未安装。
    if (probe.status === 'failed') {
      openEnvGuide('preview', async () => {
        const outcome = await continuePreviewExport();
        if (typeof options.onContinueResult === 'function') options.onContinueResult(outcome);
      });
      return {
        ok: false,
        code: 'ENV_GUIDE_OPENED',
        message: '检测微信开发者工具状态失败，已打开检查清单；可在清单里点「重新检测」后再试。',
      };
    }
    if (!probe.found || probe.running === false || probe.projectOpen === false) {
      // 底部常驻按钮与模板页共用这条入口：勾选「已准备就绪」后继续导出并打开。
      openEnvGuide('preview', async () => {
        const outcome = await continuePreviewExport();
        if (typeof options.onContinueResult === 'function') options.onContinueResult(outcome);
      });
      return {
        ok: false,
        code: 'ENV_GUIDE_OPENED',
        message: !probe.found
          ? '未检测到微信开发者工具，已打开检查清单。'
          : (probe.projectOpen === false
            ? '微信开发者工具已启动，但还没有打开小程序页面，已打开检查清单。'
            : '微信开发者工具尚未启动，已打开检查清单。'),
      };
    }

    return continuePreviewExport();
  }, [devtoolsService, openEnvGuide, continuePreviewExport, runPreviewExport]);

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

  /**
   * 门店资料阶段的一轮 Agent 对话。
   *
   * `origin === 'sidebar'` 时额外记进项目级 Agent 会话（state.agentChat）：
   * 请求前在这里追加唯一一条侧栏用户消息（actionKind 由阶段路由决定），
   * 成功/失败再写一条助手消息；外层不再包一层重复追加，主会话行为保持原样。
   */
  const handleAgentTurn = async (utterance, {
    retry = false,
    imageKinds = null,
    // 侧栏本轮附件：显式传入时只发这些图片，不与中间上传区的图片混在一起。
    images: explicitImages = null,
    requireVision = false,
    origin = AGENT_CHAT_ORIGINS.MAIN,
    // 统一会话的菜单识别在任意阶段都可用；主输入框仍只在资料阶段可用。
    allowAnyPhase = false,
  } = {}) => {
    const fromSidebar = origin === AGENT_CHAT_ORIGINS.SIDEBAR;
    if (agentBusy.current) {
      if (fromSidebar) {
        setNotice('另一个 Agent 请求正在处理中：等它结束后再发送，避免两轮结果互相覆盖。');
        setAgentChatImageError({
          code: 'AGENT_BUSY',
          message: '另一个 Agent 请求正在处理中，等它结束后再发送这一轮。',
        });
      }
      return null;
    }
    if (!allowAnyPhase && phase !== PHASES.STORE_INFO) {
      if (fromSidebar) setNotice('当前阶段不走资料整理：请切到「门店资料」阶段，或直接说页面要改什么。');
      return null;
    }
    if (fromSidebar && (agentChatBusy.current || agentChatState.status === CHAT_STATUS.REQUESTING)) {
      setNotice('上一轮还在处理中：等结果回来再发送。');
      return null;
    }
    const text = String(utterance ?? '').trim();
    if (!text) {
      if (fromSidebar) setNotice('这一轮没有可发送的文字或图片，请先输入内容。');
      return null;
    }
    agentBusy.current = true;
    // 只由侧栏请求自己持有/释放这道同步守卫，主输入框（origin='main'）不受影响。
    if (fromSidebar) agentChatBusy.current = true;
    const requestId = createAgentRequestId();
    // 侧栏请求身份：项目与阶段在此刻冻结，迟到响应不能串到别的项目/阶段。
    const chatRequestId = createAgentChatRequestId();
    const chatProjectId = state.project.activeId || null;
    const chatPhase = phase;
    const chatStartedAt = Date.now();
    const images = Array.isArray(explicitImages)
      ? explicitImages
      : (Array.isArray(imageKinds)
        ? imageKinds.flatMap((kind) => (Array.isArray(agentImages[kind]) ? agentImages[kind] : []))
        : [...agentImages.menu, ...agentImages.store]);
    const frozenDraft = state.agentDraft;
    const frozenRevision = state.agent.draftRevision;
    const frozenImageCount = images.length;
    const route = resolveAgentRequestRoute({
      phase: 'store-info',
      imageCount: frozenImageCount,
      transportMode: describeAgentTransport().mode,
    });
    // 直连 DeepSeek 只接管纯文字的资料整理；带图片的单轮识别要由本机模型服务处理。
    if (frozenImageCount > 0 && describeAgentTransport().mode === 'direct') {
      const error = {
        code: 'AGENT_VISION_UNAVAILABLE',
        message: '当前是直连 DeepSeek 模式，图片识别需要「本机服务」通道。可以到「设置与模型」切换通道，或先去掉图片、用文字描述菜品。',
        retryable: false,
      };
      dispatch({ type: 'AGENT_TURN_FAILURE', requestId, error });
      if (fromSidebar) {
        dispatch({
          type: 'AGENT_CHAT_FAILURE',
          projectId: chatProjectId,
          requestId: chatRequestId,
          phase: chatPhase,
          error,
        });
      }
      agentBusy.current = false;
      if (fromSidebar) agentChatBusy.current = false;
      return null;
    }
    if (fromSidebar) {
      dispatch(retry
        // 重试只重放上一轮原话，不重复追加用户消息。
        ? { type: 'AGENT_CHAT_RETRY_PREPARE', projectId: chatProjectId, requestId: chatRequestId, phase: chatPhase }
        : {
          type: 'AGENT_CHAT_REQUEST_START',
          projectId: chatProjectId,
          requestId: chatRequestId,
          utterance: text,
          actionKind: 'store-info',
          phase: chatPhase,
        });
    }
    dispatch(retry
      ? { type: 'AGENT_TURN_RETRY', requestId, draftRevision: frozenRevision }
      : {
        type: 'AGENT_TURN_REQUEST',
        utterance: text,
        requestId,
        draftRevision: frozenRevision,
        origin: fromSidebar ? AGENT_CHAT_ORIGINS.SIDEBAR : AGENT_CHAT_ORIGINS.MAIN,
      });
    try {
      const result = isAgentRunRoute(route)
        ? await requestAgentRun({ utterance: text, draft: frozenDraft, requestId })
        : await requestAgentTurn({
          utterance: text,
          draft: frozenDraft,
          ...(images.length ? { images } : {}),
        });
      if (requireVision && result.vision?.analyzed !== true) {
        const error = {
          code: 'AGENT_VISION_UNAVAILABLE',
          message: '当前图片识别服务没有真正读取菜单图片，未回写识别结果。请检查模型配置后重试。',
          retryable: true,
        };
        dispatch({ type: 'AGENT_TURN_FAILURE', requestId, error });
        if (fromSidebar) {
          dispatch({
            type: 'AGENT_CHAT_FAILURE',
            projectId: chatProjectId,
            requestId: chatRequestId,
            phase: chatPhase,
            error,
          });
        }
        return result;
      }
      const imagesAddedDuringRequest = Array.isArray(explicitImages)
        ? false
        : agentImagesRef.current > frozenImageCount;
      dispatch({
        type: 'AGENT_TURN_SUCCESS',
        ...result,
        requestId,
        draftRevision: frozenRevision,
        imagesAddedDuringRequest,
        origin: fromSidebar ? AGENT_CHAT_ORIGINS.SIDEBAR : AGENT_CHAT_ORIGINS.MAIN,
      });
      if (fromSidebar) {
        dispatch({
          type: 'AGENT_CHAT_SUCCESS',
          projectId: chatProjectId,
          requestId: chatRequestId,
          phase: chatPhase,
          actionKind: 'store-info',
          reply: String(result?.reply ?? '').trim() || '这一轮已经处理完，请看草稿是否与你说的一致。',
          run: buildAgentChatRunSummary({
            requestId: chatRequestId,
            actionKind: 'store-info',
            startedAt: chatStartedAt,
            result,
          }),
        });
        dispatch({ type: 'AGENT_CHAT_DRAFT_SET', value: '' });
        setAgentChatImages([]);
        setAgentChatImageError(null);
        setAgentChatImageBusy(false);
      }
      setDraft('');
      setAgentImageError(null);
      return result;
    } catch (error) {
      if (error && typeof error.code === 'string' && error.code.startsWith('AGENT_IMAGE')) {
        setAgentImageError({ code: error.code, message: error.message || '图片不可用，请重新选择。' });
      }
      dispatch({ type: 'AGENT_TURN_FAILURE', requestId, error });
      if (fromSidebar) {
        dispatch({
          type: 'AGENT_CHAT_FAILURE',
          projectId: chatProjectId,
          requestId: chatRequestId,
          phase: chatPhase,
          error,
        });
      }
      return null;
    } finally {
      agentBusy.current = false;
      if (fromSidebar) agentChatBusy.current = false;
    }
  };

  const handleRecognizeMenuImages = async () => {
    if (!agentImages.menu.length) {
      setMenuImageRecognition({ status: 'needs_input', message: '请先上传菜单图片。' });
      return;
    }
    setMenuImageRecognition({ status: 'recognizing', message: '' });
    const result = await handleAgentTurn(
      '请只识别已上传的菜单图片，把菜名、价格和描述回写到菜品资料；不要参考门店环境图，不要修改页面布局。',
      { imageKinds: ['menu'], requireVision: true },
    );
    if (!result) {
      setMenuImageRecognition({ status: 'failed', message: '识别没有完成，图片已保留，可以直接重试。' });
    } else if (result.vision?.analyzed !== true) {
      setMenuImageRecognition({ status: 'failed', message: '当前图片识别服务没有真正读取菜单图片，未回写识别结果。请检查模型配置后重试。' });
    } else {
      setMenuImageRecognition({ status: 'written_back', message: '菜单识别结果已回写，请逐项核对。' });
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

  // ---- 右侧栏「Agent 对话」：全项目唯一的侧栏入口（路由 + 防重 + 本地指引） ----

  /**
   * 侧栏的「参考图重构」摘要。
   *
   * 只有项目里真的存在参考图/重构材料时才给摘要与「查看候选」入口；摘要取
   * `frontendView` 已有的安全文案，不复述截图内容、不假装侧栏能生成候选。
   */
  const agentChatCandidate = (() => {
    const hasReferenceImage = Boolean(state.screenRef && state.screenRef.image);
    const hasFrontendMaterial = frontendState.status !== FRONTEND_STATUS.IDLE
      || Boolean(frontendState.candidate)
      || Boolean(frontendState.request && frontendState.request.image);
    if (!hasReferenceImage && !hasFrontendMaterial) return null;
    const title = String(frontendView.title ?? '').trim();
    const body = String(frontendView.body ?? '').trim();
    const summary = [title, body].filter(Boolean).join('：');
    return {
      summary: summary || '这个项目已有参考图重构材料；候选会在私有工作区生成，校验后由你决定是否采用。',
      status: frontendState.status,
      runId: frontendState.runId,
      attempt: frontendState.candidate?.attempt ?? null,
      progress: frontendView.progress
        ? {
          label: frontendView.progress.label,
          percent: frontendView.progress.percent,
        }
        : null,
    };
  })();

  /**
   * 统一会话没有「当前阶段前置条件」：只要项目打开就能发。
   * 需要确认的动作由结果里的 actionRequest 走各自原入口，不在发送前拦截。
   */
  const agentChatSendBlockedReason = isFrontendBusy(frontendState)
    ? '参考图候选正在自动构建或验证，等本轮结束后再发送新的修改。'
    : null;

  // 统一会话在每个项目阶段都可以带图片；具体用途由附件用途与 Agent 判断。
  const agentChatImageKinds = (() => {
    if (!state.project.activeId) return [];
    return ['auto', 'menu', 'store', 'reference'];
  })();

  /**
   * 侧栏附件增删：只动内存里的本轮附件，不碰消息正文与持久化文档。
   *
   * 数量上限复用 `AGENT_IMAGE_LIMITS`；组件已经先拦一次，这里再兜一层，
   * 避免拖拽/连续添加绕过限制。
   */
  const handleAgentChatImagesAdd = (kind, drafts) => {
    const incoming = Array.isArray(drafts)
      ? drafts.filter((item) => item && typeof item.id === 'string' && item.id)
      : [];
    if (!incoming.length) return;
    setAgentChatImageError(null);
    setAgentChatImages((previous) => {
      const current = Array.isArray(previous) ? previous : [];
      const next = [...current];
      for (const draft of incoming) {
        if (next.length >= AGENT_IMAGE_LIMITS.maxTotalImages) break;
        const sameKind = next.filter((item) => item.kind === kind).length;
        const limit = kind === 'menu'
          ? AGENT_IMAGE_LIMITS.maxMenuImages
          : (kind === 'store' ? AGENT_IMAGE_LIMITS.maxStoreImages : (kind === 'reference' ? 1 : AGENT_IMAGE_LIMITS.maxTotalImages));
        if (sameKind >= limit) continue;
        next.push({ ...draft, kind });
      }
      return next;
    });
  };

  const handleAgentChatImageRemove = (id) => {
    setAgentChatImages((previous) => (
      Array.isArray(previous) ? previous.filter((item) => item && item.id !== id) : []
    ));
  };

  /**

   * 统一会话（`app-assistant.v1`）的一轮：任意阶段同一个入口。
   *
   * - 冻结 projectId / requestId / contextRevision；阶段只作上下文，不参与拒收；
   * - 服务端/direct 只给提案，这里用桌面校验器再验一次，再按能力目录拆批；
   * - 字段批次原子写入；高风险项只登记为「待确认」，不与低风险字段混成半批。
   */
  const runAppAssistantTurn = async ({ text, images = [], retry = false, preserveAttachments = false }) => {
    const projectId = state.project.activeId || null;
    if (!projectId) return null;
    const attachedImages = Array.isArray(images) ? images : [];
    const utterance = text || (attachedImages.length ? '请判断图片用途；不确定时先追问。' : '');
    if (!utterance) return null;
    if (agentChatBusy.current || agentChatState.status === CHAT_STATUS.REQUESTING) return null;

    const requestId = createAgentChatRequestId();
    const frozenState = state;
    const frozenRevision = Number.isInteger(state.project.contentRevision) ? state.project.contentRevision : 0;
    const history = (Array.isArray(state.agentChat?.messages) ? state.agentChat.messages : [])
      .filter((message) => message
        && (message.role === 'user' || message.role === 'assistant')
        && typeof message.text === 'string'
        && message.text.trim())
      .slice(-12)
      .map((message) => ({ role: message.role, text: message.text }));
    const startedAt = Date.now();
    agentChatBusy.current = true;
    dispatch(retry
      ? { type: 'AGENT_CHAT_RETRY_PREPARE', projectId, requestId, contextRevision: frozenRevision, phase }
      : {
        type: 'AGENT_CHAT_REQUEST_START',
        projectId,
        requestId,
        utterance,
        actionKind: 'app-assistant',
        contextRevision: frozenRevision,
        phase,
      });
    try {
      const result = await requestAppAssistant({
        utterance,
        attachments: attachedImages.map((item) => ({
          id: item.id,
          kind: item.kind,
          mediaType: item.mediaType,
          dataBase64: item.dataBase64,
          name: item.name,
          bytes: item.bytes,
        })),
        history,
        state: frozenState,
        requestId,
        contextRevision: frozenRevision,
        phase,
      });
      const proposal = result.proposal;
      const applyPlan = buildProposalApplyPlan(proposal, frozenState);
      const applyAction = applyPlan.autoChanges.length
        ? {
          type: 'APP_ASSISTANT_CHANGES_APPLY',
          proposalId: proposal.proposalId,
          // 带上本轮 requestId：变更卡要锚定到这一轮的助手消息后面。
          requestId,
          baseContextRevision: frozenRevision,
          changes: applyPlan.autoChanges,
        }
        : null;
      // 候选 Plan 只能使用这次字段批次写回后的状态，不能回读发起请求前的旧 state。
      const projectState = applyAction ? reducer(frozenState, applyAction) : frozenState;
      if (applyAction) dispatch(applyAction);
      dispatch({
        type: 'AGENT_CHAT_SUCCESS',
        projectId,
        requestId,
        contextRevision: frozenRevision,
        phase,
        actionKind: 'app-assistant',
        reply: proposal.reply,
        // 待确认项只登记摘要，绝不自动写入。
        // 动作请求里只有 navigate.phase 可自动执行；其余一律留给原业务面板确认。
        pending: {
          fields: applyPlan.pendingConfirmations.map((item) => ({
            opId: item.opId,
            fieldId: item.fieldId ?? null,
            // 带上 op：删菜和「清空/改写已有值」要走不同的确认入口，卡片文案也不同。
            op: item.op ?? null,
          })),
          actions: selectUnexecutedActions(executeAppAssistantActions(proposal.actionRequests, {
            state: frozenState,
            navigate: (nextPhase) => dispatch({ type: 'PHASE_GOTO', phase: nextPhase }),
          })),
        },
        run: normalizeChatRun({
          requestId,
          actionKind: 'app-assistant',
          status: proposal.trace?.degraded ? 'partial' : 'done',
          durationMs: Math.max(0, Date.now() - startedAt),
          toolLabels: [],
          degraded: proposal.trace?.degraded === true,
          runId: proposal.runId ?? null,
          note: proposal.trace?.degraded ? '这一轮有步骤没有正常完成，结果可能不完整。' : null,
        }),
      });
      const keepInput = proposal.status === 'needs-input' || proposal.status === 'rejected';
      if (!keepInput) dispatch({ type: 'AGENT_CHAT_DRAFT_SET', value: '' });
      if (!preserveAttachments && !keepInput) setAgentChatImages([]);
      setAgentChatImageError(null);
      setAgentChatImageBusy(false);
      return { ...result, projectState };
    } catch (error) {
      dispatch({
        type: 'AGENT_CHAT_FAILURE',
        projectId,
        requestId,
        contextRevision: frozenRevision,
        phase,
        error,
      });
      return null;
    } finally {
      agentChatBusy.current = false;
    }
  };

  /**
   * 附件分流（T7）：不重复实现专用链。
   *
   * - `reference`：送入「参考图重构」输入（侧栏只投递，不生成/采用候选）；
   * - `menu`：走 `agent-turn.v2`，只有真实 `vision.analyzed=true` 才回写；
   * - `auto` / `store`：走 app-assistant 视觉判断（不确定先追问）。
   */
  const dispatchAgentChatTurn = (text, images = [], { retry = false } = {}) => {
    const list = Array.isArray(images) ? images : [];
    const menuImages = list.filter((item) => item && item.kind === 'menu');
    const referenceImages = list.filter((item) => item && item.kind === 'reference');
    if (referenceImages.length && list.some((item) => item && item.kind !== 'reference')) {
      setAgentChatImageError({
        code: 'AGENT_IMAGE_KIND_MIXED',
        message: '参考截图不能和菜单照、环境照一起发：请只保留参考截图，或分开各发一轮。',
      });
      return;
    }

    const intent = resolveFrontendGenerationIntent({ text, images: list });
    if (intent !== 'none') {
      const draft = list[0];
      const image = {
        assetId: null,
        name: draft.name || '参考截图',
        mediaType: draft.mediaType,
        bytes: draft.bytes,
        dataBase64: draft.dataBase64,
        previewUrl: draft.previewDataUrl || '',
      };
      const checked = validateReferenceImage(image);
      if (!checked.ok) {
        setAgentChatImageError({ code: checked.code, message: checked.message });
        return;
      }
      return runSidebarFrontendAutomation({
        text: String(text ?? '').trim() || '请按这张参考图生成首页骨架。',
        image,
        retry,
      });
    }

    if (menuImages.length) {
      handleAgentTurn(text || '请只识别这张菜单图片，把菜名、价格与描述回写到菜品资料；不要修改页面布局。', {
        origin: AGENT_CHAT_ORIGINS.SIDEBAR,
        images: menuImages,
        requireVision: true,
        allowAnyPhase: true,
        retry,
      });
      return;
    }
    runAppAssistantTurn({ text, images: list, retry });
  };

  /**
   * 侧栏发送入口：任意阶段都进入同一个统一会话。
   *
   * 能否发送的判断只来自 `buildAgentChatSubmitPlan`（domain 唯一口径）；
   * 允许只发图片——用途由 Agent 判断，不确定时先追问。
   */
  const handleAgentChatSubmit = (value) => {
    const text = String(value ?? '').trim();
    const images = agentChatImagesRef.current;
    const projectId = state.project.activeId || null;
    const plan = buildAgentChatSubmitPlan({ projectId, phase, hasProject: Boolean(projectId) });
    if (!plan.allowed) {
      setNotice(plan.notice);
      return;
    }
    // 这里原来三处都是静默 return：按钮可点却什么都没发生，用户只能反复点击。
    // 统一改成「就地给出原因」，并且把原因同时写进附件区/提示条，避免再出现“没反应”。
    if (agentChatBusy.current || agentChatState.status === CHAT_STATUS.REQUESTING || isFrontendBusy(frontendState)) {
      setNotice(isFrontendBusy(frontendState)
        ? '参考图候选正在自动构建或验证，等本轮结束后再发送。'
        : '上一轮还在处理中：等结果回来（或失败后点「重试上一轮」）再发送。');
      return;
    }
    if (!isValidChatDraft(text) && !images.length) {
      setNotice('先输入要改的内容，或点「添加图片」附一张图，再发送。');
      return;
    }
    if (!isValidChatDraft(text) && images.length) {
      setNotice('已发送图片：用途交给项目 Agent 判断，不确定时会先追问。');
    }
    dispatchAgentChatTurn(text, images);
  };

  /**
   * 侧栏「重试上一轮」：重放上一轮原话，不重复追加用户消息。
   *
   * 必须按附件用途重新分流：上一轮如果是菜单照（agent-turn.v2），重试仍走 v2；
   * 固定走 app-assistant 会把菜单照当成普通附件发过去，等于换了一条链路。
   */
  const handleAgentChatRetry = () => {
    if (!state.project.activeId) return;
    if (agentChatState.status !== CHAT_STATUS.FAILED) return;
    if (agentChatBusy.current) return;
    const text = String(agentChatState.lastUtterance ?? '').trim();
    if (!text) return;
    dispatchAgentChatTurn(text, agentChatImagesRef.current, { retry: true });
  };

  /**
   * 「撤销本轮」：只有项目仍停在这次字段批次应用后的版本时才可用。
   *
   * 用户在应用后又手改了业务内容，就改为提示使用全局撤销，避免把后续修改一起退掉。
   */
  const handleAgentChatUndoApplied = () => {
    const applied = agentChatState.lastApplied;
    if (!applied) return;
    const current = Number.isInteger(state.project.contentRevision) ? state.project.contentRevision : 0;
    if (current !== applied.appliedRevision) {
      setNotice('项目在这之后又有变化，不能只撤销这一轮；请使用全局撤销。');
      return;
    }
    dispatch({ type: 'UNDO_APPLY' });
    // 撤销成功后清掉这一轮的变更卡与冲突提示，并明确告诉用户已经撤销。
    dispatch({ type: 'AGENT_CHAT_UNDO_APPLIED', requestId: applied.requestId });
    setNotice('已撤销本轮修改，门店资料已回到这一轮应用前的值。');
  };

  /** 侧栏统一先进入门店资料阶段，再定位同一个候选面板。 */
  const handleAgentChatOpenCandidates = () => {
    dispatch({ type: 'PHASE_GOTO', phase: PHASES.STORE_INFO });
    if (typeof document === 'undefined') return;
    setTimeout(() => {
      const node = document.getElementById('frontend-reconstruct-panel');
      if (!node) {
        setNotice('已进入「门店资料」阶段，请在参考图区域查看候选进度。');
        return;
      }
      if (typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'center' });
      setNotice('已定位到「参考图重构」候选面板。');
    }, 0);
  };

  // ---- P3：参考截图 → 识别 → 确认 → 候选模板 ----

  const createReferenceImage = async (file, assetId = null) => {
    const draft = await prepareImageFile(file, { kind: 'menu', name: file.name || '参考截图' });
    const image = {
      assetId,
      name: draft.name,
      mediaType: draft.mediaType,
      bytes: draft.bytes,
      dataBase64: draft.dataBase64,
      previewUrl: draft.previewDataUrl,
    };
    const check = validateReferenceImage(image);
    if (!check.ok) throw new Error(check.message);
    return image;
  };

  const createReferenceImageFromDataUrl = async (dataUrl, name, assetId) => {
    if (!dataUrl) throw new Error('截图预览读取失败，请重新选择。');
    const blob = dataUrlToBlob(dataUrl);
    const file = new File([blob], name, { type: blob.type || 'image/jpeg' });
    return createReferenceImage(file, assetId);
  };

  const commitScreenRefImage = async (image) => {
    const previousAssetId = state.screenRef.image?.assetId || null;
    setScreenRefImageStatus(state.screenRef.image ? 'replaced' : 'idle');
    setScreenRefPersisted(Boolean(image.assetId));
    dispatch({ type: 'SCREEN_REF_IMAGE_SET', image });
    const service = projectServiceRef.current;
    const projectId = state.project.activeId;
    if (previousAssetId && previousAssetId !== image.assetId && projectId && service.mode === 'desktop') {
      try {
        const removed = await service.removeAsset(projectId, previousAssetId);
        if (removed.status !== 'ok') setNotice('新截图已保存，但旧截图资产未能删除，可在项目目录中检查。');
      } catch (error) {
        setNotice('新截图已保存，但旧截图资产未能删除，可在项目目录中检查。');
      }
    }
  };

  const handleScreenRefPick = async (openFileInput) => {
    setScreenRefError(null);
    const service = projectServiceRef.current;
    if (service.mode !== 'desktop') {
      setScreenRefPersisted(false);
      if (typeof openFileInput === 'function') openFileInput();
      return;
    }
    const projectId = state.project.activeId;
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
      const image = await createReferenceImageFromDataUrl(
        dataUrl,
        asset.originalName || item.name || '参考截图',
        asset.assetId,
      );
      await commitScreenRefImage(image);
    } catch (error) {
      setScreenRefError(error?.message || '上传或压缩截图失败，请重试。');
    }
  };

  const handleScreenRefFile = async (file) => {
    setScreenRefError(null);
    if (!file) return;
    try {
      const image = await createReferenceImage(file);
      await commitScreenRefImage(image);
    } catch (error) {
      setScreenRefError(error?.message || '读取或压缩截图失败，请重新选择。');
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
  const handleScreenRefReset = async () => {
    setScreenRefError(null);
    const image = state.screenRef.image;
    const service = projectServiceRef.current;
    const projectId = state.project.activeId;
    if (image?.assetId && projectId && service.mode === 'desktop') {
      try {
        const removed = await service.removeAsset(projectId, image.assetId);
        if (removed.status !== 'ok') {
          setScreenRefError(removed.message || '截图资产删除失败，请重试。');
          return;
        }
      } catch (error) {
        setScreenRefError('截图资产删除失败，请重试。');
        return;
      }
    }
    frontendDispatch({ type: 'FRONTEND_RESET', keepImage: false });
    setFrontendLocalError(null);
    setScreenRefImageStatus('idle');
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

  // B5：真正发起识别（只有拿到本次确认才会走到这里）。
  const runFrontendAnalyze = async ({ consent }) => {
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
      consent,
    });
    if (!result.ok) {
      if (result.code === 'FRONTEND_CANCELLED') {
        frontendDispatch({ type: 'FRONTEND_CANCELLED', runId, revision });
      } else {
        // 确认相关的失败要能让用户直接重新确认，而不是看着一个「失败」发呆。
        if (typeof result.code === 'string' && result.code.startsWith('FRONTEND_CONSENT_')) {
          setScreenConsentGrant(null);
        }
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

  const handleFrontendAnalyze = async () => {
    // 重复点击：忙碌时直接忽略（reducer 也会拒绝第二次 REQUEST）。
    if (isFrontendBusy(frontendState)) return;
    const image = state.screenRef.image;
    if (!image) {
      setFrontendLocalError('请先上传一张参考截图，再生成候选前端。');
      return;
    }
    setFrontendLocalError(null);
    setScreenConsentNotice(null);
    const host = endpointHostOf(state.settings.config && state.settings.config.apiBaseUrl);
    const imageDigest = await imageDigestOf(image.dataBase64);
    const usable = isScreenConsentUsable(screenConsentGrant, { imageDigest, host });
    if (!usable.ok) {
      // 没确认过（或换了图 / 换了接收方 / 超时）：只弹告知，不发任何请求。
      setScreenConsentPrompt({
        host,
        imageDigest,
        notice: describeScreenSendNotice({ image, host }),
      });
      return;
    }
    await runFrontendAnalyze({ consent: screenConsentGrant });
  };

  const handleScreenSendConfirm = async () => {
    const prompt = screenConsentPrompt;
    if (!prompt) return;
    const consent = createScreenConsent({ imageDigest: prompt.imageDigest, host: prompt.host });
    setScreenConsentPrompt(null);
    if (!consent) {
      setFrontendLocalError('这张截图的摘要算不出来，请重新上传后再试；这次没有发送。');
      return;
    }
    setScreenConsentGrant(consent);
    const pending = frontendAutomationPending.current;
    frontendAutomationPending.current = null;
    if (pending) {
      if (pending.runId !== frontendState.runId) {
        setScreenConsentNotice('这次确认属于旧候选任务，已丢弃；不会取消当前新任务。');
        return;
      }
      if (pending.revision !== frontendState.revision) {
        frontendDispatch({
          type: 'FRONTEND_CANCELLED',
          runId: frontendState.runId,
          revision: frontendState.revision,
        });
        setScreenConsentNotice('自动候选的输入版本已变化，已取消这次失效任务；请核对输入后重新生成。');
        return;
      }
      await continueSidebarFrontendAutomation({ ...pending, consent });
      return;
    }
    await runFrontendAnalyze({ consent });
  };

  const handleScreenSendCancel = () => {
    const pending = frontendAutomationPending.current;
    frontendAutomationPending.current = null;
    setScreenConsentPrompt(null);
    setScreenConsentGrant(null);
    if (pending) frontendDispatch({ type: 'FRONTEND_CANCELLED', runId: pending.runId, revision: pending.revision });
    setScreenConsentNotice('已取消：这张截图没有发出去，当前项目和模板都没有变化。');
  };

  async function prepareFrontendCandidateContext({ projectState, projectId, runId }) {
    let plan = null;
    try {
      plan = buildPlanFromSession(projectState).plan;
    } catch (error) {
      return { ok: false, code: 'FRONTEND_PLAN_INVALID', message: error?.message || '当前项目 Plan 无法用于候选构建。' };
    }
    if (!plan) return { ok: false, code: 'FRONTEND_PLAN_INVALID', message: '当前项目 Plan 为空，已停止候选构建。' };
    const prepared = await prepareProjectPreview({
      bindingKey: `${projectId}:${runId}`,
      agentDraft: projectState.agentDraft,
      store: projectState.store,
    });
    if (prepared.status !== 'ok') {
      return {
        ok: false,
        code: prepared.code || 'PREVIEW_DATA_FAILED',
        message: `准备独立预览数据失败：${prepared.message || '未知原因'}`,
      };
    }
    return {
      ok: true,
      plan,
      storeId: prepared.storeId,
      backendVersions: prepared.backendVersions,
    };
  }

  async function runFrontendBuildPipeline({ projectState, projectId, runId, revision, draft, verify = false }) {
    frontendDispatch({ type: 'FRONTEND_BUILD_REQUEST' });
    const context = await prepareFrontendCandidateContext({ projectState, projectId, runId });
    if (!context.ok) {
      frontendDispatch({
        type: 'FRONTEND_BUILD_FAILURE',
        runId,
        revision,
        error: { code: context.code, message: context.message },
      });
      return context;
    }

    const result = await frontendService.buildCandidate({
      projectId,
      runId,
      draft,
      plan: context.plan,
      storeId: context.storeId,
      backendVersions: context.backendVersions,
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
      return result;
    }
    frontendDispatch({ type: 'FRONTEND_BUILD_SUCCESS', runId, revision, result });
    if (!verify || !result.candidate || result.verification?.static?.ok !== true) return result;

    const candidate = result.candidate;
    const identity = { runId, revision, candidateId: candidate.candidateId, attempt: candidate.attempt };
    frontendDispatch({ type: 'FRONTEND_VERIFY_REQUEST', ...identity });
    const verified = await frontendService.verifyCandidate({
      projectId,
      runId,
      attempt: candidate.attempt,
      appId: resolvePreviewAppId(projectState.project),
    });
    if (!verified.ok) {
      if (verified.code === 'FRONTEND_CANCELLED') {
        frontendDispatch({ type: 'FRONTEND_CANCELLED', runId, revision });
      } else {
        frontendDispatch({
          type: 'FRONTEND_VERIFY_FAILURE',
          ...identity,
          error: { code: verified.code, message: verified.message },
        });
      }
      return verified;
    }
    frontendDispatch({ type: 'FRONTEND_VERIFY_SUCCESS', ...identity, result: verified });
    return verified;
  }

  const handleFrontendBuild = async () => {
    if (isFrontendBusy(frontendState)) return;
    const draft = frontendState.analysis && frontendState.analysis.draft ? frontendState.analysis.draft : null;
    if (!draft || !frontendState.runId) {
      setFrontendLocalError('没有可构建的草稿，请先重新生成候选前端。');
      return;
    }
    setFrontendLocalError(null);
    await runFrontendBuildPipeline({
      projectState: frontendStateWithCandidate,
      projectId: frontendProjectId(),
      runId: frontendState.runId,
      revision: frontendState.revision,
      draft,
    });
  };

  async function continueSidebarFrontendAutomation({
    projectId,
    runId,
    revision,
    image,
    text,
    targetPages,
    baseTemplate,
    projectState,
    consent,
  }) {
    const analyzed = await frontendService.analyze({
      runId,
      projectId,
      utterance: text,
      image,
      targetPages,
      baseTemplate,
      consent,
    });
    if (!analyzed.ok) {
      if (analyzed.code === 'FRONTEND_CANCELLED') {
        frontendDispatch({ type: 'FRONTEND_CANCELLED', runId, revision });
      } else {
        if (typeof analyzed.code === 'string' && analyzed.code.startsWith('FRONTEND_CONSENT_')) {
          setScreenConsentGrant(null);
        }
        frontendDispatch({
          type: 'FRONTEND_ANALYZE_FAILURE',
          runId,
          revision,
          error: { code: analyzed.code, message: analyzed.message },
        });
      }
      return analyzed;
    }

    frontendDispatch({ type: 'FRONTEND_ANALYZE_SUCCESS', runId, revision, response: analyzed.response });
    if (analyzed.response?.status !== 'planned' || !analyzed.response?.draft) return analyzed;

    const completed = await runFrontendBuildPipeline({
      projectState,
      projectId,
      runId,
      revision,
      draft: analyzed.response.draft,
      verify: true,
    });
    if (completed?.ok && completed?.status === 'PASS') {
      setAgentChatImages([]);
      setAgentChatImageError(null);
    }
    return completed;
  }

  async function runSidebarFrontendAutomation({ text, image, retry = false }) {
    const projectId = state.project.activeId || null;
    if (!projectId || isFrontendBusy(frontendState) || agentChatBusy.current) {
      setAgentChatImageError({
        code: 'FRONTEND_BUSY',
        message: '已有一轮项目或候选任务在处理中，请等它结束后再发送。',
      });
      return null;
    }

    const runId = createFrontendRunId();
    const revision = frontendState.revision + 1;
    const targetPages = frontendState.request.targetPages;
    const baseTemplate = frontendState.request.baseTemplate;
    frontendDispatch({
      type: 'FRONTEND_AUTO_REQUEST',
      runId,
      image,
      utterance: text,
      targetPages,
      baseTemplate,
    });
    await commitScreenRefImage(image);
    handleAgentChatOpenCandidates();

    const assistant = await runAppAssistantTurn({
      text,
      images: [],
      retry,
      preserveAttachments: true,
    });
    if (!assistant) {
      frontendDispatch({
        type: 'FRONTEND_ANALYZE_FAILURE',
        runId,
        revision,
        error: { code: 'APP_ASSISTANT_FAILED', message: '文字资料没有写回成功，已停止自动候选；图片和文字均已保留。' },
      });
      return null;
    }
    const proposal = assistant.proposal || {};
    if (proposal.status === 'needs-input' || proposal.status === 'rejected') {
      frontendDispatch({
        type: 'FRONTEND_ANALYZE_FAILURE',
        runId,
        revision,
        error: {
          code: proposal.status === 'needs-input' ? 'APP_ASSISTANT_NEEDS_INPUT' : 'APP_ASSISTANT_REJECTED',
          message: proposal.reply || '需要先补充或调整文字要求，再生成候选。',
        },
      });
      return assistant;
    }
    const projectState = assistant.projectState;
    if (!projectState) {
      frontendDispatch({
        type: 'FRONTEND_ANALYZE_FAILURE',
        runId,
        revision,
        error: { code: 'APP_ASSISTANT_STATE_MISSING', message: '没有取得资料写回后的项目状态，已停止候选构建。' },
      });
      return assistant;
    }

    const host = endpointHostOf(state.settings.config && state.settings.config.apiBaseUrl);
    let imageDigest = '';
    try {
      imageDigest = await imageDigestOf(image.dataBase64);
    } catch (error) {
      frontendDispatch({
        type: 'FRONTEND_ANALYZE_FAILURE',
        runId,
        revision,
        error: { code: 'FRONTEND_IMAGE_INVALID', message: error?.message || '参考图摘要计算失败，请重新选择图片。' },
      });
      return assistant;
    }
    const usable = isScreenConsentUsable(screenConsentGrant, { imageDigest, host });
    const continuation = {
      projectId,
      runId,
      revision,
      image,
      text,
      targetPages,
      baseTemplate,
      projectState,
    };
    if (!usable.ok) {
      frontendAutomationPending.current = continuation;
      setScreenConsentPrompt({
        host,
        imageDigest,
        notice: describeScreenSendNotice({ image, host }),
      });
      setScreenConsentNotice('确认发送参考图后，会自动继续构建与验证候选，不会自动采用。');
      return assistant;
    }
    return continueSidebarFrontendAutomation({ ...continuation, consent: screenConsentGrant });
  }

  const handleFrontendVerify = async () => {
    if (isFrontendBusy(frontendState) || !frontendState.candidate) return;
    const { runId, revision, candidate } = frontendState;
    const identity = { runId, revision, candidateId: candidate.candidateId, attempt: candidate.attempt };
    frontendDispatch({ type: 'FRONTEND_VERIFY_REQUEST', ...identity });
    const result = await frontendService.verifyCandidate({
      projectId: frontendProjectId(),
      runId,
      attempt: candidate.attempt,
      appId: resolvePreviewAppId(state.project),
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
    const canContinue = Boolean(record && record.status === 'adopted') && runtimeStatus !== 'FAIL';
    setNotice(record && record.status === 'adopted'
      ? (canContinue
        ? '已采用这个骨架并进入继续制作；最终微信预览需另行点击。'
        : '候选已记录，但微信运行时 FAIL，已阻止进入继续制作。')
      : '已采用候选前端，但快照记录不完整（缺少 overlay 引用或摘要），导出会被阻断；请重新构建/采用一次。');
    frontendDispatch({ type: 'FRONTEND_ADOPT_SUCCESS', ...identity, adoption: result.adoption });
    if (canContinue) dispatch({ type: 'PHASE_GOTO', phase: PHASES.PROMPT_STUDIO });
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
    const image = state.screenRef.image;
    if (image?.assetId && !image.dataBase64) return;
    frontendDispatch({ type: 'FRONTEND_INPUT_SET', image });
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

  /**
   * 拖拽海报素材：只支持 PNG、≤2 MB；与「上传图片（PNG）」同一条资产落盘链路。
   * 拖入后回读预览并写进视觉切片，未保存成功前不允许「使用此图」。
   */
  const handleDropPoster = async (file) => {
    if (posterBusy || !file) return;
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
    const type = String(file.type || '').toLowerCase();
    if (type !== 'image/png') {
      setNotice('海报素材目前只支持 PNG 图片，请重新选择');
      return;
    }
    if (Number(file.size) > MAX_POSTER_UPLOAD_BYTES) {
      setNotice('图片超过 2 MB，请压缩后再上传');
      return;
    }

    setPosterBusy(true);
    try {
      const dataBase64 = await readImageFileAsBase64(file);
      if (!dataBase64) {
        setNotice('读取图片失败，请重新选择');
        return;
      }
      const attached = await service.attachImageData(projectId, [{
        name: String(file.name || 'poster.png'),
        mime: type,
        dataBase64,
      }]);
      if (attached.status !== 'ok') {
        setNotice(attached.message || '保存图片失败，请重试');
        return;
      }
      const asset = Array.isArray(attached.assets) ? attached.assets[0] : null;
      if (!asset || !asset.assetId) {
        setNotice('保存图片失败，请重试');
        return;
      }
      if (Number.isFinite(asset.bytes) && asset.bytes > MAX_POSTER_UPLOAD_BYTES) {
        setNotice('图片超过 2 MB，请压缩后再上传');
        return;
      }
      const preview = await service.readAsset(projectId, asset.assetId, 720);
      if (preview.status !== 'ok' || !preview.asset || !preview.asset.dataUrl) {
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
          note: '你拖入的图片，不是模型生成结果',
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

  // G1：海报阶段的真实生图提示词与能力探测。
  // 只读服务端状态，不触发任何上游调用；提示词由服务端按已确认资料生成一次，用户可改。
  useEffect(() => {
    if (state.phase !== PHASES.IMAGE_REVIEW) return undefined;
    const baseUrl = state.settings.config?.apiBaseUrl;
    const styleLabel = (STYLE_PRESETS.find((item) => item.id === state.visual.styleId) ?? STYLE_PRESETS[0])?.name || '';
    const storeName = state.store.name || state.agentDraft.storeName || '';
    const promptKey = [storeName, state.agentDraft.category, styleLabel, state.agentDraft.dishes.length].join('|');
    let alive = true;
    (async () => {
      const status = await fetchPosterStatus(baseUrl).catch(() => null);
      if (!alive) return;
      setPosterGen((previous) => ({
        ...previous,
        status: !status
          ? 'unavailable'
          : (status.ok ? (status.configured ? 'ready' : 'unconfigured') : 'unavailable'),
        configured: Boolean(status && status.ok && status.configured),
        provider: status && status.ok ? status.provider : '',
        model: status && status.ok ? status.model : '',
        disclosure: status && status.ok ? status.disclosure : '',
      }));
      if (!status || !status.ok || !status.configured) return;
      if (posterPromptLoaded.current === promptKey) return;
      const built = await fetchPosterPrompt(baseUrl, {
        storeName,
        storeType: state.agentDraft.category || state.store.type,
        styleLabel,
        dishes: state.agentDraft.dishes.map((dish) => dish.name),
      }).catch(() => null);
      if (!alive || !built || !built.ok) return;
      posterPromptLoaded.current = promptKey;
      setPosterGen((previous) => (previous.prompt ? previous : { ...previous, prompt: built.prompt }));
    })();
    return () => { alive = false; };
  }, [
    state.phase,
    state.settings.config?.apiBaseUrl,
    state.store.name,
    state.store.type,
    state.agentDraft.storeName,
    state.agentDraft.category,
    state.agentDraft.dishes,
    state.visual.styleId,
  ]);

  /**
   * G1：真实生成一张海报。
   * - 只有服务端确认返回合法 PNG，才会落盘、才会显示「AI 生成成功」；
   * - 落盘走主进程受控资产链路（saveGeneratedImage），来源记 ai-generated；
   * - 晚到的响应不覆盖更新的选择：每次请求带自增序号，只有最新那次能写状态。
   */
  const handleGeneratePoster = async () => {
    if (posterGen.busy || posterBusy) return;
    const service = projectServiceRef.current;
    const projectId = state.project.activeId;
    if (service.mode !== 'desktop') {
      setNotice('浏览器模式不会把图片写进项目，请在桌面应用中生成海报');
      return;
    }
    if (!projectId) {
      setNotice('请先在工作台新建或打开项目，再生成海报');
      return;
    }
    const prompt = String(posterGen.prompt || '').trim();
    if (!prompt) {
      setPosterGen((previous) => ({ ...previous, error: '请先写一段海报提示词' }));
      return;
    }
    posterGenSeq.current += 1;
    const seq = posterGenSeq.current;
    setPosterGen((previous) => ({ ...previous, busy: true, error: '', success: null }));
    try {
      const result = await generatePoster(state.settings.config?.apiBaseUrl, { prompt });
      if (seq !== posterGenSeq.current) return;
      if (!result.ok) {
        setPosterGen((previous) => ({ ...previous, busy: false, error: describePosterError(result.code, result.message) }));
        return;
      }
      const saved = await service.saveGeneratedImage(projectId, {
        dataUrl: result.dataUrl,
        source: 'ai-generated',
        provider: result.provider,
        model: result.model,
      });
      if (seq !== posterGenSeq.current) return;
      if (saved.status !== 'ok' || !saved.asset || !saved.asset.assetId) {
        setPosterGen((previous) => ({
          ...previous,
          busy: false,
          error: saved.message || '图片已生成，但保存到项目失败，请重试',
        }));
        return;
      }
      const preview = await service.readAsset(projectId, saved.asset.assetId, 720).catch(() => null);
      if (seq !== posterGenSeq.current) return;
      if (!preview || preview.status !== 'ok' || !preview.asset || !preview.asset.dataUrl) {
        setPosterGen((previous) => ({ ...previous, busy: false, error: '图片已保存，但预览读取失败，请重新生成' }));
        return;
      }
      // 资产元数据必须同步进渲染进程的项目文档：否则下一次自动保存会把主进程刚写的
      // assets.images 覆盖成空列表，导出时会报 MEDIA_ASSET_NOT_IN_PROJECT。
      dispatch({ type: 'ADD_PROJECT_IMAGES', images: [saved.asset] });
      dispatch({
        type: 'SET_POSTER_ASSET',
        assetId: saved.asset.assetId,
        meta: {
          provider: 'ai-generated',
          width: saved.asset.width,
          height: saved.asset.height,
          model: result.model,
          note: '这张图由第三方生图服务真实生成',
        },
        preview: preview.asset.dataUrl,
      });
      setPosterGen((previous) => ({
        ...previous,
        busy: false,
        error: '',
        success: {
          width: result.width,
          height: result.height,
          bytes: result.bytes,
          latencyMs: result.latencyMs,
          model: result.model,
        },
      }));
      setNotice('AI 生成的海报已保存到项目');
    } catch (error) {
      if (seq !== posterGenSeq.current) return;
      setPosterGen((previous) => ({
        ...previous,
        busy: false,
        error: error instanceof Error ? error.message : '生成海报失败，请重试',
      }));
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

  useEffect(() => {
    const assets = Array.isArray(state.assets?.images) ? state.assets.images : [];
    setSelectedStoreImageId((previous) => (
      assets.some((item) => item.assetId === previous) ? previous : (assets[0]?.assetId || null)
    ));
    setStoreImageAnalysis((previous) => (
      assets.some((item) => item.assetId === previous.assetId)
        ? previous
        : { status: 'idle', assetId: null, message: '' }
    ));
    const service = projectServiceRef.current;
    const projectId = state.project.activeId;
    if (!projectId || service.mode !== 'desktop' || assets.length === 0) {
      setStoreImagePreviews({});
      return undefined;
    }
    let alive = true;
    Promise.all(assets.map(async (asset) => {
      const result = await service.readAsset(projectId, asset.assetId, 480).catch(() => null);
      const previewUrl = result?.status === 'ok' ? result.asset?.dataUrl || '' : '';
      return [asset.assetId, previewUrl];
    })).then((entries) => {
      if (alive) setStoreImagePreviews(Object.fromEntries(entries));
    });
    return () => { alive = false; };
  }, [state.project.activeId, state.assets.images]);

  const handleSelectStoreImage = (assetId) => {
    setSelectedStoreImageId(assetId);
    setStoreImageAnalysis((previous) => (
      previous.assetId === assetId ? previous : { status: 'idle', assetId, message: '' }
    ));
  };

  const handleRemoveStoreImage = async (assetId) => {
    if (storeImageBusy || !assetId) return;
    const service = projectServiceRef.current;
    const projectId = state.project.activeId;
    if (!projectId || service.mode !== 'desktop') return;
    setStoreImageBusy(true);
    try {
      const removed = await service.removeAsset(projectId, assetId);
      if (removed.status !== 'ok') {
        setNotice(removed.message || '删除环境图片失败');
        return;
      }
      dispatch({ type: 'REMOVE_PROJECT_IMAGE', assetId });
      setStoreImagePreviews((previous) => {
        const next = { ...previous };
        delete next[assetId];
        return next;
      });
      setStoreImageAnalysis((previous) => (
        previous.assetId === assetId
          ? { status: 'idle', assetId: null, message: '' }
          : previous
      ));
      setNotice('已删除环境图片');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '删除环境图片失败');
    } finally {
      setStoreImageBusy(false);
    }
  };

  const handleAnalyzeStoreImage = async (assetId) => {
    if (storeImageBusy || !assetId) return;
    const service = projectServiceRef.current;
    const projectId = state.project.activeId;
    const asset = state.assets.images.find((item) => item.assetId === assetId);
    if (!asset || !projectId || service.mode !== 'desktop') return;
    setStoreImageBusy(true);
    setStoreImageAnalysis({ status: 'analyzing', assetId, message: '正在分析选中图片的门店氛围，不会回写菜品或布局。' });
    try {
      const read = await service.readAsset(projectId, assetId, 1280);
      const dataUrl = read?.status === 'ok' ? read.asset?.dataUrl || '' : '';
      if (!dataUrl) throw new Error('环境图片读取失败，请重新选择。');
      const blob = dataUrlToBlob(dataUrl);
      const name = asset.originalName || asset.fileName || '门店环境图片';
      const file = new File([blob], name, { type: blob.type || asset.mime || 'image/jpeg' });
      const draft = await prepareImageFile(file, { kind: 'store', id: assetId, name });
      const result = await requestAgentTurn({
        utterance: '只分析这张门店环境图呈现的装修、光线与氛围，用简短中文说明；不要识别菜品，不要修改菜名、价格、描述或页面布局。',
        draft: state.agentDraft,
        images: [draft],
      });
      if (result.vision?.analyzed !== true) {
        setStoreImageAnalysis({
          status: 'failed',
          assetId,
          message: '当前图片识别服务没有真正读取环境图片，未生成氛围分析。请检查模型配置后重试。',
        });
      } else {
        setStoreImageAnalysis({
          status: 'analyzed',
          assetId,
          message: result.reply || '氛围分析完成；未回写菜品资料，也未修改页面布局。',
        });
      }
    } catch (error) {
      setStoreImageAnalysis({
        status: 'failed',
        assetId,
        message: error instanceof Error ? error.message : '氛围分析失败，图片已保留，可以重试。',
      });
    } finally {
      setStoreImageBusy(false);
    }
  };

  /**
   * 拖拽门店环境图：与「添加环境图片」走同一条资产落盘链路。
   * 渲染进程只把文件内容转成 base64，类型/体积由主进程重新校验。
   */
  const handleDropStoreImages = async (files) => {
    if (storeImageBusy) return;
    const service = projectServiceRef.current;
    const projectId = state.project.activeId;
    if (service.mode !== 'desktop') {
      setNotice('浏览器模式不支持图片落盘，请在桌面应用中拖入门店图片');
      return;
    }
    if (!projectId) {
      setNotice('请先在工作台新建项目，再添加门店图片');
      return;
    }
    const incoming = Array.from(files ?? []);
    if (incoming.length === 0) return;
    const current = Array.isArray(state.assets && state.assets.images) ? state.assets.images : [];
    const room = Math.max(0, 6 - current.length);
    if (room === 0) {
      setNotice('最多保留 6 张门店图片');
      return;
    }

    setStoreImageBusy(true);
    try {
      const items = [];
      for (const file of incoming.slice(0, room)) {
        const type = String(file?.type ?? '').toLowerCase();
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(type)) {
          setNotice('仅支持 PNG / JPG / WebP 图片');
          continue;
        }
        if (Number(file?.size) > 10 * 1024 * 1024) {
          setNotice('单张图片不能超过 10 MB');
          continue;
        }
        const dataBase64 = await readImageFileAsBase64(file);
        if (!dataBase64) continue;
        items.push({ name: String(file.name || 'dropped-image'), mime: type, dataBase64 });
      }
      if (items.length === 0) return;

      const attached = await service.attachImageData(projectId, items);
      if (attached.status !== 'ok') {
        setNotice(attached.message || '导入拖入的图片失败');
        return;
      }
      const assets = Array.isArray(attached.assets) ? attached.assets.slice(0, room) : [];
      dispatch({ type: 'ADD_PROJECT_IMAGES', images: assets });
      const known = new Set(current.map((item) => item.assetId));
      const added = assets.filter((item) => !known.has(item.assetId));
      const nextSelectedId = selectedStoreImageId || added[0]?.assetId || null;
      setSelectedStoreImageId(nextSelectedId);
      setStoreImageAnalysis((previous) => (
        previous.assetId === nextSelectedId
          ? previous
          : { status: 'idle', assetId: nextSelectedId, message: '' }
      ));
      setNotice(added.length > 0
        ? `已拖入 ${added.length} 张门店图片，请选择一张用于氛围分析`
        : '拖入的图片已在项目中');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '导入拖入的图片失败');
    } finally {
      setStoreImageBusy(false);
    }
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
    const room = Math.max(0, 6 - current.length);
    if (room === 0) {
      setNotice('最多保留 6 张门店图片');
      return;
    }
    setStoreImageBusy(true);
    try {
      const picked = await service.pickImages(room);
      if (picked.status !== 'ok') {
        setNotice(picked.message || '选择图片失败');
        return;
      }
      const items = Array.isArray(picked.items) ? picked.items.slice(0, room) : [];
      if (items.length === 0) return;
      const attached = await service.attachImages(projectId, items.map((item) => item.token));
      if (attached.status !== 'ok') {
        setNotice(attached.message || '导入图片失败');
        return;
      }
      const assets = attached.assets.slice(0, room);
      dispatch({ type: 'ADD_PROJECT_IMAGES', images: assets });
      const known = new Set(current.map((item) => item.assetId));
      const added = assets.filter((item) => !known.has(item.assetId));
      const nextSelectedId = selectedStoreImageId || added[0]?.assetId || null;
      setSelectedStoreImageId(nextSelectedId);
      setStoreImageAnalysis((previous) => (
        previous.assetId === nextSelectedId
          ? previous
          : { status: 'idle', assetId: nextSelectedId, message: '' }
      ));
      setNotice(added.length > 0 ? `已添加 ${added.length} 张门店图片，请选择一张用于氛围分析` : '所选图片已在项目中');
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
    const gate = selectCanChooseDirectory(state, exportSignatureParts.signature);
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
    const gate = selectCanChooseDirectory(state, exportSignatureParts.signature);
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
    const gate = selectCanChooseDirectory(state, exportSignatureParts.signature);
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
      let effectiveDirectory = state.deploy.directory
        || (defaultTarget.status === 'ok' ? defaultTarget.path : '');
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
            effectiveDirectory = defaultTarget.path;
            target = fallback;
          }
        }
        merged = mergeTargetPreflight(merged, target);
      }
      // B4 规则 6：体检结果与「当前 Plan + 素材 + 目标位置」的签名一起落库，
      // 任何一项变了都会让这份结果失效，不再显示「可以导出」。
      const signatureParts = buildSignatureParts({
        plan: exportPlanForReview.ok ? exportPlanForReview.plan : null,
        posterAssetId: state.visual.imageAssetId || null,
        directory: effectiveDirectory,
        projectName: state.deploy.projectName
          || sanitizeProjectName(state.store.name || state.agentDraft.storeName),
      });
      dispatch({
        type: 'PREFLIGHT_RESULT',
        errors: merged.errors,
        warns: merged.warns,
        infos: merged.infos,
        planDigest: merged.planDigest,
        recipe: merged.recipe || null,
        signature: signatureParts,
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
              onSkip={() => dispatch({ type: 'SUBMIT_CUSTOMIZE', value: '' })}
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
              canUndo={undoState.canUndo}
              onUndo={() => dispatch({ type: 'UNDO_APPLY' })}
              onRefine={(value) => {
                dispatch({ type: 'SUBMIT_TEMPLATE_FEEDBACK', value });
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
        const canConfirm = agent.status === 'reviewing'
          && agent.missingFields.length === 0
          && agent.errors.length === 0;
        const confirmed = agent.status === 'confirmed';
        const validation = {
          missingFields: agent.missingFields,
          errors: agent.errors,
          readyForReview: canConfirm,
        };
        const draftDisabled = agent.status === 'requesting' || confirmed;
        const environmentStatusLabels = {
          idle: '待识别',
          analyzing: '识别中',
          analyzed: '已分析',
          failed: '识别失败',
        };
        const basicSection = (
          <>
            <DraftEditor
              draft={state.agentDraft}
              validation={validation}
              disabled={draftDisabled}
              open={draftEditorOpen}
              mode="store"
              collapsible={false}
              embedded
              onToggleOpen={() => setDraftEditorOpen((value) => !value)}
              onChangeField={handleAgentFieldChange}
              onToggleFulfillment={handleAgentFulfillment}
              onChangeDish={handleAgentDishChange}
              onAddDish={handleAgentAddDish}
              onRemoveDish={handleAgentRemoveDish}
            />
            <StoreInfoStep
              store={{ ...state.store, intro: state.store.notes }}
              storeTypes={storeTypesForForm}
              styles={STYLE_PRESETS}
              styleId={state.visual.styleId}
              embedded
              showHeader={false}
              showIdentity={false}
              showImages={false}
              showSubmit={false}
              onFieldChange={handleFieldChange}
              onStyleChange={(id) => dispatch({ type: 'SET_STYLE', id })}
            />
          </>
        );
        const dishesSection = (
          <>
            <DraftEditor
              draft={state.agentDraft}
              validation={validation}
              disabled={draftDisabled}
              open={draftEditorOpen}
              mode="dishes"
              collapsible={false}
              embedded
              onToggleOpen={() => setDraftEditorOpen((value) => !value)}
              onChangeField={handleAgentFieldChange}
              onToggleFulfillment={handleAgentFulfillment}
              onChangeDish={handleAgentDishChange}
              onAddDish={handleAgentAddDish}
              onRemoveDish={handleAgentRemoveDish}
            />
            <VisionImageUploader
              images={agentImages}
              kinds={['menu']}
              busy={agent.status === 'requesting'}
              disabled={confirmed}
              error={agentImageError}
              recognition={menuImageRecognition}
              onAdd={handleVisionImagesAdd}
              onRemove={handleVisionImageRemove}
              onRecognize={handleRecognizeMenuImages}
            />
          </>
        );
        const environmentSection = (
          <StoreInfoStep
            embedded
            showHeader={false}
            showIdentity={false}
            showContact={false}
            showStyle={false}
            showSubmit={false}
            images={state.assets.images.map((item) => ({
              ...item,
              previewUrl: storeImagePreviews[item.assetId] || '',
              statusLabel: storeImageAnalysis.assetId === item.assetId
                ? environmentStatusLabels[storeImageAnalysis.status] || '待识别'
                : '待识别',
            }))}
            imageBusy={storeImageBusy}
            selectedImageId={selectedStoreImageId}
            imageAnalysis={storeImageAnalysis}
            onPickImages={handlePickStoreImages}
            onDropImages={handleDropStoreImages}
            onSelectImage={handleSelectStoreImage}
            onRemoveImage={handleRemoveStoreImage}
            onAnalyzeImage={handleAnalyzeStoreImage}
          />
        );
        // B5：不要在这里包一层 Fragment —— ScreenReferencePanel 会把 uploadSlot
        // 通过 cloneElement 注入到候选面板里，包 Fragment 会让上传入口整个消失。
        const frontendCandidatePanel = (
          <FrontendCandidatePanel
            view={frontendView}
            imageReady={Boolean(state.screenRef.image)}
            desktopMode={frontendService.mode === 'desktop'}
            localError={frontendLocalError}
            notice={screenConsentNotice}
            consentNotice={screenConsentPrompt ? screenConsentPrompt.notice : null}
            onConsentConfirm={handleScreenSendConfirm}
            onConsentCancel={handleScreenSendCancel}
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
        const referenceSection = (
          <ScreenReferencePanel
            view={state.screenRef.view}
            busy={state.screenRef.status === 'recognizing'}
            localError={screenRefError}
            persisted={screenRefPersisted}
            frontendPanel={frontendCandidatePanel}
            frontendView={frontendView}
            imageStatus={screenRefImageStatus}
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
        return (
          <>
            {confirmed ? (
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
            ) : (
              <AgentIntakePanel
                status={agent.status}
                reply={agent.reply}
                missingFields={agent.missingFields}
                errors={agent.errors}
                nextQuestion={agent.nextQuestion}
                lastError={agent.lastError}
                attempts={agent.attempts}
                process={agent.process}
                processHistory={agent.processHistory}
                staleDraftNotice={agent.staleDraftNotice}
                hint={agent.hint}
                onRetry={handleAgentRetry}
              />
            )}
            <StoreInfoSections
              basic={basicSection}
              dishes={dishesSection}
              environment={environmentSection}
              reference={referenceSection}
            />
            {confirmed ? (
              <div className="store-step-foot">
                <button type="button" className="store-submit" onClick={handleStoreSubmit}>确认店铺信息</button>
              </div>
            ) : null}
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
            onDropFile={handleDropPoster}
            onUse={() => {
              if (!state.visual.imageAssetId) {
                setNotice('图片还没有保存到项目，请重新选择图片');
                return;
              }
              dispatch({
                type: 'APPROVE_IMAGE',
                material: state.visual.image && state.visual.image.provider === 'ai-generated'
                  ? 'ai-generated'
                  : 'uploaded',
              });
            }}
            onSkip={() => dispatch({ type: 'APPROVE_IMAGE', material: 'skipped' })}
            canGenerate={posterGen.configured || canGenerateImage()}
            generateBlockedReason={IMAGE_GENERATION_BLOCKED_REASON}
            generator={posterGen.configured ? {
              prompt: posterGen.prompt,
              onPromptChange: (value) => setPosterGen((previous) => ({ ...previous, prompt: value, error: '' })),
              onGenerate: handleGeneratePoster,
              busy: posterGen.busy,
              error: posterGen.error,
              success: posterGen.success,
              providerLabel: [posterGen.provider, posterGen.model].filter(Boolean).join(' / '),
              model: posterGen.model,
            } : null}
          />
        );
case PHASES.DEPLOY: {
        // 规则 6：体检结果过期时不允许导出（旧的「可以导出」不能继续用）。
        const exportGate = selectCanExport(state, exportSignatureParts.signature);
        const chooseGate = selectCanChooseDirectory(state, exportSignatureParts.signature);
        return (
          <>
            <PreflightPanel
              status={state.deploy.preflight.status}
              errors={state.deploy.preflight.errors}
              warns={state.deploy.preflight.warns}
              infos={state.deploy.preflight.infos}
              acknowledged={state.deploy.preflight.acknowledged}
              checkedAt={state.deploy.preflight.checkedAt}
              canExport={exportGate}
              stale={preflightStale}
              staleReason={preflightStaleReason}
              onRerun={runPreflight}
              onToggleAck={(ruleId) => dispatch({ type: 'PREFLIGHT_ACK_TOGGLE', ruleId })}
              onGoto={(nextPhase) => dispatch({ type: 'PHASE_GOTO', phase: nextPhase })}
            />
            <ExportReviewCard
              review={exportReview}
              stale={preflightStale}
              staleReason={preflightStaleReason}
              onRerun={runPreflight}
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
  // 三.3：Agent 在等用户去别的区域点一个控件时，必须说清「等什么 / 在哪 / 点哪个」。
  // 推导口径只在 domain/agentWaiting.mjs 一处；这里只做接线，不另写第二套条件。
  const agentWaitingHint = selectAgentWaitingHint({
    phase,
    agent: state.agent,
    build: state.build,
    presentation: presentationState,
  });
  // 跳转只做「滚到控件 + 聚焦 + 高亮一下」，绝不代替用户点确认/应用/生成/导出。
  // `behavior: 'instant'` 是必须的：主流区 `.chat-stream` 设了 `scroll-behavior: smooth`，
  // 平滑滚动会被聊天流的自动滚到底打断，等于点了没反应。
  const jumpToControl = (jumpId) => {
    const node = document.querySelector(`[data-jump-id="${jumpId}"]`);
    if (!node) {
      const fallback = document.querySelector(jumpId === 'template-apply' ? '.template-gallery' : '.workspace-actions');
      fallback?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      return;
    }
    node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    if (typeof node.focus === 'function') node.focus({ preventScroll: true });
    node.classList.add('is-jump-flash');
    window.setTimeout(() => node.classList.remove('is-jump-flash'), 1600);
  };
  const handleWaitingGo = (jumpId) => jumpToControl(jumpId);
  // 问题 6：待确认卡片必须给一条「能点到的下一步」——只定位到原业务面板并高亮，
  // 写入仍然要用户自己在那里点确认（不自动点、不自动写）。
  const pendingConfirmItems = describePendingConfirmations(agentChatState.lastPending, {
    fieldLabel: (fieldId) => {
      const field = findAppCapabilityField(fieldId);
      return field && typeof field.label === 'string' ? field.label : '';
    },
    actionLabel: (actionId) => {
      const handler = APP_ASSISTANT_ACTION_HANDLERS[actionId];
      return handler && typeof handler.label === 'string' ? handler.label : '';
    },
  }).map((item) => ({
    ...item,
    // 上方等待提示已经指向同一个控件时，卡片不再放第二个按钮要求同一件事。
    sameTargetAsHint: Boolean(agentWaitingHint && agentWaitingHint.jumpId === item.jumpId),
  }));
  const handlePendingConfirmGo = (item) => {
    const jumpId = item && typeof item.jumpId === 'string' ? item.jumpId : '';
    if (!jumpId) return;
    const targetPhase = item && typeof item.phase === 'string' ? item.phase : '';
    if (targetPhase && targetPhase !== phase) {
      // 确认入口在别的阶段：先切过去，等这一帧渲染完再滚到控件。
      dispatch({ type: 'PHASE_GOTO', phase: targetPhase });
      window.setTimeout(() => jumpToControl(jumpId), 260);
      return;
    }
    jumpToControl(jumpId);
  };
  // 右侧栏「Agent 对话」视图模型：安全字段 + 回调，组件不持有会话状态、也不自己发请求。
  // 过程卡只给 lastRun（`normalizeChatRun` 白名单产物），trace 不进消息正文。
  const agentChatViewModel = {
    projectId: state.project.activeId || null,
    projectName: String(state.store.name || state.agentDraft.storeName || '').trim(),
    phase,
    phaseLabel: meta?.label ?? '',
    chat: agentChatState,
    candidate: agentChatCandidate,
    // 与 handleAgentChatSubmit 共用同一条原因：面板禁用发送 + 显示原因。
    sendBlockedReason: agentChatSendBlockedReason,
    images: agentChatImages,
    imageKinds: agentChatImageKinds,
    imageError: agentChatImageError,
    imageBusy: agentChatImageBusy,
    onAddImages: handleAgentChatImagesAdd,
    onRemoveImage: handleAgentChatImageRemove,
    onImageBusyChange: setAgentChatImageBusy,
    onDraftChange: (value) => dispatch({ type: 'AGENT_CHAT_DRAFT_SET', value }),
    onSubmit: handleAgentChatSubmit,
    onRetry: handleAgentChatRetry,
    onOpenCandidates: handleAgentChatOpenCandidates,
    onUndoApplied: handleAgentChatUndoApplied,
    waitingHint: agentWaitingHint,
    onWaitingGo: handleWaitingGo,
    // 待确认卡片的逐项定位入口（问题 6）：只定位高亮，不代替用户确认写入。
    pendingConfirm: { items: pendingConfirmItems, onGo: handlePendingConfirmGo },
  };
  // UX0a-3：海报素材（可选）阶段没有真实生图服务，不再提供"重新生成"输入区。
  const composerVisible = phase === PHASES.STORE_INFO
    ? agentComposer.visible
    : (phase === PHASES.TEMPLATE_PICK || phase === PHASES.IMAGE_REVIEW
      ? false
      : COMPOSER_PHASES.includes(phase));
  const skipVisible = phase === PHASES.ONBOARDING && Boolean(state.store.name);
  // 模板页不再复用全局输入框：修改面板是唯一入口（模式开关区分改页面/换候选）。
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
        modelKey={modelKey}
        modelKeySaving={modelKeySaving}
        modelKeyError={modelKeyError}
        modelKeyNotice={modelKeyNotice}
        modelTest={modelTest}
        onSave={handleSettingsSave}
        onSaveModelKey={handleSaveModelKey}
        onClearModelKey={handleClearModelKey}
        onTestModel={handleTestModel}
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

  const previewStoreName = String(
    (state.store && state.store.name) || (state.agentDraft && state.agentDraft.storeName) || '',
  ).trim();
  const previewDockVisible = phase !== PHASES.HOME;
  const previewDockNode = previewDockVisible ? (
    <DevtoolsPreviewDock
      phase={phase}
      storeName={previewStoreName}
      onPrepareProject={handlePreparePreviewProject}
    />
  ) : null;

  return (
    <>
      <AppShell
      sidebar={(
        <Sidebar
          appName="口袋店长·轻启"
          sessions={state.sessions}
          activeSessionId={state.activeSessionId}
          currentStoreName={state.store.name}
          saveLabel={selectSaveLabel(state)}
          mode={state.project.mode}
          modelLabel={selectModelLabel(state)}
          onStartOnboarding={startOnboarding}
          onSelectSession={selectSession}
          onOpenWorkbench={handleOpenWorkbench}
          onOpenSettings={handleOpenSettings}
          onReset={reset}
        />
      )}
      panel={<RightPanel meta={meta} cards={panelCards} agentChat={agentChatViewModel} />}
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
                      missingCount={state.agent.missingFields.length}
                      errorCount={state.agent.errors.length}

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
                    {previewDockNode}
                  </div>
                ) : null}
                {!composerVisible && previewDockNode ? (
                  <div className="workspace-preview-dock">{previewDockNode}</div>
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
      <EnvGuideDialog
        open={envGuideOpen}
        mode={envGuideMode}
        deploymentMode={envGuideDeploymentMode}
        checks={envGuideChecks}
        busy={envGuideBusy}
        onRefresh={runEnvChecks}
        onStart={closeEnvGuideAndContinue}
        onSkip={handleEnvGuideSkip}
        onCopyGuide={handleCopyDevtoolsGuide}
      />
    </>
  );
}