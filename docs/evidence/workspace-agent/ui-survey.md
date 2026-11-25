# Workspace-Agent · product-ui 只读调研（facade / 候选 UI / B3 对齐）

> 任务：t3（attempt 1，attempt_id `fb2fb50c-d32d-4e92-bcd7-038d72122117`），只读。
> 对齐基线：`docs/handoff/Workspace-Agent-B阶段接口冻结.md` **§3 rev1**（Captain 冻结；本文件不改它，只在 §4 提建议修改点）。
> 上游：`docs/handoff/Workspace-Agent大规模重构与遗留收尾-Flash总计划.md` §1.2/§8(E1–E3)/§10(G1–G4)/§14.5。
> 边界：本轮未改任何产品代码/测试，未启动 Electron/微信，未读 `.env`。所有“事实”均来自静态阅读，**没有运行时证据**。

状态词口径（总计划 §0.4）：`PASS / FAIL / BLOCKED / NOT_RUN`；`partial` 不等于通过。

---

## 0. 结论摘要（先给 Captain 的 6 条）

1. **现有候选链已经具备“语义化 + 有界返回 + 串行/取消/采用门禁”的成熟形状**，B3 不需要重造安全模型，但**返回体形状与冻结 §3.3 不一致**（旧 `{ok,...flat}` / `{ok,data}` 两种），UI 必须做适配层，不能指望主进程 retrofit（冻结 §3.3 末条已写明）。
2. **8 页（E1）与源码 diff（E3）在 UI 与 domain 里都不存在**：`FRONTEND_TARGET_PAGES` 只有 `home|menu`（`src/domain/frontendReconstruct.mjs:25`），组件库无源码 diff 视图（`ImportDiffCard` 是导入菜单 diff，`src/components/build/ImportDiffCard.jsx`）。
3. **“真实进度”当前会静默丢阶段**（事实级缺陷）：主进程 `materialize` 会发 `validate/render/workspace/write/commit`（`desktop/frontend-reconstruct/materialize.cjs:81,420,454,476,491,584`），渲染层只认 9 个阶段（`src/domain/frontendReconstruct.mjs:73-83`），未知阶段直接 no-op（同文件 `848-849`），进度条会停在上一阶段。
4. **微信截图在 IPC 层被丢掉**（事实级缺陷，直接影响 E3）：`verify-runtime` 产出 `{label,path,bytes}`（`desktop/frontend-reconstruct/verify-runtime.cjs:335,601`），IPC 读的是 `shot.name`（`desktop/frontend-reconstruct-ipc.cjs:1253-1259`）→ `screenshots` 恒为空数组；`pages[].screenshot` 也在 IPC 映射时被丢弃（同文件 `1269-1273`）。因此 before/after 不能靠旧链补，必须在 B3/B4 新命令里给相对引用 + 受控字节读取。
5. **统一会话已经是“单入口 + 变更卡 + 撤销”的骨架**（`AgentSidebarPanel` / `AppAssistantChangeCard` / `sessionMachine` 撤销栈），G1/G3 主要是“接新 facade + 加版本卡/取消/进度”，不是重写；但 `AGENT_TURN_SUCCESS`（`src/state/sessionMachine.mjs:1765`）仍是绕过变更卡直接写草稿的旧路径，是 G4 明确退出点。
6. **建议冻结修改 9 项**（§4，全部是“补字段/补枚举/补命名”，不新增大命令面）：截图相对引用与受控读取、before 基线来源、targetPage 单页枚举、取消状态机、progress 终态与阶段枚举、`versions` 最小字段、`get-diff` 比较基准、`run-check` 参数白名单、`window.smartStore` 只允许出现在 `src/services/**`。

---

## 1. 现有 facade / IPC 面（事实）

### 1.1 preload 暴露面

`desktop/preload.cjs:37-113` 只暴露 `window.smartStore` 一个全局（`Object.freeze`），分 7 组：

| 组 | 代表 API | 行 | 备注 |
|---|---|---|---|
| 导出/Composer | `chooseExportDirectory` `composerValidate` `composerPreflightTarget` `composerExport` `composerCancel` `composerReadReport` | 39-45 | 另有 `onComposerProgress`（46-50）与废弃别名 `exportProject`（51-52） |
| 素材/文件 | `pickMaterials` `openPath` `saveImage` | 53-57 | `openPath` 仍是通用路径打开入口，只被 `exportService` 使用 |
| 外链 | `openExternalLink` | 56 | 仅 http/https，主进程再校验 |
| 项目/设置/模型 | `project*` `pickImages` `attachImages` `attachImageData` `saveGeneratedImage` `readAsset` `removeAsset` `settings*` `modelKey*` `modelTest` `modelChat` `diagnostics*` `applyAppid` `probeDevtools` | 59-84 | `modelChat` 支持 `tools` 透传（`desktop/model-ipc.cjs:92-110`） |
| 真实预览 | `openPreviewProject` `pickPreviewScreenshot` `openPreviewDevtools` `onProjectFlushRequest` `reportFlushDone` | 86-96 | 人工对照链路 |
| 候选前端（旧链） | `analyzeFrontend` `buildCandidate` `validateCandidate` `verifyCandidate` `adoptCandidate` `discardCandidate` `cancelFrontendRun` `onFrontendProgress` | 98-112 | 8 个语义 API，“不提供任何通用 read/write/exec/spawn 通道”（注释 99-100） |

**事实**：preload 里没有任何 workspace/版本/源码读写的命名空间；`window.smartStore.workspaceAgent` 尚不存在（冻结 §3.1 待建）。

### 1.2 `frontend:*` 7 命令 + 进度

`desktop/frontend-reconstruct-ipc.cjs`（1472 行）：

- 通道注册：`handlers` 7 条（`1423-1431`），统一在 `registerFrontendReconstructIpc` 里过 `isTrustedSender` + 1 MB payload 上限（`1437-1451`）。
- payload 白名单 `ALLOWED_KEYS`（`161-172`）：未知键直接拒绝（`checkUnknownKeys`，`223-227`）。
- 返回体：`ok(extra)` = `{ok:true, ...extra}`（`174-176`）；`fail(code,message,details)` = `{ok:false,code,message,details}`（`178-180`）。**与 `project:*` 的 `{ok,data}` 不同**（`desktop/project-ipc.cjs:32-34`），与冻结 §3.3 的 `{ok,data,issues,meta}` 也不同。
- 进度：`frontend:progress`，payload `{runId,projectId,stage,label,attempt,at}`，250ms 节流（`266-288`）。
- 串行/上限：每项目单任务 + 全局最多 2 个（`12-14`、`229-258`、`MAX_ACTIVE_RUNS=2` at `61`）。
- 取消：只置 `session.signal`，按 runId 生效（`290-299`、`1410-1421`）；无在途任务返回 `FRONTEND_NO_ACTIVE_RUN`。
- 写路径鉴权：`resolveAttempt` 推导 attempt 目录 + canonical/audit + `attempt.json` 身份 + 本会话创建或 `run.json` 登记（`305-359`）；渲染进程给不了目录。
- 采用门禁（B1 语义已在旧链）：静态门禁必须 ok（`1294-1299`）、运行时证据必须属于当前候选（`1306-1319`，否则 `FRONTEND_RUNTIME_EVIDENCE_STALE`）、`FAIL` 一律拒绝且 partial 确认不能覆盖（`1322-1328`）、非 PASS 需 `partialConfirmed`（`1329-1335`）、记录里 `partialConfirmed` 显式留痕（`1346-1348`）。
- 截图外发确认（B5）：`consent` 必须存在且在 15 分钟内、图摘要与 host 都匹配（`579-605`），先记 `consent.json` 再联网（`608-623`、`809-845`）。

错误码命名空间：`CODES`（`98-140`）约 40 个 `FRONTEND_*`；另有 `UNTRUSTED_SENDER`、`PAYLOAD_TOO_LARGE`。

### 1.3 `project:*` / `composer:*` / `preview:*` / 模型

- `desktop/project-ipc.cjs`：`{ok,data}` envelope（`32-34`）；`project:load` 会做候选 overlay 摘要校验并把 `frontendCandidate.status` 降级为 `unavailable` + `candidateCheck`（`95-139`）；`project:save` 用 `adoption.pickAdoption` 白名单落盘（`141-156`）。**无版本/undo/redo/versions 通道。**
- `desktop/composer-ipc.cjs`：8 通道（`609-616`）+ `composer:progress`（`407`）；`isTrustedSender` 白名单为 `file://` 与 `http://127.0.0.1:5173/`（`129`、`146-150`）；`FORBIDDEN_MEDIA_KEYS` 禁渲染进程传媒体本体/路径（`135-144`）。
- `desktop/preview-channel.cjs`：`preview:open-project` / `preview:pick-screenshot` / `preview:open-devtools`（`27-29`）；`pick-screenshot` 返回 `{path,name,bytes,mime,dataUrl}`（`277-285`，≤8 MiB，PNG/JPEG 内容嗅探）；`open-project` 明确“只表示目录已打开，不代表渲染完成”（`292-293`、`345-349`）。
- `desktop/model-ipc.cjs`：`settings:model:chat` 透传 `messages/tools/maxTokens/temperature/thinking`（`92-110`）——这是 D 阶段“直连 + 工具调用”的既有出口。

### 1.4 `src/services/**` 调用面与错误/取消语义

| 服务 | 出口 | 事实 |
|---|---|---|
| `src/services/frontendReconstruct/frontendReconstructService.js` | 8 个语义 API 的唯一封装（`129-358`） | `fromIpc` 把旧 `{ok,code,message,details}` 归一成 `{ok,status:'ok'|'failed',code,message}`（`115-127`）；`onProgress` 返回退订函数（`333-345`）；浏览器模式返回 `DESKTOP_REQUIRED`（`135-142`） |
| `src/services/projectService.js` | `{ok,data}` 处理（`148,254-410`） | 项目/资产/缩略图唯一入口（`projectThumbnailLoader.js:9` 明确注入 `readAsset`） |
| `src/services/exportService.js` | Composer 导出 + 进度订阅（`141`）、取消（`369-377`） | 超时用 `withTimeout` 包住 |
| `src/services/appAssistant/*` | app-assistant 统一会话（`appAssistantService.js:56`、`directAppAssistantTransport.js:509-675`） | **直连模式在渲染进程跑工具循环**（`tools: APP_ASSISTANT_TOOLS`，`543`；`toolCalls` 汇总 `596-675`）——D 阶段要判断这条循环是否搬到主进程/服务端 |
| `src/services/agentTurn/screenReferenceService.js` | 旧 `screen-reference.v1`（`31`） | 直接 `fetch('/api/v1/agent/turn')`（`95-100`），可选 `getAuthorization`；`App.jsx:3000` 调用时**没有传** `getAuthorization` → 与 B2“桌面会话凭证由主进程持有”不一致 |
| `src/services/frontendReconstruct/adoptionBridge.js` | 采用记录 ↔ 快照 | `deriveAttemptPaths` 用正则从 `recordRelative` 截出 attempt/overlay 相对路径（`19-28`）；采用/撤销语义在 domain，不在组件 |

---

## 2. 现有候选/会话 UI（事实）

### 2.1 状态机 `src/domain/frontendReconstruct.mjs`

- 13 个状态 `idle/analyzing/planning/generating/validating/verifying/ready/partial/needs_input/rejected/failed/cancelled/adopted`（`49-63`）；忙碌 4 态（`66-71`）。
- 25 个 action（`case 'FRONTEND_*'`，`669-1160`）：输入/自动编排/分析/构建/进度/复核/微信验证/采用/放弃/取消/重试/重置。
- 迟到响应防护：`runMatches` + `revision` + `pendingOp`（`640-643`），输入变更直接 `revision++` 作废在途（`705`）。
- 视图模型 `buildFrontendReconstructView`（`1339-1409`）：把 `canAnalyze/canBuild/canVerify/canAdopt/canDiscard/canCancel/canRetry` 与 `adoptBlockedReason/partialNote` 一起算好——**组件不重复判断业务规则**（组件注释 `FrontendCandidatePanel.jsx:5-13` 也这么写）。
- 已覆盖可见状态：失败（`error` + `issues`）、取消（`cancelled` tone idle）、`partial`（`requiresPartialConfirmation`，`1335`、`1405-1407`）、`NOT_RUN/BLOCKED`（`FRONTEND_RUNTIME_LABELS`，`125-130`）。

### 2.2 组件 props/events 与可见状态

| 组件 | 行 | props（关键） | 现状要点 |
|---|---|---|---|
| `src/components/screenRef/FrontendCandidatePanel.jsx` | 436 行 | `view,imageReady,localError,notice,consentNotice,desktopMode,uploadSlot,onUtteranceChange,onTargetPagesChange,onAnalyze,onBuild,onVerify,onValidate,onAdopt,onDiscard,onCancel,onRetry,onReset`（`48-69`） | 纯展示；`partialConfirmed` 本地态按 `candidateKey` 重置（`83-86`）；进度条 `role=progressbar`（`257-273`）；能力覆盖/候选摘要/验证报告三块 `role=group`（`275-426`） |
| `src/components/agent/AgentSidebarPanel.jsx` | 415 行 | `projectId,projectName,phase,phaseLabel,chat,process,candidate,sendBlockedReason,images,imageKinds,imageError,imageBusy,onAddImages,onRemoveImage,onImageBusyChange,onDraftChange,onSubmit,onRetry,onOpenCandidates,onUndoApplied,onConfirmPending`（`103-128`） | 时间线 = 消息 + 每轮结果卡（`192-200`）；过程卡复用 `ProcessSummary`；变更卡 `AppAssistantChangeCard`（`293-307`）；参考图重构摘要块（`308-342`）；**没有取消入口**（只有 `busy` 提示，`349-358`） |
| `src/components/layout/RightPanel.jsx` | 170 行 | `meta,cards,agentChat,initialView`（`93`） | 双 tab（`项目信息`/`Agent 对话`，`34-37`），roving tabIndex + 方向键（`98-119`）；同一时刻只渲染一个视图（`149-167`），避免重名 |
| `src/components/chat/ChatStream.jsx` | 90 行 | `messages,revealKey,flushKey,revealAll,process,children`（`61-68`） | `ProcessSummary`（`21-57`）只吃安全视图：无 `title` 不渲染，无 trace 不产步骤 |
| `src/domain/agentRunProcess.mjs` | 556 行 | — | 工具标签（`19-35`）、前端阶段标签（`45-55`）、`buildFrontendProcessView`（`474-523`，含 `meta{runId,attempt,status,durationMs}` 与 `metaLines`）；`processHistory` 折叠 3 条（`538-556`） |

### 2.3 接线（`App.jsx`，5393 行）

- 候选面板只在 **开店资料阶段** 渲染：`referenceSection`（`4893-4912`）作为 `StoreInfoSections.reference` 传入（`4945-4950`）。→ G1“任意阶段都能发图/文”当前**不成立**。
- 进度订阅：`frontendService.onProgress` → `FRONTEND_PROGRESS`（`3622-3632`）；耗时只按真实 runId 记录（`3636-3650`）。
- 参考图与候选面板共享同一张图（`3654-3658`）。
- `App.jsx` 内 5 处直接用 `window.smartStore`：`2057`、`2183`、`2211`、`2252`、`2265`（预览/截图）。

### 2.4 版本/撤销现状

- 快照层：`frontendCandidate` 只有一个 `previous` 层（`src/domain/projectSnapshot.mjs:614-615,868-908`；`adoptionBridge.js:131-149`）；`verified` 只在重开校验后置位，撤销**不重新校验**（`adoptionBridge.js:123-149`）。
- 内存撤销栈：`sessionMachine` 的 `UNDOABLE_ACTIONS` 20 步、只回退业务切片（`src/state/sessionMachine.mjs:2631-2661,2672+`），`selectUndoState` 只给 `canUndo/canRedo/count`（`3026-3034`）。
- **没有** `versions` 列表、版本指针、redo 版本、diff 或截图索引的 UI；`Ctrl+Z` 语义目前是“字段撤销”，不是“版本指针”。

---

## 3. 缺口清单（对齐冻结 §3.2 命令面）

图例：**复用** = 现成可直接用；**新造** = 需要新面板/新状态；**移植** = 逻辑存在但形状要改。

| 冻结命令 | 现有对应 | 状态 | 缺口 |
|---|---|---|---|
| `agent:get-context` | 无（`projectAgentContext.mjs` 只有会话摘要） | 新造 | 需要“当前版本 + 可用 checkId + 验证摘要”数据源；B2 落地前 UI 无处取版本 |
| `agent:list-files` / `read-file` / `search-files` | 无 | 新造 | 无文件浏览器/源码查看器组件；需要只读、行号、`nextOffset` 续读 |
| `agent:write-files` / `delete-files` | `composer:*`（导出）+ 旧 `frontend:build-candidate`（DSL 物化） | 移植 | UI 不应直接发起写；写由 Runtime 调，UI 只展示 diff/结果 |
| `agent:add-image-asset` | `project:pick-images` → `project:attach-images`（`desktop/asset-store.cjs:174-315`） | 复用 | 形状：`attachmentRef` 未定义（token? assetId?）；当前候选链用 `screenRef.image.dataBase64`，E1 不能把 base64 塞进 RPC |
| `agent:get-diff` | 无源码 diff（`ImportDiffCard` 是菜单导入 diff） | 新造 | 需要 `status/path/additions/deletions` 列表 + 折叠正文；需要 `truncated` 提示 |
| `agent:run-check` | `npm` 脚本矩阵 + `dry-run.cjs` 的 compose/mini-check/consistency/observable（`desktop/frontend-reconstruct/dry-run.cjs:54`） | 移植 | UI 需要 checkId → 结果列表（PASS/FAIL/BLOCKED/NOT_RUN + 有界 issues），当前只有 `checks[]` 文案列表 |
| `agent:verify-wechat` | `frontend:verify-candidate`（`1187-1284`） | 移植 | 返回形状；**截图字段丢失**（见 §0.4）；`pages[].screenshot` 未透传 |
| `agent:read-verification` | 无（旧链只能 `read-report` 导出报告） | 新造 | 需要 before/after 展示所需的相对引用 + 受控字节读取 |
| `agent:submit-candidate` | `frontend:build-candidate` 的“候选已生成” | 移植 | 现链条把“生成”和“验证”混在一次调用里；新链条要分离 submit / verify / adopt |
| `agent:versions` / `adopt-version` / `undo` / `redo` / `reopen` | 无（`project:load/save` + 单层 `frontendCandidate`） | 新造 | G3 版本卡与版本历史整块缺失 |
| `agent:cancel-run` | `frontend:cancel-run`（`1410-1421`） | 移植 | 需要“请求已取消 vs 已取消 vs 取消太晚”三态 |
| `agent:progress` | `frontend:progress`（`266-288`） | 移植 | 阶段枚举不一致导致静默丢步（§0.3）；无终态事件 |

### 3.1 E1（单图单页视觉分析）

- **目标页选择**：现在是 2 个复选框、多选、可同时 home+menu（`FrontendCandidatePanel.jsx:161-176`；`FRONTEND_TARGET_PAGES` 仅 2 项）。E1 要求**单数 8 页**、一图一页。缺口：枚举、单选控件、attempt 上记录 `targetPage`。
- **图片 + 设想输入**：已有 textarea（500 字）+ 上传槽（`uploadSlot`，由 `ScreenReferencePanel` cloneElement 注入，`App.jsx:4868-4872`）+ 发图确认（`ScreenSendConsent.jsx`）。可复用，但需与 `agent:add-image-asset` 对齐（现在是 `screenRef.image.dataBase64`）。
- **真实进度**：见 §0.3；另需把阶段映射集中一处（现在是 3 份副本：IPC `STAGE_LABELS:142-156`、renderer `FRONTEND_STAGE_LABELS:85-95`、`agentRunProcess.mjs:45-55`）。
- **BLOCKED/NOT_RUN**：已有文案表（`FRONTEND_RUNTIME_LABELS:125-130`）与 tone（`RUNTIME_TONE`，`FrontendCandidatePanel.jsx:15-20`），可复用。

### 3.2 E3（真实截图与对比）

- **before/after 同 route 同尺寸**：当前只展示“截图清单（名字+体积）”（`FrontendCandidatePanel.jsx:385-394`），**没有图片本体**；IPC 甚至丢掉了引用。需要：新面板 + 受控字节通道 + 缺图状态（`NOT_RUN`/`BLOCKED`/`MISSING`）。
- **修改文件/diff**：完全缺失（见 §3 表）。
- **业务影响范围**：`analysis.coverage` 已有“近似/不支持/风险/降级”（`analysisView:1218-1273`），可作为“影响”上半部分复用；源码级影响需新字段。
- **展示约束（必须写进 UI 文案与实现）**：React 预览截图、`preview:pick-screenshot` 的 dataUrl、`RealPreviewPanel` 的双图对照**都不是**微信运行时证据；缺图时只能显示 `NOT_RUN`/`BLOCKED`/`MISSING`，不得用 CSS 截图或旧图补位。

### 3.3 G1（统一入口）

- 已有：单入口侧栏（任意阶段可用 `RightPanel` 的 Agent tab）、变更卡、撤销本轮、待确认批次、stale 提示、失败保留输入并重试（`AgentSidebarPanel.jsx:176-187,360-375`）。
- 缺口：① 候选链仍被 phase 门禁；② **无取消**入口；③ 参考图按钮只是跳旧面板（`onOpenCandidates`，`228-238`），G1 要求“直接从侧栏发起 Workspace 候选”；④ 菜单识别仍走 `AGENT_TURN_SUCCESS` 直写草稿（`sessionMachine.mjs:1765-1804`），G1 要求统一变更卡。

### 3.4 G2/G3（主流程与版本 UI）

- G2：流程里“功能勾选/模板匹配/生图/Prompt Studio”仍是主流程步骤（`App.jsx` 的 `case PHASES.PROMPT_STUDIO/IMAGE_REVIEW`，`4959-4983`），需要降级为可选工具；常驻微信预览入口已有（`DevtoolsPreviewDock`，`84,139`）。
- G3：版本卡/历史/undo-redo 全缺；`App.jsx` 5393 行 + `sessionMachine.mjs` 3334 行仍是大文件，拆分需在行为测试保护下逐职责进行。

### 3.5 事实级缺陷（与 E1/E3 直接相关，供 Captain 决定是否单开修）

1. 进度阶段静默丢失：`materialize.cjs:81` 的 6 个阶段 vs `frontendReconstruct.mjs:73-83` 的 9 个阶段，交集只有 `materialize`；`FRONTEND_PROGRESS` 对未知阶段 `return sameState`（`848-849`）。
2. 截图引用丢失：`frontend-reconstruct-ipc.cjs:1256` 读 `shot.name`，`verify-runtime.cjs:335` 给的是 `{label,path,bytes}` → `screenshots` 恒 `[]`；`pages[].screenshot` 未映射（`1269-1273`）。
3. 阶段标签三处副本（IPC / renderer domain / agentRunProcess），改一处不改另一处会造成 UI 与主进程各说各话。
4. `screenReferenceService` 在桌面模式仍由渲染进程直连后端且不带授权（`screenReferenceService.js:95-100` + `App.jsx:3000`），与 B2 凭证模型冲突。

---

## 4. 建议修改冻结的点（不自行改接口，等 Captain 出 rev2）

> 编号 F1–F9。全部是“补字段/补枚举/补命名”，不新增第二条命令面。每条给理由与最小改动。

**F1｜截图相对引用 + 受控字节读取（P0，E3 阻塞）**
冻结 §3.2 里 `agent:verify-wechat` 与 `agent:read-verification` 都只写“screenshots”，未定义字段，也没有读取字节的入口。
建议：① 明确 `screenshots: [{label, path, bytes, mime?, route?}]`（`path` 为 `verification/runtime/shots/**` 的相对路径）；② 新增 `agent:read-artifact` `{projectId, runId, attemptId, kind:"screenshot", path}` → `{mime,bytes,sha256}` + 受控字节通道（复用 `preview:pick-screenshot` 的“主进程读、渲染进程拿 dataUrl/Blob”模式，`desktop/preview-channel.cjs:277-285`，但**不接受渲染进程给路径**，只接受上面返回过的相对引用）。
理由：旧 IPC 已把引用丢掉（§3.5-2）；没有它 E3 的 before/after 无法真实展示。

**F2｜before 基线来源（P0，E3 阻塞）**
`Before` 不是本次 attempt 的产物。冻结里只有 `agent:get-diff {projectId,revision}` 与 attempt 级验证。
建议：新增只读 `agent:get-version-evidence {projectId, versionId}` → `{versionId, treeDigest, verification:{static,runtime}, screenshots:[…]}`；或给 `agent:read-verification` 加 `source:"attempt"|"version"` 与 `versionId`。
理由：E3 要求“同 route、同尺寸、同门店/身份”的对比，before 必须来自已采用版本登记的 `evidence/runtimeRelative`（B2 `version.json.evidence` 已冻结该字段，`§2.1`）。

**F3｜targetPage 单页枚举（P0，E1 阻塞）**
冻结命令面没有 `targetPage`；现有枚举只有 `home|menu`（`frontendReconstruct.mjs:25`）。
建议：`agent:get-context` 返回 `targetPages: [{id,label,enabled}]`（8 页，按 F1 开放顺序），`agent:submit-candidate` 增加 `targetPage` 并写入 `attempt.json`；`agent:progress` 的 `phase` 允许 `analyze|generate|repair`。
理由：不冻结就会出现“UI 自己写 8 页枚举 / 服务端另写一套”的双真相，且版本卡无法回答“这一版改的是哪一页”。

**F4｜取消三态（P1，G1）**
`agent:cancel-run` 目前只 `{cancelled:bool}`。
建议：`data` 增加 `state:"requested"|"cancelled"|"too-late"` 与 `stage`（无在途任务不是错误，用 `state:"too-late"` 表达；或保留 `AGENT_BUSY` 但明确 UI 文案）。
理由：旧链 `FRONTEND_NO_ACTIVE_RUN`（`frontend-reconstruct-ipc.cjs:1418`）是错误码，UI 只能显示成“失败”；G1 要求“可重试和取消”且状态真实。

**F5｜progress 的终态与阶段集合（P1，E1 真实进度）**
建议：① 冻结 `agent:progress.status ∈ running|succeeded|failed|cancelled`；② 明确“终态以命令返回为准，progress 只表示过程”；③ 允许 `stage` 为开放字符串（UI 做未知阶段折叠为“处理中”，不得静默丢弃）。
理由：见 §3.5-1；未知阶段丢步是真实缺陷，B3 再复制一次会扩大。

**F6｜`agent:versions` 最小字段（P1，G3）**
建议冻结 `data.versions[]` 至少含：`versionId, parentVersionId, createdAt, reason, isCurrent, treeDigest, verification{static,runtime}, screenshotCount, fileCount`，并返回 `redoVersionId`。
理由：版本卡要显示父版本/diff/截图/验证（G3），否则 UI 只能对每个版本再发 N 次请求，或自己从 `project.json` 猜。

**F7｜undo/redo 与既有撤销栈的边界（P1，G3 双真相风险）**
建议冻结一句：**版本 undo/redo 只由版本卡按钮触发**（`agent:undo/redo` 只动版本指针）；既有 `Ctrl+Z` 仍是业务字段撤销（`sessionMachine` 内存 20 步，`2631-2661`），不进入版本链；两者文案必须不同（“撤销这一步修改” vs “回退到上一版本”）。
理由：否则“按一次 Ctrl+Z 到底撤销了什么”无法回答，也违反 §2.2“不得造成双事实”。

**F8｜`agent:get-diff` 的比较基准（P1，E3/G3）**
建议：`data` 明确 `comparedTo:{versionId|attemptId}` + `files[].{path,status,additions,deletions,sha256}`，`diff` 正文允许缺省（有大小上限时只给统计）。同时明确 `revision` 取值域：`versionId` 或 `attemptId`，不接受自由字符串。
理由：E3“修改文件/diff”与 G3“版本 diff”是同一份数据两种视角，基准不冻结就会各算一套。

**F9｜`window.smartStore` 只允许出现在 `src/services/**`（P2，防止 facade 扩散）**
建议在 §3.1 加一句：组件/domain 不得直接读 `window.*`，只能 import `src/services/workspaceAgent/**`；`agent:*` 的适配层固定在该目录（例如 `service.js`）。
理由：现状已有 6 处越界（`MarkdownView.jsx:13`、`RealPreviewPanel.jsx:64-76`、`PreviewLaunchButton.jsx:20`、`DevtoolsPreviewDock.jsx:84,139`、`App.jsx:2057,2183,2211,2252,2265`），不冻结会继续长。

（另有 2 条不建议现在改冻结，只记录观察：`agent:run-check.params` 建议白名单化，理由同旧链 `ALLOWED_KEYS`；`agent:add-image-asset.attachmentRef` 建议明确为 `project:attach-images` 的 `assetId` 而非 token。若 Captain 愿意，可并入 F3/F6 一起出 rev2。）

---

## 5. UI 最小新增面板与状态（E1/E3/G1–G3）

> 原则：**一个面板一个职责**；状态文案集中在新 facade 适配层，组件不判断业务；所有新控件有唯一可读名称与稳定 id；不新增第二个 window 全局。

| # | 面板 | 位置 | 关键状态 | 复用 |
|---|---|---|---|---|
| 1 | `WorkspaceTargetPagePicker` | 统一会话输入区（候选面板上方） | 8 页单选、`disabled`（busy）、当前页标注 | `FrontendCandidatePanel` 的目标页 fieldset 样式 |
| 2 | `WorkspaceRunCard` | 侧栏时间线 | `running/succeeded/failed/cancelled` + 阶段 + runId/turnId/attempt + 取消/重试 | `ProcessSummary`（`ChatStream.jsx:21-57`）、`buildFrontendProcessView` 形状 |
| 3 | `SourceDiffCard` | 侧栏结果卡内 | 文件列表（added/modified/deleted）+ `+/-` 计数 + 折叠 diff + `truncated` | `AppAssistantChangeCard` 的卡片骨架 |
| 4 | `BeforeAfterShots` | 侧栏/候选面板 | `before/after` 两图 + `NOT_RUN/BLOCKED/MISSING` 占位 + 尺寸/route 标注 | `RealPreviewPanel` 的双图样式（但**不得复用其“人工对照”语义**） |
| 5 | `VersionHistoryPanel` | 右侧栏第三个 tab 或候选面板内 | 版本列表、current 标记、undo/redo、采用、漂移 `unavailable` | `projectSnapshot` 的 adoption 文案（`adoptionBridge.js:152-165`） |
| 6 | `CheckRunsList` | `SourceDiffCard` 下方 | 每 checkId 一行：PASS/FAIL/BLOCKED/NOT_RUN + issues（file:line） | `verification.static.checks` 列表（`FrontendCandidatePanel.jsx:362-370`） |

最小可行顺序（依赖冻结与 B3）：`WorkspaceRunCard` → `WorkspaceTargetPagePicker` → `CheckRunsList` → `SourceDiffCard` → `BeforeAfterShots` → `VersionHistoryPanel`。

---

## 6. 可访问性锚点清单

### 6.1 现状（已被 `agent:smoke` / `app:assistant:smoke` 断言或可作锚点）

- 候选主链：`frontend-reconstruct-panel`（`FrontendCandidatePanel.jsx:102`）、`frontend-reconstruct-utterance`（`149`）、`frontend-target-home|menu`（`166`）、`frontend-analyze-button`（`195`）、`frontend-build-button`（`205`）、`frontend-verify-button`（`217`）、`frontend-validate-button`（`226`）、`frontend-cancel-button`（`236`）、`frontend-retry-button`（`241`）、`frontend-discard-button`（`246`）、`frontend-reset-button`（`251`）、`frontend-partial-confirm`（`401`）、`frontend-adopt-button`（`414`）。
- 进度/报告：`aria-label=候选前端进度`（`259`）、`候选前端进度百分比` progressbar（`264-268`）、`能力覆盖报告`（`276`）、`验证报告`（`355`）、`静态门禁检查项`（`363`）、`微信页面验证结果`（`377`）、`微信截图清单`（`388`）。
- 发图确认：`ScreenSendConsent` 的 `role=dialog` + `aria-label=截图发送确认`（`ScreenSendConsent.jsx:13-14`）、`screen-send-confirm`/`screen-send-cancel`（`27,36`）。
- 旧参考图：`screen-ref-panel`（`ScreenReferencePanel.jsx:134`）、`screen-ref-file`（`81`）、`screen-ref-upload-button`（`91`）。
- 会话：`project-agent-sidebar`（`AgentSidebarPanel.jsx:222`）、`agent-open-frontend-candidates`（`230`）、`project-agent-messages`（`258`）、`project-agent-busy`（`350`）、`project-agent-error`（`361`）、`project-agent-composer`（`391`）。
- 双视图：`right-panel-tab-info|agent`、`right-panel-view-info|agent`（`RightPanel.jsx:35-36`）。

### 6.2 建议新增（命名不重复，避免 `AMBIGUOUS_TARGET`）

| 锚点 id | role / aria-label | 用在哪 |
|---|---|---|
| `workspace-agent-panel` | `region` / `aria-label="源码修改运行"` | 新统一运行面板容器 |
| `workspace-target-page-<id>` | `radio` / `aria-label="目标页：首页"` … | 8 页单选（`<id>` 用稳定英文 route 名） |
| `workspace-run-progress` | `status` + `aria-live=polite` / `aria-label="本轮进度"` | 真实进度文案 |
| `workspace-run-progressbar` | `progressbar` / `aria-valuenow` | 有阶段总数的进度条 |
| `workspace-run-cancel` | 按钮 `取消本轮`（唯一名，不与旧 `取消候选前端任务` 重名） | G1 取消 |
| `workspace-run-retry` | 按钮 `重试本轮` | 保留输入重试 |
| `workspace-diff-panel` | `group` / `aria-label="源码修改清单"` | E3 |
| `workspace-diff-file-<n>` | `listitem`，文本 = 相对路径 + `+a/-d` | 逐文件 |
| `workspace-checks-panel` | `group` / `aria-label="检查结果"` | B4 checkId 结果 |
| `workspace-shot-before` / `workspace-shot-after` | `img` + `alt="改前：<route>"` / `alt="改后：<route>"` | E3 对比 |
| `workspace-shot-missing` | `status` 文本 `NOT_RUN`/`BLOCKED`/`MISSING` | 缺图 |
| `workspace-version-history` | `region` / `aria-label="版本历史"` | G3 |
| `workspace-version-current` | `status` 文本 `当前版本 v2` | G3 |
| `workspace-version-adopt` / `-undo` / `-redo` | 按钮 `采用此版本` / `回退到上一版本` / `重做` | G3（与旧 `按这个骨架继续制作` 区分） |

**UIA smoke 增补建议**：`scripts/agent-smoke.cjs` 的 `FRONTEND_PANEL_TEXTS`（`30-41`）保持不动，新增 `WORKSPACE_AGENT_TEXTS`（运行卡、目标页、检查结果）；`scripts/app-assistant-smoke.cjs` 的 `RESULT_TEXTS`（`30-36`）追加版本卡与 diff 文案。新增断言必须能在“没有真实模型/微信”的情况下只断言面板存在，不把 BLOCKED 写成 PASS。

---

## 7. G4：旧 DSL / 旧入口退出点

| # | 退出对象 | 证据 | 处理建议 |
|---|---|---|---|
| 1 | `screen-reference.v1` 新入口 | `src/domain/screenReference.mjs:20`；`src/services/agentTurn/screenReferenceService.js:31,65-100`；`ScreenReferencePanel`（`src/components/screenRef/ScreenReferencePanel.jsx`）；`sessionMachine.mjs:1562` `SCREEN_REF_*` | 新入口不再提供“参考图 → 候选模板”；旧快照仍可打开（`restoreScreenRef`，`projectSnapshot.mjs:587`）；面板降级为“旧项目只读查看” |
| 2 | `frontend-pack-draft.v1` DSL 物化链 | `src/domain/frontendReconstruct.mjs:23`；`desktop/frontend-reconstruct/{materialize,render,schema}.cjs`；`frontend:build-candidate` | 新项目默认 Workspace Agent；v1 只读兼容；B2 迁移把已采用候选导入为 `v2`（冻结 §2.3），**不双写** |
| 3 | `AGENT_TURN_SUCCESS` 直写草稿 | `src/state/sessionMachine.mjs:1765-1804`（绕过变更卡） | 菜单识别结果转为统一变更卡后再写；先保留旧 action 读路径，等 grep 证明无引用再删 |
| 4 | 废弃导出别名与旧 generator 通道 | `desktop/preload.cjs:51-52`（`exportProject` 注释 `@deprecated`）；`generator:pick-materials/open-path/save-image` | grep 证明无生产引用后删；`openPath` 仅 `exportService` 用，保留 |
| 5 | 三份阶段/状态标签副本 | `frontend-reconstruct-ipc.cjs:142-156`、`frontendReconstruct.mjs:85-95`、`agentRunProcess.mjs:45-55` | 收敛成一份（新 facade 适配层或 domain 常量），旧链只保留映射 |
| 6 | `preview:pick-screenshot` 作为证据的用法 | `desktop/preview-channel.cjs:277-285`；`RealPreviewPanel` | 不删通道，但 UI 文案固定为“人工对照，不是运行时证据”；不得进入验证报告 |
| 7 | `FRONTEND_TARGET_PAGES` 两页枚举 | `frontendReconstruct.mjs:25` | 被 F3 的 8 页枚举取代；旧枚举只用于读旧 attempt |
| 8 | 文档口径 | `AGENTS.md` 仍在描述“模型只产出有界 JSON DSL” | G4 阶段由 Captain 统一更新（成员不写 `docs/handoff/**`） |

---

## 8. 展示约束（“禁止用 React 预览截图冒充微信截图”的落地写法）

1. 证据来源只有两类：`agent:verify-wechat` 返回的 `screenshots`（相对引用）与 `agent:read-verification` 的验证报告；**任何来自 `preview:*`、React 预览、CSS 截图、旧会话缓存的图片都不得进入 `BeforeAfterShots`**。
2. 无图时必须显式显示 `NOT_RUN` / `BLOCKED` / `MISSING`（复用 `FRONTEND_RUNTIME_LABELS`，`frontendReconstruct.mjs:125-130`），不得留空、不得用占位图、不得复用上一候选的图。
3. 每张图必须带 `route` + 生成时间 + 是否属于当前 `treeDigest`；不匹配时显示“证据不属于当前版本”，并阻止采用文案变成“已验证”。
4. `partial` 只出现在“静态通过 + 运行时未 PASS”，文案固定为“部分采用（不构成验收通过）”（对齐 `frontend-reconstruct-ipc.cjs:1373-1377`）。
5. 报告/过程卡不回传绝对路径、base64、完整 prompt、密钥（沿用 `cleanProcessText` 的清洗口径，`agentRunProcess.mjs:366-378`）。

---

## 9. 风险与取舍

| 风险 | 影响 | 取舍建议 |
|---|---|---|
| 旧链 `frontend:*` 与新 `agent:*` 并存期返回体不一致 | 适配层容易写歪，状态可能丢 | 适配层一个文件、一个 `normalizeResult()`，并为两种 envelope 写单元测试（不写产品代码，交给后续任务） |
| `App.jsx` 5393 行 + `sessionMachine` 3334 行 | G3 拆分与 E 接线互相踩踏 | 先加面板与 service，再改 `App.jsx` 接线（冻结 §5 已要求串行） |
| 直连模式的工具循环在渲染进程（`directAppAssistantTransport.js:509-675`） | Workspace 工具必须主进程执行，循环位置要变 | B3 前先确认 D 阶段谁跑循环；UI 只消费结果与进度，不执行工具 |
| 8 页枚举与 SourceFacts 未落地 | E1 UI 可能先于事实存在 | 目标页 UI 用 `agent:get-context` 下发的 `enabled` 驱动，不在前端硬编码 8 页 |
| 版本 undo 与字段 undo 混淆 | 用户不知道撤销了什么 | F7 冻结文案与作用域；两套按钮名称必须不同 |
| 截图读取通道被滥用 | 变成任意文件读取 | 只接受 `agent:read-verification` 返回过的相对引用；主进程复核归属与体积（复用 `preview-channel` 的校验思路） |
| UIA 断言写成“有文本 = 通过” | 把 BLOCKED 写成 PASS | 断言只覆盖“面板可见 + 状态词存在”，PASS 必须由真实验证结果决定 |

---

## 10. 可复用清单（避免重造）

- 安全路径/工作区：`desktop/frontend-reconstruct/workspace.cjs`（B1 抽共享，冻结 §0）。
- 串行/取消/信任 sender/payload 上限：`desktop/frontend-reconstruct-ipc.cjs:229-299,1437-1451`；`composer-ipc.cjs:146-150`。
- 采用门禁与证据归属：`frontend-reconstruct-ipc.cjs:1286-1377`；`adoptionBridge.js`；`projectSnapshot.mjs:868-908`。
- 发图确认与摘要绑定：`validateAnalyzeConsent`（`frontend-reconstruct-ipc.cjs:579-605`）+ `ScreenSendConsent`。
- 过程卡安全视图：`buildFrontendProcessView`（`agentRunProcess.mjs:474-523`）+ `ProcessSummary`（`ChatStream.jsx:21-57`）。
- 有界 issues/checks 形状：`normalizeChecks`/`normalizeIssues`（`frontend-reconstruct-ipc.cjs:437-453`）。
- 双 tab 与 roving tabIndex：`RightPanel.jsx:93-169`。
- UIA 走查脚本骨架：`scripts/agent-smoke.cjs`、`scripts/app-assistant-smoke.cjs`。

---

## 11. 本轮未做 / 边界声明

- 未运行任何测试（`npm test`、`node --test`）、未构建、未启动 Electron 或微信开发者工具；本文件**没有**运行时证据，全部为静态阅读事实。
- 未读 `.env`、未接触任何密钥；未改 `src/**`、`desktop/**`、`server/**`、`contracts/**`、`test/**`；未改冻结文档。
- 未验证 UI 在真实 UIA 树下的可读名称（需后续 GUI 任务跑 `npm run agent:smoke` / `app:assistant:smoke`）。
