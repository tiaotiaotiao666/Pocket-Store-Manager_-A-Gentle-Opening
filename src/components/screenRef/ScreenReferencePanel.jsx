import { useRef } from 'react';

/**
 * P3/P4：参考截图 →（兼容区）可复用/近似/不支持 → 确认 → 候选模板；
 * 下方再接「生成候选前端」主链（P4）。
 *
 * 只负责展示后端/领域层算好的视图模型（`screenRef.view` 与 `frontendView`）
 * 并回传意图；不在这里做任何白名单判断，也不生成页面代码。
 * 兼容区保持 P3 的行为不变：旧识别/确认/候选模板链路仍可独立走通。
 */
export default function ScreenReferencePanel({
  view,
  busy = false,
  uploadDisabled = false,
  localError = null,
  persisted = true,
  frontendPanel = null,
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
  const tone = view?.tone ?? 'idle';
  const groups = view?.recognition?.groups ?? null;

  const handleFileChange = (event) => {
    const file = event.target.files && event.target.files[0];
    if (file && typeof onPickFile === 'function') onPickFile(file);
    // 允许重复选同一张图：清空 input 值。
    event.target.value = '';
  };

  return (
    <section className={`screen-ref is-${tone}`} role="group" aria-label="参考截图生成候选模板" id="screen-ref-panel">
      <header className="screen-ref-head">
        <h3 className="screen-ref-title">{view?.title ?? '参考截图生成候选模板'}</h3>
        <p className="screen-ref-body">{view?.body}</p>
        {view?.disclaimer ? <p className="screen-ref-disclaimer">{view.disclaimer}</p> : null}
      </header>

      {persisted ? null : (
        <p className="screen-ref-note" role="note">
          浏览器模式：截图只保存在内存中，重开项目后需要重新上传。
        </p>
      )}

      {localError ? (
        <p className="screen-ref-error" role="alert">{localError}</p>
      ) : null}

      <div className="screen-ref-actions">
        <input
          ref={inputRef}
          id="screen-ref-file"
          className="screen-ref-file"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          aria-label="选择参考截图"
          disabled={busy || uploadDisabled}
          onChange={handleFileChange}
        />
        <button
          type="button"
          className="btn btn-ghost"
          disabled={busy || uploadDisabled}
          onClick={() => {
            // 桌面模式走主进程选图（可落盘），浏览器模式回落到隐藏 file input。
            if (typeof onPick === 'function') onPick(() => inputRef.current && inputRef.current.click());
            else if (inputRef.current) inputRef.current.click();
          }}
        >
          {view?.image ? '换一张截图' : '上传截图'}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || !view?.image || uploadDisabled}
          onClick={onRecognize}
        >
          {busy ? '识别中…' : '开始识别'}
        </button>
        {view?.canRetry ? (
          <button type="button" className="btn btn-ghost" onClick={onRetry} disabled={busy}>
            重新识别
          </button>
        ) : null}
        {view?.image ? (
          <button type="button" className="btn btn-ghost" onClick={onReset} disabled={busy}>
            放弃这条参考
          </button>
        ) : null}
      </div>

      {view?.image ? (
        <div className="screen-ref-image">
          {view.image.previewUrl ? (
            <img src={view.image.previewUrl} alt={`参考截图预览：${view.image.name}`} />
          ) : (
            <p className="screen-ref-note">截图已保存，重开时按需读取预览。</p>
          )}
          <p className="screen-ref-note">{view.image.name}</p>
        </div>
      ) : null}

      {groups ? (
        <div className="screen-ref-groups">
          <p className="screen-ref-headline">{view.recognition.headline}</p>
          <div className="screen-ref-group">
            <h4>可复用的布局与组件（{groups.reusable.length}）</h4>
            {groups.reusable.length === 0 ? (
              <p className="screen-ref-note">没有可直接复用的项。</p>
            ) : (
              <ul>
                {groups.reusable.map((item) => (
                  <li key={`${item.kind}-${item.id}`}>
                    <span className="screen-ref-tag">{item.kind}</span>
                    {item.label}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="screen-ref-group">
            <h4>只能近似（{groups.approximate.length}）</h4>
            {groups.approximate.length === 0 ? (
              <p className="screen-ref-note">没有需要近似的部分。</p>
            ) : (
              <ul>
                {groups.approximate.map((item, index) => (
                  <li key={`approx-${index}`}>
                    {item.label}：{item.reason}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="screen-ref-group">
            <h4>暂不支持（{groups.unsupported.length}）</h4>
            {groups.unsupported.length === 0 ? (
              <p className="screen-ref-note">没有不支持的项。</p>
            ) : (
              <ul>
                {groups.unsupported.map((item, index) => (
                  <li key={`unsupported-${index}`}>
                    {item.label}：{item.reason}
                  </li>
                ))}
              </ul>
            )}
          </div>
          {view.recognition.styleSummary ? (
            <p className="screen-ref-note">{view.recognition.styleSummary}</p>
          ) : null}
          {view.recognition.notes ? (
            <p className="screen-ref-note">识别说明：{view.recognition.notes}</p>
          ) : null}
        </div>
      ) : null}

      {view?.confirmable ? (
        <div className="screen-ref-confirm">
          <p className="screen-ref-note">{view.recognition?.confirmHint}</p>
          <button type="button" className="btn btn-primary" onClick={onConfirm} disabled={busy}>
            确认识别结果
          </button>
        </div>
      ) : null}

      {view?.confirmed && !view?.candidate ? (
        <div className="screen-ref-confirm">
          <p className="screen-ref-note">已确认识别结果，可以生成候选模板（不会覆盖当前版本）。</p>
          <button type="button" className="btn btn-primary" onClick={onCreateCandidate} disabled={busy}>
            生成候选模板
          </button>
        </div>
      ) : null}

      {view?.candidate ? (
        <div className="screen-ref-candidate">
          <h4>候选模板：{view.candidate.label}</h4>
          <p className="screen-ref-note">
            组件：{view.candidate.components.length ? view.candidate.components.join('、') : '沿用当前选择'}
          </p>
          <p className="screen-ref-note">{view.candidate.styleSummary}</p>
          <p className="screen-ref-note">
            保留门店资料{view.candidate.preservedStoreName ? `「${view.candidate.preservedStoreName}」` : ''}
            ，菜品 {view.candidate.preservedDishes} 道原样不动。
          </p>
          {view.candidate.approximate > 0 || view.candidate.unsupported > 0 ? (
            <p className="screen-ref-note">
              候选里仍有 {view.candidate.approximate} 项近似、{view.candidate.unsupported} 项不支持，均已标注。
            </p>
          ) : null}
          <div className="screen-ref-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={onAdopt}
              disabled={busy || !view.canAdopt}
            >
              {view.adopted ? '已采用这个候选' : '采用这个候选'}
            </button>
            <button type="button" className="btn btn-ghost" onClick={onDiscard} disabled={busy}>
              放弃候选
            </button>
          </div>
          <p className="screen-ref-note">采用后仍可在下一步预览、返回修改或重新生成；不会自动发布。</p>
        </div>
      ) : null}

      {frontendPanel}
    </section>
  );
}
