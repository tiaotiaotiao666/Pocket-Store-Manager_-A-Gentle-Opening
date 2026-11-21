import { useEffect, useRef, useState } from 'react';

/**
 * 三栏外壳：左导航 / 主区 / 右对话面板。
 *
 * 左右两栏都可以用鼠标拖动分隔条调整宽度，也支持键盘左右箭头；
 * 宽度写进 localStorage（只管本机界面，不属于项目数据）。
 */

const LAYOUT_STORAGE_KEY = 'smartstore.desktop.layout.v1';
const SIDEBAR_DEFAULT = 272;
const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 440;
const PANEL_DEFAULT = 344;
const PANEL_MIN = 300;
const PANEL_MAX = 760;
const MAIN_MIN = 420;
const KEYBOARD_STEP = 16;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function viewportWidth() {
  return typeof window === 'undefined' ? 1440 : (window.innerWidth || 1440);
}

function clampWidths(widths, viewport = viewportWidth()) {
  const maxSidebar = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, viewport - MAIN_MIN - PANEL_MIN));
  const maxPanel = Math.max(PANEL_MIN, Math.min(PANEL_MAX, viewport - MAIN_MIN - SIDEBAR_MIN));
  return {
    sidebar: Math.round(clamp(widths.sidebar, SIDEBAR_MIN, maxSidebar)),
    panel: Math.round(clamp(widths.panel, PANEL_MIN, maxPanel)),
  };
}

function readStoredWidths() {
  const fallback = { sidebar: SIDEBAR_DEFAULT, panel: PANEL_DEFAULT };
  if (typeof window === 'undefined' || !window.localStorage) return clampWidths(fallback);
  try {
    const raw = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (!raw) return clampWidths(fallback);
    const parsed = JSON.parse(raw);
    return clampWidths({
      sidebar: Number.isFinite(parsed?.sidebar) ? parsed.sidebar : SIDEBAR_DEFAULT,
      panel: Number.isFinite(parsed?.panel) ? parsed.panel : PANEL_DEFAULT,
    });
  } catch (error) {
    return clampWidths(fallback);
  }
}

function persistWidths(widths) {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(widths));
  } catch (error) {
    // 隐私模式/配额满时静默忽略：宽度只是本机界面偏好。
  }
}

export default function AppShell({ sidebar, main, panel }) {
  const [widths, setWidths] = useState(readStoredWidths);
  const latestRef = useRef(widths);

  function applyWidths(next) {
    const clamped = clampWidths(next, viewportWidth());
    latestRef.current = clamped;
    setWidths(clamped);
    return clamped;
  }

  // 窗口变小后两栏不能把主区挤没，重新收敛一次。
  useEffect(() => {
    function handleResize() {
      applyWidths(latestRef.current);
    }
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  function beginDrag(edge, event) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidths = latestRef.current;
    const start = startWidths[edge];
    document.body.classList.add('is-resizing-layout');

    function handleMove(moveEvent) {
      const delta = moveEvent.clientX - startX;
      // 右栏的分隔条在它左边：往左拖变大。
      const value = edge === 'panel' ? start - delta : start + delta;
      applyWidths({ ...startWidths, [edge]: value });
    }

    function handleUp() {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
      document.body.classList.remove('is-resizing-layout');
      persistWidths(latestRef.current);
    }

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
  }

  function handleKeyDown(edge, event) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const direction = event.key === 'ArrowRight' ? 1 : -1;
    const nextValue = latestRef.current[edge] + direction * KEYBOARD_STEP
      * (edge === 'panel' ? -1 : 1);
    const next = applyWidths({ ...latestRef.current, [edge]: nextValue });
    persistWidths(next);
  }

  function resizerProps(edge, label) {
    const min = edge === 'panel' ? PANEL_MIN : SIDEBAR_MIN;
    const max = edge === 'panel' ? PANEL_MAX : SIDEBAR_MAX;
    return {
      className: 'shell-resizer',
      role: 'separator',
      'aria-label': label,
      'aria-orientation': 'vertical',
      'aria-valuemin': min,
      'aria-valuemax': max,
      'aria-valuenow': widths[edge],
      tabIndex: 0,
      title: `${label}（拖动或用左右箭头，双击恢复默认）`,
      onPointerDown: (event) => beginDrag(edge, event),
      onKeyDown: (event) => handleKeyDown(edge, event),
      onDoubleClick: () => {
        persistWidths(applyWidths({
          ...latestRef.current,
          [edge]: edge === 'panel' ? PANEL_DEFAULT : SIDEBAR_DEFAULT,
        }));
      },
    };
  }

  return (
    <div
      className="shell"
      style={{ '--sidebar-w': `${widths.sidebar}px`, '--panel-w': `${widths.panel}px` }}
    >
      <aside className="shell-sidebar" id="app-sidebar" aria-label="项目导航">{sidebar}</aside>
      <div {...resizerProps('sidebar', '调整项目导航宽度')} />
      <section className="shell-main">{main}</section>
      <div {...resizerProps('panel', '调整对话侧栏宽度')} />
      <aside className="shell-panel" id="app-panel" aria-label="项目信息与 Agent 对话">{panel}</aside>
    </div>
  );
}