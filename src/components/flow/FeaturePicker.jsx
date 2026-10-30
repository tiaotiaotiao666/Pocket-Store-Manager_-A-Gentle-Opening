import { Check, Plus } from 'lucide-react';

export default function FeaturePicker({
  groups = [],
  features = [],
  selectedIds = [],
  requiredIds = [],
  onToggle,
  custom = '',
  onCustomChange,
  onCustomize,
  busy = false,
}) {
  const selected = new Set(selectedIds);
  const required = new Set(requiredIds);

  const handleToggle = (id, isRequired) => {
    if (busy || isRequired) return;
    onToggle?.(id);
  };

  const handleCustomize = () => {
    if (busy) return;
    onCustomize?.(custom);
  };

  return (
    <section className="feature-picker">
      <div className="feature-groups">
        {groups.map((group) => {
          const groupFeatures = features.filter((feature) => feature.group === group);
          if (!groupFeatures.length) return null;
          const hasRequired = groupFeatures.some((feature) => required.has(feature.id));
          return (
            <div className="feature-group" key={group}>
              <div className="feature-group-head">
                <h3>{group}</h3>
                {hasRequired ? <span className="feature-group-tag">基础能力</span> : null}
              </div>
              <div className="feature-grid">
                {groupFeatures.map((feature) => {
                  const isRequired = required.has(feature.id);
                  const isSelected = isRequired || selected.has(feature.id);
                  const cardClass = [
                    'feature-card',
                    isSelected ? 'is-selected' : '',
                    isRequired ? 'is-required' : '',
                  ].filter(Boolean).join(' ');
                  return (
                    <button
                      type="button"
                      key={feature.id}
                      className={cardClass}
                      disabled={busy || isRequired}
                      onClick={() => handleToggle(feature.id, isRequired)}
                    >
                      <span className="feature-card-check">
                        {isSelected ? <Check size={14} /> : null}
                      </span>
                      <span className="feature-card-body">
                        <span className="feature-card-title">
                          <b>{feature.label}</b>
                          <em className={isRequired ? 'feature-flag-required' : 'feature-flag-optional'}>
                            {isRequired ? '必选' : '可选'}
                          </em>
                        </span>
                        <span className="feature-card-desc">{feature.description}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <div className="feature-customize">
        <input
          className="feature-customize-input"
          type="text"
          value={custom}
          disabled={busy}
          placeholder="没有想要的功能？在这里补充你的定制需求…"
          onChange={(event) => onCustomChange?.(event.target.value)}
        />
        <button
          type="button"
          className="feature-customize-button"
          disabled={busy}
          onClick={handleCustomize}
        >
          <Plus size={16} />
          加入定制能力
        </button>
      </div>
    </section>
  );
}