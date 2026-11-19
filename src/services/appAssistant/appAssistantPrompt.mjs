/**
 * 直连 DeepSeek 时的统一项目会话提示词与五工具定义。
 *
 * 工具白名单与 `docs/handoff/全应用统一会话Agent-Flash实施计划.md` §2.1 一致，
 * 与 server 端 Runtime 共享同一套语义：模型只能提案，校验与写入都在桌面。
 */
export const APP_ASSISTANT_SYSTEM_PROMPT = [
  '你是“口袋店长·轻启”的统一项目会话 Agent，在当前桌面项目里帮店主修改开店资料、视觉偏好或发起已有业务动作。',
  '',
  '硬规则：',
  '1. 你只能提出提案（proposal），绝不声称已经写入、保存、发布、导出或切换阶段成功。',
  '2. 事实字段（店名、品类、营业时间、取餐方式、地址、电话、菜名、价格、AppID）只能来自用户本轮明确提供的内容；没说就追问，不要猜。',
  '3. 菜品描述只有用户明确要求代拟时才生成，否则保持原值或不提。',
  '4. 用户明确授权代拟（如“你定”“给点建议”“帮我定价”）时可以给建议菜名与价格，但必须在回复里说明是建议值，请店主核对；不得编造品牌、产地、获奖、资质。',
  '5. 不要编造营业时间、地址、电话、AppID、素材 assetId；没有真实值就追问。',
  '',
  '工具使用规则：',
  '- 先调用 get_project_capabilities 了解可写字段、取值限制和可用动作；调用 get_project_context 读取当前值、缺项和校验错误。不要凭空假设。',
  '- 用 propose_project_changes 提交字段修改或动作请求；每条 change 都必须给 evidence：source 说明依据（如 utterance / image），excerpt 摘录用户原话（最长 120 字）。',
  '- 需要补充依据时用 ask_follow_up 提具体问题；不确定就不要提交猜测性写入。',
  '- 不要重复完全相同的工具调用；工具报错后按提示修正一次，仍失败就追问。',
  '',
  '最终回复要求：',
  '- 用简体中文，一到两句话，最多 500 字；不要输出 JSON、Markdown、代码块或内部实现细节。',
  '- 说明你整理了什么、还有哪些需要店主确认；不要复述工具返回的 JSON。',
].join('\n');

const EVIDENCE_SCHEMA = Object.freeze({
  type: 'object',
  description: '这条修改的依据；excerpt 摘录用户原话，最长 120 字',
  properties: {
    source: { type: 'string', description: 'utterance / image / context' },
    excerpt: { type: 'string' },
    attachmentId: { type: 'string' },
  },
  required: ['source'],
  additionalProperties: false,
});

const CHANGE_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    op: { type: 'string', enum: ['field.set', 'dish.upsert', 'dish.remove', 'action.request'] },
    fieldId: { type: 'string' },
    value: { description: '字段值；类型与范围由能力目录决定' },
    name: { type: 'string' },
    dishId: { type: 'string' },
    priceCents: { type: 'integer', description: '整数分，例如 28 元 = 2800；null 表示清空' },
    description: { type: 'string' },
    actionId: { type: 'string' },
    params: { type: 'object' },
    attachmentIds: { type: 'array', items: { type: 'string' } },
    evidence: EVIDENCE_SCHEMA,
    reason: { type: 'string' },
  },
  required: ['op', 'evidence'],
  additionalProperties: false,
});

export const APP_ASSISTANT_TOOLS = Object.freeze([
  {
    type: 'function',
    function: {
      name: 'get_project_capabilities',
      description: '读取当前可写字段、取值限制、风险级别和可用业务动作。',
      parameters: {
        type: 'object',
        properties: {
          domain: { type: 'string', description: '可选：store / visual / features / build / deploy' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_project_context',
      description: '读取本轮安全项目上下文、缺项、校验错误与用户消息。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_project_changes',
      description: '提交本轮字段修改或动作请求。只提交确定要改的项，未提交的保持不变。',
      parameters: {
        type: 'object',
        properties: {
          changes: {
            type: 'array',
            description: '最多 24 条；每条的 op 必须是 field.set / dish.upsert / dish.remove / action.request',
            items: CHANGE_SCHEMA,
          },
        },
        required: ['changes'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'request_business_action',
      description: '登记一个已有业务动作请求（不真正执行）。actionId 必须来自能力目录。',
      parameters: {
        type: 'object',
        properties: {
          actionId: { type: 'string' },
          params: { type: 'object' },
          attachmentIds: { type: 'array', items: { type: 'string' } },
          evidence: EVIDENCE_SCHEMA,
        },
        required: ['actionId', 'evidence'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_follow_up',
      description: '记录有界追问，用于信息不足或图片用途不明确。',
      parameters: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            description: '最多 3 个具体问题，每个一句话',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                text: { type: 'string' },
              },
              required: ['text'],
              additionalProperties: false,
            },
          },
        },
        required: ['questions'],
        additionalProperties: false,
      },
    },
  },
]);

export const APP_ASSISTANT_TOOL_NAMES = Object.freeze([
  'get_project_capabilities',
  'get_project_context',
  'propose_project_changes',
  'request_business_action',
  'ask_follow_up',
]);

/** 与 contracts/app-assistant.v1.json 的 limits 同源。 */
export const APP_ASSISTANT_DIRECT_LIMITS = Object.freeze({
  maxModelCalls: 6,
  maxToolCalls: 12,
  maxWallClockMs: 60000,
});