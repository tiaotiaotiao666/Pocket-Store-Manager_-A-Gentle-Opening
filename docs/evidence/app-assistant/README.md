# 全应用统一会话 Agent（`app-assistant.v1`）验收证据

> 日期：2026-11-20
> 基线：`main@d6e7a7f`（本轮未提交）
> 计划：`docs/handoff/全应用统一会话Agent-Flash实施计划.md`
> 契约：`contracts/app-assistant.v1.json` + `docs/app-assistant-contract.md`
> 结论：**自动化与静态门禁 PASS；真实模型 HTTP/直连、GUI（UIA）与微信运行时本轮 NOT_RUN / BLOCKED，不能据此宣称「全应用已验收」**。

## 1. 实际修改文件（对照 `git status`）

本轮由主 agent 与两个子 agent 共同完成，文件归属如下（`git status --short` 可复核）：

### 契约与领域（T1/T2/T3）

- `contracts/app-assistant.v1.json`（新）
- `docs/app-assistant-contract.md`（新）
- `test/fixtures/app-assistant/contract/cases.json`（新）
- `test/app-assistant-contract.test.cjs`（新）
- `src/domain/appCapabilities.mjs`（新）
- `src/domain/projectAgentContext.mjs`（新）
- `scripts/app-capabilities.cjs`（新）
- `server/src/agent/app-assistant/capabilities.snapshot.json`（生成物，digest `c6df6763`）
- `test/app-capabilities.test.cjs`、`test/app-assistant-context.test.cjs`（新）
- `src/domain/appAssistantProposal.mjs`（新）
- `src/state/sessionMachine.mjs`（改：`contentRevision`、`APP_ASSISTANT_CHANGES_APPLY`、包装层递增、agentChat 身份三元组、`lastApplied/lastPending/lastStale`、assets 进撤销快照）
- `test/app-assistant-proposal.test.cjs`、`test/app-assistant-reducer.test.cjs`（新）

### 服务端（T4，子 agent）

- `server/src/agent/app-assistant/{types,capabilities,schema,tools,prompt,service,controller}.ts`（新）
- `server/src/agent/agent.module.ts`（改：注册 controller/service）
- `server/test/app-assistant.test.ts`（新，34 例）

### 传输（T5，子 agent）

- `src/services/appAssistant/{appAssistantConfig,appAssistantError,appAssistantRequest.mjs,appAssistantPrompt.mjs,directAppAssistantTransport,httpAppAssistantTransport,mockAppAssistantTransport,appAssistantService}.js`（新）
- `test/app-assistant-service.test.cjs`、`test/app-assistant-transports.test.cjs`（新，26 例）

### 侧栏与图片、动作（T6/T7/T8）

- `src/domain/agentSidebar.mjs`（改：统一入口、`requestContextRevision` 三元组）
- `src/components/agent/AgentSidebarPanel.jsx`（改：变更卡、待确认、stale、撤销入口、空态文案）
- `src/components/agent/AppAssistantChangeCard.jsx`（新）
- `src/components/agent/AgentChatAttachments.jsx`（改：`auto`/`reference` 用途）
- `src/services/appAssistant/actionExecutor.js`（新）
- `src/App.jsx`（改：`runAppAssistantTurn`、`dispatchAgentChatTurn`、撤销本轮、动作执行接线、`allowAnyPhase`）
- `src/styles/agent-sidebar.css`（改：变更卡/待确认/stale 样式）
- `test/app-assistant-sidebar-panel.test.cjs`、`test/app-assistant-attachments.test.cjs`、`test/app-assistant-image-wiring.test.cjs`、`test/app-assistant-asset-undo.test.cjs`、`test/app-assistant-actions.test.cjs`、`test/app-assistant-action-wiring.test.cjs`（新）
- `test/agent-sidebar.test.cjs`、`test/app-agent-sidebar-wiring.test.cjs`（改：旧阶段路由断言替换为统一入口/三元组断言）

### 脚本与文档（T9）

- `scripts/app-assistant-smoke.cjs`（新）
- `package.json`（仅新增 `app:capabilities`、`app:capabilities:check`、`app:assistant:smoke`）
- 本文件与 `docs/` 相关索引更新

## 2. 命令与真实退出码

| 命令 | 结果 |
| --- | --- |
| `node --test test/app-assistant-contract.test.cjs` | 10 pass / 0 fail，exit 0 |
| `node --test test/app-capabilities.test.cjs test/app-assistant-context.test.cjs` | 12 pass / 0 fail，exit 0 |
| `node --test test/app-assistant-proposal.test.cjs test/app-assistant-reducer.test.cjs` | 19 pass / 0 fail，exit 0 |
| `node --test test/app-assistant-service.test.cjs test/app-assistant-transports.test.cjs` | 26 pass / 0 fail，exit 0（T5 子 agent 自跑，主 agent 复核） |
| `node --test test/agent-sidebar.test.cjs` | 19 pass / 0 fail，exit 0 |
| `node --test test/agent-sidebar-panel.test.cjs test/app-agent-sidebar-wiring.test.cjs` | 23 pass / 0 fail，exit 0 |
| `node --test test/app-assistant-sidebar-panel.test.cjs` | 7 pass / 0 fail，exit 0 |
| `node --test test/app-assistant-attachments.test.cjs test/app-assistant-image-wiring.test.cjs test/app-assistant-asset-undo.test.cjs` | 14 pass / 0 fail，exit 0 |
| `node --test test/app-assistant-actions.test.cjs test/app-assistant-action-wiring.test.cjs` | 8 pass / 0 fail，exit 0 |
| `npm test` | **1229 tests / 1227 pass / 0 fail / 0 todo**，exit 0 |
| `npm run build` | exit 0（`dist/assets/index-*.js` 约 857 kB，仅 vite 既有 chunk 体积告警） |
| `npm run test:desktop` | 23 pass / 0 fail，exit 0 |
| `npm run app:capabilities:check` | 快照一致（digest `c6df6763`），exit 0 |
| `npm run frontend:capabilities:check` | exit 0 |
| `node scripts/check-packaging.cjs` | 372 个必需文件，exit 0 |
| `server`: `npx vitest run test/app-assistant.test.ts` | 34 pass / 0 fail，exit 0 |
| `server`: `npx tsc -p tsconfig.json --noEmit --incremental false` | exit 0 |
| `node scripts/app-assistant-smoke.cjs` | **exit 2（环境 BLOCKED）**：agent-desktop `status` 报 `PERM_DENIED IO error: private file DACL grants an untrusted principal` |

未运行项：

- HTTP 真实模型请求：**NOT_RUN**（未启动本机服务；本轮只跑 stub/direct 注入测试）。
- DeepSeek 直连真实请求：**NOT_RUN**（需要在桌面应用内运行，GUI 不可用）。
- 真实菜单/氛围图片识别：**NOT_RUN**（同上）。
- UIA 走查与撤销/重开的人工闭环：**BLOCKED**（agent-desktop 权限被本机 DACL 拦住）。
- 微信运行时：**NOT_RUN**（本轮未改动导出工程与模板资产）。

## 3. 契约偏差与实现决策（逐条）

1. **清空店名/品类**：服务端最初按快照 `minChars=1` 拒绝空串，与桌面「清空需确认」不一致。已把 `store.name` / `store.category` 的 `limits.minChars` 改为 `0` 并重生成快照（digest `c6df6763`）；服务端因此接受空串提案，桌面 `buildProposalApplyPlan` 依 `confirmWhenEmpty` 要求确认，`validateAgentDraft` 只在缺项里提示，不硬拒绝。
2. **`action.request` 位置**：契约允许放在 `changes` 或顶层 `actionRequests`。桌面校验器两者都接受并共用 `opId` 去重；服务端只产出 `changes`。两条链最终形状一致。
3. **direct 带图（2026-11-20 更新）**：早期 direct 通道没有图片片段，带图直接返回 `AGENT_REQUEST_INVALID` + `details.reason = 'DIRECT_ATTACHMENTS_UNSUPPORTED'`。现已在主进程 `modelChat` 放开 OpenAI 多模态 `content` 块：默认模型 `deepseek-flash`（DeepSeek-V4.1-Flash-1017，官方支持图像理解），图片只接受 JPEG/PNG/WebP 内联 data URL，单张 ≤400 KiB、合计 ≤1 MiB、最多 3 张；direct 把附件放进最后一条 user 消息。非法图片、超过上限、以及 `deepseek-v4-pro` 带图仍返回 `AGENT_REQUEST_INVALID`（`details.reason` 为 `DIRECT_ATTACHMENT_*` / `DIRECT_MODEL_NO_VISION`），仍不静默丢图。真实上游带图调用本轮 **NOT_RUN**（未提供 Key，本机代理未启动）。
4. **trace 形状**：服务端严格只输出 `name/ok/latencyMs`；direct 额外带 `errorCode`。桌面校验器只取 `toolCalls.length`，不影响验收；若要完全一致需在 direct 侧删字段。
5. **参考图（`reference`）**：本轮侧栏只做「用途识别 + 定位既有候选面板」，未自动发起 `frontend-reconstruct.v1`。原因：候选生成需要 runId/目标页/私有 workspace 等受控参数，自动发起会重复实现专用链。与计划 §5.2「侧栏可发起」存在差距，已登记为遗留项。
6. **菜单图（`menu`）**：仍走 `agent-turn.v2`（`requireVision` + `analyzed=true` 硬校验），回写由既有 `AGENT_TURN_SUCCESS` 完成，**没有**转换成标准 `field.set/dish.upsert` 批次再进统一 reducer。因此「菜单识别」这一轮不产生 `lastApplied` 变更卡；变更卡只覆盖 `app-assistant.v1` 字段批次。
7. **`export.preflight`**：计划把「导出前体检」列为可自动，本轮保守地标为「需确认」，避免在统一会话里触发导出相关状态机；用户仍在既有部署面板执行。
8. **素材撤销**：`assets` 已进 `undoSnapshot` 与 `UNDO_APPLY/REDO_APPLY` 恢复，`ADD_PROJECT_IMAGES` / `REMOVE_PROJECT_IMAGE` 已进 `UNDOABLE_ACTIONS`。物理内容寻址文件保留用于 redo，状态中不会出现幽灵素材。
9. **丢失的 `lastApplied`**：`agentChat.lastApplied/lastPending/lastStale` 只存在内存，`pickAgentChat` 只落 `messages`；重开项目业务字段恢复、运行态不恢复（与计划 §6.7 一致）。
10. **`phase` 语义**：请求/消息里保留 `phase` 作为上下文，但 `isChatResponseAcceptable` 不再用它拒收；迟到判定用 `projectId + requestId + contextRevision`。
11. **package.json 事故**：本轮中途发现 `package.json` 被外部进程/会话覆盖（丢失 `agent:*`、`frontend:*`、`mirror:*` 脚本与 `agent-desktop`、`miniprogram-automator` 依赖，description/productName 被改）。已按 `git show HEAD:package.json` 恢复，仅追加本轮三条脚本；`npm test` 与各门禁复跑通过。若用户确实需要英文 description / 改 productName，属于另一项独立决策，本轮未擅自保留。

## 4. 能力边界（现在能做什么 / 不能做什么）

能（自动化层面已验证）：

- 任意项目阶段在右侧栏输入文字，进入同一 `app-assistant.v1` 请求；`projectId + requestId + contextRevision` 冻结与 stale 拒收。
- 服务端/direct 返回 proposal 后，桌面按能力目录拆成「可自动」与「需确认」，字段批次原子写入、店名/品类双写、营业时间跨天、菜品 upsert/remove、一批一撤销、重开恢复。
- 变更卡展示桌面真实 before/after，并提供「撤销本轮」（仅当版本未变）。
- 图片按用途分流：`menu` → v2（analyzed 硬校验）、`reference` → 既有候选面板、`auto/store` → 统一视觉请求。
- 动作只走显式映射；只有 `navigate.phase` 自动执行，其余动作一律待确认。

不能（本轮未验证或未实现）：

- 真实模型/真实图片识别未跑；UIA 与人工撤销/重开闭环 BLOCKED。
- 菜单识别结果没有统一的变更卡与「撤销本轮」。
- 参考图不能由侧栏直接发起候选生成。
- HTTP 直连与 direct 的取消能力不同：direct 只能在调用边界检查取消。

## 5. 复验步骤

```powershell
npm run app:capabilities:check
node --test test/app-assistant-*.test.cjs test/app-capabilities.test.cjs
npm test
npm run build
npm run test:desktop
node scripts/check-packaging.cjs

Set-Location server
npx vitest run test/app-assistant.test.ts
npx tsc -p tsconfig.json --noEmit --incremental false
```

GUI（需用户操作，环境解封后）：

```powershell
npm run agent:app
node scripts/app-assistant-smoke.cjs
```

冒烟脚本会打开工作台中第一个项目，在「说明这一轮要改什么…」输入 `店名改为松月食堂` 并发送，按结果区真实文本给出 PASS/FAIL；不会伪造模型结果。