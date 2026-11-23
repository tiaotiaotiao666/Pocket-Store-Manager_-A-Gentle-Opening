import { CornerDownRight, MousePointerClick } from 'lucide-react';

/**
 * 「Agent 正在等你操作」提示条。
 *
 * 只做三件事：说清在等什么、去哪一块点哪个按钮、给一个「前往处理」跳转入口。
 * 边界：
 * - 纯展示 + 一个跳转回调，不发请求、不 dispatch，也不替用户点确认/应用/生成/导出/下单；
 * - 是否显示完全由 App 依据真实状态算出来（`waitingHint`），状态一变就自动消失，
 *   组件自己没有任何计时器或本地记忆，避免「已经完成还挂着等你的条」。
 */
export default function AgentWaitingHint({ hint = null, busy = false, onGo }) {
  const title = hint && typeof hint.title === 'string' ? hint.title : '';
  if (!title) return null;
  const detail = typeof hint.detail === 'string' ? hint.detail : '';
  const jumpId = typeof hint.jumpId === 'string' ? hint.jumpId : '';
  const actionLabel = typeof hint.actionLabel === 'string' && hint.actionLabel ? hint.actionLabel : '前往处理';

  return (
    <section className="agent-waiting-hint" role="status" aria-live="polite" aria-label="等待你操作">
      <p className="agent-waiting-hint-title">
        <MousePointerClick size={13} aria-hidden="true" />
        {title}
      </p>
      {detail ? <p className="agent-waiting-hint-detail">{detail}</p> : null}
      {jumpId && typeof onGo === 'function' ? (
        <button
          type="button"
          className="agent-waiting-hint-go"
          data-waiting-jump={jumpId}
          disabled={busy}
          onClick={() => onGo(jumpId)}
        >
          {actionLabel}
          <CornerDownRight size={13} aria-hidden="true" />
        </button>
      ) : null}
      <p className="agent-waiting-hint-note">只是帮你定位：确认、应用、生成、导出仍然由你自己点。</p>
    </section>
  );
}
