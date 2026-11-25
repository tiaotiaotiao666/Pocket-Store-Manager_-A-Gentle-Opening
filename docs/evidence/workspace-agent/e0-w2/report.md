# E0-W2 证据：检查主体绑定 / 平台派生 bundle / 提交门禁 / adopt-attempt IPC（X4–X7）

> 契约：`docs/handoff/Workspace-Agent-B阶段接口冻结.md` rev15 §14.4（checkId→主体）、§14.5（唯一执行顺序）、
> §14.9（错误码白名单）、§14.12-Q1（adopt 码表）、§14.13-5（handle 拒绝码）；
> 以及团队合同 **revision 2** 新增的 F1–F4（submit 返回体 / 检查缺参先拒后跑 / submit 不得派生 / partial 前先判新鲜度）。
>
> **2026-11-25 t22 修复轮**：按 t15（Review-t5）F-T5-01…10 与 Captain 追加 **OBS-4** 完成修复；
> 本报告 §1/§2.3/§2.5/§3/§4/§7/§7.5/§8 已同步，新增 §9 修复记录。修复后门禁：
> `agent-workspace*` **99/99**、`agent-tools-ipc + desktop-contract + composer-source-overlay` **51/51**、
> 模块加载 4 个 `.cjs` exit 0。X4/X5/X6 复核结论保持不变；X7 的 IPC 阻断项（F-T5-01）已修。
> 计划：`docs/handoff/Workspace-Agent-E0闭环纠偏与E阶段-Flash续期计划.md` §4 E0-W2。
> 执行者：workspace-lead（t5，attempt 2）。采集时间：2026-11-25。
> **E0 独立验收（E0-V1）通过前，本报告不构成 E0 通过，也不代表 E1–E4 可开工。**

---

## 0. 总计划 §0.3 模板

```text
任务 ID：E0-W2（X4 / X5 / X6 / X7 + 合同 rev2 的 F1–F4）
目标是否完成：YES（E0-W2 范围内）
  - X4 checkId→subject 绑定、平台填 root：**已闭合**
  - X5 8 页枚举来自 SourceFacts、enabled 派生：**已闭合**
  - X6 source-bundle 平台派生、模型不可调用/不可写：**已闭合**
  - X7 证据四态 + attempt/导出树绑定 + 冻结码：**已闭合**
  - F1 submit 返回体、F2 检查缺参先拒后跑、F3 submit 不再派生、F4 新鲜度先于 partial：**已闭合**
  - t22 修复轮：F-T5-01（IPC attempt 标识类型）…F-T5-10 与 OBS-4（legacy 写入/cancel 绕过 Coordinator）
    **全部已修**，明细见 §9；X7 的 IPC 阻断项已消除。

实际修改文件：
  - desktop/agent-workspace/source-bundle.cjs                 新增（平台派生 + 8 页枚举 + compose 封装）
  - desktop/agent-workspace/direct-runtime.cjs                新增（direct 通道惰性装配，交付锁）
  - desktop/agent-workspace/checks.cjs                        改（subject 表 / 11 checkId + 别名 / 四态归一 / 进程内 attempt 级检查）
  - desktop/agent-workspace/run-coordinator.cjs               改（派生、subject 解析、静态门禁、adopt 绑定、nextAction）
  - desktop/agent-tools-ipc.cjs                               改（submit 委托门禁 + F1 返回体、新增 agent:adopt-attempt、
                                                                  attempt/export 级 checkId 先拒后跑、未知状态不归一成 FAIL）
  - desktop/main.cjs                                          改（direct 通道惰性接线 createDirectWorkspaceRuntime +
                                                                 把 workspaceRunCoordinator 注入 agent-tools IPC）
  - desktop/preload.cjs                                       改（workspaceAgent.adoptAttempt，仍 Object.freeze、旧 API 不变）
  - scripts/agent-checks/run-check.cjs                        改（去掉 source.check/composer.dry-run；新增 capabilities.check；
                                                                  wechat 位置参数根；状态原样透出，未知 → NOT_RUN）
  - test/agent-workspace.bundle.test.cjs                      新增（6 用例：枚举/派生/越界/删除/组件/资产/陈旧）
  - test/agent-workspace.vertical-chain.test.cjs              新增/扩展（t5 时 5 用例；t22 后 9 用例：无 UI 垂直闭环 + F2 先拒后跑
                                                                 + §14.12-Q2 身份 + 非 menu 页可提交 + 半成品门禁
                                                                 + F4/§14.13-1 陈旧 + F-T5-07 缺 exportTreeDigest
                                                                 + F-T5-01 IPC→真实 Coordinator + OBS-4 legacy 写入/cancel）
  - test/agent-workspace.direct-runtime.test.cjs              新增（5 用例：未接线/接线成功/缺凭据/请求有界/main.cjs 接线）
  - test/agent-workspace.checks.test.cjs                      重写（10 用例：主体表/别名/真实 attempt 树/缺根不回落/白名单/四态）
  - test/agent-workspace.coordinator.test.cjs                 改（陈旧证据 → AGENT_EVIDENCE_STALE + rerun-checks；main.cjs 接线断言）
  - test/agent-tools-ipc.test.cjs                             改（20 命令、submit 走门禁、adopt-attempt 委托、先拒后跑；
                                                                 t22：attemptId 断言改为字符串 `attempt-1`，堵住 F-T5-01 盲区）
  - test/desktop-contract.test.cjs                            改（19 → 20 个语义命令 + adoptAttempt）
  - docs/evidence/workspace-agent/e0-w2/report.md             新增（本文件）

行为变化：
  - 唯一执行所有者仍是 WorkspaceRunCoordinator；`agent:submit-candidate` / `agent:adopt-attempt` 只是**转调**，
    无 Coordinator 即 AGENT_RUNTIME_TOOL_MISSING（不静默降级）。
  - run_check 的 checkId→主体由平台固定表决定：source.check/composer.dry-run → attempt 候选树（进程内，不 spawn）；
    mini.check/output.consistency/wechat.verify → 本 attempt 的派生导出树；capabilities.check 独立承担仓库级语义。
    模型给 root/exportRoot/attempt/versionId → AGENT_PAYLOAD_INVALID；注册表缺 definitions → AGENT_CHECK_UNKNOWN 且不跑。
  - 派生（source-bundle.json）只发生在检查阶段：attempt/export 主体检查前幂等派生；**submit 不再派生**（F3）。
  - submit 门禁：source.check + composer.dry-run 必须 PASS/attempt/当前 treeDigest；dry-run 必须留下
    exportRelative + exportTreeDigest；mini/output/wechat 若跑过则绑定同一次导出树。
    证据陈旧 → AGENT_EVIDENCE_STALE + issue EVIDENCE_STALE_RERUN_CHECKS + nextAction "rerun-checks"；
    缺失/不满足 → AGENT_STATIC_GATE_FAILED；未跑运行时检查 → partial=true。
  - adopt：未提交 → AGENT_ADOPTION_FAILED + issue NOT_SUBMITTED；摘要陈旧 → AGENT_EVIDENCE_STALE（先于 partial）；
    partial 未显式确认 → AGENT_PARTIAL_CONFIRM_REQUIRED + nextAction "confirm-partial"。
  - 状态口径统一四态 PASS|FAIL|BLOCKED|NOT_RUN；工具不可用/不可解析 → BLOCKED，未知状态 → NOT_RUN（绝不归一成 FAIL 或 PASS）。

新增测试：test/agent-workspace.bundle.test.cjs（6）、test/agent-workspace.vertical-chain.test.cjs（t22 后 9）、
          test/agent-workspace.direct-runtime.test.cjs（5）、test/agent-workspace.checks.test.cjs（10）
执行命令与真实退出码：见 §1（3 条门禁全部 exit 0）
8 条等价门禁全部退出码 0
真实模型/微信/UIA/安装包证据：NOT_RUN（本任务为无 UI 的检查绑定与门禁，未跑真实模型/微信/UIA/安装包）
与计划的偏差：见 §5
剩余问题：见 §6（转 E1 的接线项 + 需要 E1 决定的 overlay 目录白名单）
下一任务是否可开始：YES（E0-W3/E0-R1 可在此交付之上继续；E1–E4 仍需 E0-V1 独立 PASS）
```

---

## 1. 门禁命令与真实退出码（rev15 §14.11 等价命令）

| # | 命令 | 结果 | 证据 |
|---|---|---|---|
| 1 | `node --test --experimental-test-isolation=none "test/agent-workspace*.test.cjs"` | **exit 0** | tests **99 / pass 99 / fail 0**（含 coordinator 15、checks 10、bundle 6、direct-runtime 5、vertical-chain **9**） |
| 2 | `node --test --experimental-test-isolation=none test/agent-tools-ipc.test.cjs test/desktop-contract.test.cjs test/composer-source-overlay.test.cjs` | **exit 0** | tests 51 / pass 51 / fail 0 |
| 3 | `node -e "require('./desktop/agent-workspace/run-coordinator.cjs');require('./desktop/agent-workspace/checks.cjs');require('./desktop/agent-workspace/source-bundle.cjs');require('./desktop/agent-workspace/direct-runtime.cjs');console.log('e0-w2 modules ok')"` | **exit 0** | stdout `e0-w2 modules ok` |

补充（仅本任务关注的细分，便于复核定位）：

| 命令 | 结果 |
|---|---|
| `node --test --experimental-test-isolation=none test/agent-workspace.coordinator.test.cjs` | **exit 0**：tests 15 / pass 15 |
| `node --test --experimental-test-isolation=none test/agent-workspace.checks.test.cjs` | **exit 0**：tests 10 / pass 10 |
| `node --test --experimental-test-isolation=none test/agent-workspace.bundle.test.cjs` | **exit 0**：tests 6 / pass 6 |
| `node --test --experimental-test-isolation=none test/agent-workspace.direct-runtime.test.cjs` | **exit 0**：tests 5 / pass 5 |
| `node --test --experimental-test-isolation=none test/agent-workspace.vertical-chain.test.cjs` | **exit 0**：tests **9 / pass 9** |

官方口径（§14.11 第二段）如实记录：

- `npm test`（`node --test test/*.test.cjs` 全量）：**本报告§1 未以它作为 E0-W2 门禁**；等价门禁见上表第 1/2 条。
- `npm run build` / `npm run desktop:dev`：**NOT_RUN**（本任务不触碰 renderer 与构建配置）。
- 真实模型（DeepSeek Flash）/ 微信开发者工具 / UIA 无障碍走查 / 安装包：**NOT_RUN**（属 verifier t8 与 E1–E4）。

---

## 2. 交付物与形状（照抄 rev15）

### 2.1 `desktop/agent-workspace/source-bundle.cjs`（新增，纯 CJS）

```js
SCHEMA_VERSION = 'frontend-source-bundle.v1'
BUNDLE_FILE = 'source-bundle.json'
PAGE_IDS = ['home','menu','checkout','orders','order-detail','product-detail','mine','merchant-orders']

loadComposerContext({ planPath?, refresh? }) => { plan, loaded, graph, base:{id,version}, baseSrc, baseTreeSha256, pageIds }
enumerateTargetPages({ files }) => [{ id, enabled, reasons:[...] }]   // enabled 由候选树派生，不是硬编码 true
isKnownTargetPage(id) => boolean
readTree(dir) => { ok, files:Map<rel,Buffer>, totalBytes }            // 拒符号链接 / >1MiB 单文件 / >4000 文件 / >64MiB
deriveBundle({ candidateFiles, targetPages, baseSrc, pageIds })
  => { ok, manifest, digest, fileCount, deletedCount, assetCount, componentCount }
bundleIsStale(candidateFiles, baseFiles) => boolean
renderBundle(manifest) => string                                      // 2 空格 + 结尾换行
composeAttempt({ root, parentDir, projectName, baseSrc }) => { ok, outputPath, treeSha256, fileCount, checks }
```

派生失败码（都映射到 `AGENT_STATIC_GATE_FAILED` + issue.code）：`SOURCE_BUNDLE_PATH_FORBIDDEN`（只允许
`pages/ components/ assets/`）、`SOURCE_BUNDLE_FILE_TYPE_FORBIDDEN`、`SOURCE_BUNDLE_DELETE_FORBIDDEN`（只允许删
`assets/**`，删页面文件即失败）、`SOURCE_BUNDLE_ASSET_TYPE_INVALID`（png/jpeg/webp 魔数）、
`SOURCE_BUNDLE_TARGET_PAGE_REQUIRED`。

### 2.2 `desktop/agent-workspace/checks.cjs`（改）—— checkId→主体固定表（X4）

| checkId | subject | 实现 | 说明 |
|---|---|---|---|
| `source.check` | **attempt** | 进程内 `scripts/frontend-source/check.cjs#checkProject` | 根 = 本 attempt 的 `candidate/`；与 `checkBase` 同参数（`facts`+`baseline`） |
| `composer.dry-run` | **attempt** | 进程内 `source-bundle.composeAttempt` | 先验 bundle，再导出到 `attempt/verification/dry-run/`，返回 `exportedRoot`+`exportTreeDigest` |
| `mini.check` | **export** | 进程内 `scripts/agent-checks/…`（mini runner） | 缺导出根 → `AGENT_CHECK_UNKNOWN`，**绝不回落仓库 `miniprogram/`** |
| `output.consistency` | **export** | 进程内 `inspectOutput` | 同上 |
| `wechat.verify` | **export** | dispatcher → `scripts/wechat-devtools-run.cjs`（位置参数根） | 工具不可用 → BLOCKED |
| `capabilities.check` | repo | dispatcher → `scripts/frontend-capabilities.cjs --check` | 旧 `source.check` 的仓库级语义独立保留（rev15 §14.4 原名） |
| `capabilities.source-facts` | repo | 同上（**合同别名**，同一实现） | t5 验收要求「旧语义保留为独立 checkId `capabilities.source-facts`」；别名与 canonical 等价，不改变 11 个 canonical 检查数量，也不冒名 `source.check` |
| `unit.targeted` / `unit.full` / `desktop.contract` / `catalog.check` / `registry.check` | repo | dispatcher | 目标文件白名单 + 无 shell |

`assertFixedMapping()` 在模块加载时自检：subject 只能是 `attempt|export|repo`、脚本文件必须真实存在、
wechat 必须走 dispatcher、进程内模块必须可解析。四态 `STATUSES=['PASS','FAIL','BLOCKED','NOT_RUN']`。

### 2.3 `desktop/agent-workspace/run-coordinator.cjs`（改）

新增/变更的对外行为：

```js
startRun / submitAttempt：targetPage 只认 sourceBundle.isKnownTargetPage（8 页枚举），
  并与 run.targetPage、enumerateTargetPages(...).enabled 交叉校验
invokeTool('run_check')：
  1) checkId → 注册表 definitions.subject（缺 definitions / 缺该 id → AGENT_CHECK_UNKNOWN，runner 调用 0 次）
  2) subject∈{attempt,export} → 平台幂等派生 source-bundle（模型永不调用派生）
  3) subject=export → root 只能取本 attempt 最近一次 composer.dry-run 证据（缺 → AGENT_CHECK_UNKNOWN）
  4) 证据落 attempt/verification/checks/<checkId>.json（含 treeDigest/subjectKind/attemptId/exportTreeDigest/exportRelative）
submitAttempt：静态门禁（不再派生）；成功返回
  { candidateId, revision, treeDigest, exportRelative, exportTreeDigest, targetPage, status:'submitted', partial }
adoptAttempt：NOT_SUBMITTED → AGENT_ADOPTION_FAILED；摘要陈旧（含**缺失/非字符串** exportTreeDigest，F-T5-02）
  → AGENT_EVIDENCE_STALE(+rerun-checks)；partial 未确认 → AGENT_PARTIAL_CONFIRM_REQUIRED(+confirm-partial)
```

### 2.4 `desktop/agent-workspace/direct-runtime.cjs`（新增，交付锁）+ 接线

```js
createDirectWorkspaceRuntime({ coordinator, credentials, transport? }) => { invoke, describe }
invoke({ context, request }) =>
  1) 上下文必须由平台给（projectId/runId/turnId/attemptId + subject.kind==='attempt' 且 attemptId 一致），否则 AGENT_PAYLOAD_INVALID
  2) coordinator 缺失 → AGENT_RUNTIME_TOOL_MISSING；transport 缺失（credential.chat 不可用）→ AGENT_RUNTIME_TOOL_MISSING
  3) request 有界校验（messages ≤24、单条 ≤20000 字、总 ≤60000、role 白名单、无绝对路径/base64/sk- 密钥）→ 不合法则**不发起**调用
  4) 成功只回 { content, finishReason, model, chars }；不合法/不可达如实失败；DEEPSEEK_NOT_CONFIGURED → AGENT_RUNTIME_TOOL_MISSING
```

`desktop/main.cjs` 接线（替代 `directRuntime: null`）：

```js
const workspaceRunCoordinator = createRunCoordinator({
  userDataDir,
  checks: createCheckRegistry({ userDataDir }),
  directRuntime: createDirectWorkspaceRuntime({
    coordinator: () => workspaceRunCoordinator,   // 惰性解析，避免单例顺序问题
    credentials: modelCredentials,                // 主进程唯一实例（safeStorage + ≤3 槽位调度）
  }),
  emitProgress: broadcastAgentProgress,
});
```

断言：`test/agent-workspace.direct-runtime.test.cjs` 证明「接线后 `invokeDirect` 返回成功且不是
`AGENT_RUNTIME_TOOL_MISSING`」「未接线/未配置凭据时该码仍显式」；`test/agent-workspace.coordinator.test.cjs`
静态断言 main.cjs 不再是 `directRuntime: null`、且 coordinator 用 getter、凭据用 `modelCredentials`。
原生写入仍只能经 coordinator 的 `write_files`（direct 结果不落盘）。

### 2.5 `desktop/agent-tools-ipc.cjs` / `desktop/main.cjs` / `desktop/preload.cjs`

- `agent:submit-candidate`：8 页枚举 + 转调 `coordinator.submitAttempt`；返回体按 F1 固定含
  `exportRelative`/`exportTreeDigest`；失败时透出 `nextAction`。
- `agent:adopt-attempt`（**新**）：keys `projectId,runId,turnId,attemptId,targetPage,partialConfirmed`，
  转调 `coordinator.adoptAttempt`，无 Coordinator → `AGENT_RUNTIME_TOOL_MISSING`。
- **t22 / F-T5-01**：submit/adopt 现在把 `attemptId: 'attempt-' + attempt.attempt` 交给 Coordinator
  （此前传数字 → 真实 Coordinator 恒 `AGENT_ATTEMPT_NOT_FOUND`）；补了 IPC→真实 Coordinator 端到端用例。
- **t22 / OBS-4**：legacy `agent:write-files` / `agent:delete-files` 在 Coordinator 已接线时**统一转调
  `coordinator.invokeTool`**（提交后 → `AGENT_ATTEMPT_IMMUTABLE`、零落盘）；`agent:cancel-run` 同样转调
  `coordinator.cancelRun`（run.json 落 `cancelled` / `cancelRequested`，提交后为 `too-late` 且不改盘）。
  无 Coordinator 的旧路径仅保留给 B3 legacy 测试，属**非产品链**（E1 前隔离）。
- `agent:run-check`：attempt/export 级 checkId **先拒后跑**（F2）；状态未知 → `NOT_RUN`（不归一成 FAIL）。
- `agent:get-context`：`targetPages` 由 `sourceBundle.enumerateTargetPages` 派生。**退化说明**：该命令当前
  不携带 attempt 上下文（无 runId/turnId/attemptId），`enumerateTargetPages({})` 会得到 8×`enabled:false`
  + 原因“候选树未提供”；它不是硬编码，但 UI 若直接用它画页面选择器会全部灰掉。E1 接线时应带 attempt 上下文，
  或明确页面选择器改由 coordinator 的 `get_context`（工具）供数据。本任务只如实登记该退化，不改 B3 命令面。
- `desktop/main.cjs`：把 `workspaceRunCoordinator` 注入 `registerAgentToolsIpc`。
- `desktop/preload.cjs`：`workspaceAgent.adoptAttempt(payload)`；仍 `Object.freeze`，旧 `smartStore` API 一个不少。

---

## 3. X4 / X5 / X6 / X7 逐条结论

### X4 checkId→subject 绑定 + 平台填 root：**已闭合**

- 绑定表唯一：`checks.CHECK_DEFINITIONS[*].subject`（`assertFixedMapping()` 自检），coordinator 只读表、不猜。
- 模型给路径即非法：`FORBIDDEN_CHECK_PARAM_KEYS = [root,exportRoot,exportParentDir,exportRelative,subject,subjectKind,command,env,cwd,shell,…]`
  → `AGENT_PAYLOAD_INVALID`。
- 缺根不回落：export 级检查缺 dry-run 证据 → `AGENT_CHECK_UNKNOWN`；`checks.cjs` 内不存在
  `path.join(REPO_ROOT,'miniprogram')` 之类的默认根（测试里做了源码级断言，且仓库镜像目录仍存在但永不被当作导出成果）。
- F2 先拒后跑：注册表缺 `definitions` / 缺该 checkId → `AGENT_CHECK_UNKNOWN`，**runner 调用次数 0**。

断言位置：`test/agent-workspace.checks.test.cjs`（主体表、缺根、白名单、源码级防线）、
`test/agent-workspace.vertical-chain.test.cjs`（步骤 7 + F2 用例：`calls.length === 0`）。

### X5 8 页枚举（SourceFacts 单一事实源）：**已闭合**

- `sourceBundle.PAGE_IDS` 与 `scripts/agent-source-facts.cjs#PAGE_IDS` 逐项相等（测试断言），顺序冻结。
- `enabled` 由候选树派生：缺 `pages/<id>/index.json|wxml` 或契约缺失 → `false` + `reasons`；
  候选树不可读 → 全 `false`（绝不 8 个 `true`）。
- v1 的 `home/menu` 常量未被复用；`startRun`/`submitAttempt`/IPC 三处都拒非枚举页
  （`settings` 被拒，`checkout` 通过 —— 反证 v1 常量已废弃）。

- page 枚举顺序采用 `scripts/agent-source-facts.cjs#PAGE_IDS` 的顺序（`home,menu,checkout,orders,order-detail,
  product-detail,mine,merchant-orders`），与 rev15 §14.5 文本列举顺序不同；这是“单一来源”的必然结果，
  顺序口径由 **rev16** 统一说明，E0 内不改冻结文本（t22 / F-T5-10-①）。

断言位置：`test/agent-workspace.bundle.test.cjs`（枚举用例）、`test/agent-workspace.vertical-chain.test.cjs`（步骤 1 + IPC 用例）。

### X6 source-bundle 平台派生、模型不可调用/不可写：**已闭合**

- `derive_source_bundle` 在 `PLATFORM_ONLY_TOOL_NAMES` → 模型调用即 `AGENT_TOOL_NOT_ALLOWED`。
- 平台在 attempt/export 主体检查前幂等派生；模型写进候选树的假清单会被平台派生结果覆盖（测试断言 `evil` 内容消失）。
- F3：`submitAttempt` **不再派生**（不碰候选树），提交前后 `source-bundle.json` 逐字节相同（测试断言）。
- 派生 fail-closed：改 `services/**` → `SOURCE_BUNDLE_PATH_FORBIDDEN`；删页面文件 → `SOURCE_BUNDLE_DELETE_FORBIDDEN`；
  假图 → `SOURCE_BUNDLE_ASSET_TYPE_INVALID`；`base.treeSha256` 必须等于真 Base 树摘要。

断言位置：`test/agent-workspace.bundle.test.cjs`（4 个派生用例）、`test/agent-workspace.vertical-chain.test.cjs`（步骤 2/4 + F3）。

### X7 证据四态 + 主体/导出树绑定：**已闭合**

- 状态四态统一；dispatcher 未知状态 → `NOT_RUN`（`CHECK_STATUS_UNKNOWN`），不可解析/工具不可用 → `BLOCKED`
  （`CHECK_TOOL_MISSING`）；IPC 层不再把未知状态折成 `FAIL`。
- 证据文件：`attempt/verification/checks/<checkId>.json`，字段
  `{checkId,status,durationMs,treeDigest,subjectKind,attemptId,at,issues,exportTreeDigest?,exportRelative?,evidenceRelative?}`；
  提交证据 `attempt/verification/submission.json`。
- 门禁把证据钉在「当前 attempt 的当前 revision/treeDigest + 同一次导出树」上：source.check/composer.dry-run 必须
  PASS/attempt/当前摘要；mini/output/wechat 的 `exportTreeDigest` 必须等于 dry-run 的。
  **t22 / F-T5-07（fail-closed）**：mini/output/wechat 的 PASS 证据若**缺少** `exportTreeDigest`（且 dry-run 已有导出摘要），
  记 `AGENT_EVIDENCE_STALE`（不再静默视为一致）。
- **t22 / F-T5-02（§14.13-1）**：`submission.exportTreeDigest` 缺失或非字符串一律按陈旧处理
  （`AGENT_EVIDENCE_STALE` + issue `EVIDENCE_STALE_RERUN_CHECKS` + `nextAction:"rerun-checks"`），不得跳过导出树校验。
- 错误码只取 §14.9 冻结清单；新增的 `EVIDENCE_STALE_RERUN_CHECKS` 是 **issue.code**，不是 envelope code（`AGENT_EVIDENCE_STALE` 是 envelope code）。
- 反过来：`attempt/verification/` 之外不产生任何检查产物；导出树只落在 `attempt/verification/dry-run/`。

断言位置：`test/agent-workspace.checks.test.cjs`（四态用例）、`test/agent-workspace.coordinator.test.cjs`（陈旧证据）、
`test/agent-workspace.vertical-chain.test.cjs`（证据字段 + 门禁 + adopt 绑定）。

### F1–F4（合同 rev2）

| 项 | 现状 | 断言 |
|---|---|---|
| F1 submit 返回体 | 固定含 `candidateId,revision,treeDigest,exportRelative,exportTreeDigest,targetPage,status:'submitted'`，`exportRelative` 为相对路径 | `vertical-chain` 步骤 8；`agent-tools-ipc.test.cjs` submit 分支 |
| F2 缺参先拒后跑 | `AGENT_CHECK_UNKNOWN`，runner 调用 0 次 | `vertical-chain`「F2」用例（`calls.length === 0`） |
| F3 submit 不派生 | 派生只在检查阶段；陈旧 → `AGENT_EVIDENCE_STALE` + issue `EVIDENCE_STALE_RERUN_CHECKS` + `nextAction:"rerun-checks"` | `coordinator.test.cjs` + `vertical-chain` 步骤 8/9（含提交前后清单逐字节相同） |
| F4 partial 前先判新鲜度 | adopt 先校验 `submission.treeDigest`/`exportTreeDigest`，再判 partial：未提交 → `AGENT_ADOPTION_FAILED`+`NOT_SUBMITTED`；已提交+摘要陈旧（含缺/非字符串）→ `AGENT_EVIDENCE_STALE`+`rerun-checks`；partial 未确认 → `AGENT_PARTIAL_CONFIRM_REQUIRED`+`confirm-partial` | `vertical-chain`：主用例 partial 分支 + 「F4 + §14.13-1 已提交+篡改/缺失摘要」用例（t22 新增，实际码断言）；另「F-T5-01 IPC 端到端」用例经 IPC 覆盖三分码 |

---

## 4. 无 UI 垂直闭环（真实 Composer，不 mock 业务）
`test/agent-workspace.vertical-chain.test.cjs` 主用例逐步断言：

1. `initProject` → 基线版本 v1；`startRun({targetPage:'menu'})`（非枚举页 4 个反例被拒）；
2. `get_context` → 8 页枚举、全部 `enabled:true`；
3. 模型调 `derive_source_bundle` → `AGENT_TOOL_NOT_ALLOWED`；
4. `read_file` → `write_files`（真实改写 `pages/menu/index.wxml`，落 `attempt/candidate/`）；
5. `run_check source.check` → PASS，平台派生 `source-bundle.json`（`targetPages:['menu']`、`base.treeSha256` 真值、假清单被覆盖）；
6. `run_check composer.dry-run` → PASS + `exportRelative:'verification/dry-run'` + `exportTreeDigest`，导出树里能读到本次改动；
7. `run_check mini.check` / `output.consistency` → PASS，证据 `exportTreeDigest` 与 dry-run 相同；
8. 模型给 `root/exportRoot/attempt/versionId` → `AGENT_PAYLOAD_INVALID`；
9. `submit_candidate` → 成功 + F1 六项 + `partial === true`（本机 `wechat.verify` BLOCKED/NOT_RUN；partial ≠ 通过）；
   未确认 partial → `AGENT_PARTIAL_CONFIRM_REQUIRED` + `nextAction:"confirm-partial"`；确认后 adopt 成功；
10. `adoptAttempt({partialConfirmed:true})` → 新版本 v2；`reopenProject.currentVersionId === v2`；
    **采用版本树摘要 === 候选树摘要**（逐字节同源）；`undoVersion`/`redoVersion`/`reopenProject` 回到 v2；
11. `agent:progress` 事件里有 `bundle` 与 `submit` stage，且不含仓库/userData 绝对路径。

第二条用例证明「半成品不能提交」：只有 source.check → `AGENT_STATIC_GATE_FAILED`（点名缺 composer.dry-run）；
导出树级检查在缺 dry-run 时 `AGENT_CHECK_UNKNOWN`；补跑后 → 再改一行 → `AGENT_EVIDENCE_STALE`+`rerun-checks`
（且 submit 未派生）→ 重跑齐 → 提交成功。

### 4.5 §14.12-Q2 身份一致性（可复验断言，单列）

`test/agent-workspace.vertical-chain.test.cjs` 的「projectId ↔ 私有根强一致」是**独立用例**（不与垂直链混跑）：

| 场景 | 期望 | 实测 |
|---|---|---|
| 伪造 projectId（该名下没有该 run） | 拒绝且不跨项目猜目录 | `AGENT_RUN_NOT_FOUND` |
| 把 run 目录复制到另一个合法 projectId 下，再按那个 projectId 调用 | `run.json.projectId` 与句柄不一致 → 拒绝 | `AGENT_PROJECT_MISMATCH`，且伪造副本零字节变化 |
| runId 不存在/非法 | run 级拒绝 | `AGENT_RUN_NOT_FOUND` |
| 伪造 turnId / attemptId | turn/attempt 级拒绝 | `AGENT_ATTEMPT_NOT_FOUND`（§14.13-5 码表解释） |
| 全部被拒请求之后 | 候选树逐字节不变 | 前后 `treeDigest` 相等，页面文本无 `hijack` |

---

## 5. 与计划的偏差（全部为有意的收紧，不是降级）

1. **dry-run 计划固定用 Base recipe**（`templates/recipes/order-classic/1.0.0/plan.json`）：用户店铺 plan 的接线属
   E1/E3（需要 appId/门店事实）。当前只验证「候选 overlay + Base 能导出可校验的小程序」。
2. **空 overlay 显式失败**：候选与 Base 无差异时不再让 loader 抛 `SOURCE_BUNDLE_MANIFEST_INVALID`，
   而是 FAIL + issue `SOURCE_BUNDLE_NO_CHANGES`（更可读、同一 envelope 口径）。
3. **`capabilities.check` 独立成仓库级 checkId**：否则 `source.check` 一旦绑定 attempt，旧仓库级语义就无处安放
   （rev15 §14.4 的 explicitly 要求）。
4. **`appId` 不转发给 wechat runner**：`scripts/wechat-devtools-run.cjs` 当前签名不接收 appId，
   本任务只做主体绑定，不改 runner 契约（E1 再接）。
5. **`verify_wechat` 在本机恒为 BLOCKED/NOT_RUN → partial**：因此垂直链必须显式 `partialConfirmed:true` 才能 adopt，
   这是诚实的 partial，不是“验收通过”。
6. **`EVIDENCE_STALE_RERUN_CHECKS` 走 issue.code**（envelope code 仍是冻结的 `AGENT_EVIDENCE_STALE`），
   避免私增 envelope 码。

---

## 6. 剩余问题 / 转 E1 的接线项

1. **overlay 目录白名单**：派生只允许 `pages/ components/ assets/`，因此 agent 写 `services/**`、`app.js` 会
   fail-closed（`SOURCE_BUNDLE_PATH_FORBIDDEN`）。E1 若要支持非页面代码改动，需要 Composer overlay 契约扩展
   （`scripts/composer/source-overlay.cjs`，本任务范围外）。
2. **用户店铺 plan / appId 接线**：见 §5-1、§5-4。
3. **真实模型链（Flash）+ 真实微信验证**：属 verifier t8 与 E2/E3；本报告全部为无 UI、无真实模型的等价门禁。
4. **`projectId ↔ 私有根` 一致性断言**：已按 §14.12-Q2 单列成独立用例（见 §4.5），
   三条码（`AGENT_PROJECT_MISMATCH` / `AGENT_RUN_NOT_FOUND` / `AGENT_ATTEMPT_NOT_FOUND`）+ 零落盘都可在
   `test/agent-workspace.vertical-chain.test.cjs` 里复跑；仍建议 verifier A21 用**自己的**伪造手法独立复核一遍。
5. **`capabilities.source-facts` 别名**：t5 验收文本要求该 id，rev15 §14.4 原文是 `capabilities.check`；
   实现上以 `capabilities.check` 为 canonical、`capabilities.source-facts` 为等价别名（同一实现、同一 subject=repo），
   两者都不会冒名 `source.check`。若 E0-R1 的契约要求只保留一个名字，删别名是一行改动。
6. **direct 通道的真实模型话术**：本任务只交付惰性装配与有界请求/返回契约（transport 默认接
   `credential.chat`），真实 Flash 往返与工具循环仍归 E0-R1/t8 验收；本报告的 direct 用例全部使用注入替身，不联网。

---

## 7. 本任务最终文件摘要（供 t8 复跑锚定）

```text
desktop/agent-workspace/run-coordinator.cjs   sha256=ae670806da313f95c06e8e5b279ec2e5a6193892099fd514cd816def30f8451a  bytes=89072
desktop/agent-workspace/checks.cjs            sha256=7974b039fdde645524b83df6d6df3d09103855fbee537babf10dd11c67544a0c  bytes=31313
desktop/agent-workspace/source-bundle.cjs     sha256=20386ef2b130cfac2d68eb79ba63bca30987cc860f9e466a5852091764858502  bytes=20729
desktop/agent-workspace/direct-runtime.cjs    sha256=2b8fab79107f1e7162db810d0e8e3343e7f2ced64ecfa92f3cb34d6cb387b636  bytes=9653
desktop/agent-tools-ipc.cjs                   sha256=9fbee683b117dd0b7bdd3ee9b11257b43e126bbfd6c9bffda496ec44369fe177  bytes=75472
scripts/agent-checks/run-check.cjs            sha256=3e2eb923d9b2fca70429974f44beb0180ad390bb507baa3872c00808cfb59866  bytes=13425
desktop/preload.cjs                           sha256=4146d71c14fa0cc3f4719f881ef7b58e3b020005a695addb084c098d8aab0de4  bytes=9042
desktop/main.cjs                              sha256=481870ef515d6586b322613abf13f0f58f06e4aaf72778b7cf5ea59efb0c3d27  bytes=20915
```

> 上表是 **t22 修复后**的最终字节（2026-11-25 15:0x 复算）。t15 复核时钉的 t5 交付字节
> （run-coordinator 88,235 B / agent-tools-ipc 70,939 B / source-bundle 20,567 B）已被本修复轮改写；
> t8/verifier2 请以本节为准重新复算。t1 版 `run-coordinator.cjs`（85,904 B）早已被 t5 取代。

---

## 7.5 验收 14（direct 接线）与验收 13（身份一致性）的对照

| 验收项 | 证据 |
|---|---|
| main.cjs 把 `directRuntime: null` 改为惰性 `createDirectWorkspaceRuntime({ coordinator: () => workspaceRunCoordinator, credentials: modelCredentials })` | `desktop/main.cjs` §2.4 片段 + `test/agent-workspace.coordinator.test.cjs` 静态断言（不再有 `directRuntime: null`） |
| 接线后 `invokeDirect` 不再返回 `AGENT_RUNTIME_TOOL_MISSING` | `test/agent-workspace.direct-runtime.test.cjs`「接线后 invokeDirect 正常返回」：注入替身传输后 `result.ok===true` 且 `code!=='AGENT_RUNTIME_TOOL_MISSING'` |
| 未接线时该码仍显式（不静默） | 同文件「未接线 → AGENT_RUNTIME_TOOL_MISSING」「未配置凭据 → 仍显式 RUNTIME_TOOL_MISSING」 |
| 身份一致性单列为可复验断言 | §4.5 + `vertical-chain` 独立用例（`AGENT_PROJECT_MISMATCH` / `AGENT_RUN_NOT_FOUND` / `AGENT_ATTEMPT_NOT_FOUND` 三条 + 零落盘） |
| t22 / F-T5-01 IPC attempt 标识 | `agent:submit-candidate`/`agent:adopt-attempt` 以 `'attempt-' + n` 转调；`vertical-chain`「IPC → 真实 Coordinator 端到端」用例覆盖 F1 六项 + 三分码；`agent-tools-ipc.test.cjs` 的 stub 断言也改为字符串 |
| t22 / OBS-4 legacy 写入与 cancel | `vertical-chain`「legacy 写入不得绕过 submitted 只读；cancel-run 必须落盘 run.json」用例：提交后 `agent:write-files`/`agent:delete-files` → `AGENT_ATTEMPT_IMMUTABLE` 且候选树 treeDigest 不变；取消未提交 run → `run.json.state=cancelled`；提交后取消 → `too-late` 且 run.json 仍 `submitted` |

---

## 8. verifier 复跑指引（不含任何“自证通过”）

```powershell
node --test --experimental-test-isolation=none "test/agent-workspace*.test.cjs"        # 期望 exit 0 / 99 pass
node --test --experimental-test-isolation=none test/agent-tools-ipc.test.cjs test/desktop-contract.test.cjs test/composer-source-overlay.test.cjs   # 期望 exit 0 / 51 pass
node -e "require('./desktop/agent-workspace/run-coordinator.cjs');require('./desktop/agent-workspace/checks.cjs');require('./desktop/agent-workspace/source-bundle.cjs');require('./desktop/agent-workspace/direct-runtime.cjs');console.log('e0-w2 modules ok')"
```

> 计数说明：t15 复核时是 95 pass / 51 pass；t22 新增 4 条垂直链用例（F4/§14.13-1、F-T5-07、F-T5-01 IPC e2e、OBS-4）
> 后为 **99 pass / 51 pass**。第 1 条命令的 glob 不包含 `agent-tools-ipc.test.cjs`（它在第 2 条命令里）。

重点抽查（不做等价替代）：

1. F2：把注册表换成没有 `definitions` 的替身，`run_check` 必须 `AGENT_CHECK_UNKNOWN` 且 runner 0 次；
2. F3：检查全绿后**再写一行**，`submit_candidate` 必须 `AGENT_EVIDENCE_STALE` + `nextAction:"rerun-checks"`，
   且候选树 `source-bundle.json` 提交前后逐字节相同；
3. X4：`run_check mini.check` 在缺 dry-run 证据时 `AGENT_CHECK_UNKNOWN`，且仓库 `miniprogram/` 未被读取（可断点/审计）。
4. X5：`agent:get-context` 的 `targetPages` 必须来自 SourceFacts，改掉任一页 `index.wxml` 后该页 `enabled:false`。

---

## 9. t22 修复记录（F-T5-01…10 + Captain 追加 OBS-4）

> 修复轮：`t22 / repair-round-2`（workspace-lead2，attempt 2）。修复对象是 t15（Review-t5）的 findings；
> 未修改 `docs/handoff/**`、`src/**`、`server/**`、`templates/**`、`miniprogram/**`、`contracts/**`、`package.json`。

| ID | 严重度 | 修复 | 回归断言 |
|---|---|---|---|
| F-T5-01 | blocker | `desktop/agent-tools-ipc.cjs` submit/adopt 改传 `'attempt-' + attempt.attempt`（Coordinator 只收字符串）；`test/agent-tools-ipc.test.cjs` 的 stub 断言同步改为字符串 | `vertical-chain`「IPC → 真实 Coordinator 端到端」：写→source.check→composer.dry-run→IPC submit 成功含 F1 六项→IPC adopt 未提交/陈旧/partial 三分码 |
| F-T5-02 | medium | `run-coordinator.cjs#adoptAttempt`：`submission.exportTreeDigest` 缺失/非字符串 → `AGENT_EVIDENCE_STALE`（不再跳过导出树校验） | `vertical-chain`「F4 + §14.13-1」子用例 (b)(c)：缺/非字符串 digest 均 stale + `EVIDENCE_STALE_RERUN_CHECKS` |
| F-T5-03 | medium | 新增「已提交 + 篡改 treeDigest + 未 partialConfirmed → `AGENT_EVIDENCE_STALE`」用例；报告 §3/F4、§7.5 按实际码改写（不再写“陈旧场景返回 AGENT_ADOPTION_FAILED/AGENT_EVIDENCE_STALE”的模糊口径） | 同用例 (a)：断言 `code==='AGENT_EVIDENCE_STALE'`、`nextAction==='rerun-checks'`，且明确 `!=='AGENT_PARTIAL_CONFIRM_REQUIRED'` |
| F-T5-04 | low | `vertical-chain` progress 断言删除 `|| typeof event.stage === 'string'`，改为白名单常量 `PROGRESS_STAGE_WHITELIST`（rev15 §9.1+§14.9）并断言 `PROGRESS_STAGES` 与之一致 | 主用例步骤 11 |
| F-T5-05 | low | 断言 `submitted.partial === true`（备注 `wechat.verify` BLOCKED/NOT_RUN）；删除 `if (submission.partial) … else …` 与重试 adopt | 主用例步骤 8/9 |
| F-T5-06 | low | `test/agent-workspace.checks.test.cjs` 断言 `args.slice(0,3) === [checksMod.dispatcherPath, '--check', 'capabilities.check']`（不再自比较） | checks 别名用例 |
| F-T5-07 | low | `run-coordinator.cjs#evaluateStaticGate`：PASS 证据缺 `exportTreeDigest` 且 dry-run 有导出摘要 → 记 stale（fail-closed） | `vertical-chain`「F-T5-07」：删掉 mini.check 的 exportTreeDigest 后 submit → `AGENT_EVIDENCE_STALE` |
| F-T5-08 | low | 报告 §2.5 如实登记 `agent:get-context` 无 attempt 上下文 → `targetPages` 8×false 的退化，及 E1 的两种接线方式 | 文档（不改 B3 命令面） |
| F-T5-09 | low | 报告 §8 计数改为实际 **99 pass / 51 pass**，模块加载命令与 §1 对齐（4 个 `.cjs`） | 本节 + §8 |
| F-T5-10 | info | `source-bundle.cjs` 注释与实现对齐（只查 index.json/index.wxml，不称“四件套”；index.js/wxss 由 source.check 负责）；8 页顺序口径注明由 rev16 统一 | 文档 + 主用例步骤 1 |
| **OBS-4** | medium | legacy `agent:write-files`/`agent:delete-files` 在 Coordinator 注入时统一转调 `coordinator.invokeTool`（提交后 `AGENT_ATTEMPT_IMMUTABLE`、零落盘）；`agent:cancel-run` 转调 `coordinator.cancelRun`（run.json 落 `cancelled`/`cancelRequested`；提交后 `too-late` 且不改盘）。无 Coordinator 的旧路径仅留给 legacy 测试，报告注明非产品链 | `vertical-chain`「OBS-4」：提交后 write/delete 被拒且候选树 treeDigest 不变；未提交 run cancel → `run.json.state==='cancelled'`；提交后 cancel → `too-late` 且 run.json 仍 `submitted` |

修复后的真实门禁（2026-11-25，本机）：

| # | 命令 | 退出码 | 结果 |
|---|---|---|---|
| 1 | `node --test --experimental-test-isolation=none "test/agent-workspace*.test.cjs"` | **0** | tests 99 / pass 99 / fail 0 / skipped 0（vertical-chain 9） |
| 2 | `node --test --experimental-test-isolation=none test/agent-tools-ipc.test.cjs test/desktop-contract.test.cjs test/composer-source-overlay.test.cjs` | **0** | tests 51 / pass 51 / fail 0 |
| 3 | `node -e "require 4 个 agent-workspace 模块"` | **0** | stdout `e0-w2 modules ok` |

修复后的最终字节见 §7（已复算）。仍未做/不背书：真实 DeepSeek Flash 工具循环（t8/E0-V1）、真实微信开发者工具/UIA/安装包
（NOT_RUN）、E1–E4 接线；X4/X5/X6 的结论沿用 §3，X7 的 IPC 阻断项已由 F-T5-01 修复、其余证据绑定按 §3/§9 复验。
