import { useRef, useState } from 'react';
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
import AgentSidebarPanel from '../agent/AgentSidebarPanel.jsx';

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

const VIEWS = Object.freeze({
  INFO: 'info',
  AGENT: 'agent',
});

/**
 * 双视图标签。可见文本固定为「项目信息」「Agent 对话」——UIA 走查按这两个名字点击，
 * 因此不要改成图标或缩写，也不要让别处出现同名可访问名称。
 */
const TABS = Object.freeze([
  { id: VIEWS.INFO, label: '项目信息', tabId: 'right-panel-tab-info', panelId: 'right-panel-view-info' },
  { id: VIEWS.AGENT, label: 'Agent 对话', tabId: 'right-panel-tab-agent', panelId: 'right-panel-view-agent' },
]);

function ProjectInfoView({ meta, cards }) {
  return (
    <>
      <header className="panel-head">
        <span className="panel-eyebrow">上下文</span>
        <h2 className="panel-title">{meta.label ?? '轻启'}</h2>
        {meta.caption ? <p className="panel-caption">{meta.caption}</p> : null}
      </header>

      <div className="panel-cards">
        {cards.length === 0 ? (
          <p className="panel-cards-empty">这个阶段没有需要显示的上下文摘要。</p>
        ) : null}
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
    </>
  );
}

/**
 * 右侧栏：项目信息 / Agent 对话 双视图。
 *
 * - 默认打开「Agent 对话」；「项目信息」仍是原来那批 `panelCards`，行为不回归；
 * - 切换只在本地切「看哪个视图」，不取消在途请求、不清空消息：会话与草稿都来自
 *   App 传入的视图模型（`agentChat`），组件里没有自己的会话状态；
 * - 同一时刻只渲染一个视图，避免两套 DOM 出现同名可访问名称（UIA 走查要求唯一）。
 */
export default function RightPanel({ meta = {}, cards = [], agentChat = null, initialView = VIEWS.AGENT }) {
  // 默认打开「Agent 对话」；`initialView` 只用于测试/深链，非法值一律回落到默认视图。
  const [view, setView] = useState(TABS.some((tab) => tab.id === initialView) ? initialView : VIEWS.AGENT);
  const tabRefs = useRef([]);
  // 标准 tabs 键盘约定：roving tabIndex + 方向键切换，键盘用户也能在双视图间移动。
  const activateTab = (index) => {
    const tab = TABS[index];
    if (!tab) return;
    setView(tab.id);
    const node = tabRefs.current[index];
    if (node) node.focus();
  };
  const handleTabKeyDown = (event, index) => {
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      activateTab((index + 1) % TABS.length);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      activateTab((index - 1 + TABS.length) % TABS.length);
    } else if (event.key === 'Home') {
      event.preventDefault();
      activateTab(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      activateTab(TABS.length - 1);
    }
  };
  const hasCards = Array.isArray(cards) && cards.length > 0;
  const hasAgentChat = Boolean(agentChat);
  // UX0-6：右栏两栏都没有内容时整块收起（保持原有不占位的行为）。
  if (!hasCards && !hasAgentChat) return null;

  return (
    <div className="panel panel-dual">
      <div className="panel-tabs" role="tablist" aria-label="右侧栏视图">
        {TABS.map((tab, index) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={tab.tabId}
            ref={(node) => {
              tabRefs.current[index] = node;
            }}
            className={`panel-tab${view === tab.id ? ' is-active' : ''}`}
            aria-selected={view === tab.id}
            aria-controls={tab.panelId}
            tabIndex={view === tab.id ? 0 : -1}
            onClick={() => setView(tab.id)}
            onKeyDown={(event) => handleTabKeyDown(event, index)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {view === VIEWS.AGENT ? (
        <div
          className="panel-view panel-view-agent"
          id="right-panel-view-agent"
          role="tabpanel"
          aria-labelledby="right-panel-tab-agent"
        >
          <AgentSidebarPanel {...(agentChat || {})} />
        </div>
      ) : (
        <div
          className="panel-view panel-view-info"
          id="right-panel-view-info"
          role="tabpanel"
          aria-labelledby="right-panel-tab-info"
        >
          <ProjectInfoView meta={meta} cards={hasCards ? cards : []} />
        </div>
      )}
    </div>
  );
}
