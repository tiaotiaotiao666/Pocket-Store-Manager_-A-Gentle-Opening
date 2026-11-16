import { Check, Clock } from 'lucide-react';
import { HeroBanner, ProductCard } from './PreviewShared.jsx';
import PosterCarouselBlock from './PosterCarouselBlock.jsx';

/**
 * 首页 hero 槽位查找的本地实现，避免 PreviewTabs → MiniProgramPreview → PreviewTabs 的循环依赖。
 *
 * 页面归属以 ViewModel 的 `block.pageId` 为准（旧 Plan 的块没有 pageId，按 home-hero 语义回落首页）。
 */
function findHeroBlock(blocks, pageId = 'home') {
  return (Array.isArray(blocks) ? blocks : []).find((block) => (
    block
    && block.slotId === 'home-hero'
    && (block.pageId || 'home') === pageId
  )) || null;
}

function findPageBlocks(blocks, pageId) {
  return (Array.isArray(blocks) ? blocks : []).filter((block) => (
    block && typeof block === 'object' && (block.pageId || 'home') === pageId
  ));
}

/**
 * 菜单页的 Plan 区块。未登记的块由 ViewModel 过滤，这里只需要按类型渲染，
 * 不认识就返回 null，避免在菜单页留下空容器。
 */
function MenuPlanBlock({ block }) {
  if (block.id === 'poster-carousel') {
    return <PosterCarouselBlock block={block} interactive />;
  }
  return null;
}

/**
 * P2：分类条。
 *
 * 数据来自 ViewModel 的 `categories`：真实菜品带分类就用真实的，
 * 演示状态用演示分类（`demo:true`）。这里只做呈现，不发明分类。
 */
function CategoryStrip({ categories, theme }) {
  const list = Array.isArray(categories) ? categories : [];
  if (list.length === 0) return null;
  return (
    <div className="mini-categories" aria-label="菜品分类">
      {list.map((item, index) => (
        <span
          key={item.key}
          className={`mini-category${index === 0 ? ' is-active' : ''}`}
          style={index === 0 ? { background: `${theme.primaryColor}1a`, color: theme.primaryColor } : undefined}
        >
          {item.label}
          <small>{item.count}</small>
        </span>
      ))}
    </div>
  );
}

/** P2：下单入口。始终标注演示状态，不暗示真实支付可用。 */
function OrderCta({ cta, theme }) {
  if (!cta) return null;
  return (
    <div className="mini-order-cta">
      <div className="mini-order-cta-copy">
        <b>{cta.order}</b>
        <small>{cta.demoNotice}</small>
      </div>
      <span className="mini-order-cta-button" style={{ background: theme.primaryColor }}>
        {cta.checkout}
      </span>
    </div>
  );
}

function HomeTab({ viewModel }) {
  const { layout, theme, hero, products, blocks, sizes, categories, cta } = viewModel;
  const count = layout === 'catalog' ? 3 : 4;
  const heroBlock = findHeroBlock(blocks, 'home');

  return (
    <>
      {heroBlock
        ? <PosterCarouselBlock block={heroBlock} interactive />
        : <HeroBanner hero={hero} theme={theme} heightPx={sizes?.homeHeroPx} />}
      <CategoryStrip categories={categories} theme={theme} />
      <div className="mini-sec">
        <b>{hero.sectionTitle}</b>
        <span>查看全部</span>
      </div>
      <div className={`mini-products is-${layout}`}>
        {products.slice(0, count).map((product) => (
          <ProductCard key={product.key} product={product} theme={theme} thumbPx={sizes?.productCardPx} />
        ))}
      </div>
      {hero.story ? <p className="mini-story">{hero.story}</p> : null}
      <OrderCta cta={cta} theme={theme} />
    </>
  );
}

function MenuTab({ viewModel }) {
  const { layout, theme, products, menuCountText, blocks, sizes, categories, cta } = viewModel;
  const menuBlocks = findPageBlocks(blocks, 'menu');

  return (
    <>
      {menuBlocks.map((block) => (
        <MenuPlanBlock key={`${block.id}:${block.slotId}:${block.dataKey}`} block={block} />
      ))}
      <CategoryStrip categories={categories} theme={theme} />
      <div className="mini-sec">
        <b>全部菜单</b>
        <span>{menuCountText}</span>
      </div>
      <div className={`mini-products is-${layout === 'catalog' ? 'catalog' : 'menu'}`}>
        {products.map((product) => (
          <ProductCard key={product.key} product={product} theme={theme} thumbPx={sizes?.productCardPx} />
        ))}
      </div>
      <OrderCta cta={cta} theme={theme} />
    </>
  );
}

function OrdersTab({ viewModel }) {
  const { theme, order } = viewModel;

  return (
    <>
      <div className="mini-order-head">
        <div>
          <b>{order.number}</b>
          <small>{order.context}</small>
        </div>
        <span
          className="mini-order-state"
          style={{ background: `${theme.primaryColor}1f`, color: theme.primaryColor }}
        >
          {order.status}
        </span>
      </div>
      <div className="mini-order-steps">
        {order.steps.map((step) => {
          const done = step.state === 'done' || step.state === 'current';
          const current = step.state === 'current';
          return (
            <div
              className={`mini-order-step${done ? ' is-done' : ''}${current ? ' is-current' : ''}`}
              key={step.key}
            >
              <span
                className="mini-order-dot"
                style={done ? { background: theme.primaryColor } : undefined}
              >
                {done ? <Check size={8} /> : null}
              </span>
              <span>{step.label}</span>
            </div>
          );
        })}
      </div>
      <p className="mini-order-note"><Clock size={10} /> {order.estimate}</p>
    </>
  );
}

function MineTab({ viewModel }) {
  const { theme, store, capabilities } = viewModel;
  const exportedCount = capabilities.filter((capability) => capability.exported).length;
  const summary = exportedCount === capabilities.length
    ? `${capabilities.length} 项均随模板导出`
    : `${exportedCount}/${capabilities.length} 项随模板导出`;

  return (
    <>
      <div className="mini-mine-card" style={{ background: `${theme.primaryColor}12` }}>
        <b>门店资料</b>
        <small>{store.businessHoursText}</small>
        <small>地址与联系方式可在「我的」中查看</small>
      </div>
      <div className="mini-sec"><b>能力与导出状态</b><span>{summary}</span></div>
      <div className="mini-chips">
        {capabilities.map((capability) => (
          <span
            className="mini-chip"
            key={capability.key}
            style={{
              borderColor: `${theme.primaryColor}33`,
              color: capability.exported ? theme.primaryColor : undefined,
              opacity: capability.exported ? 1 : 0.55,
            }}
          >
            {capability.label}{capability.exported ? '' : ' · 未导出'}
          </span>
        ))}
      </div>
    </>
  );
}

export function PreviewTabContent({ tab, viewModel }) {
  switch (tab) {
    case 'home':
      return <HomeTab viewModel={viewModel} />;
    case 'menu':
      return <MenuTab viewModel={viewModel} />;
    case 'orders':
      return <OrdersTab viewModel={viewModel} />;
    case 'mine':
      return <MineTab viewModel={viewModel} />;
    default:
      return null;
  }
}