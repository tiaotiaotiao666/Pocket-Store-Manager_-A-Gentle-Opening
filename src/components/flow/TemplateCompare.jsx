/**
 * 模板并排对比（`C-TEMPLATE-GALLERY@1`，plan.md 2.2.5）。
 *
 * 约束：
 * - 最多并排 2 套候选（两侧各一个 `MiniProgramPreview size="full"`）；
 * - 不自己构造展示事实，预览一律使用父组件传入的 `viewModelsByTemplateId`；
 * - 窄窗口下退化为上下堆叠（见 flow.css 的 .template-compare-grid 媒体查询）。
 */

import { X } from 'lucide-react';
import MiniProgramPreview from '../preview/MiniProgramPreview.jsx';

function collectIds(viewModelsByTemplateId, candidates) {
  const fromCandidates = (Array.isArray(candidates) ? candidates : [])
    .map((item) => item?.id)
    .filter((id) => typeof id === 'string' && id);
  const fromViewModels = Object.keys(viewModelsByTemplateId || {});
  return [...new Set([...fromCandidates, ...fromViewModels])];
}

function resolveLabel(id, candidates, viewModelsByTemplateId) {
  const candidate = (Array.isArray(candidates) ? candidates : []).find((item) => item?.id === id);
  if (candidate?.name) return candidate.name;
  const viewModel = viewModelsByTemplateId?.[id];
  if (viewModel?.recipe?.displayName) return viewModel.recipe.displayName;
  if (viewModel?.store?.name) return viewModel.store.name;
  return id;
}

function resolveMeta(id, candidates, viewModelsByTemplateId) {
  const candidate = (Array.isArray(candidates) ? candidates : []).find((item) => item?.id === id);
  const viewModel = viewModelsByTemplateId?.[id];
  return {
    recipe: viewModel?.recipe?.displayName || '',
    score: typeof candidate?.score === 'number' ? Math.round(candidate.score) : null,
    summary: candidate?.summary || '',
  };
}

export default function TemplateCompare({
  viewModelsByTemplateId = {},
  leftId,
  rightId,
  candidates = [],
  onChangeLeft,
  onChangeRight,
  onClose,
}) {
  const ids = collectIds(viewModelsByTemplateId, candidates);
  const safeLeft = ids.includes(leftId) ? leftId : ids[0] ?? leftId;
  const safeRight = ids.includes(rightId) ? rightId : ids.find((id) => id !== safeLeft) ?? ids[0] ?? rightId;

  if (!safeLeft || !safeRight) return null;

  const changeSide = (side, nextId) => {
    if (!nextId) return;
    const currentId = side === 'left' ? safeLeft : safeRight;
    if (nextId === currentId) return;

    // 两侧不允许选同一套模板。选中另一侧已占用的模板时，只回调这一侧，
    // 由父组件（TemplateGallery）把旧值换到另一侧，组件本身不维护第二份对比状态。
    if (side === 'left') onChangeLeft?.(nextId);
    else onChangeRight?.(nextId);
  };

  const renderSide = (side, id, tone) => {
    const label = resolveLabel(id, candidates, viewModelsByTemplateId);
    const meta = resolveMeta(id, candidates, viewModelsByTemplateId);
    return (
      <article className={`template-compare-card is-${tone}`} key={side}>
        <div className="template-compare-toolbar">
          <span className={`template-compare-pill is-${tone}`}>{side === 'left' ? 'A' : 'B'}</span>
          <select
            className="template-compare-select"
            value={id}
            aria-label={side === 'left' ? '选择左侧对比模板' : '选择右侧对比模板'}
            onChange={(event) => changeSide(side, event.target.value)}
          >
            {ids.map((optionId) => (
              <option key={optionId} value={optionId}>
                {resolveLabel(optionId, candidates, viewModelsByTemplateId)}
              </option>
            ))}
          </select>
          {meta.score !== null ? (
            <span className="template-compare-score">{meta.score}%</span>
          ) : null}
        </div>
        <div className="template-compare-title">
          <h4>{label}</h4>
          {meta.recipe ? <span>{meta.recipe}</span> : null}
        </div>
        <div className="template-compare-stage">
          <MiniProgramPreview viewModel={viewModelsByTemplateId[id]} size="full" />
        </div>
        {meta.summary ? <p className="template-compare-summary">{meta.summary}</p> : null}
      </article>
    );
  };

  return (
    <section className="template-compare" aria-label="模板并排对比">
      <header className="template-compare-head">
        <div className="template-compare-heading">
          <span className="template-compare-kicker">并排对比</span>
          <h3>两套模板，同屏看清差异</h3>
          <p>配色、区块顺序和文案会一起呈现；点手机底部标签可切换页面。</p>
        </div>
        {typeof onClose === 'function' ? (
          <button
            type="button"
            className="template-compare-close"
            onClick={onClose}
            aria-label="关闭对比"
          >
            <X size={15} />
            关闭对比
          </button>
        ) : null}
      </header>

      <div className="template-compare-grid">
        {renderSide('left', safeLeft, 'a')}
        {renderSide('right', safeRight, 'b')}
      </div>
    </section>
  );
}