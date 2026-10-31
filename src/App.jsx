import { useEffect, useMemo, useReducer, useRef, useState } from 'react';

import { features as catalogFeatures } from './domain/catalog.mjs';
import { STORE_TYPES, STYLE_PRESETS } from './domain/storeBrief.mjs';
import { DEPLOY_STEPS, SKIP_HINT } from './domain/onboardingScript.mjs';
import {
  PHASES,
  PHASE_META,
  HOME_GREETING,
  COMPOSER_PLACEHOLDER,
  COMPOSER_SUBMIT_LABEL,
} from './state/constants.mjs';
import {
  createInitialState,
  reducer,
  selectActiveSession,
  selectAgentComposerState,
} from './state/sessionMachine.mjs';
import { formatCents } from './domain/agentDraft.mjs';
import { requestAgentTurn, describeAgentTransport } from './services/agentTurn/agentTurnService.js';
import {
  buildTemplateCandidates,
  composePrompt,
  revisePrompt,
  generateImage,
  reviseImage,
} from './services/agentService.js';

import AppShell from './components/layout/AppShell.jsx';
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
import StoreInfoStep from './components/build/StoreInfoStep.jsx';
import PromptStudio from './components/build/PromptStudio.jsx';
import ImageReview from './components/build/ImageReview.jsx';
import DeployStep from './components/build/DeployStep.jsx';
import AgentIntakePanel from './components/agent/AgentIntakePanel.jsx';
import DraftEditor from './components/agent/DraftEditor.jsx';
import StoreInfoActionBar from './components/agent/StoreInfoActionBar.jsx';
import AgentDraftSummary from './components/agent/AgentDraftSummary.jsx';

const FEATURE_GROUPS = [...new Set(catalogFeatures.map((feature) => feature.group))];
const REQUIRED_IDS = catalogFeatures.filter((feature) => feature.required).map((feature) => feature.id);
const BUILD_STEPS = ['解析功能清单', '匹配页面骨架', '拼装门店页面', '准备预览'];
const INTRO_AUTO_ADVANCE_MS = 5200;
const COMPOSER_PHASES = [PHASES.ONBOARDING, PHASES.STORE_INFO, PHASES.PROMPT_STUDIO, PHASES.IMAGE_REVIEW];

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

function buildPanelCards(state, tips, imageBusy) {
  const cards = [];
  const style = STYLE_PRESETS.find((item) => item.id === state.visual.styleId) ?? STYLE_PRESETS[0];
  const selectedTemplate = state.build.candidates.find((item) => item.id === state.build.selectedId)
    ?? state.build.candidates[0];

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
        title: '候选页面骨架',
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
            template={selectedTemplate}
            theme={style}
            storeName={state.store.name || '我的餐馆'}
            features={state.features.selected}
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
            template={selectedTemplate}
            theme={style}
            storeName={state.store.name || '我的餐馆'}
            features={state.features.selected}
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
        title: '部署进度',
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

export default function App() {
  const [state, dispatch] = useReducer(reducer, undefined, createInitialState);
  const [draft, setDraft] = useState('');
  const [buildProgress, setBuildProgress] = useState(0);
  const [promptTips, setPromptTips] = useState([]);
  const [promptBusy, setPromptBusy] = useState(false);
  const [imageBusy, setImageBusy] = useState(false);
  const [draftEditorOpen, setDraftEditorOpen] = useState(false);
  const buildStarted = useRef(false);
  const promptStarted = useRef(false);
  const imageStarted = useRef(false);
  const deployStarted = useRef(false);
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
  const storeTypesForForm = useMemo(() => {
    const category = state.agentDraft.category;
    if (!category) return STORE_TYPES;
    const exists = STORE_TYPES.some((item) => {
      const value = typeof item === 'string' ? item : (item?.value ?? item?.name ?? '');
      return value === category;
    });
    return exists ? STORE_TYPES : [...STORE_TYPES, { value: category, label: category }];
  }, [state.agentDraft.category]);

  useEffect(() => {
    setDraft('');
  }, [phase]);

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
    if (phase !== PHASES.PROMPT_STUDIO) {
      promptStarted.current = false;
      return undefined;
    }
    if (promptStarted.current) return undefined;
    promptStarted.current = true;
    let alive = true;
    composePrompt({ store: state.store, styleId: state.visual.styleId }).then((result) => {
      if (!alive) return;
      setPromptTips(result.tips);
      dispatch({ type: 'SET_PROMPT', prompt: result.prompt });
    });
    return () => {
      alive = false;
    };
  }, [phase, state.store, state.visual.styleId]);

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
    if (phase !== PHASES.DEPLOY) {
      deployStarted.current = false;
      return undefined;
    }
    if (deployStarted.current) return undefined;
    deployStarted.current = true;
    let step = 0;
    const timer = setInterval(() => {
      step += 1;
      if (step >= DEPLOY_STEPS.length) {
        clearInterval(timer);
        dispatch({ type: 'DEPLOY_DONE' });
        return;
      }
      dispatch({
        type: 'DEPLOY_PROGRESS',
        step,
        progress: Math.round((step / DEPLOY_STEPS.length) * 100),
      });
    }, 900);
    return () => clearInterval(timer);
  }, [phase]);

  useEffect(() => {
    if (phase !== PHASES.ONBOARDING || !state.store.name) return undefined;
    const timer = setTimeout(() => dispatch({ type: 'SKIP_INTRO' }), INTRO_AUTO_ADVANCE_MS);
    return () => clearTimeout(timer);
  }, [phase, state.store.name]);

  const panelCards = useMemo(
    () => buildPanelCards(state, promptTips, imageBusy),
    [state, promptTips, imageBusy],
  );

  const startOnboarding = () => dispatch({ type: 'START_ONBOARDING' });
  const reset = () => dispatch({ type: 'RESET' });
  const selectSession = (id) => dispatch({ type: 'SWITCH_SESSION', id });

  const handlePromptFeedback = async (text) => {
    if (promptBusy) return;
    setPromptBusy(true);
    const nextPrompt = await revisePrompt({ base: state.visual.prompt, feedback: text });
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

  const handleAgentTurn = async (utterance, { retry = false } = {}) => {
    if (agentBusy.current) return;
    if (phase !== PHASES.STORE_INFO) return;
    const text = String(utterance ?? '').trim();
    if (!text) return;
    agentBusy.current = true;
    dispatch(retry ? { type: 'AGENT_TURN_RETRY' } : { type: 'AGENT_TURN_REQUEST', utterance: text });
    try {
      const result = await requestAgentTurn({
        utterance: text,
        draft: state.agentDraft,
        simulateFailureOnce: state.agent.simulateFailure,
      });
      dispatch({ type: 'AGENT_TURN_SUCCESS', ...result });
      setDraft('');
    } catch (error) {
      dispatch({ type: 'AGENT_TURN_FAILURE', error });
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
            theme={currentTheme}
            storeName={state.store.name || '我的餐馆'}
            features={state.features.selected}
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
            onFieldChange={handleFieldChange}
            onStyleChange={(id) => dispatch({ type: 'SET_STYLE', id })}
            onSubmit={handleStoreSubmit}
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
      case PHASES.DEPLOY:
        return (
          <DeployStep
            status={state.deploy.status}
            steps={DEPLOY_STEPS}
            step={state.deploy.step}
            progress={state.deploy.progress}
            storeName={state.store.name}
            templateName={selectedTemplate?.name ?? '默认骨架'}
            styleName={styleName}
          />
        );
      default:
        return null;
    }
  }

  const agentComposer = selectAgentComposerState(state);
  const composerVisible = phase === PHASES.STORE_INFO
    ? agentComposer.visible
    : COMPOSER_PHASES.includes(phase);
  const skipVisible = phase === PHASES.ONBOARDING && Boolean(state.store.name);

  return (
    <AppShell
      sidebar={(
        <Sidebar
          appName="智能开店"
          sessions={state.sessions}
          activeSessionId={state.activeSessionId}
          currentStoreName={state.store.name}
          onStartOnboarding={startOnboarding}
          onSelectSession={selectSession}
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
            onReset={reset}
          />
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
                      placeholder={phase === PHASES.STORE_INFO
                        ? agentComposer.placeholder
                        : COMPOSER_PLACEHOLDER[phase]}
                      submitLabel={phase === PHASES.STORE_INFO
                        ? agentComposer.submitLabel
                        : (COMPOSER_SUBMIT_LABEL[phase] ?? '发送')}
                      hint={phase === PHASES.STORE_INFO ? agentComposer.hint : COMPOSER_HINTS[phase]}
                      disabled={phase === PHASES.STORE_INFO ? !agentComposer.editable : false}
                      submitDisabled={phase === PHASES.STORE_INFO ? agentComposer.submitDisabled : false}
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
  );
}