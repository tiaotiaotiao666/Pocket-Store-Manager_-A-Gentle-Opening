import { Check } from 'lucide-react';
import SatisfactionPrompt from './SatisfactionPrompt.jsx';
import MiniProgramPreview from '../preview/MiniProgramPreview.jsx';
import { SATISFACTION } from '../../domain/onboardingScript.mjs';

export default function TemplateGallery({
  candidates = [],
  selectedId = null,
  onSelect,
  onConfirm,
  theme,
  storeName = '我的餐馆',
  features = [],
}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const selected = list.find((item) => item.id === selectedId) ?? list[0];

  return (
    <section className="template-gallery">
      <div className="template-intro">
        <div>
          <h3>实时小程序预览</h3>
          <p>点选骨架会立刻按模板结构与配色重新渲染，下方可以切换首页、菜单和订单。</p>
        </div>
      </div>

      <div className="template-grid">
        {list.map((item) => {
          const isSelected = item.id === selectedId;
          const cardClass = `template-card${isSelected ? ' is-selected' : ''}`;
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
                  template={item}
                  theme={theme}
                  storeName={storeName}
                  features={features}
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
                  {typeof item.score === 'number' ? (
                    <span className="template-score">{Math.round(item.score)}%</span>
                  ) : null}
                  {item.customized ? <span className="template-customized">已定制</span> : null}
                </div>
                {item.note ? <p className="template-note">{item.note}</p> : null}
              </div>
            </button>
          );
        })}
      </div>

      {selected ? (
        <div className="template-detail">
          <div className="template-detail-preview">
            <MiniProgramPreview
              template={selected}
              theme={theme}
              storeName={storeName}
              features={features}
              size="full"
            />
          </div>
          <div className="template-detail-info">
            <span className="template-detail-kicker">当前选中</span>
            <h3>{selected.name}</h3>
            <p>{selected.summary}</p>
            <div className="template-detail-meta">
              {selected.source ? <span>{selected.source}</span> : null}
              {typeof selected.score === 'number' ? <b>{Math.round(selected.score)}%</b> : null}
            </div>
            <p className="template-detail-hint">预览可点按手机底部标签，切换首页 / 菜单 / 订单。</p>
            <SatisfactionPrompt
              question={SATISFACTION.question}
              action={SATISFACTION.action}
              onConfirm={onConfirm}
              disabled={!selectedId}
            />
          </div>
        </div>
      ) : null}
    </section>
  );
}