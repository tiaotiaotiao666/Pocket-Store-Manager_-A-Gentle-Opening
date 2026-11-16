import { Image as ImageIcon, RefreshCw } from 'lucide-react';
import MaterialEmptyState from './MaterialEmptyState.jsx';

/** local-demo 占位图不是真实素材，只有用户上传（或未来真实生成的）图片才算。 */
function resolveMaterial(image) {
  if (!image || !image.dataUrl) return null;
  if (image.provider === 'local-demo') return null;
  return image;
}

/**
 * UX0b：海报素材（可选）。
 * - 上传走「主进程选图 → 资产落盘 → 回读预览」，渲染进程不直接读磁盘；
 * - 只有资产真的保存成功（assetId + user-upload 预览）才允许「使用此图并继续」，
 *   否则按钮禁用并说明，不会假装上传成功；
 * - 保存中禁用重复操作并显示「正在保存图片」；
 * - 已选图后可「重新选择图片」：旧图在新图保存完成前保持不变。
 */
export default function ImageReview({
  image = null,
  assetId = null,
  busy = false,
  onPick,
  onUse,
  onSkip,
  canGenerate = false,
  generateBlockedReason,
}) {
  const material = resolveMaterial(image);
  const saved = Boolean(assetId) && material?.provider === 'user-upload';
  const sourceLabel = material
    ? (material.provider === 'user-upload'
      ? (saved ? '你上传的图片（已保存到项目）' : '你上传的图片（预览）')
      : (material.note || material.provider || '已选素材'))
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
                disabled={busy || !saved}
                title={saved ? undefined : '图片还没有保存成功，请重新选择图片'}
              >
                使用此图并继续
              </button>
              <button
                type="button"
                className="agent-btn agent-btn-ghost"
                onClick={() => onPick?.()}
                disabled={busy}
              >
                <RefreshCw size={15} />
                {busy ? '正在保存图片' : '重新选择图片'}
              </button>
              <button
                type="button"
                className="agent-btn agent-btn-ghost"
                onClick={() => onSkip?.()}
                disabled={busy}
              >
                暂时跳过
              </button>
            </div>
            {saved ? null : (
              <p className="material-empty-reason">这张图只做了预览，还没有保存到项目；请重新选择图片。</p>
            )}
          </>
        ) : (
          <MaterialEmptyState
            onPick={onPick}
            onSkip={onSkip}
            canGenerate={canGenerate}
            generateBlockedReason={generateBlockedReason}
            uploadDisabled={busy}
          />
        )}

        {busy ? (
          <div className="review-busy">
            <span className="review-busy-label">正在保存图片</span>
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
