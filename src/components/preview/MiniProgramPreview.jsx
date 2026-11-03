import { useState } from 'react';
import {
  CompactProduct,
  HeroBanner,
  PreviewIcon,
  StoreHeader,
} from './PreviewShared.jsx';
import PosterCarouselBlock from './PosterCarouselBlock.jsx';
import { PreviewTabContent } from './PreviewTabs.jsx';

/**
 * 首页 hero 槽位是否被 Recipe 的某个块占用；占用时用它替换默认 hero。
 * `pageId` 过滤保证落位到菜单 hero 的块不会在首页重复出现。
 */
export function findHeroBlock(blocks, pageId = 'home') {
  return (Array.isArray(blocks) ? blocks : []).find((block) => (
    block
    && block.slotId === 'home-hero'
    && (block.pageId || 'home') === pageId
  )) || null;
}

function CompactPreview({ viewModel }) {
  const { layout, theme, store, hero, products, tabs, blocks } = viewModel;
  const count = layout === 'catalog' ? 3 : 2;
  const heroBlock = findHeroBlock(blocks, 'home');

  return (
    <div
      className="mini-preview mini-preview-compact"
      style={{ background: theme.pageBackground, color: theme.textColor }}
    >
      <StoreHeader store={store} theme={theme} compact />
      <div className="mini-compact-head">
        <small>{store.businessHoursText}</small>
      </div>
      {heroBlock
        ? <PosterCarouselBlock block={heroBlock} compact />
        : <HeroBanner hero={hero} theme={theme} compact />}
      <div className={`mini-compact-products is-${layout}`}>
        {products.slice(0, count).map((product) => (
          <CompactProduct key={product.key} product={product} theme={theme} />
        ))}
      </div>
      <div
        className="mini-compact-tabs"
        style={{
          borderColor: `${theme.textColor}18`,
          background: theme.tabBarBackground,
          color: theme.tabBarColor,
        }}
      >
        {tabs.map((tab) => (
          <span className="mini-compact-tab" key={tab.id}>
            <PreviewIcon icon={tab.icon} size={9} />
            {tab.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function FullPreview({ viewModel, activeTab, onTabChange }) {
  const { theme, store, tabs } = viewModel;

  return (
    <div className="mini-preview mini-preview-full">
      <div className="mini-phone">
        <div className="mini-phone-notch" />
        <div
          className="mini-phone-screen"
          style={{ background: theme.pageBackground, color: theme.textColor }}
        >
          <div className="mini-phone-status">
            <span>9:41</span>
            <span>▮▮▮ ◉</span>
          </div>
          <StoreHeader store={store} theme={theme} />
          <div className="mini-phone-body">
            <PreviewTabContent tab={activeTab} viewModel={viewModel} />
          </div>
          <nav
            className="mini-phone-tabs"
            style={{
              borderColor: `${theme.textColor}18`,
              background: theme.tabBarBackground,
            }}
          >
            {tabs.map((tab) => {
              const active = tab.id === activeTab;
              return (
                <button
                  key={tab.id}
                  type="button"
                  className={`mini-phone-tab${active ? ' is-active' : ''}`}
                  style={{
                    color: active ? theme.tabBarSelectedColor : theme.tabBarColor,
                  }}
                  onClick={() => onTabChange(tab.id)}
                  aria-current={active ? 'page' : undefined}
                >
                  <PreviewIcon icon={tab.icon} size={14} />
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </nav>
        </div>
      </div>
    </div>
  );
}

export default function MiniProgramPreview({ viewModel, size = 'full' }) {
  const [activeTab, setActiveTab] = useState('home');
  const compact = size === 'compact';

  if (viewModel == null) {
    return (
      <div
        className={compact ? 'mini-preview mini-preview-compact' : 'mini-preview mini-preview-full'}
        role="status"
      >
        <span>预览暂不可用</span>
      </div>
    );
  }

  if (compact) {
    return <CompactPreview viewModel={viewModel} />;
  }

  return (
    <FullPreview
      viewModel={viewModel}
      activeTab={activeTab}
      onTabChange={setActiveTab}
    />
  );
}