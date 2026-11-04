# BUG-019 CORS 白名单缺少 `X-Agent-Request-Id`，对话修改模板一律报 `AGENT_NETWORK`

- 状态：已修复
- 级别：P0 阻断
- 发现日期：2026-11-03
- 发现人/来源：用户反馈（桌面截图：自检五项全绿，但「对话修改」面板报 `AGENT_NETWORK`）
- 影响版本：`0.2.0` 工作区当前代码（`agent-template-revise.v1` / `agent-template-candidates.v1`）
- 影响面：
  - 桌面「模板匹配」页 →「对话修改 → 应用修改」：必然失败，显示「网络不可用，请检查配置后重试」
  - 「重新匹配骨架 / 重新描述候选」的模型版链路：请求同被预检拦截，静默降级为本地规则（`meta.degraded=true`，标签「本地规则（模型不可用）」）
  - 后端 `/api/v1/agent/turn`（开店资料轮次）不受影响：它只带 `X-Agent-Contract`
- 涉及文件：
  - `server/src/main.ts:126`（`allowedHeaders`）
  - `src/services/agentTurn/templateReviseTransport.js:430`（`X-Agent-Request-Id`）
  - `src/services/agentTurn/templateCandidatesService.js:341`（`X-Agent-Request-Id`）

## 1. 现象

1. 设置页「运行自检」五项全绿（运行环境 / 数据目录 / Composer 资源 / 后端服务 / 模型通道），后端 `health` 与 `readyz` 均 200。
2. 模板匹配页底部状态显示「DeepSeek 后端（真实模型）」，但点击「应用修改」后固定报：
   - 错误码 `AGENT_NETWORK`
   - 文案「网络不可用，请检查配置后重试」
3. 后端日志中**没有**该请求的任何处理记录（请求在 CORS 预检阶段就被 Chromium 拒绝，未发出真实 POST）。
4. 模板推荐请求同样被拦，界面表现是候选来源回落为「本地规则（模型不可用）」。

## 2. 根因

CORS 预检（`OPTIONS`）返回的 `Access-Control-Allow-Headers` 不含前端实际发送的自定义头：

```text
请求头（template-revise）：Content-Type, X-Agent-Contract, X-Agent-Request-Id
预检响应实际值：Content-Type,Authorization,Idempotency-Key,X-Agent-Contract
```

`server/src/main.ts` 的 `allowedHeaders` 只列了 4 项，漏掉 `X-Agent-Request-Id`。Chromium 判定预检失败 → `fetch` 抛 `TypeError: Failed to fetch` → `normalizeAgentTurnError` 把**任意非 `AgentTurnError`** 归一为 `AGENT_NETWORK`（`src/services/agentTurn/agentTurnError.js:53-56`），于是界面显示「网络不可用」。

自检全绿与失败并存的原因：自检的后端探测是简单 `GET /api/v1/health`（无自定义头，不触发预检），而模板修订是 `POST` + 两个自定义头（必触发预检）。**自检不覆盖 CORS 预检**，所以它无法发现这类问题。

## 3. 复现步骤

```text
1. npm start（MySQL + 后端 + 桌面端全部起来）
2. 进入「模板匹配」，选任一骨架，输入「主色换成暖橙」并点「应用修改」
   期望：模板补丁生效，预览改色
   实际：错误条 AGENT_NETWORK「网络不可用，请检查配置后重试」

3. 直接发预检请求（复现最小证据）：
   OPTIONS http://127.0.0.1:3000/api/v1/agent/template-revise
   Origin: http://127.0.0.1:5173
   Access-Control-Request-Headers: content-type,x-agent-contract,x-agent-request-id
   修复前响应头 allow-headers 缺少 X-Agent-Request-Id
```

## 4. 修复方案

- 方案 A（已采纳）：在 `server/src/main.ts` 的 `allowedHeaders` 增加 `X-Agent-Request-Id`；并新增根测试 `test/cors-headers.test.cjs`，从 `src/services/agentTurn/*.js` 收集所有 `X-` 自定义请求头，断言它们全部被后端 `allowedHeaders` 覆盖。
- 方案 B（未采纳）：前端改用 `X-Request-Id`（该头已在 `exposedHeaders` 中，但请求头方向仍需后端放行），或去掉单飞 requestId 头改放请求体。均涉及契约变更，成本高于方案 A。
- 推荐：A。改动最小、不动契约、不改变前端行为。

## 5. 验收标准

- [x] 预检响应 `allow-headers` 包含 `X-Agent-Request-Id`
- [x] 真实 `POST /api/v1/agent/template-revise` 返回 200 且补丁通过前端契约校验
- [x] `POST /api/v1/agent/template-candidates` 返回 200 且 `meta.mock=false`
- [x] 服务端 `agent.controller.e2e` 13/13、`tsc --noEmit` exit 0
- [x] 新增防回归测试通过（根测试 623 例 / 622 pass / 1 todo / 0 fail）
- [ ] 桌面端「应用修改」按钮的人工点击复验（GUI 属用户操作，未执行）

## 6. 验证证据

| 命令/操作 | 结果 |
| --- | --- |
| 修复前 `OPTIONS` 预检 | `204`，`allow-headers: Content-Type,Authorization,Idempotency-Key,X-Agent-Contract`（缺 `X-Agent-Request-Id`） |
| 修复后 `OPTIONS` 预检 | `204`，`allow-headers: Content-Type,Authorization,Idempotency-Key,X-Agent-Contract,X-Agent-Request-Id` |
| `POST /api/v1/agent/template-revise`（utterance「主色换成暖橙，首屏再大气一点」，`warm-bistro`） | `200`，1252ms，`patch={"theme":{"primaryColor":"#F97316"},"sizes":{"homeHero":"lg"}}`，`meta={transport:http, provider:deepseek, mock:false, model:deepseek-chat}` |
| `POST /api/v1/agent/template-candidates`（brief「想要大图招牌菜和门店故事」） | `200`，1337ms，`orderedTemplateIds=[signature-kitchen,warm-bistro,modern-coffee]`，`meta.mock=false` |
| `npx vitest run test/agent.controller.e2e.test.ts`（server） | exit 0，13/13 pass |
| `npx tsc --noEmit -p tsconfig.json`（server） | exit 0 |
| `npm test`（根） | exit 0，tests 623 / pass 622 / fail 0 / todo 1 |
| `npm run build` | exit 0 |

## 7. 备注

- 该缺陷只在 Chromium 渲染层（Electron / 浏览器 dev server）出现；用 Node 直接 `fetch` 打后端不会复现（Node 不做 CORS 校验），因此历史上的后端联调测试**无法**发现它，只有预检头断言能覆盖。
- 后端由 `nest start --watch` 启动时，改 `main.ts` 会自动重编译重启（实测 19:26:04 完成重启，PID 变为 9444）；若使用旧 `dist/main` 实例，需要先停旧进程。
- 关联文档：`docs/backend-local-dev.md` §0（一键启动）、`docs/2026-11-03-全链路Agent打通-人工走查清单.md`。