# E0-V1 独立门禁计划（E0-V1p 准备稿）

> 任务：`t4 / E0-V1p — 独立验证器准备（无 UI 垂直链 + 攻击清单）`。执行者：**verifier**。
> 契约依据：`docs/handoff/Workspace-Agent-B阶段接口冻结.md` **rev15** §14.2–§14.12（辅以 §1.3/§1.5/§3.3/§3.8/§9.1）
> 与计划 `docs/handoff/Workspace-Agent-E0闭环纠偏与E阶段-Flash续期计划.md` §1（X1–X12）、§4（E0-V1）。
> 攻击清单见同目录 [`attacks.md`](./attacks.md)；执行器见 [`scripts/e0-verify/`](../../../../scripts/e0-verify/README.md)。
>
> **本文件是“怎么验”的计划，不是“验过了”的结论。** 本任务不判 PASS；E0 是否通过只能由 t8（E0-V1）
> 在实现就绪后按本计划执行并出具 verdict。实现未就绪的步骤一律 `NOT_RUN`，不得用 mock/替身补绿。
>
> 2026-11-25 修订：按 Captain 在 rev15 **§14.12** 对 Q1–Q4 的裁定与两条事实登记同步（原 §8 开放问题已关闭，见 §8）。

---

## 0. 判定口径（先定规则，再看步骤）

| 口径 | 规则 |
|---|---|
| 状态词 | 只用 `PASS` / `FAIL` / `BLOCKED` / `NOT_RUN`；`PARTIAL` 只用于“微信运行时未完成”的交付描述 |
| 通过条件（计划 §4） | 无 UI 垂直链 PASS + 负例全部 PASS + X1–X12 各有代码与测试关闭（X12 = 上游并发 ≤3）+ X10 接入项冻结 + X11 基线明确 + **verifier 独立出具 PASS** |
| 检查对象 | 一切检查必须落在**当前 attempt / 其派生导出树**；Base、已采用版本、`miniprogram/` 镜像都不是候选 |
| 证据来源 | 只信磁盘证据 + 平台重算（treeDigest / exportTreeDigest / bundleDigest）；不信模型自述，不信实现者报告的自评 |
| 门禁分级 | 官方 `npm test` / `npm run build` / `test:desktop` 与等价命令（`node --test --experimental-test-isolation=none …`）分开记录；`spawn EPERM` 记 `BLOCKED`，不得把等价门禁当官方门禁 |
| 真实模型（rev15 §14.12-4） | **真实 Flash 是 E0 PASS 的必需项**：一轮真实多模态 + 一次 issue→repair 必须留可复核证据（输入图 sha256、响应 `model`、工具 trace、treeDigest、截断/重试）。`server/.env` 的 `DEEPSEEK_API_KEY` 实测存在且非占位，**不得以“无 Key”为由跳过**；网络/网关不可用属实才记 `BLOCKED` 并附实际错误 |
| 微信/UIA（rev15 §14.12-4） | 不可用记 `BLOCKED`，**不阻塞** E0 判定；但不得把 React 预览截图当微信运行时截图 |
| E0 结论（rev15 §14.12-4） | 只允许三选一：`PASS`（垂直链+负例+真实 Flash 全通过且 X1–X12 关闭）/ `PARTIAL`（真实模型或运行时环境 BLOCKED）/ `FAIL`（代码或证据缺陷）。写 `PARTIAL` 时**禁止暗示 E1–E4 可开** |
| 禁止 | 伪造模型/微信证据；用 React 预览截图冒充微信截图；把 `partial` 当通过；为了让报告好看把 `NOT_RUN` 改 `PASS` |

---

## 1. 就绪度快照（实测，2026-11-25 00:2x；`node scripts/e0-verify/run.cjs --mode offline`）

| X | 关键接口 | 实测事实 | 归属任务 |
|---|---|---|---|
| X1 | `desktop/agent-workspace/run-coordinator.cjs` | **已落地**，导出面完整（`createRunCoordinator` + `MODEL_TOOL_NAMES`/`PLATFORM_ONLY_TOOL_NAMES`/`RUN_STATES`/`PROGRESS_STAGES`/`CODES`）。**桌面侧执行断言已复跑 PASS**（C01/C02/C04/C13/C14/C16，见 `incremental-w1r1a.md`） | t1 E0-W1 |
| X2 | `desktop/agent-runtime/**`（`resolveAssetImage` / `buildMultimodalContent`） | **未落地**（`desktop/agent-runtime` 不存在；仓库内无该符号） | t7 E0-R2 |
| X3 | Coordinator `startRun`/`invokeTool` + attempt 生命周期 | 模块已落地，**桌面侧执行断言已复跑 PASS**（C03/C04/C05/C08/C10/C11/C15/C16：subject 固定 attempt、写只落 attempt、提交后只读、伪造/跨项目句柄拒绝且零落盘、取消三态与迟到零落盘） | t1 E0-W1 |
| X4 | `desktop/agent-workspace/checks.cjs` | **未关闭**（已登记 rev15 §14.12-5）：`source.check` 仍映射 `scripts/frontend-capabilities.cjs` 且不带 `--root`；`mini.check.scoped=false`；无独立 `capabilities.check`；`composer.dry-run` 的 `--root` = 已采用版本 source（A11O 实测）。t5 交付前一律记未关闭 | t5 E0-W2 |
| X5 | submit 8 页单一来源 | 只能执行判定（导出面无法静态确认页枚举来源）；t5 验收已含 R3–R6（targetPages 派生、8 页单一来源、run-check 证据字段、未知状态不得归一 FAIL） | t5 E0-W2 |
| X6 | `deriveSourceBundle`（平台派生） | **未落地**（仓库内无 `deriveSourceBundle`） | t5 E0-W2 |
| X7 | `agent:adopt-attempt` + 证据绑定 | **未落地**（`desktop/agent-tools-ipc.cjs` 内无 `adopt-attempt`）；B2 `adoptAttempt` 存在但不校验磁盘证据。失败码按 §14.12-1 三分（见 V10/A10） | t1 + t5 |
| X8 | `requestChat` 返回 `finishReason`/`truncated` | **未落地**（`desktop/model-credentials.cjs` 内无 `finishReason`/`truncated`/`output_truncated`） | t6 E0-R1 |
| X9 | desktop 回复处理（删除伪状态改写）+ 服务端副本 | **未关闭**：desktop 侧未落地；服务端 `server/src/agent/workspace/workspace-agent.service.ts:80` 仍保留 `已验证/已采用 → 待本地确认`。rev15 §14.12-3：**必须在 E0 关闭前删除**（桌面 + 服务端同日径），判据 = 桌面已删 **且** 服务端副本已删/证明不可达 | t6 E0-R1（桌面侧）+ **t9 E0-R1b（服务端副本）** |
| X10 | `src/components/agent/e0/**` + `docs/evidence/workspace-agent/e0-u1/` | **已有交付**（8 个文件 + `interface-gap.md`）；接入项冻结需 t8 按 §6 判（t3 的 R1/R7/R8 缺口按 §14.12-6 由 rev16 在 E0 通过后冻结，不影响 E0 判定） | t3 E0-U1 |
| X11 | `docs/evidence/workspace-agent/e0-git/**` | **基线证据已归档**（`baseline.md` + `status-classification.json`）；逐项核对仍需 t8 | Captain（已完成） |
| X12 | `desktop/model-call-scheduler.cjs` | **桌面侧已关闭**（rev15 §14.12）：模块 `MAX_UPSTREAM_CONCURRENCY=3`、`DEFAULT_QUEUE_TIMEOUT_MS=180000`；t2 交付 27 tests + 5 并发实测 `active=3/queued=2` + 两进程峰值 3（`docs/evidence/workspace-agent/e0-r1a/`）。**服务端侧（t9）未做**，故 t9 前只能记“桌面侧已关闭”；t8 仍需独立复跑 A38–A42 | t2 E0-R1a（桌面）/ t9（服务端） |

> 结论（本表口径，2026-11-25 修订为 rev15 §14.12 口径）：**X4/X6/X7/X8/X9 明确未关闭；X2 无实现；X12 仅桌面侧已关闭（服务端待 t9）；X1/X3 桌面侧已由 C 组断言复跑 PASS、整体（IPC/direct/真实模型）未关闭；X5 接口在手但语义未判定；X10/X11 待 t8 核对。**
> 因此现在**不可能**给出 E0 PASS，本阶段所有 E0 级用例保持 `NOT_RUN`。
> 本轮新增的 C 组（C01–C17）与 S 组（S01–S06）是**已可执行的桌面侧断言**，明细与 findings 见 [`incremental-w1r1a.md`](incremental-w1r1a.md)。

---

## 2. 无 UI 垂直链（E0-V1 主体，V01–V14）

执行器：`scripts/e0-verify/chains/vertical.cjs`（用例 id 与下表一致）。每步都写清：
**用哪个冻结接口 → 断言什么 → 失败即说明哪个 X 未关闭 → 当前状态**。

| # | 冻结接口 | 断言（可机械复核） | 失败即 X 未关闭 | 现状 |
|---|---|---|---|---|
| V01 | `coordinator.startRun({…})` + `workspace.createAttempt` 语义 | runId 由平台生成（`/^frun-…/`）、`attempt-1`、`baseVersionId=currentVersionId`、`baseTreeDigest` = 该版本摘要、attempt 目录在 `<userData>/projects/<projectId>/agent-workspace/runs/…`；**无当前版本 → `AGENT_VERSION_NOT_FOUND` 且不建目录（不回落 Base）** | X1 / X3 | NOT_RUN（执行体待 t8） |
| V02 | `coordinator.invokeTool({tool,…})` | 返回 envelope 带 `runId/turnId/attemptId`；`read_file` 可 `subjectOverride:{kind:"version"}` 只读；写入传 version subject → `AGENT_TOOL_NOT_ALLOWED`/`AGENT_PAYLOAD_INVALID` 且零落盘 | X3 | NOT_RUN |
| V03 | `invokeTool` + direct runtime（t6） | fake model 读 menu/product-card 事实并写真实修改：落 `attempt/candidate`、`revision+1`、`treeDigest` 变、当前版本 source 逐字节不变、trace 只含工具标签与相对路径 | X1 / X3 | NOT_RUN（`agent-runtime` 缺） |
| V04 | `derive_source_bundle`（平台） + `manifest.buildManifest` | `attempt/source-bundle.json` 为 `frontend-source-bundle.v1`（`files` 最终完整内容 / `deleted` 显式 / `components[].scope` / `assets` 真实字节 / `bundleDigest`）；派生后 manifest/treeDigest 重算=磁盘；模型调用该工具 → `AGENT_TOOL_NOT_ALLOWED` | X6 | NOT_RUN（t5） |
| V05 | `run_check({checkId:"source.check"})` → `scripts/frontend-source/check.cjs#checkProject` | 证据含 `{checkId,status,treeDigest=attempt 摘要,subjectKind:"attempt",attemptId,at,issues[]}`；**在 attempt 里埋一处 checkProject 必检违规 → status=FAIL 且 `issues[].file` 指向该 attempt 相对路径**（同一违规不在 Base 中，证明查的是 attempt） | X4 | NOT_RUN（t5；A11O 已实测当前查的是仓库/版本） |
| V06 | `run_check({checkId:"composer.dry-run"})` | 先 compose attempt，导出树落 `attempt/verification/dry-run/`，返回相对引用 + `exportTreeDigest`；导出内容含 V03 的修改；两次 compose 摘要一致 | X4 / X6 | NOT_RUN（t5） |
| V07 | `run_check({checkId:"mini.check"})`、`output.consistency` | root 由平台填且等于 V06 导出树摘要；无 root → `AGENT_CHECK_UNKNOWN`；root 指向 `miniprogram/` → 拒绝；status 只用四态（未知状态不得归一为 FAIL） | X4 | NOT_RUN（t5） |
| V08 | `coordinator.submitAttempt` | `source.check=PASS` + `composer.dry-run=PASS` + 导出摘要=当前 `treeDigest` 才 `submitted`；缺任一 → `AGENT_STATIC_GATE_FAILED`；摘要陈旧 → `AGENT_EVIDENCE_STALE`；非法 targetPage → `AGENT_TARGET_PAGE_UNSUPPORTED`；返回状态只有 `submitted` | X7 | NOT_RUN（依赖 t5 证据链） |
| V09 | `submitAttempt` + 写事务 | submitted 后 `write_files/delete_files` → `AGENT_ATTEMPT_IMMUTABLE` 且零落盘；重复 submit → `AGENT_RUN_ALREADY_SUBMITTED`；repair 落 `attempt-2`，`attempt-1` 指纹不变 | X3 / X7 | NOT_RUN |
| V10 | `coordinator.adoptAttempt` + `agent:adopt-attempt` | 读磁盘 `submitted` + `verification/**` 证据，校验 `treeDigest`/`exportTreeDigest`；成功生成 parent=当前版本的新版本、`adoption.sourceKind="agent-edit"`、`version.json.verification` 四态。**失败必须三分（rev15 §14.12-1，不得互相顶替）**：① `state ≠ submitted`（从未提交/已取消/已被取代）→ `AGENT_ADOPTION_FAILED` + issue `NOT_SUBMITTED`；② 已 submitted 但证据摘要与当前 attempt 不一致 → `AGENT_EVIDENCE_STALE`；③ 运行时证据 `BLOCKED/NOT_RUN` 且未 `partialConfirmed` → `AGENT_PARTIAL_CONFIRM_REQUIRED` | X7 | NOT_RUN（依赖 t5，IPC 缺） |
| V11 | `versions.undoVersion/redoVersion/reopenProject`（命令面经 Coordinator） | undo→父版本（redo=当前）、redo→推回并清 redo、无父/无 redo → 对应 `AGENT_*_UNAVAILABLE`；篡改 current source 后 reopen → `AGENT_VERSION_CONFLICT` 且不回退 Base | X7 / X11 | B2 层已由 P06/A24 覆盖；命令面待 t8 |
| V12 | `versions.verifyExportIdentity/resolveVersionSource` + Composer 导出 | 当前版本身份校验 PASS；`overlayDigest=adoption.integrity`；导出树逐文件 sha 与 `versions/<current>/source` 一致；漂移不清洗、不回落 | X6 / X7 | B2 层由 P07/A25 覆盖；导出接线待 t5 |
| V13 | `coordinator.cancelRun` + `scheduler.stats()` | 首次 cancel=`requested`；停止后=`cancelled`；已完成/未知=`too-late`（不得显示失败）；取消后 `invokeTool` 零落盘、不再发起上游、调度器 `active/queued` 归零 | X8 / X12 | NOT_RUN |
| V14 | `coordinator.emitProgress` + §9.1 stage 清单 | 每个 stage ∈ §9.1 ∪ {queue,image,bundle,submit,adopt}；payload 无绝对路径/源码/base64/prompt/Key；status ∈ running/succeeded/failed/cancelled；未知 stage 不得静默丢弃 | X10 | NOT_RUN |

**顺序要求**：V01→V02→V03 建候选；V05/V06/V07 必须在 V03 之后（否则没有“候选改动”可证明检查目标）；
V08 必须在 V05/V06 之后；V10 必须在 V08 之后；V11/V12 在 V10 之后；V13/V14 可独立跑但在 V03 之后更有意义。

---

## 2.5 C 组 / S 组：桌面侧已可执行的断言（E0-V1a 增量，2026-11-25）

V 组需要 direct 通道与真实模型，整体仍 `NOT_RUN`；但 **t1 的 Coordinator 与 t2 的调度器本身已可独立执行断言**，
因此新增两组**今天就能真跑**的用例（执行器：`chains/coordinator.cjs`、`chains/scheduler.cjs`），
V 组里与它们重叠的部分以这两组为准（V01/V02/V05/V06/V08/V09/V10/V13/V14 的桌面侧事实已在 C 组落地）。
本轮实测结论、命令与退出码、findings、对 t5/t6 的风险提示见 **[`incremental-w1r1a.md`](incremental-w1r1a.md)**。

| ID | 断言（简） | 现状 |
| --- | --- | --- |
| C01 | `startRun` 从 `currentVersionId` 复制 attempt 树、返回冻结字段 | PASS |
| C02 | 无版本/未知项目 → `AGENT_VERSION_NOT_FOUND` + 零建目录、不回落 Base | PASS |
| C03 | subject 固定 attempt；写入拒绝 version subject；`read_file` 版本覆盖只读 | PASS |
| C04 | 写只落 attempt、revision+1、摘要与磁盘一致、版本零写入 | PASS |
| C05 | 工具面 11 vs 平台专用 3；未知名 `AGENT_TOOL_NOT_ALLOWED` | PASS |
| C06 | 无证据 submit → `AGENT_STATIC_GATE_FAILED`，状态不变 | PASS |
| C07 | `checkId→subject` 平台表；证据主体降级即被门禁拒 | PASS |
| C08 | 主体 PASS 证据 → `submitted`+`partial`；提交后只读/重复提交/取消 `too-late` | PASS |
| C09 | adopt 三分码实测且不互相顶替 | PASS |
| C10 | 伪造/跨项目/跨 run/跨 turn 句柄在 Coordinator 层被拒 + 零落盘（§14.12-2 判据） | PASS |
| C11 | 取消三态 + 迟到结果零落盘 + 取消后不再调注册表/direct | PASS |
| C12 | `agent:progress` stage/status 白名单 + 脱敏 | PASS |
| C13 | `getRun`/`getAttemptState` 与磁盘事实一致 | PASS |
| C14 | `startRun` 入参校验（含 `imageAssetIds` 只接受 assetId） | PASS |
| C15 | 注册表漂移（无 `definitions`）fail-closed 且不抛异常 | PASS（暴露 finding F2） |
| C16 | **真实检查链（零替身）**：写改→派生→双检查 PASS→submit(partial)→adopt v2 | PASS |
| C17 | 检查后再写 → 旧证据失效被拒（fail-closed，暴露 finding F3） | PASS |
| S01 | 5 并发 → active 3 / queued 2，全部完成 | PASS |
| S02 | 排队超时 → `MODEL_QUEUE_TIMEOUT`（虚拟时钟，不真等 30 s） | PASS |
| S03 | 取消排队任务 → `MODEL_ABORTED`，槽位不泄漏 | PASS |
| S04 | 两子进程各 2 任务共享令牌池 → 全局峰值 ≤3 | PASS |
| S05 | 并发上限只接受 1–3；非法值 `MODEL_CONFIG_INVALID`；旧 env 名不生效 | PASS |
| S06 | 排队 FIFO，无插队 | PASS |

> 这些 `PASS` 只覆盖**桌面侧**，不得据此外推 X1/X3/X12 整体关闭；整体关闭仍需 t5（IPC）、t6（direct）、t7（图片）、t8（真实 Flash）。

---

## 3. 前置链（P01–P08，已可执行；不属 X 关闭证据）

用途：证明“临时 userData + 版本 → attempt → 真实修改 → 采用 → undo/redo/重开/导出身份”的地基可用，
避免 t8 把 B1/B2 的既有能力误算成 E0 新能力。

| # | 断言 | 实测（2026-11-25，本机） |
|---|---|---|
| P01 | 临时根在 `tmpdir` 内、不在仓库内、与 `app-data`/AppData 真实 userData 无交集 | PASS |
| P02 | `initProject` → v1（`import-base`，`parentVersionId=null`），两次 reopen 摘要一致 | PASS |
| P03 | `createAttempt`（source=version v1）→ `attempt-1`；`versions/v1` 指纹不变 | PASS |
| P04 | `writeFile` → revision 递增、treeDigest 变化、读回新内容、版本零写入 | PASS |
| P05 | B2 `adoptAttempt` → v2（parent=v1、`sourceKind=agent-edit`），v1 逐字节不变 | PASS |
| P06 | undo/redo 只动指针，`versions/` 目录集合不变 | PASS |
| P07 | `reopenProject` + `verifyExportIdentity` PASS；`resolveVersionSource.sourceRoot = versions/<current>/source`，重算摘要=索引摘要 | PASS |
| P08 | `manifest.buildManifest(candidateDir).treeDigest` 与 attempt 记录摘要一致（写前后各一次） | PASS |

> 边界：P 组 PASS **不**意味着 X6/X7 关闭（B2 的 `adoptAttempt` 不读证据、不校验 `exportTreeDigest`，
> 这正是 E0 要补的部分，见 A07/A08/A10）。

---

## 4. 真实 Flash 一轮（R01–R07，`--mode real`）

| # | 冻结接口 | 断言 | 失败即 X 未关闭 |
|---|---|---|---|
| R01 | `resolveAssetImage({userDataDir,projectId,assetId})` | 只接受 assetId；返回 `{assetId,mime,bytes,sha256,dataUrl}`；sha256 与原始图一致；symlink/junction/越界拒绝 | X2 |
| R02 | `buildMultimodalContent` | 消息含真实 `{type:"image_url"}` data URL；顺序稳定；base64 不落 `attempt.json/run.json/trace/日志`（跑完全量扫描） | X2 |
| R03 | 真实模型调用 | 带图能正确回答图内主色/元素；同提示仅给 assetId 文本时不得产生同样结论 | X2 |
| R04 | direct 工具循环 | 工具名只出现 11 个模型可见工具；`write_files` 真落 attempt；trace 记录 revision/treeDigest | X1 / X8 |
| R05 | 检查回灌 + repair | 模型读 `issues` 后做一次定向修复；前后 treeDigest 与 issue 集合可追溯；修复走新 revision/新 attempt | X4 / X7 |
| R06 | `requestChat` 截断信号 | 空正文 + `finish_reason=length` 记 truncated；truncated 时本批 `tool_calls` 不执行、返回 `output_truncated`；重试次数入证据 | X8 |
| R07 | `wechat.verify` | CLI/UIA 不可用 → `BLOCKED` + 行为 partial；不得把 React 预览截图当微信运行时截图 | X10 |

当前：全部 `NOT_RUN`（`agent-runtime` 未落地；`requestChat` 无截断字段）。按 rev15 §14.12-4：**真实 Flash 是 E0 PASS 必需项**，`server/.env` 的 `DEEPSEEK_API_KEY` 实测存在且非占位，t8 不得以“无 Key”跳过；网关不可用属实才记 `BLOCKED` 并附错误。微信 CLI 历史实测写 AppData EPERM（历史 BLOCKED），按同一裁定：微信不可用只记 BLOCKED、不阻塞 E0，但整体结论最高只能是 `PARTIAL`。

---

## 5. 攻击清单覆盖（与 `attacks.md` 一一对应）

`attacks.md` 共 **51 条**（A01–A49 + 两条观察 A11O/A21O），分组：
证据绑定（A01–A09 + A49）、检查目标（A10–A15 + A11O）、句柄/路径/越权（A16–A23 + A21O）、
重开/导出身份（A24–A25）、attempt 不可变（A26–A29）、工具白名单（A30–A31）、
截断/预算（A32–A34）、取消/迟到（A35–A37）、上游并发（A38–A42）、图片与视觉（A43–A48）。

> 编号说明（2026-11-25 修订）：Captain 裁定里提到的“A10「二者之一」记录”，指的就是**越级 adopt** 那一条
> （原 plan §8 Q1 的指代）。为保持已有 id 稳定（脚本、run-report、其他成员引用都在用），该条落在 **A49**，
> **A10 仍是“用 Base 冒充候选检查”**；两者一一对应关系见 attacks.md §1/§2 的表头注记。

任务要求的必含项 → 条目映射：

| 必含项 | 条目 |
|---|---|
| 未 derive bundle / 未 source.check / 未 composer.dry-run 就 submit → `AGENT_STATIC_GATE_FAILED` | A01 / A02 / A03（A04 伪造 PASS 证据） |
| 用旧 treeDigest 的证据 submit/adopt → `AGENT_EVIDENCE_STALE` | A05 / A06 / A07 / A08 |
| 越级 adopt（未 submitted）→ `AGENT_ADOPTION_FAILED` + issue `NOT_SUBMITTED` | **A49**（rev15 §14.12-1） |
| 用 Base 或 miniprogram 镜像冒充候选检查 → 判 FAIL | A10 / A11 / A12（+A11O 现状观察） |
| 跨项目 / 跨 run / 跨 turn / 伪造 attempt 句柄 → 拒绝且零落盘 | A16 / A21 / A22（+A20 非法 id；A21O 现状观察） |
| submitted 后再写同一 attempt → `AGENT_ATTEMPT_IMMUTABLE` | A26（+A27/A28） |
| 截断（finish=length）→ 不回放 tool_calls、返回 `output_truncated` | A32 / A33 |
| 5 个并发上游请求 → 第 4 个排队（≤3） | A38（+A39–A42） |
| 缺图/坏图/超 2 MiB/非 PNG-JPEG-WebP → `AGENT_IMAGE_INVALID`；无视觉能力 → `AGENT_VISION_UNAVAILABLE` | A43 / A44 / A45（+A46/A47） |
| 取消后不再发起上游请求；迟到工具不落盘 | A35 / A36（+A37 三态） |
| partial（微信 BLOCKED）未确认 adopt → `AGENT_PARTIAL_CONFIRM_REQUIRED` | A09 |

---

## 6. 当前 NOT_RUN 清单，以及需要 Captain 派给谁

> 依据：本轮实测（§1）。**我（verifier）本轮只做骨架与清单，不执行 E0 级判定，也不接管别人任务。**

| 未就绪项 | 阻塞的用例 | 需要谁 | 交付后我要做的事 |
|---|---|---|---|
| 检查目标绑定（X4）：`source.check` → `scripts/frontend-source/check.cjs`，`mini.check` 改 scoped 到派生导出根，新增 `capabilities.check`，`composer.dry-run` 先 compose attempt | V05–V07、A11–A13、A15 | **t5 E0-W2（workspace-lead）** | 跑 A11O 复核 `--root=attempt`，再补 V05–V07 执行体 |
| source-bundle 平台派生（X6）+ submit 静态门禁 | V04、V08、A01–A06 | **t5 E0-W2**（依赖 t1 的 submit 门禁） | 补 V04/V08 执行体，核对 `bundleDigest`/证据字段 |
| `agent:adopt-attempt` IPC + 证据绑定（X7） | V10、A07–A10 | **t5 E0-W2**（B2 `adoptAttempt` 复用，t1 已接线） | 补 V10 执行体；按 §14.12-1 三分码分别断言（未提交→`AGENT_ADOPTION_FAILED`+`NOT_SUBMITTED`；摘要不符→`AGENT_EVIDENCE_STALE`；未确认 partial→`AGENT_PARTIAL_CONFIRM_REQUIRED`） |
| Coordinator 句柄校验补 `projectId ↔ 私有根` 一致性断言（伪造 projectId → `AGENT_PROJECT_MISMATCH`，零落盘） | A21（升级判据）、A21O | **t5 E0-W2**（rev15 §14.12-2 要求） | A21 按“Coordinator 层必须拒绝，B1 直调属非产品链”判，**不因 A21O 判 FAIL** |
| direct runtime（X8/X9 桌面侧）+ 图片管线（X2） | V03、V13、R01–R07、A32–A34、A43–A48 | **t6 E0-R1 → t7 E0-R2** | 补 R 组执行体与 `output_truncated` 断言 |
| **X9 服务端副本删除**（`server/src/agent/workspace/workspace-agent.service.ts:80` 正则改写）+“已不存在”断言 | X9 关闭判定 | **t9 E0-R1b**（rev15 §14.12-3：E0 关闭前必须删） | 复验桌面已删 **且** 服务端副本已删/证明不可达，二者缺一即 X9 未关闭 |
| 上游并发 ≤3（X12）：桌面侧 t2 已交（27 tests + 5 并发实测 active=3/queued=2 + 两进程峰值 3，`e0-r1a/`）；**服务端侧未做** | A38–A42（服务端一份） | **t9（服务端通道）**；桌面侧执行归 t8 | 独立复跑 A38–A42 观测峰值，不采信 t2 自评 |
| Coordinator 语义执行体（X1/X3/X5，含 progress/V14） | V01–V03、V09、V14、A21/A22/A26–A31/A36/A37 | **t1 E0-W1 已交付模块，且桌面侧断言已由 t10 复跑 PASS**（C01–C17，见 `incremental-w1r1a.md`） | t8 只补 direct/IPC/真实模型相关执行体；不得直接采信 `e0-w1/report.md` 自评 |
| UI 接入项冻结（X10） | V14、R07 | **t3 E0-U1 已交付**（`src/components/agent/e0/**` + `interface-gap.md`） | t8 核对 stage/单页枚举/截图二进制/未知 stage 不丢步 |
| 真实模型凭据/网关 | R01–R07 | **t8 执行时自行取用**（`server/.env` 的 key 实测存在；不得跳过） | 网关不可用属实才 BLOCKED，并附实际错误 |
| E0 最终 verdict | 全部 | **t8 E0-V1（verifier 角色，另一 attempt）** | 实现全绿后按本计划执行并出 `PASS / PARTIAL / FAIL` |

---

## 7. 证据与报告规范（t8 必须遵守）

1. 每次执行落 `docs/evidence/workspace-agent/e0-v1/run-report.json`（本脚本自动生成），
   长日志另存 `…/e0-v1/raw/<timestamp>-<mode>.log`，报告只引用相对路径。
2. 结论必须分开写：`静态 PASS` / `真实模型 PASS` / `微信运行时 BLOCKED|NOT_RUN` / `E0 整体 PASS|PARTIAL|FAIL`。
3. 任何 FAIL 必须给：用例 id、被测文件与行、实际码/实际行为、期望、复现命令。
4. 不得把实现者的 `report.md` 自评当证据；必须自己跑出同样的码与摘要。
5. 临时 userData 只在系统临时目录；跑完必须删干净（`G02` 守卫），不留 `dsh-e0v1-*`。
6. 写 `PARTIAL` 时必须同时写“E1–E4 不开放”，不得暗示可以接主链或真实图片生成。

---

## 8. 原开放问题：已由 Captain 裁定（rev15 §14.12，2026-11-25）

| # | 原问题 | 裁定 | 本计划/执行器的落地 |
|---|---|---|---|
| Q1 | “未 submitted 就 adopt”的码 | **不新增码，三分**：① `state ≠ submitted`（从未提交/已取消/已被取代）→ `AGENT_ADOPTION_FAILED` + issue `NOT_SUBMITTED`；② 已 submitted 但证据摘要与当前 attempt 不一致 → `AGENT_EVIDENCE_STALE`；③ 运行时 `BLOCKED/NOT_RUN` 且未 `partialConfirmed` → `AGENT_PARTIAL_CONFIRM_REQUIRED`；三者不得互相顶替 | V10 断言、A10 判据已按三分重写（原“二者之一”作废）；A07/A08 保留为②，A09 保留为③ |
| Q2 | B1 只校验布局、不校验 `handle.projectId` ↔ 私有根 | **不判 FAIL**：产品链唯一入口是 Coordinator，跨项目拒绝由 §14.2-5 承担；但 **t5 必须在 Coordinator 句柄校验层补一致性断言**（伪造 projectId → `AGENT_PROJECT_MISMATCH`，零落盘），并在证据里写明“B1 直调属非产品链” | A21 升级为“Coordinator 层必须拒绝”；A21O 降级为纯事实登记（不构成 FAIL）；§6 新增 t5 待办行 |
| Q3 | X9 服务端副本 | **必须在 E0 关闭前删除**（与桌面同一条产品事实规则），指派 **t9 E0-R1b**；X9 判据 = 桌面侧已删 **且** 服务端副本已删/证明不可达 | §1 X9 行、§6 t9 行已更新；readiness.cjs 的 X9 facts 保留 `serverRegexRewriteStillPresent` 供 t8 复验 |
| Q4 | 真实模型/微信环境 | **真实 Flash 是 E0 PASS 必需项**，`server/.env` key 实测存在，不得以“无 Key”跳过；网关真不可用才 BLOCKED 并附错误。微信/UIA BLOCKED 不阻塞，但结论只能 `静态+负例 PASS / 真实模型 BLOCKED / 整体 PARTIAL`，不得写 PASS，E1–E4 继续不开放。E0 结论三选一 `PASS|PARTIAL|FAIL` | §0 口径新增三行（真实模型/微信/结论），§4 尾注、§6 凭据行、§7-6 已同步 |
| 附 | X4 现状登记（A11O） | 已登记进 §14.12-5；t5 交付前一律记未关闭 | §1 X4 行已注明“已登记 §14.12-5” |
| 附 | X12 桌面侧 | 桌面侧已关闭（t2：27 tests + 5 并发 active=3/queued=2 + 两进程峰值 3）；服务端侧 t9 前只记“桌面侧已关闭” | §1 X12 行、§6 行已更新；t8 仍须独立复跑 A38–A42 |

---

## 8.1 追加裁定（rev15 §14.13，2026-11-25，基于 E0-V1a 的 6 条 finding）

| # | 裁定 | 对执行器的落地（t8 必须按此判） |
|---|---|---|
| F1 | `submitAttempt` 成功返回**必须**含 `{candidateId,revision,treeDigest,exportRelative,exportTreeDigest,targetPage,status:'submitted'}`；`exportRelative` 相对路径；缺 `exportTreeDigest` 即不可 adopt | 派修 **t5 E0-W2**；C08/C13/C16 需补返回体字段断言（本轮只校验了 `submission.json`） |
| F2 | `run_check` 缺 subject/root/definitions **先拒后跑**，runner 调用次数 0 | 派修 **t5**；C15 判据需收紧为“registry calls=0” |
| F3 | **derive bundle 只能发生在检查阶段，submit 不得再派生**；唯一合法顺序 写→derive→source.check→composer.dry-run→mini/output→submit→adopt；证据与当前 `revision/treeDigest` 不一致 → `AGENT_EVIDENCE_STALE` + issue `EVIDENCE_STALE_RERUN_CHECKS` + `nextAction:"rerun-checks"`；不得自动补派/静默放行 | 派修 **t5**（实现）+ **t6**（direct 循环工具说明与停止条件，第 9 条验收）；C17 判据须重写（本轮观测到的是旧合同行为 `AGENT_STATIC_GATE_FAILED`） |
| F4 | adopt 判 partial **前**先校验证据新鲜度；陈旧先报 `AGENT_EVIDENCE_STALE` | 派修 **t5**；C09 增“陈旧优先于未确认”子断言 |
| F6 | 码表只改文档：run 级 `AGENT_RUN_NOT_FOUND` / turn·attempt 级 `AGENT_ATTEMPT_NOT_FOUND` / `handle.projectId` 与私有根不一致 `AGENT_PROJECT_MISMATCH`，三者拒绝且零落盘 | **无需改码**；C10 观测值已符合，t8 复跑对照即可 |
| 时效 | `run-coordinator.cjs = 232F24F2A35920CB…（85 904 B）` 的判定只对该版本有效；t5 会继续改该文件 | **t8 必须对最终版本重跑**并把最终 sha256 写进结论头；不得用 t10 的口头结论续期 |

> 明细检查点（含“哪条用例需要改判据”）见 [`incremental-w1r1a.md`](incremental-w1r1a.md) §10。
