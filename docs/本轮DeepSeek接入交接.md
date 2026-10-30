# 本轮交接：DeepSeek Agent 首次真实接入

> 日期：2026-10-31
> 状态：**后端 `POST /api/v1/agent/turn` 已实现，真实 Provider 为 DeepSeek；前端支持 `mock|http` 切换。**
> 真实 DeepSeek 调用**已于 2026-10-31 验证通过**：Key 仅写入本机被 git 忽略的 `server/.env`，未进入仓库、前端、日志或文档；验证完成后由用户自行销毁该 Key。详见第 7.5 节。
> 上游契约：[`agent-turn-contract.md`](agent-turn-contract.md)；上一轮交接：[`本轮Agent接入前准备交接.md`](本轮Agent接入前准备交接.md)。

---

## 0. 一句话结论

桌面端现在具备两条可切换链路：

```text
默认（无后端）：桌面端 → 本地 Mock transport（零网络，UI 可启动）

设置 VITE_AGENT_TRANSPORT=http：
桌面端 → POST /api/v1/agent/turn → NestJS AgentModule → DeepSeek chat/completions
       → 后端解析并白名单合并 → 后端草稿校验 → agent-turn.v1 → 前端展示追问/草稿
```

**本轮没有接入 ModelArts、盘古、Skill、工具调用、多 Agent、自主规划、动态代码生成或数据库写入。**

---

## 1. 本轮目标与边界

### 1.1 已完成

| 能力 | 状态 |
| --- | --- |
| `POST /api/v1/agent/turn`（`agent-turn.v1`） | ✅ 已实现 |
| DeepSeek OpenAI 兼容 Provider | ✅ 已实现（`/chat/completions`） |
| 服务端独立草稿校验（不信任前端/模型） | ✅ 已实现 |
| 模型输出 JSON 解析、去 Markdown 围栏、白名单合并 | ✅ 已实现 |
| 缺少 Key 返回 `503 DEEPSEEK_NOT_CONFIGURED`，不回退 Mock | ✅ 已实现 |
| 鉴权临时边界（development/test 联调开关） | ✅ 已实现 |
| CORS `X-Agent-Contract` + `X-Request-Id` | ✅ 已实现 |
| 前端 `VITE_AGENT_TRANSPORT=mock\|http` | ✅ 已实现 |
| 后端 mock fetch 测试（14 项要求全覆盖） | ✅ 68 项通过 |
| 前端保留既有测试 + 新增配置测试 | ✅ 96 项通过 |

### 1.2 明确未做

- 未接入 ModelArts Studio、盘古、华为云任何模型。
- 未接入 Skill、工具调用、多 Agent、自主规划、流式输出。
- 未写业务数据库：Agent 模块不 import Prisma，也没有 `agent_sessions` / `agent_turns` 表。
- 未做完整店主登录：`Authorization` 只校验 Bearer 形式，属于临时边界。
- 未做幂等 `Idempotency-Key`、限流、内容审核、用量计费。
- 未修改 B1 点餐模块、Electron 打包、模板、小程序、导出工程。

---

## 2. DeepSeek 配置

### 2.1 变量列表

写入 `server/.env`（**不提交**）或云端密钥管理系统；`server/.env.example` 只放空值与默认值。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DEEPSEEK_API_BASE_URL` | `https://api.deepseek.com` | 必须为 http(s) URL；末尾斜杠自动去掉 |
| `DEEPSEEK_API_KEY` | 空 | **唯一真实密钥位置**；留空时接口 503，不回退 Mock |
| `DEEPSEEK_MODEL` | `deepseek-chat` | `[A-Za-z0-9._:-]{1,64}`，可改 `deepseek-reasoner` |
| `DEEPSEEK_TIMEOUT_MS` | `30000` | 1000–120000 整数毫秒 |
| `AGENT_REQUIRE_AUTH` | `false` | 仅 development/test 可为 false；production 必须为 true |

前端只读取 `VITE_AGENT_TRANSPORT`、`VITE_AGENT_ENDPOINT`、`VITE_AGENT_TIMEOUT_MS`，**不读取任何 `DEEPSEEK_*` 变量**。

### 2.2 环境校验策略

`server/src/common/config/env.validation.ts`：

- 校验 URL、模型名、超时范围；空值回落到安全默认值。
- **开发环境缺少 `DEEPSEEK_API_KEY` 不阻止服务启动**；请求时才返回 503。
- `NODE_ENV=production` 时：
  - 沿用原有 demo 开关与微信配置校验；
  - 新增：`AGENT_REQUIRE_AUTH` 必须为 `true`，否则启动失败。

### 2.3 密钥红线

- 真实 Key 只允许存在 `server/.env` 或云端密钥管理系统。
- 不写入前端 `.env`、`VITE_*`、日志、错误响应、仓库、导出工程。
- 错误体只返回稳定错误码与中文提示；不返回上游原始响应、堆栈、Key。
- 日志记录 `requestId`、模型名、耗时、状态、缺项/错误数量，**不记录 utterance 原文、草稿全文、模型完整响应**。

---

## 3. 后端模块

### 3.1 目录

```text
server/src/agent/
  agent.module.ts                 注册 Controller/Service/Provider/Guard
  agent.controller.ts             POST /agent/turn，200，写 X-Request-Id
  agent.service.ts                请求校验 → Provider → 合并 → 校验 → agent-turn.v1
  agent.types.ts                  ContractDraft / InternalDraft / Response / 注入 token
  agent-draft.validator.ts        服务端独立校验、归一化、白名单补丁合并、追问
  agent-auth.guard.ts             临时鉴权边界（401）
  agent-exception.filter.ts       统一错误体 { code, message, requestId }
  provider/
    agent-provider.interface.ts   AgentProvider 接口与 AgentFetch 类型
    deepseek-agent.provider.ts    DeepSeek /chat/completions 调用与响应清洗
server/src/common/request-id.ts   requestId 生成/复用
```

`server/src/app.module.ts` 已注册 `AgentModule`；`main.ts` CORS 增加 `X-Agent-Contract` 并暴露 `X-Request-Id`。

### 3.2 请求处理顺序

1. `AgentAuthGuard`：临时鉴权，生成/复用 `requestId`。
2. `AgentService.parseTurnRequest`：严格校验 `contractVersion`、`utterance`、`draft`、`client`、`projectId`。
3. `DeepseekAgentProvider.extractTurn`：调用 DeepSeek，取 `choices[0].message.content`。
4. 去掉 Markdown 围栏 → `JSON.parse` → 只取 `reply` 与 `draftPatch`。
5. `applyDraftPatch`：白名单合并到当前草稿（未知字段丢弃、空串不覆盖）。
6. `validateInternalDraft`：后端重新计算 `missingFields`、`errors`、`readyForReview`。
7. 生成 `status`、`nextQuestion`、`meta`，返回 `agent-turn.v1`。

模型返回的 `status`、`missingFields`、`errors`、`readyForReview` **全部忽略**。

### 3.3 服务端校验规则

| 字段 | 规则 | 缺项 | 错误码 |
| --- | --- | --- | --- |
| `storeName` | 1–48 Unicode 码点 | `REQUIRED` | `NAME_TOO_LONG` |
| `category` | 1–24 码点 | `REQUIRED` | `CATEGORY_TOO_LONG` |
| `businessHours` | 1–3 段 `HH:MM-HH:MM`，`start < end`，不重叠，不允许跨午夜 | `REQUIRED` | `HOURS_FORMAT` / `HOURS_RANGE` / `HOURS_OVERLAP` / `HOURS_TOO_MANY` |
| `fulfillment` | 至少堂食或自取一个 true | `FULFILLMENT_REQUIRED` | — |
| `dishes` 数量 | 3–5 | `DISHES_TOO_FEW` | `DISHES_TOO_MANY` |
| `dishes[].name` | 1–24 码点 | `DISH_NAME_REQUIRED` | `DISH_NAME_TOO_LONG` |
| `dishes[].priceCents` | 整数分 1–999999 | `PRICE_REQUIRED` | `PRICE_INVALID` / `PRICE_RANGE` |
| `dishes[].description` | ≤60 码点 | — | `DESCRIPTION_TOO_LONG` |
| `dishes[].id` | 1–32 可见字符且唯一 | 自动补齐 | `DISH_ID_INVALID` |

`readyForReview = missingFields.length === 0 && errors.length === 0`；只有此时 `status=reviewing`。

服务端不复用前端 React 状态，也不把 `priceText` 写入响应。

---

## 4. API 契约与示例

### 4.1 请求

```http
POST /api/v1/agent/turn
Content-Type: application/json; charset=utf-8
X-Agent-Contract: agent-turn.v1
Authorization: Bearer <短期 Token；development/test 联调可省略>
```

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

### 4.2 成功响应（资料完整 → reviewing）

```json
{
  "contractVersion": "agent-turn.v1",
  "turnId": "turn-8f0c2f0e-6d7a-4c31-9e2b-2a1f4d5c6b70",
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
  "meta": {
    "transport": "http",
    "provider": "deepseek",
    "mock": false,
    "model": "deepseek-chat",
    "latencyMs": 1834
  }
}
```

### 4.3 缺营业时间（collecting）

```json
{
  "contractVersion": "agent-turn.v1",
  "turnId": "turn-3c1d0b3f-6a9e-4b6d-8f77-2d2a3c4b5e61",
  "status": "collecting",
  "reply": "记下了店名和菜品，还差营业时间。",
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
  "nextQuestion": {
    "field": "businessHours",
    "label": "营业时间",
    "text": "每天几点到几点营业？例如 10:00-21:00。"
  },
  "meta": {
    "transport": "http",
    "provider": "deepseek",
    "mock": false,
    "model": "deepseek-chat",
    "latencyMs": 1420
  }
}
```

### 4.4 错误响应

```json
{
  "code": "DEEPSEEK_NOT_CONFIGURED",
  "message": "DeepSeek 未配置",
  "requestId": "req_96dc9bace38006bd6e5e2786"
}
```

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
| `DEEPSEEK_NOT_CONFIGURED` | 503 | 缺少 `DEEPSEEK_API_KEY` |
| `DEEPSEEK_TIMEOUT` | 504 | 超过 `DEEPSEEK_TIMEOUT_MS` |
| `DEEPSEEK_UNAVAILABLE` | 502 | 网络不可达 |
| `DEEPSEEK_AUTH_FAILED` | 502 | 上游 401/403 |
| `DEEPSEEK_RATE_LIMITED` | 503 | 上游 429 |
| `DEEPSEEK_UPSTREAM_ERROR` | 502 | 上游 5xx |
| `DEEPSEEK_REQUEST_REJECTED` | 502 | 上游其它 4xx |
| `DEEPSEEK_RESPONSE_INVALID` | 502 | 内容为空、非 JSON、不是对象 |
| `AGENT_INTERNAL_ERROR` | 500 | 未预期异常 |

前端映射：所有 5xx（含 503/504）→ `AGENT_HTTP_5XX`（可重试）；401/403 → `AGENT_HTTP_4XX`（提示重新登录，不可重试）。

---

## 5. 鉴权与 CORS

### 5.1 临时鉴权边界

| 环境 | `AGENT_REQUIRE_AUTH` | 无 Authorization | 有 Bearer |
| --- | --- | --- | --- |
| development / test | false | 放行（本地联调） | 放行 |
| development / test | true | 401 `AUTH_REQUIRED` | 放行 |
| production | 必须 true（否则启动失败） | 401 `AUTH_REQUIRED` | 放行 |

- 本轮只校验 Bearer 形式，**不做真实店主身份解析**。
- DeepSeek API Key 不是客户端 Token，永不用于鉴权。
- `AGENT_REQUIRE_AUTH=false` **不能用于生产**：启动校验会拒绝。

### 5.2 CORS

`main.ts`：

```ts
allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Agent-Contract'],
exposedHeaders: ['X-Request-Id'],
```

真实预检结果：`Access-Control-Allow-Headers: Content-Type,Authorization,Idempotency-Key,X-Agent-Contract`，`Access-Control-Expose-Headers: X-Request-Id`。

---

## 6. 前端切换

### 6.1 配置

`src/services/agentTurn/agentServiceConfig.js`：

- 默认 `mock`（12s 超时），保证没有后端时页面仍可启动。
- `VITE_AGENT_TRANSPORT=http` → `http` 模式，默认 30s 超时（与后端 `DEEPSEEK_TIMEOUT_MS` 对齐）。
- `VITE_AGENT_ENDPOINT` 覆盖 endpoint，默认 `/api/v1/agent/turn`。
- `VITE_AGENT_TIMEOUT_MS` 覆盖超时（≥1000ms）。
- 导出纯函数 `resolveAgentTransportConfig()` 便于测试。

`src/services/agentTurn/agentTurnService.js`：

- `http` 模式自动创建 `createHttpTransport({ fetchImpl, endpoint, timeoutMs })`。
- 默认 `getAuthorization` 返回 `null`，**不携带 DeepSeek Key**。
- 仍以本地 `validateAgentDraft` 作为最终确认门槛；不信任服务端 `status`。
- 失败、重试、输入可编辑行为保持不变；状态机未重写。

### 6.2 验证 Vite 注入

```bash
VITE_AGENT_TRANSPORT=http npx vite build --outDir dist-http-check
# 产物包含 "VITE_AGENT_TRANSPORT":"http"
```

（验证后已删除临时产物目录。）

---

## 7. 测试与真实结果

### 7.1 命令与结果

| 命令 | 真实结果 |
| --- | --- |
| `cd server && npm run build` | 通过（`nest build`，无错误） |
| `cd server && npm test` | **68/68 通过**（4 个测试文件，约 1.2–1.8s） |
| `npm test`（根目录） | **96/96 通过**（原 91 + 新增 5） |
| `npm run build`（根目录） | 退出码 0，1613 modules，CSS 56.12 kB / JS 254.73 kB |
| `VITE_AGENT_TRANSPORT=http npx vite build` | 通过，产物含 `VITE_AGENT_TRANSPORT:"http"` |

### 7.2 服务端测试覆盖（对应本轮 14 项要求）

| 编号 | 覆盖内容 | 测试文件 |
| --- | --- | --- |
| 1 | 正常 DeepSeek JSON → `agent-turn.v1` | `agent.service.test.ts` / `deepseek-agent.provider.test.ts` |
| 2 | Markdown 围栏 JSON | `deepseek-agent.provider.test.ts` |
| 3 | 非法 JSON → `DEEPSEEK_RESPONSE_INVALID` | 同上 |
| 4 | 未知字段被丢弃 | `agent.service.test.ts` |
| 5 | 非法价格 → `PRICE_INVALID` | `agent.service.test.ts` |
| 6 | 超时 → 504 | `deepseek-agent.provider.test.ts` |
| 7 | 401 → `DEEPSEEK_AUTH_FAILED` | 同上 |
| 8 | 429 → `DEEPSEEK_RATE_LIMITED` | 同上 |
| 9 | 5xx → `DEEPSEEK_UPSTREAM_ERROR` | 同上 |
| 10 | 缺少 Key → 503 `DEEPSEEK_NOT_CONFIGURED` | Provider + e2e |
| 11 | 缺营业时间 → collecting + nextQuestion | `agent.service.test.ts` |
| 12 | 资料完整 → reviewing | `agent.service.test.ts` |
| 13 | production 未认证 → 401 | `agent.controller.e2e.test.ts` |
| 14 | 确认前无数据库写入 | 静态检查（agent 模块不含 Prisma/存储） |

测试全部使用注入的 fetch stub，**没有任何真实 DeepSeek 请求**。

### 7.3 真实服务启动验证（本机，development）

```text
GET  /api/v1/health              → 200 {"status":"ok",...}
GET  /api/v1/readyz              → 200 {"status":"ok","database":"ok","cache":"redis"}
POST /api/v1/agent/turn（无 Key） → 503
  {"code":"DEEPSEEK_NOT_CONFIGURED","message":"DeepSeek 未配置","requestId":"req_96dc..."}
  X-Request-Id: req_96dc9bace38006bd6e5e2786
POST /api/v1/agent/turn（v0 契约）→ 400
  {"code":"AGENT_CONTRACT_MISMATCH",...}
OPTIONS /api/v1/agent/turn        → 204，允许 X-Agent-Contract，暴露 X-Request-Id
```

验证后已停止服务，3000 端口已释放。

### 7.4 是否实际调用过 DeepSeek

**已实际调用，并通过。** 2026-10-31 用户临时提供测试 Key，仅写入本机 `server/.env`（被 `.gitignore` 第 20 行 `.env` 忽略、未被 git 追踪），未写入前端 `.env`、`VITE_*`、日志、错误响应、文档或仓库。

### 7.5 首次真实调用记录（2026-10-31，development，`deepseek-chat`）

两次真实 HTTP 请求均命中 `POST /api/v1/agent/turn`，上游为 `https://api.deepseek.com/chat/completions`，无 mock、无重试兜底。

```text
请求 1（资料完整）
  HTTP 200  耗时 1.11s
  X-Request-Id: req_8a66acc73d9d3ca69396be4e
  status: reviewing
  draft.storeName: 松月食堂
  draft.category: 社区家常菜
  draft.businessHours: 10:00-21:00
  draft.fulfillment: {"dineIn":true,"takeaway":true}
  dishes: 宫保鸡丁 2800 / 番茄炒蛋 1600 / 米饭 300（均为整数分）
  missingFields: []  errors: []
  meta: {"transport":"http","provider":"deepseek","mock":false,"model":"deepseek-chat","latencyMs":1095}

请求 2（只给店名与品类，验证追问）
  HTTP 200  耗时 0.73s
  status: collecting
  missingFields: businessHours / fulfillment / dishes（"还差 3 道菜"）
  nextQuestion.field: businessHours
  模型未臆造营业时间，具体实现为返回空值，符合"不臆造"约束
  meta: {"provider":"deepseek","mock":false,"model":"deepseek-chat","latencyMs":725}
```

安全性抽查：

- `grep "sk-<前缀>" server 日志` → **0 条**
- `grep "Bearer" server 日志` → **0 条**
- 日志只记录 `requestId / model / latencyMs / status / utteranceLength / missing / errors`
- 全仓库检索 Key 明文 → 只命中被 `.gitignore` 忽略的 `server/.env`，`dist/`、前端源码与文档均无

### 7.6 桌面端全链路端到端验证（2026-10-31）

浏览器同源路径经 Vite dev server 代理到 NestJS，再打到 DeepSeek：

```text
VITE_AGENT_TRANSPORT=http npx vite --port 5173
POST http://127.0.0.1:5173/api/v1/agent/turn
  → Vite proxy → http://127.0.0.1:3000/api/v1/agent/turn
  → DeepSeek chat/completions
HTTP 200，耗时 1.46s
status: reviewing
meta: {"transport":"http","provider":"deepseek","mock":false,"model":"deepseek-chat","latencyMs":1452}
```

前置条件：`vite.config.js` 增加 `/api` → `http://127.0.0.1:3000` 代理。若不想用代理，也可用绝对地址绕过：

```env
VITE_AGENT_ENDPOINT=http://127.0.0.1:3000/api/v1/agent/turn
```

此时浏览器直连后端，依赖后端 `DESKTOP_ORIGIN=http://127.0.0.1:5173` 的 CORS 放行（已实测 OPTIONS 204）。

> 说明：该 Key 为测试 Key，验证后由用户自行销毁；销毁后 `DEEPSEEK_API_KEY` 留空时接口会重新返回 503 `DEEPSEEK_NOT_CONFIGURED`，这是预期行为，不视为故障。

---

## 8. 修改文件清单

### 新增（后端）

```text
server/src/agent/agent.module.ts
server/src/agent/agent.controller.ts
server/src/agent/agent.service.ts
server/src/agent/agent.types.ts
server/src/agent/agent-draft.validator.ts
server/src/agent/agent-auth.guard.ts
server/src/agent/agent-exception.filter.ts
server/src/agent/provider/agent-provider.interface.ts
server/src/agent/provider/deepseek-agent.provider.ts
server/src/common/request-id.ts
server/vitest.config.mts
server/test/setup.ts
server/test/agent-draft.validator.test.ts
server/test/agent.service.test.ts
server/test/deepseek-agent.provider.test.ts
server/test/agent.controller.e2e.test.ts
```

### 修改（后端）

```text
server/src/app.module.ts                注册 AgentModule
server/src/main.ts                      CORS allowedHeaders/exposedHeaders
server/src/common/config/env.validation.ts  DeepSeek 配置与生产鉴权校验
server/.env.example                     DeepSeek 变量与 AGENT_REQUIRE_AUTH
```

### 修改（前端）

```text
src/services/agentTurn/agentServiceConfig.js  mock|http、endpoint、超时、标签
src/services/agentTurn/agentTurnService.js    http 模式自动创建 HTTP transport
vite.config.js                                 开发态 `/api` 代理到 http://127.0.0.1:3000（默认相对 endpoint 必需）
```

### 新增（前端测试）

```text
test/agent-transport-config.test.cjs  C1–C5：默认 mock、http 覆盖、真实环境变量、不携带 Key
```

### 未修改

- 仓库内文件：未写入任何 Key（`server/.env` 属 git 忽略文件，仅在 2026-10-31 真实验证期间临时写入测试 Key，未提交、未导出）
- B1 点餐模块、Electron 打包、模板、小程序、导出工程
- 原有 UI 组件与状态机

---

## 9. 如何完成首次真实调用

> 状态：**已于 2026-10-31 完成首次真实调用**（结果见 7.5）。以下步骤保留，用于换 Key 或换机器时复验。

1. 在 `server/.env` 增加（**不要提交**）：

   ```env
   DEEPSEEK_API_BASE_URL=https://api.deepseek.com
   DEEPSEEK_API_KEY=<你的 Key>
   DEEPSEEK_MODEL=deepseek-chat
   DEEPSEEK_TIMEOUT_MS=30000
   AGENT_REQUIRE_AUTH=false
   ```

2. 重新构建并启动：

   ```bash
   cd server
   npm run build
   npm run start:prod
   ```

3. 直接验证接口：

   ```bash
   curl -X POST http://127.0.0.1:3000/api/v1/agent/turn \
     -H 'Content-Type: application/json' \
     -H 'X-Agent-Contract: agent-turn.v1' \
     -d '{"contractVersion":"agent-turn.v1","utterance":"店名叫松月食堂，做社区家常菜，每天 10:00-21:00，堂食和自取都做。招牌是宫保鸡丁 28 元、番茄炒蛋 16 元、米饭 3 元。","draft":{"storeName":"","category":"","businessHours":"","fulfillment":{"dineIn":false,"takeaway":false},"dishes":[]},"client":{"surface":"desktop","phase":"store-info"},"projectId":null}'
   ```

4. 前端联调：

   ```bash
   # 根目录 .env（不要写 Key，只写 transport）
   VITE_AGENT_TRANSPORT=http
   npm run desktop:dev
   ```

---

## 10. 未完成与后续建议

| 事项 | 建议 |
| --- | --- |
| 真实 DeepSeek 调用验证 | 填入 Key 后执行第 9 节，记录真实 `latencyMs` 与回复样例 |
| 店主真实登录 | 接 B1 `auth`，把 `AgentAuthGuard` 换成真实 Token → 店主身份 |
| 幂等 | 支持 `Idempotency-Key` + `turnId` 去重，避免重试重复计费 |
| 限流 | 按店主/IP 限流，429 映射 `AGENT_RATE_LIMITED` |
| 内容审核 | 输入输出审核与敏感经营信息脱敏 |
| 会话持久化 | 新增独立 `agent_sessions` / `agent_turns`，**不得复用 B1 `sessions`** |
| 模型切换 | ModelArts / 盘古接入时新增 Provider 实现，不改 Controller/Service/契约 |
| Electron 打包 | `VITE_AGENT_TRANSPORT=http` 需在打包配置中显式注入 |

---

## 11. 红线复述

- 当前真实 Provider 是 **DeepSeek**；ModelArts / 盘古尚未接入。
- DeepSeek Key 只在服务端；前端只有短期 Token 或空。
- Agent 仍然不写业务数据库；确认前不落库、不发布。
- development/test 的未认证联调开关不能用于生产（启动校验 + 请求校验双保险）。
- 当前没有 Skill、工具调用、多 Agent、自主规划和自动发布。

---

## 12. 回退方案

| 场景 | 回退动作 |
| --- | --- |
| 前端回到纯 Mock | 移除 `VITE_AGENT_TRANSPORT=http`（默认即 mock） |
| 停用真实后端 | 不部署/不启动 `AgentModule`；前端保持 mock |
| 回退后端 | 删除 `server/src/agent/` 与 `app.module.ts` 中的 `AgentModule`；恢复 `main.ts` CORS 头 |
| 回退前端配置 | 恢复 `agentServiceConfig.js` 为固定 `mock`，移除 `agentTurnService.js` 的 http 分支 |

回退只针对本轮新增内容，**禁止 `git reset` / `git checkout` / `git clean` / `git stash`**。