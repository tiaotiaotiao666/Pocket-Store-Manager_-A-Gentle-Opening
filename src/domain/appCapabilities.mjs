import { AGENT_DRAFT_LIMITS, normalizeBusinessHoursText, validateAgentDraft, createEmptyAgentDraft } from './agentDraft.mjs';
import { STYLE_PRESETS } from './storeBrief.mjs';
import { features as FEATURE_CATALOG } from './catalog.mjs';

/**
 * 应用能力目录（`app-capabilities.v1`）——前端唯一事实源。
 *
 * 定位：
 * - 统一会话 Agent 能改什么、值域与确认级别**只在这里定义一次**；
 * - 服务端只读由本文件生成的快照（`scripts/app-capabilities.cjs`），不手抄第二份数值；
 * - 目录是纯 JSON 可序列化数据，函数/动作实现不进入目录。
 *
 * 数值必须引用现有领域常量（`AGENT_DRAFT_LIMITS`、`STYLE_PRESETS`、`catalog.features`），
 * 不允许在本文件里重新写字面量，否则与表单校验会分叉。
 */

export const APP_CAPABILITIES_VERSION = 'app-capabilities.v1';

const MAX_ADDRESS = 120;
const MAX_PHONE = 32;
const MAX_NOTES = 200;
const MAX_VISUAL_PROMPT = 2000;
const MAX_FEATURES_CUSTOM = 500;
const MAX_STORE_IMAGES = 6;

const STYLE_IDS = Object.freeze(STYLE_PRESETS.map((preset) => preset.id));
const FEATURE_IDS = Object.freeze(FEATURE_CATALOG.map((item) => item.id));
const REQUIRED_FEATURE_IDS = Object.freeze(FEATURE_CATALOG.filter((item) => item.required).map((item) => item.id));

/** 只读上下文，不可通过任何字段修改写入（只出现在项目上下文里）。 */
export const APP_READ_ONLY_FIELD_IDS = Object.freeze([
  'build.candidates',
  'build.screenRef',
  'build.frontendCandidate',
  'deploy.result',
]);

/** 永久排除：非项目业务字段或秘密。 */
export const APP_DENIED_FIELD_PREFIXES = Object.freeze([
  'settings.',
  'agentChat.',
  'deploy.directory',
  'unmappedFields',
  'secret.',
]);

const FIELDS = Object.freeze([
  {
    fieldId: 'store.name',
    label: '店名',
    type: 'string',
    writeMode: 'field.set',
    writable: true,
    risk: 'auto',
    confirmWhenEmpty: true,
    limits: { minChars: 0, maxChars: AGENT_DRAFT_LIMITS.maxStoreName },
    writeback: { agentDraft: 'storeName', store: 'name' },
  },
  {
    fieldId: 'store.category',
    label: '品类',
    type: 'string',
    writeMode: 'field.set',
    writable: true,
    risk: 'auto',
    confirmWhenEmpty: true,
    limits: { minChars: 0, maxChars: AGENT_DRAFT_LIMITS.maxCategory },
    writeback: { agentDraft: 'category', store: 'type' },
  },
  {
    fieldId: 'store.businessHours',
    label: '营业时间',
    type: 'hours',
    writeMode: 'field.set',
    writable: true,
    risk: 'auto',
    confirmWhenEmpty: true,
    limits: { maxChars: 120, maxSegments: AGENT_DRAFT_LIMITS.maxHoursSegments, format: 'HH:MM-HH:MM，多段用英文逗号；结束早于开始表示营业到次日' },
    writeback: { agentDraft: 'businessHours' },
  },
  {
    fieldId: 'store.fulfillment',
    label: '取餐方式',
    type: 'fulfillment',
    writeMode: 'field.set',
    writable: true,
    risk: 'auto',
    limits: { keys: ['dineIn', 'takeaway'], atLeastOneForReview: true },
    writeback: { agentDraft: 'fulfillment' },
  },
  {
    fieldId: 'store.dishes',
    label: '菜品',
    type: 'dish.list',
    writeMode: 'ops',
    writable: false,
    risk: 'auto',
    limits: {
      minDishes: AGENT_DRAFT_LIMITS.minDishes,
      maxDishes: AGENT_DRAFT_LIMITS.maxDishes,
      maxNameChars: AGENT_DRAFT_LIMITS.maxDishName,
      maxDescriptionChars: AGENT_DRAFT_LIMITS.maxDescription,
      minPriceCents: AGENT_DRAFT_LIMITS.minPriceCents,
      maxPriceCents: AGENT_DRAFT_LIMITS.maxPriceCents,
    },
    ops: ['dish.upsert', 'dish.remove'],
    writeback: { agentDraft: 'dishes' },
    note: '新增/更新走 dish.upsert，删除走 dish.remove（需确认）；不能对菜品使用 field.set。',
  },
  {
    fieldId: 'store.address',
    label: '门店地址',
    type: 'string',
    writeMode: 'field.set',
    writable: true,
    risk: 'auto',
    limits: { maxChars: MAX_ADDRESS },
    writeback: { store: 'address' },
  },
  {
    fieldId: 'store.phone',
    label: '联系电话',
    type: 'string',
    writeMode: 'field.set',
    writable: true,
    risk: 'auto',
    limits: { maxChars: MAX_PHONE },
    writeback: { store: 'phone' },
    note: '只做长度/字符合法性校验，不猜测真实号码。',
  },
  {
    fieldId: 'store.notes',
    label: '门店说明',
    type: 'string',
    writeMode: 'field.set',
    writable: true,
    risk: 'auto',
    limits: { maxChars: MAX_NOTES },
    writeback: { store: 'notes' },
    note: '只记录用户提供或明确要求代拟的文案，不新写旧版 intro。',
  },
  {
    fieldId: 'visual.styleId',
    label: '装修风格',
    type: 'enum',
    writeMode: 'field.set',
    writable: true,
    risk: 'auto',
    options: STYLE_IDS,
    writeback: { visual: 'styleId' },
    note: '切换风格会清空展示补丁里的 theme，与 SET_STYLE 语义一致。',
  },
  {
    fieldId: 'visual.prompt',
    label: '视觉偏好说明',
    type: 'string',
    writeMode: 'field.set',
    writable: true,
    risk: 'auto',
    limits: { maxChars: MAX_VISUAL_PROMPT },
    writeback: { visual: 'prompt' },
    note: '只写用户偏好或图片可观察事实，不写入 base64、URL 或绝对路径。',
  },
  {
    fieldId: 'store.imageAssetIds',
    label: '门店环境图引用',
    type: 'assetId.list',
    writeMode: 'action',
    writable: false,
    risk: 'confirm',
    limits: { maxItems: MAX_STORE_IMAGES },
    actions: ['asset.attach-store-image'],
    writeback: { store: 'imageAssetIds' },
  },
  {
    fieldId: 'visual.imageAssetId',
    label: '海报素材引用',
    type: 'assetId',
    writeMode: 'action',
    writable: false,
    risk: 'confirm',
    actions: ['asset.attach-store-image'],
    writeback: { visual: 'imageAssetId' },
  },
  {
    fieldId: 'features.selected',
    label: '启用功能',
    type: 'featureId.list',
    writeMode: 'field.set',
    writable: true,
    risk: 'auto',
    options: FEATURE_IDS,
    required: REQUIRED_FEATURE_IDS,
    writeback: { features: 'selected' },
    note: '只影响模板推荐，不会从 Base 工程移除未勾选的内置能力；required 功能不可移除。',
  },
  {
    fieldId: 'features.custom',
    label: '定制要求',
    type: 'string',
    writeMode: 'field.set',
    writable: true,
    risk: 'auto',
    limits: { maxChars: MAX_FEATURES_CUSTOM },
    writeback: { features: 'custom' },
  },
  {
    fieldId: 'project.appid',
    label: '小程序 AppID',
    type: 'appid',
    writeMode: 'field.set',
    writable: true,
    risk: 'confirm',
    limits: { pattern: '^wx[0-9a-fA-F]{16}$' },
    writeback: { project: 'appid' },
  },
]);

const ACTIONS = Object.freeze([
  { actionId: 'navigate.phase', label: '切换阶段', risk: 'auto', params: { phase: 'string' } },
  { actionId: 'template.select', label: '选择模板', risk: 'confirm', params: { templateId: 'string' } },
  { actionId: 'template.revise', label: '对话修改当前模板', risk: 'auto', params: { utterance: 'string' } },
  { actionId: 'frontend.reconstruct', label: '生成参考图候选', risk: 'confirm', params: { targetPage: 'home|menu|profile' } },
  { actionId: 'frontend.adopt', label: '采用前端候选', risk: 'confirm', params: { templateId: 'string' } },
  { actionId: 'frontend.discard', label: '放弃前端候选', risk: 'confirm', params: {} },
  { actionId: 'agentDraft.confirm', label: '确认门店资料', risk: 'confirm', params: {} },
  { actionId: 'export.preflight', label: '导出前体检', risk: 'auto', params: {} },
  { actionId: 'export.choose-directory', label: '选择导出目录', risk: 'confirm', params: {} },
  { actionId: 'export.run', label: '导出小程序工程', risk: 'confirm', params: {} },
  { actionId: 'asset.attach-store-image', label: '保存门店图片素材', risk: 'confirm', params: { attachmentId: 'string', target: 'store|visual' } },
]);

/** 附件用途（统一入口全阶段可用）。 */
export const APP_ATTACHMENT_PURPOSES = Object.freeze(['auto', 'menu', 'store', 'reference']);

/**
 * 构造能力目录。返回值必须是可 JSON 序列化的纯数据（不含函数）。
 */
export function buildAppCapabilityCatalog() {
  return {
    catalogVersion: APP_CAPABILITIES_VERSION,
    fields: FIELDS.map((field) => ({ ...field })),
    actions: ACTIONS.map((action) => ({ ...action })),
    attachmentPurposes: [...APP_ATTACHMENT_PURPOSES],
    deniedFieldIdPrefixes: [...APP_DENIED_FIELD_PREFIXES],
    readOnlyFieldIds: [...APP_READ_ONLY_FIELD_IDS],
    riskPolicy: '桌面 catalog 决定确认级别；模型传 requiresApproval=false 无效。',
  };
}

/** 按 fieldId 查能力；不存在返回 null。 */
export function findAppCapabilityField(fieldId) {
  const id = typeof fieldId === 'string' ? fieldId.trim() : '';
  if (!id) return null;
  return FIELDS.find((field) => field.fieldId === id) ?? null;
}

/** 某个 fieldId 属于「可写 / 只读 / 禁止 / 未知」。 */
export function classifyFieldId(fieldId) {
  const id = typeof fieldId === 'string' ? fieldId.trim() : '';
  if (!id) return 'unknown';
  if (APP_DENIED_FIELD_PREFIXES.some((prefix) => id.startsWith(prefix))) return 'denied';
  if (APP_READ_ONLY_FIELD_IDS.includes(id)) return 'readonly';
  const field = findAppCapabilityField(id);
  if (!field) return 'unknown';
  return field.writable || field.writeMode === 'ops' || field.writeMode === 'action' ? 'writable' : 'readonly';
}

export function findAppCapabilityAction(actionId) {
  const id = typeof actionId === 'string' ? actionId.trim() : '';
  if (!id) return null;
  return ACTIONS.find((action) => action.actionId === id) ?? null;
}

function codePointLength(value) {
  return Array.from(value).length;
}

function invalid(code, message) {
  return { ok: false, code, message };
}

/**
 * 校验单个字段值（桌面端与目录同源）。
 *
 * 只做「值本身」的类型/长度/选项校验；是否需要确认、是否清空已有值由调用方结合当前值判断。
 *
 * @param {string} fieldId
 * @param {unknown} value
 * @returns {{ok: true, value: unknown} | {ok: false, code: string, message: string}}
 */
export function validateCapabilityFieldValue(fieldId, value) {
  const field = findAppCapabilityField(fieldId);
  if (!field) return invalid('APP_ASSISTANT_FIELD_UNKNOWN', `未知字段 ${fieldId}。`);
  if (field.writeMode !== 'field.set') {
    return invalid('APP_ASSISTANT_OPERATION_DENIED', `${field.label}不能直接用 field.set 写入。`);
  }

  switch (field.type) {
    case 'string': {
      if (typeof value !== 'string') return invalid('APP_ASSISTANT_VALUE_INVALID', `${field.label}必须是文本。`);
      const trimmed = value.trim();
      const max = field.limits?.maxChars ?? 0;
      if (max && codePointLength(trimmed) > max) {
        return invalid('APP_ASSISTANT_VALUE_INVALID', `${field.label}不能超过 ${max} 个字。`);
      }
      // 空值是合法提案（用于清空已有值），但必须经桌面确认后再写入；
      // 确认级别由 buildProposalApplyPlan 依据 confirmWhenEmpty 决定，不在这里拒绝。
      return { ok: true, value: field.fieldId === 'store.businessHours' ? normalizeBusinessHoursText(trimmed) : trimmed };
    }
    case 'hours': {
      if (typeof value !== 'string') return invalid('APP_ASSISTANT_VALUE_INVALID', '营业时间必须是文本。');
      const normalized = normalizeBusinessHoursText(value);
      if (!normalized) return invalid('APP_ASSISTANT_VALUE_INVALID', '营业时间不能为空。');
      if (codePointLength(normalized) > 120) return invalid('APP_ASSISTANT_VALUE_INVALID', '营业时间过长。');
      const validation = validateAgentDraft({ ...createEmptyAgentDraft(), businessHours: normalized });
      const problem = validation.errors.find((item) => item.field === 'businessHours');
      if (problem) return invalid('APP_ASSISTANT_VALUE_INVALID', problem.message);
      return { ok: true, value: normalized };
    }
    case 'fulfillment': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return invalid('APP_ASSISTANT_VALUE_INVALID', '取餐方式必须是对象。');
      }
      const keys = Object.keys(value);
      if (keys.some((key) => key !== 'dineIn' && key !== 'takeaway')) {
        return invalid('APP_ASSISTANT_VALUE_INVALID', '取餐方式只包含 dineIn / takeaway。');
      }
      if (typeof value.dineIn !== 'boolean' && typeof value.takeaway !== 'boolean') {
        return invalid('APP_ASSISTANT_VALUE_INVALID', '取餐方式至少包含一个布尔值。');
      }
      return {
        ok: true,
        value: {
          ...(typeof value.dineIn === 'boolean' ? { dineIn: value.dineIn } : {}),
          ...(typeof value.takeaway === 'boolean' ? { takeaway: value.takeaway } : {}),
        },
      };
    }
    case 'enum': {
      if (typeof value !== 'string' || !field.options.includes(value)) {
        return invalid('APP_ASSISTANT_VALUE_INVALID', `${field.label}只能是 ${field.options.join(' / ')}。`);
      }
      return { ok: true, value };
    }
    case 'featureId.list': {
      if (!Array.isArray(value)) return invalid('APP_ASSISTANT_VALUE_INVALID', '功能选择必须是数组。');
      const ids = [];
      for (const item of value) {
        if (typeof item !== 'string' || !FEATURE_IDS.includes(item)) {
          return invalid('APP_ASSISTANT_VALUE_INVALID', `未知功能 ${String(item)}。`);
        }
        if (!ids.includes(item)) ids.push(item);
      }
      const missing = REQUIRED_FEATURE_IDS.filter((id) => !ids.includes(id));
      if (missing.length) return invalid('APP_ASSISTANT_VALUE_INVALID', `必需功能不可移除：${missing.join('、')}。`);
      return { ok: true, value: ids };
    }
    case 'appid': {
      if (typeof value !== 'string' || !/^wx[0-9a-fA-F]{16}$/.test(value.trim())) {
        return invalid('APP_ASSISTANT_VALUE_INVALID', 'AppID 必须是 wx 加 16 位十六进制。');
      }
      return { ok: true, value: value.trim() };
    }
    default:
      return invalid('APP_ASSISTANT_OPERATION_DENIED', `${field.label}不支持直接写入。`);
  }
}

export const APP_CAPABILITY_LIMITS = Object.freeze({
  maxAddressChars: MAX_ADDRESS,
  maxPhoneChars: MAX_PHONE,
  maxNotesChars: MAX_NOTES,
  maxVisualPromptChars: MAX_VISUAL_PROMPT,
  maxFeaturesCustomChars: MAX_FEATURES_CUSTOM,
  maxStoreImages: MAX_STORE_IMAGES,
  styleIds: STYLE_IDS,
  featureIds: FEATURE_IDS,
  requiredFeatureIds: REQUIRED_FEATURE_IDS,
});

/** 稳定的 FNV-1a 32 位摘要（浏览器与 Node 都可用，不依赖 crypto）。 */
export function capabilitiesDigest(text) {
  let hash = 0x811c9dc5;
  const source = String(text ?? '');
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** 服务端只读快照的完整内容（脚本 --write / --check 共用）。 */
export function buildAppCapabilitySnapshot() {
  const catalog = buildAppCapabilityCatalog();
  const body = JSON.stringify(catalog);
  return {
    contractVersion: 'app-capabilities-snapshot.v1',
    catalogVersion: APP_CAPABILITIES_VERSION,
    digest: capabilitiesDigest(body),
    catalog,
  };
}