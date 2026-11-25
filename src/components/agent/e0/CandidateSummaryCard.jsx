/**
 * E0-U1：候选摘要卡（修改文件数 / treeDigest / 静态四态 / 运行时四态 / BLOCKED·NOT_RUN 原因）。
 *
 * 只展示本地事实（§14.7 X9：模型文字不做“已验证/已采用”改写；状态只来自本地证据）：
 * - 静态四态与运行时四态分开显示，`partial` 与 `PASS` 不同色不同词；
 * - `submitReady` 只是“静态门禁是否满足”，**不表示已采用**，卡片上必须写明这一点；
 * - 没有候选时显示 NOT_RUN，不画一个看起来通过的空壳。
 */

import {
  E0_EMPTY_SUMMARY_TEXT,
  E0_STATUS_LABELS,
  buildCandidateSummary,
  formatCheckStatusLabel,
} from './e0UiContract.mjs';

function CheckRow({ item }) {
  return (
    <li className="e0-check-row" role="listitem" data-check-id={item.checkId} data-status={item.status} aria-label={`${item.checkId}：${item.status}`}>
      <code className="e0-check-id">{item.checkId}</code>
      <span className="e0-check-status" data-status={item.status}>{item.status}</span>
      <span className="e0-check-status-label" role="note" aria-label={`${item.checkId}状态说明`}>{formatCheckStatusLabel(item.status)}</span>
      {item.reason ? (
        <span className="e0-check-reason" role="note" aria-label={`${item.checkId}原因`}>{item.reason}</span>
      ) : null}
    </li>
  );
}

function ReasonList({ title, items, ariaLabel }) {
  if (!items.length) return null;
  return (
    <div className="e0-reason-block" role="group" aria-label={ariaLabel}>
      <span className="e0-reason-title">{title}</span>
      <ul className="e0-reason-list" role="list" aria-label={ariaLabel}>
        {items.map((item) => (
          <li key={`${item.checkId}-${item.status}`} className="e0-reason-item" role="listitem" aria-label={`${item.checkId} ${item.status} 原因`}>
            <span className="e0-check-status" data-status={item.status}>{item.status}</span>
            <code className="e0-check-id">{item.checkId}</code>
            <span className="e0-check-reason">{item.reason}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function CandidateSummaryCard({ summary = null, title = '候选摘要' }) {
  const data = summary ? buildCandidateSummary(summary) : null;

  if (!data || (!data.attemptId && data.changedFileCount === 0 && data.static.count === 0)) {
    return (
      <section className="e0-candidate" id="e0-candidate-summary" role="region" aria-label={title}>
        <div className="e0-field-header">
          <span className="e0-field-label">{title}</span>
          <span className="e0-field-meta e0-check-status" data-status="NOT_RUN" role="status" aria-label="候选状态：NOT_RUN">NOT_RUN</span>
        </div>
        <p className="e0-field-hint" role="note" aria-label="无候选提示">{E0_EMPTY_SUMMARY_TEXT}</p>
      </section>
    );
  }

  return (
    <section className="e0-candidate" id="e0-candidate-summary" role="region" aria-label={title}>
      <div className="e0-field-header">
        <span className="e0-field-label">{title}</span>
        <span
          className={`e0-field-meta e0-check-status e0-gate${data.submitReady ? ' e0-gate-ready' : ''}`}
          data-status={data.static.status}
          role="status"
          aria-label={`静态门禁：${data.static.status}`}
        >
          静态门禁 {data.static.status}
        </span>
      </div>

      <dl className="e0-candidate-facts">
        <div className="e0-fact">
          <dt>修改文件数</dt>
          <dd aria-label={`修改文件数 ${data.changedFileCount}`}>{data.changedFileCount}</dd>
        </div>
        <div className="e0-fact">
          <dt>treeDigest</dt>
          <dd className="e0-digest" title={data.treeDigest} aria-label={`treeDigest ${data.treeDigest || '未知'}`}>{data.treeDigestShort}</dd>
        </div>
        <div className="e0-fact">
          <dt>attempt</dt>
          <dd aria-label={`attempt ${data.attemptId || '未知'}`}>{data.attemptId || '未知'}{data.revision === null ? '' : `（revision ${data.revision}）`}</dd>
        </div>
        <div className="e0-fact">
          <dt>目标页面</dt>
          <dd aria-label={`目标页面 ${data.targetPage || '未知'}`}>{data.targetPage || '未知'}</dd>
        </div>
      </dl>

      <div className="e0-check-groups">
        <div className="e0-check-group" role="group" aria-label="静态检查四态">
          <div className="e0-check-group-header">
            <span className="e0-check-group-title">静态检查</span>
            <span className="e0-check-status" data-status={data.static.status} role="status" aria-label={`静态检查汇总：${data.static.status}`}>
              {data.static.status}
            </span>
            <span className="e0-field-meta">{E0_STATUS_LABELS[data.static.status]}（{data.static.count} 项）</span>
          </div>
          {data.static.count > 0 ? (
            <ul className="e0-check-list" role="list" aria-label="静态检查明细">
              {data.static.items.map((item) => <CheckRow key={`static-${item.checkId}`} item={item} />)}
            </ul>
          ) : (
            <p className="e0-field-hint" role="note" aria-label="静态检查未执行">静态检查未执行（NOT_RUN）</p>
          )}
        </div>

        <div className="e0-check-group" role="group" aria-label="运行时检查四态">
          <div className="e0-check-group-header">
            <span className="e0-check-group-title">运行时检查（微信）</span>
            <span className="e0-check-status" data-status={data.runtime.status} role="status" aria-label={`运行时检查汇总：${data.runtime.status}`}>
              {data.runtime.status}
            </span>
            <span className="e0-field-meta">{E0_STATUS_LABELS[data.runtime.status]}（{data.runtime.count} 项）</span>
          </div>
          {data.runtime.count > 0 ? (
            <ul className="e0-check-list" role="list" aria-label="运行时检查明细">
              {data.runtime.items.map((item) => <CheckRow key={`runtime-${item.checkId}`} item={item} />)}
            </ul>
          ) : (
            <p className="e0-field-hint" role="note" aria-label="运行时检查未执行">
              运行时检查未执行（NOT_RUN）：不得声称微信已验证
            </p>
          )}
        </div>
      </div>

      <ReasonList title="BLOCKED 原因" items={data.blockedReasons} ariaLabel="BLOCKED 原因" />
      <ReasonList title="NOT_RUN 原因" items={data.notRunReasons} ariaLabel="NOT_RUN 原因" />

      {data.partial ? (
        <p className="e0-field-hint" role="note" aria-label="partial 说明">
          partial ≠ 通过：存在 BLOCKED / NOT_RUN 的检查，采用时需要显式确认
        </p>
      ) : null}
      <p className="e0-field-hint" role="note" aria-label="门禁口径说明">
        「静态门禁 {data.static.status}」只表示能不能提交，不等于已采用/已导出；采用与导出只由本地版本证据决定
      </p>
    </section>
  );
}
