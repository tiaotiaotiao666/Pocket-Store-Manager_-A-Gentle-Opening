# D1 独立复核（t31）— workspace-agent.v1 契约 / HTTP 边界 / runtime 复用 / RPC 代理 / mock 与脱敏

- 复核对象：D1（t29）`contracts/workspace-agent.v1.json`、`server/src/agent/workspace/**`（9 文件）、
  `server/src/agent/agent.module.ts`（+2 行）、`server/test/workspace-agent.test.ts`
- 复核者：verifier（只读；除本文件外未写仓库文件；攻击套件 `server/.tmp/a31/d1-attack.test.ts`（临时 scratch，
  未改 test/src）；未做 git 写操作；未发起真实 DeepSeek 请求、未访问网络/本机磁盘）
- 时间：2026-11-24 21:26–21:40（+08:00）；Node v24.14.0；DSH 沙箱 `workspace-write`
- **Verdict：`pass`（0 findings）**；真实 DeepSeek/微信/DB 运行时保持 **NOT_RUN / BLOCKED**，未伪造。

## 1. 门禁（真实退出码）

| # | 命令 | 退出码 | 结果 |
| ---: | --- | ---: | --- |
| 1 | `cd server; npx vitest run --configLoader native --pool=threads test/workspace-agent.test.ts` | **0** | `Test Files 1 passed`，**16/16** |
| 2 | `cd server; npx tsc -p tsconfig.json --noEmit --incremental false` | **0** | 无输出（0 errors） |
| 3 | `node -e JSON.parse(contracts/workspace-agent.v1.json)` | **0** | `contract ok` |
| 4 | 自写攻击套件 `npx vitest run --config .tmp/a31/vitest.config.mts --configLoader native --pool=threads` | **0** | **15/15 PASS**（见 §2） |
| 5 | server 非 DB 回归（37 个 test 文件中排除名称含 db/prisma/database/redis/seed） | **1** | **31 文件 / 562 tests passed**；6 个文件在 `prepareDatabase → execSync('npx prisma migrate deploy')` 处 **spawnSync cmd.exe EPERM**（86 skipped）→ **环境 BLOCKED、非 D1**；Captain full-access 528/528 作外部证据 |
| 6 | 官方 `npm test` / server DB 测试 | — | **BLOCKED**（沙箱 spawn EPERM；未执行用例） |

## 2. 自写攻击结论（`server/.tmp/a31/d1-attack.test.ts`，15/15）

### 2.1 契约单一事实源

- `loadWorkspaceAgentContract()` 返回与 `contracts/workspace-agent.v1.json` 一致：contractVersion `workspace-agent.v1`、
  endpoint `POST /api/v1/agent/workspace`、operations `plan|edit|repair|explain`；
  **tools 恰 11 个**（get_context/list_files/read_file/search_files/get_diff/write_files/delete_files/run_check/
  read_verification/verify_wechat/submit_candidate，11 个 rpc 唯一）；operationTools 白名单 4 组（plan/edit/repair/explain）；
  **limits 17 项**（maxRequestBytes 262144、maxImages 3、maxToolResultBytes 16384 等）；
  **errorCodes 18 个**；response.allowedKeys **8 个**；forbiddenKeys 恰 `applied/adopted/exported/verified`。
- 静态单源检查（排除 contract 加载器本身）：workspace-agent.* 源码中**无** `['get_context','list_files'…]` 工具数组副本、
  无 `maxImages: 3` / `maxModelCalls: 8` / `262144` 等常量副本、无错误码数组副本；服务从 `this.contract.limits.*` /
  `this.contract.operationTools` / `loadWorkspaceAgentContract()` 取值；响应对象的键集合在运行时与 allowedKeys 完全一致。
- 复用 runtime：service 从 `../runtime` 导入并只调用一次 `runAgent({...})`；源码无 `while (` / 自建 complete 循环；
  service/tools/mock/rpc/controller 无 `node:fs` / readFileSync / writeFileSync（只有 contract 加载器读契约文件）。
  → **无第二套 loop、无本机磁盘访问**。

### 2.2 HTTP 边界（Nest + supertest，真实模块）

- mock:true → **200**、`X-Request-Id` 存在、body 键集合 = 8 allowedKeys、`meta.mock=true`、trace 工具链非空、
  序列化后无 `"applied|adopted|exported|verified"`。
- 未知键 → **400** `WORKSPACE_REQUEST_INVALID` + `requestId`；版本不符 → **400** `WORKSPACE_CONTRACT_MISMATCH`；
  images 4 个 → **400** `WORKSPACE_IMAGE_LIMIT`；超大 body → **413**。
  （说明：本攻击 app 未挂 main.ts 的 body parser，413 来自 Express 默认 100KB；生产 `configureBodyParsers` 对
  `/api/v1/agent` 使用 `AGENT_MAX_BODY_BYTES` 默认 **2 MiB**（最小 256KiB），≥ 契约 256KiB；service 层另有 262144 校验，
  攻击套件对 service.run 直接验证 413 `WORKSPACE_BODY_TOO_LARGE`。）
- 控制器 abort：`response.once('close')` 在未结束时 `abort.abort()`；独立用 fake response 触发 close → run 以
  **408 `AGENT_ABORTED`** 拒绝，且 `X-Request-Id` 已回写；路由元数据 `path=workspace`、`method=POST`，全局前缀由 main.ts
  `api/v1` 提供（静态核对 `AGENT_ROUTE_PREFIX='/api/v1/agent'`）。
- `AgentModule` 的 `imports` 元数据包含 `WorkspaceAgentModule`（非测试内手搭 controller）；agent.module.ts diff 恰 **+2 行**
  （import + imports 数组）。

### 2.3 工具循环 / RPC 代理（fake model + fake proxy，无网络/磁盘）

- plan：fake model 发起 `get_context` → 仅代理收到 `agent:get-context`，context `{projectId, runId, operation:'plan'}`；
  trace 仅 `{name,ok,latencyMs,attempts,bytes,truncated}` 元数据。
- edit：`write_files` → `agent:write-files`、`submit_candidate` → `agent:submit-candidate`，两者 ok、degraded=false。
- 未注入代理：工具 ok=false、`trace.degraded=true`（确定性失败，不伪造读盘）。
- 结果 >16KiB：`trace.truncated=true`；重复调用同一工具：`stopReason=loop_detected` + degraded；
  预取消 signal：**408 `AGENT_ABORTED`**；`mock:false` 无模型：**503 `DEEPSEEK_NOT_CONFIGURED`**。
- mock:true：plan/edit 工具链严格等于契约 operationTools，`meta.mock=true`，trace 只元数据；mock 模型/代理为内存实现，
  不 spawn、不读盘。

### 2.4 脱敏 / trace / 错误映射

- 模型输出“已采用并导出到 `E:\tmp\secret\...`，已验证通过” → reply 中四类 claim 替换为“待本地确认”、绝对路径替换为
  `[path]`；响应无 `C:\` 绝对路径；trace 只 6 个元数据字段；日志仅 requestId/runId/operation/mock/stopReason/
  modelCalls/toolCalls/failedTools/latencyMs（**无 reply/prompt/utterance/密钥**）。
- 错误映射：模型错误码 → 503/504/502（`DEEPSEEK_NOT_CONFIGURED`/`TIMEOUT`/其余 upstream）、取消 → 408、参数 → 400/413、
  内部 → 500；未暴露堆栈或模型原文。
- 观察（非 finding）：回复脱敏范围按冻结要求为“claims + 绝对路径”，若模型回显 `sk-…` 样式字符串不会被额外清洗；
  服务端从未把 `DEEPSEEK_*` 密钥写入 prompt/日志/响应，故不构成密钥泄露；建议后续 rev 增加通用密钥 scrub。

## 3. 测试与边界

- `server/test/workspace-agent.test.ts` **16 例**（Nest+supertest 200/400、模块元数据、工具循环、mock、错误码、
  AgentModule imports、controller 自动构造），无 `.skip/.only/.todo`；既有 server 测试文件未改。
- 边界 = **12 路径**：`contracts/workspace-agent.v1.json`；`server/src/agent/workspace/{index,workspace-agent.contract,
  controller,mock,module,rpc,service,tools,types}.ts`（9）；`agent.module.ts`（+2 行）；`server/test/workspace-agent.test.ts`。
  `git status`：上述新文件均 `??`、agent.module `M`；`source-facts.components.ts`/`source-facts.snapshot.ts` 的 `M`
  为 C1 既有改动（mtime 19:09，早于 D1 20:52），不计入 D1。未改 desktop/src/templates/miniprogram/package.json/前端重构模块；
  HEAD 仍 `437bf5f`，未 commit；verifier 未做 git 写操作。
- D1 mtimes 20:52–21:16；与 C4（20:50）之后的 D1 时间线一致。

## 4. 结论

- 契约是单一事实源（服务端无同义常量副本）；HTTP 边界 200/400/413 + requestId、响应仅 allowedKeys、无
  applied/adopted/exported/verified；复用 `runtime.runAgent` 无第二套 loop；工具全部经注入 `WorkspaceRpcProxy`、
  超时/预算/循环检测/16KiB 截断/取消（408）/未注入代理 degraded 均生效；mock 显式、真实模型缺失 503、真实 DeepSeek
  **NOT_RUN**；脱敏与 trace 元数据符合要求；测试 16/16、tsc 0、契约可解析；边界恰 12 路径。
- **verdict=pass（0 findings）**。残余环境项：server DB 测试 spawn EPERM → BLOCKED（非 D1）；真实 DeepSeek 调用
  NOT_RUN，需在有模型配置/可 spawn 环境终验；D2–D4 本轮未启动。
- 证据：本文件；攻击套件 `server/.tmp/a31/d1-attack.test.ts` + `.tmp/a31/vitest.config.mts`（scratch，不写正式 test/src）。
