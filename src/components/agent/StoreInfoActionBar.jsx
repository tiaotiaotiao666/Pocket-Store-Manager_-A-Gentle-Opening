import { CheckCircle2, Plus } from 'lucide-react';

function summaryText(status, pendingCount, canConfirm) {
  if (status === 'requesting') return '正在整理资料，请稍候';
  if (status === 'failed') return `请求失败，还有 ${pendingCount} 项待处理`;
  if (canConfirm) return '资料已齐全，可以继续';
  if (pendingCount > 0) return `还有 ${pendingCount} 项待补充`;
  return '等待输入开店资料';
}

export default function StoreInfoActionBar({
  status = 'idle',
  dishCount = 0,
  maxDishes = 5,
  missingCount = 0,
  errorCount = 0,
  editorOpen = true,
  onAddDish,
  onConfirm,
}) {
  const requestPending = status === 'requesting';
  const canAddDish = !requestPending && dishCount < maxDishes;
  const canConfirm = status === 'reviewing' && missingCount === 0 && errorCount === 0;
  const pendingCount = missingCount + errorCount;

  return (
    <div className="agent-action-bar" role="group" aria-label="开店资料操作">
      <div className="agent-action-meta">
        <span className={`agent-action-dot agent-action-dot-${status}`} aria-hidden="true" />
        <span className="agent-action-text">{summaryText(status, pendingCount, canConfirm)}</span>
        <span className="agent-action-count">{dishCount}/{maxDishes} 道菜</span>
      </div>
      <div className="agent-action-buttons">
        {editorOpen ? (
          <button
            type="button"
            className="agent-btn agent-btn-ghost"
            disabled={!canAddDish}
            onClick={() => onAddDish?.()}
          >
            <Plus size={14} />
            添加菜品（{dishCount}/{maxDishes}）
          </button>
        ) : null}
        <button
          type="button"
          className="agent-btn agent-btn-confirm"
          disabled={!canConfirm}
          onClick={() => onConfirm?.()}
        >
          <CheckCircle2 size={15} />
          资料无误，继续
        </button>
      </div>
    </div>
  );
}