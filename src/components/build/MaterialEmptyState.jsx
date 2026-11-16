import { useRef } from 'react';
import { ImagePlus, Sparkles, SkipForward } from 'lucide-react';

/**
 * UX0-5：没有真实生图结果时的素材空状态。
 * 不显示任何"看起来像效果图"的占位图（本地演示图不得冒充生成结果），
 * 只给出三条明确路径，其中未接入的能力必须禁用并说明原因。
 */
export default function MaterialEmptyState({
  onUpload,
  onSkip,
  canGenerate = false,
  generateBlockedReason = '尚未接入生图服务，当前版本无法生成海报',
  uploadDisabled = false,
}) {
  const inputRef = useRef(null);

  const handlePick = () => {
    if (uploadDisabled) return;
    inputRef.current?.click();
  };

  const handleChange = (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (file) onUpload?.(file);
  };

  return (
    <div className="material-empty" role="group" aria-label="素材空状态">
      <div className="material-empty-head">
        <span className="material-empty-icon" aria-hidden="true">
          <ImagePlus size={18} />
        </span>
        <div>
          <h4 className="material-empty-title">还没有效果图</h4>
          <p className="material-empty-text">这里不会用占位图冒充生成结果。你可以先放一张自己的图，或跳过这一步。</p>
        </div>
      </div>
      <div className="material-empty-actions">
        <button
          type="button"
          className="agent-btn agent-btn-primary"
          onClick={handlePick}
          disabled={uploadDisabled}
        >
          <ImagePlus size={15} />
          上传图片
        </button>
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
        <button type="button" className="agent-btn agent-btn-ghost" onClick={() => onSkip?.()}>
          <SkipForward size={15} />
          暂时跳过
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="material-empty-file"
          onChange={handleChange}
          tabIndex={-1}
          aria-hidden="true"
        />
      </div>
      {canGenerate ? null : (
        <p className="material-empty-reason" id="material-generate-reason">{generateBlockedReason}</p>
      )}
    </div>
  );
}
