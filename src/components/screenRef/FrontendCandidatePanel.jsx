import { useEffect, useState } from 'react';
import ScreenSendConsent from './ScreenSendConsent.jsx';

/**
 * P4：「生成候选前端」主链面板（只负责展示与回传意图）。
 *
 * - 所有门槛（能否分析/构建/验证/采用）都由 `src/domain/frontendReconstruct.mjs`
 *   算好放进 `view`，组件不再重复判断业务规则。
 * - `partial`（静态门禁通过但微信验证未完成）必须单独确认：勾选后「采用候选前端」
 *   才可用，并把 `partialConfirmed: true` 交给上层写入采用记录。
 * - 新增控件都有唯一可读名称（可见文本或 aria-label）与稳定 id，
 *   便于 `npm run agent:smoke` / `agent:verify` 做 UIA 断言。
 */

const RUNTIME_TONE = {
  PASS: 'ok',
  FAIL: 'fail',
  BLOCKED: 'warn',
  NOT_RUN: 'idle',
};

function formatBytes(bytes) {
  const value = Number.isFinite(bytes) ? bytes : 0;
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

function SectionList({ title, label, items, emptyText }) {
  return (
    <div className="frontend-candidate-group">
      <h5>{title}（{items.length}）</h5>
      {items.length === 0 ? (
        <p className="screen-ref-note">{emptyText}</p>
      ) : (
        <ul aria-label={label}>
          {items.map((item, index) => (
            <li key={`${label}-${index}`}>
              {item.label}{item.reason ? `：${item.reason}` : ''}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function FrontendCandidatePanel({
  view,
  imageReady = false,
  localError = null,
  notice = null,
  consentNotice = null,
  onConsentConfirm,
  onConsentCancel,
  desktopMode = false,
  uploadSlot = null,
  onUtteranceChange,
  onTargetPagesChange,
  onAnalyze,
  onBuild,
  onVerify,
  onValidate,
  onAdopt,
  onDiscard,
  onCancel,
  onRetry,
  onReset,
}) {
  const [partialConfirmed, setPartialConfirmed] = useState(false);
  const safe = view || {};
  const request = safe.request || { utterance: '', targetPages: [], targetPageOptions: [] };
  const analysis = safe.analysis || null;
  const coverage = analysis ? analysis.coverage : null;
  const candidate = safe.candidate || null;
  const verification = safe.verification || null;
  const progress = safe.progress || null;
  const needsPartialConfirm = Boolean(safe.adoptNeedsPartialConfirm);
  const adoptDisabled = !safe.canAdopt || (needsPartialConfirm && !partialConfirmed);

  // partial 的确认只对「当前这个候选」有效：换候选/重开后必须重新由用户勾选，
  // 绝不让上一次的勾选自动替新候选背书。
  const candidateKey = candidate ? `${candidate.candidateId}@${candidate.attempt}` : '';
  useEffect(() => {
    setPartialConfirmed(false);
  }, [candidateKey]);

  const handleTargetToggle = (pageId, checked) => {
    if (typeof onTargetPagesChange !== 'function') return;
    const current = Array.isArray(request.targetPages) ? request.targetPages : [];
    const next = checked
      ? [...current, pageId]
      : current.filter((item) => item !== pageId);
    onTargetPagesChange(next.length ? next : [pageId]);
  };

  return (
    <section
      className={`frontend-candidate is-${safe.tone || 'idle'}`}
      role="region"
      aria-label="参考截图候选方案"
      id="frontend-reconstruct-panel"
    >
      <header className="frontend-candidate-head">
        <h4 className="frontend-candidate-title">候选前端方案</h4>
        <p className="frontend-candidate-status" role="note">
          {safe.title || '还没生成候选前端'}：{safe.body || ''}
        </p>
        {safe.modeNote ? <p className="screen-ref-disclaimer">{safe.modeNote}</p> : null}
        <p className="screen-ref-note" role="note">
          候选状态只保留在本次应用会话里；重开项目后需要重新生成（采用记录由项目快照负责）。
        </p>
        {desktopMode ? null : (
          <p className="screen-ref-note" role="note">
            浏览器里只能预览这条链路；生成候选需要桌面应用（主进程负责私有工作区）。
          </p>
        )}
      </header>

      {uploadSlot}

      {/* B5：发图前先问一次（哪张图 / 做什么用 / 发给谁），确认后才请求模型。 */}
      <ScreenSendConsent notice={consentNotice} onConfirm={onConsentConfirm} onCancel={onConsentCancel} />

      {/* B5：取消发送这类「中性结论」不是错误，用 status 而不是 alert 播报。 */}
      {notice ? <p className="screen-send-notice" role="status">{notice}</p> : null}
      {localError ? <p className="screen-ref-error" role="alert">{localError}</p> : null}
      {safe.error ? (
        <div className="screen-ref-error" role="alert">
          <p>{safe.error.message}</p>
          {safe.error.issues && safe.error.issues.length ? (
            <ul aria-label="候选前端问题清单">
              {safe.error.issues.slice(0, 8).map((issue, index) => (
                <li key={`frontend-issue-${index}`}>
                  {issue.code}{issue.path ? `（${issue.path}）` : ''}：{issue.message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {safe.notice ? <p className="screen-ref-note" role="note">{safe.notice}</p> : null}

      <div className="frontend-candidate-input">
        <label className="frontend-candidate-label" htmlFor="frontend-reconstruct-utterance">
          补充要求（可选，500 字以内）
        </label>
        <textarea
          id="frontend-reconstruct-utterance"
          className="frontend-candidate-textarea"
          aria-label="补充要求输入框"
          rows={3}
          maxLength={500}
          placeholder="例如：保留顶部搜索和双列菜品卡片，整体更清爽一些。也可以只上传截图。"
          value={request.utterance || ''}
          disabled={safe.busy}
          onChange={(event) => {
            if (typeof onUtteranceChange === 'function') onUtteranceChange(event.target.value);
          }}
        />
        <fieldset className="frontend-candidate-pages" aria-label="目标页面">
          <legend>目标页（首页或菜单页）</legend>
          {(request.targetPageOptions || []).map((option) => (
            <label key={`frontend-target-${option.id}`} className="frontend-candidate-check">
              <input
                id={`frontend-target-${option.id}`}
                type="checkbox"
                aria-label={`目标页面：${option.label}`}
                checked={option.checked === true}
                disabled={safe.busy}
                onChange={(event) => handleTargetToggle(option.id, event.target.checked)}
              />
              {option.label}
            </label>
          ))}
        </fieldset>
        {analysis?.status === 'needs-input' && analysis.questions.length ? (
          <div className="frontend-candidate-needs-input" role="alert">
            <strong>请补充以下信息后重试：</strong>
            <ul aria-label="补充要求待确认问题">
              {analysis.questions.map((question, index) => (
                <li key={`frontend-input-question-${index}`}>{question.label ? `${question.label}：` : ''}{question.text}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {imageReady ? null : (
          <p className="screen-ref-note">请先上传一张参考截图，再识别并生成候选方案。</p>
        )}
      </div>

      <div className="screen-ref-actions">
        <button
          type="button"
          id="frontend-analyze-button"
          className="btn btn-primary"
          disabled={!safe.canAnalyze}
          onClick={onAnalyze}
        >
          {safe.status === 'analyzing' ? '正在识别并生成…' : '识别并生成候选方案'}
        </button>
        {analysis?.status === 'planned' ? (
          <button
            type="button"
            id="frontend-build-button"
            className="btn btn-primary"
            disabled={!safe.canBuild}
            onClick={onBuild}
          >
            构建候选工程
          </button>
        ) : null}
        {candidate ? (
          <>
            <button
              type="button"
              id="frontend-verify-button"
              className="btn btn-ghost"
              disabled={!safe.canVerify}
              onClick={onVerify}
            >
              验证候选工程（微信）
            </button>
            <button
              type="button"
              id="frontend-validate-button"
              className="btn btn-ghost"
              disabled={!safe.canValidate}
              onClick={onValidate}
            >
              复核候选前端（只读）
            </button>
          </>
        ) : null}
        {safe.canCancel ? (
          <button type="button" id="frontend-cancel-button" className="btn btn-ghost" onClick={onCancel}>
            取消候选前端任务
          </button>
        ) : null}
        {safe.canRetry ? (
          <button type="button" id="frontend-retry-button" className="btn btn-ghost" onClick={onRetry}>
            重试候选前端
          </button>
        ) : null}
        {safe.canDiscard ? (
          <button type="button" id="frontend-discard-button" className="btn btn-ghost" onClick={onDiscard}>
            放弃此候选前端
          </button>
        ) : null}
        {candidate ? (
          <button type="button" id="frontend-reset-button" className="btn btn-ghost" onClick={onReset} disabled={safe.busy}>
            清空候选状态
          </button>
        ) : null}
      </div>

      {progress ? (
        <div className="frontend-candidate-progress">
          <p role="status" aria-live="polite" aria-label="候选前端进度">
            {progress.label}（第 {progress.step}/{progress.total} 步）
          </p>
          <div
            className="frontend-candidate-bar"
            role="progressbar"
            aria-label="候选前端进度百分比"
            aria-valuenow={progress.percent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <span style={{ width: `${progress.percent}%` }} />
          </div>
        </div>
      ) : null}

      {analysis ? (
        <div className="frontend-candidate-report" role="group" aria-label="能力覆盖报告">
          <h4>识别结果与能力覆盖</h4>
          <p className="screen-ref-note">
            {analysis.statusLabel}：共 {analysis.sectionCount} 个分区，覆盖 {coverage.requiredCount} 项必需能力
            {coverage.missingCount > 0 ? `，缺 ${coverage.missingCount} 项` : '，没有缺项'}。
            {analysis.summary ? `摘要：${analysis.summary}` : ''}
          </p>
          {coverage.missingCount > 0 ? (
            <p className="screen-ref-note">缺少的能力：{coverage.missing.join('、')}</p>
          ) : null}
          {analysis.pages.map((page) => (
            <div key={`frontend-page-${page.pageId}`} className="frontend-candidate-group">
              <h5>
                {page.pageLabel}（{page.layoutLabel}，{page.sectionCount} 个分区）
              </h5>
              {page.sections.length === 0 ? (
                <p className="screen-ref-note">这张图没有识别出可描述的分区。</p>
              ) : (
                <ul aria-label={`${page.pageLabel}识别分区`}>
                  {page.sections.map((section) => (
                    <li key={`${page.pageId}-${section.order}-${section.id || section.label}`}>
                      {section.order + 1}. {section.label}
                      {/* B3：识别把握不再以裸百分比展示。 */}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
          <SectionList
            title="只能近似"
            label="候选前端的近似项"
            items={[...analysis.approximate, ...(coverage.degradations || [])]}
            emptyText="没有需要近似的部分。"
          />
          <SectionList
            title="暂不支持"
            label="候选前端的不支持项"
            items={[...analysis.unsupported, ...(analysis.unknownRegions || [])]}
            emptyText="没有不支持的项。"
          />
          {coverage.risks && coverage.risks.length ? (
            <SectionList
              title="能力风险"
              label="能力覆盖风险"
              items={coverage.risks.map((risk) => ({ label: risk.capability, reason: risk.reason }))}
              emptyText="没有额外风险。"
            />
          ) : null}
          {analysis.status !== 'needs-input' && analysis.questions.length ? (
            <div className="frontend-candidate-group">
              <h5>需要你补充（{analysis.questions.length}）</h5>
              <ul aria-label="候选前端待确认问题">
                {analysis.questions.map((question, index) => (
                  <li key={`frontend-question-${index}`}>{question.label ? `${question.label}：` : ''}{question.text}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <p className="screen-ref-note">
            样式：密度 {analysis.style.densityLabel}，{analysis.style.themeCount} 个主题色、{analysis.style.sizeCount} 个尺寸档位。
          </p>
        </div>
      ) : null}

      {candidate ? (
        <div className="frontend-candidate-report" role="group" aria-label="候选前端摘要">
          <h4>候选前端：{candidate.label}</h4>
          <p className="screen-ref-note">
            页面：{candidate.pages.length ? candidate.pages.join('、') : '沿用 Base 页面'}
            {candidate.files ? `；生成 ${candidate.files} 个文件` : ''}
            {candidate.attempt ? `；私有 attempt-${candidate.attempt}` : ''}
            {candidate.digestShort ? `；摘要 ${candidate.digestShort}` : ''}
          </p>
          <p className="screen-ref-note">候选只在应用私有工作区里，不会写正式 templates，也不会改小程序的镜像目录。</p>
        </div>
      ) : null}

      {verification ? (
        <div className="frontend-candidate-report" role="group" aria-label="验证报告">
          <h4>验证报告</h4>
          <p className="screen-ref-note">
            静态门禁：{verification.static
              ? `${verification.static.ok ? '通过' : '未通过'}（${verification.static.summary || verification.static.code || '无摘要'}）`
              : '未执行'}
          </p>
          {verification.static && verification.static.checks.length ? (
            <ul aria-label="静态门禁检查项">
              {verification.static.checks.map((check, index) => (
                <li key={`frontend-check-${index}`}>
                  {check.id}：{check.status}{check.message ? ` — ${check.message}` : ''}
                </li>
              ))}
            </ul>
          ) : null}
          <p className="screen-ref-note">{verification.repairNote}</p>
          <p className={`screen-ref-note is-${RUNTIME_TONE[verification.runtime.status] || 'idle'}`}>
            微信运行时：{verification.runtime.statusLabel}
            {verification.runtime.summary ? ` — ${verification.runtime.summary}` : ''}
          </p>
          {verification.runtime.pages.length ? (
            <ul aria-label="微信页面验证结果">
              {verification.runtime.pages.map((page, index) => (
                <li key={`frontend-runtime-page-${index}`}>
                  {page.label || page.route}：{page.status}
                </li>
              ))}
            </ul>
          ) : null}
          {verification.runtime.screenshots.length ? (
            <div className="frontend-candidate-group">
              <h5>微信运行时截图（{verification.runtime.screenshots.length}）</h5>
              <ul aria-label="微信截图清单">
                {verification.runtime.screenshots.map((shot, index) => (
                  <li key={`frontend-shot-${index}`}>{shot.name}（{formatBytes(shot.bytes)}）</li>
                ))}
              </ul>
            </div>
          ) : null}
          {safe.partialNote ? (
            <p className="frontend-candidate-partial" role="note">{safe.partialNote}</p>
          ) : null}
          {needsPartialConfirm ? (
            <label className="frontend-candidate-check">
              <input
                id="frontend-partial-confirm"
                type="checkbox"
                aria-label="我已知悉微信验证未完成，仍要采用候选前端"
                checked={partialConfirmed}
                onChange={(event) => setPartialConfirmed(event.target.checked)}
                disabled={safe.busy}
              />
              我已知悉「微信验证未完成」，仍要采用此候选
            </label>
          ) : null}
          <div className="screen-ref-actions">
            <button
              type="button"
              id="frontend-adopt-button"
              className="btn btn-primary"
              disabled={adoptDisabled}
              onClick={() => {
                if (typeof onAdopt === 'function') onAdopt(needsPartialConfirm ? partialConfirmed : false);
              }}
            >
              {safe.adoption ? '重新采用候选前端' : '采用候选前端'}
            </button>
            {safe.adoptBlockedReason ? <span className="screen-ref-note">{safe.adoptBlockedReason}</span> : null}
          </div>
        </div>
      ) : null}

      {safe.adoption ? (
        <p className="screen-ref-note" role="note">
          已采用：{safe.adoption.candidateId}（attempt-{safe.adoption.attempt}，微信状态 {safe.adoption.runtimeStatus}
          {safe.adoption.partialConfirmed ? '，已单独确认 partial' : ''}）。
        </p>
      ) : null}
    </section>
  );
}
