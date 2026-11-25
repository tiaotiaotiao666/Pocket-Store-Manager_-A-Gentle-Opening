import { useEffect, useRef } from 'react';
import { ChevronDown, Plus, Trash2 } from 'lucide-react';

import StoreNameField from '../common/StoreNameField.jsx';
import {
  MAX_HOURS_SEGMENTS,
  describeHoursSegment,
  formatHoursText,
  parseHoursText,
  segmentTimeline,
  validateHoursSegments,
} from '../../domain/businessHours.mjs';
import { MAX_DISHES, MIN_DISHES } from '../../domain/storeLimits.mjs';

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
  maxDishes = MAX_DISHES,
  minDishes = MIN_DISHES,
  open = false,
  mode = 'all',
  collapsible = true,
  embedded = false,
  onToggleOpen,
  onChangeField,
  onToggleFulfillment,
  onChangeDish,
  onAddDish,
  onRemoveDish,
}) {
  const nameRefs = useRef({});
  const previousCount = useRef(draft.dishes.length);
  const showStore = mode === 'all' || mode === 'store';
  const showDishes = mode === 'all' || mode === 'dishes';
  const bodyOpen = collapsible ? open : true;

  useEffect(() => {
    if (draft.dishes.length > previousCount.current) {
      const last = draft.dishes[draft.dishes.length - 1];
      nameRefs.current[last?.id]?.focus?.();
    }
    previousCount.current = draft.dishes.length;
  }, [draft.dishes]);

  const nameError = fieldError(validation, 'storeName');
  const categoryError = fieldError(validation, 'category');
  const hoursMissing = fieldMissing(validation, 'businessHours');
  const dishesMissing = fieldMissing(validation, 'dishes');
  const fulfillmentMissing = fieldMissing(validation, 'fulfillment');
  const visibleDishCount = draft.dishes.length;
  const label = mode === 'store' ? '门店基本资料编辑' : mode === 'dishes' ? '菜品资料编辑' : '结构化开店资料';

  // 营业时间：主入口是时间范围选择器，文本只是同一份数据的规范序列化（见 businessHours.mjs）。
  const hoursSegments = parseHoursText(draft.businessHours);
  const hoursProblems = validateHoursSegments(hoursSegments);
  const hoursProblemIndexes = new Set(hoursProblems.map((problem) => problem.index).filter((index) => index !== null));

  const applyHoursSegments = (nextSegments) => {
    onChangeField?.('businessHours', formatHoursText(nextSegments));
  };

  const updateHoursSegment = (index, part, value) => {
    const next = hoursSegments.map((segment, position) => (
      position === index ? { ...segment, [part]: value } : segment
    ));
    applyHoursSegments(next);
  };

  const addHoursSegment = () => {
    if (hoursSegments.length >= MAX_HOURS_SEGMENTS) return;
    applyHoursSegments([...hoursSegments, { start: '', end: '' }]);
  };

  const removeHoursSegment = (index) => {
    applyHoursSegments(hoursSegments.filter((_, position) => position !== index));
  };

  const dishTip = visibleDishCount === 0
    ? `还没有菜品：加 ${minDishes} 道带菜名和价格的菜就能继续（0 道也可以先存草稿）。`
    : visibleDishCount < minDishes
      ? `至少 ${minDishes} 道，还差 ${minDishes - visibleDishCount} 道`
      : null;

  return (
    <section className={`agent-editor${embedded ? ' is-embedded' : ''}`} aria-label={label} data-jump-id="store-info-form">
      {collapsible ? (
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
      ) : null}

      {bodyOpen ? (
        <div className="agent-editor-body">
          {showStore ? (
            <>
              <div className="agent-editor-grid">
                <label className="agent-field" id="agent-field-storeName">
                  <span className="agent-field-label">店名</span>
                  {/* 店名走统一 20 字上限字段：输入/粘贴/拖拽/回填同一口径，带「当前字数/20」。 */}
                  <StoreNameField
                    inputId="agent-input-storeName"
                    value={draft.storeName}
                    placeholder="例如：松月食堂"
                    disabled={disabled}
                    invalid={Boolean(nameError)}
                    describedBy={nameError ? 'agent-error-storeName' : undefined}
                    onChange={(next) => onChangeField?.('storeName', next)}
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
                  {/* 品类输入框已有 placeholder 提示，不再重复显示下方黄色缺项说明。 */}
                  <FieldMessage error={categoryError} />
                </label>
              </div>

              <div className="agent-field agent-field-wide agent-hours" id="agent-field-businessHours" role="group" aria-label="营业时间">
                <span className="agent-field-label">营业时间</span>
                {hoursSegments.length === 0 ? (
                  <p className="agent-field-hint">还没有营业时段，点下面的「增加时段」选开始和结束时间。</p>
                ) : (
                  <ul className="agent-hours-list">
                    {hoursSegments.map((segment, index) => {
                      const timeline = segmentTimeline(segment);
                      const crossesMidnight = Boolean(timeline && timeline.crossesMidnight);
                      const invalid = hoursProblemIndexes.has(index);
                      return (
                        <li className={`agent-hours-row${invalid ? ' is-invalid' : ''}`} key={`hours-${index}`}>
                          <span className="agent-hours-index">第 {index + 1} 段</span>
                          <label className="agent-hours-point">
                            <span className="agent-field-label">开始</span>
                            <input
                              className={`agent-input${invalid ? ' is-invalid' : ''}`}
                              type="time"
                              value={segment.start}
                              disabled={disabled}
                              aria-label={`第 ${index + 1} 段开始时间`}
                              onChange={(event) => updateHoursSegment(index, 'start', event.target.value)}
                            />
                          </label>
                          <span className="agent-hours-arrow" aria-hidden="true">→</span>
                          <label className="agent-hours-point">
                            <span className="agent-field-label">结束</span>
                            <input
                              className={`agent-input${invalid ? ' is-invalid' : ''}`}
                              type="time"
                              value={segment.end}
                              disabled={disabled}
                              aria-label={`第 ${index + 1} 段结束时间`}
                              onChange={(event) => updateHoursSegment(index, 'end', event.target.value)}
                            />
                          </label>
                          {crossesMidnight ? (
                            <span className="agent-hours-nextday">次日 {segment.end}</span>
                          ) : null}
                          <span className="agent-hours-summary">{describeHoursSegment(segment)}</span>
                          <button
                            type="button"
                            className="agent-hours-remove"
                            aria-label={`删除第 ${index + 1} 个营业时段`}
                            disabled={disabled}
                            onClick={() => removeHoursSegment(index)}
                          >
                            <Trash2 size={14} />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}

                <div className="agent-hours-actions">
                  <button
                    type="button"
                    className="agent-dish-add"
                    disabled={disabled || hoursSegments.length >= MAX_HOURS_SEGMENTS}
                    onClick={addHoursSegment}
                  >
                    <Plus size={14} aria-hidden="true" />
                    增加时段
                  </button>
                  <span className="agent-field-tip">
                    午休可以加第二段；结束时间早于开始时间表示营业到次日，例如 22:00 → 次日 02:00。
                  </span>
                </div>

                {hoursProblems.map((problem) => (
                  <p className="agent-field-error" key={`${problem.code}-${problem.index ?? 'all'}`}>
                    {problem.message}
                  </p>
                ))}
                {hoursProblems.length === 0 ? <FieldMessage error={null} missing={hoursMissing} /> : null}
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
            </>
          ) : null}

          {showDishes ? (
            <>
              <div className="agent-dish-head">
                <div className="agent-dish-head-copy">
                  <span className="agent-field-label">菜品（{visibleDishCount}/{maxDishes}）</span>
                  {dishTip ? <span className="agent-dish-tip">{dishTip}</span> : null}
                </div>
                <button
                  type="button"
                  className="agent-dish-add"
                  disabled={disabled || visibleDishCount >= maxDishes}
                  onClick={() => onAddDish?.()}
                >
                  <Plus size={14} aria-hidden="true" />
                  添加菜品（{visibleDishCount}/{maxDishes}）
                </button>
              </div>

              <ul className="agent-dish-list" id="agent-field-dishes" data-jump-id="store-dishes">
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
            </>
          ) : null}
        </div>
      ) : (
        <p className="agent-editor-collapsed">也可以直接手动填写这些资料。</p>
      )}
    </section>
  );
}
