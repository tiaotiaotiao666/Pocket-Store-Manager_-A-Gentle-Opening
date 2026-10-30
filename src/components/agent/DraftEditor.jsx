import { useEffect, useRef } from 'react';
import { ChevronDown, Trash2 } from 'lucide-react';

function fieldError(validation, field) {
  return validation.errors.find((error) => error.field === field) ?? null;
}

function fieldMissing(validation, field) {
  return validation.missingFields.find((item) => item.field === field) ?? null;
}

function FieldMessage({ error, missing }) {
  if (error) {
    return <p className="agent-field-error" id={`agent-error-${error.field}`}>{error.message}</p>;
  }
  if (missing) {
    return <p className="agent-field-hint">{missing.detail}</p>;
  }
  return null;
}

export default function DraftEditor({
  draft,
  validation,
  disabled = false,
  maxDishes = 5,
  minDishes = 3,
  open = false,
  onToggleOpen,
  onChangeField,
  onToggleFulfillment,
  onChangeDish,
  onRemoveDish,
}) {
  const nameRefs = useRef({});
  const previousCount = useRef(draft.dishes.length);

  useEffect(() => {
    if (draft.dishes.length > previousCount.current) {
      const last = draft.dishes[draft.dishes.length - 1];
      nameRefs.current[last?.id]?.focus?.();
    }
    previousCount.current = draft.dishes.length;
  }, [draft.dishes]);

  const nameError = fieldError(validation, 'storeName');
  const categoryError = fieldError(validation, 'category');
  const hoursError = fieldError(validation, 'businessHours');
  const dishesMissing = fieldMissing(validation, 'dishes');
  const fulfillmentMissing = fieldMissing(validation, 'fulfillment');
  const visibleDishCount = draft.dishes.length;

  return (
    <section className="agent-editor" aria-label="结构化开店资料">
      <button
        type="button"
        className="agent-editor-toggle"
        onClick={() => onToggleOpen?.()}
        aria-expanded={open}
      >
        <span>
          结构化资料草稿
          <em className="agent-editor-count">{visibleDishCount} 道菜</em>
        </span>
        <ChevronDown size={16} className={open ? 'is-open' : ''} />
      </button>

      {open ? (
        <div className="agent-editor-body">
          <div className="agent-editor-grid">
            <label className="agent-field" id="agent-field-storeName">
              <span className="agent-field-label">店名</span>
              <input
                className={`agent-input${nameError ? ' is-invalid' : ''}`}
                type="text"
                value={draft.storeName}
                placeholder="例如：松月食堂"
                disabled={disabled}
                aria-invalid={nameError ? 'true' : 'false'}
                aria-describedby={nameError ? 'agent-error-storeName' : undefined}
                onChange={(event) => onChangeField?.('storeName', event.target.value)}
              />
              <FieldMessage error={nameError} missing={fieldMissing(validation, 'storeName')} />
            </label>

            <label className="agent-field" id="agent-field-category">
              <span className="agent-field-label">餐饮品类</span>
              <input
                className={`agent-input${categoryError ? ' is-invalid' : ''}`}
                type="text"
                value={draft.category}
                placeholder="例如：社区餐馆、咖啡茶饮"
                disabled={disabled}
                aria-invalid={categoryError ? 'true' : 'false'}
                aria-describedby={categoryError ? 'agent-error-category' : undefined}
                onChange={(event) => onChangeField?.('category', event.target.value)}
              />
              <FieldMessage error={categoryError} missing={fieldMissing(validation, 'category')} />
            </label>

            <label className="agent-field agent-field-wide" id="agent-field-businessHours">
              <span className="agent-field-label">营业时间</span>
              <input
                className={`agent-input${hoursError ? ' is-invalid' : ''}`}
                type="text"
                value={draft.businessHours}
                placeholder="例如 10:00-21:00"
                disabled={disabled}
                aria-invalid={hoursError ? 'true' : 'false'}
                aria-describedby={hoursError ? 'agent-error-businessHours' : undefined}
                onChange={(event) => onChangeField?.('businessHours', event.target.value)}
              />
              <span className="agent-field-tip">多个时段用英文逗号分隔，例如 10:00-14:00,16:00-21:00</span>
              <FieldMessage error={hoursError} missing={fieldMissing(validation, 'businessHours')} />
            </label>
          </div>

          <fieldset className="agent-field agent-fulfillment" id="agent-field-fulfillment">
            <legend className="agent-field-label">取餐方式</legend>
            <div className="agent-chip-row">
              <label className={`agent-check${draft.fulfillment.dineIn ? ' is-checked' : ''}`}>
                <input
                  type="checkbox"
                  checked={draft.fulfillment.dineIn}
                  disabled={disabled}
                  onChange={(event) => onToggleFulfillment?.('dineIn', event.target.checked)}
                />
                堂食
              </label>
              <label className={`agent-check${draft.fulfillment.takeaway ? ' is-checked' : ''}`}>
                <input
                  type="checkbox"
                  checked={draft.fulfillment.takeaway}
                  disabled={disabled}
                  onChange={(event) => onToggleFulfillment?.('takeaway', event.target.checked)}
                />
                到店自取
              </label>
              {fulfillmentMissing ? <span className="agent-field-hint">{fulfillmentMissing.detail}</span> : null}
            </div>
          </fieldset>

          <div className="agent-dish-head">
            <span className="agent-field-label">菜品（{visibleDishCount}/{maxDishes}）</span>
            {visibleDishCount < minDishes ? (
              <span className="agent-dish-tip">至少 {minDishes} 道，还差 {minDishes - visibleDishCount} 道</span>
            ) : null}
          </div>

          <ul className="agent-dish-list" id="agent-field-dishes">
            {draft.dishes.map((dish, index) => {
              const nameKey = `dishes[${index}].name`;
              const priceKey = `dishes[${index}].priceCents`;
              const descriptionKey = `dishes[${index}].description`;
              const dishNameError = fieldError(validation, nameKey);
              const priceError = fieldError(validation, priceKey);
              const descriptionError = fieldError(validation, descriptionKey);
              return (
                <li className="agent-dish-card" key={dish.id}>
                  <div className="agent-dish-index" aria-hidden="true">{index + 1}</div>
                  <div className="agent-dish-main">
                    <div className="agent-dish-row">
                      <label className="agent-field agent-dish-name" id={`agent-field-${nameKey}`}>
                        <span className="agent-field-label">菜名</span>
                        <input
                          ref={(node) => { nameRefs.current[dish.id] = node; }}
                          className={`agent-input${dishNameError ? ' is-invalid' : ''}`}
                          type="text"
                          value={dish.name}
                          placeholder="例如：宫保鸡丁"
                          disabled={disabled}
                          aria-invalid={dishNameError ? 'true' : 'false'}
                          aria-describedby={dishNameError ? `agent-error-${nameKey}` : undefined}
                          onChange={(event) => onChangeDish?.(dish.id, 'name', event.target.value)}
                        />
                        <FieldMessage error={dishNameError} missing={fieldMissing(validation, nameKey)} />
                      </label>

                      <label className="agent-field agent-dish-price" id={`agent-field-${priceKey}`}>
                        <span className="agent-field-label">价格（元）</span>
                        <input
                          className={`agent-input${priceError ? ' is-invalid' : ''}`}
                          type="text"
                          inputMode="decimal"
                          value={dish.priceText}
                          placeholder="28.50"
                          disabled={disabled}
                          aria-invalid={priceError ? 'true' : 'false'}
                          aria-describedby={priceError ? `agent-error-${priceKey}` : undefined}
                          onChange={(event) => onChangeDish?.(dish.id, 'priceText', event.target.value)}
                        />
                        <FieldMessage error={priceError} missing={fieldMissing(validation, priceKey)} />
                      </label>
                    </div>

                    <label className="agent-field" id={`agent-field-${descriptionKey}`}>
                      <span className="agent-field-label">描述（可选）</span>
                      <textarea
                        className={`agent-input agent-textarea${descriptionError ? ' is-invalid' : ''}`}
                        rows={2}
                        value={dish.description}
                        placeholder="一句话介绍这道菜"
                        disabled={disabled}
                        aria-invalid={descriptionError ? 'true' : 'false'}
                        aria-describedby={descriptionError ? `agent-error-${descriptionKey}` : undefined}
                        onChange={(event) => onChangeDish?.(dish.id, 'description', event.target.value)}
                      />
                      <FieldMessage error={descriptionError} missing={null} />
                    </label>
                  </div>
                  <button
                    type="button"
                    className="agent-dish-remove"
                    disabled={disabled}
                    aria-label={`删除第 ${index + 1} 道菜`}
                    onClick={() => onRemoveDish?.(dish.id)}
                  >
                    <Trash2 size={14} />
                  </button>
                </li>
              );
            })}
          </ul>

          {dishesMissing ? (
            <p className="agent-field-hint agent-dish-missing">{dishesMissing.detail}</p>
          ) : null}

        </div>
      ) : (
        <p className="agent-editor-collapsed">也可以直接手动填写这些资料。</p>
      )}
    </section>
  );
}