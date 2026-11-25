/**
 * E0-U1：参考图上传 + consent 提示。
 *
 * 边界（冻结 §14.8 / 计划 §2.3）：
 * - 组件**不读文件、不写文件、不调 IPC**：只表达“选图请求”和“用户明确同意把图发给模型”；
 *   真正的 picker / assetId 解析由主进程负责（E1 接线，命令 `project:pick-images` + `startRun.imageAssetIds`）。
 * - E0 只接受 1 张参考图、单张 ≤2 MiB（放大/超限的判定在主进程，这里只如实显示）。
 * - 缺图必须同时露出 `MISSING` 与 `BLOCKED`：不允许悄悄退化成纯文本生成。
 * - 每个可交互控件都有可读名称（`aria-label`），复选框用 `role="checkbox"` + `aria-checked`（UIA 可见）。
 */

import { E0_CONSENT_LABEL, E0_CONSENT_TEXT, E0_LIMITS, describeConsent, describeReferenceImage } from './e0UiContract.mjs';

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '大小未知';
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
  return `${Math.max(1, Math.round(value / 1024))} KiB`;
}

export default function ReferenceImageUploader({
  image = null,
  consent = false,
  disabled = false,
  busy = false,
  error = null,
  onRequestPick,
  onRemove,
  onConsentChange,
}) {
  const imageState = describeReferenceImage(image);
  const consentState = describeConsent(consent);
  const blocked = !imageState.canRunVision || !consentState.granted || Boolean(error);
  const pickDisabled = Boolean(disabled) || Boolean(busy);

  function requestPick() {
    if (pickDisabled) return;
    if (typeof onRequestPick === 'function') onRequestPick();
  }

  function removeImage() {
    if (pickDisabled) return;
    if (typeof onRemove === 'function') onRemove();
  }

  function toggleConsent() {
    if (disabled) return;
    if (typeof onConsentChange === 'function') onConsentChange(!consentState.granted);
  }

  return (
    <section className="e0-field" id="e0-reference-image-field" role="group" aria-label="参考图与同意提示">
      <div className="e0-field-header">
        <span className="e0-field-label">参考图（1 张，≤{Math.floor(E0_LIMITS.maxImageBytes / 1024)} KiB）</span>
        <span className="e0-field-meta e0-image-state" data-image-state={imageState.state} role="status" aria-label={`参考图状态：${imageState.state}`}>
          {imageState.state}
        </span>
      </div>

      {imageState.canRunVision ? (
        <div className="e0-image-chip" role="note" aria-label="已选参考图">
          <span className="e0-image-name">{image?.fileName || image?.assetId}</span>
          <span className="e0-image-meta">{formatBytes(image?.bytes)} · {image?.mime || 'MIME 未知'} · {image?.assetId}</span>
        </div>
      ) : (
        <p className="e0-field-hint e0-image-missing" role="note" aria-label="参考图缺失提示">
          {imageState.text}
        </p>
      )}

      <div className="e0-field-actions">
        <button type="button" className="e0-button" aria-label="选择一张参考图" disabled={pickDisabled} onClick={requestPick}>
          {imageState.canRunVision ? '换一张参考图' : '选择参考图'}
        </button>
        {imageState.canRunVision ? (
          <button type="button" className="e0-button e0-button-ghost" aria-label="移除已选参考图" disabled={pickDisabled} onClick={removeImage}>
            移除
          </button>
        ) : null}
      </div>

      <div
        className="e0-consent"
        id="e0-consent-checkbox"
        role="checkbox"
        aria-checked={consentState.granted}
        aria-disabled={Boolean(disabled)}
        aria-label={E0_CONSENT_LABEL}
        tabIndex={disabled ? -1 : 0}
        data-consent-state={consentState.state}
        onClick={toggleConsent}
      >
        <span className="e0-consent-box" aria-hidden="true">{consentState.granted ? '✓' : ''}</span>
        <span className="e0-consent-text">{E0_CONSENT_TEXT}</span>
      </div>
      <p className="e0-field-hint" role="note" aria-label="同意状态说明">
        {consentState.note}（只表示同意发图给模型，不会自动上传或保存图片）
      </p>

      {error ? (
        <p className="e0-field-error" role="alert" aria-label="参考图错误">
          {typeof error === 'string' ? error : (error.message || '参考图不可用')}
        </p>
      ) : null}
      {blocked ? (
        <p className="e0-field-hint e0-blocked-hint" role="note" aria-label="视觉分析阻断提示">
          本轮视觉分析 BLOCKED：需要先有可用参考图并勾选同意，缺一即不允许假装完成
        </p>
      ) : null}
    </section>
  );
}
