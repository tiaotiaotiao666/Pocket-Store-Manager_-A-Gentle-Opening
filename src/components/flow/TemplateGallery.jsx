import { Check, GitCompareArrows } from 'lucide-react';
import SatisfactionPrompt from './SatisfactionPrompt.jsx';
import TemplateCompare from './TemplateCompare.jsx';
import TemplateRevisePanel from './TemplateRevisePanel.jsx';
import MiniProgramPreview from '../preview/MiniProgramPreview.jsx';
import PreviewLaunchButton from '../preview/PreviewLaunchButton.jsx';
import { describeTemplateReviseTransport } from '../../services/agentTurn/templateReviseService.js';
import { describeStructureCoverage, describeTemplateStructure } from '../../domain/templateGroups.mjs';
import { SATISFACTION } from '../../domain/onboardingScript.mjs';

/**
 * 模板页（`C-TEMPLATE-GALLERY@1`，plan.md 2.2.5）。
 *
 * 现有 props 与行为全部保留：
 * - 3 张候选卡始终展示、可切换；
 * - 「实时预览」只消费 `viewModelsByTemplateId[selectedId]`；
 * - B3：「修改当前页面」与「重新匹配候选」合并成**一个**输入框 + 模式开关（见 TemplateRevisePanel），
 *   不再各摆一个输入框；`onRefine` 仍由父组件负责派发。
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
  onRefine,
  refining = false,
  refineError = null,
  // —— 以下为新增可选 props ——
  presentation = null,
  onRevise,
  onClearReviseError,
  canUndo = false,
  onUndo,
  compareIds = null,
  onCompareChange,
  mockRevise = null,
  previewProjectPath = null,
  onPrepareProject = null,
  // P2：每张卡的状态（当前使用 / 候选模板 / 已采用 / 已放弃），由 App 用领域函数算好传进来。
  statusById = {},
  statusHint = null,
}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const selected = list.find((item) => item.id === selectedId) ?? list[0];
  const selectedRecipe = selected && viewModelsByTemplateId[selected.id] && viewModelsByTemplateId[selected.id].recipe
    ? viewModelsByTemplateId[selected.id].recipe.displayName
    : null;

  const ids = list.map((item) => item.id);
  const compareEnabled = typeof onCompareChange === 'function';
  const activeCompare = (() => {
    if (!Array.isArray(compareIds) || compareIds.length !== 2) return null;
    const [left, right] = compareIds;
    if (left === right || !ids.includes(left) || !ids.includes(right)) return null;
    return [left, right];
  })();
  const reviseEnabled = typeof onRevise === 'function' || presentation != null;
  // B4 规则 1：模板页先说明「真实独立结构有几套」，同一结构的候选只算配色方案。
  const coverage = describeStructureCoverage(ids);
  // 显式传布尔值时尊重父组件；未传时按当前 transport 模式自动标注，
  // 避免 T14 忘记传 prop 时把本地 Mock 结果说成真实模型成功。
  const mockBadge = typeof mockRevise === 'boolean'
    ? mockRevise
    : (reviseEnabled ? describeTemplateReviseTransport().mock : false);


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
          {/* B4 规则 1：先讲清真实结构有几套，避免把同一结构的两种配色当成两套骨架。 */}
          <p className="template-structure-hint">{coverage.text}</p>
          {statusHint ? <p className="template-intro-hint">{statusHint}</p> : null}
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
          const status = statusById[item.id] ?? null;
          const cardClass = `template-card${isSelected ? ' is-selected' : ''}${status ? ` is-${status.tone}` : ''}`;
          const recipeName = viewModelsByTemplateId[item.id] && viewModelsByTemplateId[item.id].recipe
            ? viewModelsByTemplateId[item.id].recipe.displayName
            : null;
          const structure = describeTemplateStructure(item.id);
          return (
            <button
              type="button"
              key={item.id}
              className={cardClass}
              onClick={() => onSelect?.(item.id)}
              aria-current={status && status.isCurrent ? 'true' : undefined}
            >
              <div className="template-visual">
                {item.badge ? <span className="template-badge">{item.badge}</span> : null}
                {status ? (
                  <span className={`template-status is-${status.tone}`}>{status.label}</span>
                ) : null}
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
                  {status && status.referenceTag ? (
                    <span className="template-source is-reference">{status.referenceTag}</span>
                  ) : null}
                  {item.source ? <span className="template-source">{item.source}</span> : null}
                  {recipeName ? (
                    <span className="template-recipe" title={structure.note}>
                      {structure.badge || recipeName}
                    </span>
                  ) : null}
                  {/* B3：不再展示裸百分比（分数是本地覆盖率估算，不是概率）。 */}
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
              <PreviewLaunchButton
                projectPath={previewProjectPath}
                viewModel={viewModelsByTemplateId[selected.id]}
                templateName={selected.name}
                onPrepareProject={onPrepareProject}
              />
            </div>
          )}
          <div className="template-detail-info">
            <span className="template-detail-kicker">
              {statusById[selected.id] ? statusById[selected.id].label : '当前选中'}
            </span>
            <h3>{selected.name}</h3>
            {statusById[selected.id] ? (
              <p className="template-detail-status">{statusById[selected.id].note}</p>
            ) : (selected.summary ? <p>{selected.summary}</p> : null)}
            <div className="template-detail-meta">
              {selected.source ? <span>{selected.source}</span> : null}
              {selectedRecipe ? <span>{selectedRecipe}</span> : null}
              {/* 详情区同样不展示裸百分比，改用上面的推荐理由与描述。 */}
            </div>
            <p className="template-detail-hint">预览可点按手机底部标签，切换首页 / 菜单 / 订单。</p>

            {/* 唯一主输入框：模式开关区分「修改当前页面」与「重新匹配候选」，不再各摆一个输入框。 */}
            {reviseEnabled ? (
              <TemplateRevisePanel
                presentation={presentation}
                templateName={selected.name}
                canRevise={!refining && Boolean(selected)}
                disabled={refining}
                refining={refining}
                refineError={refineError}
                canUndo={canUndo}
                onRevise={onRevise}
                onRefine={onRefine}
                onUndo={onUndo}
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