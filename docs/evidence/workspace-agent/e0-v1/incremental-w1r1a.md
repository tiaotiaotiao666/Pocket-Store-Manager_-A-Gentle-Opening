# E0-V1a 增量验证 W1-R1a：t1 Coordinator / t2 调度器的独立执行断言

- 任务：**t10 / E0-V1a**（独立验证器 verifier，attempt 2）
- 本文件性质：**增量片段**，不是 E0 终局 verdict；终局由 t8（E0-V1）出具
- 生成时间：2026-11-25 01:05（+08）
- 判定范围：X1 / X3 / X12（**桌面侧**）+ 顺带记录的 X4 / X6 / X7 桌面侧事实
- 纪律：只调用冻结模块公开导出（`createRunCoordinator` / `createModelCallScheduler` / `checks`），不复制实现；
  不改产品代码、不改 `docs/handoff/**`、不改 `test/**`；临时 userData 自建自清；仓库数据目录零写入由 G01 守卫

## 0. 先把验证对象的指纹钉死（t1 在 2026-11-25 凌晨仍在并发改这份文件）

| 被测文件 | 版本标记 | SHA-256（前 16 位） | 大小 | mtime |
| --- | --- | --- | --- | --- |
| `desktop/agent-workspace/run-coordinator.cjs` | rev15 §14.2（owner t1/t5） | `232F24F2A35920CB` | 85 904 B | 2026-11-25 00:52:30 |
| `desktop/model-call-scheduler.cjs` | rev15 §14.6（owner t2） | `C1CBF5E1C38DC3AA` | — | 2026-11-25 00:0x |
| `desktop/agent-workspace/checks.cjs` | rev10 §3.8 + §14.4 改造中（owner t5） | `0FFECDBBF68F5E76` | — | 2026-11-25 00:5x |

运行前后都取一次 `run-coordinator.cjs` 的摘要，两次一致（`stable=True`），因此下表所有 C 组结论**只对上面这个摘要成立**。
⚠️ 验证过程中实际观测到：00:39 那版（无导出树绑定）与 00:52 那版（引入 `exportTreeDigest`/`exportedRoot` 绑定）行为不同，
**同一批用例在旧版 PASS、新版 FAIL（随后按新语义修正用例再 PASS）**。任何后续改动都必须重跑本套件，不能引用本文件的历史结论。

## 1. 执行命令与真实退出码（本机 PowerShell，未走 `npm test`）

| # | 命令 | 退出码 | 结果摘要 |
| --- | --- | --- | --- |
| 1 | `node scripts/e0-verify/run.cjs --mode offline` | **0** | 104 用例：PASS 42 / FAIL 0 / NOT_RUN 62 / BLOCKED 0；`e0Verdict=NOT_RUN`（准备阶段固定不判 PASS）；耗时 113 s；报告落 `docs/evidence/workspace-agent/e0-v1/run-report.json` |
| 2 | `node --test --experimental-test-isolation=none test/model-call-scheduler.test.cjs "test/agent-workspace*.test.cjs"` | **0** | `tests 105 / pass 105 / fail 0 / cancelled 0 / skipped 0`，耗时 201 s（含 t2 的“两个独立 node 进程各 2 次请求，上游实际并发 ≤3”实测 1.49 s） |

说明：官方 `npm test` / `npm run build` 在本沙箱下 `spawn EPERM`（BLOCKED，非产品失败），故用等价的 `node --test` 直跑并如实记录退出码。

## 2. X 判定（桌面侧）

| X | 判据（rev15） | 本轮判定 | 证据 |
| --- | --- | --- | --- |
| **X1** Coordinator 是唯一执行所有者 | §14.2 不变量 1/2/3/4 | **桌面侧：已关闭**（整体仍未关闭） | C01（startRun 从 `currentVersionId` 复制 attempt 树、`frun-…`/`turn-1`/`attempt-1`、`baseTreeDigest=versions/v1`、`revision=1`）、C02（无版本/未知项目 → `AGENT_VERSION_NOT_FOUND` + 零建目录 + 不回落 Base）、C04（写事务 revision+1、摘要重算）、C13（getRun/getAttemptState 同源）、C14（入参校验）、C16（真实链路闭环） |
| **X3** 句柄/主体/取消语义 | §14.2 不变量 5/6、§14.3 | **桌面侧：已关闭**（整体仍未关闭） | C03（写入拒绝 version subject；`read_file` 版本覆盖只读）、C05（模型工具表 11 个；3 个平台专用名 + 未知名 → `AGENT_TOOL_NOT_ALLOWED`）、C10（跨项目 `AGENT_RUN_NOT_FOUND`、伪造 attempt/跨 turn `AGENT_ATTEMPT_NOT_FOUND`、磁盘 projectId 篡改 `AGENT_PROJECT_MISMATCH`，两个项目 `runs/` 指纹不变）、C11（取消 `requested`→迟到结果 `AGENT_CANCELLED` 且零落盘、取消后不再调注册表/direct）、C15（注册表漂移 fail-closed 不抛异常） |
| **X12** 上游并发 ≤3（桌面侧） | §14.6 | **桌面侧：已关闭**（整体仍未关闭） | S01–S06（5 并发→active 3/queued 2；排队超时 `MODEL_QUEUE_TIMEOUT`；取消 `MODEL_ABORTED` 不泄漏槽位；两进程峰值 3；`configure(4)` clamp 3 + 非法值 `MODEL_CONFIG_INVALID`；FIFO 无插队）+ 命令 2 的 105 项全绿 |
| X4 检查对象=attempt | §14.4/§14.5 | **桌面侧：部分关闭，未关闭** | C07（证据主体降级即被门禁拒）、C16（真实 `source.check`/`composer.dry-run` 双 PASS 且 `subjectKind=attempt`）、C17（陈旧证据被拒）；`mini.check.scoped=false` 仍待 t5 |
| X6 source-bundle 平台派生 | §14.5 | **桌面侧：已关闭（作为门禁前置）** | C16 实测派生后 `treeDigest` 变化、`bundleDerivedAtSubmit` 语义可用；C17 显示“检查后再写”会被自动补派破坏证据 |
| X7 submit/adopt 证据绑定 | §14.5/§14.12-1 | **桌面侧：已关闭**（IPC 层未关闭） | C06/C08/C09/C16/C17；`agent:adopt-attempt` IPC 尚未实现 → A01–A09 仍 NOT_RUN |

**“未关闭”的准确含义**（避免被误读成缺陷）：缺的是本任务范围外的接线与真实模型证据 —— t5（IPC 挂载、`agent:adopt-attempt`、mini.check scoped）、
t6（direct 通道、截断语义）、t7（图片资产/多模态）、t8（真实 Flash）。这些在 run-report 中全部保持 NOT_RUN，**本文件不为其背书**。

## 3. C 组：Coordinator 执行断言（16 条，全 PASS）

| ID | 断言（简） | 结果 | 关键实测值 |
| --- | --- | --- | --- |
| C01 | startRun 从 `currentVersionId` 复制 attempt 树并返回冻结字段 | PASS | `runId=frun-…`、`baseVersionId=v1`、`revision=1`、候选树重算摘要 = `versions/v1` 摘要 `sha256:cf6cb495…`；版本目录指纹不变 |
| C02 | 无版本/未知项目 → `AGENT_VERSION_NOT_FOUND`，零建目录 | PASS | `missingVersionCode/unknownProjectCode` 均为 `AGENT_VERSION_NOT_FOUND`；`runs/` 指纹不变；当前版本仍 v1 |
| C03 | subject 固定 attempt；写入拒绝 version subject；版本覆盖只读 | PASS | 两次写入均 `AGENT_PAYLOAD_INVALID`；`read_file(version)` 读到版本文件原文；版本目录指纹不变 |
| C04 | 写只落 attempt、revision+1、摘要与磁盘一致、版本零写入 | PASS | `1 → 2`；`sha256:cf6cb495… → sha256:ff8a1e95…`；平台重算摘要 = attempt 记录摘要 |
| C05 | 工具面 11 vs 平台专用 3；未知名拒绝 | PASS | `modelToolCount=11`；`derive_source_bundle`/`adopt_attempt`/`attach_image_asset`/`shell`/`write_file`/`child_process` 全 `AGENT_TOOL_NOT_ALLOWED` |
| C06 | 完全无证据 submit → `AGENT_STATIC_GATE_FAILED`，状态不变 | PASS | 提示“缺少 source.check（未执行）、composer.dry-run（未执行）”；`status=open`、`runState=running` |
| C07 | `checkId→subject` 由平台表决定；主体降级的 PASS 不能放行 | PASS | 注册表收到 `root=<attempt>/candidate`、`subject={kind:attempt}`、`subjectKind=attempt`、`exportParentDir`；证据降级 `version` 后 submit 报“证据主体不是 attempt” |
| C08 | attempt 主体证据 → `submitted`+`partial`；提交后只读、重复提交、取消 too-late | PASS | `partial=true`；随后写 `AGENT_ATTEMPT_IMMUTABLE`；再提交 `AGENT_RUN_ALREADY_SUBMITTED`；`cancel.state=too-late`、`cancelled=false` |
| C09 | adopt 三分码实测且不互相顶替 | PASS | ①`AGENT_ADOPTION_FAILED` + `issues=[NOT_SUBMITTED]`（且不生成新版本）；②摘要被改写 → `AGENT_EVIDENCE_STALE`；③partial 未确认 → `AGENT_PARTIAL_CONFIRM_REQUIRED`，确认后 `adoptedVersionId=v2`、`previous=v1`、`currentVersionId=v2` |
| C10 | 伪造/跨项目/跨 run/跨 turn 句柄在 Coordinator 层被拒且零落盘 | PASS | `AGENT_RUN_NOT_FOUND`（跨项目、跨 run）、`AGENT_ATTEMPT_NOT_FOUND`（伪造 attemptId、跨 turn）、`AGENT_PROJECT_MISMATCH`（磁盘 projectId 篡改，即 §14.12-2 判据）；两项目 `runs/` 指纹不变。⚠️ 码表口径差异见 F6 |
| C11 | 取消三态 + 迟到调用零落盘 + 取消后不再发上游 | PASS | 在途取消 `requested` → 迟到 `run_check` 结果 `AGENT_CANCELLED` 且 `verification/checks/` 文件数 0；取消后 `run_check`/`invokeDirect` 均 `AGENT_CANCELLED`，注册表计数不增、direct 调用 0；无在途 `cancelled`、重复取消幂等 |
| C12 | progress 事件 stage/status 白名单 + 脱敏 | PASS | 4 条事件，stage ∈ {workspace, write, bundle, validate}，无盘符路径/`data:image`/长 base64/私有根 |
| C13 | getRun / getAttemptState 与磁盘事实一致 | PASS | 初始 `open`/`revision=1`；submit 后 `runState=submitted`、`attemptStatus=submitted` |
| C14 | startRun 入参校验（含 imageAssetIds 只接受 assetId） | PASS | `AGENT_TARGET_PAGE_UNSUPPORTED` / `AGENT_PAYLOAD_INVALID` ×5（operation、utterance、路径、dataURL、>4 项）；`runs/` 零建 |
| C15 | 注册表漂移（无 `definitions`）必须 fail-closed 且不抛异常 | PASS | run_check 与 submit 均未抛异常；不注入 `root`（回落 `repo` 主体）→ submit `AGENT_STATIC_GATE_FAILED` |
| C16 | **真实检查链（零替身）**：写改→派生→双检查 PASS→submit(partial)→adopt v2 | PASS | `source.check PASS/attempt`；`composer.dry-run PASS/attempt`、`exportRelative=verification/dry-run`、`exportTreeDigest=sha256:8c16c59e…`；submit `submitted/partial=true`；adopt 未确认被拒、确认后 `v2`，v1 源目录字节不变 |
| C17 | 检查后再写：submit 补派 bundle 使旧证据失效 → 必须拒 | PASS | 摘要 `9965cad2…` → 写入后 `346cdc53…` → submit `AGENT_STATIC_GATE_FAILED`（“证据 treeDigest 与当前候选不一致”）；attempt 仍 `open`，无 submission 证据 |

## 4. S 组：t2 调度器独立复验（6 条，全 PASS）

| ID | 断言（简） | 结果 | 关键实测值 |
| --- | --- | --- | --- |
| S01 | 5 个并发 → 同时在跑 3、排队 2，全部完成 | PASS | `peakActive=3`、`maxQueueLength=2`、`totalAcquired=5`、结束 `active=queued=0` |
| S02 | 排队超时 → `MODEL_QUEUE_TIMEOUT`（虚拟时钟推进 30 s） | PASS | `code=MODEL_QUEUE_TIMEOUT`、`totalTimedOut=1`；占槽的 3 个任务不受影响并正常完成 |
| S03 | 取消排队任务 → `MODEL_ABORTED`，槽位不泄漏 | PASS | 两个取消均 `MODEL_ABORTED`；随后新任务立刻执行；`active=0`、`queued=0` |
| S04 | 两子进程各 2 任务共享令牌池 → 全局峰值 ≤3 | PASS | `peakGlobalConcurrency=3`、`tasksA=tasksB=2`、`degraded=false`（非降级路径） |
| S05 | 并发上限只接受 1–3；非法值报错；旧 env 名不生效 | PASS | `configure(4)` → 3 且有 warning；`configure(0)` → `MODEL_CONFIG_INVALID`；`MODEL_MAX_CONCURRENT=9` → 3；`AGENT_MAX_CONCURRENT=1` 被忽略（仍 3） |
| S06 | 排队 FIFO，无插队 | PASS | 出队顺序 `q0,q1,q2`；`totalAcquired=6` |

## 5. Findings（交 Captain 派修；我不改产品代码）

| ID | 严重度 | 位置 | 问题 | 建议修复 | 建议 owner |
| --- | --- | --- | --- | --- | --- |
| **F1** | medium | `desktop/agent-workspace/run-coordinator.cjs#submitAttempt`（返回体） | submit 成功后返回体只有 `candidateId/revision/treeDigest/targetPage/status/partial/subject`，**没有** `exportRelative`/`exportTreeDigest`；这两个绑定信息只落在 `verification/submission.json`。C16 实测：IPC/UI 想显示“本次提交绑定的是哪棵导出树”必须二次读盘 | 在返回体补 `exportRelative`/`exportTreeDigest`（与 submission 证据同值），或明确在 §14.5 写明“由 read_verification 读取”，二者择一，避免 t5 接线时各写一套 | t1（+t5 接线复核） |
| **F2** | medium | `run-coordinator.cjs#toolRunCheck`（subject 解析） | 注入的注册表若没有 `definitions`，`subject` **静默回落到 `repo`**：不注入 `root`、仍会真的拉起一次检查并写证据，最后被门禁拒。C15 实测 `rootInjectedWhenNoDefinitions=false`，无 warning、无专门码。行为是 fail-closed，但“跑了一次无意义的检查 + 错误信息与真实原因无关”，排障成本高 | 缺 `definitions` 时直接 `AGENT_CHECK_UNKNOWN`（或 `AGENT_RUNTIME_TOOL_MISSING`）并 warn，不要静默按 repo 跑 | t1（t5 复核注册表注入面） |
| **F3** | medium | `run-coordinator.cjs#submitAttempt`（自动补派 bundle）+ `evaluateStaticGate` | C17 实测常见顺序“写 → 检查 → 再写 → submit”会失败：submit 内部重新派 bundle 改变了 `treeDigest`，先前的 `source.check`/`composer.dry-run` 证据随即“陈旧”，门禁只回“证据 treeDigest 与当前候选不一致”。fail-closed 正确，但**没有告诉调用方“请重跑检查”**，也没有可区分的码 | `derived.changed === true` 且已有证据时返回专门码（如 `AGENT_CHECK_STALE` / `AGENT_EVIDENCE_STALE`）+ 明确“重跑 source.check 与 composer.dry-run 后再提交”；或派生后自动重跑这两项（需 t5 同意职责边界） | t1（会同 t5/t6 定顺序契约） |
| **F4** | low | `run-coordinator.cjs#evaluateStaticGate`（`partial` 判定） | `partial` 只看 mini/output/wechat 三项**缺失/BLOCKED/NOT_RUN**，不看它们是否**陈旧**（例如导出树变了但 wechat 证据是上一棵树的）：目前靠 `exportTreeDigest` 不一致升级为 failed，方向正确；但若某项 PASS 而 `exportTreeDigest` 缺失（旧证据）则静默视为一致 | `entry.exportTreeDigest` 缺失且 `dryRunExportDigest` 存在时按“陈旧”处理（fail-closed），并补一条断言用例 | t5 |
| **F5** | low | `scripts/e0-verify/**`（验证器自身） | 旧版用例把 `checks` 替身的 `definitions` 省掉了，导致 00:41 那轮 4 条 FAIL 实为**用例缺陷**（不是产品缺陷）；已改为“definitions 取真实 `checks.cjs`，只替身 `runCheck`” | 已在本次提交修正；后续新增用例一律禁止自造 `checkId→subject` 表 | verifier（已完成） |
| **F6** | low | `run-coordinator.cjs#resolveAttempt`（跨项目分支） | §14.2-5 原文把“跨项目/跨 run/跨 turn 的句柄”归到 `AGENT_PROJECT_MISMATCH` / `AGENT_ATTEMPT_NOT_FOUND` 两码；实测**跨项目/跨 run 走的是 `AGENT_RUN_NOT_FOUND`**（先查不到 run 就返回），`AGENT_PROJECT_MISMATCH` 只在“attempt.json 的 projectId 被篡改”时触发。行为 fail-closed、不泄漏信息，但与原文码表不完全一致 | 二选一：① 在 §14.2-5 补一句“run 层查不到时返回 `AGENT_RUN_NOT_FOUND`”；② 跨项目时先比对 projectId 再决定码。建议①（改文档，成本低） | t1 + Captain（文档口径） |

**没有发现的缺陷**（明确记录，避免重复排查）：句柄拒绝、零落盘、取消三态、adopt 三分码、调度器并发/超时/取消/跨进程上限，
在钉住的摘要上均按 rev15 语义成立。

## 6. 对 t5 / t6 的风险提示（按优先级）

1. **t5（E0-W2）**：`mini.check.scoped=false` 仍是 X4 的缺口（readiness X4 事实）；C16 证明“导出树绑定”机制可用，但 `mini.check/output.consistency/wechat.verify`
   必须是 scoped + 只查 `verification/dry-run` 这棵派生树。否则 A12（仓库 `miniprogram/` 冒充导出树）会从“未关闭”变成“可被冒充”。
2. **t5**：`agent:adopt-attempt` IPC 仍不存在（readiness X7 `adoptAttemptIpcPresent=false`）。C09/C16 已在模块层证明三分码与确认语义，
   **IPC 层必须原样透传 `AGENT_PARTIAL_CONFIRM_REQUIRED`**，不得自己把 `partial` 洗成成功。
3. **t6（E0-R1）**：C11 只证明“取消后不再调 direct、迟到结果不落盘”。**direct 循环本身**（截断/工具回放/`imageAssetIds` 真实进入多模态）完全未验证，
   不要引用本文件的 X3“桌面侧已关闭”去推断 direct 通道已就绪。
4. **t6/t1**：C17/F3 的顺序契约不敲定，模型侧“先检查再微调再提交”会稳定失败；建议在 direct 循环的工具提示里写死“改动后必须重跑两项检查”。
5. **所有人**：`run-coordinator.cjs` 昨夜仍在被并发修改（00:39 → 00:52 两版行为不同）。任何基于本文件的结论都必须先核对第 0 节摘要；
   摘要不一致就重跑命令 1（113 s），不要口头复用。

## 7. 本文件没有覆盖的（保持 NOT_RUN，禁止被当作已通过）

- 真实 Flash 调用与“答案依赖图像内容”（X2/§14.12-4）：属 t8/t7，`--mode real` 未开启。
- 多模态图片真实进入消息（A43–A48）、`verify_wechat` 真实运行时（微信工具 BLOCKED 不阻塞 E0，但必须如实记 BLOCKED）。
- IPC 层 `agent:adopt-attempt`/`agent:workspace-tool` 的端到端链路（t5）。
- UI 侧（t3 `src/components/agent/e0/**`）与 `agent:progress` 到界面的接线。
- 服务端副本删除（X9，t9 E0-R1b）。

## 8. 复现

```powershell
# 1) 钉摘要（与第 0 节对比；不一致则本文件结论作废）
Get-FileHash desktop/agent-workspace/run-coordinator.cjs, desktop/model-call-scheduler.cjs, desktop/agent-workspace/checks.cjs -Algorithm SHA256

# 2) 全量离线断言（104 例；退出码 0 = 无 FAIL，不代表 E0 通过）
node scripts/e0-verify/run.cjs --mode offline

# 3) 只跑本轮新增/受影响用例（快速回归）
node scripts/e0-verify/run.cjs --mode offline --no-write --only C01,C02,C07,C08,C09,C10,C11,C15,C16,C17,S01,S02,S03,S04,S05,S06

# 4) 真实（非替身）检查链单独复现
node scripts/e0-verify/run.cjs --mode offline --no-write --only C16

# 5) t1/t2 自身测试面
node --test --experimental-test-isolation=none test/model-call-scheduler.test.cjs "test/agent-workspace*.test.cjs"
```

新增脚本：`scripts/e0-verify/chains/coordinator.cjs`（C01–C17）、`scripts/e0-verify/chains/scheduler.cjs`（S01–S06）、
`scripts/e0-verify/lib/scheduler-child.cjs`（跨进程峰值观测子进程）。

## 9. 结论

- X1 / X3 / X12 的**桌面侧**在本轮实测中达到可判“已关闭”的程度（证据见 §2），但三条的整体关闭、以及 E0 的最终
  `PASS|PARTIAL|FAIL` 结论，仍归 t8 且必须先有真实 Flash 证据（§14.12-4）。
- 本文件 `e0Verdict` 保持 **NOT_RUN**：准备/增量阶段不判 PASS。
- 现存 6 条 finding 无 blocker；F1–F3 建议在 t5 接线前修掉，否则 IPC/UI 层会把“陈旧证据”与“网络错误”混为一谈；
  F6 只是码表口径不一致（fail-closed 成立），建议改冻结文档的措辞而不是改代码。

## 10. 附录：Captain 裁定 rev15 §14.13 → t8 复验检查点（2026-11-25，本文件结论不受影响）

本节只登记“裁定要求的可机械复核项”，**不代表已复验**（t5/t6 尚未交付；本文件所有 PASS 仍只对第 0 节摘要成立）。

| 裁定 | 要求（可机械复核） | t8 复验动作 | 现有用例影响 |
| --- | --- | --- | --- |
| §14.13-F1 | `submitAttempt` 成功返回**必须**含 `{candidateId, revision, treeDigest, exportRelative, exportTreeDigest, targetPage, status:'submitted'}`；`exportRelative` 为相对路径；缺 `exportTreeDigest` 即不可 adopt | 断言返回体逐字段存在且 `exportTreeDigest === dry-run 证据值`；再断言缺失时 adopt 被拒 | C08/C13/C16 增字段断言（现仅校验 submission.json 内字段，属 finding F1） |
| §14.13-F2 | `run_check` 在缺 subject/root/definitions 时**先拒后跑**，检查 runner 调用次数必须为 0 | 用计数注册表断言 `calls.length === 0` 且返回错误码 | **C15 需收紧**：现仅断言“不抛异常 + 最终 submit 被拒”，未断言 runner 调用 0；C07 保持 |
| §14.13-F3 | **derive bundle 只能在检查阶段，submit 不得再派生**；顺序固定 写→derive→source.check→composer.dry-run→mini/output→submit→adopt；证据与当前 revision/treeDigest 不一致 → `AGENT_EVIDENCE_STALE` + issue `EVIDENCE_STALE_RERUN_CHECKS` + `nextAction:"rerun-checks"`，不得自动补派或静默放行 | 构造“检查后再写” → 断言 `AGENT_EVIDENCE_STALE`、issue 码、`nextAction`；并断言 submit 未改动 `bundleDerivedAtSubmit`/候选摘要 | **C17 需重写判据**：现接受 `AGENT_STATIC_GATE_FAILED`（旧合同行为），须改为上述三要素断言 |
| §14.13-F4 | adopt 判 partial 前**先校验证据新鲜度**，陈旧先报 `AGENT_EVIDENCE_STALE` | 构造“已提交 + 证据陈旧 + 未确认 partial” → 必须 `AGENT_EVIDENCE_STALE`（不得先报 `AGENT_PARTIAL_CONFIRM_REQUIRED`） | C09 增一条“陈旧优先于未确认”的子断言（现三例不重叠，未覆盖优先级） |
| §14.13-F6 | 码表：run 级 → `AGENT_RUN_NOT_FOUND`；turn/attempt 级 → `AGENT_ATTEMPT_NOT_FOUND`；`handle.projectId` 与私有根不一致 → `AGENT_PROJECT_MISMATCH`；三者均拒绝且零落盘（**只改文档不改码**） | 复跑 C10 并对照 §14.2-5/§14.13 文案 | C10 **已符合**（观测值即此三分），无需改 |

**t8 起跑前必做**：重取 `run-coordinator.cjs` 的 sha256 并写入结论头（t5 会继续改该文件；本文件钉的 `232F24F2A35920CB` 只覆盖本轮）。
