# Agent Runtime 与多轮 function calling

> 状态：`agent-run.v1` 已实现（2026-11-12，服务端）；`frontend-reconstruct.v1` 四个前端重构工具已实现（2026-11-17，服务端 + 桌面本地链）
> 契约：`agent-run.v1`（`POST /api/v1/agent/run`）、`frontend-reconstruct.v1`（`POST /api/v1/agent/frontend-reconstruct`，见 §11 与 [`frontend-reconstruct-contract.md`](frontend-reconstruct-contract.md)）
> 代码：`server/src/agent/runtime/`、`server/src/agent/store-setup/`、`server/src/agent/frontend-reconstruct/`、`desktop/frontend-reconstruct/`
> 关联：[`agent-turn-contract.md`](agent-turn-contract.md)（单轮抽取，仍为默认链路）

## 1. 解决什么问题

`agent-turn.v1` / `v2` 是**单轮**资料抽取：模型一次返回 `reply + draftPatch`，服务端合并、校验后结束。它没有工具、没有中间状态，也无法让模型在“读草稿 → 补字段 → 再看缺什么”之间往返。

本轮新增的 Runtime 把这件事拆成三层：

1. **协议层**：模型返回 `tool_calls`，Runtime 执行工具并把结果作为 `tool` 消息回填，继续下一轮模型调用。
2. **工具层**：工具声明 JSON Schema、超时、重试、副作用、是否并发安全、是否需要审批；执行器负责参数解析、校验、超时、重试、并发、结果截断。
3. **业务层**：开店资料 Agent 只暴露两个工具（`get_store_draft` / `update_store_draft`），草稿存在单次请求的内存里；最终 `missingFields` / `errors` / `nextQuestion` 仍由服务端 `validateInternalDraft` 重算，模型无权决定。

边界：Runtime 不执行任意代码、不访问数据库、不读写文件；工具是业务代码显式注册的纯函数。当前 `agent-run.v1` 尚未接入桌面端 UI；图片驱动前端重构（`frontend-reconstruct.v1`）已接桌面候选面板，但走独立端点与受控工具链（见 §11），不是 `agent-run.v1` 的 UI 接线。

## 2. 目录与职责

```text
server/src/agent/runtime/
  json-schema.ts         JSON Schema 子集：配置期检查 + 运行期校验
  json-utils.ts          稳定序列化、UTF-8 字节数、按码点/字节截断
  runtime.types.ts       ChatModel / ChatMessage / 日志事件等纯类型
  runtime.errors.ts      AgentError、AgentToolError、AgentModelError、限制类错误
  tool-registry.ts       defineTool、ToolRegistry、工具配置校验
  tool-executor.ts       参数解析 → schema 校验 → 审批 → 超时/重试 → 结果封装
  agent-loop.ts          模型 ↔ 工具循环、上限、循环检测、usage 累计
  adapters/
    deepseek-chat-model.ts  OpenAI 兼容 /chat/completions 的 ChatModel 实现
  index.ts               公共出口；不依赖 Nest

server/src/agent/store-setup/
  store-setup.types.ts   agent-run.v1 请求/响应/trace 类型
  store-setup.prompt.ts  开店资料系统提示词
  store-setup.tools.ts   两个工具 + 草稿会话 + 参数 schema
  store-setup.service.ts 请求校验、runtime 调用、服务端重算、HTTP 错误映射
  store-setup.controller.ts  POST /agent/run
```

Runtime 目录刻意不 `import @nestjs/*`，可被脚本、测试或其它进程复用；业务侧只从 `../runtime` 取能力。

## 3. 一次 run 的流程

```text
POST /api/v1/agent/run
  → AgentAuthGuard（Bearer / 开发环境放行）
  → StoreSetupAgentService.parseRunRequest（严格字段校验）
  → createStoreSetupSession(normalizeInternalDraft(draft))
  → new ToolRegistry().registerAll(createStoreSetupTools(session))
  → runAgent:
      ① ChatModel.complete(messages, tools)
      ② 无 tool_calls → 得到最终回复，结束
      ③ 有 tool_calls → ToolExecutor.executeBatch
          参数解析 → schema 校验 → 审批钩子 → 超时/重试 → 结果截断
      ④ 每个 tool_call 回填一条 role='tool' 消息（失败也回填结构化错误）
      ⑤ 回到 ①，直到结束或触达上限
  → validateInternalDraft(session.draft)（服务端权威）
  → 组装 draft / missingFields / errors / nextQuestion / trace / meta
```

关键保证：

- **每个 `tool_call` 必有 `tool` 回复**。未知工具、参数错误、执行失败、取消都会生成对应的 tool 消息，避免下一轮模型 API 因消息不配对而 400。
- **失败不必然中断**。单个工具失败会以 `{"ok":false,...}` 回填，模型可以修正参数后重试；`trace.degraded` 与 `trace.toolCalls[].ok` 会如实反映。
- **模型不能改校验结论**。工具只写草稿字段；`readyForReview`、缺字段、字段错误、下一问由服务端重新计算。

## 4. 运行上限

业务端点从环境变量读取三个上限（`server/src/common/config/env.validation.ts`、`server/.env.example`）：

| 变量 | 默认 | 允许范围 | 含义 |
| --- | ---: | ---: | --- |
| `AGENT_RUN_MAX_STEPS` | 6 | 1–12 | 单次 run 最多模型调用次数（含首次） |
| `AGENT_RUN_MAX_TOOL_CALLS` | 12 | 1–50 | 单次 run 最多执行的工具调用个数 |
| `AGENT_RUN_TIMEOUT_MS` | 60000 | 1000–300000 | 单次 run 的墙钟时间上限（毫秒） |

Runtime 内部默认值（`DEFAULT_AGENT_RUN_LIMITS`）与硬边界：

| 字段 | 默认 | clamp |
| --- | ---: | ---: |
| `maxModelCalls` | 6 | 1–12 |
| `maxToolCalls` | 12 | 1–50 |
| `maxWallClockMs` | 60000 | 1000–300000 |
| `maxParallelToolCalls` | 4 | 1–8 |
| `maxReplyCharacters` | 4000 | 100–20000 |
| `maxToolResultBytes` | 16384 | 512–262144 |
| `modelMaxAttempts` | 2 | 1–3 |
| `modelRetryBackoffMs` | 300 | 0–5000 |
| `toolTimeoutMs` | 15000 | 100–120000 |

终端错误、配置错误、空回复兜底、循环检测和上限终止都会体现在 `trace.stopReason`：

| `stopReason` | 触发条件 |
| --- | --- |
| `final_answer` | 模型返回无工具调用的非空回复 |
| `empty_reply` | 连续空回复，已追加一次 nudge 后仍为空 |
| `max_model_calls` | 达到模型调用上限 |
| `max_tool_calls` | 下一批工具调用会超过总上限，该批不执行并回填 synthetic 错误 |
| `loop_detected` | 相同工具名 + 规范化参数第 3 次出现，该批不执行 |
| `time_limit` | 墙钟超时 |
| `aborted` | 外部 `AbortSignal` 取消 |

`status` 只有两种业务语义：`collecting`（还需补充）与 `reviewing`（服务端校验通过、可确认）。Runtime 自身的 `status` 是 `completed | limit_reached | aborted`，不直接暴露给客户端。

## 5. 工具契约

```ts
export interface AgentToolDefinition<Args extends JsonObject> {
  name: string;                    // ^[a-z][a-z0-9_]{1,47}$，2–48 字符
  title?: string;                  // ≤80，仅内部可读
  description: string;             // 4–2000 字符，写给模型看
  parameters: JsonSchema;          // 根必须是 object
  timeoutMs?: number;              // 100–120000；默认 15000
  retry?: {
    maxAttempts: number;           // 1–4，含首次
    backoffMs?: number;            // 0–10000，默认 200
    retryOnTimeout?: boolean;      // 默认 false
  };
  sideEffect: 'read' | 'write';    // write 默认串行
  concurrencySafe?: boolean;       // 默认 sideEffect === 'read'
  requiresApproval?: boolean;      // 默认 false
  execute(args, context): Promise<JsonValue | void> | JsonValue | void;
}
```

注册期检查（`ToolRegistry`）：

- 工具名合法、唯一；单个注册表最多 32 个工具；白名单里不存在的工具直接判配置错误。
- description 长度、`timeoutMs`、重试策略、backoff 都在范围内。
- `parameters` 序列化后 ≤16KB；根 schema 的 `type` 必须是字符串 `'object'`；`required` 必须在 `properties` 中声明。

### 5.1 支持的 JSON Schema 子集

`type`（字符串或类型数组）、`properties`、`required`、`additionalProperties`（仅布尔）、`items`、`enum`、`const`、`minimum`、`maximum`、`minLength`、`maxLength`、`minItems`、`maxItems`、`pattern`、`default`、`title`、`description`。

未支持的关键字（如 `$ref`、`oneOf`、`anyOf`、`allOf`）在注册期直接报配置错误，不会发给模型后才发现无法校验。字符串长度按 Unicode 码点计算；schema 深度上限 16；`validateJsonValue` 默认最多返回 20 条 issue。

### 5.2 参数与结果

- 参数文本必须是非空 JSON 对象，且 ≤64KB；解析失败/非对象/不满足 schema 都按 `TOOL_ARGUMENTS_INVALID` 处理。
- 成功结果统一包成 `{"ok":true,"result":...}`；超过 `maxResultBytes` 时只把截断预览交给模型：`{"ok":true,"truncated":true,"preview":"...","note":"..."}`。
- 失败结果包成 `{"ok":false,"error":{"code","message","details?}}`，内部异常 message 不回显；`trace` 只记录调用元数据，不记录参数和结果正文。
- 工具抛 `AgentToolError(code, message, { retryable, details })` 可控制是否重试；其它异常一律 `TOOL_EXECUTION_FAILED`，默认不可重试。

### 5.3 并发、审批与取消

- 一批调用中只要有未知工具、或任一工具 `concurrencySafe === false`，整批串行；否则按 `maxParallelToolCalls`（默认 4）并发。
- `requiresApproval: true` 且没有提供 `approval` 钩子时，工具不会执行，返回 `TOOL_APPROVAL_REQUIRED`；钩子返回 `false` 或抛错返回 `TOOL_DENIED`。
- 取消后不再启动新工具；已经开始的结果会保留，未开始的调用生成 `AGENT_ABORTED` 的工具结果。

## 6. HTTP 契约

### 6.1 请求

顶层只允许这些键，未知键按 400 处理：

```json
{
  "contractVersion": "agent-run.v1",
  "utterance": "开一家面馆，堂食和外卖都做，牛肉面 28 元",
  "draft": {
    "storeName": "",
    "category": "",
    "businessHours": "",
    "fulfillment": { "dineIn": false, "takeaway": false },
    "dishes": []
  },
  "client": { "surface": "desktop", "phase": "store-info" },
  "projectId": null
}
```

- `contractVersion` 必须显式等于 `agent-run.v1`，不会静默升级。
- `utterance` trim 后按码点 1–500 字。
- `draft` 必须是对象，按 `normalizeInternalDraft` 归一化；非法价格不会在这一步被吞掉，而是留给服务端校验报错。
- `client` 固定 `{"surface":"desktop","phase":"store-info"}`。
- `projectId` 固定 `null`。
- 本轮不支持图片；图片仍走 `agent-turn.v2`。

### 6.2 响应（200）

```json
{
  "contractVersion": "agent-run.v1",
  "runId": "run_0f1e...",
  "status": "reviewing",
  "reply": "资料已整理好，请确认。",
  "draft": {
    "storeName": "孙记面馆",
    "category": "面馆",
    "businessHours": "10:00-21:00",
    "fulfillment": { "dineIn": true, "takeaway": true },
    "dishes": [
      { "id": "dish_1", "name": "牛肉面", "priceCents": 2800, "description": "" },
      { "id": "dish_2", "name": "凉皮", "priceCents": 1200, "description": "" },
      { "id": "dish_3", "name": "酸梅汤", "priceCents": 800, "description": "" }
    ]
  },
  "missingFields": [],
  "errors": [],
  "nextQuestion": null,
  "trace": {
    "modelCalls": 2,
    "toolCalls": [
      {
        "callId": "call_1",
        "name": "update_store_draft",
        "ok": true,
        "latencyMs": 3,
        "attempts": 1,
        "truncated": false
      }
    ],
    "stopReason": "final_answer",
    "degraded": false
  },
  "meta": {
    "transport": "http",
    "provider": "deepseek",
    "mock": false,
    "model": "deepseek-chat",
    "latencyMs": 1200,
    "runId": "run_0f1e..."
  }
}
```

`degraded = runtime 的 degraded || 存在失败工具调用`。`meta.runId` 与顶层 `runId` 相同，便于日志关联。`trace` 不含工具参数、工具结果、模型原始回复或任何 prompt。

### 6.3 错误

统一错误体：`{ "code": string, "message": string, "requestId": string }`；不返回堆栈、上游响应或内部细节。

| HTTP | code | 场景 |
| ---: | --- | --- |
| 400 | `AGENT_REQUEST_INVALID` | 请求体非对象、含未知顶层字段 |
| 400 | `AGENT_CONTRACT_MISMATCH` | `contractVersion` 不是 `agent-run.v1` |
| 400 | `UTTERANCE_INVALID` |  utterance 为空或超过 500 字 |
| 400 | `DRAFT_INVALID` | `draft` 不是对象 |
| 400 | `CLIENT_INVALID` | `client` 不是桌面/资料阶段 |
| 400 | `PROJECT_ID_INVALID` | `projectId` 非 null |
| 401 | `AUTH_REQUIRED` / `AUTH_INVALID` | 生产环境未登录或 Bearer 格式错误 |
| 408 | `AGENT_ABORTED` | 运行被取消 |
| 413 | `AGENT_BODY_TOO_LARGE` | `/api/v1/agent` 请求体超过 2MiB |
| 500 | `AGENT_INTERNAL_ERROR` / `AGENT_CONFIGURATION_INVALID` / 限制类错误 | 未预期错误、工具/模型配置错误 |
| 502 | `DEEPSEEK_UNAVAILABLE` / `DEEPSEEK_AUTH_FAILED` / `DEEPSEEK_UPSTREAM_ERROR` / `DEEPSEEK_REQUEST_REJECTED` / `DEEPSEEK_RESPONSE_INVALID` | 上游不可用或响应无效 |
| 503 | `DEEPSEEK_NOT_CONFIGURED` / `DEEPSEEK_RATE_LIMITED` | 未配置密钥 / 限流 |
| 504 | `DEEPSEEK_TIMEOUT` | 上游超时 |

## 7. DeepSeek 适配器

`DeepseekChatModel` 走 OpenAI 兼容 `POST {baseUrl}/chat/completions`：

- 默认 `baseUrl=https://api.deepseek.com`、`model=deepseek-chat`、`timeoutMs=30000`、`maxTokens=1200`、`temperature=0.2`。
- **多模态（2026-11-17）**：`ChatMessage.content` 支持类型化片段 `text` + `image_url`；请求含图片时使用 `DEEPSEEK_VISION_MODEL`（默认 `deepseek-flash`），无图时保持原 `DEEPSEEK_MODEL` 与旧 wire shape。调用方可显式设置 `maxTokens`（重构专用默认 6000），适配器把值 clamp 到 **100–8000**；`finish_reason=length` 或内容被裁剪时在结果上标 `truncated`，业务层必须拒绝解析截断 JSON。
- 请求带 `tools`，并固定 `tool_choice: 'auto'`；`response_format` 只在调用方显式要求 `json_object` 时发送。
- 消息映射：assistant 的 `toolCalls` → `tool_calls`；tool 消息带 `tool_call_id`。
- 空 content 且无 tool_calls 视为非法响应；assistant content 最多保留 20000 字符。
- 错误统一为 `AgentModelError`，code 沿用 `DEEPSEEK_*`；`401/403` 不重试，`429` 与 `5xx` 可重试。
- 配置读取通过 `readDeepseekChatSettings` 从 `ConfigService` 的键值读取，不把密钥写入日志或响应。

## 8. 安全与可观测性

- **鉴权**：`AgentAuthGuard`；有 `Authorization` 时走 `SessionAuthGuard`，无头时仅 development 且 `AGENT_REQUIRE_AUTH=false` 放行，production 强制登录。
- **请求体**：`/api/v1/agent` 上限 2MiB（`AGENT_MAX_BODY_BYTES`），413 统一映射。
- **最小暴露**：Runtime 日志只有 runId / requestId / step / 时长 / 计数 / 工具名 / 错误码；不含用户原话、prompt、工具参数/结果、模型回复、密钥。
- **权威校验**：草稿的金额、字段长度、菜品数量、营业时间合法性全部由服务端重算；模型只能提议。
- **无隐式副作用**：工具必须显式注册；写操作默认串行，且可通过 `requiresApproval` 接入审批钩子。
- **结果有界**：工具结果 16KB 截断、工具参数 64KB 上限、模型回复 4000 码点上限（业务层最终回复再截 500）。

## 9. 扩展一个新工具

```ts
import { defineTool } from '../runtime';

const lookupStoreTool = defineTool<{ keyword: string }>({
  name: 'lookup_store_template',
  description: '按关键词查询可用模板，只读。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      keyword: { type: 'string', minLength: 1, maxLength: 24 },
    },
    required: ['keyword'],
  },
  sideEffect: 'read', // concurrencySafe 自动为 true
  timeoutMs: 3000,
  retry: { maxAttempts: 2, backoffMs: 100 },
  execute: async ({ keyword }) => {
    return { keyword, items: [] };
  },
});

registry.register(lookupStoreTool);
```

建议：读工具声明 `sideEffect:'read'`；写工具声明 `'write'` 并保证幂等或携带幂等键；结果只返回模型需要的最小字段；不要返回密钥、完整数据库行或超大文件；超时按下游 P99 设置，不要依赖默认 15s。

## 10. 测试与验证

已落盘测试（`server/test/`）：

| 文件 | 用例 | 覆盖 |
| --- | ---: | --- |
| `agent-runtime.schema.test.ts` | 11 | schema 关键字白名单、根对象、required、嵌套数组路径、类型数组、边界 |
| `agent-runtime.executor.test.ts` | 12 | 成功、未知工具、参数错误、审批、重试、超时、截断、内部异常、取消 |
| `agent-runtime.loop.test.ts` | 9 | 多轮工具、空回复 nudge、循环检测、工具/模型上限、回复截断、模型重试、取消 |
| `store-setup-agent.test.ts` | 10 | 完整资料流、失败继续、空回复兜底、5 种 400、504/503 映射 |
| `agent-run.e2e.test.ts` | 5 | 200 全流程、requestId、400、production 401、503 |

连同既有 `agent.controller.e2e.test.ts`（13）与 `env-validation.test.ts`（14），定向回归共 **74 tests / 7 files**。

常用命令（`server/` 下）：

```bash
npx vitest run \
  test/agent-runtime.schema.test.ts \
  test/agent-runtime.executor.test.ts \
  test/agent-runtime.loop.test.ts \
  test/store-setup-agent.test.ts \
  test/agent-run.e2e.test.ts \
  test/agent.controller.e2e.test.ts \
  test/env-validation.test.ts

npx tsc -p tsconfig.json --noEmit --incremental false
```

## 11. frontend-reconstruct.v1 前端重构工具（2026-11-17）

同一 Runtime 被图片驱动前端重构复用：`POST /api/v1/agent/frontend-reconstruct`，契约见
[`frontend-reconstruct-contract.md`](frontend-reconstruct-contract.md)。它不是 `agent-run.v1` 的替代，也不改变既有
`/agent/turn`、`/agent/run`、`/agent/template-revise` 行为。

### 11.1 四个业务工具

| 工具 | sideEffect | timeout | 约束 |
| --- | --- | ---: | --- |
| `get_frontend_capabilities({pageIds})` | read | 5000ms | 只返回目标页真实组件 props/events、插槽、动作、dataPath、主题/尺寸 token；`pageIds` 仅 home/menu |
| `check_frontend_coverage({requirement, requestedCapabilities?})` | read | 5000ms | 提交完整 UiRequirement；`covered/partial/rejected` 由服务端按事实计算，模型不能声明 covered |
| `propose_frontend_draft({draft})` | write（仅内存） | 5000ms | 校验 `frontend-pack-draft.v1`、页面集合、mustKeep、coverage 交叉不变量；不写磁盘 |
| `repair_frontend_draft({issues, patch})` | write（仅内存） | 5000ms | 只接受本次门禁产生的 `{path,code}`（1–8 条）+ 路径补丁；最多 2 轮；不能改 Base/Registry/源码 |

读工具声明 `retry: {maxAttempts:2, backoffMs:100, retryOnTimeout:true}`；写工具默认串行。工具结果只回传模型修复所需的最小字段，错误详情有界且可定位到 `$` DSL path。

### 11.2 事实与截断

- 能力事实来自打包只读快照 `server/src/agent/frontend-reconstruct/capabilities.snapshot.json`（页面事实内嵌），
  由 `scripts/frontend-capabilities.cjs` 生成，`--check` 与 Catalog/Base 同源；不接受客户端上传的 id 集合。
- P1 执行入口强制 `pageFacts`：`validateFrontendPackDraftForP1` / `validateFrontendReconstructResponseForP1`
  缺省或空 pageFacts 直接 `FRONTEND_FACTS_INVALID`（fail closed），不允许退回只看全局事实。
- prompt 只使用 canonical dataPath：`<pageId>.<key>`、`cart.*`、`store.*`；禁止原始 WXML token
  （`cartSummary.*`、`products.length`、`item.*`），运行时由 renderer 映射为真实 WXML 表达式。
- 模型输出被截断（`finish_reason=length` 或字符裁剪）时直接 `FRONTEND_MODEL_RESPONSE_INVALID`，**不解析残片**。

### 11.3 运行上限

| 项 | 默认 | 上限/允许范围 |
| --- | ---: | --- |
| 模型调用 | 8 | `FRONTEND_MAX_MODEL_CALLS`，1–8 |
| 工具调用 | 16 | `FRONTEND_MAX_TOOL_CALLS`，1–16 |
| 墙钟 | 120000ms | `FRONTEND_TIMEOUT_MS`，1000–120000 |
| 模型输出 token | 6000 | `FRONTEND_MAX_TOKENS`，100–6000（适配器硬上限 8000） |
| 修复 | 2 轮 | 契约固定，不得放宽；第 3 次 `FRONTEND_REPAIR_LIMIT_EXCEEDED` |

### 11.4 过程卡与可观测性

- 服务端响应 `trace` 只含 `modelCalls`、`toolCalls:[{name,ok}]`、`stopReason`、`degraded`，不含参数、结果、源码、图片或 prompt。
- 桌面过程卡使用 `buildFrontendProcessView`（`src/domain/agentRunProcess.mjs`）：只翻译四个真实工具名与真实 progress stage，
  展示 `runId`/`attempt`/状态/耗时；没有真实 trace/进度时不编造步骤，未知工具折叠为「辅助步骤」。
- 视图不包含工具参数/结果、原始 JSON、源码、base64、完整 prompt、密钥或本机绝对路径；错误文本先脱敏再截断。
- `ChatStream` 只消费领域层算好的安全 `process` 视图；不读取消息正文、不序列化 trace、不注入 HTML。
  `src/App.jsx` 的接线与最终展示位置不在 P6 文档任务范围（当前 P4 候选面板仍展示自身进度），P7 走查时确认，避免两处重复过程卡。

### 11.5 明确边界

- 状态机：`idle → analyzing → planning → [awaiting-capability-confirmation?] → generating → validating → verifying-runtime → ready | partial → adopted`；`rejected`/`cancelled` 终态，`failed` 换新 runId 重试，`adopted` 显式撤销；`partial` 必须显式确认，不能显示“已验收”。
- 模型不决定覆盖结论；缺必需能力时返回 `rejected`，不物化候选。
- 候选只写应用私有 workspace/overlay，不写正式 `templates/**`、不重冻结全局 Registry、不改 `miniprogram/`。
- 只执行仓库固定的 `scripts/wechat-devtools-run.cjs`；不接受模型或远端提供的命令。
- 真实微信运行时不可用/未登录/端口关闭时只能 `BLOCKED`/`NOT_RUN`，不得伪造 PASS。

## 12. 已知边界与后续

- 未接入桌面 UI：当前只有服务端端点与类型；前端仍走 `agent-turn.v1/v2`。
- 无持久会话：每次 run 的草稿只存在于内存，响应即结束；多轮上下文由客户端每次回传 `draft` 表达。
- 无流式输出：`ChatModel.complete` 是一次性响应；SSE/增量回复未实现。
- 审批只是钩子：没有 UI/人工确认通道，`requiresApproval` 的工具在未注入钩子时会被拒绝。
- 无 token 预算：只累计并返回 usage，不按 token 截断上下文。
- 无图片：`agent-run.v1` 不接受图片；视觉图片抽取仍属于 `agent-turn.v2`，参考图重构走 `frontend-reconstruct.v1`（§11）。
- HTTP 断开未接入取消：`runAgent` 支持 `AbortSignal`，但 controller 尚未把客户端断开映射为 signal。
- 工具结果超限会截断：需要完整大对象时应分页或让工具返回摘要，不要依赖模型看完整结果。

## 12. 全应用统一会话 Agent（`app-assistant.v1`，2026-11-20）

- 端点：`POST /api/v1/agent/app-assistant`；代码：`server/src/agent/app-assistant/`。
- 复用同一个 Runtime（工具注册/schema/超时/重试/并发/循环检测/上限），上限 6 模型调用 / 12 工具 / 60s。
- 五个工具：`get_project_capabilities`（读只读快照）、`get_project_context`（读客户端安全上下文）、`propose_project_changes`（写内存提案）、`request_business_action`（登记动作）、`ask_follow_up`（有界追问）。写工具没有数据库、文件或桌面 IPC 副作用。
- 能力目录唯一事实源是 `src/domain/appCapabilities.mjs`；服务端只读 `capabilities.snapshot.json`（`npm run app:capabilities` 生成，`app:capabilities:check` 逐字节校验）。
- 响应只允许 `proposal | needs-input | rejected`；`contextRevision` 与请求不一致时桌面按 `APP_ASSISTANT_CONTEXT_STALE` 整批拒写。
- 直连路径由 `src/services/appAssistant/directAppAssistantTransport.js` 实现同一工具白名单与响应契约；带图时明确报错（不静默丢图）。
