import { Image as ImageIcon } from 'lucide-react';
import MaterialEmptyState from './MaterialEmptyState.jsx';

/** 本地演示图（provider=local-demo）不是真实生成结果，不能当效果图展示。 */
function isRealResult(image) {
  if (!image || !image.dataUrl) return false;
  return image.provider !== 'local-demo';
}

/**
 * UX0-4 / UX0-5：卡片内不再放"修改框 + 重新生成 + 确认"三套入口，
 * 唯一输入区与主操作按钮统一由底部 Composer 承担；
 * 没有真实生成结果时展示可跳过的素材空状态，而不是笑脸占位图。
 */
export default function ImageReview({
  image = null,
  rounds = [],
  busy = false,
  onUpload,
  onSkip,
  canGenerate = false,
  generateBlockedReason,
}) {
  const roundList = Array.isArray(rounds) ? rounds : [];
  const real = isRealResult(image);

  return (
    <section className="review-panel">
      <header className="review-head">
        <span className="review-head-icon">
          <ImageIcon size={16} />
        </span>
        <div className="review-heading">
          <h3>效果图</h3>
          <p>在下方输入框描述要改的地方，我就会重做一版。</p>
        </div>
        {roundList.length ? (
          <span className="review-rounds">已修改 {roundList.length} 轮</span>
        ) : null}
      </header>

      <div className={`review-stage${busy ? ' is-busy' : ''}`}>
        {real ? (
          <figure className="review-figure">
            <img className="review-image" src={image.dataUrl} alt="效果图" />
            {image.provider || image.note ? (
              <figcaption className="review-caption">
                {image.provider ? <span className="review-provider">{image.provider}</span> : null}
                {image.note ? <span className="review-note">{image.note}</span> : null}
              </figcaption>
            ) : null}
          </figure>
        ) : (
          <MaterialEmptyState
            onUpload={onUpload}
            onSkip={onSkip}
            canGenerate={canGenerate}
            generateBlockedReason={generateBlockedReason}
            uploadDisabled={busy}
          />
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
    </section>
  );
}
