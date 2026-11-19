import { Info, ShieldAlert, ShieldCheck } from 'lucide-react';

/**
 * 「最终生成内容」确认卡（B4 规则 4、5）。
 *
 * 只渲染 `buildExportReview()` 给出的数据；本组件不自己拼事实，
 * 也不重复计算菜品/时间/模板——这样导出摘要与真正导出的 Plan 不会漂移。
 *
 * 默认只显示人话、影响与可执行动作；`ruleId`、Plan 摘要等技术信息收在「技术详情」里（规则 7）。
 */
export default function ExportReviewCard({
  review = null,
  stale = false,
  staleReason = null,
  onRerun,
  rerunLabel = '重新体检',
}) {
  if (!review) return null;
  const sections = Array.isArray(review.sections) ? review.sections : [];
  const disclaimers = Array.isArray(review.disclaimers) ? review.disclaimers : [];
  const notes = Array.isArray(review.notes) ? review.notes : [];
  const technical = review.technical && typeof review.technical === 'object' ? review.technical : {};
  const Icon = stale ? ShieldAlert : ShieldCheck;

  return (
    <section className="export-review" aria-label="最终生成内容确认">
      <header className="export-review-head">
        <span className={`export-review-mark${stale ? ' is-stale' : ''}`}>
          <Icon size={16} />
        </span>
        <div>
          <h3>{review.ok ? review.headline : '还不能生成内容'}</h3>
          <p>
            {review.ok
              ? '下面这些就是从当前资料推导出来的结果；改资料或换位置后需要重新体检。'
              : review.emptyReason}
          </p>
        </div>
        {stale ? (
          <div className="export-review-stale">
            <strong>这份确认已过期</strong>
            <span>{staleReason || '资料或导出位置变了'}，旧体检结果不再有效。</span>
            {typeof onRerun === 'function' ? (
              <button type="button" className="ghost-button" onClick={onRerun}>
                {rerunLabel}
              </button>
            ) : null}
          </div>
        ) : null}
      </header>

      {review.ok ? (
        <div className="export-review-sections">
          {sections.map((section) => (
            <div className="export-review-section" key={section.id}>
              <h4>{section.title}</h4>
              <dl className="export-review-list">
                {(section.rows || []).map((row) => (
                  <div
                    className={`export-review-row${row.tone === 'warn' ? ' is-warn' : ''}`}
                    key={`${section.id}-${row.label}`}
                  >
                    <dt>{row.label}</dt>
                    <dd>{row.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      ) : null}

      {notes.length > 0 ? (
        <ul className="export-review-notes">
          {notes.map((note) => (
            <li key={note}>
              <Info size={13} />
              <span>{note}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {disclaimers.length > 0 ? (
        <p className="export-review-scope">{disclaimers.join('；')}</p>
      ) : null}
    </section>
  );
}
