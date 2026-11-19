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
  generator = null,
}) {
  const material = resolveMaterial(image);
  const provider = material?.provider || null;
  const isAi = provider === 'ai-generated';
  const saved = Boolean(assetId) && (provider === 'user-upload' || isAi);
  const sourceLabel = provider === 'user-upload'
    ? (saved ? '你上传的图片（已保存到项目）' : '你上传的图片（预览）')
    : (isAi
      ? (saved ? 'AI 生成（第三方生图服务，已保存到项目）' : 'AI 生成（预览，未保存）')
      : (material ? (material.note || provider || '已选素材') : ''));

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
            {isAi && saved ? (
              <p className="poster-generator-success" role="status">AI 生成成功 · 已保存到项目</p>
            ) : null}
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
              {generator ? (
                <button
                  type="button"
                  className="agent-btn agent-btn-ghost"
                  onClick={() => generator.onGenerate?.()}
                  disabled={busy || generator.busy}
                >
                  <RefreshCw size={15} />
                  {generator.busy ? '正在重新生成（约 30 秒）' : '重新生成'}
                </button>
              ) : null}
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
            {generator && generator.error ? (
              <p className="poster-generator-error" role="alert">{generator.error}</p>
            ) : null}
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
            generator={generator}
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
