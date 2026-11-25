import { CheckCircle2 } from 'lucide-react';

import { canConfirmStoreInfo } from '../../domain/agentDraft.mjs';
import { storeInfoActionSummary } from '../../domain/storeInfoActionText.mjs';
import { MAX_DISHES } from '../../domain/storeLimits.mjs';

export default function StoreInfoActionBar({
  status = 'idle',
  dishCount = 0,
  maxDishes = MAX_DISHES,
  missingCount = 0,
  errorCount = 0,
  onConfirm,
}) {
  const canConfirm = canConfirmStoreInfo(status, missingCount, errorCount);
  const pendingCount = missingCount + errorCount;

  return (
    <div className="agent-action-bar" role="group" aria-label="开店资料操作">
      <div className="agent-action-meta">
        <span className={`agent-action-dot agent-action-dot-${status}`} aria-hidden="true" />
        <span className="agent-action-text">{storeInfoActionSummary(status, pendingCount, canConfirm)}</span>
        <span className="agent-action-count">{dishCount}/{maxDishes} 道菜</span>
      </div>
      <div className="agent-action-buttons">
        <button
          type="button"
          className="agent-btn agent-btn-confirm" data-jump-id="store-info-confirm"
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