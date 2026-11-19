/**
 * `app-assistant.v1` 的五个受控工具。
 *
 * 写工具只累积“单次请求内存中的提案”，不写数据库、不写文件、不调用桌面 IPC；
 * 服务的最终响应由 runtime 结果 + 这里的会话状态组装，模型无权声明已写入项目。
 */

import { AgentToolError } from '../runtime';
import type { JsonObject, JsonSchema, JsonValue } from '../runtime';
import { defineTool } from '../runtime/tool-registry';
import type { AgentTool } from '../runtime/tool-registry';
import { APP_CATALOG, APP_CAPABILITY_SNAPSHOT } from './capabilities';
import { normalizeActionRequest, normalizeChange, normalizeQuestion } from './schema';
import {
  APP_ASSISTANT_CONTRACT_VERSION,
  APP_ASSISTANT_LIMITS,
  APP_ASSISTANT_TOOL_NAMES,
} from './types';
import type {
  AppAssistantActionRequest,
  AppAssistantChange,
  AppAssistantQuestion,
  ProjectAgentContext,
  ValidatedAppAttachment,
} from './types';

export { APP_ASSISTANT_TOOL_NAMES };

const CAPABILITY_DOMAINS = ['all', 'store', 'visual', 'features', 'project', 'actions'] as const;

const EVIDENCE_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['source'],
  properties: {
    source: {
      type: 'string',
      enum: ['utterance', 'attachment', 'context'],
      description: '依据来源：用户本轮文字、图片附件或项目上下文。',
    },
    excerpt: {
      type: 'string',
      maxLength: APP_ASSISTANT_LIMITS.maxEvidenceExcerptChars,
      description: '用户原话摘要，最多 120 字；图片证据改用 attachmentId。',
    },
    attachmentId: {
      type: 'string',
      maxLength: 64,
      description: '本轮附件 id（kind 见请求附件）。',
    },
  },
};

const CHANGE_ITEM_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['opId', 'op', 'evidence'],
  properties: {
    opId: {
      type: 'string',
      maxLength: 48,
      pattern: '^[A-Za-z0-9._:-]{1,48}$',
      description: '本轮变更的唯一 id，例如 op_1。',
    },
    op: {
      type: 'string',
      enum: ['field.set', 'dish.upsert', 'dish.remove'],
      description: 'field.set 改字段；dish.upsert 新增/更新菜品；dish.remove 删除菜品。',
    },
    fieldId: {
      type: 'string',
      maxLength: 80,
      description: '仅 field.set 使用，必须来自 get_project_capabilities。',
    },
    value: {
      description: '仅 field.set 使用，类型由字段目录决定（文本/布尔/列表等）。',
    },
    name: {
      type: 'string',
      minLength: 1,
      maxLength: 24,
      description: '仅 dish.upsert 使用：菜名。',
    },
    dishId: {
      type: 'string',
      maxLength: 32,
      description: '已有菜品 id；新增时省略。',
    },
    priceCents: {
      type: ['integer', 'null'],
      minimum: 1,
      maximum: 999_999,
      description: '价格，整数分；例如 28 元写 2800，未知写 null。',
    },
    description: {
      type: 'string',
      maxLength: 60,
      description: '菜品描述，最多 60 字；用户未要求代拟时省略。',
    },
    evidence: EVIDENCE_SCHEMA,
    reason: {
      type: 'string',
      maxLength: 120,
      description: '为什么做这条变更，供桌面展示。',
    },
  },
};

const ACTION_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['actionId', 'evidence'],
  properties: {
    actionId: {
      type: 'string',
      maxLength: 80,
      description: '必须来自 get_project_capabilities 返回的 actions。',
    },
    params: {
      type: 'object',
      additionalProperties: false,
      properties: {
        phase: { type: 'string', maxLength: 40 },
        templateId: { type: 'string', maxLength: 64 },
        utterance: { type: 'string', maxLength: 500 },
        targetPage: { type: 'string', enum: ['home', 'menu', 'profile'] },
        attachmentId: { type: 'string', maxLength: 64 },
        target: { type: 'string', enum: ['store', 'visual'] },
      },
    },
    attachmentIds: {
      type: 'array',
      maxItems: APP_ASSISTANT_LIMITS.maxAttachments,
      items: { type: 'string', maxLength: 64 },
    },
    evidence: EVIDENCE_SCHEMA,
    reason: { type: 'string', maxLength: 120 },
  },
};

const QUESTION_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['text'],
  properties: {
    field: {
      type: 'string',
      maxLength: 60,
      description: '可选：追问对应的字段，例如 store.businessHours。',
    },
    text: {
      type: 'string',
      minLength: 1,
      maxLength: 200,
      description: '具体、可回答的问题。',
    },
  },
};

export interface AppAssistantSessionInput {
  projectId: string;
  contextRevision: number;
  phase: string;
  context: ProjectAgentContext;
  attachments: readonly ValidatedAppAttachment[];
}

export interface AppAssistantSession {
  projectId: string;
  contextRevision: number;
  phase: string;
  context: ProjectAgentContext;
  attachments: readonly ValidatedAppAttachment[];
  attachmentIds: ReadonlySet<string>;
  changes: AppAssistantChange[];
  actionRequests: AppAssistantActionRequest[];
  questions: AppAssistantQuestion[];
  nextOperationNumber: number;
  nextQuestionNumber: number;
}

export function createAppAssistantSession(input: AppAssistantSessionInput): AppAssistantSession {
  return {
    projectId: input.projectId,
    contextRevision: input.contextRevision,
    phase: input.phase,
    context: input.context,
    attachments: input.attachments,
    attachmentIds: new Set(input.attachments.map((attachment) => attachment.id)),
    changes: [],
    actionRequests: [],
    questions: [],
    nextOperationNumber: 0,
    nextQuestionNumber: 0,
  };
}

function toolFailure(result: { code: string; message: string }): never {
  throw new AgentToolError(result.code, result.message);
}

function snapshot(session: AppAssistantSession): JsonValue {
  return {
    proposal: {
      changes: session.changes,
      actionRequests: session.actionRequests,
      questions: session.questions,
    },
    counts: {
      changes: session.changes.length,
      actionRequests: session.actionRequests.length,
      questions: session.questions.length,
    },
    limits: {
      maxChanges: APP_ASSISTANT_LIMITS.maxChanges,
      maxQuestions: APP_ASSISTANT_LIMITS.maxQuestions,
      maxActionRequests: APP_ASSISTANT_LIMITS.maxActionRequests,
    },
  } as unknown as JsonValue;
}

export function createAppAssistantTools(session: AppAssistantSession): AgentTool[] {
  const getCapabilities = defineTool<JsonObject>({
    name: 'get_project_capabilities',
    title: '读取项目能力目录',
    description:
      '按 domain 返回服务端只读能力目录：可写字段、值类型、选项、限制、写回位置与可用业务动作。修改前必须先读取，不要凭空假设字段。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        domain: {
          type: 'string',
          enum: [...CAPABILITY_DOMAINS],
          description: 'all 返回全部；store/visual/features/project 只返回对应字段；actions 只返回业务动作。',
        },
      },
    },
    sideEffect: 'read',
    execute: async (args) => {
      const domain = typeof args.domain === 'string' ? args.domain : 'all';
      const includeFields = domain !== 'actions';
      const includeActions = domain === 'all' || domain === 'actions';
      const fields = includeFields
        ? APP_CATALOG.fields.filter((field) => domain === 'all' || field.fieldId.startsWith(`${domain}.`))
        : [];
      return {
        contractVersion: APP_ASSISTANT_CONTRACT_VERSION,
        catalogVersion: APP_CAPABILITY_SNAPSHOT.catalogVersion,
        catalogDigest: APP_CAPABILITY_SNAPSHOT.digest,
        fields,
        actions: includeActions ? APP_CATALOG.actions : [],
        attachmentPurposes: APP_CATALOG.attachmentPurposes,
        deniedFieldIdPrefixes: APP_CATALOG.deniedFieldIdPrefixes,
        readOnlyFieldIds: APP_CATALOG.readOnlyFieldIds,
        riskPolicy: APP_CATALOG.riskPolicy,
      } as unknown as JsonValue;
    },
  });

  const getContext = defineTool<JsonObject>({
    name: 'get_project_context',
    title: '读取当前项目上下文',
    description:
      '返回本轮客户端提供的安全项目快照、缺项与校验错误、当前阶段和附件用途。不包含设置、密钥、路径、base64 或原始 trace。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    sideEffect: 'read',
    execute: async () => ({
      projectId: session.projectId,
      contextRevision: session.contextRevision,
      phase: session.phase,
      context: session.context,
      attachments: session.attachments.map((attachment) => ({
        id: attachment.id,
        kind: attachment.kind,
        mediaType: attachment.mediaType,
        bytes: attachment.bytes,
      })),
    }) as unknown as JsonValue,
  });

  const proposeChanges = defineTool<JsonObject>({
    name: 'propose_project_changes',
    title: '提交项目变更提案',
    description:
      '把本轮用户明确要求的字段修改或菜品增删记成提案。服务端会按能力目录做初步校验；桌面端还会再次校验并决定是否写入、是否需要用户确认。不要提交猜测字段，也不要在同一批里混入未提供依据的修改。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['changes'],
      properties: {
        changes: {
          type: 'array',
          minItems: 1,
          maxItems: APP_ASSISTANT_LIMITS.maxChanges,
          items: CHANGE_ITEM_SCHEMA,
        },
      },
    },
    sideEffect: 'write',
    execute: async (args) => {
      const rawChanges = args.changes;
      if (!Array.isArray(rawChanges) || rawChanges.length === 0) {
        throw new AgentToolError('APP_ASSISTANT_RESPONSE_INVALID', '至少需要一条变更。');
      }
      if (session.changes.length + rawChanges.length > APP_ASSISTANT_LIMITS.maxChanges) {
        throw new AgentToolError(
          'APP_ASSISTANT_RESPONSE_INVALID',
          `单轮最多 ${APP_ASSISTANT_LIMITS.maxChanges} 条变更。`,
        );
      }

      const existing = new Set(session.changes.map((change) => change.opId));
      const seen = new Set<string>();
      const accepted: AppAssistantChange[] = [];
      for (const raw of rawChanges) {
        const normalized = normalizeChange(raw, session.attachmentIds);
        if (!normalized.ok) toolFailure(normalized);
        const change = normalized.value;
        if (existing.has(change.opId) || seen.has(change.opId)) {
          throw new AgentToolError('APP_ASSISTANT_PROPOSAL_DUPLICATE', 'opId 不能重复。');
        }
        seen.add(change.opId);
        accepted.push(change);
      }

      session.changes.push(...accepted);
      return snapshot(session);
    },
  });

  const requestAction = defineTool<JsonObject>({
    name: 'request_business_action',
    title: '登记已有业务动作请求',
    description:
      '登记一个已有业务动作（切换阶段、选模板、改模板、参考图候选、确认资料、导出、保存图片素材）。只登记请求，不导航、不导出、不写文件；桌面端会检查前置条件并按原确认链执行。actionId 必须来自能力目录。',
    parameters: ACTION_SCHEMA,
    sideEffect: 'write',
    execute: async (args) => {
      if (session.actionRequests.length >= APP_ASSISTANT_LIMITS.maxActionRequests) {
        throw new AgentToolError(
          'APP_ASSISTANT_RESPONSE_INVALID',
          `单轮最多 ${APP_ASSISTANT_LIMITS.maxActionRequests} 个动作请求。`,
        );
      }
      session.nextOperationNumber += 1;
      const normalized = normalizeActionRequest(
        {
          opId: `op_action_${session.nextOperationNumber}`,
          op: 'action.request',
          actionId: args.actionId,
          ...(args.params === undefined ? {} : { params: args.params }),
          ...(args.attachmentIds === undefined ? {} : { attachmentIds: args.attachmentIds }),
          evidence: args.evidence,
          ...(args.reason === undefined ? {} : { reason: args.reason }),
        },
        session.attachmentIds,
      );
      if (!normalized.ok) toolFailure(normalized);
      session.actionRequests.push(normalized.value);
      return snapshot(session);
    },
  });

  const askFollowUp = defineTool<JsonObject>({
    name: 'ask_follow_up',
    title: '记录追问',
    description:
      '当缺少依据、图片用途不明或信息不足时，记录 1–3 个具体问题。追问轮不得附带任何猜测性写入。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['questions'],
      properties: {
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: APP_ASSISTANT_LIMITS.maxQuestions,
          items: QUESTION_SCHEMA,
        },
      },
    },
    sideEffect: 'write',
    execute: async (args) => {
      const rawQuestions = args.questions;
      if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
        throw new AgentToolError('APP_ASSISTANT_RESPONSE_INVALID', '至少需要一个追问。');
      }
      if (session.questions.length + rawQuestions.length > APP_ASSISTANT_LIMITS.maxQuestions) {
        throw new AgentToolError(
          'APP_ASSISTANT_RESPONSE_INVALID',
          `单轮最多 ${APP_ASSISTANT_LIMITS.maxQuestions} 个追问。`,
        );
      }
      const accepted: AppAssistantQuestion[] = [];
      for (const raw of rawQuestions) {
        const normalized = normalizeQuestion(raw);
        if (!normalized.ok) toolFailure(normalized);
        session.nextQuestionNumber += 1;
        accepted.push({ id: `q_${session.nextQuestionNumber}`, text: normalized.value.text });
      }
      session.questions.push(...accepted);
      return snapshot(session);
    },
  });

  return [getCapabilities, getContext, proposeChanges, requestAction, askFollowUp];
}