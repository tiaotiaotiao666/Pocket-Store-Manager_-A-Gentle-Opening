/**
 * 模板候选与真实结构的对应关系（纯函数，单一事实来源）。
 *
 * 背景（B4 规则 1）：试用反馈里 3 张候选卡看起来像「三套不同的页面骨架」，
 * 但 `templates/registry` 里只有 `order-classic` 与 `order-poster` 两套已验证 Recipe，
 * `warm-bistro` 与 `modern-coffee` 共用 `order-classic`，差异只来自主题 Token 与
 * 候选自带的 layout 提示。这里把这件事**算出来**并给出可直接展示的人话，
 * 避免界面继续把「同一套结构的两种配色」说成两套骨架。
 *
 * 数据来源只有两处，本文件不新增事实：
 * - `./catalog.mjs`：候选模板（id/name/summary…）；
 * - `./recipeCatalog.mjs`：模板 → Recipe 映射与 Recipe 展示名。
 */

import { templates as catalogTemplates } from './catalog.mjs';
import { RECIPES, TEMPLATE_TO_RECIPE } from './recipeCatalog.mjs';

function ownKey(source, key) {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(source, key) ? key : null;
}

/** 候选模板的展示信息（只取有用字段，避免把 keywords 带进界面模型）。 */
function candidateOf(templateId) {
  const found = catalogTemplates.find((item) => item.id === templateId);
  if (!found) return { id: templateId, name: templateId, summary: '', layout: null };
  return {
    id: found.id,
    name: found.name,
    summary: found.summary || '',
    layout: found.layout || null,
  };
}

/**
 * 按真实 Recipe 分组的模板结构清单。
 *
 * @returns {Array<{recipeId:string, displayName:string, description:string,
 *   primaryId:string, members:Array<{id:string,name:string}>, isColorScheme:boolean}>}
 *   顺序按 `catalogTemplates` 出现顺序，保证界面顺序稳定。
 */
export function listTemplateStructures() {
  const order = [];
  const byRecipe = new Map();
  for (const template of catalogTemplates) {
    const recipeId = ownKey(TEMPLATE_TO_RECIPE, template.id) ? TEMPLATE_TO_RECIPE[template.id] : null;
    if (!recipeId) continue;
    if (!byRecipe.has(recipeId)) {
      order.push(recipeId);
      byRecipe.set(recipeId, []);
    }
    byRecipe.get(recipeId).push({ id: template.id, name: template.name });
  }
  return order.map((recipeId) => {
    const entry = ownKey(RECIPES, recipeId) ? RECIPES[recipeId] : null;
    const members = byRecipe.get(recipeId) || [];
    return {
      recipeId,
      displayName: entry ? entry.displayName : recipeId,
      description: entry ? entry.description : '',
      primaryId: members.length > 0 ? members[0].id : null,
      members,
      /** 同一结构下有多个候选 → 这些候选只是配色方案，不算独立模板。 */
      isColorScheme: members.length > 1,
    };
  });
}

/**
 * 单个候选模板在「真实结构」里的位置。
 *
 * @param {string|null|undefined} templateId
 * @returns {{recipeId:string, displayName:string, shared:boolean, memberCount:number,
 *   variantOf:string|null, badge:string|null, note:string}}
 */
export function describeTemplateStructure(templateId) {
  const structures = listTemplateStructures();
  const key = ownKey(TEMPLATE_TO_RECIPE, templateId) ? TEMPLATE_TO_RECIPE[templateId] : null;
  const structure = key ? structures.find((item) => item.recipeId === key) : null;
  if (!structure) {
    return {
      recipeId: null,
      displayName: null,
      shared: false,
      memberCount: 0,
      variantOf: null,
      badge: null,
      note: '还没有选择模板；导出会使用默认结构（经典点餐）。',
    };
  }
  const shared = structure.members.length > 1;
  return {
    recipeId: structure.recipeId,
    displayName: structure.displayName,
    shared,
    memberCount: structure.members.length,
    variantOf: shared ? structure.recipeId : null,
    badge: shared ? `${structure.displayName} · 配色方案` : structure.displayName,
    note: shared
      ? `「${candidateOf(templateId).name}」与同组候选共用「${structure.displayName}」这一套页面结构，只是配色与风格不同。`
      : `「${candidateOf(templateId).name}」使用独立的「${structure.displayName}」结构。`,
  };
}

/**
 * 模板页顶部的一句事实说明：真实独立结构有几套、哪些候选只是配色。
 *
 * @param {Array<string>} [visibleIds] 当前界面实际展示的候选；缺省用全部候选。
 * @returns {{structureCount:number, structureNames:Array<string>, text:string}}
 */
export function describeStructureCoverage(visibleIds) {
  const ids = Array.isArray(visibleIds) && visibleIds.length > 0
    ? visibleIds
    : catalogTemplates.map((item) => item.id);
  const structures = listTemplateStructures()
    .map((structure) => ({
      ...structure,
      members: structure.members.filter((member) => ids.includes(member.id)),
    }))
    .filter((structure) => structure.members.length > 0);
  const names = structures.map((structure) => structure.displayName);
  const sharedGroups = structures.filter((structure) => structure.members.length > 1);
  const sharedText = sharedGroups
    .map((structure) => `${structure.members.map((member) => `「${member.name}」`).join('与')}是「${structure.displayName}」的两种配色`)
    .join('；');
  return {
    structureCount: structures.length,
    structureNames: names,
    text: structures.length <= 1
      ? `当前只有「${names[0] || '经典点餐'}」这一套页面结构${sharedText ? `；${sharedText}` : ''}。`
      : `真实独立结构 ${structures.length} 套：${names.join('、')}${sharedText ? `；${sharedText}，不算额外模板` : ''}。`,
  };
}
