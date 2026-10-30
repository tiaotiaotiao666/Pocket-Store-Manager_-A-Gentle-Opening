# 开店 Agent 单轮接口契约（agent-turn.v1）

> 状态：**契约冻结；`POST /api/v1/agent/turn` 已实现，真实 Provider 为 DeepSeek。**
> 桌面端默认仍为**本地 Mock**（规则解析、固定文案、零网络请求）；设置 `VITE_AGENT_TRANSPORT=http` 后走 NestJS 后端 → DeepSeek。
> **ModelArts / 盘古尚未接入**；当前没有 Skill、工具调用、多 Agent、自主规划和自动发布。
> 适用阶段：桌面端 `STORE_INFO`（店铺装修）阶段内的开店资料收集。
> 设计依据：[`agent-turn-design.md`](agent-turn-design.md)；任务清单：[`tasks-agent-turn.md`](tasks-agent-turn.md)；本轮交接：[`本轮DeepSeek接入交接.md`](本轮DeepSeek接入交接.md)。

---

## 1. 能力边界与责任划分

| 角色 | 负责 | 不负责 |
| --- | --- | --- |
| 模型（**DeepSeek，已接入**） | 从店主自然语言中**提取**店名、品类、营业时间、取餐方式、菜品名称与整数分价格，生成面向店主的回复 | 不直接写数据库、不发布、不决定是否可确认、不生成动态代码、不调用外部工具 |
| 后端（NestJS `agent` 模块，**已实现**） | 请求校验、字段校验、价格二次校验、日志脱敏；模型输出白名单合并；店主确认前不写库 | 不在店主确认前保存或发布；不把密钥下发前端；本轮不做幂等、限流与真实店主身份解析 |
| 前端领域层（已实现） | 草稿规范化、金额整数分、缺项/错误判定、`readyForReview` 最终门槛、补丁合并、契约投影 | 不调用真实模型；不伪造模型名 |
| 前端 transport（已实现） | Mock 规则解析（默认）；`VITE_AGENT_TRANSPORT=http` 时使用 HTTP transport | 不自动重试、不读取全局 Token、不写 `localStorage`、不携带 DeepSeek Key |
| 店主 | 用自然语言补充资料、编辑草稿、明确点击确认 | — |

**硬规则**

1. 模型只提取和草拟资料，后端与前端领域层负责校验。
2. 店主确认前不得保存、不得发布、不得写库；本轮连 `localStorage` 都不写。
3. `priceCents` 是对外唯一金额事实，整数分；`priceText` 只存在于本地编辑态，永不进入契约。
4. 本契约的 `sessionId` / `turnId` 与 B1 点餐业务**不是同一概念**，详见第 2 节。

---

## 2. 与 B1 顾客 `sessions` 的区别

| 项目 | B1 点餐 `sessions` | Agent 单轮 `agent-turn.v1` |
| --- | --- | --- |
| 归属 | 顾客扫码登录会话 | 店主开店资料收集回合 |
| 存储 | MySQL，已有 B1 表结构 | **本轮不落库、不持久化** |
| 标识 | B1 的 `sessionId` | 本轮 `turnId` 为单个回合标识；未来可扩展 `agentSessionId`，但**不得复用 B1 `sessions` 表** |
| 生命周期 | 登录态、有效期、可撤销 | 单次请求/响应；草稿只存在前端内存 reducer |
| 权限 | 顾客身份 | 未来店主身份，独立鉴权 |

`docs/api.md` 中的 B1 契约保持不变；本契约不修改、不覆盖 B1 的任何接口。若未来需要 Agent 会话持久化，应新增独立表（如 `agent_sessions` / `agent_turns`）并单独立项，而不是复用 `sessions`。

---

## 3. 请求

### 3.1 请求行与请求头

```http
POST /api/v1/agent/turn
Content-Type: application/json; charset=utf-8
Accept: application/json
X-Agent-Contract: agent-turn.v1
Authorization: Bearer <未来由宿主注入的短期 Token，本轮不发>
```

| 头 | 必填 | 说明 |
| --- | --- | --- |
| `Content-Type` | 是 | `application/json; charset=utf-8` |
| `Accept` | 是 | `application/json` |
| `X-Agent-Contract` | 否 | `agent-turn.v1`，便于网关路由与日志 |
| `Authorization` | 条件 | 短期 Token；**AK/SK 与 DeepSeek Key 永不下发前端**。development/test 且 `AGENT_REQUIRE_AUTH=false` 时可省略；production 必须提供，否则 401 |

### 3.2 请求体

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `contractVersion` | string | 是 | 固定 `"agent-turn.v1"` | 契约版本；不兼容变更升 `agent-turn.v2` |
| `utterance` | string | 是 | trim 后 1–500 字 | 本轮新增的自然语言；超过 500 字前端先截断或拒绝 |
| `draft` | `ContractDraft` | 是 | 见 3.3 | 当前草稿；首次为空草稿 |
| `client.surface` | string | 是 | 固定 `"desktop"` | 调用面 |
| `client.phase` | string | 是 | 固定 `"store-info"` | 便于服务端日志与路由 |
| `projectId` | string \| null | 否 | 本轮固定 `null` | 不生成假 ID；持久化后由服务端下发 |

### 3.3 `ContractDraft`

| 字段 | 类型 | 必有 | 约束 |
| --- | --- | --- | --- |
| `storeName` | string | 是 | 空串或 1–48 个 Unicode 码点 |
| `category` | string | 是 | 空串或 1–24 个码点；自由文本，不限定枚举 |
| `businessHours` | string | 是 | 空串或 1–3 段 `HH:MM-HH:MM`，多段英文逗号分隔；不支持跨午夜 |
| `fulfillment.dineIn` | boolean | 是 | 是否堂食 |
| `fulfillment.takeaway` | boolean | 是 | 是否到店自取 |
| `dishes` | `ContractDish[]` | 是 | 0–5 个；少于 3 个由校验报缺项 |
| `dishes[].id` | string | 是 | 1–32 个可见字符，本地稳定引用，不是数据库主键 |
| `dishes[].name` | string | 是 | 空串或 1–24 个码点 |
| `dishes[].priceCents` | integer \| null | 是 | `null` 或 1–999999；禁止浮点与字符串 |
| `dishes[].description` | string | 是 | 空串或 ≤60 个码点 |

### 3.4 请求示例（首次，空草稿）

```json
{
  "contractVersion": "agent-turn.v1",
  "utterance": "店名叫松月食堂，做社区家常菜，每天 10:00-21:00，堂食和自取都做。招牌是宫保鸡丁 28 元、番茄炒蛋 16 元、米饭 3 元。",
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

---

## 4. 响应

### 4.1 响应体

| 字段 | 类型 | 必有 | 约束 |
| --- | --- | --- | --- |
| `contractVersion` | string | 是 | 必须等于 `agent-turn.v1` |
| `turnId` | string | 是 | 1–64 个可见字符；Mock 为 `turn-mock-<n>` |
| `status` | string | 是 | 只允许 `collecting` \| `reviewing`；**永不出现 `confirmed`** |
| `reply` | string | 是 | 1–500 字，面向店主的中文回复 |
| `draft` | `ContractDraft` | 是 | 合并后的草稿（不删除已有合法字段） |
| `missingFields` | `MissingField[]` | 是 | `{ field, label, detail }`，可为空 |
| `errors` | `FieldError[]` | 是 | `{ field, code, message }`，可为空 |
| `nextQuestion` | `Question \| null` | 是 | `{ field, label, text }`；`reviewing` 时为 `null` |
| `meta.transport` | string | 是 | `"mock"` \| `"http"` |
| `meta.provider` | string | 是 | `"local-mock"`（mock）或 `"deepseek"`（http） |
| `meta.mock` | boolean | 是 | mock 固定 `true`；真实 DeepSeek 调用固定 `false` |
| `meta.model` | string \| null | 是 | mock 固定 `null`；http 为实际模型名（默认 `deepseek-chat`）；不得填未实际调用的名称 |
| `meta.latencyMs` | number | 否 | ≥0；Mock 固定 0，不冒充真实模型延迟；http 为后端实际处理耗时 |

**状态语义**

- `collecting`：仍有缺项或字段错误，前端继续追问。
- `reviewing`：服务端视角资料齐全，可以进入确认；前端仍会用本地校验覆盖该判断。
- 服务端 `status` 只是参考，**前端最终状态由本地 `validateAgentDraft` 决定**，避免服务端误报导致空资料被确认。

### 4.2 响应示例（collecting，缺营业时间）

```json
{
  "contractVersion": "agent-turn.v1",
  "turnId": "turn-mock-3",
  "status": "collecting",
  "reply": "记下了：店名 松月食堂、品类 社区餐馆。还差营业时间。每天几点到几点营业？例如 10:00-21:00。",
  "draft": {
    "storeName": "松月食堂",
    "category": "社区餐馆",
    "businessHours": "",
    "fulfillment": { "dineIn": true, "takeaway": true },
    "dishes": [
      { "id": "dish-1", "name": "宫保鸡丁", "priceCents": 2800, "description": "" },
      { "id": "dish-2", "name": "番茄炒蛋", "priceCents": 1600, "description": "" },
      { "id": "dish-3", "name": "米饭", "priceCents": 300, "description": "" }
    ]
  },
  "missingFields": [
    { "field": "businessHours", "label": "营业时间", "detail": "格式 HH:MM-HH:MM，例如 10:00-21:00" }
  ],
  "errors": [],
  "nextQuestion": { "field": "businessHours", "label": "营业时间", "text": "每天几点到几点营业？例如 10:00-21:00。" },
  "meta": { "transport": "mock", "provider": "local-mock", "mock": true, "model": null, "latencyMs": 0 }
}
```

### 4.3 响应示例（reviewing，资料齐全）

```json
{
  "contractVersion": "agent-turn.v1",
  "turnId": "turn-mock-4",
  "status": "reviewing",
  "reply": "资料齐了：松月食堂，社区餐馆，10:00-21:00，堂食和自取，3 道菜。请检查后确认。",
  "draft": {
    "storeName": "松月食堂",
    "category": "社区餐馆",
    "businessHours": "10:00-21:00",
    "fulfillment": { "dineIn": true, "takeaway": true },
    "dishes": [
      { "id": "dish-1", "name": "宫保鸡丁", "priceCents": 2800, "description": "" },
      { "id": "dish-2", "name": "番茄炒蛋", "priceCents": 1600, "description": "" },
      { "id": "dish-3", "name": "米饭", "priceCents": 300, "description": "" }
    ]
  },
  "missingFields": [],
  "errors": [],
  "nextQuestion": null,
  "meta": { "transport": "mock", "provider": "local-mock", "mock": true, "model": null, "latencyMs": 0 }
}
```

---

## 5. 校验规则（前端领域层 + 后端 `AgentService` 双实现）

长度按 Unicode 码点计；字段先 `trim`；空值优先判缺项，同一字段不会同时出现在缺项与错误中。

后端实现位于 `server/src/agent/agent-draft.validator.ts`，**独立于前端实现**，不复用 React 状态，也不接受模型或前端传入的 `status` / `missingFields` / `errors` / `readyForReview`。

| 字段 | 合法 | 缺项 | 错误码 |
| --- | --- | --- | --- |
| `storeName` | 1–48 码点 | 空 → `REQUIRED` | `NAME_TOO_LONG` |
| `category` | 1–24 码点，自由文本 | 空 → `REQUIRED` | `CATEGORY_TOO_LONG` |
| `businessHours` | 1–3 段 `HH:MM-HH:MM`，start < end，多段不重叠 | 空 → `REQUIRED` | `HOURS_FORMAT` / `HOURS_RANGE` / `HOURS_OVERLAP` / `HOURS_TOO_MANY` |
| `fulfillment` | 至少一个 true | 双 false → `FULFILLMENT_REQUIRED` | — |
| `dishes` 数量 | 3–5 | 0–2 → `DISHES_TOO_FEW` | `DISHES_TOO_MANY` |
| `dishes[].name` | 1–24 码点 | 空 → `DISH_NAME_REQUIRED` | `DISH_NAME_TOO_LONG` |
| `dishes[].priceCents` | 整数 1–999999 | `null` → `PRICE_REQUIRED` | `PRICE_INVALID` / `PRICE_RANGE` |
| `dishes[].description` | ≤60 码点，可空 | — | `DESCRIPTION_TOO_LONG` |
| `dishes[].id` | 1–32 字符且唯一 | 内部自动补齐 | `DISH_ID_INVALID`（内部防御） |

营业时间归一化支持全角符号、中文逗号/顿号、`~` / `—` / `到` / `至`、`10点` / `10点半`；跨午夜（如 `22:00-02:00`）明确报 `HOURS_RANGE`，本轮不引入跨天字段。

`readyForReview = missingFields.length === 0 && errors.length === 0`。

---

## 6. 错误码与重试语义

### 6.1 传输/服务错误（抛 `AgentTurnError`）

| code | 触发 | retryable | UI 行为 |
| --- | --- | --- | --- |
| `AGENT_MOCK_FAILURE` | 开启“下一次请求模拟失败” | 是 | 错误条 + 重试；明确标注仅为 Mock |
| `AGENT_TIMEOUT` | 超过 12s | 是 | “请求超时，请重试”；保留输入 |
| `AGENT_NETWORK` | 网络错误/未知异常 | 是 | “网络不可用，请检查后重试” |
| `AGENT_ABORTED` | 外部取消 | 否 | 静默 |
| `AGENT_HTTP_4XX` | 400/401/403/404/409/422 | 否 | 展示服务端 message；401/403 提示重新登录 |
| `AGENT_RATE_LIMITED` | 429 | 是 | “请求过于频繁，稍后重试” |
| `AGENT_HTTP_5XX` | 500/502/503 | 是 | “服务暂时不可用，请重试” |
| `AGENT_RESPONSE_INVALID` | 非 JSON、缺字段、类型错、草稿越界 | 否 | “返回内容无法识别，请重新描述” |
| `AGENT_CONTRACT_MISMATCH` | 版本不匹配 | 否 | “客户端与服务端版本不一致” |
| `AGENT_TRANSPORT_UNKNOWN` | 未知 transport / 未注入 fetch | 否 | 开发期错误 |
| `AGENT_REQUEST_INVALID` | utterance 为空或超长 | 否 | 输入框提示 |

`AgentTurnError` 只暴露 `name / code / message / retryable / httpStatus / serverCode / requestId / details`；**不包含堆栈、原始响应体、Token、密钥**。

### 6.1.1 后端 HTTP 错误码（NestJS AgentModule）

| code | HTTP | 触发 |
| --- | --- | --- |
| `AGENT_REQUEST_INVALID` | 400 | 请求体不是 JSON 对象 |
| `AGENT_CONTRACT_MISMATCH` | 400 | `contractVersion` 不是 `agent-turn.v1` |
| `UTTERANCE_INVALID` | 400 | `utterance` 为空或超过 500 字 |
| `DRAFT_INVALID` | 400 | `draft` 不是对象 |
| `CLIENT_INVALID` | 400 | `client.surface/phase` 不匹配 |
| `PROJECT_ID_INVALID` | 400 | 本轮 `projectId` 非 null |
| `AUTH_REQUIRED` | 401 | production 或 `AGENT_REQUIRE_AUTH=true` 且无 Authorization |
| `AUTH_INVALID` | 401 | Authorization 不是合法 Bearer |
| `DEEPSEEK_NOT_CONFIGURED` | 503 | 缺少 `DEEPSEEK_API_KEY`（不会回退 Mock） |
| `DEEPSEEK_TIMEOUT` | 504 | 超过 `DEEPSEEK_TIMEOUT_MS` |
| `DEEPSEEK_UNAVAILABLE` | 502 | 网络不可达 |
| `DEEPSEEK_AUTH_FAILED` | 502 | 上游 401/403 |
| `DEEPSEEK_RATE_LIMITED` | 503 | 上游 429 |
| `DEEPSEEK_UPSTREAM_ERROR` | 502 | 上游 5xx |
| `DEEPSEEK_REQUEST_REJECTED` | 502 | 上游其它 4xx |
| `DEEPSEEK_RESPONSE_INVALID` | 502 | 内容为空、非 JSON、不是对象 |
| `AGENT_INTERNAL_ERROR` | 500 | 未预期异常 |

错误体统一为 `{ code, message, requestId }`，同时写入响应头 `X-Request-Id`。

### 6.2 重试约定

1. 不自动重试；超时、网络、5xx、429、Mock 失败只提供手动重试。
2. 重试复用 `lastUtterance` 与**当前最新草稿**，不追加新的 user 消息。
3. 每次重试 `attempts + 1`，失败条展示“第 N 次尝试”。
4. 请求中禁止再次提交；失败后输入框必须保持可编辑、提交按钮可用。
5. 4xx / 契约不匹配 / 响应非法不提供重试，应重新描述或更新应用。

---

## 7. 实现映射

### 7.1 前端（已落地）

| 文件 | 职责 |
| --- | --- |
| `src/domain/agentDraft.mjs` | 草稿工厂、规范化、金额整数分、营业时间归一化、缺项/错误、追问、补丁合并、契约投影/反投影 |
| `src/services/agentTurn/agentServiceConfig.js` | `VITE_AGENT_TRANSPORT=mock\|http`、`AGENT_ENDPOINT`、超时、版本、`describeAgentTransport()` |
| `src/services/agentTurn/agentTurnError.js` | 错误码、构造、识别、归一化 |
| `src/services/agentTurn/mockAgentTransport.js` | 本地规则解析、固定回复模板、`meta.mock=true`、一次性失败注入 |
| `src/services/agentTurn/httpAgentTransport.js` | 完整 HTTP 契约、超时、错误归一化、响应结构校验；`http` 模式启用 |
| `src/services/agentTurn/agentTurnService.js` | React 唯一调用入口；`http` 模式自动创建 HTTP transport；不信服务端 `status`，用本地校验决定状态 |
| `src/state/sessionMachine.mjs` | `agentDraft` / `agent` 切片、请求生命周期、编辑、确认/重开、选择器 |
| `src/components/agent/*` | 状态面板、草稿编辑器、已确认摘要；组件内无 `fetch`、无 service import |
| `src/App.jsx` | 只做组合根：派发 action、调用 `requestAgentTurn`、接线组件 |

### 7.2 后端（已落地）

| 文件 | 职责 |
| --- | --- |
| `server/src/agent/agent.controller.ts` | `POST /agent/turn`，返回 200，写 `X-Request-Id` |
| `server/src/agent/agent.service.ts` | 严格请求校验 → Provider → 白名单合并 → 校验 → `agent-turn.v1` |
| `server/src/agent/agent-draft.validator.ts` | 服务端独立校验、营业时间归一化、补丁合并、追问 |
| `server/src/agent/provider/deepseek-agent.provider.ts` | DeepSeek `/chat/completions`、超时、响应清洗、错误映射 |
| `server/src/agent/agent-auth.guard.ts` | 临时鉴权边界（401） |
| `server/src/agent/agent-exception.filter.ts` | 统一错误体 `{ code, message, requestId }` |
| `server/src/common/config/env.validation.ts` | DeepSeek 配置校验；production 强制 `AGENT_REQUIRE_AUTH=true` |

**状态机（`STORE_INFO` 内子状态，不新增顶层 phase）**

```text
idle → requesting → collecting（缺项追问）
                  → reviewing（可编辑确认）
reviewing → confirmed（店主明确确认）
failed ← 请求失败；Composer 保持可用，可手动重试
confirmed → reviewing（再次编辑）→ confirmed（重新确认）
```

---

## 8. Mock ↔ HTTP 替换（已完成）

本轮已完成替换，前端只换 transport，UI、reducer、领域层不改：

1. 后端 `POST /api/v1/agent/turn` 已实现，响应严格符合第 4 节，`meta.mock=false`、`meta.provider="deepseek"`、`meta.model` 为实际模型名。
2. `agentTurnService.js` 在 `VITE_AGENT_TRANSPORT=http` 时自动创建 `createHttpTransport`：

   ```js
   createHttpTransport({
     fetchImpl: globalThis.fetch.bind(globalThis),
     endpoint: '/api/v1/agent/turn',
     timeoutMs: 30000,
     // getAuthorization 默认返回 null；DeepSeek Key 永不下发前端
   })
   ```

3. 默认仍为 `mock`，保证没有后端时桌面端可启动；切换只依赖环境变量。
4. `meta.mock` 可辨识：HTTP 模式 UI 显示「DeepSeek 后端（真实模型）」，Mock 模式显示「本地 Mock（未接入真实模型）」。
5. **真实 DeepSeek 调用已于 2026-10-31 验证通过**（键值仅在本机被 git 忽略的 `server/.env`，验证后由用户销毁）；自动化测试仍全部使用 mock fetch，禁止真实计费请求。

---

## 9. 模型接入状态与后续（Q1–Q10）

**当前真实 Provider：DeepSeek。** 通过 `DEEPSEEK_API_BASE_URL / DEEPSEEK_API_KEY / DEEPSEEK_MODEL / DEEPSEEK_TIMEOUT_MS` 配置，**Key 只存在于服务端**。**ModelArts Studio / 盘古尚未接入**；没有 Skill、工具调用、多 Agent、自主规划和自动发布。

下表保留为后续切换 ModelArts / 盘古时的待确认项：

| 编号 | 待确认 | 本轮处理 |
| --- | --- | --- |
| Q1 调用方式 | ModelArts Studio 工作流、托管推理还是盘古 API？同步还是异步任务？ | 契约按同步单轮设计；异步需扩展 `turnId` 轮询 |
| Q2 鉴权方式 | IAM Token、AK/SK 签名、API Key 还是临时 STS？ | **前端只接收短期 Token**；AK/SK 永不下发前端 |
| Q3 模型名称/版本 | 具体模型名、版本、上下文长度、是否支持结构化输出 | `meta.model` 预留；Mock 固定 `null` |
| Q4 超时/配额/限流 | 单请求超时、QPS、日配额、并发上限 | 前端超时 12s；限流映射 `AGENT_RATE_LIMITED` |
| Q5 是否流式 | 是否需要 SSE/流式返回 | 本轮非流式；流式需新增事件协议 |
| Q6 内容审核/脱敏 | 输入输出审核、敏感信息脱敏责任方 | 本轮无；后端接入时确认 |
| Q7 日志与可观测性 | 请求 ID、模型调用日志、保留周期、脱敏字段 | 前端只保留 `requestId`；不记录原文 |
| Q8 会话归属/多租户 | Agent 会话如何归属店主、如何隔离 | 本轮无持久化；**不复用 B1 `sessions`** |
| Q9 幂等 | 重试是否会产生重复回合/重复扣费 | 建议后端支持 `Idempotency-Key` + `turnId` 去重 |
| Q10 最终校验责任 | 价格、营业时间、菜品数量的最终校验方 | 前端领域层已是门槛；后端必须二次校验后才允许保存 |

**账号/API/鉴权/区域信息仍是未知项**：华为云账号归属、ModelArts Studio 工作区与服务 ID、API 形式与版本、IAM/Token 策略、区域（Region）与 Endpoint、模型名称与版本、配额与限流、内容审核策略、日志保留周期、幂等策略、租户隔离方案。以上均需在接入前由项目负责人确认，**本轮未配置、未伪造任何凭据**。

---

## 10. 本轮验证证据（DeepSeek 接入轮次）

- `cd server && npm test`：**68/68 通过**（validator 29、service 12、provider 16、e2e 11）。
- `cd server && npm run build`：通过（`nest build`，无错误）。
- 根目录 `npm test`：**96/96 通过**（原有 91 项 + 新增 5 项 transport 配置测试）。
- 根目录 `npm run build`：退出码 0，1613 modules，CSS 56.12 kB / JS 254.73 kB。
- `VITE_AGENT_TRANSPORT=http npx vite build`：通过，产物包含 `VITE_AGENT_TRANSPORT:"http"`。
- 真实服务启动验证：
  - `GET /api/v1/health` → 200；`GET /api/v1/readyz` → 200（database ok，cache redis）。
  - 无 Key 时 `POST /api/v1/agent/turn` → **503 `DEEPSEEK_NOT_CONFIGURED`**，`X-Request-Id` 与响应体 `requestId` 一致。
  - `contractVersion=agent-turn.v0` → **400 `AGENT_CONTRACT_MISMATCH`**。
  - CORS 预检 → 204，允许 `X-Agent-Contract`，暴露 `X-Request-Id`。
- 测试运行期间无真实 DeepSeek 请求。

> **真实 DeepSeek 调用未验证**：本机 `server/.env` 与仓库均未配置 `DEEPSEEK_API_KEY`。填入 Key 后按 [`本轮DeepSeek接入交接.md`](本轮DeepSeek接入交接.md) 第 9 节完成首次真实调用。
>
> **ModelArts / 盘古仍未接入**；本轮交付的是 DeepSeek 真实链路 + 可替换的 Provider 边界。