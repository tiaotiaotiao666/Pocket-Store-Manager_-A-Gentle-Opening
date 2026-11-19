/**
 * 营业时间：唯一口径（B3）。
 *
 * 数据链只有一条：AgentDraft.businessHours 是一段规范文本
 * `HH:MM-HH:MM[,HH:MM-HH:MM…]`，编辑器把这段文本渲染成「开始时间 / 结束时间」选择器，
 * 预览、快照、Plan、Composer 都从同一条文本解析，不另建第二套结构。
 *
 * 跨午夜：结束时间早于开始时间表示营业到**次日**，例如 `22:00-02:00`；
 * 界面与预览都会显示成「22:00–次日 02:00」，不再要求用户手工拆成两段。
 *
 * 本模块是纯函数，前端领域层、导出前体检和服务端校验共用同一套判定：
 * - 开始 === 结束时明确报错（不是「营业 0 分钟」）；
 * - 时间串非法（如 `10:00-`、`25:00-26:00`）按格式错误处理；
 * - 多个时段重叠（含跨午夜时段与早间时段重叠）报冲突；
 * - 未填完的时段单列「还没选完」，不冒充格式错误。
 */

export const MAX_HOURS_SEGMENTS = 3;

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const LOOSE_POINT = /^(\d{1,2})(?::(\d{2}))?(?:[点时])?(半)?$/;
const MINUTES_PER_DAY = 24 * 60;

/** 单段营业时间的规范文本：两个时间点用 `-` 连接，任一侧可以为空（正在填写）。 */
export function isTimeText(value) {
  return typeof value === 'string' && TIME_PATTERN.test(value.trim());
}

/** 把 `9` / `9:5` / `9点半` / `21点` 之类的输入规范成 `HH:MM`。 */
export function normalizeTimePoint(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (TIME_PATTERN.test(raw)) return raw;
  const matched = LOOSE_POINT.exec(raw);
  if (!matched) return null;
  const hour = Number(matched[1]);
  if (!Number.isInteger(hour) || hour > 23) return null;
  const minute = matched[2] === undefined ? (matched[3] ? 30 : 0) : Number(matched[2]);
  if (!Number.isInteger(minute) || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** 文本 → 原始分段数组（保留空时段，便于编辑器渲染「还没选完」）。 */
export function splitHoursText(text) {
  const source = String(text ?? '').trim();
  if (!source) return [];
  return source
    .split(/[，,;；、]/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

/**
 * 把一段文本切成开始/结束。
 * @returns {{start: string, end: string, raw: string}}
 */
export function parseHoursSegment(segment) {
  const raw = String(segment ?? '').trim();
  const parts = raw.split(/[-~～—–至到]/);
  if (parts.length !== 2) return { start: '', end: '', raw };
  return {
    start: normalizeTimePoint(parts[0]) ?? (parts[0].trim() === '' ? '' : parts[0].trim()),
    end: normalizeTimePoint(parts[1]) ?? (parts[1].trim() === '' ? '' : parts[1].trim()),
    raw,
  };
}

/** 文本 → 分段数组（结构永远是 `{start, end}`，未填完的一侧为空串）。 */
export function parseHoursText(text) {
  return splitHoursText(text).map((segment) => {
    const parsed = parseHoursSegment(segment);
    return { start: parsed.start, end: parsed.end };
  });
}

export function formatHoursSegment(segment) {
  const source = segment && typeof segment === 'object' ? segment : {};
  const start = typeof source.start === 'string' ? source.start.trim() : '';
  const end = typeof source.end === 'string' ? source.end.trim() : '';
  return `${start}-${end}`;
}

export function formatHoursText(segments) {
  const list = Array.isArray(segments) ? segments : [];
  // 刚点「增加时段」的空行也要留下（序列化成 `-`），否则时间选择器整行消失、按钮看起来没反应。
  // 未填完的时段由 validateHoursSegments 报 HOURS_INCOMPLETE，不会静默当成合法时段。
  return list.map(formatHoursSegment).join(',');
}

export function toMinutes(value) {
  if (!isTimeText(value)) return null;
  const [hour, minute] = value.trim().split(':');
  return Number(hour) * 60 + Number(minute);
}

/**
 * 时段在一天内的坐标。
 * 跨午夜时段拆成两段区间，方便判重叠。
 */
export function segmentTimeline(segment) {
  const source = segment && typeof segment === 'object' ? segment : {};
  const startMinutes = toMinutes(source.start);
  const endMinutes = toMinutes(source.end);
  if (startMinutes === null || endMinutes === null) return null;
  const crossesMidnight = endMinutes < startMinutes;
  const minutes = crossesMidnight ? MINUTES_PER_DAY - startMinutes + endMinutes : endMinutes - startMinutes;
  return {
    startMinutes,
    endMinutes,
    crossesMidnight,
    minutes,
    ranges: crossesMidnight
      ? [
          [startMinutes, MINUTES_PER_DAY],
          [0, endMinutes],
        ]
      : [[startMinutes, endMinutes]],
  };
}

/** 统一的展示文案：跨午夜标「次日」。 */
export function describeHoursSegment(segment) {
  const source = segment && typeof segment === 'object' ? segment : {};
  const start = typeof source.start === 'string' ? source.start : '';
  const end = typeof source.end === 'string' ? source.end : '';
  if (!start || !end) return [start, end].filter(Boolean).join('–');
  const timeline = segmentTimeline(source);
  return timeline && timeline.crossesMidnight ? `${start}–次日 ${end}` : `${start}–${end}`;
}

export function describeHoursText(text) {
  return parseHoursText(text).map(describeHoursSegment).filter(Boolean).join('，');
}

function rangesIntersect(left, right) {
  return left[0] < right[1] && right[0] < left[1];
}

/** 找出互相重叠的时段对（含跨午夜与早间时段的重叠）。 */
export function findOverlappingPairs(segments) {
  const list = Array.isArray(segments) ? segments : [];
  const timelines = list.map(segmentTimeline);
  const pairs = [];
  for (let index = 0; index < timelines.length; index += 1) {
    for (let other = index + 1; other < timelines.length; other += 1) {
      const left = timelines[index];
      const right = timelines[other];
      if (!left || !right) continue;
      const hit = left.ranges.some((a) => right.ranges.some((b) => rangesIntersect(a, b)));
      if (hit) pairs.push([index, other]);
    }
  }
  return pairs;
}

export const HOURS_MESSAGES = Object.freeze({
  HOURS_INCOMPLETE: '这个时段还没选完开始或结束时间。',
  HOURS_FORMAT: '时间格式不对，请用 24 小时制 HH:MM，例如 10:00。',
  HOURS_SAME_TIME: '开始和结束时间不能相同，请改一下结束时间。',
  HOURS_TOO_MANY: `最多支持 ${MAX_HOURS_SEGMENTS} 个营业时段，请先删掉多余的时段。`,
});

/**
 * 营业时段校验（字段附近提示用的人话文案）。
 * @returns {{code: string, message: string, index: number|null}[]}
 */
export function validateHoursSegments(segments) {
  const list = Array.isArray(segments) ? segments : [];
  const problems = [];

  if (list.length > MAX_HOURS_SEGMENTS) {
    problems.push({ code: 'HOURS_TOO_MANY', message: HOURS_MESSAGES.HOURS_TOO_MANY, index: null });
  }

  list.forEach((segment, index) => {
    const source = segment && typeof segment === 'object' ? segment : {};
    const rawStart = typeof source.start === 'string' ? source.start.trim() : '';
    const rawEnd = typeof source.end === 'string' ? source.end.trim() : '';
    if (!rawStart || !rawEnd) {
      problems.push({
        code: 'HOURS_INCOMPLETE',
        message: `第 ${index + 1} 个时段还没选完：${HOURS_MESSAGES.HOURS_INCOMPLETE}`,
        index,
      });
      return;
    }
    if (!isTimeText(rawStart) || !isTimeText(rawEnd)) {
      problems.push({
        code: 'HOURS_FORMAT',
        message: `第 ${index + 1} 个时段${HOURS_MESSAGES.HOURS_FORMAT}`,
        index,
      });
      return;
    }
    if (rawStart === rawEnd) {
      problems.push({
        code: 'HOURS_SAME_TIME',
        message: `第 ${index + 1} 个时段${HOURS_MESSAGES.HOURS_SAME_TIME}`,
        index,
      });
    }
  });

  for (const [left, right] of findOverlappingPairs(list)) {
    problems.push({
      code: 'HOURS_OVERLAP',
      message: `第 ${left + 1} 段和第 ${right + 1} 段时间重叠了，请调整后再继续。`,
      index: right,
    });
  }

  return problems;
}

/** 只有「能真正营业」的时段才算数：两端都是合法时间且不相等。 */
export function countUsableSegments(segments) {
  const list = Array.isArray(segments) ? segments : [];
  return list.filter((segment) => {
    const source = segment && typeof segment === 'object' ? segment : {};
    return isTimeText(source.start) && isTimeText(source.end) && source.start !== source.end;
  }).length;
}
