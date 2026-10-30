import {
  CheckCircle2,
  CircleAlert,
  Image as ImageIcon,
  ListChecks,
  Palette,
  Rocket,
  Sparkles,
  Store,
} from 'lucide-react';

const ICON_MAP = {
  sparkles: Sparkles,
  store: Store,
  palette: Palette,
  image: ImageIcon,
  rocket: Rocket,
  list: ListChecks,
  check: CheckCircle2,
  alert: CircleAlert,
};

export default function RightPanel({ meta = {}, cards = [] }) {
  return (
    <div className="panel">
      <header className="panel-head">
        <span className="panel-eyebrow">上下文</span>
        <h2 className="panel-title">{meta.label ?? '轻启'}</h2>
        {meta.caption ? <p className="panel-caption">{meta.caption}</p> : null}
      </header>

      <div className="panel-cards">
        {cards.map((card) => {
          const Icon = ICON_MAP[card.icon] ?? Sparkles;
          const className = ['panel-card', card.tone ? `is-${card.tone}` : '']
            .filter(Boolean)
            .join(' ');
          return (
            <article className={className} key={card.id}>
              <div className="panel-card-head">
                <span className="panel-card-icon">
                  <Icon size={14} />
                </span>
                <h3 className="panel-card-title">{card.title}</h3>
              </div>
              {card.body ? <p className="panel-card-body">{card.body}</p> : null}
              {Array.isArray(card.items) && card.items.length ? (
                <ul className="panel-card-items">
                  {card.items.map((item, index) => (
                    <li key={`${card.id}-${index}`}>{item}</li>
                  ))}
                </ul>
              ) : null}
              {card.image ? (
                <img className="panel-card-image" src={card.image} alt={card.title} />
              ) : null}
              {card.node ? <div className="panel-card-node">{card.node}</div> : null}
            </article>
          );
        })}
      </div>
    </div>
  );
}