import { Check, ImagePlus, Store } from 'lucide-react';


export default function StoreInfoStep({
  store = {},
  storeTypes = [],
  styles = [],
  styleId,
  images = [],
  imageBusy = false,
  onFieldChange,
  onStyleChange,
  onPickImages,
  onSubmit,
}) {
  const typeList = Array.isArray(storeTypes) ? storeTypes : [];
  const styleList = Array.isArray(styles) ? styles : [];
  const imageList = Array.isArray(images) ? images : [];
  const data = store || {};

  return (
    <section className="store-step">
      <header className="store-step-head">
        <span className="store-step-icon">
          <Store size={16} />
        </span>
        <div className="store-step-heading">
          <h3>店铺信息</h3>
          <p>这些信息会用在页面结构与文案里，之后随时可以再修改。</p>
        </div>
      </header>

      <div className="store-form">
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
              return (
                <option key={value} value={value}>
                  {label}
                </option>
              );
            })}
          </select>
        </label>

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
      </div>

      <div className="store-images-block">
        <div className="store-images-head">
          <h4>门店图片</h4>
          <span className="store-style-hint">最多 6 张；只保存在本机项目里，不会打进导出工程。第一张会作为工作台缩略图。</span>
        </div>

        {imageList.length > 0 ? (
          <ul className="store-images-list">
            {imageList.map((item) => (
              <li key={item.assetId} className="store-image-item">
                <span className="store-image-mark">
                  <ImagePlus size={13} />
                </span>
                <span className="store-image-name">{item.originalName || item.fileName || item.assetId}</span>
                <span className="store-image-meta">
                  {item.width && item.height ? `${item.width}×${item.height}` : item.mime || '图片'}
                  {item.bytes ? ` · ${Math.max(1, Math.round(item.bytes / 1024))} KB` : ''}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="store-images-empty">还没有门店图片。添加后工作台卡片会显示第一张作为缩略图。</p>
        )}

        <div className="store-images-actions">
          <button
            type="button"
            className="ghost-button store-images-button"
            onClick={() => onPickImages?.()}
            disabled={imageBusy}
          >
            <ImagePlus size={14} />
            {imageBusy ? '正在导入图片…' : (imageList.length > 0 ? '继续添加图片' : '添加门店图片')}
          </button>
          <span className="store-images-note">
            {imageList.length > 0
              ? `已添加 ${imageList.length} / 6 张`
              : '支持 PNG / JPG / WebP，单张不超过 10 MB'}
          </span>
        </div>
      </div>

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
                    {isSelected ? (
                      <span className="store-style-check">
                        <Check size={12} />
                      </span>
                    ) : null}
                  </span>
                  <span className="store-style-caption">{item.caption}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="store-step-foot">
        <button type="button" className="store-submit" onClick={() => onSubmit?.()}>
          确认店铺信息
        </button>
      </div>
    </section>
  );
}