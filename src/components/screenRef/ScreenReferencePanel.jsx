import { cloneElement, useRef, useState } from 'react';

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(value / 1024))} KB`;
}

function imageStatusLabel(frontendView, imageStatus) {
  const status = frontendView?.status || 'idle';
  if (status === 'idle') return imageStatus === 'replaced' ? '重新上传后待识别' : '待识别';
  if (status === 'analyzing') return '识别中';
  if (status === 'needs_input') return '需补充';
  if (status === 'rejected' || status === 'failed') return '识别失败';
  if (status === 'cancelled') return '待识别';
  return '已分析';
}

export default function ScreenReferencePanel({
  view,
  busy = false,
  uploadDisabled = false,
  localError = null,
  persisted = true,
  frontendPanel = null,
  frontendView = null,
  imageStatus = 'idle',
  onPickFile,
  onPick,
  onRecognize,
  onConfirm,
  onCreateCandidate,
  onAdopt,
  onDiscard,
  onRetry,
  onReset,
}) {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const groups = view?.recognition?.groups ?? null;
  const mainBusy = busy || Boolean(frontendView?.busy);
  const hasLegacy = Boolean(view?.recognition || view?.candidate);

  const handleFileChange = (event) => {
    const file = event.target.files && event.target.files[0];
    if (file && typeof onPickFile === 'function') onPickFile(file);
    event.target.value = '';
  };

  const uploadSlot = (
    <div
      className={`screen-ref-upload${dragging ? ' is-drop-target' : ''}`}
      onDragOver={(event) => {
        if (mainBusy || uploadDisabled) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget)) return;
        setDragging(false);
      }}
      onDrop={(event) => {
        if (mainBusy || uploadDisabled) return;
        event.preventDefault();
        setDragging(false);
        const file = event.dataTransfer?.files && event.dataTransfer.files[0];
        if (file && typeof onPickFile === 'function') onPickFile(file);
      }}
    >
      <div className="screen-ref-upload-layout">
        <header className="screen-ref-head">
          <h3 className="screen-ref-title">上传参考截图</h3>
          <p className="screen-ref-body">支持 JPG / PNG / WebP，选择后自动压缩。只参考布局、组件与风格，不提取菜品、地址或电话。</p>
          <p className="screen-ref-disclaimer">不会复制对方源码或品牌素材，也不会直接覆盖当前版本。</p>
        </header>
        <div className="screen-ref-actions screen-ref-upload-actions">
          <input
            ref={inputRef}
            id="screen-ref-file"
            className="screen-ref-file"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            aria-label="选择参考截图"
            disabled={mainBusy || uploadDisabled}
            onChange={handleFileChange}
          />
          <button
            type="button"
            id="screen-ref-upload-button"
            className="btn btn-primary screen-ref-upload-button"
            disabled={mainBusy || uploadDisabled}
            onClick={() => {
              if (typeof onPick === 'function') onPick(() => inputRef.current && inputRef.current.click());
              else if (inputRef.current) inputRef.current.click();
            }}
          >
            {view?.image ? '换一张截图' : '上传截图'}
          </button>
          {view?.image ? (
            <button type="button" className="btn btn-ghost" onClick={onReset} disabled={mainBusy || uploadDisabled}>
              删除截图
            </button>
          ) : null}
        </div>
      </div>

      {!persisted ? <p className="screen-ref-note" role="note">浏览器模式：截图只保存在内存中，重开项目后需要重新上传。</p> : null}
      {localError ? <p className="screen-ref-error" role="alert">{localError}</p> : null}

      {view?.image ? (
        <div className="screen-ref-image">
          {view.image.previewUrl ? (
            <img src={view.image.previewUrl} alt={`参考截图预览：${view.image.name}`} />
          ) : (
            <p className="screen-ref-note">截图已保存，重开时按需读取预览。</p>
          )}
          <p className="screen-ref-note">
            {view.image.name}
            {view.image.bytes ? ` · ${formatBytes(view.image.bytes)}` : ''}
            {' · '}
            <strong>{imageStatusLabel(frontendView, imageStatus)}</strong>
          </p>
        </div>
      ) : (
        <p className="screen-ref-upload-empty">还没有上传截图。点击「上传截图」选择一张首页或菜单页截图；也可以只上传图片，不填写补充要求。</p>
      )}
    </div>
  );
  const candidatePanel = frontendPanel ? cloneElement(frontendPanel, { uploadSlot }) : null;

  return (
    <section className="screen-ref" role="group" aria-label="参考小程序截图" id="screen-ref-panel">
      {candidatePanel}

      {hasLegacy ? (
        <details className="screen-ref-legacy">
          <summary>历史参考候选（旧版识别与模板流程）</summary>
          <div className="screen-ref-legacy-body">
            {groups ? (
              <div className="screen-ref-groups">
                <p className="screen-ref-headline">{view.recognition.headline}</p>
                <div className="screen-ref-group">
                  <h4>可复用的布局与组件（{groups.reusable.length}）</h4>
                  {groups.reusable.length === 0 ? <p className="screen-ref-note">没有可直接复用的项。</p> : (
                    <ul>
                      {groups.reusable.map((item) => (
                        <li key={`${item.kind}-${item.id}`}><span className="screen-ref-tag">{item.kind}</span>{item.label}</li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="screen-ref-group">
                  <h4>只能近似（{groups.approximate.length}）</h4>
                  {groups.approximate.length === 0 ? <p className="screen-ref-note">没有需要近似的部分。</p> : (
                    <ul>{groups.approximate.map((item, index) => <li key={`approx-${index}`}>{item.label}：{item.reason}</li>)}</ul>
                  )}
                </div>
                <div className="screen-ref-group">
                  <h4>暂不支持（{groups.unsupported.length}）</h4>
                  {groups.unsupported.length === 0 ? <p className="screen-ref-note">没有不支持的项。</p> : (
                    <ul>{groups.unsupported.map((item, index) => <li key={`unsupported-${index}`}>{item.label}：{item.reason}</li>)}</ul>
                  )}
                </div>
                {view.recognition.styleSummary ? <p className="screen-ref-note">{view.recognition.styleSummary}</p> : null}
                {view.recognition.notes ? <p className="screen-ref-note">识别说明：{view.recognition.notes}</p> : null}
              </div>
            ) : null}

            {view?.confirmable ? (
              <div className="screen-ref-confirm">
                <p className="screen-ref-note">{view.recognition?.confirmHint}</p>
                <button type="button" className="btn btn-primary" onClick={onConfirm} disabled={busy}>确认识别结果</button>
              </div>
            ) : null}

            {view?.confirmed && !view?.candidate ? (
              <div className="screen-ref-confirm">
                <p className="screen-ref-note">已确认识别结果，可以生成候选模板（不会覆盖当前版本）。</p>
                <button type="button" className="btn btn-primary" onClick={onCreateCandidate} disabled={busy}>生成候选模板</button>
              </div>
            ) : null}

            {view?.canRetry ? (
              <div className="screen-ref-actions">
                <button type="button" className="btn btn-ghost" onClick={onRetry} disabled={busy}>重新识别历史截图</button>
              </div>
            ) : null}

            {view?.candidate ? (
              <div className="screen-ref-candidate">
                <h4>候选模板：{view.candidate.label}</h4>
                <p className="screen-ref-note">组件：{view.candidate.components.length ? view.candidate.components.join('、') : '沿用当前选择'}</p>
                <p className="screen-ref-note">{view.candidate.styleSummary}</p>
                <p className="screen-ref-note">保留门店资料{view.candidate.preservedStoreName ? `「${view.candidate.preservedStoreName}」` : ''}，菜品 {view.candidate.preservedDishes} 道原样不动。</p>
                <div className="screen-ref-actions">
                  <button type="button" className="btn btn-primary" onClick={onAdopt} disabled={busy || !view.canAdopt}>
                    {view.adopted ? '已采用这个候选' : '采用这个候选'}
                  </button>
                  <button type="button" className="btn btn-ghost" onClick={onDiscard} disabled={busy}>放弃候选</button>
                </div>
              </div>
            ) : null}
          </div>
        </details>
      ) : null}
    </section>
  );
}
