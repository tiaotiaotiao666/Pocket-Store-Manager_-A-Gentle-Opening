export default function SatisfactionPrompt({
  question = '对于当前页面满意？',
  action = '下一步',
  onConfirm,
  disabled = false,
}) {
  return (
    <div className={`satisfy-prompt${disabled ? ' is-disabled' : ''}`}>
      <div className="satisfy-prompt-body">
        <span className="satisfy-prompt-question">{question}</span>
      </div>
      <button
        type="button"
        className="satisfy-prompt-action"
        disabled={disabled}
        onClick={onConfirm}
      >
        {action}
      </button>
    </div>
  );
}