import { useState } from 'react';
import { Sparkles, Save } from 'lucide-react';

/**
 * 视觉偏好步骤（B3 收口）。
 *
 * 当前版本没有接入生图服务，所以这里**不承诺**生成图片，也不让用户"先打磨再出图"：
 * 只记录用户想要的视觉偏好，主流程下一屏是「海报素材（可选）：上传或跳过」。
 */
export default function PromptStudio({
  prompt = '',
  tips = [],
  rounds = [],
  busy = false,
  onPromptChange,
  onFeedback,
  onConfirm,
}) {
  const [feedback, setFeedback] = useState('');
  const tipList = Array.isArray(tips) ? tips : [];
  const roundList = Array.isArray(rounds) ? rounds : [];

  const handleTip = (tip) => {
    const text = typeof tip === 'string' ? tip : tip?.text ?? tip?.label ?? '';
    if (!text) return;
    setFeedback((prev) => (prev.trim() ? `${prev.trim()}；${text}` : text));
  };

  const handleSubmit = () => {
    const text = feedback.trim();
    if (!text || busy) return;
    onFeedback?.(text);
    setFeedback('');
  };

  return (
    <section className="prompt-studio">
      <header className="prompt-head">
        <span className="prompt-head-icon">
          <Sparkles size={16} />
        </span>
        <div className="prompt-heading">
          <h3>视觉偏好（不生成图片）</h3>
          <p>
            当前版本没有接入生图服务，这一步只记录你想要的视觉风格；
            下一步是「海报素材（可选）」，可以上传一张图，也可以直接跳过。
          </p>
        </div>
        {roundList.length ? (
          <span className="prompt-rounds">已记录 {roundList.length} 次偏好</span>
        ) : null}
      </header>

      <textarea
        className="prompt-textarea"
        rows={7}
        value={prompt || ''}
        placeholder="例如：暖色调、木头质感、主图大一点、字少一点"
        onChange={(event) => onPromptChange?.(event.target.value)}
      />

      {tipList.length ? (
        <div className="prompt-tips">
          <span className="prompt-tips-label">试试这些调整</span>
          <div className="prompt-tip-list">
            {tipList.map((tip, index) => {
              const text = typeof tip === 'string' ? tip : tip?.text ?? tip?.label ?? '';
              return (
                <button
                  type="button"
                  key={`tip-${index}`}
                  className="prompt-tip"
                  onClick={() => handleTip(tip)}
                >
                  {text}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="prompt-feedback">
        <input
          className="prompt-feedback-input"
          type="text"
          value={feedback}
          placeholder="还想补充的偏好"
          onChange={(event) => setFeedback(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') handleSubmit();
          }}
        />
        <button
          type="button"
          className="prompt-feedback-button"
          onClick={handleSubmit}
          disabled={busy || !feedback.trim()}
        >
          <Save size={14} />
          保存这段偏好
        </button>
      </div>

      <div className="prompt-foot">
        <button
          type="button"
          className="prompt-confirm"
          onClick={() => onConfirm?.()}
          disabled={busy}
        >
          继续（下一步：海报素材，可选）
        </button>
      </div>
    </section>
  );
}
