export default function TitleBar({ title, caption, badge, onReset }) {
  return (
    <header className="titlebar">
      <div className="titlebar-lead">
        <span className="titlebar-title">{title}</span>
        {caption ? <span className="titlebar-caption">{caption}</span> : null}
      </div>
      <div className="titlebar-tail">
        {badge ? <span className="titlebar-badge">{badge}</span> : null}
        <button type="button" className="titlebar-reset" onClick={onReset}>
          重置
        </button>
      </div>
    </header>
  );
}