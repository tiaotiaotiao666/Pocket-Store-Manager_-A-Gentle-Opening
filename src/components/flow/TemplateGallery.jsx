import { Check, GitCompareArrows, Loader2, RefreshCw } from 'lucide-react';
import SatisfactionPrompt from './SatisfactionPrompt.jsx';
import TemplateCompare from './TemplateCompare.jsx';
import TemplateRevisePanel from './TemplateRevisePanel.jsx';
import MiniProgramPreview from '../preview/MiniProgramPreview.jsx';
import { describeTemplateReviseTransport } from '../../services/agentTurn/templateReviseService.js';
import { SATISFACTION, TEMPLATE_REFINE } from '../../domain/onboardingScript.mjs';

/**
 * 模板页（`C-TEMPLATE-GALLERY@1`，plan.md 2.2.5）。
 *
 * 现有 props 与行为全部保留：
 * - 3 张候选卡始终展示、可切换；
 * - 「实时预览」只消费 `viewModelsByTemplateId[selectedId]`；
 * - 「不满意 → 重新用语言描述」表单仍是独立入口，提交走 `onRefine`。
 *
 * 新增 props 全部可选，未传时行为与之前一致：
 * - `presentation` / `onRevise` / `onClearReviseError`：「对话修改当前模板」面板；
 * - `compareIds` / `onCompareChange`：并排对比（最多 2 个完整预览）。
 */
export default function TemplateGallery({
  candidates = [],
  selectedId = null,
  onSelect,
  onConfirm,
  viewModelsByTemplateId = {},
  refineText = '',
  onRefineChange,
  onRefine,
  refining = false,
  refineError = null,
  // —— 以下为新增可选 props ——
  presentation = null,
  onRevise,
  onClearReviseError,
  compareIds = null,
  onCompareChange,
  mockRevise = null,
}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const selected = list.find((item) => item.id === selectedId) ?? list[0];
  const selectedRecipe = selected && viewModelsByTemplateId[selected.id] && viewModelsByTemplateId[selected.id].recipe
    ? viewModelsByTemplateId[selected.id].recipe.displayName
    : null;
  const trimmed = String(refineText ?? '').trim();
  const canSubmit = trimmed.length > 0 && !refining;

  const ids = list.map((item) => item.id);
  const compareEnabled = typeof onCompareChange === 'function';
  const activeCompare = (() => {
    if (!Array.isArray(compareIds) || compareIds.length !== 2) return null;
    const [left, right] = compareIds;
    if (left === right || !ids.includes(left) || !ids.includes(right)) return null;
    return [left, right];
  })();
  const reviseEnabled = typeof onRevise === 'function' || presentation != null;
  // 显式传布尔值时尊重父组件；未传时按当前 transport 模式自动标注，
  // 避免 T14 忘记传 prop 时把本地 Mock 结果说成真实模型成功。
  const mockBadge = typeof mockRevise === 'boolean'
    ? mockRevise
    : (reviseEnabled ? describeTemplateReviseTransport().mock : false);

  const handleRefineSubmit = (event) => {
    event.preventDefault();
    if (!canSubmit) return;
    onRefine?.(trimmed);
  };

  const handleToggleCompare = () => {
    if (!compareEnabled) return;
    if (activeCompare) {
      onCompareChange(null);
      return;
    }
    const left = selected?.id ?? ids[0];
    const right = ids.find((id) => id !== left);
    if (!left || !right) return;
    onCompareChange([left, right]);
  };

  // 两侧不允许选同一套模板：选中另一侧已占用的模板时自动互换。
  const handleCompareSideChange = (side, nextId) => {
    if (!activeCompare || !nextId) return;
    const [left, right] = activeCompare;
    const current = side === 'left' ? left : right;
    const other = side === 'left' ? right : left;
    if (nextId === current) return;
    if (nextId === other) {
      onCompareChange?.(side === 'left' ? [nextId, current] : [current, nextId]);
      return;
    }
    onCompareChange?.(side === 'left' ? [nextId, right] : [left, nextId]);
  };

  return (
    <section className="template-gallery">
      <div className="template-intro">
        <div>
          <h3>实时小程序预览</h3>
          <p>点选骨架会立刻按模板结构与配色重新渲染，下方可以切换首页、菜单和订单。</p>
        </div>
        {compareEnabled && ids.length > 1 ? (
          <button
            type="button"
            className={`template-compare-toggle${activeCompare ? ' is-active' : ''}`}
            onClick={handleToggleCompare}
          >
            <GitCompareArrows size={15} />
            {activeCompare ? '退出对比' : '并排对比'}
          </button>
        ) : null}
      </div>

      <div className="template-grid">
        {list.map((item) => {
          const isSelected = item.id === selectedId;
          const cardClass = `template-card${isSelected ? ' is-selected' : ''}`;
          const recipeName = viewModelsByTemplateId[item.id] && viewModelsByTemplateId[item.id].recipe
            ? viewModelsByTemplateId[item.id].recipe.displayName
            : null;
          return (
            <button
              type="button"
              key={item.id}
              className={cardClass}
              onClick={() => onSelect?.(item.id)}
            >
              <div className="template-visual">
                {item.badge ? <span className="template-badge">{item.badge}</span> : null}
                <MiniProgramPreview
                  viewModel={viewModelsByTemplateId[item.id]}
                  size="compact"
                />
              </div>
              <div className="template-body">
                <div className="template-head">
                  <h3>{item.name}</h3>
                  {isSelected ? (
                    <span className="template-check">
                      <Check size={14} />
                    </span>
                  ) : null}
                </div>
                {item.summary ? <p className="template-summary">{item.summary}</p> : null}
                <div className="template-meta">
                  {item.source ? <span className="template-source">{item.source}</span> : null}
                  {recipeName ? <span className="template-recipe">{recipeName}</span> : null}
                  {typeof item.score === 'number' ? (
                    <span className="template-score">{Math.round(item.score)}%</span>
                  ) : null}
                  {item.customized ? <span className="template-customized">已定制</span> : null}
                  {item.briefHits > 0 ? (
                    <span className="template-brief">描述命中 {item.briefHits}</span>
                  ) : null}
                </div>
                {item.note ? <p className="template-note">{item.note}</p> : null}
              </div>
            </button>
          );
        })}
      </div>

      {selected && activeCompare ? (
        <TemplateCompare
          viewModelsByTemplateId={viewModelsByTemplateId}
          leftId={activeCompare[0]}
          rightId={activeCompare[1]}
          candidates={list}
          onChangeLeft={(id) => handleCompareSideChange('left', id)}
          onChangeRight={(id) => handleCompareSideChange('right', id)}
          onClose={() => onCompareChange?.(null)}
        />
      ) : null}

      {selected ? (
        <div className={`template-detail${activeCompare ? ' is-comparing' : ''}`}>
          {/* 对比模式已占用 2 个 full 预览，当前选中预览必须让位，避免同屏 3 个。 */}
          {activeCompare ? null : (
            <div className="template-detail-preview">
              <MiniProgramPreview
                viewModel={viewModelsByTemplateId[selected.id]}
                size="full"
              />
            </div>
          )}
          <div className="template-detail-info">
            <span className="template-detail-kicker">当前选中</span>
            <h3>{selected.name}</h3>
            <p>{selected.summary}</p>
            <div className="template-detail-meta">
              {selected.source ? <span>{selected.source}</span> : null}
              {selectedRecipe ? <span>{selectedRecipe}</span> : null}
              {typeof selected.score === 'number' ? <b>{Math.round(selected.score)}%</b> : null}
            </div>
            <p className="template-detail-hint">预览可点按手机底部标签，切换首页 / 菜单 / 订单。</p>

            <form
              className={`template-refine${refining ? ' is-busy' : ''}`}
              onSubmit={handleRefineSubmit}
            >
              <div className="template-refine-head">
                <span className="template-refine-title">{TEMPLATE_REFINE.title}</span>
                <span className="template-refine-caption">
                  {refining ? '正在按你的描述重新排骨架…' : TEMPLATE_REFINE.caption}
                </span>
              </div>
              <div className="template-refine-form">
                <input
                  className="template-refine-input"
                  type="text"
                  value={refineText}
                  disabled={refining}
                  maxLength={TEMPLATE_REFINE.maxLength}
                  placeholder={TEMPLATE_REFINE.placeholder}
                  onChange={(event) => onRefineChange?.(event.target.value)}
                />
                <button
                  type="submit"
                  className="template-refine-button"
                  disabled={!canSubmit}
                >
                  {refining ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
                  {refining ? '重新匹配中' : TEMPLATE_REFINE.action}
                </button>
              </div>
              {refineError ? (
                <p className="template-refine-error" role="alert">{refineError.message || refineError}</p>
              ) : null}
            </form>

            {reviseEnabled ? (
              <TemplateRevisePanel
                presentation={presentation}
                templateName={selected.name}
                onRevise={onRevise}
                onClearError={onClearReviseError}
                mock={mockBadge}
              />
            ) : null}

            <SatisfactionPrompt
              question={SATISFACTION.question}
              action={SATISFACTION.action}
              onConfirm={onConfirm}
              disabled={!selectedId || refining}
            />
          </div>
        </div>
      ) : null}
    </section>
  );
}