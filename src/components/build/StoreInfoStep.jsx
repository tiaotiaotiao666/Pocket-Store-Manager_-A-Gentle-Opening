import { useState } from 'react';
import { Check, ImagePlus, Store, Trash2 } from 'lucide-react';

export default function StoreInfoStep({
  store = {},
  storeTypes = [],
  styles = [],
  styleId,
  images = [],
  imageBusy = false,
  selectedImageId = null,
  imageAnalysis = null,
  embedded = false,
  showHeader = true,
  showIdentity = true,
  showContact = true,
  showImages = true,
  showStyle = true,
  showSubmit = true,
  onFieldChange,
  onStyleChange,
  onPickImages,
  onDropImages,
  onSelectImage,
  onRemoveImage,
  onAnalyzeImage,
  onSubmit,
}) {
  const typeList = Array.isArray(storeTypes) ? storeTypes : [];
  const styleList = Array.isArray(styles) ? styles : [];
  const imageList = Array.isArray(images) ? images : [];
  const data = store || {};
  const analyzing = imageAnalysis?.status === 'analyzing';
  const [dragging, setDragging] = useState(false);
  const canAcceptDrop = !imageBusy && imageList.length < 6;

  return (
    <section className={`store-step${embedded ? ' is-embedded' : ''}`}>
      {showHeader ? (
        <header className="store-step-head">
          <span className="store-step-icon">
            <Store size={16} />
          </span>
          <div className="store-step-heading">
            <h3>店铺信息</h3>
            <p>这些信息会用在页面结构与文案里，之后随时可以再修改。</p>
          </div>
        </header>
      ) : null}

      {showIdentity || showContact ? (
        <div className="store-form">
          {showIdentity ? (
            <>
              <label className="store-field">
                <span className="store-field-label">店铺名称</span>
                <input
                  className="store-field-input"
                  type="text"
                  value={data.name || ''}
                  placeholder="例如：松月食堂"
                  onChange={(event) => onFieldChange?.('name', event.target.value)}
                />
              </label>

              <label className="store-field">
                <span className="store-field-label">店铺类型</span>
                <select
                  className="store-field-input store-field-select"
                  value={data.type || ''}
                  onChange={(event) => onFieldChange?.('type', event.target.value)}
                >
                  <option value="">请选择店铺类型</option>
                  {typeList.map((item) => {
                    const value = typeof item === 'string' ? item : item?.value ?? item?.name ?? '';
                    const label = typeof item === 'string' ? item : item?.label ?? item?.name ?? value;
                    return <option key={value} value={value}>{label}</option>;
                  })}
                </select>
              </label>
            </>
          ) : null}

          {showContact ? (
            <>
              <label className="store-field">
                <span className="store-field-label">店铺地址</span>
                <input
                  className="store-field-input"
                  type="text"
                  value={data.address || ''}
                  placeholder="例如：杭州市西湖区文三路 88 号"
                  onChange={(event) => onFieldChange?.('address', event.target.value)}
                />
              </label>

              <label className="store-field">
                <span className="store-field-label">联系电话</span>
                <input
                  className="store-field-input"
                  type="text"
                  value={data.phone || ''}
                  placeholder="例如：0571-88886666"
                  onChange={(event) => onFieldChange?.('phone', event.target.value)}
                />
              </label>

              <label className="store-field store-field-wide">
                <span className="store-field-label">一句话介绍</span>
                <textarea
                  className="store-field-input store-field-textarea"
                  rows={3}
                  value={data.intro || ''}
                  placeholder="用一句话说明这家店最打动人的地方"
                  onChange={(event) => onFieldChange?.('intro', event.target.value)}
                />
              </label>
            </>
          ) : null}
        </div>
      ) : null}

      {showImages ? (
        <div
          className={`store-images-block${dragging ? ' is-drop-target' : ''}`}
          onDragOver={(event) => {
            if (!canAcceptDrop) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
            setDragging(true);
          }}
          onDragLeave={(event) => {
            if (event.currentTarget.contains(event.relatedTarget)) return;
            setDragging(false);
          }}
          onDrop={(event) => {
            if (!canAcceptDrop) return;
            event.preventDefault();
            setDragging(false);
            onDropImages?.(event.dataTransfer?.files);
          }}
        >
          <div className="store-images-head">
            <h4>{imageList.length > 0 ? '已上传图片' : '还没有上传图片'}</h4>
            <span className="store-style-hint">真实项目资产，最多 6 张；只保存在本机项目里，不会打进导出工程。可以把图片直接拖到这里。</span>
          </div>

          {imageList.length > 0 ? (
            <ul className="store-images-list">
              {imageList.map((item, index) => {
                const isSelected = item.assetId === selectedImageId;
                return (
                  <li key={item.assetId} className={`store-image-item${isSelected ? ' is-selected' : ''}`}>
                    <label className="store-image-media">
                      <input
                        type="radio"
                        name="store-environment-selection"
                        checked={isSelected}
                        disabled={imageBusy}
                        aria-label={`选择环境图片 ${index + 1}`}
                        onChange={() => onSelectImage?.(item.assetId)}
                      />
                      {item.previewUrl ? (
                        <img className="store-image-preview" src={item.previewUrl} alt={`门店环境图片 ${index + 1}`} />
                      ) : (
                        <span className="store-image-mark"><ImagePlus size={18} /></span>
                      )}
                      {isSelected ? <span className="store-image-selected-badge">用于氛围分析</span> : null}
                    </label>
                    <div className="store-image-body">
                      <span className="store-image-name">{item.originalName || item.fileName || item.assetId}</span>
                      <span className="store-image-meta">
                        {item.bytes ? `${Math.max(1, Math.round(item.bytes / 1024))} KB · ` : ''}
                        {item.statusLabel || '待识别'}
                      </span>
                      <button
                        type="button"
                        className="store-image-remove"
                        aria-label={`删除环境图片 ${index + 1}`}
                        disabled={imageBusy}
                        onClick={() => onRemoveImage?.(item.assetId)}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="store-images-empty">还没有门店环境图片。添加后可选择一张，只用于分析门店氛围。</p>
          )}

          <div className="store-images-actions">
            <button
              type="button"
              className="ghost-button store-images-button"
              onClick={() => onPickImages?.()}
              disabled={imageBusy || imageList.length >= 6}
            >
              <ImagePlus size={14} />
              {imageBusy && !analyzing ? '正在导入图片…' : (imageList.length > 0 ? '继续添加图片' : '添加环境图片')}
            </button>
            <button
              type="button"
              className="ghost-button store-images-button"
              onClick={() => onAnalyzeImage?.(selectedImageId)}
              disabled={imageBusy || !selectedImageId}
            >
              {analyzing ? '正在分析氛围…' : '分析选中图片氛围'}
            </button>
            <span className="store-images-note">
              {imageList.length > 0 ? `已添加 ${imageList.length} / 6 张` : '支持 PNG / JPG / WebP，单张不超过 10 MB'}
            </span>
          </div>
          {imageAnalysis?.message ? (
            <p className={`store-image-analysis is-${imageAnalysis.status}`} role="status">{imageAnalysis.message}</p>
          ) : null}
        </div>
      ) : null}

      {showStyle ? (
        <div className="store-style-block">
          <div className="store-style-head">
            <h4>装修风格</h4>
            <span className="store-style-hint">选一个更贴近你店铺气质的配色</span>
          </div>
          <div className="store-style-grid">
            {styleList.map((item) => {
              const isSelected = item.id === styleId;
              const colors = Array.isArray(item.colors) ? item.colors : [];
              return (
                <button
                  type="button"
                  key={item.id}
                  className={`store-style-card${isSelected ? ' is-selected' : ''}`}
                  onClick={() => onStyleChange?.(item.id)}
                >
                  <span className="store-style-swatches">
                    {colors.map((color, index) => (
                      <i
                        key={`${item.id}-${index}`}
                        className="store-style-swatch"
                        style={{ background: color }}
                      />
                    ))}
                  </span>
                  <span className="store-style-body">
                    <span className="store-style-name">
                      {item.name}
                      {isSelected ? <span className="store-style-check"><Check size={12} /></span> : null}
                    </span>
                    <span className="store-style-caption">{item.caption}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {showSubmit ? (
        <div className="store-step-foot">
          <button type="button" className="store-submit" onClick={() => onSubmit?.()}>
            确认店铺信息
          </button>
        </div>
      ) : null}
    </section>
  );
}
