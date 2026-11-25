# Review-t1：E0-W1 Coordinator 与 attempt 生命周期独立复核

> 任务：`t14 / Review-t1`（复核者：runtime-engineer2，attempt 2）
> 被复核任务：`t1 / E0-W1`（workspace-lead，attempt 1）
> 契约：`docs/handoff/Workspace-Agent-B阶段接口冻结.md` rev15 §14.2 / §14.3 / §14.12 / §14.13；
> 计划 `docs/handoff/Workspace-Agent-E0闭环纠偏与E阶段-Flash续期计划.md` §4 E0-W1；
> 被复核证据：`docs/evidence/workspace-agent/e0-w1/report.md`。
> 复核方式：**只读被复核代码**（未修改 `desktop/**`、`test/**`、`src/**`、`server/**`），
> 只在本目录新增独立探针 `t14-probe.cjs`（只 require 实现 + B1/B2 + 显式 fake checks，不复制实现逻辑）与本文。
> 结论：**PASS**（t1 的 12 条验收在本复核范围内全部成立；无阻塞 finding）。
> 边界：**本复核不是 E0 验收结论**；真实模型调用 0 次（fake checks / fake direct），微信/UIA/安装包 NOT_RUN；
> X4/X5/X6/X7（t5）与 X12（t2/t9）不在本复核判定范围。

## 0. 被测字节（本判定只对这些字节成立）

复核时（2026-11-25，Node v24.14.0 / npm 11.9.0）逐文件用 `Get-FileHash -Algorithm SHA256` 复算，未采用报告自述：

| 文件 | 字节 | sha256 |
|---|---:|---|
| `desktop/agent-workspace/run-coordinator.cjs` | 88 235 | `eedd1823efad27ed620a751788e031295756ce160a610545b283348d22cf36f2` |
| `desktop/main.cjs` | 20 915 | `481870ef515d6586b322613abf13f0f58f06e4aaf72778b7cf5ea59efb0c3d27` |
| `test/agent-workspace.coordinator.test.cjs` | 45 746 | `3644507535ab4118340ec2e6325ba425848a1029979f2b07d816a8cfdf0d884f` |
| `desktop/agent-workspace/checks.cjs`（关联，t5 交付） | 31 313 | `7974b039fdde645524b83df6d6df3d09103855fbee537babf10dd11c67544a0c` |
| `desktop/agent-workspace/source-bundle.cjs`（关联，t5） | 20 567 | `7cd641ea62248c4085b4ed04803c5e5aa8cc52d23639b6942392333aa7dfee0e` |
| `desktop/agent-workspace/direct-runtime.cjs`（关联，t5） | 9 653 | `2b8fab79107f1e7162db810d0e8e3343e7f2ced64ecfa92f3cb34d6cb387b636` |
| `desktop/agent-tools-ipc.cjs`（关联，t5） | 70 939 | `b35f0e6b27305c8b622254060cde15790783d1d277255b86623c03f7ca8badb4` |
| `desktop/preload.cjs`（关联，t5） | 9 042 | `4146d71c14fa0cc3f4719f881ef7b58e3b020005a695addb084c098d8aab0de4` |
| `test/agent-tools-ipc.test.cjs`（门禁） | 42 221 | `db97bf025db4347507f2baeea613c2ff1ab0a94fdd22e31320340c1fea858c83` |
| `test/desktop-contract.test.cjs`（门禁） | 28 185 | `715490494a21e45c1b7230c3d8b2458f4d42f02d3a370b547033ec38280cbe48` |
| 本复核独立探针 `t14-probe.cjs` | 28 260 | `a2fb37c5dbaa4bd880495d529edc970dcc2327a019a6b8237b2e3c28efa565db` |

**W1 → W2 的字节事实（必须知道，避免把 t1 报告当现行字节）**：

- rev15 §14.13-6（文档 1131–1135 行）钉的最终版正是上表：`run-coordinator.cjs eedd1823…`、`main.cjs 481870ef…`。
  t10 曾钉的 t1 版 `232F24F2…`（85 904 B）**已不在磁盘**。
- 当前 `main.cjs:387-395` 已由 W2 改为 `createDirectWorkspaceRuntime({ coordinator: () => workspaceRunCoordinator, credentials: modelCredentials })`，
  `checks` 也是真实 `createCheckRegistry`；`agent-tools-ipc.cjs` 懒解析真实 checks。因此 t1 报告 §2.3/§5-8
  的“`directRuntime: null` / B3 checks 仍为 null”是**当时历史字节**，不是现行字节；`test/agent-workspace.coordinator.test.cjs:809-814`
  已同步改为断言“direct 惰性装配”（W2 改动）。
- 本复核对**现行字节**判定 §14.2/§14.3 不变量；t5 的改动不构成 t1 的验收对象，但会单独登记为观察（§5-OBS-5）。

## 1. 命令与真实退出码（本次复核独立执行）

| # | 命令 | 真实退出码 | 结果摘要 |
|---|---|---|---|
| 1 | `node --test --experimental-test-isolation=none "test/agent-workspace*.test.cjs"` | **0** | tests 95 / pass 95 / fail 0 / duration_ms 156 922（含 coordinator 15、checks 10、bundle 6、direct-runtime 5、vertical-chain 5） |
| 2 | `node --test --experimental-test-isolation=none test/agent-tools-ipc.test.cjs test/desktop-contract.test.cjs` | **0** | tests 44 / pass 44 / fail 0 / duration_ms 16 512（stderr 只有 P5c 预期重试日志） |
| 3 | `node -e "require('./desktop/agent-workspace/run-coordinator.cjs');console.log('run-coordinator ok')"` | **0** | stdout `run-coordinator ok`，导出面 8 个符号 |
| 4 | `node docs/evidence/workspace-agent/reviews/t14-probe.cjs` | **0** | 独立探针 **37/37 PASS**；另有 4 条 `OBS`（范围外观察，不影响退出码，见 §4/§5） |

口径说明：

- 命令 1/2 是 rev15 §14.11 的 E0 等价门禁，**不是官方 `npm test`**；本次未跑 `npm test` / `npm run build` / `npm run desktop:dev`（**NOT_RUN**，本复核不触碰 renderer/构建）。
- 真实模型 / 微信开发者工具 / UIA / 安装包：**NOT_RUN**。命令 1 中 coordinator/vertical-chain 的 `checks` 是显式测试替身；本复核不把 fake 当真实证据。
- 命令 4 的探针全部在 `os.tmpdir()` 下建/删临时 `userDataDir`，不写仓库、不联网、不要求 Electron。

## 2. 验收逐条核对表

| # | t14 验收项 | 结论 | 证据（文件:行 / 命令 / 探针） |
|---|---|---|---|
| 1 | `startRun` 从 `currentVersionId` 复制 attempt 树 | PASS | `run-coordinator.cjs:853-885`（先读 state/version，再 `createAttempt(source:{kind:'version'})`）；探针 P2（`baseTreeDigest === resolveVersionSource(v1).treeDigest`）；测试 2 |
| 2 | 无版本 → `AGENT_VERSION_NOT_FOUND` 且**零建目录**、不回落 Base | PASS | `run-coordinator.cjs:854-865`；`versions.cjs:88-133` 纯读；探针 P1（`projects/` 不存在）；测试 3 三场景 |
| 3 | subject 固定 `{kind:'attempt',attemptId}` | PASS | `run-coordinator.cjs:308-310,1243-1277`（get_context）、`1344-1400`（写）、探针 P2；测试 5 |
| 4 | 写入拒绝 version subject | PASS | `run-coordinator.cjs:1737-1743`（写工具带 `subject/subjectOverride` → `AGENT_PAYLOAD_INVALID`）；`1344-1379`（changes 白名单）；探针 P2；测试 5 |
| 5 | `read_file` 版本只读 | PASS | `run-coordinator.cjs:1294-1303` + `1159-1214`（canonical + `resolveInside` + `auditPath`，只读返回 `sha256`）；探针 P2（版本 subject + 逃逸拒绝）；测试 5 |
| 6 | 写事务 revision+1 + treeDigest 重算 | PASS | `run-coordinator.cjs:1381-1400` → `transactions.cjs:564-568,391-410`；探针 P2（revision 2、digest 与 `buildManifest` 一致）；测试 6 |
| 7 | 提交后只读（repair 不覆盖已提交候选） | PASS（本入口） | `run-coordinator.cjs:1737-1739`（写/删 → `AGENT_ATTEMPT_IMMUTABLE`）；`1840-1841`（重复提交）；探针 P2（候选树摘要不变）；测试 11。**残余旁路见 OBS-4** |
| 8 | 取消三态（requested/cancelled/too-late） | PASS | `run-coordinator.cjs:1045-1094,1096-1103`；探针 P4/P5（too-late、requested→cancelled、幂等 cancelled）；测试 9/10 |
| 9 | 句柄校验层强制 `projectId ↔ 私有根`；跨项目/跨 run/跨 turn 拒绝且零落盘 | PASS | `run-coordinator.cjs:507-526`（run.json `projectId` 比对→`AGENT_PROJECT_MISMATCH`）、`538-595`（attempt.json 三项 + `openAttempt` canonical）；探针 P3/P6（junction 拒绝且链接目标零写；伪造副本 `AGENT_PROJECT_MISMATCH` 零写；`RUN_NOT_FOUND`/`ATTEMPT_NOT_FOUND` 码表）；测试 7 + vertical-chain Q2 用例 |
| 10 | adopt 三分码按 §14.12-Q1 且互不顶替（未提交/证据陈旧/partial 未确认）；F4 先新鲜度后 partial | PASS | `run-coordinator.cjs:1928-1999`、`715-726`；探针 P4：未提交→`AGENT_ADOPTION_FAILED`+`NOT_SUBMITTED`；篡改 digest 且**不带** `partialConfirmed`→`AGENT_EVIDENCE_STALE`+`rerun-checks`（优先于 partial）；恢复后→`AGENT_PARTIAL_CONFIRM_REQUIRED`+`confirm-partial`；确认后 adopt→v2 |
| 11 | `main.cjs` 接线为唯一单例、无通用 fs/exec 通道、renderer 拿不到目录/绝对路径 | PASS | `main.cjs:24`（require 一次）、`:387-395`（实例化一次，模块级 const）、`:367-375`（唯一 progress 出口）；`preload.cjs:54-81`（20 个语义命令，无目录/路径/fs/exec）；探针 P7（require/实例化各 1 次、无 `agent:(dir\|path\|shell\|exec)` 通道、coordinator 无 electron/child_process）；测试 15 |
| 12 | 独立复跑门禁并记录真实退出码 | PASS | 本文 §1：命令 1/2 均 **exit 0**（95/95、44/44）；探针 **exit 0**（37/37） |

## 3. 六个关注点逐条结论

### ① 路径 / 句柄安全（canonical、symlink/junction、projectId ↔ 私有根）——**拒绝且零落盘**

- 路径推导全部复用 B1 唯一实现：`run-coordinator.cjs:552-559` 调 `workspaceMod.attemptPaths`，
  `workspace.cjs:114-190` 内 `auditPath` 逐段做 lstat/realpath（junction 也会被 realpath 复核，见 `paths.cjs:105-117`）。
  本文件**没有**第二套 canonical/realpath 实现；`readVersionFile`/证据写入也只调 `assertCanonicalDir`/`resolveInside`/`auditPath`/`writeJsonAtomic`。
- **零落盘顺序**：`resolveAttempt` 在 `readRun` → run.json 身份 → attempt.json 身份 → `openAttempt` canonical 之前**不写任何字节**；
  拒绝路径只读文件（`fs.readFileSync`）与纯路径推导。探针 P6 用 `treeSnapshot`（相对路径+字节+sha256）证明伪造 run 副本逐字节不变。
- **跨项目/跨 run/跨 turn 码表**（rev15 §14.13-5）：run 级 → `AGENT_RUN_NOT_FOUND`；turn/attempt 级 → `AGENT_ATTEMPT_NOT_FOUND`；
  `handle.projectId` 与 run.json/attempt.json 不一致 → `AGENT_PROJECT_MISMATCH`。探针 P6 独立复验三条。
- **junction**：把整个 `attempt-1` 目录换成 junction 后，`attemptPaths` 的 audit 先失败，`resolveAttempt:559` 归一到
  `AGENT_ATTEMPT_NOT_FOUND`（拒绝成立；此处归一化会丢掉 `AGENT_PATH_LINK` 具体码，属码表措辞问题而非放行）。
  链接目标候选树摘要前后一致（探针 P3）。
- **B1 直调边界**：`transactions.assertAttemptHandle`（`transactions.cjs:62-119`）只校验布局，不校验
  `handle.projectId` 与私有根；这与 rev15 §14.12-Q2 的裁定一致（B1 直调不构成产品攻击面），
  Coordinator 层已补 `run.json`/`attempt.json`/`project.json` 三重一致性。本复核不把 B1 直调判 FAIL。

### ② 写事务与 revision/treeDigest 一致性 ——**同一事务 ABI，无旁路**

- 所有写入（含 bundle 派生写回）都走 `transactionsMod.applyChanges(attempt, changes)`，该函数复用
  `assertAttemptHandle`（唯一归属校验）并在提交时写 `attempt.json` 的 `revision`/`treeDigest`
  （`transactions.cjs:391-410,529-539`）；Coordinator 只读回结果，不手改 revision。
- 探针 P2：写一次后 `revision=2`、返回的 `treeDigest` 等于 `manifest.buildManifest(candidate)` 的重算值，
  `attempt.json.revision=2`；`getAttemptState` 读回一致。测试 6 还覆盖 2→3→4 与 delete。
- 提交/采用：`submitAttempt` 只通过 `manifest.writeAttemptMeta` 改 `status/submittedAt/candidateId/targetPage`；
  `adoptAttempt` 委托 `versionsMod.adoptAttempt`（`versions.cjs:798+`）后由 B2 建版本；没有绕过 B1/B2 的文件写。

### ③ 取消与迟到工具零落盘 ——**三态 + 双重取消判定成立**

- `cancelRun`：`submitted/adopted` → `too-late`（不回滚事实）；已 `cancelled` → 幂等 `cancelled`；
  有在途 `activeCalls>0` → 只写 `cancelRequested:true` 并返回 `requested`，在途结束的 `finally`
  调 `settleCancellation` 落 `cancelled`。`run-coordinator.cjs:1045-1103`。
- `invokeTool`：取消判定在**工具分发之前**（`:1733-1735`）；异步工具 `await` 回来后再次 `runCancelledNow`
  （`:1510-1513`、`:1581-1583`），外层再按 `activeCalls===0` 复核（`:1804-1810`）；取消后不调注册表、不落证据。
- 探针 P5 用挂起的 fake 检查复验：`requested` → 迟到结果 `AGENT_CANCELLED` → run 落 `cancelled` →
  迟到 write 拒绝且候选树快照不变 → 迟到 `invokeDirect` 拒绝且 direct 调用数 0。测试 9 同口径（含注册表调用数不变）。
- 观察：`invokeDirect` 自身在途取消仍原样返回模型结果（见 OBS-1）；**没有磁盘写入**，且生产 direct 循环
  每步都重新 `assertRunActive` 并丢弃迟到结果（`desktop/agent-runtime/workspace-runtime.cjs:234-249,450-492`），
  因此不构成 §14.2-6 的落盘违例，但注释措辞与实现不一致。

### ④ 提交后只读 ——**Coordinator 入口成立；存在一条 legacy renderer 旁路（OBS-4）**

- `invokeTool` 对 `write_files/delete_files` 在 `attemptStatus !== 'open'` 时直接 `AGENT_ATTEMPT_IMMUTABLE`
  （`:1737-1739`）；`submitAttempt` 重复提交 → `AGENT_RUN_ALREADY_SUBMITTED`（`:1840-1841`）；
  读工具仍可用（测试 11）。探针 P2 证明写/删后候选树摘要不变。
- **但**：W1 报告 §6-4 把“`agent:*` 统一转调 Coordinator”列为 W2 交接项，最终字节只把
  `agent:submit-candidate` / `agent:adopt-attempt` 转调 Coordinator；legacy B3 `agent:write-files` 仍直接
  `transactions.applyChanges`（`agent-tools-ipc.cjs:771-811`），**没有** status 检查。探针 OBS-4 实测：
  Coordinator 已提交后，经 `createAgentToolsIpc().invoke('agent:write-files', …)` 仍成功写入（revision 4、候选页被改），
  且 B3 `agent:cancel-run` 返回 `too-late` 而 Coordinator run 仍 `submitted`。该旁路不经 Coordinator，
  **若 E1 把 UI 接到 B3 写入面，会直接绕过提交后只读**。

### ⑤ 是否偷偷放宽 B1/B2 语义或新增通用 exec 通道 ——**未发现**

- `require` 面：`run-coordinator.cjs` 只 require `node:crypto/fs/path` + B1/B2/B4 模块，无 `electron`、无 `child_process`、
  无 `exec/spawn`（探针 P7 静态断言；测试 15 同口径）。`main.cjs` 无 `agent:*` 目录/命令类新通道。
- 复用而非复制：路径安全（`paths.cjs`）、工作区/attempt（`workspace.cjs`）、读写搜索（`files.cjs`）、
  事务/revision（`transactions.cjs`）、摘要/diff（`manifest.cjs`）、版本/采用（`versions.cjs`）、检查（`checks.cjs`）。
  Coordinator 只做编排与 subject/证据绑定。
- B1/B2 冻结码未私增：`CODES` 在 `constants.CODES` 之上只引用 §1.7 已列码（`run-coordinator.cjs:60-77`），
  `AGENT_VERIFICATION_MISSING`/`AGENT_CANCELLED`/`AGENT_PROJECT_MISMATCH`/`AGENT_PARTIAL_CONFIRM_REQUIRED`
  均在冻结文档 367–370 行的允许集合内；`EVIDENCE_STALE_RERUN_CHECKS` 只作 `issue.code`，envelope 码仍是 `AGENT_EVIDENCE_STALE`。
- 工具面：11 个模型工具、3 个平台专用名拒绝、`args` 白名单、`run_check.params` 平台字段拒绝（探针 P2/P7、测试 8）。
- 一处**报告措辞**不精确：t1 报告 §2.2 写“本文件没有新增 lstat/realpath/mkdir 安全逻辑”，实际
  `readVersionFile`/`readJsonBoundedFile`/`listRelativeEvidence` 有只读 `lstatSync`，证据目录用 `paths.ensureDirectory`；
  但没有第二套 canonical/realpath 算法（见 OBS-6）。不影响语义。

### ⑥ 是否有“看起来通过”的空断言 ——**t1 测试未发现；W2 用例中有 1 条（OBS-7）**

- 逐行读完 `test/agent-workspace.coordinator.test.cjs`（15 个 `test(`，827 行）：断言到具体码/字段/次数
  （如 `AGENT_ATTEMPT_IMMUTABLE`、`revision===2`、`treeDigest===buildManifest(...)`、`counters.calls` 不变、
  目录快照 `deepStrictEqual`），没有 `assert.ok(true)` 或“只要不抛异常”式断言；`assertNoPathLeak` 是对
  `JSON.stringify` 做真实子串断言（`test/agent-workspace.helpers.cjs:129-134`）。
- 静态接线用例（`:795-827`）虽为源码正则，但断言的是“require 一次/实例化一次/注入 checks+emitProgress/无
  electron/child_process/无 agent 目录通道”这些可反驳的具体事实，并已被探针 P7 用同一事实独立复验。
- **范围外**：`test/agent-workspace.vertical-chain.test.cjs:263-265` 的进度断言
  `assert.ok([...].includes(event.stage) || typeof event.stage === 'string')` 恒真（W2 文件，转 t15）。
- 测试替身边界：coordinator 用例的 `fakeChecks` 显式注明是测试替身（`:53-58`），并镜像真实平台契约
  （`definitions[checkId].subject` + dry-run `exportedRoot/exportTreeDigest`）；真实 Composer 垂直链在 W2 用例
  `vertical-chain` 中另有覆盖（随门禁 1 通过），未被当作 t1 的“真实检查证据”。

## 4. 独立探针（37/37 PASS + 4 条 OBS）

`node docs/evidence/workspace-agent/reviews/t14-probe.cjs` → **exit 0**，`SUMMARY checks=37 failures=0`。分组：

| 组 | 条数 | 覆盖 |
|---|---:|---|
| P1 | 2 | 无版本 → `AGENT_VERSION_NOT_FOUND`；`projects/` 零创建 |
| P2 | 14 | 从 v1 source 复制；run/attempt 元数据无 prompt/data URL；subject 固定；版本只读；写拒 version + 逃逸拒绝；revision/digest；submit F1 字段；提交后只读；重复提交；adopt→v2 |
| P3 | 2 | attempt 目录换 junction → 拒绝且链接目标零写 |
| P4 | 5 | 未提交/陈旧/partial 三码 + F4 优先级；adopt 后 too-late |
| P5 | 6 | 在途 cancel→requested→cancelled；迟到检查/写/direct 零落盘；幂等取消 |
| P6 | 3 | 伪造 projectId→`AGENT_PROJECT_MISMATCH` 零写；跨 run/turn 码表 |
| P7 | 5 | main.cjs 单例/无通用通道；coordinator 无 Electron/child_process；preload 20 语义命令 |

4 条 `OBS`（探针**不计入**退出码，原因见 §5）：

- `OBS-1` 在途 `invokeDirect` 取消：`cancel=requested`、方法返回 `ok:true`（与 `run-coordinator.cjs:1121-1123` 注释不符），run 最终 `cancelled`，零落盘。
- `OBS-2` `submission.json` 去掉 `exportTreeDigest` 后 adopt 仍成功（`adoptOk=true`，v2），与 §14.13-1“缺 `exportTreeDigest` 即不可 adopt”不符（t5/t15 范围）。
- `OBS-3` `read_file subjectOverride` 可读非 base 版本 v2（只读、零写），与 §14.3“只读 base 版本”的严格字面有偏差。
- `OBS-4` legacy B3 `agent:write-files` 在 Coordinator 已提交后仍写入成功（revision 4、候选页被改），B3 cancel 返回 `too-late` 而 Coordinator run 仍 `submitted`。

## 5. 观察与转派（均不影响 t1 verdict）

| ID | 级别 | 事实与证据 | 去向 / 建议 |
|---|---|---|---|
| OBS-1 | low | `invokeDirect` 在途取消返回原始结果，注释宣称丢弃；零落盘，direct 循环层每步重新 `assertRunActive` 并丢弃（`workspace-runtime.cjs:234-249,450-492`）；探针 OBS-1 | E0-V1（t8）确认“迟到模型结果不入 UI/trace”；若要收紧，改 `invokeDirect` 在 `finally` 前读 run 状态并返回 `AGENT_CANCELLED`（不属 t1 冻结 8 签名） |
| OBS-2 | medium | `adoptAttempt` 仅在 `submission.exportTreeDigest` 为字符串时校验（`run-coordinator.cjs:1955-1963`）；缺失时直接进入 partial/adopt → 实测 adopt 成功。§14.13-1 明确“缺 exportTreeDigest 即不可 adopt”。复现：提交后从 `verification/submission.json` 删除 `exportTreeDigest`/`exportRelative`，再 `adoptAttempt({partialConfirmed:true})` → `ok:true, adoptedVersionId:"v2"` | **t5/t15**：建议 adopt 在 `submission` 缺 `exportTreeDigest` 时返回 `AGENT_VERIFICATION_MISSING`（或 `AGENT_EVIDENCE_STALE`+rerun）并补负例用例；同时评估 W1 遗留 submission.json 的兼容策略 |
| OBS-3 | low | `readVersionFile` 只校验 versionId 形状与项目归属，不限制为本次 run 的 `baseVersionId`；实测 adopt 出 v2 后可读 v2（只读、零写） | E0-V1/rev16：若要求“只读 base”，加一条 `attempt.meta.baseVersionId` 比较即可；不改 B1/B2 |
| OBS-4 | medium | legacy B3 `agent:write-files` 无 status 检查，提交后仍直接 `applyChanges`（`agent-tools-ipc.cjs:771-811`）；`agent:cancel-run` 只看 B3 内存表（`:1334-1372`），不写 run.json。实测提交后 revision 4、候选页被改，B3 cancel=`too-late`、coordinator run 仍 `submitted`。W1 报告 §6-4 把“agent:* 统一转调”列为 W2 事项，W2 只做了 submit/adopt（`e0-w2/report.md:46`） | **E0-V1（t8）在判 X1“唯一执行所有者”前必须裁定**：要么把 B3 写入/取消面也转调 Coordinator（或在 E1 删除旧面），要么在 rev 中明确 B3 属非产品链并在 E1 隔离。t1 的 12 条验收只要求 main.cjs 单例/无通用 fs-exec/不泄漏目录，故本项不改变 t1 判定 |
| OBS-5 | info | 现行字节已含 W2 改动（`main.cjs` direct 惰性装配 + 真实 checks；coordinator 88 235 B）。t1 报告 §2.3/§5-8 的 `directRuntime: null`/B3 checks null 是历史事实 | 读取 t1 报告时以本文 §0 字节表为准；t8 复跑用 rev15 §14.13-6 钉版 |
| OBS-6 | info | t1 报告“本文件没有新增 lstat/realpath/mkdir 安全逻辑”不精确：有只读 `lstatSync` 与 `paths.ensureDirectory` 调用，但无第二套 canonical 实现 | 文档措辞建议改为“无第二套 canonical/realpath 实现”；无需改码 |
| OBS-7 | low | `vertical-chain.test.cjs:263-265` 进度断言含 `\|\| typeof event.stage === 'string'`，恒真 | **t15**：改为 `PROGRESS_STAGES.has(event.stage)`（W2 文件，t1 测试无此问题） |
| OBS-8 | info | “repair 建新 attempt”没有 Coordinator 入口：冻结 8 签名无 repair，当前只能 `startRun` 新 run（attempt-1）。新 run 不覆盖已提交候选，未违反 §14.2-4 的只读要求；但 t1 报告未显式登记该偏差 | E0-V1/E1：若需要“同 run 内 repair”，由 rev 增加签名；E0 垂直链的 issue→repair 仍在 open attempt 内完成，不阻塞 |

## 6. 结论

- **t14 / Review-t1：PASS**。t1 的 12 条验收在现行磁盘字节上全部成立；X1/X3 的**桌面 direct/Coordinator 路径**成立：
  唯一 run/turn/attempt 创建入口、subject 固定 attempt、写入只落 attempt、revision/treeDigest 一致、提交后只读、
  取消三态与迟到零落盘、句柄身份一致性、adopt 三分码。
- **不是 E0 验收结论**：本复核不判 X2/X4–X7/X9/X12，也不判真实模型/微信/UIA；E0 整体 verdict 仍归 E0-V1（t8）。
- **两条需要下游裁决的观察**（不改变 t1 判定）：
  - OBS-4：B3 legacy 写入面可绕过 Coordinator 的提交后只读——E0-V1 判 X1“唯一执行所有者”前必须裁定。
  - OBS-2：adopt 对缺失 `exportTreeDigest` 的 submission 未 fail-closed——t5/t15 修复或由 Captain 裁定为兼容项。
- 未修改被复核代码；本目录新增文件仅 `t14-probe.cjs` 与本文（`docs/evidence/workspace-agent/reviews` 在内 scope）。

## 7. 总计划 §0.3 模板汇报

```text
任务 ID：t14 / Review-t1（E0-W1 WorkspaceRunCoordinator 与 attempt 生命周期独立复核）
目标是否完成：YES（12 条验收全部 PASS；无阻塞 finding；4 条范围外观察转 t15/E0-V1，1 条文档措辞、1 条 repair 登记、2 条字节事实）
实际修改文件：
  - docs/evidence/workspace-agent/reviews/t1-review.md（本文）
  - docs/evidence/workspace-agent/reviews/t14-probe.cjs（独立探针，37/37，exit 0）
  - 未改 desktop/**、test/**、src/**、server/**、templates/**、miniprogram/**、contracts/**、package.json、docs/handoff/**
行为变化：无（只读复核；探针只在 os.tmpdir() 建临时 userDataDir）
新增测试：无（独立探针不接入产品测试；未改被复核测试）
执行命令与真实退出码：
  node --test --experimental-test-isolation=none "test/agent-workspace*.test.cjs" → exit 0（95/95）
  node --test --experimental-test-isolation=none test/agent-tools-ipc.test.cjs test/desktop-contract.test.cjs → exit 0（44/44）
  node -e "require('./desktop/agent-workspace/run-coordinator.cjs');console.log('run-coordinator ok')" → exit 0
  node docs/evidence/workspace-agent/reviews/t14-probe.cjs → exit 0（37/37）
真实模型/微信/UIA/安装包：NOT_RUN（全部离线；checks/direct 为显式测试替身；0 次真实调用）
关键结论：
  - startRun 从 currentVersionId 复制、无版本 AGENT_VERSION_NOT_FOUND 且零建目录、subject 固定 attempt、
    写入拒 version、read_file 版本只读、revision+1+treeDigest、提交后只读、取消三态、句柄身份一致性、adopt 三码：全部成立
  - main.cjs 单例一次接线、无通用 fs/exec、preload 仅 20 个语义命令、coordinator 无 Electron/child_process
  - 门禁独立复跑：agent-workspace 95/95、agent-tools-ipc+desktop-contract 44/44，均真实 exit 0（等价门禁 ≠ 官方 npm test）
  - 观察（不阻塞 t1）：B3 legacy agent:write-files 可绕过提交后只读；adopt 对缺 exportTreeDigest 的 submission 未 fail-closed；
    invokeDirect 在途取消返回原结果（零落盘）；read_file 版本 override 不限于 base
与计划的偏差：无（本任务只读；W1→W2 字节差异已登记 OBS-5）
剩余问题：OBS-4 → E0-V1 判 X1 前裁定；OBS-2 → t5/t15；OBS-1/OBS-3/OBS-8 → E0-V1/E1；OBS-7 → t15
下一任务是否可开始：就 t14 复核门禁而言 YES（t1 可采纳为 E0-W1 交付）；E0 整体仍须 t8 独立 PASS，E1–E4 不开放
```

## 8. 复现方式

```powershell
# 1) t14 验收门禁（真实退出码见 §1）
node --test --experimental-test-isolation=none "test/agent-workspace*.test.cjs"
node --test --experimental-test-isolation=none test/agent-tools-ipc.test.cjs test/desktop-contract.test.cjs
node -e "require('./desktop/agent-workspace/run-coordinator.cjs');console.log('run-coordinator ok')"

# 2) 独立探针（37/37，exit 0；打印 OBS-1..4）
node docs/evidence/workspace-agent/reviews/t14-probe.cjs
```
