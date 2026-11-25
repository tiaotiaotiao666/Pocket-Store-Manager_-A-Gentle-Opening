/**
 * E0-U1：目标页面单选（8 页冻结枚举）。
 *
 * 约束：
 * - 只吃 props（`pages` 来自平台 `get-context.targetPages[{id,enabled,reasons}]`），不读窗口全局、不调 IPC；
 * - 非 `enabled` 页**不可选**，并显示原因（reason 必须可见，不能只靠 disabled 颜色）；
 * - 每个可交互控件都有可读名称（`role` + `aria-label`），供 UIA / agent-desktop 按名字定位；
 * - 不自己发明第二个页面清单：id/label/顺序全部来自 `e0UiContract.mjs`。
 */

import { E0_TARGET_PAGE_IDS, normalizeTargetPages, E0_TARGET_PAGE_DISABLED_REASON } from './e0UiContract.mjs';

export default function TargetPageSelect({ pages, value = null, disabled = false, onChange, idPrefix = 'e0-target-page' }) {
  const normalized = normalizeTargetPages(pages);
  const enabledCount = normalized.pages.filter((page) => page.enabled).length;

  function selectPage(page) {
    if (disabled || !page.enabled) return;
    if (typeof onChange === 'function') onChange(page.id);
  }

  return (
    <section className="e0-field" id="e0-target-page-field" role="group" aria-label="目标页面选择">
      <div className="e0-field-header">
        <span className="e0-field-label" id="e0-target-page-label">目标页面（一次只改一个页面）</span>
        <span className="e0-field-meta" role="note" aria-label="可选页面数量">
          {enabledCount > 0 ? `可选 ${enabledCount} / ${E0_TARGET_PAGE_IDS.length} 页` : '当前没有可选页面'}
        </span>
      </div>
      <div className="e0-page-list" role="radiogroup" aria-label="目标页面（单选）" aria-labelledby="e0-target-page-label">
        {normalized.pages.map((page) => (
          <div
            key={page.id}
            id={`${idPrefix}-${page.id}`}
            className={`e0-page-option${page.enabled ? '' : ' e0-page-option-disabled'}${value === page.id ? ' e0-page-option-active' : ''}`}
            role="radio"
            aria-checked={value === page.id}
            aria-disabled={!page.enabled || disabled}
            aria-label={`${page.label}（${page.id}）${page.enabled ? '' : '，不可选'}`}
            tabIndex={page.enabled && !disabled ? 0 : -1}
            data-page-id={page.id}
            data-enabled={page.enabled ? 'true' : 'false'}
            onClick={() => selectPage(page)}
          >
            <span className="e0-page-option-title">{page.label}</span>
            <code className="e0-page-option-id">{page.id}</code>
            {page.enabled ? null : (
              <span className="e0-page-option-reason" role="note" aria-label={`${page.label}不可选原因`}>
                {page.reasons[0] || E0_TARGET_PAGE_DISABLED_REASON}
              </span>
            )}
          </div>
        ))}
      </div>
      {normalized.rejected.length > 0 ? (
        <p className="e0-field-hint" role="note" aria-label="被忽略的页面">
          平台返回了枚举外的页面 id：{normalized.rejected.join('、')}（已忽略，不是 8 页契约的一部分）
        </p>
      ) : null}
    </section>
  );
}
