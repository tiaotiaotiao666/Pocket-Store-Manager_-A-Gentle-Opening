import { RotateCcw, ShieldAlert } from 'lucide-react';
import { PENDING_CONFIRM_NOTE } from '../../domain/agentPendingConfirm.mjs';

/**
 * 统一会话「本轮已写入」卡片。
 *
 * 只展示桌面端实际生成的 before/after，不采信模型「已修改」文案；
 * 待确认项与 stale 结果单独分区，绝不与已写入项混在一起。
 */
const FIELD_LABELS = Object.freeze({
  'store.dishes': '菜品',
});

function labelOf(entry) {
  return entry.label || FIELD_LABELS[entry.fieldId] || entry.fieldId;
}

function displayValue(value) {
  return typeof value === 'string' && value ? value : '（空）';
}

export default function AppAssistantChangeCard({
  applied = null,
  pending = null,
  stale = null,
  canUndo = false,
  onUndo,
  pendingConfirm = null,
  pendingExpired = false,
}) {
  const entries = applied && Array.isArray(applied.entries) ? applied.entries : [];
  const pendingFields = pending && Array.isArray(pending.fields) ? pending.fields : [];
  const pendingActions = pending && Array.isArray(pending.actions) ? pending.actions : [];
  // 待确认项逐条给出「到哪确认」；App 没接进来时退化成原来的纯文字说明，绝不出现点不动的按钮。
  const confirmItems = pendingConfirm && Array.isArray(pendingConfirm.items) ? pendingConfirm.items : [];
  const onGoConfirm = pendingConfirm && typeof pendingConfirm.onGo === 'function' ? pendingConfirm.onGo : null;
  const hasPending = pendingFields.length > 0 || pendingActions.length > 0;

  if (!entries.length && !hasPending && !stale) return null;

  return (
    <div className="agent-chat-changes">
      {entries.length ? (
        <section className="agent-chat-changes-applied" aria-label="本轮已写入的修改">
          <h3 className="agent-chat-changes-title">本轮已写入</h3>
          <ul className="agent-chat-changes-list">
            {entries.map((entry, index) => (
              <li key={`${entry.fieldId}-${index}`} className="agent-chat-changes-item">
                <span className="agent-chat-changes-field">{labelOf(entry)}</span>
                <span className="agent-chat-changes-values">
                  <span className="agent-chat-changes-before">{displayValue(entry.before)}</span>
                  <span aria-hidden="true">→</span>
                  <span className="agent-chat-changes-after">{displayValue(entry.after)}</span>
                </span>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="agent-chat-changes-undo"
            aria-label="撤销本轮修改"
            disabled={!canUndo}
            onClick={() => onUndo?.()}
          >
            <RotateCcw size={13} aria-hidden="true" />
            撤销本轮
          </button>
          {!canUndo ? (
            <p className="agent-chat-changes-note">项目在这之后又有变化，只能用全局撤销。</p>
          ) : null}
        </section>
      ) : null}

      {hasPending ? (
        <section className="agent-chat-pending" aria-label="等待确认的修改">
          <p className="agent-chat-pending-title">
            <ShieldAlert size={13} aria-hidden="true" />
            {pendingExpired
              ? `有 ${pendingFields.length + pendingActions.length} 项当时需要确认，这一轮已经过期`
              : `有 ${pendingFields.length + pendingActions.length} 项需要你确认，尚未写入`}
          </p>
          {pendingExpired ? (
            // 过期后不再给任何入口：旧提案不许复用，只能重新发一次让模型按当前项目重新出提案。
            <p className="agent-chat-pending-note">
              这一轮的提案已经过期（项目在此期间有变化，或换过项目），请重新发一次再确认。没有写入任何内容。
            </p>
          ) : (
            <>
              <p className="agent-chat-pending-note">{PENDING_CONFIRM_NOTE}</p>
              {confirmItems.length ? (
                <ul className="agent-chat-pending-list">
                  {confirmItems.map((item) => (
                    <li className="agent-chat-pending-item" key={item.key}>
                      <span className="agent-chat-pending-item-text">
                        <span className="agent-chat-pending-item-title">{item.title}</span>
                        <span className="agent-chat-pending-item-detail">{item.detail}</span>
                      </span>
                      {item.jumpId && onGoConfirm ? (
                        <button
                          type="button"
                          className="agent-chat-pending-jump"
                          // 同一屏可能有多条待确认：可见文案统一，读屏名按条目区分，避免同名按钮。
                          aria-label={`前往确认：${item.title}`}
                          disabled={item.sameTargetAsHint === true}
                          title={item.sameTargetAsHint ? '上面的提示已经指向同一处' : `定位到「${item.title}」的确认入口`}
                          onClick={() => onGoConfirm(item)}
                        >
                          前往确认
                        </button>
                      ) : (
                        <span className="agent-chat-pending-item-hint">
                          {item.sameTargetAsHint ? '见上方提示' : '请到对应业务面板确认'}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="agent-chat-pending-note">
                  涉及清空已有值、删除菜品、素材、AppID、模板或导出等高风险操作；确认入口仍走原有业务面板。
                </p>
              )}
            </>
          )}
        </section>
      ) : null}

      {stale ? (
        <p className="agent-chat-stale" role="status">
          项目在此期间已变化，这次结果没有写入，请重试。
        </p>
      ) : null}
    </div>
  );
}