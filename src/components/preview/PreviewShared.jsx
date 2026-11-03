import { ClipboardList, House, Store, Utensils } from 'lucide-react';

const TAB_ICONS = Object.freeze({
  home: House,
  menu: Utensils,
  orders: ClipboardList,
  mine: Store,
});

export function PreviewIcon({ icon, size }) {
  const Icon = TAB_ICONS[icon];
  return Icon ? <Icon size={size} aria-hidden="true" /> : null;
}

/**
 * 门店头部。
 *
 * `store.tagline` 来自 Plan 的 `storeProfile.notes`（展示补丁 copy.tagline 由状态机写入），
 * 有值时才多渲染一行，且排在原有 subtitle 之后，不挤占或替换现有信息。
 * 两个新 props（tagline/heightPx/thumbPx）都是可选的，缺省渲染与改动前一致。
 */
export function StoreHeader({ store, theme, compact = false }) {
  const tagline = typeof store.tagline === 'string' ? store.tagline.trim() : '';

  return (
    <header className={compact ? 'mini-compact-head' : 'mini-phone-head'}>
      <span
        className={compact ? 'mini-compact-logo' : 'mini-phone-logo'}
        style={{ background: theme.primaryColor }}
      >
        {store.initial}
      </span>
      <div>
        <b>{store.name}</b>
        <small>{store.subtitle}</small>
        {tagline ? (
          <small className={compact ? 'mini-compact-tagline' : 'mini-tagline'}>{tagline}</small>
        ) : null}
      </div>
      <span className={compact ? 'mini-compact-dots' : 'mini-phone-dots'}>•••</span>
    </header>
  );
}

/**
 * 默认首屏 hero。
 * `heightPx` 为 `preview-size-tokens.v1` 的 homeHero px 档位；缺省时沿用样式表默认高度。
 */
export function HeroBanner({ hero, theme, compact = false, heightPx = null }) {
  const style = {
    background: `linear-gradient(135deg, ${theme.primaryColor}, ${theme.accentColor})`,
    ...(Number.isFinite(heightPx) && heightPx > 0 ? { minHeight: `${heightPx}px` } : {}),
  };

  return (
    <div className={compact ? 'mini-compact-hero' : 'mini-hero'} style={style}>
      <small>{hero.kicker}</small>
      <b>{hero.title}</b>
      <span
        className={compact ? 'mini-compact-cta' : 'mini-hero-cta'}
        style={{ background: theme.pageBackground, color: theme.primaryColor }}
      >
        {hero.cta}
      </span>
    </div>
  );
}

/**
 * 完整预览的商品卡。
 * `thumbPx` 为 productCard px 档位；缺省沿用样式表默认高度。
 */
export function ProductCard({ product, theme, thumbPx = null }) {
  return (
    <div className="mini-product">
      <span
        className="mini-product-thumb"
        style={{
          background: `linear-gradient(135deg, ${theme.primaryColor}55, ${theme.accentColor}88)`,
          ...(Number.isFinite(thumbPx) && thumbPx > 0 ? { height: `${thumbPx}px` } : {}),
        }}
      />
      <div className="mini-product-copy">
        <b>{product.name}</b>
        <small>{product.note}</small>
      </div>
      <span className="mini-product-price">¥{product.priceDisplay}</span>
    </div>
  );
}

/** 紧凑缩略卡保持既有视觉，不消费尺寸档位（缩略图尺寸远小于真机档位）。 */
export function CompactProduct({ product, theme }) {
  return (
    <div className="mini-compact-product">
      <span
        className="mini-compact-thumb"
        style={{
          background: `linear-gradient(135deg, ${theme.primaryColor}55, ${theme.accentColor}88)`,
        }}
      />
      <span className="mini-compact-copy">
        <b>{product.name}</b>
        <small>¥{product.priceDisplay}</small>
      </span>
    </div>
  );
}