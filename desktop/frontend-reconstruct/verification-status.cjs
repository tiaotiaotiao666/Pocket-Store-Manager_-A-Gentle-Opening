'use strict';

/**
 * 微信验证总状态的唯一定义（P0：交互失败必须参与总状态）。
 *
 * 背景：`scripts/wechat-devtools-run.cjs` 原先只按 `pages` 计算 `status`，
 * `interactions` 里的 FAIL/BLOCKED 只被统计、不参与定级；`verify-runtime.cjs`
 * 同样只做统计。结果是「关键下单动作失败」也能显示成「验证通过」。
 *
 * 现在规则只写一份，两条链路共用：
 *   - 任一页面不是 PASS → FAIL（页面都打不开，谈不上通过）；
 *   - 任一交互 FAIL → FAIL（关键链路失败不能被降级成 PASS）；
 *   - 有阻断原因，或任一**关键**交互不是 PASS（BLOCKED / NOT_RUN）→ BLOCKED；
 *   - 其余 → PASS，非关键交互的非 PASS 结果进 `degraded`（如实展示，但不定级）。
 *
 * 「关键」标记是交互项上的 `critical` 字段：显式 `critical: false` 视为参考项；
 * 没有该字段的交互按关键项对待（外部/旧证据不会被静默降级为通过）。
 */

const STATUS = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  BLOCKED: 'BLOCKED',
  NOT_RUN: 'NOT_RUN',
});

const VALID_STATUSES = Object.freeze(Object.values(STATUS));

/** 未知/缺失状态一律降为 NOT_RUN：宁可"没跑"，也不默认通过。 */
function normalizeStatus(value) {
  return typeof value === 'string' && VALID_STATUSES.includes(value) ? value : STATUS.NOT_RUN;
}

function countByStatus(list) {
  const counts = { total: 0, PASS: 0, FAIL: 0, BLOCKED: 0, NOT_RUN: 0 };
  for (const item of Array.isArray(list) ? list : []) {
    counts.total += 1;
    counts[normalizeStatus(item && item.status)] += 1;
  }
  return counts;
}

function isCriticalInteraction(item) {
  return !(item && item.critical === false);
}

function labelOf(item, fallback) {
  const label = item && (item.label || item.id || item.route);
  return typeof label === 'string' && label ? label.slice(0, 120) : fallback;
}

/**
 * 计算一次微信验证的总状态。
 *
 * @param {{ blocked?: string|null, pages?: object[], interactions?: object[] }} report
 * @returns {{
 *   status: string,
 *   reason: string,
 *   pages: object,
 *   interactions: object,
 *   critical: { total: number, passed: number, failed: number, blocked: number, notRun: number },
 *   degraded: Array<{ label: string, status: string }>,
 *   failures: Array<{ kind: 'page'|'interaction', label: string, status: string, critical: boolean }>,
 * }}
 */
function computeVerificationStatus(report) {
  const source = report && typeof report === 'object' ? report : {};
  const pages = Array.isArray(source.pages) ? source.pages : [];
  const interactions = Array.isArray(source.interactions) ? source.interactions : [];
  const pageCounts = countByStatus(pages);
  const interactionCounts = countByStatus(interactions);

  const critical = { total: 0, passed: 0, failed: 0, blocked: 0, notRun: 0 };
  const degraded = [];
  const failures = [];

  for (const page of pages) {
    const status = normalizeStatus(page && page.status);
    if (status === STATUS.PASS) continue;
    failures.push({ kind: 'page', label: labelOf(page, '未命名页面'), status, critical: true });
  }

  for (const item of interactions) {
    const status = normalizeStatus(item && item.status);
    const isCritical = isCriticalInteraction(item);
    if (isCritical) {
      critical.total += 1;
      if (status === STATUS.PASS) critical.passed += 1;
      else if (status === STATUS.FAIL) critical.failed += 1;
      else if (status === STATUS.BLOCKED) critical.blocked += 1;
      else critical.notRun += 1;
    }
    if (status === STATUS.PASS) continue;
    if (status === STATUS.FAIL) {
      failures.push({ kind: 'interaction', label: labelOf(item, '未命名交互'), status, critical: isCritical });
      continue;
    }
    if (isCritical) {
      failures.push({ kind: 'interaction', label: labelOf(item, '未命名交互'), status, critical: true });
    } else {
      degraded.push({ label: labelOf(item, '未命名交互'), status });
    }
  }

  const base = {
    reason: '',
    pages: pageCounts,
    interactions: interactionCounts,
    critical,
    degraded,
    failures,
  };

  const blocked = typeof source.blocked === 'string' ? source.blocked.trim() : '';
  if (!blocked && pageCounts.total === 0 && interactionCounts.total === 0) {
    return { ...base, status: STATUS.NOT_RUN, reason: '没有任何页面或交互证据，不能判定通过' };
  }
  if (blocked) {
    return { ...base, status: STATUS.BLOCKED, reason: '工具层阻塞：' + blocked };
  }
  if (failures.some((item) => item.status === STATUS.FAIL || item.kind === 'page')) {
    const first = failures[0];
    return {
      ...base,
      status: STATUS.FAIL,
      reason: (first.kind === 'page' ? '页面未通过：' : '交互失败：') + first.label + '（' + first.status + '）',
    };
  }
  if (failures.length > 0) {
    const first = failures[0];
    return {
      ...base,
      status: STATUS.BLOCKED,
      reason: '关键交互未取得结论：' + first.label + '（' + first.status + '）',
    };
  }
  return { ...base, status: STATUS.PASS, reason: '页面与关键交互全部通过' };
}

module.exports = {
  STATUS,
  VALID_STATUSES,
  countByStatus,
  computeVerificationStatus,
  isCriticalInteraction,
  normalizeStatus,
};
