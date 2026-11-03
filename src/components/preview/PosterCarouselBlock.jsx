import { useEffect, useState } from 'react';
import {
  DEFAULT_SIZE_TOKENS,
  SIZE_STEPS,
  toPx,
} from '../../domain/previewSizeTokens.mjs';

/**
 * 预览侧的 poster-carousel 块。
 *
 * 视觉与行为对齐 `templates/features/poster-carousel/1.0.0/src/components/poster-carousel`：
 * - 三档语气底色（warm / green / ink）取自组件 wxss 的同一组渐变；
 * - 空 items 时渲染 `POSTER` 占位，对应 wxml 的 `wx:else` 分支；
 * - interval 已在 ViewModel 侧按 manifest 契约钳制到 3000–8000ms。
 *
 * 刻意不渲染 `image`：Plan 禁止外部 URL，预览只使用主题色块，
 * 与 Feature Pack manifest 的 knownLimits「演示海报使用主题渐变色块」一致。
 */

const TONE_CLASS = Object.freeze({
  warm: 'is-warm',
  green: 'is-green',
  ink: 'is-ink',
});

const FALLBACK_INTERVAL = 4000;

export default function PosterCarouselBlock({ block, compact = false, interactive = false }) {
  const props = block && block.props ? block.props : {};
  const items = Array.isArray(props.items) ? props.items : [];
  const count = items.length;
  const [index, setIndex] = useState(0);

  // 尺寸档位：优先 ViewModel 的 block.size，其次 Plan 的 props.size，最后回落到 md。
  // 紧凑缩略图保持样式表的固定高度，不消费真机档位。
  const sizeStep = SIZE_STEPS.includes(block && block.size)
    ? block.size
    : SIZE_STEPS.includes(props.size)
      ? props.size
      : DEFAULT_SIZE_TOKENS.carousel;
  const heightStyle = compact ? undefined : { height: `${toPx('carousel', sizeStep)}px` };

  // items 变短时把游标拉回合法区间，避免渲染 undefined。
  useEffect(() => {
    if (count === 0) {
      if (index !== 0) setIndex(0);
      return;
    }
    if (index > count - 1) setIndex(0);
  }, [count, index]);

  const autoplay = props.autoplay === true && count > 1;
  const interval = Number.isFinite(props.interval) && props.interval > 0
    ? props.interval
    : FALLBACK_INTERVAL;

  useEffect(() => {
    if (!autoplay) return undefined;
    const timer = setInterval(() => {
      setIndex((current) => (current + 1) % count);
    }, interval);
    return () => clearInterval(timer);
  }, [autoplay, interval, count]);

  const sizeClass = compact ? ' is-compact' : '';

  if (count === 0) {
    return (
      <div className={`mini-poster mini-poster-empty${sizeClass}`} style={heightStyle} role="presentation">
        POSTER
      </div>
    );
  }

  const safeIndex = Math.min(index, count - 1);
  const active = items[safeIndex];

  const handleAdvance = () => {
    if (!interactive || count < 2) return;
    setIndex((current) => (current + 1) % count);
  };

  return (
    <div className={`mini-poster${sizeClass}`} role="presentation">
      <div
        className={`mini-poster-slide ${TONE_CLASS[active.tone] || TONE_CLASS.warm}`}
        style={heightStyle}
        onClick={handleAdvance}
        role={interactive && count > 1 ? 'button' : undefined}
        tabIndex={interactive && count > 1 ? 0 : undefined}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            handleAdvance();
          }
        }}
      >
        <small className="mini-poster-eyebrow">本周推荐</small>
        <b className="mini-poster-title">{active.title}</b>
        {active.subtitle ? <span className="mini-poster-sub">{active.subtitle}</span> : null}
      </div>
      {props.showIndicator ? (
        <div className="mini-poster-dots" aria-hidden="true">
          {items.map((item, dotIndex) => (
            <span
              key={item.id}
              className={`mini-poster-dot${dotIndex === safeIndex ? ' is-active' : ''}`}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}