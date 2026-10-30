export default function TypingDots({ label }) {
  return (
    <div className="typing-row">
      <span className="typing-dots">
        <i className="typing-dot" />
        <i className="typing-dot" />
        <i className="typing-dot" />
      </span>
      {label ? <span className="typing-label">{label}</span> : null}
    </div>
  );
}