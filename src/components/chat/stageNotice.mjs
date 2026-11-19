/**
 * UX0a-2：系统/交接消息的展示文案只来自这张受控表。
 *
 * 硬约束：这里绝不读取消息正文 —— 交接正文、Markdown、payload、字段名
 * 都属于内部数据，可以持久化，但不能被截取成用户文案。
 */

const STAGE_NOTICES = Object.freeze({
  '店铺资料': { label: '店铺资料', hint: '请确认资料后继续。' },
  '店铺装修': { label: '店铺装修', hint: '选好风格后进入下一步。' },
  '部署小程序': { label: '导出小程序', hint: '选择导出位置后生成工程。' },
});

/**
 * P6：图片驱动前端重构的受控阶段文案。
 *
 * 键来自主进程真实 `frontend:progress` 的 stage（analyze/materialize/compose/...），
 * 文案只在这张表里维护；绝不读取系统消息正文。`meta.stage` 使用 `frontend:<stage>`
 * 前缀，或 `meta.frontendStage=<stage>`，避免与既有交接阶段混淆。
 */
const FRONTEND_STAGE_NOTICES = Object.freeze({
  analyze: { label: '识别截图与页面能力', hint: '正在读取参考截图；识别完成前不会写候选文件。' },
  materialize: { label: '准备候选文件', hint: '候选只会写进应用自己的目录。' },
  compose: { label: '检查页面结构', hint: '正在按固定规则检查候选页面能否正常生成。' },
  'mini-check': { label: '检查小程序结构', hint: '正在检查页面、组件与结构是否完整。' },
  consistency: { label: '核对导出内容', hint: '正在核对候选页面与最终导出是否一致。' },
  observable: { label: '核对页面细节', hint: '只对照分区顺序、配色、组件、按钮与位置。' },
  verify: { label: '在微信开发者工具里试跑', hint: '微信里没验证通过前，候选不能当作已验收。' },
  adopt: { label: '记录采用结果', hint: '只有检查通过并确认后才会采用。' },
  done: { label: '完成', hint: '本轮页面生成已结束。' },
});

const FALLBACK_NOTICE = Object.freeze({ label: '进行中', hint: '请按提示继续。' });

function frontendNoticeFor(stage) {
  const key = typeof stage === 'string' ? stage.replace(/^frontend:/, '') : '';
  return FRONTEND_STAGE_NOTICES[key] || null;
}

/** 只认受控的前端阶段标识，其余一律落到固定兜底文案。 */
export function frontendStageNotice(stage) {
  const matched = frontendNoticeFor(stage);
  if (!matched) return { label: FALLBACK_NOTICE.label, hint: FALLBACK_NOTICE.hint, known: false };
  return { label: matched.label, hint: matched.hint, known: true };
}

/** 只认受控的阶段标识，其余一律落到固定兜底文案。 */
export function stageNoticeFor(message) {
  const meta = (message && message.meta) || {};
  const key = typeof meta.stage === 'string' && meta.stage
    ? meta.stage
    : (typeof meta.to === 'string' ? meta.to : '');
  const matched = STAGE_NOTICES[key];
  if (matched) return { label: matched.label, hint: matched.hint, known: true };

  const frontendKey = typeof meta.frontendStage === 'string'
    ? `frontend:${meta.frontendStage}`
    : (key.startsWith('frontend:') ? key : '');
  const frontend = frontendNoticeFor(frontendKey);
  if (frontend) return { label: frontend.label, hint: frontend.hint, known: true };

  return { label: FALLBACK_NOTICE.label, hint: FALLBACK_NOTICE.hint, known: false };
}

export const STAGE_NOTICE_LABELS = Object.freeze(
  Object.fromEntries(Object.entries(STAGE_NOTICES).map(([key, value]) => [key, value.label])),
);

export const FRONTEND_STAGE_NOTICE_LABELS = Object.freeze(
  Object.fromEntries(Object.entries(FRONTEND_STAGE_NOTICES).map(([key, value]) => [`frontend:${key}`, value.label])),
);
