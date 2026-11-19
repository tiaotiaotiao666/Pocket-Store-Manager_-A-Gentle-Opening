import { ImagePlus, Sparkles, SkipForward } from 'lucide-react';
import PosterGeneratorPanel from './PosterGeneratorPanel.jsx';

/**
 * UX0b：没有海报素材时的空状态。
 * - 「上传图片」走主进程文件对话框 + 本地资产落盘，不在渲染进程读文件；
 * - G1：接入真实生图服务后，生成入口变成可编辑提示词的生成面板；
 *   未接入（generator 为空）时保持禁用并说明原因；
 * - 「暂时跳过」不阻断小程序生成。
 */
export default function MaterialEmptyState({
  onPick,
  onSkip,
  canGenerate = false,
  generateBlockedReason = '尚未接入生图服务，当前版本无法生成海报',
  uploadDisabled = false,
  generator = null,
}) {
  return (
    <div className="material-empty" role="group" aria-label="素材空状态">
      <div className="material-empty-head">
        <span className="material-empty-icon" aria-hidden="true">
          <ImagePlus size={18} />
        </span>
        <div>
          <h4 className="material-empty-title">还没有海报素材</h4>
          <p className="material-empty-text">
            这里不会用占位图冒充生成结果。可以放一张自己的 PNG 图（不超过 2 MB），或跳过这一步。
          </p>
        </div>
      </div>
      <div className="material-empty-actions">
        <button
          type="button"
          className="agent-btn agent-btn-primary"
          onClick={() => onPick?.()}
          disabled={uploadDisabled}
        >
          <ImagePlus size={15} />
          {uploadDisabled ? '正在保存图片' : '上传图片（PNG）'}
        </button>
        {generator ? null : (
          <button
            type="button"
            className="agent-btn agent-btn-ghost"
            disabled={!canGenerate}
            title={canGenerate ? undefined : generateBlockedReason}
            aria-describedby="material-generate-reason"
          >
            <Sparkles size={15} />
            生成海报
          </button>
        )}
        <button
          type="button"
          className="agent-btn agent-btn-ghost"
          onClick={() => onSkip?.()}
          disabled={uploadDisabled}
        >
          <SkipForward size={15} />
          暂时跳过
        </button>
      </div>
      {generator ? <PosterGeneratorPanel {...generator} /> : null}
      {!generator && !canGenerate ? (
        <p className="material-empty-reason" id="material-generate-reason">{generateBlockedReason}</p>
      ) : null}
    </div>
  );
}
