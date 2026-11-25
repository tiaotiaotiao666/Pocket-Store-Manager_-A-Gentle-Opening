# t5 复核（Review-t5）：E0-W2 检查目标 / SourceBundle / submit 门禁 / adopt 证据

- 复核任务：**t15 / Review-t5**（独立验证工程师 verifier2，attempt 1，attempt_id `15a81b98-66ca-4317-ad21-a213c0ae7197`）
- 被复核任务：**t5 / E0-W2**（workspace-lead，attempt 2）
- 生成时间：2026-11-25 15:10（+08）
- 复核方式：**只读**被复核代码；以**最终磁盘字节**为准；不引用 t5 自带测试的“绿”当结论，
  另写 6 个独立探针（`t5-probe-*.cjs`，只写 `os.tmpdir()`，不写仓库）复验行为
- 判定对象：`rev15 §14.4/§14.5/§14.13`、t5 合同 16 条、verifier t10 的 F1–F4
- 本文件**不是 E0 终局 verdict**（归 t8/E0-V1）；E1–E4 仍不开放

---

## 0. 总计划 §0.3 模板

```text
任务 ID：t15 Review-t5（E0-W2 检查目标/bundle/submit/adopt 独立复核）
目标是否完成：NO（needs_revision）
  - X4 检查目标绑定（attempt 树/派生导出树、缺根不回落镜像）：**复核 PASS**
  - X5 8 页单一来源 + enabled 派生 + 非 menu 页可提交：**复核 PASS**
  - X6 source-bundle 平台派生、submit 不再派生、fail-closed：**复核 PASS**
  - X7 submit 门禁 / adopt 证据绑定：**协调器层 PASS，IPC 层 FAIL**
  - F1/F2/F3：**复核 PASS**；F4：**协调器层 PASS**，§14.13-1「缺 exportTreeDigest 即不可 adopt」**未落实（medium）**
  - 阻断项：`agent:submit-candidate` / `agent:adopt-attempt` 经真实 Coordinator 恒返回
    AGENT_ATTEMPT_NOT_FOUND（IPC 传数字 attemptId，Coordinator 只收 'attempt-N'）→ 渲染进程侧
    submit/adopt 完全不可用（blocker）

实际修改文件：无（复核方只写 docs/evidence/workspace-agent/reviews/ 与本目录的探针脚本）
行为变化：无（未改任何产品代码、未改 test/**、未改 docs/handoff/**）
新增测试：无新增产品测试；新增 6 个独立探针（t5-probe-chain / ipc-adopt / capabilities /
          identity / adopt-evidence / derive-closed），共 60 条断言。8 条 FAIL 中 4 条是探针
          自身口径错误/序列缺陷（已在 §3 标注并重测），4 条是真实产品缺陷：
          P3/P5（blocker）、S3（medium）、R4（low）
执行命令与真实退出码：
  1) node --test --experimental-test-isolation=none "test/agent-workspace*.test.cjs"
     → exit 0，tests 95 / pass 95 / fail 0（150.3s）
  2) node --test --experimental-test-isolation=none test/agent-tools-ipc.test.cjs
     test/desktop-contract.test.cjs test/composer-source-overlay.test.cjs
     → exit 0，tests 51 / pass 51 / fail 0（23.8s）
  3) node -e "require(4 个 agent-workspace 模块)" → exit 0，stdout `e0-w2 modules ok`
真实模型/微信/UIA/安装包证据：NOT_RUN（本轮为只读复核，未跑真实 Flash/微信/UIA/安装包）
与计划的偏差：无（复核范围按 t15 合同；不碰被复核代码）
剩余问题：F-T5-01（blocker）/ F-T5-02、03（medium）/ F-T5-04…09（low）/ F-T5-10（info）
下一任务是否可开始：t8/E0-V1 **不得**把本交付当作「X7 已关闭」；需先修 F-T5-01 并补
                  IPC→真实 Coordinator 端到端用例。X4/X5/X6 可按本文件结论引用。
```

---

## 1. 被测字节指纹（复核前后两次复算，一致）

报告 §7 与 rev15 §14.13-6 的钉版在这里**逐字命中**（`sha256` 前 8 位…后 6 位、bytes 全等）：

| 文件 | SHA-256 | bytes | mtime |
|---|---|---|---|
| `desktop/agent-workspace/run-coordinator.cjs` | `eedd1823efad27ed620a751788e031295756ce160a610545b283348d22cf36f2` | 88 235 | 11-25 01:49:06 |
| `desktop/agent-workspace/checks.cjs` | `7974b039fdde645524b83df6d6df3d09103855fbee537babf10dd11c67544a0c` | 31 313 | 11-25 01:49:34 |
| `desktop/agent-workspace/source-bundle.cjs` | `7cd641ea62248c4085b4ed04803c5e5aa8cc52d23639b6942392333aa7dfee0e` | 20 567 | 11-25 00:36:13 |
| `desktop/agent-workspace/direct-runtime.cjs` | `2b8fab79107f1e7162db810d0e8e3343e7f2ced64ecfa92f3cb34d6cb387b636` | 9 653 | 11-25 01:48:52 |
| `desktop/agent-tools-ipc.cjs` | `b35f0e6b27305c8b622254060cde15790783d1d277255b86623c03f7ca8badb4` | 70 939 | 11-25 01:49:44 |
| `desktop/main.cjs` | `481870ef515d6586b322613abf13f0f58f06e4aaf72778b7cf5ea59efb0c3d27` | 20 915 | 11-25 01:49:03 |
| `desktop/preload.cjs` | `4146d71c14fa0cc3f4719f881ef7b58e3b020005a695addb084c098d8aab0de4` | 9 042 | 11-25 00:46:27 |
| `scripts/agent-checks/run-check.cjs` | `3e2eb923d9b2fca70429974f44beb0180ad390bb507baa3872c00808cfb59866` | 13 425 | 11-25 00:38:11 |

- 复核开始（14:49）与结束（15:05）各复算一次，**8/8 字节不变**；结论只对上面这组摘要成立。
- `docs/evidence/workspace-agent/e0-w2/report.md` = `9d768435…dcadef`，29 261 B（与本目录 `t15` 启动快照一致）。

---

## 2. 门禁独立复跑（真实退出码，未用 `npm test`）

| # | 命令（与 t5 合同 verify 相同） | 真实退出码 | 结果 |
|---|---|---|---|
| 1 | `node --test --experimental-test-isolation=none "test/agent-workspace*.test.cjs"` | **0** | tests 95 / pass 95 / fail 0 / cancelled 0 / skipped 0，duration 150 312 ms |
| 2 | `node --test --experimental-test-isolation=none test/agent-tools-ipc.test.cjs test/desktop-contract.test.cjs test/composer-source-overlay.test.cjs` | **0** | tests 51 / pass 51 / fail 0，duration 23 845 ms |
| 3 | `node -e "require('./desktop/agent-workspace/{run-coordinator,checks,source-bundle,direct-runtime}.cjs')"` | **0** | stdout `e0-w2 modules ok` |

**“测试绿”不等于通过**（本轮阻断项正是全绿背后的盲区）：t5 的 IPC 用例把 Coordinator 整体替身为
stub（`test/agent-tools-ipc.test.cjs:624`），并且**显式断言**「attemptId 以数字编号交给 Coordinator」
（`:635`）；真实 Coordinator 只接受字符串 `attempt-N`（`run-coordinator.cjs:546`）。因此命令 2 的 51 绿
完全没有覆盖「IPC → 真实 Coordinator」这条接缝。

---

## 3. 独立探针（我自己的手法，不复用 t5 断言）

探针脚本已随本文件落盘（`docs/evidence/workspace-agent/reviews/t5-probe-*.cjs`，运行只写 `os.tmpdir()`）：

| 探针 | 覆盖 | 结果 |
|---|---|---|
| `t5-probe-chain.cjs` | 真实链路、检查主体记录、证据字段、submit 字节不变、F1、F2 负例、错误根负例、8 页派生、F3、IPC 桩 | 38 条：34 PASS / 4 FAIL（3 条为我自己的预期错误、1 条为序列缺陷；均已在 §3 末说明并重测） |
| `t5-probe-ipc-adopt.cjs` | **IPC → 真实 Coordinator 端到端** + F4 优先级 | 8 条：6 PASS / **2 FAIL（P3/P5，blocker 实证）** |
| `t5-probe-capabilities.cjs` | submit 缺 bundle 不得派生、subject 表、capabilities.check 独立性、别名归一 | 4 条全 PASS |
| `t5-probe-identity.cjs` | projectId ↔ 私有根一致性；PASS 证据缺 exportTreeDigest 的门禁口径 | 2 条：1 PASS / 1 FAIL（low 残留） |
| `t5-probe-adopt-evidence.cjs` | adopt 的导出树绑定（删证据/改摘要/缺摘要/树陈旧优先于 partial） | 4 条：3 PASS / **1 FAIL（S3，medium）** |
| `t5-probe-derive-closed.cjs` | overlay 越界/删页面/假图 fail-closed + 四态归一 | 4 条全 PASS |

### 3.1 关键实测值（原文摘录）

```text
A05 source.check 注册表实际收到的 root =
  <attempt>/candidate                     （absolute，且没有 exportRoot）
A08 dry-run  root=<attempt>/candidate，exportParentDir=<attempt>/verification，
     exportRelative=verification/dry-run，导出树含本次候选标记
A09 mini.check  exportRoot = <attempt>/verification/dry-run（不是仓库 miniprogram/）
A10 submit 前后：bundleSha 相同、整棵候选树 treeDigest 相同、revision 3→3（submit 未派生）
A11 F1 返回体：candidateId=attempt-1, revision=3, treeDigest=sha256:2f076a3e…,
    exportRelative=verification/dry-run, exportTreeDigest=sha256:d6d596d8…, targetPage=menu,
    status=submitted（exportRelative 非绝对路径，且等于 dry-run 证据值）
A12 未确认 partial → AGENT_PARTIAL_CONFIRM_REQUIRED + nextAction=confirm-partial；确认后 adopt 成功
B01 注册表无 definitions → AGENT_CHECK_UNKNOWN，runner 调用 0 次（message 明确点名 definitions）
B03/B05 导出树检查缺根 / 越界 root('../../../../miniprogram') / 绝对仓库 miniprogram 路径
    → 三种都 AGENT_CHECK_UNKNOWN，runner 0 次（不回落镜像）
B06 删掉 pages/mine/index.wxml → get_context 的 mine.enabled=false，原因
    「候选缺少 pages/mine/index.wxml」，其余 7 页仍 true
B07 checkout（非 menu）可走完整门禁并提交；目标页不一致/非法页 → AGENT_TARGET_PAGE_UNSUPPORTED
B08 写→检查→再写→submit → AGENT_EVIDENCE_STALE + issues[EVIDENCE_STALE_RERUN_CHECKS]
    + nextAction=rerun-checks；提交前后 source-bundle 字节与 revision 不变
P2  coordinator.submitAttempt({attemptId: 1}) → AGENT_ATTEMPT_NOT_FOUND（Coordinator 只收字符串）
P3  ipc('agent:submit-candidate', attemptId:'attempt-1') → AGENT_ATTEMPT_NOT_FOUND（blocker）
P4  直接 coordinator.submitAttempt(attemptId:'attempt-1') → ok，exportRelative=verification/dry-run
P5  ipc('agent:adopt-attempt', partialConfirmed:true) → AGENT_ATTEMPT_NOT_FOUND（blocker）
P6  直接 coordinator.adoptAttempt(attemptId:'attempt-1') → ok，adoptedVersionId=v2
P7b 已提交 + submission.treeDigest 被改 + 未确认 partial → AGENT_EVIDENCE_STALE（先于 partial）；
    dry-run 证据 exportTreeDigest 被改 → AGENT_EVIDENCE_STALE；
    正常未确认 → AGENT_PARTIAL_CONFIRM_REQUIRED + confirm-partial；确认后成功
S1  adopt 前删掉 checks/composer.dry-run.json → AGENT_EVIDENCE_STALE
S2  submission.exportTreeDigest 与 dry-run 不一致 → AGENT_EVIDENCE_STALE
S3  submission.json 缺 exportTreeDigest（伪造/旧证据）→ **adopt 仍然成功（违反 §14.13-1）**
S4  submission.treeDigest 陈旧 + 未确认 partial → AGENT_EVIDENCE_STALE + rerun-checks
R1  run 目录复制到另一个合法 projectId → AGENT_PROJECT_MISMATCH，副本零写入，候选树摘要不变
R4  mini.check 的 PASS 证据缺 exportTreeDigest → submit 仍成功（t10-F4 残留口径，仅篡改可达）
T1/T2/T3  写 services/**、删页面、假 png → 分别 SOURCE_BUNDLE_PATH_FORBIDDEN /
          SOURCE_BUNDLE_DELETE_FORBIDDEN / SOURCE_BUNDLE_ASSET_TYPE_INVALID（AGENT_STATIC_GATE_FAILED）
T4  未知状态 → NOT_RUN + CHECK_STATUS_UNKNOWN；EPERM → BLOCKED + CHECK_TOOL_MISSING
```

**探针自身的 4 条“FAIL”口径说明（避免被误读成产品缺陷）**：

1. `B-scenario-error`：我的 B09 用例把整页 WXML 替换成 `<view>f1</view>`，导致 `source.check` 真的
   FAIL（页面契约要求丢失），submit 因此没有写出 `submission.json`——**我的探针序列缺陷**；已用
   `t5-probe-adopt-evidence.cjs`（保留原内容再追加）重测，F4 优先级实测成立。
2. `C02/C06`：我把 stub Coordinator 回传的**数字** candidateId/attemptId 当成产品输出断言；
   它们恰好暴露了 F-T5-01 的类型错位，但这两条本身不作为产品判据（判据是 P3/P5）。
3. `C04`：我在 `agent:run-check` 里多传了 `turnId`（该命令 keys 不含 turnId），得到 `AGENT_PAYLOAD_INVALID`；
   去掉后单独复跑：attempt 级 checkId → `AGENT_CHECK_UNKNOWN` 且 runner 0 次，仓库级 → 跑 1 次。

---

## 4. t5 合同（16 条）逐条对照

| # | t5 验收条目 | 复核结论 | 依据 |
|---|---|---|---|
| 1 | `source.check` 真跑 `checkProject` 于 attempt 树；旧语义独立为 `capabilities.source-facts` | **PASS** | A05（记录到 root=候选树）、Q2（subject 表）、Q3/Q4（capabilities.check 独立 + 别名归一同一证据） |
| 2 | `composer.dry-run` 派生后导出到 `attempt/verification/dry-run`，返回相对引用与摘要；mini/output 只查该树 | **PASS** | A07/A08/A09；B05（三种错误根全拒） |
| 3 | `mini.check` 无 root → `AGENT_CHECK_UNKNOWN`，绝不回落 `miniprogram/` | **PASS** | B03（runner 0 次）、B05、D01（源码无 `REPO_ROOT/miniprogram` 默认根） |
| 4 | `deriveSourceBundle` diff 语义（完整内容摘要/deleted/components/assets）+ 派生后重算 treeDigest | **PASS** | A07（shape/targetPages/base.treeSha256）、T1/T2/T3（fail-closed）、A06（证据 treeDigest = 候选树摘要） |
| 5 | submit 静态门禁 + **F1 返回体**（六项、relative） | **PASS**（协调器层） | A11、B07、Q1（缺检查 → STATIC_GATE_FAILED 且不置 submitted） |
| 6 | **F3** 写→派生→检查→submit；陈旧 → `AGENT_EVIDENCE_STALE` + `EVIDENCE_STALE_RERUN_CHECKS` + `rerun-checks`，不得补派生 | **PASS** | B08（字节/revision 不变）、A10、Q1（缺 bundle 也不派生） |
| 7 | **F2** 缺 subject/root/definitions 先拒后跑（runner 0） | **PASS** | B01/B02（0 次）、B03、B04（模型给路径 0 次） |
| 8 | **F4** adopt 判 partial 前先判新鲜度 | **PASS**（协调器层，S4/P7b） | 优先顺序实测：树陈旧/导出摘要不一致都先 `AGENT_EVIDENCE_STALE`；正常路径才 `AGENT_PARTIAL_CONFIRM_REQUIRED` |
| 9 | 页枚举单一来源（禁用 v1 home/menu 常量），非法页 `AGENT_TARGET_PAGE_UNSUPPORTED` | **PASS** | A01、B07、D07（`PAGE_IDS = [...sourceFacts.PAGE_IDS]`）、D02（无 contract.generated TARGET_PAGES） |
| 10 | `get-context.targetPages = [{id,enabled,reasons}]` 派生、不硬编码 8 个 true | **PASS**（含注记 F-T5-08） | A02（协调器 8×true，来自候选树）、B06（删页→false+原因）、C07（IPC 无 attempt → 8×false+原因） |
| 11 | `run-check.data` 证据字段齐全；未知 → NOT_RUN；工具缺失 → BLOCKED | **PASS** | A06（checkId/status/treeDigest/subjectKind/attemptId/at/issues）、A11/A09（exportTreeDigest/exportRelative）、T4 |
| 12 | 新增 `agent:adopt-attempt` IPC 调 B2 adoptAttempt（读磁盘证据、校验摘要、三分码） | **FAIL（blocker）** | C01/C02/C03（通道存在、只转调、无 Coordinator 显式失败）但 **P3/P5：真实 Coordinator 下恒 `AGENT_ATTEMPT_NOT_FOUND`**，读不到任何磁盘证据 |
| 13 | Coordinator 句柄层强制 projectId ↔ 私有根一致（伪造/搬迁 → MISMATCH 且零落盘） | **PASS** | R1（AGENT_PROJECT_MISMATCH、副本零写入、候选树摘要不变） |
| 14 | main.cjs 惰性接线 direct；接线后 invokeDirect 不再 `AGENT_RUNTIME_TOOL_MISSING`，未接线仍显式 | **PASS** | A13/A14、D04、`createModelCredentials` 实测 `describe()={ready:true,hasTransport:true,defaultTransport:true}` |
| 15 | 测试覆盖矩阵（未检查不能 submit、旧树证据不能 adopt、缺 bundle 在 dry-run 补、写后再写要重跑、partial 确认、8 页、错误 mini 根、未知状态不归一 FAIL） | **部分 PASS**（F-T5-03/04/05/06） | 行为项均在；但 IPC 端到端缺失、F4 优先级用例口径不符、1 条断言恒真 |
| 16 | 无 UI 主进程垂直链（真实 Composer，fake model） | **PASS** | 门禁 1 中 `E0-W2 垂直闭环…（真实 Composer）` 8.27 s 通过；我另跑 A 链同源 |

---

## 5. X4 / X5 / X6 / X7 + F1–F4 判定

| 项 | 判定 | 一句话依据 |
|---|---|---|
| **X4** 检查目标=attempt/导出树 | **已关闭（复核）** | 记录到注册表的 root 就是候选树/本 attempt 的 dry-run 导出树；三种错误根全拒且 runner 0 次；仓库镜像永不被当根 |
| **X5** 8 页单一来源 | **已关闭（复核）** | `PAGE_IDS` 即 SourceFacts 数组；enabled 由候选文件派生（删页→false+原因）；非 menu 页可提交、非法页拒绝 |
| **X6** bundle 平台派生 | **已关闭（复核）** | 模型写假清单被覆盖；submit 前后字节/revision 不变；缺 bundle 的 submit 仍不派生（Q1）；三条 fail-closed 规则生效 |
| **X7** submit 门禁 + adopt 证据 | **未关闭（FAIL）** | 协调器层成立（A10/A11/S1/S2/S4）；但 **IPC 层 submit/adopt 恒失败**（F-T5-01），渲染进程拿不到 F1 返回体，也 adopt 不了 |
| **F1** submit 返回体 | 已落实 | A11 六项齐全；`exportRelative` 相对路径 |
| **F2** 缺参先拒后跑 | 已落实 | B01/B02/B03/B04 runner 均 0 次 |
| **F3** submit 不得派生 | 已落实 | A10、B08、Q1、D06 |
| **F4** 陈旧优先于 partial | 协调器层已落实；**测试口径不符**（F-T5-03） | S4/P7b 实测成立；t5 自己的“陈旧 adopt”用例期望的是 `AGENT_ADOPTION_FAILED`（未提交态），没覆盖 §14.13-F4 的组合 |

---

## 6. Findings（交 Captain 派修；我不改产品代码）

| ID | 严重度 | 位置 | 问题 | 必须的修复 |
|---|---|---|---|---|
| **F-T5-01** | **blocker** | `desktop/agent-tools-ipc.cjs:1155`、`:1208` ↔ `desktop/agent-workspace/run-coordinator.cjs:546` | IPC 把 `attempt-1` 解析成**数字 1** 交给 Coordinator（`attempt.attempt`），Coordinator 只接受字符串 `attempt-N`；实测 `agent:submit-candidate` 与 `agent:adopt-attempt` 在**真实** Coordinator 下恒返回 `AGENT_ATTEMPT_NOT_FOUND`（P3/P5），而直接调 Coordinator 同参数成功（P4/P6）。后果：渲染进程侧 submit 门禁、F1 返回体、adopt 三分码全部不可达；`test/agent-tools-ipc.test.cjs:635` 还把“数字 attemptId”写成了预期，堵住了这个接缝被发现的可能 | IPC 侧传 `'attempt-' + attempt.attempt`（或在 IPC↔Coordinator 之间加显式适配层）；**必须**补一条 IPC→真实 Coordinator（非 stub）的端到端用例：写→检查→`agent:submit-candidate` 成功含 F1 六项→`agent:adopt-attempt` 走三分码 |
| **F-T5-02** | medium | `run-coordinator.cjs:1955`（adopt 的 export 摘要校验） | `if (typeof submission.exportTreeDigest === 'string')` 让**缺 `exportTreeDigest`** 的提交证据直接跳过导出树校验；S3 实测这种证据（伪造/旧格式）在 `partialConfirmed:true` 下**adopt 成功**，与 §14.13-1「缺 `exportTreeDigest` 即不可 adopt」冲突 | 缺失/非字符串按陈旧处理（`AGENT_EVIDENCE_STALE` + `EVIDENCE_STALE_RERUN_CHECKS` + `rerun-checks`），并补用例 |
| **F-T5-03** | medium | `test/agent-workspace.vertical-chain.test.cjs:529-532`；报告 §3-F4、§7.5 | 该用例处在“submit 已失败、attempt 未提交”状态，实测只能得到 `AGENT_ADOPTION_FAILED`（NOT_SUBMITTED），却在注释里写成“adopt 先报陈旧（F4）”；报告把结论写成「陈旧场景返回 `AGENT_EVIDENCE_STALE`/`AGENT_ADOPTION_FAILED`」，等于用两个码掩盖了 F4 组合没被覆盖 | 新增“已提交 + 证据陈旧 + **未** `partialConfirmed` → `AGENT_EVIDENCE_STALE`（不是 `AGENT_PARTIAL_CONFIRM_REQUIRED`）”用例；报告按实际码改写 |
| **F-T5-04** | low | `test/agent-workspace.vertical-chain.test.cjs:264-265` | `assert.ok([...].includes(event.stage) || typeof event.stage === 'string')` 对任何字符串恒真 → progress stage 白名单**没有任何断言力**（emit 已把未知 stage 归一成 workspace） | 删除 `|| typeof ...`，改为“stage 必须 ∈ 白名单（rev15 §9.1+§14.9）” |
| **F-T5-05** | low | 同文件 `:212-218`、`:223` | `if (submission.partial) {…} else {…}` 与“非 partial 才重试 adopt”让用例在两个世界都通过；本机 `wechat.verify` 恒 BLOCKED 时并未钉死 `partial === true` | 断言 `submitted.partial === true`（并给原因：`wechat.verify` BLOCKED/NOT_RUN），删掉无意义的 else |
| **F-T5-06** | low | `test/agent-workspace.checks.test.cjs:142` | 期望值的第一个元素由实际值自己构造（`[seen[…]…args[0], '--check', …]`），自比较；退化为只验后两位 | 改断言 `args.slice(0,3)` 的首元素为固定值（`process.execPath` 或直接断言 dispatcher 路径） |
| **F-T5-07** | low | `run-coordinator.cjs:767-778`（`evaluateStaticGate`） | PASS 证据缺 `exportTreeDigest` 时静默视为一致（t10-F4 建议未落地）；R4 实测：把 `mini.check` 的 PASS 证据去掉摘要后 submit 仍成功（仅篡改证据可达，正常链路由 coordinator 补齐） | `entry.status === 'PASS' && !entry.exportTreeDigest && dryRunExportDigest` → 记 stale（fail-closed），补断言 |
| **F-T5-08** | low | `desktop/agent-tools-ipc.cjs:664` | `agent:get-context` 无 attempt 上下文，`enumerateTargetPages({})` 恒得 8×false（原因“候选树未提供”）。它是“派生而非硬编码”，但 UI 若用该命令画页面选择器会全部灰掉；报告 §2.5 只写“由 … 派生”，未说明退化结果 | 报告如实注明；E1 接线时该命令要么带 attempt 上下文，要么明确由 coordinator 的 `get_context` 供页面选择器 |
| **F-T5-09** | low | `docs/evidence/workspace-agent/e0-w2/report.md` §8 | 复跑指引写“期望 exit 0 / **87 pass**”，实测（与 §1 自述）是 **95 pass**；§8 的模块加载命令还漏了 `source-bundle.cjs`/`direct-runtime.cjs`（§1 有） | 改成 95，并把 §8 第 3 条与 §1 对齐 |
| **F-T5-10** | info | `source-bundle.cjs:203-220`、`PAGE_IDS` 顺序 | ① 8 页顺序与 §14.5 列举顺序不同（取 SourceFacts 顺序，属单一来源，非缺陷）；② 注释称“四件套”，实际只查 `index.json`+`index.wxml` | 注释与实现对齐（或补齐四件套判定），顺序问题在 rev16 一并说明 |

**没有发现缺陷、已被我独立证实的点**（避免重复排查）：检查主体绑定、导出树绑定、submit 不派生、
F1/F2/F3、F4 协调器层优先顺序、capabilities.check 独立性/别名、四态归一、三条派生 fail-closed、
projectId↔私有根一致性、direct 惰性接线（含真实 `modelCredentials` 具备 `chat`）。

---

## 7. 逐文件清单与越界写入核对

- **t5 窗口（11-25 00:25–02:10）内 `desktop/`、`scripts/`、`test/` 的全部改动**与报告 §0 清单逐项对上：
  `source-bundle.cjs`(00:36)、`run-check.cjs`(00:38)、`preload.cjs`(00:46)、`desktop-contract.test.cjs`(00:47)、
  `agent-tools-ipc.test.cjs`(00:55)、`bundle.test.cjs`(00:56)、`direct-runtime.cjs`(01:48)、`main.cjs`(01:49)、
  `run-coordinator.cjs`(01:49)、`checks.cjs`(01:49)、`agent-tools-ipc.cjs`(01:49)、`direct-runtime.test.cjs`(01:49)、
  `checks.test.cjs`(01:53)、`vertical-chain.test.cjs`(01:54)、`coordinator.test.cjs`(01:59)。
- 同期其余改动均**可归属其他 owner**，不属于 t5 越界：
  `desktop/model-call-scheduler.cjs`+`test/model-call-scheduler.test.cjs`（runtime-engineer/t2）、
  `desktop/agent-runtime/**`、`desktop/model-ipc.cjs`、`desktop/model-credentials.cjs`（runtime-engineer/t6）、
  `scripts/e0-verify/**`（verifier）、`src/components/agent/e0/**`、`test/e0-ui*`（product-ui）。
- **outOfScope 目录**（`src/**`、`server/**`、`templates/**`、`miniprogram/**`、`contracts/**`、`package.json`）：
  t5 窗口内无可归属 t5 的写入。窗口内出现的 `server/dist/**`、`server/src/agent/agent-guard-rails.ts`、
  `server/test/b2-desktop-session-and-rails.test.ts`（01:10–01:22）属 E0-R1b（runtime-engineer），
  `docs/handoff/Workspace-Agent-B阶段接口冻结.md`（02:17）属 Captain 的 rev15 §14.13。
- 报告 §7 的 8 个 sha256/bytes 与我的复算**全等**（见 §1）；t1 版 `run-coordinator.cjs`
  （85 904 B / `232F24F2…`）确已被 88 235 B 版取代。
- 我本轮的写入仅为 `docs/evidence/workspace-agent/reviews/**`（本文件 + 6 个探针脚本），仓库产品代码零改动。

---

## 8. 复现

```powershell
# 1) 钉摘要（与 §1 比对；不一致则本文件作废）
Get-FileHash desktop/agent-workspace/run-coordinator.cjs, desktop/agent-workspace/checks.cjs,
  desktop/agent-workspace/source-bundle.cjs, desktop/agent-workspace/direct-runtime.cjs,
  desktop/agent-tools-ipc.cjs, desktop/main.cjs, desktop/preload.cjs,
  scripts/agent-checks/run-check.cjs -Algorithm SHA256

# 2) 两条门禁（真实退出码）
node --test --experimental-test-isolation=none "test/agent-workspace*.test.cjs"
node --test --experimental-test-isolation=none test/agent-tools-ipc.test.cjs test/desktop-contract.test.cjs test/composer-source-overlay.test.cjs

# 3) 我的独立探针（只写 os.tmpdir()；脚本内 REPO 常量为本机绝对路径）
node docs/evidence/workspace-agent/reviews/t5-probe-chain.cjs
node docs/evidence/workspace-agent/reviews/t5-probe-ipc-adopt.cjs      # P3/P5 = blocker 实证
node docs/evidence/workspace-agent/reviews/t5-probe-capabilities.cjs
node docs/evidence/workspace-agent/reviews/t5-probe-identity.cjs
node docs/evidence/workspace-agent/reviews/t5-probe-adopt-evidence.cjs # S3 = medium 实证
node docs/evidence/workspace-agent/reviews/t5-probe-derive-closed.cjs
```

最小 blocker 复现（10 行内，独立于我的探针）：

```js
// 真实 Coordinator + 真实 attempt，经 IPC 提交
const coordinator = createRunCoordinator({ userDataDir, checks: createCheckRegistry({ userDataDir }) });
// …startRun → write_files → run_check source.check → composer.dry-run → mini.check…
await ipc.invoke('agent:submit-candidate', { projectId, runId, turnId, attemptId: 'attempt-1', targetPage: 'menu' });
// → { ok:false, code:'AGENT_ATTEMPT_NOT_FOUND', message:'attemptId 非法或不存在' }
// 同参数直接 coordinator.submitAttempt({ ..., attemptId:'attempt-1' }) → ok，含 F1 六项
```

---

## 9. 未覆盖 / 不做背书

- 真实 DeepSeek Flash 往返、真实微信开发者工具、UIA 无障碍走查、安装包：**NOT_RUN**（属 t8/E0-V1 与 E1–E4）。
- `direct-runtime` 的真实话术/工具循环/多模态图片：不在本复核范围（t6/t7/t8）；本轮只确认
  “惰性接线后 `invokeDirect` 不再 `AGENT_RUNTIME_TOOL_MISSING`”这一条（A13/A14）。
- 服务端副本（X9）与 `agent-runtime` 侧（X8/X2）：不属 t5，也不在本文件背书范围。

---

## 10. 结论

**t5 复核结论：FAIL / needs_revision。**

- X4、X5、X6 以及 F1–F3、F4（协调器层）**经我独立探针实测成立**，可按本文件引用为“已完成”。
- **X7 不能记“已关闭”**：`agent:submit-candidate`/`agent:adopt-attempt` 在真实 Coordinator 下恒
  `AGENT_ATTEMPT_NOT_FOUND`（F-T5-01），渲染进程侧提交门禁、F1 返回体、adopt 三分码均不可达；
  t5 的 95/51 全绿只覆盖了 stub Coordinator，属“测试绿 ≠ 通过”。
- 另有 §14.13-1 的 adopt 边界缺口（F-T5-02）与若干“为让用例过而放宽/恒真断言”（F-T5-03…06）。
- 修完 F-T5-01（+ F-T5-02/03）并补 IPC→真实 Coordinator 端到端用例后，请 re-review；t8/E0-V1
  在此之前不要把 t5 作为 X7 关闭的证据。E1–E4 继续不开放。
