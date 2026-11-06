import { useState } from 'react';
import { Loader2, Monitor } from 'lucide-react';

/**
 * 「预览新模块」按钮：
 * - 只在 Electron 桌面端可用，点击直接调起微信开发者工具打开真实小程序工程；
 * - 浏览器环境无法启动本地程序，改为明确提示，不再打开复刻预览页。
 */
export default function PreviewLaunchButton({
  projectPath = null,
  viewModel = null,
  templateName = '',
  onPrepareProject = null,
  label = '预览新模块',
  className = '',
}) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);

  const api = typeof window !== 'undefined' ? window.smartStore : null;
  const isDesktop = Boolean(
    api
    && api.isDesktop === true
    && typeof api.openPreviewDevtools === 'function',
  );

  function openBrowserPreview() {
    setNotice({
      tone: 'warn',
      text: '微信小程序预览需要在桌面应用里进行：请安装微信开发者工具，用 npm run desktop:dev 启动桌面端后再点此按钮。',
    });
  }

  async function handleClick() {
    if (busy) return;
    if (!isDesktop) {
      openBrowserPreview();
      return;
    }

    setBusy(true);
    setNotice(null);
    try {
      let targetPath = typeof projectPath === 'string' && projectPath.trim() ? projectPath : '';
      if (!targetPath && typeof onPrepareProject === 'function') {
        setNotice({ tone: 'info', text: '正在按当前定制需求生成预览工程…' });
        const prepared = await onPrepareProject();
        if (!prepared || !prepared.ok) {
          setNotice({ tone: 'warn', text: (prepared && prepared.message) || '未能生成预览工程。' });
          return;
        }
        targetPath = prepared.path || '';
        if (!targetPath) {
          setNotice({ tone: 'warn', text: '预览工程已生成，但没有返回工程路径。' });
          return;
        }
      }

      const payload = targetPath ? { projectPath: targetPath } : {};
      const result = await api.openPreviewDevtools(payload);
      if (result && result.ok) {
        setNotice({ tone: 'ok', text: result.message || '已请求微信开发者工具打开工程。' });
      } else {
        setNotice({ tone: 'warn', text: (result && result.message) || '未能调起微信开发者工具。' });
      }
    } catch (error) {
      setNotice({ tone: 'warn', text: `调起微信开发者工具失败：${(error && error.message) || '未知错误'}` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`preview-launch${className ? ` ${className}` : ''}`}>
      <button
        type="button"
        className="preview-launch-btn"
        onClick={handleClick}
        disabled={busy}
        title={isDesktop ? '在微信开发者工具中打开当前工程' : '需在桌面端使用微信开发者工具预览'}
      >
        {busy ? <Loader2 size={12} className="spin" aria-hidden="true" /> : <Monitor size={12} aria-hidden="true" />}
        <span>{busy ? '正在调起…' : label}</span>
      </button>
      {notice ? (
        <p className={`preview-launch-note is-${notice.tone}`} role="status">
          {notice.text}
        </p>
      ) : null}
    </div>
  );
}