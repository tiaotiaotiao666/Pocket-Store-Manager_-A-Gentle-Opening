import { RotateCcw, ShieldAlert } from 'lucide-react';

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
}) {
  const entries = applied && Array.isArray(applied.entries) ? applied.entries : [];
  const pendingFields = pending && Array.isArray(pending.fields) ? pending.fields : [];
  const pendingActions = pending && Array.isArray(pending.actions) ? pending.actions : [];
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
            有 {pendingFields.length + pendingActions.length} 项需要你确认，尚未写入
          </p>
          <p className="agent-chat-pending-note">
            涉及清空已有值、删除菜品、素材、AppID、模板或导出等高风险操作；确认入口仍走原有业务面板。
          </p>
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