# `app-assistant.v1` 契约说明

> 机器可读事实源：`contracts/app-assistant.v1.json`；夹具：`test/fixtures/app-assistant/contract/cases.json`。
> 本契约由项目页右侧统一会话 Agent 使用，端点 `POST /api/v1/agent/app-assistant`。

## 0. 一句话边界

**服务端只生成 `proposal`（提案），绝不声称已经修改桌面项目。**
`applied` 是桌面本地事实：桌面端重新校验后由 reducer / 既有业务入口写入，失败与拒绝都只发生在桌面侧。

## 1. 请求

| 键 | 类型 | 约束 |
| --- | --- | --- |
| `contractVersion` | string | 必须为 `app-assistant.v1` |
| `requestId` | string | 1–120 字符；同时进入 `X-Agent-Request-Id` 请求头 |
| `catalogVersion` | string | 必须为 `app-capabilities.v1`，不一致 fail closed |
| `contextRevision` | integer | 请求发起时冻结的桌面项目内容版本 |
| `utterance` | string | 纯文字 1–500 字；只有附件时允许空 |
| `history` | array | 最多 12 条，仅 `user` / `assistant` 安全正文，总长 ≤ 6000 |
| `client` | object | `{surface:'desktop', phase:<当前阶段>}`，phase 只作理解上下文 |
| `project` | object | `{projectId, context}`；context 为安全项目快照 |
| `attachments` | array | 最多 3 张，用途 `auto｜menu｜store｜reference`，只含 base64 传输正文，不持久化 |

严格拒绝未知顶层/嵌套键。`settings`、`apiKey`、`authorization`、`systemPrompt`、`trace`、
`dataUrl`、绝对路径、reducer/IPC/命令/脚本键一律不接受。

`project.context` 只包含项目业务字段、缺项、校验错误、功能选择、模板候选、视觉偏好、
素材元数据（assetId / 文件名 / MIME / 尺寸 / 来源）、参考图与前端候选状态摘要、部署状态与
AppID 是否已填。**不含** `settings`、`apiKey`、绝对路径、base64、完整会话与原始 trace。

## 2. 响应

```json
{
  "contractVersion": "app-assistant.v1",
  "requestId": "chat_req_...",
  "runId": "run_...",
  "catalogVersion": "app-capabilities.v1",
  "contextRevision": 7,
  "status": "proposal",
  "reply": "已整理这些资料，请核对。",
  "proposalId": "proposal_...",
  "changes": [],
  "questions": [],
  "actionRequests": [],
  "trace": { "modelCalls": 2, "toolCalls": [], "stopReason": "final_answer", "degraded": false },
  "meta": { "transport": "http", "provider": "deepseek", "mock": false, "model": "deepseek-chat", "latencyMs": 1200 }
}
```

`status` 只有三种：

- `proposal`：有字段修改/动作请求，或已给出完整答复；**不代表桌面已应用**。
- `needs-input`：缺少依据或用途不明，必须给具体问题，不得附带猜测性写入。
- `rejected`：超出能力目录或安全边界，不提供替代写入。

## 3. 操作

| `op` | 必需键 | 说明 |
| --- | --- | --- |
| `field.set` | `opId, op, fieldId, value, evidence` | 值类型由桌面能力目录决定 |
| `dish.upsert` | `opId, op, name, evidence`，可选 `dishId, priceCents, description` | 价格只接受整数分或 null；新增时桌面分配 ID |
| `dish.remove` | `opId, op, dishId, evidence` | 必须经桌面确认 |
| `action.request` | `opId, op, actionId, evidence`，可选 `params, attachmentIds` | `actionId` 必须来自能力目录 |

单轮上限：24 个 `changes`、3 个 `questions`、2 个 `actionRequests`，`reply` ≤ 500 字，
`evidence.excerpt` ≤ 120 字，图片证据只引用 `attachmentId`。

桌面端以 `proposalId` 去重、以 `requestId` 防止同一响应重复回调。

## 4. 风险与确认

风险等级**只能由桌面能力目录决定**；模型传 `requiresApproval:false` 无效。

- 可直接应用：用户明确给出的非空 `field.set`、`dish.upsert`、功能勾选/自定义、视觉偏好。
- 必须确认：清空已有值、`dish.remove`、保存/替换/解除素材引用、模板选择、AppID 写入、
  候选采用/放弃、正式导出。
- 原链已有确认（partial 候选采用、导出 preflight、AppID 写文件）不得被统一会话跳过。
- 字段批次原子应用：任一项非法则整批不写。

## 5. 稳定错误码

`APP_ASSISTANT_REQUEST_INVALID`、`APP_ASSISTANT_CONTRACT_MISMATCH`、`APP_ASSISTANT_CATALOG_MISMATCH`、
`APP_ASSISTANT_CONTEXT_INVALID`、`APP_ASSISTANT_CONTEXT_STALE`、`APP_ASSISTANT_RESPONSE_INVALID`、
`APP_ASSISTANT_FIELD_UNKNOWN`、`APP_ASSISTANT_FIELD_READ_ONLY`、`APP_ASSISTANT_VALUE_INVALID`、
`APP_ASSISTANT_OPERATION_DENIED`、`APP_ASSISTANT_CONFIRMATION_REQUIRED`、
`APP_ASSISTANT_ACTION_UNAVAILABLE`、`APP_ASSISTANT_ATTACHMENT_PURPOSE_UNKNOWN`、
`APP_ASSISTANT_PROPOSAL_DUPLICATE`。

**重复 opId 的语义（2026-11-20 调整）**：opId 只是单轮的内部唯一键，不再是拒收条件。
内容完全相同的修改只保留一条；opId 撞号但内容不同的修改会重新编号（`op_auto_<n>`）后照常应用。
只有「整份提案的应用结果已写入过」这类真正的重复才返回 `APP_ASSISTANT_PROPOSAL_DUPLICATE`。
原因：模型在同一批里复用一个 `op_1` 属于常态，用它当拒收理由会让用户「一直发不出消息」。

上游模型/网络错误沿用现有 `DEEPSEEK_*` / `AGENT_*` 映射，不新建同义错误体系。

## 6. 桌面应用状态

桌面本地另算 `applyStatus`，绝不来自模型：

`applied`（已写入）｜`awaiting-confirmation`（等待用户确认）｜`stale`（项目已变化，整批未写）｜
`rejected`（校验拒绝）｜`failed`（写入异常）。