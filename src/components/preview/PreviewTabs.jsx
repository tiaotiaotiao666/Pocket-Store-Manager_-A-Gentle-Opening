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

function HomeTab({ viewModel }) {
  const { layout, theme, hero, products, blocks, sizes } = viewModel;
  const count = layout === 'catalog' ? 3 : 4;
  const heroBlock = findHeroBlock(blocks, 'home');

  return (
    <>
      {heroBlock
        ? <PosterCarouselBlock block={heroBlock} interactive />
        : <HeroBanner hero={hero} theme={theme} heightPx={sizes?.homeHeroPx} />}
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
    </>
  );
}

function MenuTab({ viewModel }) {
  const { layout, theme, products, menuCountText, blocks, sizes } = viewModel;
  const menuBlocks = findPageBlocks(blocks, 'menu');

  return (
    <>
      {menuBlocks.map((block) => (
        <MenuPlanBlock key={`${block.id}:${block.slotId}:${block.dataKey}`} block={block} />
      ))}
      <div className="mini-sec">
        <b>全部菜单</b>
        <span>{menuCountText}</span>
      </div>
      <div className={`mini-products is-${layout === 'catalog' ? 'catalog' : 'menu'}`}>
        {products.map((product) => (
          <ProductCard key={product.key} product={product} theme={theme} thumbPx={sizes?.productCardPx} />
        ))}
      </div>
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

  return (
    <>
      <div className="mini-mine-card" style={{ background: `${theme.primaryColor}12` }}>
        <b>门店资料</b>
        <small>{store.businessHoursText}</small>
        <small>地址与联系方式可在「我的」中查看</small>
      </div>
      <div className="mini-sec"><b>已启用的能力</b><span>{capabilities.length} 项</span></div>
      <div className="mini-chips">
        {capabilities.map((capability) => (
          <span
            className="mini-chip"
            key={capability.key}
            style={{ borderColor: `${theme.primaryColor}33`, color: theme.primaryColor }}
          >
            {capability.label}
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