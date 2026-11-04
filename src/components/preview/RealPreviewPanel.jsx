import {
  AlertTriangle,
  FolderOpen,
  ImagePlus,
  Info,
  Monitor,
  Trash2,
} from 'lucide-react';
import './real-preview.css';

/**
 * C-REAL-PREVIEW@1（`real-preview-channel.v1`）的展示面板。
 *
 * 诚实性说明（务必保留文案）：
 * - 这里是「真实渲染截图回传」：截图来自微信开发者工具里编译后的真实渲染；
 * - 它不是应用内实时渲染，应用内实时预览仍是 React 复刻；
 * - 截图只读本地文件，不上传网络、不写入导出工程。
 */
const DISCLAIMER = '这是「真实渲染截图回传」，不是应用内实时渲染：应用内预览是 React 复刻的近似效果，'
  + '截图来自微信开发者工具里的真实编译结果，两者不一致时以工具内真实渲染为准。';

const MANUAL_STEPS = [
  {
    key: 'import',
    title: '在微信开发者工具中导入已导出工程',
    body: '点「打开工程目录」定位到导出产物，然后在微信开发者工具选择「导入项目」并指向同一目录（AppID 可在该目录的 project.config.json 中查看）。',
  },
  {
    key: 'appid',
    title: 'AppID / 代理卡住时改直连',
    body: '若工具内编译或 CLI 自动化因 AppID 校验、网络代理卡住：到「设置 → 代理设置」改为直连（proxyType 不使用 SYSTEM），或手动登录 / 手动填入 AppID 后重试。',
  },
  {
    key: 'capture',
    title: '在工具内编译并截图',
    body: '确认首页真实渲染正常后，用工具自带截图或系统截图保存为 PNG / JPEG（≤ 8 MiB），回到本应用点「选择截图」回填。',
  },
  {
    key: 'compare',
    title: '仅用于人工对照',
    body: '回传的截图只在本次会话内显示，不会上传到任何服务，也不会写入导出工程。',
  },
];

const ERROR_TITLES = {
  PATH_INVALID: '工程路径无效',
  PATH_MISSING: '工程目录不存在',
  PREVIEW_PATH_INVALID: '工程路径无效',
  PREVIEW_PATH_NOT_FOUND: '工程目录不存在',
  DEVTOOLS_NOT_FOUND: '未能打开工程目录',
  PREVIEW_DEVTOOLS_NOT_FOUND: '未能打开工程目录',
  PREVIEW_SCREENSHOT_INVALID: '截图文件不可用',
  PREVIEW_SCREENSHOT_UNSUPPORTED_TYPE: '截图格式不支持',
  PREVIEW_SCREENSHOT_TOO_LARGE: '截图超过 8 MiB',
  PREVIEW_SCREENSHOT_CANCELLED: '已取消选择截图',
};

/**
 * 探测桌面桥接能力。浏览器（无 window.smartStore）下 mustDegrade = true，
 * 面板会禁用按钮并给出说明，而不是抛错。
 *
 * @param {any} [scope] 便于测试注入（默认 window）
 */
export function detectPreviewBridge(scope) {
  const root = scope || (typeof window !== 'undefined' ? window : null);
  const api = root ? root.smartStore : null;
  const isDesktop = Boolean(api && api.isDesktop === true);
  const canOpenProject = isDesktop && typeof api.openPreviewProject === 'function';
  const canPickScreenshot = isDesktop && typeof api.pickPreviewScreenshot === 'function';
  return {
    isDesktop,
    canOpenProject,
    canPickScreenshot,
    available: canOpenProject || canPickScreenshot,
  };
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function errorTitle(code) {
  if (!code) return '操作失败';
  return ERROR_TITLES[code] || '操作失败';
}

export function RealPreviewPanel({
  projectPath = null,
  screenshot = null,
  busy = false,
  error = null,
  onOpen,
  onPickScreenshot,
  onClear,
}) {
  const bridge = detectPreviewBridge();
  const trimmedPath = typeof projectPath === 'string' ? projectPath.trim() : '';
  const hasPath = trimmedPath.length > 0;
  const hasScreenshot = Boolean(
    screenshot
    && typeof screenshot === 'object'
    && typeof screenshot.dataUrl === 'string'
    && screenshot.dataUrl.length > 0,
  );

  const openDisabled = busy || !bridge.canOpenProject || typeof onOpen !== 'function';
  const pickDisabled = busy || !bridge.canPickScreenshot || typeof onPickScreenshot !== 'function';
  const clearDisabled = busy || !hasScreenshot || typeof onClear !== 'function';

  const openHint = bridge.canOpenProject
    ? (hasPath ? '在文件管理器中打开已导出的工程目录' : '先导出工程，再打开目录')
    : '仅桌面应用可用';
  const pickHint = bridge.canPickScreenshot
    ? '选择微信开发者工具里保存的 PNG / JPEG 截图'
    : '仅桌面应用可用';

  function handleOpen() {
    if (openDisabled) return;
    onOpen();
  }

  function handlePick() {
    if (pickDisabled) return;
    onPickScreenshot();
  }

  function handleClear() {
    if (clearDisabled) return;
    onClear();
  }

  return (
    <section className="real-preview" aria-labelledby="real-preview-title">
      <header className="real-preview-head">
        <div className="real-preview-title-block">
          <h4 id="real-preview-title" className="real-preview-title">真实渲染截图回传</h4>
          <p className="real-preview-sub">在微信开发者工具里编译后截图，回到应用人工对照</p>
        </div>
        <span className="real-preview-badge">
          <Monitor size={12} aria-hidden="true" />
          非实时渲染
        </span>
      </header>

      <p className="real-preview-disclaimer">
        <Info size={14} aria-hidden="true" />
        <span>{DISCLAIMER}</span>
      </p>

      {!bridge.canOpenProject || !bridge.canPickScreenshot ? (
        <div className="real-preview-notice" role="status">
          <Monitor size={14} aria-hidden="true" />
          <span>
            当前为浏览器模式：打开工程目录与选择截图只在桌面应用（Electron）中可用，
            浏览器里这两个按钮已禁用；其余人工步骤仍可照做。
          </span>
        </div>
      ) : null}

      {error && typeof error === 'object' && (error.message || error.code) ? (
        <div className="real-preview-error" role="alert">
          <AlertTriangle size={16} aria-hidden="true" />
          <div className="real-preview-error-body">
            <b>{errorTitle(error.code)}</b>
            {error.message ? <p>{error.message}</p> : null}
            {error.code ? <code>{error.code}</code> : null}
          </div>
        </div>
      ) : null}

      <div className="real-preview-actions">
        <button
          type="button"
          className="real-preview-btn is-primary"
          onClick={handleOpen}
          disabled={openDisabled}
          title={openHint}
        >
          <FolderOpen size={15} aria-hidden="true" />
          {busy ? '处理中…' : '打开工程目录'}
        </button>
        <button
          type="button"
          className="real-preview-btn"
          onClick={handlePick}
          disabled={pickDisabled}
          title={pickHint}
        >
          <ImagePlus size={15} aria-hidden="true" />
          选择截图
        </button>
        <button
          type="button"
          className="real-preview-btn is-ghost"
          onClick={handleClear}
          disabled={clearDisabled}
          title={hasScreenshot ? '清除当前截图' : '还没有可清除的截图'}
        >
          <Trash2 size={15} aria-hidden="true" />
          清除
        </button>
      </div>

      <p className="real-preview-path">
        <span className="real-preview-path-label">工程目录</span>
        <code className={hasPath ? '' : 'is-empty'} title={hasPath ? trimmedPath : undefined}>
          {hasPath ? trimmedPath : '尚未导出工程'}
        </code>
      </p>

      <div className="real-preview-shot">
        {hasScreenshot ? (
          <figure className="real-preview-figure">
            <img className="real-preview-image" src={screenshot.dataUrl} alt={`真实渲染截图：${screenshot.name || '未命名'}`} />
            <figcaption className="real-preview-caption">
              <span className="real-preview-name" title={screenshot.name || ''}>
                {screenshot.name || '未命名截图'}
              </span>
              {typeof screenshot.bytes === 'number' ? (
                <span className="real-preview-meta">{formatBytes(screenshot.bytes)}</span>
              ) : null}
              <span className="real-preview-local">仅本地</span>
            </figcaption>
          </figure>
        ) : (
          <div className="real-preview-placeholder">
            <ImagePlus size={20} aria-hidden="true" />
            <b>还没有回传截图</b>
            <span>按右侧步骤在开发者工具里编译截图后，点「选择截图」回填。</span>
          </div>
        )}
      </div>

      <ol className="real-preview-steps">
        {MANUAL_STEPS.map((step, index) => (
          <li key={step.key} className="real-preview-step">
            <span className="real-preview-step-index" aria-hidden="true">{index + 1}</span>
            <div className="real-preview-step-body">
              <b>{step.title}</b>
              <p>{step.body}</p>
            </div>
          </li>
        ))}
      </ol>

      <footer className="real-preview-footer">
        截图只读本地文件：不上传网络，不写入导出工程。
      </footer>
    </section>
  );
}

export default RealPreviewPanel;