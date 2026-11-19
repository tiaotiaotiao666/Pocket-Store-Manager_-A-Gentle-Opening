import { Check, Copy, FolderOpen } from 'lucide-react';

export default function ExportResultCard({
  outputPath,
  previewOnly = [],
  versionGaps = [],
  onOpenPath,
  onCopyPath,
}) {
  return (
    <section className="export-result">
      <header className="export-result-head">
        <span className="export-result-badge">
          <Check size={13} />
          工程已生成
        </span>
        {previewOnly.length > 0 ? <span className="deploy-badge is-warn">含仅预览能力</span> : null}
      </header>

      <dl className="deploy-summary">
        <div className="deploy-summary-row">
          <dt>工程目录</dt>
          <dd className="deploy-path">{outputPath || '—'}</dd>
        </div>
      </dl>

      <div className="deploy-actions">
        <button type="button" className="primary-button deploy-action" onClick={() => onOpenPath && onOpenPath(outputPath)}>
          <FolderOpen size={14} />
          打开目录
        </button>
        <button type="button" className="ghost-button deploy-action" onClick={() => onCopyPath && onCopyPath(outputPath)}>
          <Copy size={14} />
          复制路径
        </button>
      </div>

      {previewOnly.length > 0 ? (
        <p className="deploy-limits">
          <strong>仅预览：</strong>
          {previewOnly.join('、')} 尚未接入线上能力。
        </p>
      ) : null}

      {versionGaps.length > 0 ? (
        <p className="deploy-limits">
          <strong>有可用更新：</strong>
          使用的模板或组件出了新版本，重新生成一次就会用上。
        </p>
      ) : null}
    </section>
  );
}
