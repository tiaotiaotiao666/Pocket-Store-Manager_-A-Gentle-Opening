import { AlertTriangle, Check, Copy, FolderOpen, Rocket } from 'lucide-react';

const STATUS_TITLES = {
  idle: '准备生成小程序工程',
  choosing: '选择工程的保存位置',
  validating: '正在校验配置',
  generating: '正在生成工程',
  verifying: '正在检查产物',
  done: '工程已生成',
  failed: '生成失败',
  conflict: '目录已存在',
  cancelled: '已取消生成',
};

const STATUS_NOTES = {
  idle: '生成的是本地工程目录，不会上传或发布，也不会产生真实交易。',
  choosing: '请选择一个空目录位置；同名目录不会被覆盖。',
  validating: '检查 Plan、模板版本、依赖与主题对比度。',
  generating: '按 Plan 确定性写入小程序工程文件。',
  verifying: '静态校验、敏感信息扫描与可复现性检查。',
  done: '可以用微信开发者工具导入这个目录继续调试。',
  failed: '没有生成任何可用产物，修正后可以重试。',
  conflict: '目标目录已存在，换一个项目名或选择其他位置。',
  cancelled: '已停止生成，目标目录没有留下半成品。',
};

const WORKING_STATUSES = new Set(['validating', 'generating', 'verifying']);
const CANCELLABLE_STATUSES = new Set(['validating', 'generating']);

export default function DeployStep({
  status = 'idle',
  steps = [],
  step = 0,
  progress = 0,
  stageMessage = '',
  storeName,
  templateName,
  styleName,
  directory = '',
  projectName = '',
  result = null,
  error = null,
  previewOnly = [],
  versionGaps = [],
  warnings = [],
  busy = false,
  blockedReason = null,
  onChooseDirectory,
  onRetry,
  onCancel,
  onOpenPath,
  onCopyPath,
  onOpenHandoff,
}) {
  const stepList = Array.isArray(steps) ? steps : [];
  const safeProgress = Math.max(0, Math.min(100, Number(progress) || 0));
  const currentIndex = Number(step) || 0;
  const working = WORKING_STATUSES.has(status);
  const canCancel = CANCELLABLE_STATUSES.has(status) && !busy;

  return (
    <section className="deploy-step">
      <header className="deploy-head">
        <span className={`deploy-head-icon${status === 'done' ? ' is-done' : ''}`}>
          {status === 'done' ? <Check size={16} /> : (status === 'failed' || status === 'conflict' ? <AlertTriangle size={16} /> : <Rocket size={16} />)}
        </span>
        <div className="deploy-heading">
          <h3>{STATUS_TITLES[status] || '生成小程序工程'}</h3>
          <p>{stageMessage || STATUS_NOTES[status] || STATUS_NOTES.idle}</p>
        </div>
      </header>

      {working ? (
        <>
          <div className="deploy-progress">
            <div className="deploy-progress-track">
              <div className="deploy-progress-bar" style={{ width: `${safeProgress}%` }} />
            </div>
            <span className="deploy-progress-value">{safeProgress}%</span>
          </div>

          <ol className="deploy-steps">
            {stepList.map((label, index) => {
              const isCurrent = index === currentIndex;
              const isFinished = index < currentIndex;
              const className = `deploy-step-item${isCurrent ? ' is-current' : ''}${isFinished ? ' is-done' : ''}`;
              return (
                <li key={`deploy-step-${index}`} className={className}>
                  <span className="deploy-step-index">
                    {isFinished ? <Check size={11} /> : index + 1}
                  </span>
                  <span className="deploy-step-label">{label}</span>
                  {isCurrent ? <span className="deploy-step-live">进行中</span> : null}
                </li>
              );
            })}
          </ol>

          <div className="deploy-actions">
            {canCancel ? (
              <button type="button" className="ghost-button deploy-action" onClick={onCancel}>
                取消生成
              </button>
            ) : null}
            {status === 'verifying' ? (
              <span className="deploy-actions-note">检查产物阶段不可取消，完成后才交付目录。</span>
            ) : null}
          </div>
        </>
      ) : null}

      {(status === 'idle' || status === 'choosing' || status === 'cancelled') ? (
        <div className="deploy-actions deploy-actions--start">
          <button
            type="button"
            className="primary-button deploy-action"
            onClick={onChooseDirectory}
            disabled={status === 'choosing' || busy || Boolean(blockedReason)}
          >
            {status === 'choosing' ? '正在打开目录选择器…' : (status === 'cancelled' ? '重新选择导出位置' : '选择导出位置')}
          </button>
          <span className="deploy-actions-note">
            {blockedReason || '仅写本地目录；不会上传、发布或提交审核。'}
          </span>
        </div>
      ) : null}

      {status === 'failed' || status === 'conflict' ? (
        <div className="deploy-failure">
          <div className="deploy-failure-body">
            <strong>{error && error.message ? error.message : STATUS_NOTES[status]}</strong>
            {error && error.code ? <span className="deploy-failure-code">错误码：{error.code}</span> : null}
            {error && error.suggestedName ? <span className="deploy-failure-code">建议项目名：{error.suggestedName}</span> : null}
          </div>
          <div className="deploy-actions">
            <button type="button" className="primary-button deploy-action" onClick={onRetry} disabled={busy}>
              重试生成
            </button>
            <button type="button" className="ghost-button deploy-action" onClick={onChooseDirectory} disabled={busy}>
              更换目录
            </button>
          </div>
        </div>
      ) : null}

      {status === 'done' ? (
        <div className="deploy-success">
          <div className="deploy-success-head">
            <span className="deploy-success-badge">
              <Check size={13} />
              工程已生成
            </span>
            {previewOnly.length > 0 ? <span className="deploy-badge is-warn">含仅预览能力</span> : null}
          </div>

          <dl className="deploy-summary">
            <div className="deploy-summary-row">
              <dt>店铺</dt>
              <dd>{storeName || '未命名店铺'}</dd>
            </div>
            <div className="deploy-summary-row">
              <dt>页面骨架</dt>
              <dd>{templateName || '默认骨架'}</dd>
            </div>
            <div className="deploy-summary-row">
              <dt>装修风格</dt>
              <dd>{styleName || '默认风格'}</dd>
            </div>
            <div className="deploy-summary-row">
              <dt>工程目录</dt>
              <dd className="deploy-path">{result?.outputPath || (directory && projectName ? `${directory}/${projectName}` : '—')}</dd>
            </div>
            {result?.lockDigest ? (
              <div className="deploy-summary-row">
                <dt>Lock 摘要</dt>
                <dd className="deploy-path">{result.lockDigest}</dd>
              </div>
            ) : null}
          </dl>

          <div className="deploy-actions">
            <button
              type="button"
              className="primary-button deploy-action"
              onClick={() => onOpenHandoff && onOpenHandoff()}
            >
              开始交接上架
            </button>
            <button
              type="button"
              className="ghost-button deploy-action"
              onClick={() => onOpenPath && onOpenPath(result?.outputPath)}
            >
              <FolderOpen size={14} />
              打开目录
            </button>
            <button
              type="button"
              className="ghost-button deploy-action"
              onClick={() => onCopyPath && onCopyPath(result?.outputPath)}
            >
              <Copy size={14} />
              复制路径
            </button>
          </div>

          {previewOnly.length > 0 ? (
            <div className="deploy-limits">
              <strong>仅预览能力</strong>
              <span>{previewOnly.join('、')} 尚未接入线上能力，不能对外宣称已上线。</span>
            </div>
          ) : null}

          {versionGaps.length > 0 ? (
            <div className="deploy-limits">
              <strong>版本缺口</strong>
              <span>{versionGaps.map((gap) => (typeof gap === 'string' ? gap : `${gap.id} ${gap.current} → ${gap.available}`)).join('；')}</span>
            </div>
          ) : null}

          {warnings.length > 0 ? (
            <div className="deploy-limits">
              <strong>提示</strong>
              <span>{warnings.join('；')}</span>
            </div>
          ) : null}

          <p className="deploy-success-note">下一步：在微信开发者工具中导入该目录。本应用不会自动上传或发布。</p>
        </div>
      ) : null}
    </section>
  );
}