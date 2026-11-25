# E0-U1 接口差距梳理（UI 视角，只读对照 rev15）

> 任务：`t3` / **E0-U1**（product-ui），attempt 2（attempt_id `6d23cc4e-8eae-4b21-8254-80de7bf110c6`；attempt 1 收口于 PARTIAL），
> 第一次落盘为 attempt 1（attempt_id `09ae238b-7ad7-4de4-a22d-4846517613eb`）。
> 对照基线：`docs/handoff/Workspace-Agent-B阶段接口冻结.md` **rev15**（§9.1 / §14.2 / §14.3 / §14.4 / §14.5 / §14.9，附 §14.8）。
> 上游：`docs/handoff/Workspace-Agent-E0闭环纠偏与E阶段-Flash续期计划.md` §1 X2–X10、§2.2–§2.4、§4 E0-U1。
>
> **状态：四份产出全部落盘（本文件、`src/components/agent/e0/**`、`test/e0-ui*.test.cjs`、`uia-checklist.md`）。**
> 本文件由 attempt 1 的 PARTIAL 版本补齐：`uia-checklist.md` 已产出（E3 的 50 条 UIA 断言清单，全部 `NOT_RUN`，
> 未执行 GUI、未伪造截图）。仍留待 E3 的只有 §6.4 的错误码→中文文案表（本轮未产出，属 E3 前置）。
>
> 边界：本文件**只读**代码与冻结文档。没有改动任何冻结文本、`src/App.jsx`、`sessionMachine.mjs`、
> `RightPanel.jsx`、`src/services/**`、`desktop/**`、`server/**`；没有启动 Electron / 微信 / 模型调用。
> 下面每条“需新增字段 / 需新命令”都是**给 Captain 的需求**，不是我自己去改冻结。

状态词口径（总计划 §0.4）：`PASS / FAIL / BLOCKED / NOT_RUN`；`partial` ≠ 通过；`mock` 只用于测试。

---

## 0. 四类结论汇总

| 结论 | 条数 | 含义 |
|---|---|---|
| **可用** | 14 | 冻结形状 + 现有实现已经够 UI 用，本轮组件直接吃这些数据 |
| **需新增字段** | 10 | 命令存在，但 `data` 里缺 UI 必须展示的事实（不补就只能猜或显示“未知”） |
| **需新命令** | 4 | renderer 侧根本没有出口（`§14.2` 已冻结的 coordinator 方法没有 IPC 暴露） |
| **本轮不做** | 5 | 明确知道缺口，但 E0-U1 不落地（留 E3/E4 或等 Captain 派单），本轮 UI 不依赖 |

**一句话结论**：UI 侧唯一被“卡死”的是 **①没有 `agent:start-run` 类命令（无法创建 attempt）**、
**②`get-context` 没有 `targetPages:[{id,enabled,reasons}]`（8 页选择器没有事实输入）**、
**③没有 `agent:adopt-attempt`（无法采用）**、
**④`run-check` 的 `data` 没带 `treeDigest/subjectKind/at`（候选卡无法证明“检查针对本次候选”）**。
其余都能用现有字段拼出来，或本轮不依赖。

---

## 1. 方法与证据来源（全部只读）

- 冻结：`docs/handoff/Workspace-Agent-B阶段接口冻结.md`（rev15，1038 行；§9.1@608、§14.5@913、§14.9@999、adopt 命令@938）。
- renderer 出口：`desktop/preload.cjs:53-83`（`smartStore.workspaceAgent` 19 命令 + `onProgress`）、
  `src/services/workspaceAgent/index.js:13`（`WORKSPACE_AGENT_METHODS`，与 preload 同 19 项）。
- 主进程实现：`desktop/agent-tools-ipc.cjs`（`get-context`@645、`run-check`@918、`read-artifact`@1058、
  `submit-candidate`@1113、`cancel-run`@1246）。
- 旧链常量（**E0 不复用、不修改**）：`desktop/frontend-reconstruct-ipc.cjs:142`（`STAGE_LABELS`，13 键）、
  `src/domain/frontendReconstruct.mjs:73`（`FRONTEND_PROGRESS_STAGES`，9 键）、
  `src/domain/agentRunProcess.mjs:45`、`src/components/chat/stageNotice.mjs:21`（`FRONTEND_STAGE_NOTICES`，9 键）。
- 页面事实源：`scripts/agent-source-facts.cjs:73`（`PAGE_CONTRACTS`，正好 8 页，与 §14.5 枚举同集）。
- v1 目标页常量（X5 相关）：`desktop/frontend-reconstruct/contract.generated.cjs:15`
  `const TARGET_PAGES = Object.freeze(["home","menu"])`。
- 本轮自测命令（等价门禁，见 §14.11 写法）：
  `node --test --experimental-test-isolation=none "test/e0-ui*.test.cjs"` → **23 pass / 0 fail**。

---

## 2. §14.2 Coordinator 与 attempt 生命周期

| # | UI 需要的事实 | 冻结/现状 | 结论 |
|---|---|---|---|
| 2.1 | 创建 run/turn/attempt：`{projectId, baseVersionId?, targetPage, operation, utterance, imageAssetIds?}` → `{runId,turnId,attemptId,baseVersionId,baseTreeDigest,revision,targetPage,operation}` | §14.2 已冻结 `coordinator.startRun` 形状；但 preload 19 命令里**没有** start-run（`preload.cjs:53-83`），facade 也没有（`index.js:13-33`） | **需新命令**：`agent:start-run`（建议 channel 名，payload/回包按 §14.2 逐字，含 `targetPage`/`imageAssetIds`） |
| 2.2 | 读 run/attempt 状态：`state`、`turns[]`、`attempts[]`（含 `attemptId/revision/treeDigest/status`） | §14.2 已冻结 `getRun` / `getAttemptState`；renderer 无出口 | **需新命令**：`agent:get-run` / `agent:get-attempt-state`（二选一或合并；候选卡与进度卡都要它） |
| 2.3 | 候选卡要显示“修改文件数” | §14.2 的 attempt 形状**没有** `changedFileCount`；只能退化成再调 `agent:get-diff` 数 `files.length`（多一次往返 + 有 `truncated` 风险） | **需新增字段**：`attempts[].changedFileCount`（+ 可选 `changedFiles[]` 有界前 64 条） |
| 2.4 | 候选卡要显示 attempt 是否已 `submitted`（提交后只读） | §14.2 有语义（`AGENT_ATTEMPT_IMMUTABLE`），但状态字段不在任何 UI 可见 `data` 里 | **需新增字段**：`attempts[].status`（`open/submitted/adopted/discarded`） |
| 2.5 | 取消运行，且 `too-late` 不能显示成失败 | `agent:cancel-run` 已实现（`agent-tools-ipc.cjs:1246`），回 `{state:"requested"\|"cancelled"\|"too-late",stage?,cancelled}` | **可用** |
| 2.6 | 提交候选，拿到 `{candidateId,revision,treeDigest,targetPage,status:"submitted"}` | `agent:submit-candidate` 已实现（`agent-tools-ipc.cjs:1113`） | **可用**（但目标页校验见 §4.2 冲突） |
| 2.7 | 采用 attempt（E3 的“采用”按钮） | §14.5/§3.2 明确要 `agent:adopt-attempt`（冻结 @938，“B3 未实现，E0 补”）；preload/facade/IPC **都没有** | **需新命令**：`agent:adopt-attempt`（回 `{currentVersionId, adoption}`；需能回 `AGENT_EVIDENCE_STALE` / `AGENT_PARTIAL_CONFIRM_REQUIRED`） |
| 2.8 | `operation` 取值枚举（UI 下拉/文案要用） | §14.2 只写 `operation` 必填，未给取值集合 | **本轮不做**：E0-U1 组件不暴露 operation，默认单值由 E1 定 |
| 2.9 | `runId` 由平台生成、UI 不得自造 | §14.2 不变量 1 已冻结 | **可用**（UI 只显示，不生成） |

---

## 3. §14.3 工具上下文与 subject

| # | UI 需要的事实 | 冻结/现状 | 结论 |
|---|---|---|---|
| 3.1 | 工具上下文里的 `subject:{kind:"attempt",attemptId}` 由平台注入，UI 不传 | §14.3 冻结；现状 UI 也拿不到、不需要 | **可用** |
| 3.2 | 进度条要能显示“这一步在调哪个工具”（E3 过程卡） | §3.2 `agent:progress` payload 固定 `{projectId,runId,turnId,attemptId,phase,stage,status,at,message}`，**没有 tool 字段**；§14.3 的 11 个模型工具名只在模型侧 | **需新增字段**（E3 用）：`progress.tool`（白名单：11 个模型工具 + 3 个平台专用，禁止参数）。**本轮不落地**，进度条只用 stage |
| 3.3 | `read_file` 只回内容与摘要、不回绝对路径 | §14.3 冻结 + 已实现 | **可用** |
| 3.4 | 平台专用工具（`derive_source_bundle`/`adopt_attempt`/`attach_image_asset`）不得出现在模型工具列表 | §14.3 冻结；UI 不展示模型工具列表 | **可用** |
| 3.5 | E3 的 before 基线：读已采用版本的验证证据 | `agent:read-verification` 已支持 `source:"attempt"\|"version"` + `versionId`（§3.2） | **可用** |

---

## 4. §14.4 检查目标绑定

| # | UI 需要的事实 | 冻结/现状 | 结论 |
|---|---|---|---|
| 4.1 | 每条检查证据要能展示“查的是哪个树” | §14.4 要求证据记录 `{checkId,status,treeDigest\|exportTreeDigest,subjectKind,attemptId,at,issues[]}`；但 `agent:run-check` 的 `data` 只有 `{checkId,status,durationMs,issues,evidenceRelative?}`（`agent-tools-ipc.cjs:918-966`），**没有** digest/subjectKind/at | **需新增字段**：`data.{treeDigest,exportTreeDigest,subjectKind,attemptId,at}`（或 `evidenceRelative` 必填 + UI 走 `read-artifact`）。否则候选卡只能显示 PASS/FAIL 却无法证明“针对本次 treeDigest” |
| 4.2 | 四态归一：检查状态只允许 `PASS/FAIL/BLOCKED/NOT_RUN` | run-check 里 `CHECK_STATUSES.includes(outcome.status) ? outcome.status : 'FAIL'` —— **未知状态被静默改成 `FAIL`** | **需 Captain 裁定（语义更正，非新增字段）**：未知状态建议回 `NOT_RUN` + 一条 issue（`CHECK_STATUS_UNKNOWN`）。把“没跑/不认识”显示成“失败”会让用户误判，也和 §14.4“单一口径”相冲 |
| 4.3 | 工具缺失 → `BLOCKED`，不伪造 PASS | run-check 对 `TOOL_UNAVAILABLE_CODES` 回 `status:'BLOCKED'` + `CHECK_TOOL_MISSING` issue；`verify-wechat` 同 | **可用** |
| 4.4 | BLOCKED / NOT_RUN 的“原因”文案 | 现状只能从 `issues[].message` 拼（我在 `buildCandidateSummary` 里做了 `reason`/`reasons` 兼容，缺原因时如实写“平台未给出原因”） | **可用**（建议后续可选加 `data.reason`，见 4.1 一并做） |
| 4.5 | `run_check.params` 白名单（UI 只给 checkId） | §14.4 冻结 + `validateParamsObject` 已实现 | **可用** |
| 4.6 | `capabilities.check` 作为独立 repo check（不能冒名 `source.check`） | §14.4 冻结；`checks` 列表经 `get-context.checks` 下发 | **可用** |

---

## 5. §14.5 SourceBundle 与提交/采用

| # | UI 需要的事实 | 冻结/现状 | 结论 |
|---|---|---|---|
| 5.1 | **8 页目标枚举 + 每页 enabled/reasons**（选择器的唯一事实输入） | §14.5/F3 冻结为 `get-context.targetPages:[{id,enabled,reasons}]`；现状 `agent:get-context` 回 `{projectId,versionState,currentVersionId,redoVersionId,versionCount,checks,storeDraft,verification}`（`agent-tools-ipc.cjs:645-663`）——**没有 `targetPages`** | **需新增字段**（E0-U1 最关键的缺口）：`get-context.targetPages` 必须由 SourceFacts/page-contract 派生（`scripts/agent-source-facts.cjs:73` 的 8 页），非 menu 页 `enabled` 由事实存在性决定，禁止硬编码 8 个 true |
| 5.2 | 提交时 `targetPage` 的合法集合 | `submit-candidate` 仍用 v1 `contractGenerated.TARGET_PAGES`（`agent-tools-ipc.cjs:1121` → `contract.generated.cjs:15` = `home/menu`） | **需新增字段**的连带修正：X5 未关闭。E1 接线前 `submit-candidate` 必须改用与 5.1 同源的 8 页派生结果，否则除 menu 外 7 页都无法提交。UI 侧不改冻结，只在此登记需求 |
| 5.3 | 静态门禁失败的可见码 | `AGENT_STATIC_GATE_FAILED` 已冻结（§14.9）但 `submit-candidate` 尚未按 §14.5 的 ①②③ 门禁校验（当前只写 `attempt.json`） | **需新命令/实现的连带项**：属 workspace-lead E0-W2；UI 只需能显示该码 → 归类 **需新增字段**（`submit` 失败时的 `checks[]` 证据摘要）。本轮 UI 已能显示码与问题行，**不阻塞** |
| 5.4 | `partial` 采用需要显式确认 | §14.5 冻结：运行时 `BLOCKED/NOT_RUN` → 需 `partialConfirmed:true`，否则 `AGENT_PARTIAL_CONFIRM_REQUIRED`；`adopt-attempt` payload 已含该字段 | **可用**（命令本身见 2.7） |
| 5.5 | 来源清单摘要 `bundleDigest` 展示 | §14.5 冻结“派生后重算 treeDigest 并记录 bundleDigest”，但 UI 可见面没有它 | **本轮不做**：E0-U1 候选卡只展示 `treeDigest`；`bundleDigest` 留 E3，届时需要 `attempts[].bundleDigest` |
| 5.6 | 导出树摘要 `exportTreeDigest`（证明检查针对本次导出） | 同 4.1 | **本轮不做**（与 4.1 一起在 E3 前补；本轮候选卡用 `verify` 检查条目的 `status` 展示，不显示导出摘要） |
| 5.7 | 非法页 → `AGENT_TARGET_PAGE_UNSUPPORTED` | §3.3/§14.5 已冻结；UI 侧 `pickTargetPage` 已按此码返回 | **可用** |

---

## 6. §14.9 错误码 / 进度 / 口径

| # | UI 需要的事实 | 冻结/现状 | 结论 |
|---|---|---|---|
| 6.1 | progress stage 白名单追加 `queue/image/bundle/submit`（`adopt` 原文已有） | §14.9 冻结；E0 白名单 = §9.1 的 18 项 + 4 项追加 = **22 项**（`e0UiContract.mjs#E0_PROGRESS_STAGES`） | **可用** |
| 6.2 | 未知 stage 显示「未知阶段（x）」且不丢步 | §14.9/rev2 F5 冻结；payload 已有 `stage` | **可用**（旧链 `frontendReconstruct.mjs:703` 的 `return sameState` 丢步缺陷**没有**被 E0 继承） |
| 6.3 | 进度事件能分 attempt 展示 | §3.2 payload 含 `attemptId`（可能为 null） | **可用**（组件已容忍 null） |
| 6.4 | 错误码 → 中文文案表（E3 要统一话术） | 冻结只给码，没给 UI 文案 | **本轮不做**：本轮未产出错误码文案表，列为 E3 前置（见 §7 未完成项） |
| 6.5 | `partial` ≠ 通过、四态不混用 | §14.9 冻结；E0 口径模块只认四态，非法值降级 `NOT_RUN` 并标 `unknown` | **可用** |
| 6.6 | 新增 `AGENT_*` / `MODEL_*` 码不得私增 | §14.9 冻结 | **可用**（UI 只映射显示，不新增码） |

### 6.7 附：§14.8 图片与 consent（UI 表单直接受影响）

| # | UI 需要的事实 | 冻结/现状 | 结论 |
|---|---|---|---|
| 6.7.1 | run 级“参考图状态”（`MISSING/READY/BLOCKED` + 原因） | §14.8 只定义 `resolveAssetImage` 与错误码；UI 可见面没有图状态字段 | **需新增字段**：`run-state.image = {assetId,status:"MISSING"\|"READY"\|"BLOCKED",reason,mime,bytes}`。本轮组件用 props 容忍缺失（缺图显示 MISSING + BLOCKED），但**没有平台事实就无法区分“没选图”和“图坏了”** |
| 6.7.2 | consent 需要传给主进程（“用户明确同意把图发给模型”） | 冻结未定义 consent 字段；`startRun` 只有 `imageAssetIds` | **需新增字段**：`start-run.imageConsent:{granted:boolean,at:string}`（或 `consentRef`）。本轮组件只表达同意（不读文件、不写盘），传参留 E1 |
| 6.7.3 | E0 只接受 1 张图、单张 ≤2 MiB | §14.8 冻结 | **可用**（组件按 1 张 + 2 MiB 提示） |
| 6.7.4 | 视觉不可用 → `AGENT_VISION_UNAVAILABLE`，不得静默降级纯文本 | §14.8 第 5 条冻结 | **可用** |

---

## 7. 未完成项

1. **错误码 → 中文文案表**（§6.4）未产出，属 E3 前置；本轮 UI 只做“码原样显示 + 不新增码”。
2. **§3.2 的过程卡 `progress.tool`** 字段需求已提（R8），但本轮进度条只展示 stage，不展示工具名。
3. 未做任何 GUI 走查（`npm run agent:app` / `agent:snapshot`）：本轮**不伪造** UIA 结果，也不产出截图。
   E3 的 50 条断言清单见同目录 `uia-checklist.md`，全部如实记 `NOT_RUN`。

---

## 8. 需要 Captain 出 rev 的需求清单（只提需求，不改冻结）

| ID | 类别 | 内容 | 阻塞谁 |
|---|---|---|---|
| R1 | 需新命令 | `agent:start-run` / `agent:get-run` / `agent:get-attempt-state`（§14.2 已冻结 coordinator 形状，但 §3.2 命令清单是冻结的，需要 rev 追加三行） | E1 全链（没有它就创建不了 attempt） |
| R2 | 需新命令 | `agent:adopt-attempt`（§14.5 已要求，B3 未实现） | E3 采用 / E4 |
| R3 | 需新增字段 | `get-context.targetPages:[{id,enabled,reasons}]`，由 SourceFacts/page-contract 派生，禁止硬编码 8 个 true | E0-U1 选择器（当前只能全灰） |
| R4 | 实现偏差 | `submit-candidate` 仍按 v1 `home/menu` 校验目标页（X5 未关闭） | E1 其余 7 页提交 |
| R5 | 需新增字段 | `run-check.data.{treeDigest,exportTreeDigest,subjectKind,attemptId,at}`（+ 可选 `reason`） | E3 候选卡“证据绑定”展示 |
| R6 | 语义更正 | run-check 遇未知状态不得静默改 `FAIL`，应 `NOT_RUN` + issue | E3 四态可信度 |
| R7 | 需新增字段 | `attempts[].{changedFileCount,status,bundleDigest}`、`image:{assetId,status,reason}`、`start-run.imageConsent` | E3 候选卡 / E1 表单 |
| R8 | 需新增字段（E3） | `progress.tool`（11 个模型工具 + 3 个平台专用，禁参数） | E3 过程卡 |

> 以上均为**加法**：不删字段、不改现有语义（除 R6 的“未知→FAIL”更正）。在 Captain 出 rev 前，
> UI 侧一律按现有冻结形状渲染，缺字段就如实显示“未知 / NOT_RUN”，**绝不补一份本地假事实**。

---

## 9. 本轮已落地的 UI 侧口径（与上表一一对应，供 E3 直接复用）

| 契约点 | 落地位置 | 关键断言 |
|---|---|---|
| 8 页枚举（顺序即契约） | `e0UiContract.mjs#E0_TARGET_PAGE_IDS` | 测试直接解析 §14.5 原文比对；并交叉核对 `scripts/agent-source-facts.cjs#PAGE_CONTRACTS` |
| `enabled` 只认平台事实 | `normalizeTargetPages` / `pickTargetPage` | 缺事实 → 8 页全 `enabled:false` 且带原因；枚举外 id 进 `rejected` |
| stage 白名单 22 项（单一来源） | `E0_PROGRESS_STAGES` | 测试解析 §9.1 + §14.9 比对；`src/` 内只此一份（旧链副本不增加） |
| 未知 stage 不丢步 | `formatStageLabel` / `appendProgressStep` / `windowProgressSteps` | `未知阶段（mystery）` 保留；超上限只折叠旧步，未知步仍显示 |
| 四态 | `E0_CHECK_STATUSES` / `normalizeCheckStatus` | 非法值 → `NOT_RUN` + `unknown:true`，文案保留原始值 |
| 缺图 | `describeReferenceImage` | 无图 → `MISSING` + 视觉分析 `BLOCKED`，文案同时含两者 |
| consent | `describeConsent` / `E0_CONSENT_TEXT` | 未同意 → `BLOCKED`；文案表达“同意把图发给模型” |
| 候选摘要 | `buildCandidateSummary` | 修改文件数 / treeDigest / 两套四态 / BLOCKED·NOT_RUN 原因 / `partial` 标记 / `submitReady` |
| 可访问名称 | 5 个组件 | 每个可交互控件有 `aria-label`，容器有 `role`+`aria-label`，同名控件不重复 |

证据命令与结果：

```text
node --test --experimental-test-isolation=none "test/e0-ui*.test.cjs"
→ tests 23 / pass 23 / fail 0

node -e "esbuild.transformSync(...)"（e0 目录 7 个文件）
→ ok CandidateSummaryCard.jsx / e0UiContract.mjs / index.js / ReferenceImageUploader.jsx
     / RunProgressBar.jsx / TargetPageSelect.jsx / UtteranceInput.jsx
```

> 注意口径：以上是**静态口径 + 组件源码断言**，不是 GUI/UIA 验收，也不是微信运行时验收；
> 真实 UIA 断言清单（`uia-checklist.md`）与真实截图对比属 E3/E4，本轮没有做、也没有声称做过。
