export default function SkipNotice({
  visible = false,
  question = '已经了解？想跳过',
  action = '跳过',
  onSkip,
}) {
  if (!visible) return null;

  return (
    <div className="skip-notice">
      <span className="skip-question">{question}</span>
      <button type="button" className="skip-action" onClick={onSkip}>
        {action}
      </button>
    </div>
  );
}