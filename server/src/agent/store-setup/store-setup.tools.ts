/**
 * 开店资料 Agent 的工具集。
 *
 * 每次 run 创建独立的 session，草稿只存在内存中，绝不落库；
 * 工具只做“读快照 / 应用白名单补丁”，校验统一交给 agent-draft.validator。
 */

import {
  AGENT_DRAFT_LIMITS,
  applyDraftPatch,
  buildNextQuestion,
  projectContractDraft,
  validateInternalDraft,
} from '../agent-draft.validator';
import type { InternalDraft } from '../agent.types';
import type { JsonObject, JsonSchema, JsonValue } from '../runtime/json-schema';
import { defineTool } from '../runtime/tool-registry';
import type { AgentTool } from '../runtime/tool-registry';

export const GET_STORE_DRAFT_TOOL = 'get_store_draft';
export const UPDATE_STORE_DRAFT_TOOL = 'update_store_draft';

export const STORE_SETUP_TOOL_NAMES = Object.freeze([
  GET_STORE_DRAFT_TOOL,
  UPDATE_STORE_DRAFT_TOOL,
] as const);

export interface StoreSetupSession {
  draft: InternalDraft;
}

export function createStoreSetupSession(initialDraft: InternalDraft): StoreSetupSession {
  return { draft: initialDraft };
}

/**
 * 补丁 schema 与 applyDraftPatch 的白名单严格对齐：
 * - 顶层 additionalProperties=false，未知字段会被执行器在 schema 层拒绝；
 * - 所有字段可选，但每道菜必须带 name（按 id 或 name 局部合并）；
 * - 价格只接受整数分或 null，不接受字符串，避免“28.5 元”这类歧义。
 */
export const STORE_DRAFT_PATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  description: '要写入的草稿字段；只传本轮明确提供的信息。',
  properties: {
    storeName: {
      type: 'string',
      minLength: 1,
      maxLength: AGENT_DRAFT_LIMITS.maxStoreName,
      description: '店名，最多 48 个字。',
    },
    category: {
      type: 'string',
      minLength: 1,
      maxLength: AGENT_DRAFT_LIMITS.maxCategory,
      description: '品类，最多 24 个字。',
    },
    businessHours: {
      type: 'string',
      minLength: 1,
      maxLength: 80,
      description: '营业时间，格式 HH:MM-HH:MM；最多 3 段，用英文逗号分隔；结束早于开始表示营业到次日（如 22:00-02:00）。',
    },
    fulfillment: {
      type: 'object',
      additionalProperties: false,
      description: '取餐方式；只传需要改变的布尔值。',
      properties: {
        dineIn: { type: 'boolean', description: '是否支持堂食。' },
        takeaway: { type: 'boolean', description: '是否支持到店自取。' },
      },
    },
    dishes: {
      type: 'array',
      minItems: 1,
      maxItems: AGENT_DRAFT_LIMITS.maxDishes,
      description: '新增或局部更新菜品；按 id 或 name 匹配已有菜品。',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name'],
        properties: {
          id: {
            type: 'string',
            minLength: 1,
            maxLength: 32,
            description: '已有菜品的本地标识；新增菜品时省略。',
          },
          name: {
            type: 'string',
            minLength: 1,
            maxLength: AGENT_DRAFT_LIMITS.maxDishName,
            description: '菜名，最多 24 个字。',
          },
          priceCents: {
            type: ['integer', 'null'],
            minimum: AGENT_DRAFT_LIMITS.minPriceCents,
            maximum: AGENT_DRAFT_LIMITS.maxPriceCents,
            description: '价格，整数分；例如 28 元写作 2800，未知时传 null。',
          },
          description: {
            type: 'string',
            maxLength: AGENT_DRAFT_LIMITS.maxDescription,
            description: '菜品描述，最多 60 个字。',
          },
        },
      },
    },
  },
} satisfies JsonSchema;

export function createStoreSetupTools(session: StoreSetupSession): AgentTool[] {
  const getStoreDraft = defineTool<JsonObject>({
    name: GET_STORE_DRAFT_TOOL,
    title: '读取开店草稿',
    description: '读取当前开店资料草稿、缺失字段、校验错误与下一个要追问的问题。修改前先调用。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    sideEffect: 'read',
    execute: async () => buildSnapshot(session),
  });

  const updateStoreDraft = defineTool<JsonObject>({
    name: UPDATE_STORE_DRAFT_TOOL,
    title: '更新开店草稿',
    description:
      '把本轮用户明确提供的开店资料写入草稿。只传需要更新的字段；返回服务端权威校验结果。',
    parameters: STORE_DRAFT_PATCH_SCHEMA,
    sideEffect: 'write',
    execute: async (args) => {
      session.draft = applyDraftPatch(session.draft, args);
      return buildSnapshot(session);
    },
  });

  return [getStoreDraft, updateStoreDraft];
}

/** 工具结果：模型看到的唯一权威草稿视图。 */
function buildSnapshot(session: StoreSetupSession): JsonValue {
  const validation = validateInternalDraft(session.draft);
  return {
    draft: projectContractDraft(session.draft),
    readyForReview: validation.readyForReview,
    missingFields: validation.missingFields,
    errors: validation.errors,
    nextQuestion: buildNextQuestion(validation),
  } as unknown as JsonValue;
}
