/**
 * 「等待确认」卡片每一行该去哪里确认（R3 问题 6）。
 *
 * 为什么单独一份：待确认项从来不自动写入，卡片唯一能做的事就是「把人带到
 * 真实的确认入口」。所以这里只回答两件事——这一项叫什么、原业务面板里
 * 哪个控件是它的确认入口（`data-jump-id`）+ 在哪个阶段。
 *
 * 边界：
 * - 只给定位信息，不产生任何写入、不触发点击、不代替用户确认；
 * - 没有任何入口时不编一个假按钮：`jumpId` 为 null，卡片如实说明去对应面板确认。
 */

/** 动作请求 → 原业务面板里的真实确认入口（阶段取该面板所在阶段）。 */
const ACTION_TARGETS = Object.freeze({
  // 门店资料：确认按钮 + 结构化草稿表单
  'agentDraft.confirm': { jumpId: 'store-info-confirm', phase: 'store-info' },
  'asset.attach-store-image': { jumpId: 'store-info-form', phase: 'store-info' },
  // 模板：选择 / 对话修改
  'template.select': { jumpId: 'template-apply', phase: 'template-pick' },
  'template.revise': { jumpId: 'template-revise', phase: 'template-pick' },
  // 参考图候选
  'frontend.reconstruct': { jumpId: 'frontend-candidates', phase: 'image-review' },
  'frontend.adopt': { jumpId: 'frontend-candidates', phase: 'image-review' },
  'frontend.discard': { jumpId: 'frontend-candidates', phase: 'image-review' },
  // 导出：体检面板 + 导出按钮
  'export.preflight': { jumpId: 'export-preflight', phase: 'deploy' },
  'export.choose-directory': { jumpId: 'deploy-start', phase: 'deploy' },
  'export.run': { jumpId: 'deploy-start', phase: 'deploy' },
});

/** 字段类高风险项（清空、改写已选功能等）的确认入口：门店资料表单。 */
const FIELD_TARGET = Object.freeze({ jumpId: 'store-info-form', phase: 'store-info' });

/** 删菜：定位到菜品区，那里才有真实的删除按钮。 */
const DISH_TARGET = Object.freeze({ jumpId: 'store-dishes', phase: 'store-info' });

/**
 * 卡片顶部说明：这些改动都还没有写入。
 *
 * 文案唯一一份，组件与测试共用，避免两处说法不一致。
 */
export const PENDING_CONFIRM_NOTE =
  '这些修改都还没有写入项目。点「前往确认」只会带你到对应面板并高亮，写入仍要你自己在那里点确认。';

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 把待确认摘要翻译成卡片上可显示、可定位的条目。
 *
 * @param {{fields?: Array, actions?: Array}|null} pending 桌面 reducer 登记的待确认摘要
 * @param {{fieldLabel?: Function, actionLabel?: Function}} [lookups] 标签查询（由 App 注入，domain 不反向依赖服务层）
 * @returns {Array<{key: string, kind: 'field'|'action', title: string, detail: string, jumpId: string|null, phase: string|null}>}
 */
export function describePendingConfirmations(pending, lookups = {}) {
  const fieldLabel = typeof lookups.fieldLabel === 'function' ? lookups.fieldLabel : () => '';
  const actionLabel = typeof lookups.actionLabel === 'function' ? lookups.actionLabel : () => '';
  const fields = pending && Array.isArray(pending.fields) ? pending.fields : [];
  const actions = pending && Array.isArray(pending.actions) ? pending.actions : [];
  const items = [];

  fields.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return;
    const op = text(entry.op);
    const fieldId = text(entry.fieldId);
    const isDishRemove = op === 'dish.remove';
    const target = isDishRemove ? DISH_TARGET : FIELD_TARGET;
    const label = text(fieldLabel(fieldId));
    items.push({
      key: `field:${text(entry.opId) || index}`,
      kind: 'field',
      title: isDishRemove ? '删除菜品' : (label ? `${label}的改动` : '门店资料改动'),
      detail: isDishRemove
        ? '这条删除还没执行：菜品仍在菜单里，需要你在菜品区自己删。'
        : '这项改动会清空或改写已有内容，还没有写入。',
      jumpId: target.jumpId,
      phase: target.phase,
    });
  });

  actions.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return;
    const actionId = text(entry.actionId);
    const target = ACTION_TARGETS[actionId] || null;
    const label = text(actionLabel(actionId));
    const reason = text(entry.reason);
    const unavailable = entry.status === 'unavailable';
    items.push({
      key: `action:${text(entry.opId) || index}`,
      kind: 'action',
      title: label || '需要你确认的操作',
      detail: reason || (unavailable ? '当前条件下还做不到这项操作。' : '这项操作需要你在原业务面板确认后执行。'),
      jumpId: target ? target.jumpId : null,
      phase: target ? target.phase : null,
    });
  });

  return items;
}
