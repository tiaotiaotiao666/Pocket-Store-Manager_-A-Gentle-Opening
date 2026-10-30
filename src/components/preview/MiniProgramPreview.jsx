import { useState } from 'react';
import { Check, ClipboardList, Clock, House, Store, Utensils } from 'lucide-react';
import { features as catalogFeatures } from '../../domain/catalog.mjs';

const PRODUCTS = [
  { name: '门店招牌饭', note: '现点现做', price: 28 },
  { name: '时令小食拼盘', note: '清爽分享', price: 16 },
  { name: '自选鲜泡茶', note: '每日现泡', price: 10 },
  { name: '今日限定', note: '售完即止', price: 22 },
];

const TABS = [
  { id: 'home', label: '首页', icon: House },
  { id: 'menu', label: '菜单', icon: Utensils },
  { id: 'orders', label: '订单', icon: ClipboardList },
  { id: 'mine', label: '我的', icon: Store },
];

const ORDER_STEPS = ['已下单', '制作中', '可取餐'];

function heroCopy(layout) {
  if (layout === 'catalog') return { kicker: '今日新鲜出炉', title: '从一杯开始', cta: '开始点餐' };
  if (layout === 'editorial') return { kicker: '今日主厨推荐', title: '一道招牌，记住这家店', cta: '看看招牌' };
  return { kicker: '今日菜单已准备好', title: '从一份招牌开始', cta: '开始点餐' };
}

function labelOf(id) {
  return catalogFeatures.find((item) => item.id === id)?.label ?? id;
}

function ProductCard({ product, layout, primary, accent }) {
  return (
    <div className="mini-product">
      <span
        className="mini-product-thumb"
        style={{ background: `linear-gradient(135deg, ${primary}55, ${accent}88)` }}
      />
      <div className="mini-product-copy">
        <b>{product.name}</b>
        <small>{product.note}</small>
      </div>
      <span className="mini-product-price">¥{product.price}</span>
    </div>
  );
}

function HomeTab({ layout, hero, bg, primary, accent }) {
  const count = layout === 'catalog' ? 3 : 4;
  return (
    <>
      <div className="mini-hero" style={{ background: `linear-gradient(135deg, ${primary}, ${accent})` }}>
        <small>{hero.kicker}</small>
        <b>{hero.title}</b>
        <span className="mini-hero-cta" style={{ background: bg, color: primary }}>{hero.cta}</span>
      </div>
      <div className="mini-sec">
        <b>{layout === 'menu' ? '本店推荐' : layout === 'catalog' ? '今日精选' : '主厨故事'}</b>
        <span>查看全部</span>
      </div>
      <div className={`mini-products is-${layout}`}>
        {PRODUCTS.slice(0, count).map((product) => (
          <ProductCard key={product.name} product={product} layout={layout} primary={primary} accent={accent} />
        ))}
      </div>
      {layout === 'editorial' ? (
        <p className="mini-story">从清晨备料到晚间收档，这家店只做当天的新鲜。</p>
      ) : null}
    </>
  );
}

function MenuTab({ layout, primary, accent }) {
  return (
    <>
      <div className="mini-sec">
        <b>全部菜单</b>
        <span>共 4 道</span>
      </div>
      <div className={`mini-products is-${layout === 'catalog' ? 'catalog' : 'menu'}`}>
        {PRODUCTS.map((product) => (
          <ProductCard key={product.name} product={product} layout={layout} primary={primary} accent={accent} />
        ))}
      </div>
    </>
  );
}

function OrdersTab({ primary }) {
  return (
    <>
      <div className="mini-order-head">
        <div>
          <b>订单 #20261031</b>
          <small>堂食 · 3 号桌</small>
        </div>
        <span className="mini-order-state" style={{ background: `${primary}1f`, color: primary }}>制作中</span>
      </div>
      <div className="mini-order-steps">
        {ORDER_STEPS.map((label, index) => {
          const done = index < 2;
          const current = index === 1;
          return (
            <div className={`mini-order-step${done ? ' is-done' : ''}${current ? ' is-current' : ''}`} key={label}>
              <span className="mini-order-dot" style={done ? { background: primary } : undefined}>
                {done ? <Check size={8} /> : null}
              </span>
              <span>{label}</span>
            </div>
          );
        })}
      </div>
      <p className="mini-order-note"><Clock size={10} /> 预计 20 分钟后可取餐</p>
    </>
  );
}

function MineTab({ features, primary }) {
  const chips = (Array.isArray(features) ? features : []).slice(0, 4);
  return (
    <>
      <div className="mini-mine-card" style={{ background: `${primary}12` }}>
        <b>门店资料</b>
        <small>营业时间 10:00 - 22:00</small>
        <small>地址与联系方式可在「我的」中查看</small>
      </div>
      <div className="mini-sec"><b>已启用的能力</b><span>{chips.length} 项</span></div>
      <div className="mini-chips">
        {chips.map((id) => (
          <span className="mini-chip" key={id} style={{ borderColor: `${primary}33`, color: primary }}>{labelOf(id)}</span>
        ))}
      </div>
    </>
  );
}

export default function MiniProgramPreview({
  template,
  theme,
  storeName = '我的餐馆',
  features = [],
  size = 'full',
}) {
  const [tab, setTab] = useState('home');
  const colors = theme?.colors ?? ['#FAF7F1', '#E78A35', '#286957', '#29332F'];
  const [bg, primary, accent, ink] = colors;
  const layout = template?.layout ?? 'menu';
  const hero = heroCopy(layout);
  const has = (id) => Array.isArray(features) && features.includes(id);
  const initial = String(storeName || '店').slice(0, 1);

  if (size === 'compact') {
    return (
      <div className="mini-preview mini-preview-compact" style={{ background: bg, color: ink }}>
        <div className="mini-compact-head">
          <span className="mini-compact-logo" style={{ background: primary }}>{initial}</span>
          <div>
            <b>{storeName}</b>
            <small>{has('table-dining') ? '堂食 · 扫码点餐' : has('takeaway') ? '到店自取' : '营业中'}</small>
          </div>
          <span className="mini-compact-dots">•••</span>
        </div>
        <div className="mini-compact-hero" style={{ background: `linear-gradient(135deg, ${primary}, ${accent})` }}>
          <small>{hero.kicker}</small>
          <b>{hero.title}</b>
          <span className="mini-compact-cta" style={{ background: bg, color: primary }}>{hero.cta}</span>
        </div>
        <div className={`mini-compact-products is-${layout}`}>
          {PRODUCTS.slice(0, layout === 'catalog' ? 3 : 2).map((product) => (
            <div className="mini-compact-product" key={product.name}>
              <span
                className="mini-compact-thumb"
                style={{ background: `linear-gradient(135deg, ${primary}55, ${accent}88)` }}
              />
              <span className="mini-compact-copy">
                <b>{product.name}</b>
                <small>¥{product.price}</small>
              </span>
            </div>
          ))}
        </div>
        <div className="mini-compact-tabs" style={{ borderColor: `${ink}18` }}>
          {TABS.map((item) => {
            const Icon = item.icon;
            return (
              <span className="mini-compact-tab" key={item.id}>
                <Icon size={9} />
                {item.label}
              </span>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="mini-preview mini-preview-full">
      <div className="mini-phone">
        <div className="mini-phone-notch" />
        <div className="mini-phone-screen" style={{ background: bg, color: ink }}>
          <div className="mini-phone-status">
            <span>9:41</span>
            <span>▮▮▮ ◉</span>
          </div>
          <header className="mini-phone-head">
            <span className="mini-phone-logo" style={{ background: primary }}>{initial}</span>
            <div>
              <b>{storeName}</b>
              <small>{has('table-dining') ? '堂食 · 扫码点餐' : has('takeaway') ? '到店自取 · 营业中' : '营业中'}</small>
            </div>
            <span className="mini-phone-dots">•••</span>
          </header>
          <div className="mini-phone-body">
            {tab === 'home' ? <HomeTab layout={layout} hero={hero} bg={bg} primary={primary} accent={accent} /> : null}
            {tab === 'menu' ? <MenuTab layout={layout} primary={primary} accent={accent} /> : null}
            {tab === 'orders' ? <OrdersTab primary={primary} /> : null}
            {tab === 'mine' ? <MineTab features={features} primary={primary} /> : null}
          </div>
          <nav className="mini-phone-tabs" style={{ borderColor: `${ink}18` }}>
            {TABS.map((item) => {
              const Icon = item.icon;
              const active = item.id === tab;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`mini-phone-tab${active ? ' is-active' : ''}`}
                  style={{ color: active ? primary : `${ink}88` }}
                  onClick={() => setTab(item.id)}
                >
                  <Icon size={14} />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>
        </div>
      </div>
    </div>
  );
}