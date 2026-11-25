# E0-W1 证据：WorkspaceRunCoordinator 与 attempt 生命周期（X1/X3）

> 契约：`docs/handoff/Workspace-Agent-B阶段接口冻结.md` rev15 §14.2/§14.3（辅以 §1.3/§1.5/§1.6/§1.7、§3.3、§14.9、§14.10）
> + 计划 `docs/handoff/Workspace-Agent-E0闭环纠偏与E阶段-Flash续期计划.md` §4 E0-W1。
> 执行者：workspace-lead（t1，attempt 1）。采集时间：2026-11-25。
> **E0 独立验收（E0-V1）通过前，本报告不构成 E0 通过，也不代表 E1–E4 可开工。**

---

## 0. 总计划 §0.3 模板

```text
任务 ID：E0-W1（X1 / X3）
目标是否完成：YES（本轮范围内；X4/X5/X6/X7 的检查目标绑定与 bundle 派生按 rev15 属 E0-W2）
实际修改文件：
  - desktop/agent-workspace/run-coordinator.cjs                              新增（纯 CJS，不依赖 Electron）
  - desktop/main.cjs                                                          改（+2 require，+broadcastAgentProgress，+Coordinator 单例接线）
  - test/agent-workspace.coordinator.test.cjs                                 新增（15 个无 UI Node 用例）
  - docs/evidence/workspace-agent/e0-w1/report.md                             新增（本文件）
行为变化：
  - 桌面主进程新增唯一执行所有者：startRun 建 run/turn/attempt（从 versions/<id>/source 复制工作树），
    工具上下文固定注入 subject:{kind:"attempt",attemptId}；写只落 attempt；每次写事务 revision+1 并重算 treeDigest。
  - 模型工具面固定 11 个；平台专用（derive_source_bundle/adopt_attempt/attach_image_asset）一律 AGENT_TOOL_NOT_ALLOWED。
  - 跨项目/跨 run/跨 turn/伪造句柄拒绝（AGENT_PROJECT_MISMATCH / AGENT_ATTEMPT_NOT_FOUND）且零落盘。
  - submit 静态门禁 + 提交后只读（AGENT_ATTEMPT_IMMUTABLE）+ 重复提交（AGENT_RUN_ALREADY_SUBMITTED）；
    adopt 委托 B2 adoptAttempt（partial 必须显式确认）。
  - cancelRun 三态（requested/cancelled/too-late）；取消后迟到工具调用不落盘、不再调检查注册表/direct runtime。
  - 旧 B3 IPC（registerAgentToolsIpc）行为不变（checks 仍为 null）；agent:progress 广播收敛为一个出口函数。
新增测试：test/agent-workspace.coordinator.test.cjs（15 用例，见 §4）
执行命令与真实退出码：见 §1（3 条等价门禁全部退出码 0）
真实模型/微信/UIA/安装包证据：NOT_RUN（本任务为无 UI 生命周期与门禁，未跑真实模型/微信/UIA/安装包）
与计划的偏差：见 §5
剩余问题：见 §6（转 E0-W2 / E0-R1 的接线项）
下一任务是否可开始：YES（E0-W2 可在本交付之上继续；E1–E4 仍需等 E0-V1 独立 PASS）
```

---

## 1. 门禁命令与真实退出码（rev15 §14.11 等价命令）

| # | 命令 | 结果 | 证据 |
|---|---|---|---|
| 1 | `node --test --experimental-test-isolation=none "test/agent-workspace*.test.cjs"` | **exit 0** | tests 79 / pass 79 / fail 0（三次复跑 duration_ms ≈ 117960 / ≈ 89724 / ≈ 89090） |
| 2 | `node --test --experimental-test-isolation=none test/agent-tools-ipc.test.cjs test/desktop-contract.test.cjs` | **exit 0** | tests 43 / pass 43 / fail 0 / duration_ms ≈ 14676 |
| 3 | `node -e "require('./desktop/agent-workspace/run-coordinator.cjs');console.log('run-coordinator ok')"` | **exit 0** | stdout `run-coordinator ok` |

补充（仅本任务新用例，便于复核定位）：

| 命令 | 结果 |
|---|---|
| `node --test --experimental-test-isolation=none "test/agent-workspace.coordinator.test.cjs"` | **exit 0**：tests 15 / pass 15 / fail 0 |

官方门禁口径（§14.11 第二段）如实记录：

- `npm test`（`node --test test/*.test.cjs` 全量）：**NOT_RUN**。本任务只跑 E0 等价门禁，未跑仓库全量用例；
  不得用等价门禁替代官方门禁结论。
- `npm run build` / `npm run desktop:dev`：**NOT_RUN**（本任务不触碰 renderer 与构建配置）。
- 真实模型 / 微信开发者工具 / UIA 无障碍走查 / 安装包：**NOT_RUN**（E0-W1 不涉及；mock 只在测试里出现并显式标注）。

---

## 2. 交付物与形状（照抄 rev15）

### 2.1 `desktop/agent-workspace/run-coordinator.cjs`

导出：`createRunCoordinator / CODES / MODEL_TOOL_NAMES / PLATFORM_ONLY_TOOL_NAMES / RUN_STATES / ATTEMPT_STATUSES / PROGRESS_STAGES / LIMITS`。

```js
createRunCoordinator({ userDataDir, checks?, directRuntime?, emitProgress?, limits?, now? }) => coordinator
coordinator.startRun({ projectId, baseVersionId?, targetPage, operation, utterance, imageAssetIds? })
  => { runId, turnId, attemptId, baseVersionId, baseTreeDigest, revision, targetPage, operation }
coordinator.getRun({ projectId, runId })                 => { runId, projectId, state, turns, attempts, … }
coordinator.invokeTool({ projectId, runId, turnId, attemptId, tool, args }) => Promise<§3.3 envelope>
coordinator.getAttemptState({ projectId, runId, turnId, attemptId })
coordinator.cancelRun({ projectId, runId })               => { state:'requested'|'cancelled'|'too-late', cancelled:bool }
coordinator.submitAttempt({ projectId, runId, turnId, attemptId, targetPage, summary? })
coordinator.adoptAttempt({ projectId, runId, turnId, attemptId, targetPage, partialConfirmed? })
```

内部（不属于冻结 8 签名，见 §5 偏差 3）：`assertRunActive({projectId,runId})`、`invokeDirect({…,request})`、
`toolCatalog()`、`limits`。

### 2.2 复用的既有模块（零复制）

| 关注点 | 复用 |
|---|---|
| 私有根/路径闸门/链接识别/原子写 | `desktop/agent-workspace/paths.cjs`（唯一实现） |
| 布局与 attempt 句柄归属校验 | `workspace.cjs#workspacePaths/attemptPaths/openWorkspace/createAttempt/openAttempt/removeAttempt` + `transactions.assertAttemptHandle` |
| 文件读写搜索 | `files.cjs#listFiles/readFile/searchFiles/isBinaryBuffer` |
| 写事务/冲突/原子提交/revision | `transactions.cjs#applyChanges` |
| manifest/treeDigest/diff/元数据 | `manifest.cjs#buildManifest/diffManifests/digestOfContent/writeRunMeta/writeAttemptMeta` |
| 版本指针与采用 | `versions.cjs#readProjectState/readVersion/resolveVersionSource/adoptAttempt` |
| 检查注册表 | `checks.cjs#createCheckRegistry`（惰性加载，可注入） |

本文件**没有**新增 lstat/realpath/mkdir 安全逻辑，**没有** shell/child_process 入口，**没有**依赖 Electron
（`test/agent-workspace.coordinator.test.cjs` 静态断言了这三点）。

### 2.3 `desktop/main.cjs`（单例接线）

```js
const { createRunCoordinator } = require('./agent-workspace/run-coordinator.cjs');
const { createCheckRegistry } = require('./agent-workspace/checks.cjs');

function broadcastAgentProgress(payload) { /* 唯一 agent:progress 出口 */ }

const workspaceRunCoordinator = createRunCoordinator({
  userDataDir, checks: createCheckRegistry({ userDataDir }), directRuntime: null,
  emitProgress: broadcastAgentProgress,
});
```

- 主进程内单例；**不**把 `userDataDir`/目录/绝对路径交给 renderer；**不**新增通用 fs/exec 通道（静态用例断言）。
- `registerAgentToolsIpc` 仍按 B3 原样（`checks: null`），避免在本任务里偷偷改 B3 IPC 语义；见 §5 偏差 8。

---

## 3. 关闭口径（逐条对 rev15 §14.2 不变量）

| # | 冻结不变量 | 落地事实 | 用例 |
|---|---|---|---|
| 1 | runId 用 B1 `RUN_ID_PATTERN`（`frun-…`），平台生成 | `nextRunId()` 生成 `frun-<base36时间>-<6hex>`，冲突重试 8 次；模型/UI 无法指定 runId | 签名用例 + startRun 形状 |
| 2 | `baseVersionId` 缺省取 `project.json.currentVersionId`；无版本 → `AGENT_VERSION_NOT_FOUND`，不回落 Base | 先纯读 `readProjectState` + `readVersion`，失败即返回且**不建任何目录**；`projects/`、`runs/` 均断言不存在 | 「无 currentVersionId…」用例 ①②③ |
| 3 | attempt 工作树 = 该 version `source/` 副本；`baseTreeDigest` 记创建值 | `createAttempt(source:{kind:'version',versionId})`；返回 `baseTreeDigest === resolveVersionSource().treeDigest` | 「startRun 从 versions/<id>/source 复制…」 |
| 4 | 写产生新 revision 并重算 treeDigest；submitted 后只读；repair 建新 attempt | `applyChanges` 后 revision 2→3→4 且 `treeDigest === buildManifest(candidate)`；提交后写/删 `AGENT_ATTEMPT_IMMUTABLE` 且候选树快照不变 | 「每次写事务后…」「submit 静态门禁…」 |
| 5 | 跨项目/跨 run/跨 turn 句柄拒绝，只放行 `runs/<runId>/turns/<turnId>/attempts/attempt-<n>/` | 路径全部由 `attemptPaths` 推导 + `attempt.json` 身份三项比对 + `openAttempt` canonical 复核；拒绝前后 attempt 目录快照逐字节一致 | 「跨项目/跨 run/跨 turn/伪造句柄…」 |
| 6 | 迟到工具调用不得落盘 | 取消（含 requested）后 `invokeTool` 直接 `AGENT_CANCELLED`；异步检查 await 回来后二次确认，证据零写入 | 「cancelRun 三态…」 |
| 7 | 不向 renderer/模型暴露目录或绝对路径 | envelope `data`/`meta`/进度事件全部断言不含 `userDataDir` 与 attempt 绝对路径；`meta` 只含 id 与 durationMs | 各用例 `assertNoPathLeak` + 进度用例 |
| 额外 | §14.3 工具面 11 个 / 平台专用拒绝 | `MODEL_TOOL_NAMES` 11 项固定顺序；`derive_source_bundle/adopt_attempt/attach_image_asset` 与未知名 → `AGENT_TOOL_NOT_ALLOWED` | 「模型工具面 11 个…」 |

X1/X3 的可判定事实：

- **X1**：所有工具执行都在主进程 `invokeTool` 内直接调 B1/B2/B4 本地模块，不经 renderer 回环；
  `directRuntime` 缺省 null 时只能走平台工具，不调模型；`invokeDirect` 是 direct 通道唯一入口并带取消门控。
- **X3**：`startRun` 一次创建 run/turn/attempt；工具上下文固定含 `subject:{kind:"attempt",attemptId}`；写入只落 attempt。

### 3.1 证据文件（attempt/verification/**，rev15 §14.4 字段）

- `verification/checks/<checkId>.json`：`{checkId,status,durationMs,treeDigest,subjectKind,attemptId,at,issues[],evidenceRelative?}`
- `verification/submission.json`：`{candidateId,revision,treeDigest,targetPage,partial,checks[],at,summary?}`
- 全部走 `paths.writeJsonAtomic`，目标经 `assertCanonicalDir + isInsideOrEqual + auditPath` 双重校验；
  不含绝对路径/base64/源码全文。

### 3.2 submit 静态门禁（W1 版，可判定）

必须同时满足，否则 `AGENT_STATIC_GATE_FAILED` 且不置 submitted：

1. `source.check` 证据 `status=PASS` 且 `subjectKind="attempt"` 且 `treeDigest === 当前 attempt treeDigest`；
2. `composer.dry-run` 同上；
3. 已存在的 `mini.check`/`output.consistency`/`wechat.verify` 若为 `FAIL` → 拒绝；
   `BLOCKED`/`NOT_RUN`/缺失 → 允许但记 `partial:true`（`partial ≠ 通过`，adopt 需 `partialConfirmed:true`）。

### 3.3 adopt 三分码（rev15 §14.12-Q1 对齐）

| 情形 | 错误码 | issue |
|---|---|---|
| `attempt.status ≠ submitted`（从未提交 / 已取消 / 已被取代 / 已采用） | `AGENT_ADOPTION_FAILED` | `code:"NOT_SUBMITTED"` |
| 已 submitted，但 `submission.treeDigest ≠ 当前 attempt.treeDigest` | `AGENT_EVIDENCE_STALE` | —（message 说明偏差） |
| 运行时证据 `BLOCKED/NOT_RUN` 且未显式 `partialConfirmed:true` | `AGENT_PARTIAL_CONFIRM_REQUIRED` | — |
| 已 submitted 但缺 `verification/submission.json` | `AGENT_VERIFICATION_MISSING` | — |

三者语义不同、互不顶替；`AGENT_STATIC_GATE_FAILED` 只用于 **提交** 门禁，不用于 adopt。
rev15 §14.12-Q2 要求的“Coordinator 句柄校验层 `projectId ↔ 私有根` 一致性”在 W1 已提前落地
（伪造/搬迁 run 目录 → `AGENT_PROJECT_MISMATCH` 且零落盘，见用例 7 ⑤）。

---

## 4. 测试清单（`test/agent-workspace.coordinator.test.cjs`，15 用例，全绿）

| # | 用例 | 覆盖验收点 |
|---|---|---|
| 1 | createRunCoordinator 冻结签名、默认值与错误码表 | 8 签名齐备、limits 未知键拒绝、11 工具名单、平台专用不泄漏、12 个冻结错误码可达 |
| 2 | startRun 从 versions/<id>/source 复制工作树并返回冻结形状 | runId 正则/baseTreeDigest/目录布局/元数据无绝对路径/getRun 形状 |
| 3 | startRun 无 currentVersionId → AGENT_VERSION_NOT_FOUND 且不建目录（不回落 Base） | 三场景：无项目、有工作区无版本、指定不存在 baseVersionId |
| 4 | startRun 拒绝非法 targetPage/operation/utterance/imageAssetIds | `AGENT_TARGET_PAGE_UNSUPPORTED` / `AGENT_PAYLOAD_INVALID` 且零建目录 |
| 5 | 工具 subject 固定 attempt；read_file 可只读 base；写入永不接受 version | attempt/version subject、逃逸路径拒绝、写入带 subject 即拒绝、get_context 无路径 |
| 6 | 每次写事务后 revision 递增并重算 treeDigest | revision 2→3→4、digest 与 buildManifest 一致、get_diff counts |
| 7 | 跨项目/跨 run/跨 turn/伪造句柄一律拒绝且零落盘 | `AGENT_ATTEMPT_NOT_FOUND`/`AGENT_PROJECT_MISMATCH`/`AGENT_RUN_NOT_FOUND`，快照零变化 |
| 8 | 模型工具面 11 个；平台专用/未知工具一律 AGENT_TOOL_NOT_ALLOWED | 平台三件套、未知工具、run_check params 平台字段、args 白名单 |
| 9 | cancelRun 三态；取消后迟到调用不落盘、不调模型/direct runtime | requested→cancelled、证据零写入、注册表调用数不变、direct 调用数不变 |
| 10 | 提交后取消 → too-late；取消不存在 run → AGENT_RUN_NOT_FOUND | 三态之 too-late |
| 11 | submit 静态门禁、提交后只读、重复提交、adopt 委托 B2 | 无证据拒绝、陈旧 treeDigest 证据拒绝、partial、`AGENT_RUN_ALREADY_SUBMITTED`、提交后 `AGENT_ATTEMPT_IMMUTABLE`、v2 采用、重复 adopt → `AGENT_ADOPTION_FAILED`/`NOT_SUBMITTED` |
| 12 | adopt 拒绝未提交候选（`AGENT_ADOPTION_FAILED`/`NOT_SUBMITTED`）与陈旧证据 | §14.12-Q1 三分码 + `AGENT_EVIDENCE_STALE` |
| 13 | 重开一致性（新实例读回同一 revision/treeDigest 并可继续编辑） | 主进程重启语义 |
| 14 | 进度事件只用白名单 stage 且不含路径/源码/base64 | §9.1+rev15 stage 白名单、payload 字段冻结、message≤120 |
| 15 | main.cjs 以单例接线 Coordinator（不暴露目录、不新增 fs/exec 通道） | 静态断言：require 一次/实例化一次/注入 checks+emitProgress/directRuntime null；无 electron/child_process |

回归未受影响（同批命令已含）：B1 workspace/files/transactions/manifest/repo-safety、B2 versions/migration、
B4 checks/c4-slice —— 共 79 用例通过；B3 `agent-tools-ipc` 与 `desktop-contract` 43 用例通过。

---

## 5. 与 rev15 的偏差（全部显式记录，未私改契约）

1. **`invokeTool` 返回 Promise**：`=> envelope` 的**数据形状**不变，但 `run_check`/`verify_wechat` 依赖 B4 的
   async 注册表，只能异步化；调用方（direct loop/E0-R1、测试）必须 `await`。取消/句柄校验在任何 `await` 之前
   同步完成，因此“取消后拒绝”仍然是同步可判定的。
2. **检查目标绑定仍走 B4 现状（root = 当前版本 source）**：rev15 §14.4 要求 `source.check` 查 **attempt 树**，
   属 E0-W2（X4）。W1 不伪造：证据主体按注册表是否声明 `subjectKind:"attempt"` 如实记录，默认为 `"version"`；
   因此在 `main.cjs` 注入的真实注册表下 `submitAttempt` 必然返回 `AGENT_STATIC_GATE_FAILED`（不会被冒充为通过），
   W2 把 checks 改成 attempt root 后自动解除。
3. **新增两个内部方法**（不属于 §14.2 冻结 8 签名）：`assertRunActive`、`invokeDirect`。理由：冻结签名里没有
   “模型调用”入口，而验收要求“取消后不再向 direct runtime 发起调用”。`invokeDirect` 约定注入对象形状为
   `directRuntime.invoke({ context, request })`，`context` 内含固定 `subject`。E0-R1 若需不同形状，应走 rev 或由
   R1 在适配层收敛（本次不锁死）。
4. **`submitAttempt`/`adoptAttempt` 已实现最小真实路径**（任务允许“先抛 `AGENT_STATIC_GATE_FAILED`/委托 W2”）：
   W1 实现静态门禁（§3.2）+ 提交后只读 + 重复提交 + adopt 三分码（§3.3，含 rev15 §14.12-Q1 的
   `AGENT_ADOPTION_FAILED`/`NOT_SUBMITTED`）+ 委托 B2 `adoptAttempt`。
   `exportTreeDigest`/派生导出树/运行时证据绑定仍属 W2（X7），W2 会替换本段实现。
5. **`targetPage` 只做形状校验**（`^[a-z][a-z0-9-]{0,63}$`），8 页枚举与 `enabled/reasons` 派生属 W2（X5）；
   非法形状复用 `AGENT_TARGET_PAGE_UNSUPPORTED`，与 W2 保持同一错误码。
6. **`run.json` 不存 utterance 全文**（只记 `utteranceChars`），遵守 §1.6“不得含完整 prompt”；
   `imageAssetIds` 只存既有 assetId（正则限形、无路径/base64），W1 不解析图片（X2 属 E0-R2）。
7. **`get_diff` 不给行级 additions/deletions**：B1 `diffManifests` 只产出 `{path,status,sha256,bytes}`，
   行级 diff 属 W2/UI 展示面；`data` 已带 `baseTreeDigest/treeDigest/counts`。
8. **`registerAgentToolsIpc` 保持 `checks: null`**（B3 行为不变）：Coordinator 单例是本轮唯一新接线；
   `agent:adopt-attempt` 与 `agent:*` 统一转调 Coordinator 属 E0-W2 接线项（§3.2 rev6 已列命令）。
9. **取消三态的落地语义**：有在途调用 → `requested`（记 `cancelRequested:true`，在途结束后落 `cancelled`）；
   无在途 → `cancelled`；run 已 `submitted`/`adopted` → `too-late`（不显示为失败、不回滚事实）。
10. **E0 期上游并发上限（X12）不在本任务**：Coordinator 本身不发上游模型请求；唯一出口由 E0-R1a/E0-R1 负责。

---

## 6. 剩余问题 / 交接

- **E0-W2（X4/X5/X6/X7）**：
  1. 让 `checks.cjs` 支持 attempt root，并在结果里声明 `subjectKind:"attempt"`（否则 submit 永远门禁失败）；
     `composer.dry-run` 产出的导出树根与 `exportTreeDigest` 需进证据。
  2. `source-bundle.json` 平台派生（`frontend-source-bundle.v1`）→ 重写 attempt manifest/treeDigest（X6）。
  3. `adoptAttempt` 增加 `exportTreeDigest`/运行时证据校验与 `AGENT_EVIDENCE_STALE` 全量口径（X7）。
  4. `agent:*` IPC（含 `agent:adopt-attempt`）统一转调本 Coordinator 单例；`registerAgentToolsIpc` 的 `checks` 注入。
- **E0-R1**：注入 `directRuntime`（形状 `invoke({context,request})`），每个上游请求前调 `assertRunActive`；
  截断/预算/调度器在 R1a/R1 内闭环。
- **E0-U1/E0-V1**：run 状态、`attempts[].status`、进度 stage 白名单已可作为 UI/验证器输入；本报告**不是** E0 验收结论。

---

## 7. 快速复核指引（只读、可重放）

```powershell
node --test --experimental-test-isolation=none "test/agent-workspace*.test.cjs"
node --test --experimental-test-isolation=none test/agent-tools-ipc.test.cjs test/desktop-contract.test.cjs
node -e "require('./desktop/agent-workspace/run-coordinator.cjs');console.log('run-coordinator ok')"
```

复核要点（每条都能在代码里对应）：

1. `run-coordinator.cjs` 的 `resolveAttempt` 只经 `attemptPaths` + `attempt.json` 身份比对 + `openAttempt`，
   任何跨项目/跨 run/跨 turn 输入在被拒绝前不产生写调用（用例 7 用目录快照证明）。
2. `evaluateStaticGate` 只认 `subjectKind:"attempt"` 且 digest 等于当前候选的证据；旧 digest 证据自动失效（用例 11）。
3. `invokeTool` 的取消判定发生在工具分发之前，异步工具 `await` 之后再判一次（用例 9 用挂起的 fake 注册表证明）。

---

## 8. 记录性备注（harness 侧，非交付缺陷）

- 本任务 `inScope` 为 `["desktop/agent-workspace", "desktop/main.cjs", "test", "docs/evidence/workspace-agent/e0-w1"]`，
  而完成校验（`agent_teams_update_task` 的 `changedPaths`）对**目录型 inScope 条目下新增/修改的文件**报
  `<path> is undeclared`：实测 `desktop/agent-workspace/run-coordinator.cjs` 与 `desktop/agent-workspace/paths.cjs`
  均被拒，而同批的 `desktop/main.cjs`（精确条目）可通过。与 B1 复盘记录第 6 条同类：inScope 的目录未按前缀展开。
- 因此 `changedPaths` 只能按 harness 可接受的条目上报；**真实改动清单以本节与 §0 为准**：
  `desktop/agent-workspace/run-coordinator.cjs`（新增）、`desktop/main.cjs`、
  `test/agent-workspace.coordinator.test.cjs`（新增）、`docs/evidence/workspace-agent/e0-w1/report.md`（新增）。
- 该缺陷不影响交付内容（文件已在盘上、三条门禁已 exit 0），但会让后续任务的 `changedPaths` 同样失真；
  建议 Captain 在 rev/任务模板里把 inScope 目录写成 `dir/**` 或补 `declaredPaths`。

