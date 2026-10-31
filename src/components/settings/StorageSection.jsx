import { FolderOpen, HardDrive, ShieldCheck } from 'lucide-react';

export default function StorageSection({
  mode = 'desktop',
  projectCount = 0,
  maxBackups = 3,
  autoSaveEnabled = true,
  autoSaveDebounceMs = 800,
  onOpenDataDir,
  onOpenProjectDirectory,
}) {
  const isBrowser = mode === 'browser';

  return (
    <section className="settings-section">
      <header className="settings-section-head">
        <div>
          <h2>数据与存储</h2>
          <p>项目写入应用数据目录；删除的项目会先移到回收站目录，保留 30 天。</p>
        </div>
      </header>

      <div className="settings-facts">
        <div className="settings-fact">
          <span className="settings-fact-icon"><HardDrive size={15} /></span>
          <div>
            <strong>存储模式</strong>
            <span>{isBrowser ? '浏览器 localStorage（图片不落盘）' : '本机文件（userData/projects）'}</span>
          </div>
        </div>
        <div className="settings-fact">
          <span className="settings-fact-icon"><FolderOpen size={15} /></span>
          <div>
            <strong>本机项目</strong>
            <span>{isBrowser ? '由浏览器自动管理' : `已保存 ${projectCount} 个项目`}</span>
          </div>
        </div>
        <div className="settings-fact">
          <span className="settings-fact-icon"><ShieldCheck size={15} /></span>
          <div>
            <strong>自动保存</strong>
            <span>
              {autoSaveEnabled ? `开启 · 变更后 ${autoSaveDebounceMs} ms 写入` : '关闭 · 仅在切换/关闭前保存'}
              {isBrowser ? '（浏览器模式固定 3 s 节流）' : ` · 每项目保留 ${maxBackups} 份备份`}
            </span>
          </div>
        </div>
      </div>

      <div className="settings-actions">
        <button type="button" className="ghost-button" onClick={onOpenDataDir} disabled={isBrowser}>
          <FolderOpen size={14} />
          打开数据目录
        </button>
        {onOpenProjectDirectory ? (
          <button type="button" className="ghost-button" onClick={onOpenProjectDirectory}>
            打开当前项目文件夹
          </button>
        ) : null}
        <span className="settings-inline-note">诊断 JSON 不会包含绝对路径或门店业务数据。</span>
      </div>
    </section>
  );
}