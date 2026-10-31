import {
  AlertTriangle,
  ArrowRight,
  FolderOpen,
  HardDrive,
  Monitor,
  Plus,
  RefreshCw,
  Search,
  Settings,
} from 'lucide-react';

import ConfirmDialog from '../common/ConfirmDialog.jsx';
import ProjectCard from './ProjectCard.jsx';
import WorkbenchEmpty from './WorkbenchEmpty.jsx';

function SkeletonGrid() {
  return (
    <div className="project-grid" aria-hidden="true">
      {[0, 1, 2].map((index) => (
        <div className="project-card project-card-skeleton" key={`skeleton-${index}`}>
          <span className="skeleton-thumb" />
          <span className="skeleton-line is-wide" />
          <span className="skeleton-line" />
        </div>
      ))}
    </div>
  );
}

export default function ProjectWorkbench({
  status = 'idle',
  projects = [],
  search = '',
  mode = 'desktop',
  activeId = null,
  activeName = '',
  lastProjectId = null,
  deleteTarget = null,
  deleteBusy = false,
  error = null,
  openError = null,
  thumbnails = {},
  onSearch,
  onCreate,
  onOpen,
  onReveal,
  onCopyId,
  onDeleteRequest,
  onDeleteCancel,
  onDeleteConfirm,
  onOpenRecent,
  onBackToFlow,
  onRetry,
  onOpenDirectory,
  onOpenSettings,
  onDismissError,
}) {
  const visible = Array.isArray(projects) ? projects : [];
  const isBrowser = mode === 'browser';
  const hasActive = Boolean(activeId);

  return (
    <div className="workbench">
      <header className="workbench-top">
        <div className="workbench-heading">
          <span className="workbench-eyebrow">智能开店</span>
          <h1>我的项目</h1>
          <p>每个门店一个项目：资料、图片、会话与导出进度都在本机保存。</p>
        </div>
        <div className="workbench-tools">
          <label className="workbench-search">
            <Search size={15} />
            <input
              type="search"
              value={search}
              placeholder="搜索项目名或阶段，例如「部署」"
              onChange={(event) => onSearch?.(event.target.value)}
              aria-label="搜索项目"
            />
          </label>
          <button type="button" className="ghost-button workbench-tool" onClick={onOpenSettings}>
            <Settings size={15} />
            设置与自检
          </button>
          <button type="button" className="primary-button workbench-tool" onClick={onCreate}>
            <Plus size={16} />
            新建项目
          </button>
        </div>
      </header>

      {hasActive ? (
        <button type="button" className="workbench-resume" onClick={onBackToFlow}>
          <span className="workbench-resume-body">
            <span className="workbench-resume-label">正在编辑</span>
            <strong>{activeName || '当前项目'}</strong>
          </span>
          <span className="workbench-resume-action">
            继续
            <ArrowRight size={15} />
          </span>
        </button>
      ) : null}

      {isBrowser ? (
        <div className="workbench-banner">
          <Monitor size={16} />
          <span>浏览器模式：项目只保存在本机浏览器里，图片不会落盘，刷新或清缓存会丢失。要完整体验请使用桌面应用。</span>
        </div>
      ) : null}

      <main className="workbench-body">
        {openError && status !== 'error' ? (
          <div className="workbench-error-banner" role="alert">
            <AlertTriangle size={15} />
            <span>{openError.message}</span>
            {openError.code ? <code>{openError.code}</code> : null}
            <button type="button" onClick={onDismissError}>知道了</button>
          </div>
        ) : null}

        {status === 'loading' ? <SkeletonGrid /> : null}

        {status === 'error' ? (
          <div className="workbench-error">
            <span className="workbench-error-mark">
              <AlertTriangle size={24} />
            </span>
            <h3>项目列表读取失败</h3>
            <p>{error?.message || '请检查数据目录权限后重试。'}</p>
            {error?.code ? <code>{error.code}</code> : null}
            <div className="workbench-error-actions">
              <button type="button" className="primary-button" onClick={onRetry}>
                <RefreshCw size={14} />
                重试
              </button>
              <button type="button" className="ghost-button" onClick={onOpenDirectory}>
                <FolderOpen size={14} />
                打开数据目录
              </button>
            </div>
          </div>
        ) : null}

        {(status === 'idle' || status === 'empty') && visible.length === 0 ? (
          <div className="workbench-empty-wrap">
            {lastProjectId ? (
              <button type="button" className="workbench-recent" onClick={() => onOpenRecent?.(lastProjectId)}>
                <span>
                  <span className="workbench-recent-label">最近打开</span>
                  <strong>继续上次的项目</strong>
                </span>
                <ArrowRight size={16} />
              </button>
            ) : null}
            <WorkbenchEmpty onCreate={onCreate} />
          </div>
        ) : null}

        {status === 'search-empty' ? (
          <WorkbenchEmpty variant="search-empty" query={search} onClear={() => onSearch?.('')} />
        ) : null}

        {status === 'list' || status === 'deleting' ? (
          <>
            <div className="workbench-grid-head">
              <span>{visible.length} 个项目</span>
              <span className="workbench-grid-hint">双击卡片或按 Enter 打开</span>
            </div>
            <div className="project-grid">
              {visible.map((project) => (
                <ProjectCard
                  key={project.projectId}
                  project={project}
                  active={project.projectId === activeId}
                  thumbnail={thumbnails[project.projectId]}
                  onOpen={onOpen}
                  onReveal={onReveal}
                  onCopyId={onCopyId}
                  onDelete={onDeleteRequest}
                />
              ))}
            </div>
          </>
        ) : null}
      </main>

      <footer className="workbench-foot">
        <span className={`workbench-mode${isBrowser ? ' is-browser' : ''}`}>
          {isBrowser ? <Monitor size={13} /> : <HardDrive size={13} />}
          {isBrowser ? '浏览器预览 · 图片与文件不落盘' : '桌面模式 · 项目与图片写入本机数据目录'}
        </span>
        <span className="workbench-foot-note">不会上传、发布或提交审核。</span>
      </footer>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title={`删除项目「${deleteTarget?.name || ''}」？`}
        description="将移除：项目配置、图片资产、会话记录。已导出的小程序工程不会被删除。项目会先移到回收站目录，保留 30 天。"
        expectedText={deleteTarget?.name || ''}
        placeholder="输入项目名"
        confirmLabel="删除项目"
        busy={deleteBusy}
        onConfirm={onDeleteConfirm}
        onCancel={onDeleteCancel}
      />
    </div>
  );
}