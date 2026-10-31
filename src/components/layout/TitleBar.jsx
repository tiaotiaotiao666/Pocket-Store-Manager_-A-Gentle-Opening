import { FolderKanban, Redo2, Undo2 } from 'lucide-react';

export default function TitleBar({
  title,
  caption,
  badge,
  saveLabel = null,
  canUndo = false,
  canRedo = false,
  onUndo,
  onRedo,
  onOpenWorkbench,
  onReset,
}) {
  return (
    <header className="titlebar">
      <div className="titlebar-lead">
        <span className="titlebar-title">{title}</span>
        {caption ? <span className="titlebar-caption">{caption}</span> : null}
      </div>
      <div className="titlebar-tail">
        {saveLabel ? (
          <span className={`titlebar-save is-${saveLabel.tone}`}>
            <i aria-hidden="true" />
            {saveLabel.text}
          </span>
        ) : null}
        <span className="titlebar-history">
          <button type="button" className="titlebar-icon-button" onClick={onUndo} disabled={!canUndo} aria-label="撤销" title="撤销（Ctrl+Z）">
            <Undo2 size={14} />
          </button>
          <button type="button" className="titlebar-icon-button" onClick={onRedo} disabled={!canRedo} aria-label="重做" title="重做（Ctrl+Shift+Z）">
            <Redo2 size={14} />
          </button>
        </span>
        {badge ? <span className="titlebar-badge">{badge}</span> : null}
        <button type="button" className="titlebar-reset" onClick={onOpenWorkbench}>
          <FolderKanban size={13} />
          项目
        </button>
        <button type="button" className="titlebar-reset" onClick={onReset}>
          重置项目
        </button>
      </div>
    </header>
  );
}