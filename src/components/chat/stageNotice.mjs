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
  analyze: { label: '识别截图与能力覆盖', hint: '正在读取参考截图；识别完成前不会写候选文件。' },
  materialize: { label: '写入私有候选工作区', hint: '候选只会写进应用私有 attempt 目录。' },
  compose: { label: 'Composer 校验', hint: '正在用确定性 Composer 与静态门禁校验候选。' },
  'mini-check': { label: '小程序静态校验', hint: '正在检查页面、组件与镜像结构。' },
  consistency: { label: '产物一致性检查', hint: '正在核对候选产物与 Lock/报告是否一致。' },
  observable: { label: '可观察项对照', hint: '只对照分区顺序、主题、组件、按钮与插槽锚点。' },
  verify: { label: '微信真实编译与截图', hint: '微信验证未完成前，候选不能被当作已验收。' },
  adopt: { label: '写入采用记录', hint: '只有通过门禁并确认后才写入采用记录。' },
  done: { label: '完成', hint: '本轮前端重构任务已结束。' },
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
