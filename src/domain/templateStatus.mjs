/**
 * P2：模板页与参考截图的状态标签。
 *
 * 目标是把四件事说清楚，避免用户误以为「参考截图已经覆盖了当前版本」：
 * - 当前使用：现在真正在预览/导出里生效的那套；
 * - 候选模板：可选但还没生效；
 * - 已采用：由参考截图生成、并且已被采用（会同时是「当前使用」）；
 * - 已放弃：参考截图候选被放弃，只剩痕迹，不参与导出。
 *
 * 这里只做纯函数投影，不改动 Recipe / 模板 id 语义。
 */
export const TEMPLATE_STATUS = Object.freeze({
  CURRENT: 'current',
  CANDIDATE: 'candidate',
  ADOPTED: 'adopted',
  DISCARDED: 'discarded',
});

const LABELS = Object.freeze({
  current: '当前使用',
  candidate: '候选模板',
  adopted: '已采用',
  discarded: '已放弃',
});

const TONES = Object.freeze({
  current: 'current',
  candidate: 'candidate',
  adopted: 'adopted',
  discarded: 'discarded',
});

export function templateStatusLabel(key) {
  return LABELS[key] ?? LABELS.candidate;
}

/**
 * 参考截图的固定前缀：任何来源是截图的模板都必须带「参考截图 · 候选」这类标注。
 * 只有在真的被采用之后，才允许出现「已采用」。
 */
export function screenReferenceTag({ adopted = false, discarded = false } = {}) {
  if (adopted) return '参考截图 · 已采用';
  if (discarded) return '参考截图 · 已放弃';
  return '参考截图 · 候选';
}

/**
 * 一张模板卡的状态。
 *
 * @param {{id:string}} template
 * @param {{selectedId?:string|null, screenRef?:{adopted?:boolean, discarded?:boolean,
 *   templateId?:string|null}|null}} context
 * @returns {{key:string,label:string,tone:string,isCurrent:boolean,isReference:boolean,
 *   referenceTag:string|null,note:string}}
 */
export function describeTemplateStatus(template, context = {}) {
  const item = template && typeof template === 'object' ? template : {};
  const selectedId = context.selectedId ?? null;
  const screenRef = context.screenRef && typeof context.screenRef === 'object' ? context.screenRef : null;
  const referenceTemplateId = screenRef && typeof screenRef.templateId === 'string' ? screenRef.templateId : null;
  const isReference = Boolean(referenceTemplateId) && item.id === referenceTemplateId;
  const referenceTag = isReference
    ? screenReferenceTag({ adopted: screenRef.adopted === true, discarded: screenRef.discarded === true })
    : null;

  let key = TEMPLATE_STATUS.CANDIDATE;
  if (isReference && screenRef.discarded === true && !screenRef.adopted) {
    key = TEMPLATE_STATUS.DISCARDED;
  } else if (isReference && screenRef.adopted === true) {
    key = TEMPLATE_STATUS.ADOPTED;
  } else if (item.id === selectedId) {
    key = TEMPLATE_STATUS.CURRENT;
  }

  const note = key === TEMPLATE_STATUS.DISCARDED
    ? '已放弃这条参考候选，当前版本没有被改动'
    : (key === TEMPLATE_STATUS.ADOPTED
      ? '由参考截图生成，已替换当前版本，可继续微调'
      : (key === TEMPLATE_STATUS.CURRENT
        ? '预览与导出都用这一套'
        : '可切换查看，切换才会改变当前版本'));

  return {
    key,
    label: templateStatusLabel(key),
    tone: TONES[key] ?? 'candidate',
    isCurrent: item.id === selectedId && key !== TEMPLATE_STATUS.DISCARDED,
    isReference,
    referenceTag,
    note,
  };
}

/** 模板页顶部的一句话状态说明，避免用户只看到徽标却不知道差别。 */
export function describeGalleryLegend({ selectedName = null, referencePending = false } = {}) {
  const current = selectedName ? `当前使用：${selectedName}` : '还没有选定模板';
  return {
    current,
    hint: referencePending
      ? '参考截图生成的是「候选」，确认并采用后才会替换当前版本。'
      : '候选模板可以随意切换查看，只有点「就用这套」才会改变当前版本。',
  };
}
