/**
 * B5：发送参考截图前的告知卡片（纯展示，判断在 domain 与主进程）。
 *
 * 无障碍：容器 `role="dialog"` + `aria-label="截图发送确认"`，两颗按钮都有唯一可读名称，
 * 取消按钮排在前面且不隐藏，避免只能靠 Esc 才能退出。
 */
export default function ScreenSendConsent({ notice, busy = false, onConfirm, onCancel }) {
  if (!notice) return null;
  const lines = Array.isArray(notice.lines) ? notice.lines : [];
  return (
    <section
      className="screen-send-consent"
      role="dialog"
      aria-label="截图发送确认"
      aria-modal="false"
    >
      <h4>{notice.title}</h4>
      <ul className="screen-send-consent-lines">
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <div className="screen-send-consent-actions">
        <button
          type="button"
          className="btn btn-ghost"
          id="screen-send-cancel"
          onClick={busy ? undefined : onCancel}
          disabled={busy}
        >
          {notice.cancelLabel || '取消，不发'}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          id="screen-send-confirm"
          onClick={busy ? undefined : onConfirm}
          disabled={busy}
        >
          {notice.confirmLabel || '确认发送'}
        </button>
      </div>
      <p className="screen-send-consent-foot">
        确认只对这张图、这个接收方有效；换图或换后端地址会重新问你。
      </p>
    </section>
  );
}
