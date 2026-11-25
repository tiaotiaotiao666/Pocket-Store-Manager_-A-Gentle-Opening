/**
 * E0-U1：真实进度条（stage 只来自冻结白名单；未知 stage 不丢步）。
 *
 * 目标（rev2 F5 / rev15 §14.9 / D-UI-1 教训）：
 * - 每一步都来自主进程 `agent:progress` payload，组件**不生成假进度**、不靠 timer 推进；
 * - stage 不在白名单里时显示「未知阶段（x）」，并保留该步（旧链 `return sameState` 会静默丢步，这里不许复刻）；
 * - 检查四态只用 `PASS / FAIL / BLOCKED / NOT_RUN`（状态词不做第二套 pass/unknown 口径）；
 * - 容器 `role="list"` + `aria-live="polite"`，UIA 断言按 role+name 取每一步。
 */

import {
  E0_LIMITS,
  E0_STATUS_LABELS,
  formatEventStatusLabel,
  formatStageLabel,
  normalizeProgressEvent,
  windowProgressSteps,
} from './e0UiContract.mjs';

const STATUS_TOKENS = Object.freeze(['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN']);

function normalizeStep(step) {
  if (!step || typeof step !== 'object') return normalizeProgressEvent(step);
  if (typeof step.stageLabel === 'string' && typeof step.status === 'string') return step;
  return normalizeProgressEvent(step);
}

export default function RunProgressBar({
  steps = [],
  maxSteps = E0_LIMITS.maxProgressSteps,
  title = '执行进度',
}) {
  const normalized = (Array.isArray(steps) ? steps : []).map(normalizeStep);
  const windowed = windowProgressSteps(normalized, maxSteps);
  const last = normalized[normalized.length - 1] || null;

  return (
    <section className="e0-progress" id="e0-progress" role="region" aria-label={title}>
      <div className="e0-field-header">
        <span className="e0-field-label">{title}（真实事件，未知阶段也会显示）</span>
        <span className="e0-field-meta" role="note" aria-label="进度步数">
          共 {normalized.length} 步{last ? `，最新：${last.stageLabel}（${formatEventStatusLabel(last.status)}）` : ''}
        </span>
      </div>

      {normalized.length === 0 ? (
        <p className="e0-field-hint" role="note" aria-label="尚无进度">
          还没有收到进度事件（NOT_RUN）：不显示任何猜测性的阶段
        </p>
      ) : (
        <ol className="e0-progress-list" role="list" aria-label="阶段列表" aria-live="polite">
          {windowed.steps.map((step, index) => {
            const unknown = step.knownStage !== true;
            return (
              <li
                key={`${step.stage || 'unknown'}-${index}`}
                className={`e0-progress-step${unknown ? ' e0-progress-step-unknown' : ''}`}
                role="listitem"
                data-stage={step.stage}
                data-known-stage={unknown ? 'false' : 'true'}
                data-status={step.status}
                aria-label={`${step.stageLabel}：${formatEventStatusLabel(step.status)}`}
              >
                <span className="e0-progress-index" aria-hidden="true">{index + 1}</span>
                <span className="e0-progress-stage">{step.stageLabel}</span>
                <span className="e0-progress-status" data-status={step.status}>{formatEventStatusLabel(step.status)}</span>
                {step.message ? (
                  <span className="e0-progress-message" role="note" aria-label={`${step.stageLabel}说明`}>{step.message}</span>
                ) : null}
                {unknown ? (
                  <span className="e0-progress-unknown-note" role="note" aria-label="未知阶段说明">
                    白名单外阶段，按原样保留（不丢步）
                  </span>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}

      {windowed.hiddenCount > 0 ? (
        <p className="e0-field-hint" role="note" aria-label="进度折叠提示">
          已折叠较早的 {windowed.hiddenCount} 步（未知阶段仍然保留显示）
        </p>
      ) : null}

      <div className="e0-progress-legend" role="note" aria-label="状态词说明">
        <span className="e0-field-meta">状态词只用：</span>
        {STATUS_TOKENS.map((token) => (
          <span key={token} className="e0-status-token" data-status={token} role="note" aria-label={`状态词 ${token}（${E0_STATUS_LABELS[token]}）`}>
            {token}
          </span>
        ))}
        <span className="e0-field-meta">；{formatStageLabel('not-a-stage')} 是未知阶段的显示口径</span>
      </div>
    </section>
  );
}
