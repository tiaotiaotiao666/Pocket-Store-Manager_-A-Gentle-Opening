import { AlertTriangle, Check, RefreshCw, UploadCloud } from 'lucide-react';

const STATUS_TITLES = {
  idle: '把配置同步到后端',
  checking: '正在检查差异',
  reviewing: '确认要写入的变更',
  applying: '正在导入',
  done: '配置已导入',
  failed: '导入未完成',
  'auth-unavailable': '桌面导入不可用',
};

function actionLabel(action) {
  return {
    create: '新建',
    update: '更新',
    skip: '保持原样',
    conflict: '需要确认',
  }[action] || action;
}

function DiffGroup({ title, items, showConfirmation, confirmations, onToggle }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="import-group">
      <div className="import-group-head">
        <strong>{title}</strong>
        <span>{items.length} 项</span>
      </div>
      <ul className="import-list">
        {items.map((item) => {
          const key = item.confirmationKey || item.field || item.draftId;
          const isConflict = item.action === 'conflict';
          return (
            <li key={`${title}-${key}`} className={`import-item${isConflict ? ' is-conflict' : ''}`}>
              <span className="import-item-name">{item.name || item.field}</span>
              <span className={`import-action is-${item.action}`}>{actionLabel(item.action)}</span>
              {item.current !== undefined && item.current !== item.incoming ? (
                <span className="import-item-change">{item.current || '（空）'} → {item.incoming || '（空）'}</span>
              ) : null}
              {isConflict && showConfirmation ? (
                <label className="import-confirm">
                  <input
                    type="checkbox"
                    checked={(confirmations || []).includes(item.confirmationKey)}
                    onChange={() => onToggle(item.confirmationKey)}
                  />
                  确认覆盖
                </label>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default function ImportDiffCard({
  status = 'idle',
  preview = null,
  confirmations = [],
  busy = false,
  result = null,
  error = null,
  onPreview,
  onToggleConfirmation,
  onApply,
}) {
  const conflicts = (preview && preview.conflicts) || [];
  const allConfirmed = conflicts.every((key) => confirmations.includes(key));

  return (
    <section className="import-card">
      <header className="import-head">
        <span className="import-head-icon">
          {status === 'done' ? <Check size={15} /> : (status === 'failed' || status === 'auth-unavailable' ? <AlertTriangle size={15} /> : <UploadCloud size={15} />)}
        </span>
        <div>
          <h3>{STATUS_TITLES[status] || STATUS_TITLES.idle}</h3>
          <p>
            {status === 'idle' ? '只写入门店资料、分类、菜品与桌号；不覆盖未声明的运营数据。' : null}
            {status === 'checking' ? '正在读取后端门店数据并计算差异…' : null}
            {status === 'reviewing' ? '标记为“需要确认”的项目必须逐项勾选后才会更新。' : null}
            {status === 'applying' ? '单事务写入，失败会整体回滚。' : null}
            {status === 'done' ? '配置已写入后端，导出工程可重新生成以带上新版本号。' : null}
            {status === 'failed' ? (error && error.message) || '导入失败，请重试。' : null}
            {status === 'auth-unavailable' ? '当前环境不允许桌面演示登录，请在微信小程序端完成导入。' : null}
          </p>
        </div>
      </header>

      {error && error.code ? <span className="import-error-code">错误码：{error.code}</span> : null}

      {status === 'idle' || status === 'failed' ? (
        <div className="deploy-actions">
          <button type="button" className="secondary-button deploy-action" onClick={onPreview} disabled={busy}>
            <RefreshCw size={14} />
            检查导入差异
          </button>
        </div>
      ) : null}

      {preview && (status === 'reviewing' || status === 'applying') ? (
        <>
          <DiffGroup title="门店资料" items={preview.diff.profile} showConfirmation confirmations={confirmations} onToggle={onToggleConfirmation} />
          <DiffGroup title="分类" items={preview.diff.categories} showConfirmation confirmations={confirmations} onToggle={onToggleConfirmation} />
          <DiffGroup title="菜品" items={preview.diff.products} showConfirmation confirmations={confirmations} onToggle={onToggleConfirmation} />
          <DiffGroup title="桌号" items={preview.diff.tables} showConfirmation confirmations={confirmations} onToggle={onToggleConfirmation} />

          {preview.notImported && preview.notImported.length > 0 ? (
            <p className="import-limits">未导入：{preview.notImported.join('、')}</p>
          ) : null}

          <div className="deploy-actions">
            <button
              type="button"
              className="primary-button deploy-action"
              onClick={onApply}
              disabled={busy || !allConfirmed}
              title={allConfirmed ? '' : '请先确认全部冲突项'}
            >
              确认写入后端
            </button>
            <span className="deploy-actions-note">
              {conflicts.length > 0 && !allConfirmed ? `还有 ${conflicts.length - confirmations.length} 项冲突未确认。` : '写入后不可自动撤销。'}
            </span>
          </div>
        </>
      ) : null}

      {status === 'done' && result ? (
        <dl className="deploy-summary">
          <div className="deploy-summary-row">
            <dt>门店版本</dt>
            <dd>{result.configVersion}</dd>
          </div>
          <div className="deploy-summary-row">
            <dt>目录版本</dt>
            <dd>{result.catalogVersion}</dd>
          </div>
          <div className="deploy-summary-row">
            <dt>缓存刷新</dt>
            <dd>{result.cacheRefreshed ? '已刷新' : '未刷新（数据已写入）'}</dd>
          </div>
          <div className="deploy-summary-row">
            <dt>幂等重放</dt>
            <dd>{result.replay ? '是（返回首次结果）' : '否'}</dd>
          </div>
        </dl>
      ) : null}
    </section>
  );
}