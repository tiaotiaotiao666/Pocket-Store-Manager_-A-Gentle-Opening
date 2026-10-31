import { useEffect, useRef, useState } from 'react';
import { Copy, FolderOpen, MoreHorizontal, Trash2 } from 'lucide-react';

const PHASE_LABELS = {
  home: '新建',
  onboarding: '命名',
  features: '选功能',
  building: '构建中',
  'template-pick': '选骨架',
  'store-info': '装修',
  'prompt-studio': '提示词',
  'image-review': '审核',
  deploy: '部署',
};

const TONES = [
  ['#efeafe', '#6d5efc'],
  ['#e8f3ec', '#3f8a6b'],
  ['#f8efe2', '#c8843c'],
  ['#f1eef7', '#7b5ea7'],
];

function toneFor(projectId) {
  let hash = 0;
  const value = String(projectId || '');
  for (let index = 0; index < value.length; index += 1) hash = (hash * 31 + value.charCodeAt(index)) % 997;
  return TONES[hash % TONES.length];
}

function formatUpdated(iso) {
  if (!iso) return '时间未知';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '时间未知';
  const now = Date.now();
  const diff = Math.max(0, now - date.getTime());
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return '刚刚更新';
  if (minutes < 60) return `${minutes} 分钟前更新`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前更新`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前更新`;
  return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}

export default function ProjectCard({ project, active, thumbnail, onOpen, onReveal, onCopyId, onDelete }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const menuRef = useRef(null);
  const [background, foreground] = toneFor(project.projectId);
  const initial = String(project.name || '项').trim().slice(0, 1) || '项';
  const showThumbnail = Boolean(thumbnail) && !imageFailed;
  const future = project.futureVersion;
  const corrupt = project.hasCorrupt;

  useEffect(() => {
    setImageFailed(false);
  }, [thumbnail]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const close = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target)) setMenuOpen(false);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  return (
    <article className={`project-card${active ? ' is-active' : ''}${future ? ' is-readonly' : ''}`}>
      <button
        type="button"
        className="project-card-main"
        onClick={() => onOpen?.(project.projectId)}
        disabled={corrupt}
        title={corrupt ? '项目文件损坏，无法打开' : `打开「${project.name}」`}
      >
        <span className="project-card-thumb" style={{ background: `linear-gradient(140deg, ${background}, ${background}dd)`, color: foreground }}>
          {showThumbnail ? (
            <img
              src={thumbnail}
              alt=""
              loading="lazy"
              decoding="async"
              onError={() => setImageFailed(true)}
            />
          ) : (
            <span className="project-card-initial">{initial}</span>
          )}
          {corrupt ? <span className="project-card-flag">已损坏</span> : null}
          {future ? <span className="project-card-flag is-warn">需升级</span> : null}
        </span>
        <span className="project-card-body">
          <span className="project-card-title">{project.name || '未命名项目'}</span>
          <span className="project-card-meta">
            <span className={`project-card-phase${project.phase === 'deploy' ? ' is-deploy' : ''}`}>
              {PHASE_LABELS[project.phase] || '新建'}
            </span>
            <span className="project-card-time">{formatUpdated(project.updatedAt)}</span>
          </span>
        </span>
      </button>

      <div className="project-card-menu" ref={menuRef}>
        <button
          type="button"
          className="project-card-menu-trigger"
          aria-label="项目操作"
          onClick={() => setMenuOpen((value) => !value)}
        >
          <MoreHorizontal size={16} />
        </button>
        {menuOpen ? (
          <div className="project-card-menu-pop" role="menu">
            <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onOpen?.(project.projectId); }}>
              <FolderOpen size={14} />
              打开项目
            </button>
            <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onReveal?.(project.projectId); }}>
              <FolderOpen size={14} />
              在文件夹中显示
            </button>
            <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onCopyId?.(project.projectId); }}>
              <Copy size={14} />
              复制项目 ID
            </button>
            <button type="button" role="menuitem" className="is-danger" onClick={() => { setMenuOpen(false); onDelete?.(project); }}>
              <Trash2 size={14} />
              删除项目
            </button>
          </div>
        ) : null}
      </div>
    </article>
  );
}