import { Image as ImageIcon } from 'lucide-react';
import MaterialEmptyState from './MaterialEmptyState.jsx';

/** local-demo 占位图不是真实素材，只有用户上传（或未来真实生成的）图片才算。 */
function resolveMaterial(image) {
  if (!image || !image.dataUrl) return null;
  if (image.provider === 'local-demo') return null;
  return image;
}

/**
 * UX0a-3：海报素材（可选）。
 * - 没有任何生成入口：未接入生图服务时既不调用生成，也不显示"重新生成"；
 * - 空状态只留「上传图片」与「暂时跳过」，生成海报按钮禁用并说明原因；
 * - 上传后显示图片、来源与唯一主按钮「使用此图并继续」；
 * - 这一步不阻断小程序生成。
 */
export default function ImageReview({
  image = null,
  busy = false,
  onUpload,
  onUse,
  onSkip,
  canGenerate = false,
  generateBlockedReason,
}) {
  const material = resolveMaterial(image);
  const sourceLabel = material
    ? (material.provider === 'user-upload' ? '你上传的图片' : (material.note || material.provider || '已选素材'))
    : '';

  return (
    <section className="review-panel">
      <header className="review-head">
        <span className="review-head-icon">
          <ImageIcon size={16} />
        </span>
        <div className="review-heading">
          <h3>海报素材（可选）</h3>
          <p>这一步不会阻断小程序生成。没有合适的图也可以直接跳过。</p>
        </div>
      </header>

      <div className={`review-stage${busy ? ' is-busy' : ''}`}>
        {material ? (
          <>
            <figure className="review-figure">
              <img className="review-image" src={material.dataUrl} alt="已选海报素材" />
              <figcaption className="review-caption">
                <span className="review-provider">{sourceLabel}</span>
              </figcaption>
            </figure>
            <div className="material-empty-actions">
              <button
                type="button"
                className="agent-btn agent-btn-primary"
                onClick={() => onUse?.()}
              >
                使用此图并继续
              </button>
            </div>
          </>
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
            <span className="review-busy-label">处理中</span>
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
