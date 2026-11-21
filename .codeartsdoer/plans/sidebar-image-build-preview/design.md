# 侧栏单图构建与微信预览

依据：`docs/2026-11-20-侧栏单图生成与微信预览实施计划.md`。本轮实现里程碑二至五的产品链路；里程碑一/六所要求的真实双样例、Electron 与微信运行时证据必须单独实测，不能由代码或构建结果代替。

# 1. Requirements

## 1.1 Requirement Areas

### R1: 侧栏一次发送同时填资料并启动候选
店主在已打开项目的任意阶段选择一张「参考界面」图片并发送明确生成要求后，系统先按 `app-assistant.v1` 写回低风险资料，再从写回后的状态启动候选任务。
- When 用户发送一张参考图和明确文字，The system shall 显示资料变更结果与同一轮候选进度，并自动进入候选面板所在阶段。
- When 图片用途或生成意图不明确，The system shall 保留本轮附件并追问，不得自动启动候选。
- If 项目切换、输入变化、取消或请求身份过期，The system shall 丢弃旧响应且不得改写当前项目。

### R2: 候选使用本次项目 Plan 与数据版本
候选 dry-run、微信验证与后续预览必须读取本轮项目 Plan，而非固定 `order-warm-home` 示例。
- When 候选开始构建，The system shall 将本轮 `CompositionPlan`、预览 `storeId` 和后端版本传给同一 attempt。
- The system shall 在 dry-run 证据中保留 Plan 来源与摘要，并仅在该 attempt 私有目录生成工程。
- If Plan 或预览绑定不合法，The system shall 拒绝构建且不得回退到示例 Plan 或演示门店冒充成功。

### R3: 每个预览绑定拥有独立门店数据
开发预览按「用户 + 项目/运行绑定键」分配独立门店，使用既有权限导入与幂等能力写入本轮店铺资料。
- When 同一绑定键重复准备相同资料，The system shall 复用门店和导入结果且不重复增加数据版本。
- When 两个项目或两个运行绑定分别预览，The system shall 写入各自 `storeId`，使菜单、价格和门店资料互不覆盖。
- When 同一预览绑定收到新资料，The system shall 只覆盖该预览门店并返回新的 `storeConfigVersion/catalogVersion`。

### R4: 自动分析、构建与微信验证
手动面板和侧栏共用候选服务及状态机；明确的一次发送在分析为 `planned` 后不再要求逐步点击。
- When 分析返回 `planned`，The system shall 自动构建并执行静态门禁，随后对同一 attempt 执行微信验证。
- If 分析为 `needs-input` 或 `rejected`，The system shall 在侧栏显示问题或能力缺口并结束本轮。
- If 微信工具不可用或验证未通过，The system shall 显示真实 `BLOCKED/NOT_RUN/FAIL`，不得自动采用或宣称预览通过。

### R5: 按候选骨架继续制作或修改重生成
候选结果卡提供明确的继续与重生成入口，采用始终绑定当前候选身份。
- When 用户点击「按这个骨架继续制作」，The system shall 采用结果卡所示 candidate/run/attempt/digest，保存同一 overlay 并进入 `prompt-studio`，不得自动打开微信预览。
- When 用户点击「修改要求并重新生成」，The system shall 保留图片和文字、清除未采用候选视图并允许创建新 attempt，且不得覆盖已采用版本。
- If 运行时为 `FAIL` 或静态门禁未通过，The system shall 阻止继续；若为 `BLOCKED/NOT_RUN`，The system shall 保留单独 partial 确认。

### R6: 最终微信预览与已采用版本同源
底部现有微信预览入口继续使用当前项目 Plan 与已采用 overlay，并写入对应预览门店和数据版本。
- When 用户最终点击微信预览，The system shall 先准备当前版本的预览数据，再导出工程、写入 AppID 并调起开发者工具。
- The system shall 将「已请求打开工具」与「微信运行时 PASS」分开呈现。
- If 数据准备、overlay、AppID 或工具调起失败，The system shall 显示具体失败步骤，不得回退到 `store-demo-001` 或旧候选。

# 2. Technical Design

## 2.1 Architecture and Implementation Boundaries

保持 React + Electron + NestJS + Composer 现有架构，不新增第二套前端生成器。服务端只增加开发预览门店分配；资料写入复用 `ImportsService`。渲染进程在 `App.jsx` 编排统一会话、候选服务与预览准备，`frontendReconstruct.mjs` 继续负责请求身份和状态。主进程只在既有 `frontend:build-candidate` 上增加有界 Plan/门店参数，dry-run 继续复用 Composer 和私有 attempt。最终预览继续走 `runPreviewExport → exportProject → appid-postprocess → openPreviewDevtools`。

首版只支持现有 FrontendPack 能力内的 `home/menu` 新骨架组合，不开放任意源码、组件、页面或业务动作。真实双样例结构对照、真实模型、UIA 和微信截图属于运行时验收；未获得证据时标记 `NOT_RUN/BLOCKED`。

## 2.2 Interface Contracts

### C-PREVIEW-STORE@1: 开发预览门店分配与资料准备
- Provider / Consumers: `PreviewStoresController/Service`；`src/services/importService.js`、`src/App.jsx`。Requirements: R2, R3, R6
- Public surface (exact, copy-paste): `POST /api/v1/merchant/preview-stores`，`SessionAuthGuard`，请求 `{ "bindingKey": string }`；`bindingKey` 为 1–120 字符且匹配 `/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/`。成功 201 返回 `{ storeId: string, created: boolean, configVersion: number, catalogVersion: number }`。`storeId = "store-preview-" + sha256(user.id + ":" + bindingKey).slice(0, 32)`。创建时门店名为 `项目预览门店`，为当前用户建立 `Role.OWNER` membership；重复请求返回 `created:false` 且不覆盖资料/版本。若既有同 id 门店不属于当前用户 OWNER，返回 409 `PREVIEW_STORE_CONFLICT`；参数错误由全局校验返回 422。
- Ownership: Provider 写 `server/src/imports/preview-stores.{controller,service,dto}.ts` 与 `server/src/imports/imports.module.ts`；Consumer 写 `src/services/importService.js` 和 `src/App.jsx`。
- Frontend helper (exact): `prepareProjectPreview({ bindingKey, agentDraft, store })` 返回 `{ status:'ok', storeId, backendVersions:{ storeConfigVersion, catalogVersion }, importId, replay }`，失败返回 `{ status:'failed'|'auth-unavailable', code, message }`。顺序固定为 ensure store → `buildImportPayload` → `previewImport` → `applyImport`；apply 的 `confirmations` 是排序后的稳定集合：本次 preview 的 `conflicts` 并入 `profile.name/profile.category/profile.address/profile.phone/profile.businessHours` 及每个 payload 产品的 `product:<draftId>`。额外确认仅用于当前用户拥有的 `store-preview-*` 私有门店，表达将该门店完整对齐本轮 payload 的意图；集合必须覆盖本次 conflicts，且不得来自其他项目。`Idempotency-Key = "preview-" + sha256(bindingKey).slice(0,16) + "-" + payload.sourceDraftDigest`。
- Failure semantics: 任一步失败立即停止，不导出、不写其他门店；导入事务与幂等仍由既有 `ImportsService` 保证。ensure 在单个数据库事务内 check-then-write，重复/并发请求只允许一个逻辑门店与一条 OWNER membership。
- Interaction semantics / status: 新建只初始化空门店；apply 成功才采用其返回的新版本。相同 bindingKey+payload 重放不得递增版本；新 payload 仅更新该绑定门店。商品 `description` 与 `priceCents/available` 一样参与 diff：变化时动作是 `conflict`、reason 增加 `DESCRIPTION_CHANGED`、复用该产品的 confirmationKey，apply 在同一事务内写入新描述并递增版本；仅改描述也必须生效。READY

### C-CANDIDATE-PLAN@1: 本次 Plan 注入候选构建
- Provider / Consumers: `frontendReconstructService` + `frontend-reconstruct-ipc` + `dry-run`；`src/App.jsx`。Requirements: R2, R4, R6
- Public surface (exact, copy-paste): `frontendService.buildCandidate({ projectId, runId, draft, plan, storeId, backendVersions })`；preload 仍调用既有 `buildCandidate(payload)`，IPC 通道仍为 `frontend:build-candidate`。新增可选键 `plan: object`、`storeId: string`、`backendVersions: { storeConfigVersion: number|null, catalogVersion: number|null }`。`plan` 序列化不超过 256 KiB；`storeId` 匹配 `/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/`；版本只能是非负整数或 null，不允许其他键。
- Ownership: Provider 写 `src/services/frontendReconstruct/frontendReconstructService.js`、`desktop/frontend-reconstruct-ipc.cjs`、`desktop/frontend-reconstruct/dry-run.cjs`；Consumer 写 `src/App.jsx`。
- Interaction semantics: `dryRun` 将 `plan` 交给既有 `resolveCandidatePlan`，后者只把 `frontendPack` 替换成本候选；同时把 `storeId/backendVersions` 原样传给 `compose`。只有调用方完全未传 `plan` 才保留旧 `DEFAULT_PLAN_FILE` 兼容路径；显式传入非法 Plan 必须失败，禁止改读默认文件。dry-run、运行时验证和返回的 `artifacts.outputRelative` 继续指向同一 attempt。
- Failure semantics: 新参数错误返回 `{ ok:false, code:'FRONTEND_PAYLOAD_INVALID', message }`；构建失败不进入微信验证。每次构建仍创建独立 attempt；取消沿用 `FRONTEND_CANCELLED`，旧 run/revision 回包由 reducer 丢弃。
- Idempotency / boundary: 写盘只发生在应用私有 attempt；没有跨请求数据库写入，重复点击由项目单任务槽与 reducer 拒绝，重复构建不会覆盖旧 attempt。READY

### C-SIDEBAR-AUTOMATION@1: 侧栏自动编排与阶段状态
- Provider / Consumers: `src/domain/frontendReconstruct.mjs` 与 `src/App.jsx`；`AgentSidebarPanel/AgentChatAttachments`。Requirements: R1, R4
- Public surface (exact, copy-paste): `resolveFrontendGenerationIntent({ text, images }) -> 'explicit'|'implicit'|'none'`；`kind:'reference'` 的单图为 `explicit`，`kind:'auto'` 且文字同时包含页面/骨架语义与按图/重构/生成语义为 `implicit`，其余为 `none`。reducer 新动作 `{ type:'FRONTEND_AUTO_REQUEST', runId, image, utterance, targetPages, baseTemplate }` 原子地设置请求、令 `revision=current.revision+1`、进入 `analyzing` 并清空上一未采用结果。
- Ownership: Provider 写 `src/domain/frontendReconstruct.mjs`、`src/App.jsx`；Consumer 写 `src/components/agent/AgentSidebarPanel.jsx`、`src/components/agent/AgentChatAttachments.jsx`、`src/styles/agent-sidebar.css`。
- Interaction semantics: `explicit/implicit` 时文字单独走 `runAppAssistantTurn`，参考图不发给 app-assistant；该函数返回增加 `projectState`（由同一 apply action 对 frozen state 调用 reducer 得到），候选 Plan 只能由这个写回后状态构造。分析 `planned` 后调用 `prepareProjectPreview({ bindingKey: projectId + ':' + runId, ... })`，再依序 analyze → buildCandidate → verifyCandidate。`needs-input/rejected` 不构建；非 PASS 不采用。阶段先 `PHASE_GOTO store-info` 再定位 `#frontend-reconstruct-panel`。
- Failure semantics: 任何步骤失败保留图片与文字；auto 图片在 app-assistant `needs-input` 时不得清空。`FRONTEND_AUTO_REQUEST` 必须先于 `await commitScreenRefImage(image)` 派发，防止共享图片同步 effect 在两者之间多推进 revision。确认时若 pending.runId 与当前 runId 相同但 revision 不同，使用当前 runId+revision 派发 `FRONTEND_CANCELLED` 并显示失效原因；若 runId 不同则只丢弃旧确认，不得取消当前新任务。项目切换继续由 `FRONTEND_RESET` 和 run/revision 拒绝迟到结果；双击由 `agentChatBusy`、frontend busy 和 IPC 单任务槽共同拒绝。
- Idempotency / status: 同一发送只创建一个 runId；重试失败步骤创建新 run 或沿用同一 attempt 的 verify，绝不重复应用字段批次。READY

### C-CANDIDATE-APPID@1: 候选微信验证前写入项目 AppID
- Provider / Consumers: `desktop/frontend-reconstruct-ipc.cjs`、`src/services/frontendReconstruct/frontendReconstructService.js`；`src/App.jsx`。Requirements: R4, R6
- Public surface (exact, copy-paste): `frontendService.verifyCandidate({ projectId, runId, attempt, appId, timeoutMs })`；IPC `frontend:verify-candidate` 增加可选 `appId: string`，格式为 `wx` 加 16 位十六进制。未提供 `appId` 时保持旧验证入口兼容；自动链与手动微信验证必须传 `String(state.project?.appid || '').trim() || 'wx3b1c04f63cf6cfd0'`。
- Ownership: Provider 写 `desktop/frontend-reconstruct-ipc.cjs`、`src/services/frontendReconstruct/frontendReconstructService.js`；Consumer 写 `src/App.jsx`。
- Interaction semantics / status: 获得当前项目单任务槽且未取消后，在 `verifyRuntimeCandidate` 前调用既有 `desktop/appid-postprocess.cjs` 的 `applyAppid({ outputPath: projectDir, appid: appId })`，由既有事务同步 project.config、Lock、报告和侧车并自检。重复验证同一 AppID 使用其 unchanged 路径；运行时证据仍属于同一 candidate/run/attempt，且必须反映实际 AppID 身份。不得将 AppID 写入响应或日志。READY
- Failure semantics: 非法 `appId` 返回 `FRONTEND_PAYLOAD_INVALID`；已取消则不写盘；写入或自检失败返回 `FRONTEND_APPID_WRITE_FAILED` 且不调用微信验证，错误信息仅含有界错误码/摘要，不回显 AppID、密钥或本机路径。

### C-ADOPT-CONTINUE@1: 采用后继续制作
- Provider / Consumers: `FrontendCandidatePanel`；`src/App.jsx`。Requirements: R5, R6
- Public surface (exact, copy-paste): 保留 `onAdopt(partialConfirmed:boolean)` 与 `onReset()`；主按钮 id `frontend-adopt-button`、文案 `按这个骨架继续制作`，重生成按钮 id `frontend-reset-button`、文案 `修改要求并重新生成`。
- Ownership: Provider 写 `src/components/screenRef/FrontendCandidatePanel.jsx`；Consumer 写 `src/App.jsx`。
- Interaction semantics: 采用成功且快照 record 为 `adopted` 后 dispatch `{ type:'PHASE_GOTO', phase:'prompt-studio' }`；不得调用 `openPreviewDevtools`。record 不完整、静态失败或 runtime `FAIL` 不跳转。`BLOCKED/NOT_RUN` 仍要求既有 partial checkbox；重复点击由 `pendingOp='adopt'` 与主进程 adopted.json 原子写保证只形成当前一份有效采用记录。
- Interaction semantics / status: `onReset` 保留 request.image/utterance，清除未采用 candidate 并回到 idle；既有项目快照中的已采用 record 不被该动作覆盖。最终微信预览由用户另行点击，使用 adopted record 的 `projectId:runId` 作为预览 bindingKey。READY

## 2.3 Service Interaction Matrix & Open Decisions

| Caller | Callee | Method | Transaction boundary | Lock order | Idempotency |
| ------ | ------ | ------ | -------------------- | ---------- | ----------- |
| T3 `importService` | T1 `PreviewStoresController` | `POST /merchant/preview-stores` | 单事务创建 store + OWNER membership；失败整体回滚 | store → storeMember | 用户+bindingKey 确定性 id；重复读现值，不覆盖资料 |
| T3 `importService` | 既有 `ImportsController` | `preview` → `apply` | preview 无写；apply 单事务，失败整体回滚 | import 记录 → store/catalog | store+user+Idempotency-Key；同 payload 重放不增版本 |
| T3 `App` | T2 `frontend:build-candidate` | `buildCandidate(plan,storeId,backendVersions)` | 每 attempt 私有写入；失败不采用 | project slot → run slot → attempt | 项目单任务槽 + run/revision；重复点击拒绝，旧 attempt 不覆盖 |
| T3 `App` | T2 `frontend:verify-candidate` | `verifyCandidate(attempt)` | 只写该 attempt 的 runtime 证据 | project slot → run slot | run/revision/candidate/attempt 全匹配才接收 |
| T3 `App` | 既有 `preview:open-devtools` | `openPreviewDevtools(projectPath)` | 仅调起工具，无数据库事务 | 无共享锁 | 用户显式点击才调起；打开成功不等于运行时 PASS |

开放事项：两张真实样例的结构对照、真实模型输出、Electron UIA、微信编译/截图/加购仍需本轮实现后实测；若当前能力无法表达样例结构，按缺口扩展版本化能力，不放宽任意源码。`repairTransport` 本轮不伪造接通，静态失败按实际 issues 报告。