import { useEffect, useRef } from 'react';
import { ChevronRight, MessageSquareText, RefreshCw, ShieldCheck } from 'lucide-react';
import Composer from '../chat/Composer.jsx';
import { ProcessSummary } from '../chat/ChatStream.jsx';
import AgentChatAttachments from './AgentChatAttachments.jsx';
import AppAssistantChangeCard from './AppAssistantChangeCard.jsx';
import {
  CHAT_DRAFT_MAX_CHARS,
  CHAT_STATUS,
  buildAgentChatSubmitPlan,
  buildAgentChatTimeline,
  isValidChatDraft,
} from '../../domain/agentSidebar.mjs';
import '../../styles/agent-sidebar.css';

/**
 * 桌面项目页右侧栏「Agent 对话」视图（T3）。
 *
 * 硬约束（与任务契约一致）：
 * - 纯展示组件：不 import service、不发 fetch、不 dispatch，全部数据来自 App 传入的
 *   视图模型（`selectAgentChatState` 的输出）与回调；
 * - 能否发送 / 能否重试 / 本轮做什么，都复用 `domain/agentSidebar.mjs` 的判断，组件里
 *   不另写第二套规则；
 * - 过程卡只复用 ChatStream 导出的 `ProcessSummary` 与安全视图：没有真实 trace 时
 *   不渲染任何工具步骤，`partial` 显示「部分完成」而不是「全部成功」；
 * - 前端重构/参考图意图展示真实进度与「查看候选」跳转；采用仍只在候选面板确认；
 * - 本轮图片附件只在门店资料/模板展示阶段出现，由 App 传入允许的用途；
 *   附件只随请求发送，不写消息正文、不写项目快照。
 */

const ROLE_LABELS = Object.freeze({
  user: '我',
  assistant: '轻启',
  system: '系统',
});

/** 过程卡状态 → 用户看得懂的徽标文案（partial 一律「部分完成」）。 */
const RUN_TITLES = Object.freeze({
  done: '本轮已完成',
  partial: '部分完成',
  failed: '本轮未完成',
});

const RUN_TONES = Object.freeze({
  done: 'done',
  partial: 'partial',
  failed: 'failed',
});

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  if (ms < 1000) return `${Math.round(ms)} 毫秒`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${Math.round(seconds % 60)} 秒`;
}

/**
 * 把领域层 `normalizeChatRun` 的安全运行视图映射成 `ProcessSummary` 需要的形状。
 *
 * 只做标签映射：不读消息正文、不序列化 trace、不补假步骤。`toolLabels` 只在真实
 * 工具调用存在时才非空，因此没有真实 trace 时 `steps` 为空（不渲染任何步骤）。
 *
 * @param {object|null} run `normalizeChatRun` 的输出
 * @returns {object|null} `ProcessSummary` 可消费的安全视图
 */
export function buildAgentChatProcessView(run) {
  if (!run || typeof run !== 'object' || Array.isArray(run)) return null;
  const status = RUN_TITLES[run.status] ? run.status : 'done';
  const toolLabels = Array.isArray(run.toolLabels)
    ? run.toolLabels.filter((label) => typeof label === 'string' && label.trim())
    : [];
  const metaLines = [];
  const duration = formatDuration(run.durationMs);
  if (duration) metaLines.push(`用时 ${duration}`);

  const steps = toolLabels.map((label, index) => ({
    id: `agent-chat-tool-${index}`,
    label,
    state: status === 'failed' ? 'failed' : (status === 'partial' ? 'partial' : 'done'),
  }));

  let notice = typeof run.note === 'string' ? run.note : '';
  if (!notice && status === 'partial') notice = '这一轮只完成了一部分，还有步骤没有跑完。';
  if (!notice && status === 'failed') notice = '这一轮没有完成；可以点「重试上一轮」再来一次。';

  return {
    title: RUN_TITLES[status],
    headline: steps.length ? `完成了 ${steps.length} 项处理` : '',
    metaLines,
    steps,
    tone: RUN_TONES[status],
    notice,
  };
}

function resolvePhaseLabel(phaseLabel, phase) {
  if (typeof phaseLabel === 'string' && phaseLabel.trim()) return phaseLabel.trim();
  if (typeof phase === 'string' && phase.trim()) return phase.trim();
  return '未开始';
}

export default function AgentSidebarPanel({
  projectId = null,
  projectName = '',
  phase = null,
  phaseLabel = '',
  chat = null,
  process = null,
  candidate = null,
  // 当前阶段动作其实不可执行时的原因（App 与底层 handler 用同一份判断算出）。
  // 有值时：发送按钮禁用 + 输入框下方直接显示原因，绝不让「点了没反应」发生。
  sendBlockedReason = null,
  // 本轮附件：只随请求发送、不落盘；能带哪几种图片由 App 按阶段传入。
  images = [],
  imageKinds = [],
  imageError = null,
  imageBusy = false,
  onAddImages,
  onRemoveImage,
  onImageBusyChange,
  onDraftChange,
  onSubmit,
  onRetry,
  onOpenCandidates,
  onUndoApplied,
}) {
  const view = chat && typeof chat === 'object' ? chat : {};
  const messages = Array.isArray(view.messages) ? view.messages : [];
  // 草稿是受控值：失败/切视图时都从视图模型读回，因此输入与草稿不会被清空。
  const draft = typeof view.draft === 'string' ? view.draft : '';
  const status = typeof view.status === 'string' ? view.status : CHAT_STATUS.IDLE;
  const busy = view.busy === true || status === CHAT_STATUS.REQUESTING;
  const lastError = view.lastError && typeof view.lastError === 'object' ? view.lastError : null;
  const plan = view.plan && typeof view.plan === 'object'
    ? view.plan
    : buildAgentChatSubmitPlan({ projectId, phase, hasProject: Boolean(projectId) });

  // 过程卡优先用 App 传入的安全视图；缺省时把领域层 running 视图映射一次，仍不放假步骤。
  const runView = process && typeof process === 'object' ? process : buildAgentChatProcessView(view.lastRun);
  // 参考图重构意图：App 可以显式传摘要；否则取最后一条重构类消息的正文当摘要。
  const reconstructMessage = candidate && typeof candidate === 'object'
    ? null
    : [...messages].reverse().find((message) => message && message.actionKind === 'frontend-reconstruct') || null;
  const reconstruct = candidate && typeof candidate === 'object'
    ? candidate
    : (reconstructMessage ? { summary: reconstructMessage.text } : null);

  // 空白与超 500 字都不可发送：规则只在 domain 里有一份，这里只做引用。
  const draftValid = isValidChatDraft(draft, { maxChars: CHAT_DRAFT_MAX_CHARS });
  // 阶段动作不可执行（例如模板修订没准备好/上一轮还在跑）时同样不可发送：
  // 原因由 App 算好传进来，组件只负责「禁用 + 说清为什么」，不自己判断业务条件。
  const blockedReason = typeof sendBlockedReason === 'string' ? sendBlockedReason.trim() : '';
  const attachments = Array.isArray(images) ? images.filter((item) => item && typeof item.id === 'string') : [];
  const imageKindList = Array.isArray(imageKinds) ? imageKinds.filter((item) => typeof item === 'string') : [];
  const attachmentsEnabled = imageKindList.length > 0;
  // 附件压缩忙态由 App 持有（面板不持有会话状态）；忙时发送按钮同样禁用，
  // 否则会把旧附件或空附件发出去。
  const submitBlocked = busy || imageBusy || plan.allowed === false || !draftValid || Boolean(blockedReason);
  const canRetry = typeof view.canRetry === 'boolean'
    ? view.canRetry
    : Boolean(lastError && lastError.retryable !== false);
  // 本轮字段批次的真实应用结果（运行态，不落盘）：
  // - applied：桌面 before/after + 「撤销本轮」；
  // - pending：需要用户确认、尚未写入；
  // - stale：请求期间项目已变化，结果未写入。
  const applied = view.lastApplied && typeof view.lastApplied === 'object' ? view.lastApplied : null;
  const pending = view.lastPending && typeof view.lastPending === 'object' ? view.lastPending : null;
  const stale = view.lastStale && typeof view.lastStale === 'object' ? view.lastStale : null;
  const contentRevision = Number.isInteger(view.contentRevision) ? view.contentRevision : null;
  const canUndoApplied = Boolean(applied && contentRevision !== null && contentRevision === applied.appliedRevision);

  // 消息与「本轮结果」排成一条时间线（domain 只算一次）：
  // 过程卡 / 变更卡 / 待确认 / stale 挂在产生它的那一轮消息之后，
  // 新消息追加在下面，下一轮有新结果时才在更下面再出现一份。
  const timeline = buildAgentChatTimeline({
    messages,
    run: view.lastRun,
    applied,
    pending,
    stale,
    candidate: reconstruct,
    candidateMessageId: reconstructMessage ? reconstructMessage.id : '',
  });
  const timelineTailKey = timeline.length ? timeline[timeline.length - 1].key : '';
  // 外部显式传入的过程视图若没有对应的 run 条目，就在日志末尾补一次（不丢信息）。
  const processRendered = process && typeof process === 'object'
    && timeline.some((item) => item.kind === 'result' && item.run);

  const logRef = useRef(null);
  // 结果块也是日志的一部分，所以「自动滚到底」同时盯着时间线长度与末项身份，
  // 而不是只看消息条数——否则新结果插到历史位置时用户看不到。
  useEffect(() => {
    const node = logRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [messages.length, timeline.length, timelineTailKey, busy, Boolean(lastError)]);

  const jumpToLatest = () => {
    const node = logRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' });
  };

  return (
    <section className="agent-sidebar" role="region" aria-label="项目 Agent 对话" id="project-agent-sidebar">
      <header className="agent-sidebar-head">
        <div className="agent-sidebar-head-text">
          <p className="agent-sidebar-eyebrow">项目会话</p>
          <h2 className="agent-sidebar-title">{projectName || '未选择项目'}</h2>
          <p className="agent-sidebar-phase">当前阶段：{resolvePhaseLabel(phaseLabel, phase)}</p>
        </div>
        <button
          type="button"
          className="agent-sidebar-jump"
          aria-label="跳到最新消息"
          title="跳到最新消息"
          onClick={jumpToLatest}
        >
          <ChevronRight size={15} />
        </button>
      </header>

      <section className="agent-sidebar-plan" aria-label="本轮动作说明">
        <span className="agent-sidebar-plan-badge">{plan.label || '本地指引'}</span>
        <p className="agent-sidebar-plan-notice">{plan.notice}</p>
      </section>

      <div
        className="agent-sidebar-log"
        id="project-agent-messages"
        role="log"
        aria-label="项目对话消息"
        ref={logRef}
      >
        {timeline.length === 0 ? (
          <div className="agent-sidebar-empty">
            <span className="agent-sidebar-empty-icon" aria-hidden="true">
              <MessageSquareText size={16} />
            </span>
            <p>还没有对话。这里可以随时说要改什么，不必先切到对应阶段。</p>
            <p>模型只提出字段修改或追问；写入前由桌面再次校验，改完会出现变更卡与「撤销本轮」。</p>
          </div>
        ) : null}

        {/*
         * 时间线 = 消息流 + 每轮结果：过程卡 /「本轮已写入」/ 参考图摘要挂在
         * 产生它的那一轮消息之后，和普通消息一样上下滑动。
         * 用户再发新消息时它被顶上去，下一轮有新结果时才在更下面再出现一份，
         * 不会永远停在底部挡住新消息。
         */}
        {timeline.map((item) => (
          item.kind === 'message' ? (
            // 消息只有「用户原话」与「助手回复」两种已落地状态：失败不会写进消息列表
            //（失败由 lastError + 重试按钮表达），因此没有 failed 消息的额外分支。
            <article
              key={item.key}
              className={['agent-sidebar-msg', `is-${item.message.role}`].filter(Boolean).join(' ')}
            >
              <p className="agent-sidebar-msg-role">{ROLE_LABELS[item.message.role] || '系统'}</p>
              <p className="agent-sidebar-msg-text">{item.message.text}</p>
            </article>
          ) : (
            <div className="agent-sidebar-turn" key={item.key}>
              <ProcessSummary process={buildAgentChatProcessView(item.run)} />
              <AppAssistantChangeCard
                applied={item.applied}
                pending={item.pending}
                stale={item.stale}
                // 只有仍在应用后版本上的「最新那一轮」才能撤销；
                // 历史轮次的变更卡只作记录，撤销走全局撤销。
                canUndo={canUndoApplied && Boolean(item.applied) && item.applied === applied}
                onUndo={onUndoApplied}
              />
              {item.candidate ? (
                <section className="agent-sidebar-candidate" aria-label="参考图重构摘要">
                  <h3 className="agent-sidebar-candidate-title">参考图重构</h3>
                  <p className="agent-sidebar-candidate-summary">
                    {item.candidate.summary || '这一轮只汇总了参考图意图，没有任何候选产物。'}
                  </p>
                  {item.candidate.progress ? (
                    <div className="agent-sidebar-candidate-progress" role="status" aria-live="polite">
                      <span>{item.candidate.progress.label || '正在准备候选前端'}</span>
                      <span>{item.candidate.progress.percent || 0}%</span>
                      <div
                        className="agent-sidebar-candidate-progress-bar"
                        role="progressbar"
                        aria-label="侧栏自动候选进度"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={item.candidate.progress.percent || 0}
                      >
                        <span style={{ width: `${item.candidate.progress.percent || 0}%` }} />
                      </div>
                    </div>
                  ) : null}
                  <p className="agent-sidebar-candidate-note">
                    <ShieldCheck size={13} aria-hidden="true" />
                    候选只写入项目私有工作区；校验完成后由你决定是否采用。
                  </p>
                  <button
                    type="button"
                    className="agent-sidebar-candidate-open"
                    onClick={() => onOpenCandidates?.()}
                  >
                    查看候选进度
                  </button>
                </section>
              ) : null}
            </div>
          )
        ))}

        {processRendered ? null : <ProcessSummary process={runView} />}

        {busy ? (
          <p className="agent-sidebar-busy" id="project-agent-busy" role="status">
            <span className="agent-sidebar-busy-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            正在等待模型与工具结果
          </p>
        ) : null}

        {lastError ? (
          <section className="agent-sidebar-error" id="project-agent-error" role="group" aria-label="上一轮失败">
            <p className="agent-sidebar-error-title">上一轮没有成功</p>
            <p className="agent-sidebar-error-message">{lastError.message}</p>
            <p className="agent-sidebar-error-keep">你的原话和草稿都保留了，不用重新输入。</p>
            <button
              type="button"
              className="agent-sidebar-retry"
              onClick={() => onRetry?.()}
              disabled={busy || !canRetry}
            >
              <RefreshCw size={14} aria-hidden="true" />
              重试上一轮
            </button>
          </section>
        ) : null}
      </div>

      {attachmentsEnabled ? (
        <AgentChatAttachments
          images={attachments}
          kinds={imageKindList}
          disabled={busy || plan.allowed === false}
          busy={imageBusy}
          error={imageError}
          onAdd={onAddImages}
          onRemove={onRemoveImage}
          onBusyChange={onImageBusyChange}
        />
      ) : null}

      <div className="agent-sidebar-composer" id="project-agent-composer">
        <Composer
          value={draft}
          placeholder="说明这一轮要改什么…"
          submitLabel="发送到项目对话"
          hint={busy
            ? '上一轮还在处理中：结果回来后会解除发送。'
            : (imageBusy
              ? '图片正在压缩，稍等一下就能发送。'
              : (plan.allowed === false
                ? plan.notice
                : (blockedReason
                  || (attachments.length
                    ? `已附 ${attachments.length} 张图片，会随本轮一起发送 · Enter 发送`
                    : 'Enter 发送 · Shift+Enter 换行'))))}
          disabled={busy || imageBusy}
          submitDisabled={submitBlocked}
          maxChars={CHAT_DRAFT_MAX_CHARS}
          onChange={(next) => onDraftChange?.(next)}
          onSubmit={(text) => onSubmit?.(text)}
        />
      </div>
    </section>
  );
}
