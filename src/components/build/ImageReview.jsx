import { useState } from 'react';
import { Image as ImageIcon, RefreshCw } from 'lucide-react';

export default function ImageReview({
  image = null,
  rounds = [],
  busy = false,
  onFeedback,
  onRegenerate,
  onApprove,
}) {
  const [feedback, setFeedback] = useState('');
  const roundList = Array.isArray(rounds) ? rounds : [];
  const current = image && image.dataUrl ? image : null;

  const handleSubmit = () => {
    const text = feedback.trim();
    if (!text || busy) return;
    onRegenerate?.(text);
    setFeedback('');
  };

  return (
    <section className="review-panel">
      <header className="review-head">
        <span className="review-head-icon">
          <ImageIcon size={16} />
        </span>
        <div className="review-heading">
          <h3>效果图预览</h3>
          <p>看看哪里还不满意，告诉我，我们在这个会话里继续调整。</p>
        </div>
        {roundList.length ? (
          <span className="review-rounds">已修改 {roundList.length} 轮</span>
        ) : null}
      </header>

      <div className={`review-stage${busy ? ' is-busy' : ''}`}>
        {current ? (
          <figure className="review-figure">
            <img className="review-image" src={current.dataUrl} alt="效果图" />
            {current.provider || current.note ? (
              <figcaption className="review-caption">
                {current.provider ? (
                  <span className="review-provider">{current.provider}</span>
                ) : null}
                {current.note ? <span className="review-note">{current.note}</span> : null}
              </figcaption>
            ) : null}
          </figure>
        ) : (
          <div className="review-placeholder">
            <span className="review-placeholder-text">还没有效果图</span>
          </div>
        )}

        {busy ? (
          <div className="review-busy">
            <span className="review-busy-label">生成中</span>
            <span className="review-dots">
              <i className="review-dot" />
              <i className="review-dot" />
              <i className="review-dot" />
            </span>
          </div>
        ) : null}
      </div>

      <div className="review-feedback">
        <input
          className="review-feedback-input"
          type="text"
          value={feedback}
          placeholder="告诉我要修改的地方"
          onChange={(event) => setFeedback(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') handleSubmit();
          }}
        />
        <button
          type="button"
          className="review-feedback-button"
          onClick={handleSubmit}
          disabled={busy || !feedback.trim()}
        >
          <RefreshCw size={14} />
          重新生成
        </button>
      </div>

      <div className="review-foot">
        <button
          type="button"
          className="review-confirm"
          onClick={() => onApprove?.()}
          disabled={busy}
        >
          效果满意，去部署
        </button>
      </div>
    </section>
  );
}