import { useState } from 'react';
import { Sparkles, Wand2 } from 'lucide-react';

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
          <h3>生图提示词</h3>
          <p>这是我根据店铺信息写的一版提示词，你可以直接改，也可以告诉我要调整的地方。</p>
        </div>
        {roundList.length ? (
          <span className="prompt-rounds">已打磨 {roundList.length} 轮</span>
        ) : null}
      </header>

      <textarea
        className="prompt-textarea"
        rows={7}
        value={prompt || ''}
        placeholder="在这里编辑生图提示词"
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
          placeholder="告诉我要修改的地方"
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
          <Wand2 size={14} />
          让 AI 再改一版
        </button>
      </div>

      <div className="prompt-foot">
        <button
          type="button"
          className="prompt-confirm"
          onClick={() => onConfirm?.()}
          disabled={busy}
        >
          这版可以了，开始生成
        </button>
      </div>
    </section>
  );
}