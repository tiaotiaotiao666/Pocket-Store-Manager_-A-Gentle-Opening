/**
 * UX0a-2：系统/交接消息的展示文案只来自这张受控表。
 *
 * 硬约束：这里绝不读取 message.text —— 交接正文、Markdown、payload、字段名
 * 都属于内部数据，可以持久化，但不能被截取成用户文案。
 */

const STAGE_NOTICES = Object.freeze({
  '店铺资料': { label: '店铺资料', hint: '请确认资料后继续。' },
  '店铺装修': { label: '店铺装修', hint: '选好风格后进入下一步。' },
  '部署小程序': { label: '导出小程序', hint: '选择导出位置后生成工程。' },
});

const FALLBACK_NOTICE = Object.freeze({ label: '进行中', hint: '请按提示继续。' });

/** 只认受控的阶段标识，其余一律落到固定兜底文案。 */
export function stageNoticeFor(message) {
  const meta = (message && message.meta) || {};
  const key = typeof meta.stage === 'string' && meta.stage
    ? meta.stage
    : (typeof meta.to === 'string' ? meta.to : '');
  const matched = STAGE_NOTICES[key];
  if (!matched) {
    return { label: FALLBACK_NOTICE.label, hint: FALLBACK_NOTICE.hint, known: false };
  }
  return { label: matched.label, hint: matched.hint, known: true };
}

export const STAGE_NOTICE_LABELS = Object.freeze(
  Object.fromEntries(Object.entries(STAGE_NOTICES).map(([key, value]) => [key, value.label])),
);
