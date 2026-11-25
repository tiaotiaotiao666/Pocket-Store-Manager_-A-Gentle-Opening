# E0-V1b 增量：t5（E0-W2 / X4·X5·X6·X7·F1–F4·direct 接线）独立复核

> 任务：**t11 / E0-V1b**（独立验证工程师 verifier3，attempt 4，attempt_id `0cd93b3d-20e7-4fda-8d0b-11fe3c2b2e6b`）。
> 被复核：**t5 / E0-W2**（workspace-lead，attempt 2）。
> 依据：`docs/handoff/Workspace-Agent-B阶段接口冻结.md` **rev15** §14.4/§14.5/§14.7/§14.12/§14.13；`plan.md` §2（V04–V07）、§5（A01–A10/A49/A11O）；`attacks.md`。
> 执行器：`scripts/e0-verify/chains/workspace-w2.cjs`（W01–W17）、`scripts/e0-verify/attacks/b1-b2.cjs`（A11O 重写）。
>
> **本文只判 t5 的两个增量片段（E0-V1b），不出 E0 终局 verdict。** E0 通过与否只由 t8/E0-V1 在 X1–X12 全部关闭后出具。
> 真实模型 / 微信 / UIA / 安装包：**NOT_RUN**（本任务为只读复核，未跑真实 Flash/微信/UIA）。

---

## 0. 总计划 §0.3 模板

```text
任务 ID：t11 E0-V1b（t5/E0-W2 独立复核：X4/X5/X6/X7 + F1–F4 + direct 接线）
目标是否完成：NO（FAIL：X6 与 X7 仍有交付缺陷；t5 钉版字节在复核期间被 t22 修复改动，结论只对钉版成立）
  - A11O 复核（X4）：source.check 真跑 attempt 候选树；composer.dry-run 输入=attempt、导出树=attempt/verification/dry-run；
    mini/output 只查派生导出树；capabilities.check 独立 repo 级 —— **复核 PASS**
  - X5（8 页单一来源 + 非 menu 页提交 + targetPages 派生）：**复核 PASS**
  - X6（bundle 平台派生 / submit 不派生 / 逐字节不变 / deleted 显式）：**PASS（W07/W08/W16）**，
    但「模型不写摘要清单」**未闭**（W17：模型自写清单被平台原样接受）→ **X6 不能记关闭**
  - X7（submit 门禁 / F1–F4 / 三分码 / 证据绑定）：**FAIL**（W13/W14 在钉版上实测失败；W14 在修复后仍失败）
  - 句柄身份（伪造 projectId / 搬迁 run / 伪造 turn·attempt）：**复核 PASS**
  - direct 接线（惰性接线 / 接线后成功 / 未接线显式码）：**复核 PASS**
  - 钉版 sha256+bytes：8/8 在复核开始时命中；**复核期间 3 个产品文件被 t22 修复改动**（见 §1.2），本文结论只对 §1.1 的字节成立
实际修改文件：只写 `scripts/e0-verify/**` 与 `docs/evidence/workspace-agent/e0-v1/**`；产品代码零改动
行为变化：无（新增/加强验证器用例 W01–W17、重写 A11O 观察项）
新增测试：W01–W17（`chains/workspace-w2.cjs`，无 UI、临时 userData、只读产品模块）
执行命令与真实退出码：
  1) node scripts/e0-verify/run.cjs --mode offline
     → **exit 1**（钉版字节，2026-11-25T06:57:06Z / 本地 14:57）：PASS 55 / FAIL 3 / NOT_RUN 62 / BLOCKED 0（合计 120）
       FAIL = W13、W14、W15
  2) node --test --experimental-test-isolation=none "test/agent-workspace*.test.cjs" test/agent-tools-ipc.test.cjs
     test/desktop-contract.test.cjs test/composer-source-overlay.test.cjs
     → **exit 0**（146 tests / 146 pass / 0 fail；但该次执行已落在 §1.2 漂移窗口内，**不绑定钉版字节**）
  3) node scripts/e0-verify/run.cjs --mode offline --only W13,W14,W15 → exit 1（钉版：3 FAIL）
  4) node scripts/e0-verify/run.cjs --mode offline（漂移后混合态）→ exit 1；PASS 73 / FAIL 2 / NOT_RUN 47（合计 122），FAIL = W14、W17
真实模型/微信/UIA/安装包证据：NOT_RUN
与计划的偏差：计划原写「A11O 只观察」；t5 后 A11O 已重写为「缺平台派生根先拒」的事实登记（不再声称 X4 未关闭），X4 绑定判定由 W01–W04 承担
剩余问题：F-V3W2-01（high，F1 adopt 边界）/ 02（medium，partial 信任）/ 03（low，导出级证据完整性）/
          04（medium，模型自写清单） / 05（low，别名清理）
下一任务是否可开始：**t8/E0-V1 不得把 t5 钉版当作 X6/X7 已关闭的证据**。t22 已修掉 F-V3W2-01、03（漂移后复测 W13/W15 PASS），
          但 F-V3W2-02、04 仍成立；须补修后对**稳定 revision**重跑 W 组并把新 sha256 写进结论头。
```

---

## 1. 被测字节（钉版）与复核期间的漂移

### 1.1 钉版（复核开始时复算，与 rev15 §14.13-6 及 t5 报告一致）

| 文件 | sha256 | bytes |
|---|---|---|
| `desktop/agent-workspace/run-coordinator.cjs` | `eedd1823efad27ed620a751788e031295756ce160a610545b283348d22cf36f2` | 88 235 |
| `desktop/agent-workspace/checks.cjs` | `7974b039fdde645524b83df6d6df3d09103855fbee537babf10dd11c67544a0c` | 31 313 |
| `desktop/agent-workspace/source-bundle.cjs` | `7cd641ea62248c4085b4ed04803c5e5aa8cc52d23639b6942392333aa7dfee0e` | 20 567 |
| `desktop/agent-workspace/direct-runtime.cjs` | `2b8fab79107f1e7162db810d0e8e3343e7f2ced64ecfa92f3cb34d6cb387b636` | 9 653 |
| `desktop/agent-tools-ipc.cjs` | `b35f0e6b27305c8b622254060cde15790783d1d277255b86623c03f7ca8badb4` | 70 939 |
| `scripts/agent-checks/run-check.cjs` | `3e2eb923d9b2fca70429974f44beb0180ad390bb507baa3872c00808cfb59866` | 13 425 |
| `desktop/preload.cjs` | `4146d71c14fa0cc3f4719f881ef7b58e3b020005a695addb084c098d8aab0de4` | 9 042 |
| `desktop/main.cjs` | `481870ef515d6586b322613abf13f0f58f06e4aaf72778b7cf5ea59efb0c3d27` | 20 915 |

复核开始（14:48）复算 **8/8 命中**。本文 §2–§5 的 **PASS/FAIL 判据只对上面这组字节成立**（除非另注“漂移后”）。

### 1.2 复核期间的漂移（不是我的改动；必须重跑）

复核过程中（14:59–15:02）**t22 / repair-round-2** 正在修 t15 的 finding，产品文件被并发改写：

| 文件 | 漂移后 sha256（前 16 位） | bytes | mtime |
|---|---|---|---|
| `desktop/agent-workspace/run-coordinator.cjs` | `ae670806da313f95…` | 89 072 | 14:59:29 |
| `desktop/agent-workspace/source-bundle.cjs` | `20386ef2b130cfac…` | 20 729 | 14:59:32 |
| `desktop/agent-tools-ipc.cjs` | `9fbee683b117dd0b…` | 75 472 | 15:02:15 |

同时 **verifier4**（t8）在写共享验证器 `scripts/e0-verify/chains/vertical.cjs`（15:00:31）、`scripts/e0-verify/attacks/e0.cjs`（15:03:16）。

后果与处置：

1. 我在 14:57 完成的**钉版全量运行**（55/3/62/120，exit 1）是 §1.1 字节上的有效证据；其 `run-report.json`
   随后被 15:04 的混合态运行覆盖（当前文件 counts=73/2/47/122，含 verifier4 新增的 V 组执行体），
   **当前 `run-report.json` 不得当作 t5 钉版证据**。钉版的逐用例事实记录在本文 §3–§6。
2. 漂移后重跑显示：W13、W15 已由 t22 修复通过；W14、W17 仍 FAIL（见 §6 F-V3W2-02/04）。
   由于该次运行期间 `agent-tools-ipc.cjs`（15:02:15）、`attacks/e0.cjs`（15:03:16）仍在变，
   **漂移后结果只作定性观测，不作任何 revision 的正式判据**。
3. 任何后续变更都必须重跑；t8 应等 t22 收口后对稳定 revision 整体重跑 C/W/V 组并把最终 sha256 写进结论头（rev15 §14.13-6）。

---

## 2. A11O 复核（X4：检查目标绑定）— 每项命令与真实输出

执行器：`scripts/e0-verify/chains/workspace-w2.cjs`；全部用**真实 checks 注册表 + 真实检查编排/子进程**（零替身）；
只有“观察平台入参”处使用“记录请求后转交真实实现”的包装（不替换判定）。

| # | 命令 | 真实结果 | 关键观测 |
|---|---|---|---|
| W01 | `node scripts/e0-verify/run.cjs --mode offline --only W01`（或全量） | **PASS** | 注册表收到 `source.check.root=<attempt>/candidate`、`subjectKind=attempt`、无 `exportRoot`；在候选里埋非法 JSON 后 `status=FAIL`、`issues[].file=pages/menu/index.json`；同一文件在 `versions/v1/source` 仍是合法 JSON（证明查的是 attempt，不是仓库/版本） |
| W02 | `… --only W02` | **PASS** | `composer.dry-run` 的 `root=<attempt>/candidate`、`exportParentDir=<attempt>/verification`；`exportRelative=verification/dry-run`（精确相等）；导出树含本次 attempt 标记；仓库 `miniprogram/` 指纹不变；**没跑 source.check 时 dry-run 自己补派生 bundle**（§14.13-F3 的合法派生位置） |
| W03 | `… --only W03` | **PASS** | 未跑 dry-run 时 `mini.check → AGENT_CHECK_UNKNOWN` 且注册表 **0 次**调用；跑过后 `exportRoot=<attempt>/verification/dry-run`、`subjectKind=export`、`exportTreeDigest` 与 dry-run 相等；删掉导出树后再查仍 `AGENT_CHECK_UNKNOWN`（不回落仓库镜像） |
| W04 | `… --only W04` | **PASS** | `source.check.script=scripts/frontend-source/check.cjs`（subject=attempt）与 `capabilities.check.script=scripts/frontend-capabilities.cjs`（subject=repo）**不是同一实现**；`run_check(capabilities.check)` 的请求**不带** root/exportRoot/subjectKind；别名 `capabilities.source-facts` 仍存在（清理项 F-V3W2-05） |
| A11O | `… --only A11O` | **PASS**（重写后） | 直接调注册表且**不传平台派生根**：`source.check`/`composer.dry-run` 均先拒 `AGENT_CHECK_UNKNOWN`，runner **0 次** → t5 前“source.check 查仓库、dry-run 查已采用版本”的缺陷行为已消失。A11O 只登记此事实，不单独判 X4 |

> 结论：**A11O 复核 PASS**。`source.check` 在 attempt 树执行（不再“不带 `--root` 查仓库”）；dry-run 输入是当前 attempt、
> 导出树固定落 `attempt/verification/dry-run`；mini/output 只查本 attempt 派生导出树；capabilities.check 独立 repo 级、不冒名。

---

## 3. X5：8 页单一来源

| # | 断言 | 结果 | 真实观测 |
|---|---|---|---|
| W05 | `get_context.targetPages` 为 `{id,enabled,reasons}` 派生；`PAGE_IDS` 逐项等于 `scripts/agent-source-facts.cjs#PAGE_IDS`；每页有 `PAGE_CONTRACTS` | **PASS** | 8 页顺序 `home,menu,checkout,orders,order-detail,product-detail,mine,merchant-orders`；删除候选 `pages/mine/index.{json,wxml}` 后 `mine.enabled=false`、reasons=`候选缺少 pages/mine/index.json / …wxml`（其余页不受影响）→ 不是 8 个硬编码 true |
| W06 | 非 menu 页（home）真实链路提交；非法页、与 run 目标页不一致的 submit | **PASS** | `startRun(targetPage=not-a-page) → AGENT_TARGET_PAGE_UNSUPPORTED`；`submit(targetPage=menu)`（run 目标是 home）→ 同码；home 页 source.check+dry-run PASS 后 `submit.status=submitted`、`targetPage=home`、`exportTreeDigest=dry-run 摘要` |

结论：**X5 复核 PASS**（页枚举单一来源、派生、非 menu 页可提交、非法页拒绝）。

---

## 4. X6：SourceBundle 平台派生与不可变

| # | 断言 | 结果 | 真实观测 |
|---|---|---|---|
| W07 | 检查阶段平台派生 `frontend-source-bundle.v1`；`files` = 最终完整文件摘要（每项 sha256 等于候选真实字节、只列 Base→候选改动、不含自身）；`base.treeSha256` 存在；submit 前后逐字节不变 | **PASS** | `fileCount=1`（只列本次改动的 `pages/menu/index.wxml`）、`bundleSha256Head=11c87a112cf24ae8`；检查前后与 submit 前后 bundle 字节相同、`revision/treeDigest` 不变 |
| W08 | 未检查就 submit → 拒绝且**不派生**；bundle 由检查阶段补派生后链路可提交 | **PASS** | `submit → AGENT_STATIC_GATE_FAILED`、候选目录指纹不变、bundle 仍不存在；随后 `source.check` 派生 bundle、dry-run PASS 后 `submit=submitted` |
| W16 | `deleted` 显式：删 `assets/**` 必须列入 `deleted` 且不进 `files`；`files` 摘要=候选真实字节；模型调 `derive_source_bundle` → `AGENT_TOOL_NOT_ALLOWED` 且候选不变 | **PASS** | 删除 `assets/tabbar/home-active.png` 后 `bundle.deleted=["assets/tabbar/home-active.png"]`、`files` 不含它；模型调用返回 `AGENT_TOOL_NOT_ALLOWED`，摘要未变 |
| W17 | **模型自写 `source-bundle.json`（files 摘要与候选一致，但 base.treeSha256 / deleted 是编的）** 后跑 source.check：平台必须重派生或拒绝 | **FAIL（漂移后字节）** | 平台**原样保留**模型清单、未重派生 → 模型控制摘要清单（X6「模型不写摘要清单」未闭）。钉版 `source-bundle.cjs:412-444`（14:48 读取）的 `bundleIsStale` 只校验 `schemaVersion`/`base.treeSha256` 是否为字符串/`files` 摘要，**不校验** `base` 身份、`deleted`、`components`、`assets`；t22 漂移后实测仍未改 → 见 F-V3W2-04 |

结论：**X6 主体 PASS（W07/W08/W16），但“模型不写摘要清单”未闭（W17）→ X6 不能记“已关闭”**。

---

## 5. X7：submit 静态门禁 / 证据绑定 / 三分码 / F1–F4

### 5.1 通过项（钉版字节实测）

| # | 断言 | 结果 | 真实观测 |
|---|---|---|---|
| C08 | **F1** submit 成功返回六项 + `status="submitted"`；`exportRelative` 相对；提交后只读/重复提交/取消 too-late | **PASS** | `candidateId=attempt-1`、`revision`、`treeDigest`、`exportRelative=verification/export-tree`（桩导出）、`exportTreeDigest=sha256:d…`、`targetPage=menu`、`status=submitted`；写→`AGENT_ATTEMPT_IMMUTABLE`；重复 submit→`AGENT_RUN_ALREADY_SUBMITTED`；cancel→`too-late` |
| C09 | **§14.12-1 三分码不得互相顶替** | **PASS** | 未提交→`AGENT_ADOPTION_FAILED`+`issues[NOT_SUBMITTED]`；摘要被改→`AGENT_EVIDENCE_STALE`；partial 未确认→`AGENT_PARTIAL_CONFIRM_REQUIRED`，确认后 adopt v2 |
| C15 | **F2** 缺 `definitions` 先拒后跑 | **PASS** | `source.check`/`composer.dry-run` → `AGENT_CHECK_UNKNOWN`，**runner 调用 0 次**；submit 仍 `AGENT_STATIC_GATE_FAILED`，全程不抛异常 |
| C17 | **F3** 写→检查→再写→submit | **PASS** | `AGENT_EVIDENCE_STALE` + `issues=[EVIDENCE_STALE_RERUN_CHECKS]` + `nextAction=rerun-checks`；候选目录零写入、attempt 仍 open、无 submission 证据 |
| C09② | **F4** 陈旧优先于 partial | **PASS** | 已提交 + `submission.treeDigest` 被改 + 未确认 partial → `AGENT_EVIDENCE_STALE`（不是 `AGENT_PARTIAL_CONFIRM_REQUIRED`） |
| W09 | 句柄与身份 | **PASS** | 伪造 `projectId` → `AGENT_RUN_NOT_FOUND`；伪造 attempt → `AGENT_ATTEMPT_NOT_FOUND`；跨 turn → 同码；把 A 的 run 目录搬进 B 后用 B 身份 → **`AGENT_PROJECT_MISMATCH`**，B 侧副本零写入、A 摘要不变 |
| W13 | **§14.13-F1**「缺 `exportTreeDigest` 即不可 adopt」 | **FAIL（钉版）** | 提交后从 `verification/submission.json` 删掉 `exportTreeDigest`，`adoptAttempt(partialConfirmed:true)` **仍然成功并生成 v2**（钉版 `run-coordinator.cjs:1955` 的 `if (typeof submission.exportTreeDigest === 'string')` 使缺字段直接跳过导出树校验）→ **F-V3W2-01** |
| W14 | adopt 的 partial 判定必须看运行时证据，不能只信 `submission.json.partial` | **FAIL（钉版 + 漂移后）** | 把 `submission.partial` 改成 `false`、不传 `partialConfirmed`，adopt **仍然成功生成 v2**（wechat.verify 本机恒 BLOCKED/NOT_RUN，证据里没有任何 PASS 运行时证据）→ **F-V3W2-02** |
| W15 | 导出级 PASS 证据缺 `exportTreeDigest` 不得被当成完整 PASS（A15“缺字段不参与门禁”） | **FAIL（钉版）/ PASS（t22 后）** | 钉版：`submit` 直接给出 `partial=false` 的 submitted（缺摘要的 mini.check 证据被当成完整证据）；t22 漂移后重测改为 `AGENT_EVIDENCE_STALE`（已修）→ 与 t15 的 F-T5-07 同一问题，见 F-V3W2-03 |

> 说明：W13/W14/W15 的装配方式都是 A04 式“篡改/删除 `verification/**` 证据”攻击（rev15 攻击清单明确包含手写证据场景）；
> 不是靠改产品代码或替身。W15 中的 `wechat.verify` PASS 证据是**用例内模拟写入**，只为隔离“导出级证据完整性”一个变量，
> **不代表微信运行时通过**（本机 wechat.verify 恒 BLOCKED）。

### 5.2 direct 接线（X7/§14.7）

| # | 断言 | 结果 | 真实观测 |
|---|---|---|---|
| W10 | `main.cjs` 懒装配 `direct-runtime`（getter + 主进程唯一凭据） | **PASS** | 含 `require('./agent-workspace/direct-runtime.cjs')`、`createDirectWorkspaceRuntime({ coordinator: () => workspaceRunCoordinator, credentials: modelCredentials })`、`directRuntime:`；无目录/命令入口 |
| W11 | 接线后 `invokeDirect` 正常返回、请求有界 | **PASS** | `describe().ready=true`；`invokeDirect → ok:true`、`content`/`finishReason=stop` 来自下游；上游请求无绝对路径/密钥；含绝对路径的请求被拒（`AGENT_PAYLOAD_INVALID`）且上游 0 调用 |
| W12 | 未接线 / 无 transport / 未配凭据仍显式 | **PASS** | 三条路径均 `AGENT_RUNTIME_TOOL_MISSING`，无空成功 |

---

## 6. Findings（交 Captain 派修；我不改产品代码）

> 与 t15 的关系：t15（verifier2）已就 F-T5-02（adopt 缺 exportTreeDigest）与 F-T5-07（导出级证据完整性）出过 finding 并触发 t22。
> 本轮**独立复现**了这两条（W13/W15，钉版 FAIL），并新增 **W14、W17** 两条 t15 未列出的缺口。t22 漂移后复测：W13/W15 已修，W14/W17 仍失败。

| ID | 严重度 | 位置 | 问题 | requiredFix |
|---|---|---|---|---|
| **F-V3W2-01** | high | `desktop/agent-workspace/run-coordinator.cjs:1955`（钉版） | **F1 adopt 边界未闭合**：`submission.json` 缺 `exportTreeDigest` 时，`if (typeof … === 'string')` 让整个导出树校验被跳过；`adoptAttempt(partialConfirmed:true)` 仍采用并生成 v2，直接违反 rev15 §14.13-1「缺 `exportTreeDigest` 即不可 adopt」。W13 在钉版 FAIL；t22 后复测已 PASS（W13） | 缺/非字符串一律按陈旧处理：`AGENT_EVIDENCE_STALE` + `EVIDENCE_STALE_RERUN_CHECKS` + `nextAction:"rerun-checks"`；补「删除 submission.exportTreeDigest → adopt 必须被拒且 versions/ 不变」用例（t22 已在做，请保留回归） |
| **F-V3W2-02** | medium | `desktop/agent-workspace/run-coordinator.cjs:1964`（钉版与 t22 后相同） | **adopt 只信 `submission.partial`**：把该字段改成 `false` 后，未传 `partialConfirmed` 的 adopt 直接成功（W14）。实际运行时证据（wechat.verify）本机为 BLOCKED/NOT_RUN，§14.5 要求此时必须显式确认。威胁模型依据 A04（`verification/**` 可被手写/篡改） | adopt 时从 `verification/checks/**` 重新判定运行时证据（`wechat.verify` 缺失/BLOCKED/NOT_RUN ⇒ partial），不能只信 `submission.partial`；补 W14 回归。若 Captain 认定 `submission.json` 属不可篡改信任根，请明示降级为 info 并写进 rev16，否则按当前合同必须 fail-closed |
| **F-V3W2-03** | low | `desktop/agent-workspace/run-coordinator.cjs:767-778`（钉版 `evaluateStaticGate`） | **导出级 PASS 证据缺 `exportTreeDigest` 被当成完整证据**：篡改 `mini.check` PASS 证据删掉导出摘要后，钉版 submit 给出 `partial=false` 的 submitted（W15）；违反 §14.4 证据字段要求与 A15「缺字段不参与门禁」。t22 后复测已改为 `AGENT_EVIDENCE_STALE` | 保留修复并补回归：`entry.status==='PASS' && !entry.exportTreeDigest && dryRunExportDigest` ⇒ stale（fail-closed）；`output.consistency` 同判据 |
| **F-V3W2-04** | medium | `desktop/agent-workspace/source-bundle.cjs:412-444`（`bundleIsStale`，钉版锚点） | **模型可写摘要清单**：模型用 `write_files` 写一份 `source-bundle.json`（`files` 摘要与候选一致、`base.treeSha256` 与 `deleted` 是编的）后，`bundleIsStale` 只比 `files` 摘要与 `base.treeSha256` 是否字符串，判定“未过期”→ 平台**不重派生**，原样接受并把该清单写成 bundle。X6 合同明文「模型不写摘要清单」；`deleted`/`components`/`assets`/base 身份因此可被模型左右（composer 虽会校验 base sha，但 `deleted` 可让验证导出悄悄少资产）。W17 在 t22 后仍 FAIL | 二选一：①把 `write_files`/`delete_files` 对 `source-bundle.json` 直接拒绝（平台专用产物，模型不可写）；②检查阶段无条件重派生或把整份清单与 `deriveBundle` 结果逐字段比对，不一致即 `AGENT_EVIDENCE_STALE`。补 W17 回归 |
| **F-V3W2-05** | low | `desktop/agent-workspace/checks.cjs`（`CHECK_ALIASES`） | 合同别名 `capabilities.source-facts` 仍作为可调用 checkId 存在（证据已归一到 canonical）。Captain 已裁定 canonical=`capabilities.check`、别名为 rev16 清理项；本项不阻塞 E0，但需登记 | rev16 删除别名或明确只允许 canonical 进证据/日志/UI；在此之前 W04 记录 `aliasPresent=true` 作为已知清理项 |

**本轮独立证实“不是缺陷”的点**（避免 t8 重复排查）：source.check/dry-run/mini/output 的检查目标绑定（W01–W03）、
capabilities.check 独立性（W04）、8 页单一来源与派生（W05）、非 menu 页提交（W06）、bundle 派生/不派生于 submit/字节不变/deleted 显式（W07/W08/W16）、
句柄三类拒绝（W09）、direct 三态（W10–W12）、F1 返回体（C08）、三分布（C09）、F2（C15）、F3 三要素（C17）。

---

## 7. 对 t8（E0-V1）的风险提示

1. **不能引用 t5 钉版关闭 X7**：F-V3W2-01（F1 adopt 边界）在钉版成立（t22 已修，需稳定版复测）；
   F-V3W2-02（partial 只信 submission.json）在 t22 后仍成立 → 只要它未修，`AGENT_PARTIAL_CONFIRM_REQUIRED` 这条门禁可被篡改
   `submission.partial` 绕过，t8 的 adopt 负例（A09/A49）必须自己重跑，不能引 t5 的 95/51 绿。
2. **X6 不能按“已关闭”写**：F-V3W2-04（模型自写清单被接受）在 t22 后仍成立；t8 若按 t5 报告写“X6 已闭合”，
   需先确认该项已修并在 **最终 sha256** 上重跑 W17。
3. **时间绑定**：本文判据只对 §1.1 的 8 个 sha256 成立。t22 已改写 `run-coordinator.cjs` / `source-bundle.cjs` / `agent-tools-ipc.cjs`；
   t8 必须在 t22 收口后**整体重跑** C/W/V/A 组（含 real 模式），并把最终 sha256+bytes 写进结论头（rev15 §14.13-6）。
4. **IPC 侧不在本任务验收范围**：t15 报的 blocker `F-T5-01`（IPC 把 `attempt-1` 传成数字 1 给 Coordinator → `AGENT_ATTEMPT_NOT_FOUND`）
   我没有独立复核（t11 验收只到 Coordinator/检查链/direct）。t8 不得把「IPC→真实 Coordinator」当作已验；t22 的 IPC 修复需配端到端用例。
5. **共享执行器漂移**：`scripts/e0-verify/chains/vertical.cjs`、`attacks/e0.cjs` 在复核期间被 t8 并发改写，
   当前 `run-report.json` 是混合态（含 verifier4 的 V 组执行体）；t8 出 verdict 前应确认执行器与报告同一次运行、同一 revision。
6. **微信/UIA/真实模型仍 NOT_RUN**：本机 `wechat.verify` 恒 BLOCKED，本任务未跑真实 Flash；这些不因本文件 PASS/FAIL 改变。
   E0 结论最高仍只能是 `PARTIAL`，E1–E4 继续不开放。

---

## 8. 复现

```powershell
# 1) 钉版校验（与 §1.1 比对；不一致则本文判据作废，按 §1.2 重跑）
Get-FileHash desktop/agent-workspace/run-coordinator.cjs, desktop/agent-workspace/checks.cjs,
  desktop/agent-workspace/source-bundle.cjs, desktop/agent-workspace/direct-runtime.cjs,
  desktop/agent-tools-ipc.cjs, desktop/preload.cjs, desktop/main.cjs,
  scripts/agent-checks/run-check.cjs -Algorithm SHA256

# 2) W 组（t5 复核）
node scripts/e0-verify/run.cjs --mode offline --only W01,W02,W03,W04,W05,W06,W07,W08,W09,W10,W11,W12,W13,W14,W15,W16,W17

# 3) 全量（当前 revision；退出码 1 = 有用例 FAIL，属实现缺陷不是脚本故障）
node scripts/e0-verify/run.cjs --mode offline

# 4) 等价门禁（t5 合同 verify 命令）
node --test --experimental-test-isolation=none "test/agent-workspace*.test.cjs" test/agent-tools-ipc.test.cjs `
  test/desktop-contract.test.cjs test/composer-source-overlay.test.cjs
```

---

## 9. 未覆盖 / 不做背书

- 真实 DeepSeek Flash、真实微信开发者工具、UIA 无障碍走查、安装包：**NOT_RUN**（属 t8/E0-V1 与 E1–E4）。
- IPC → 真实 Coordinator 的 submit/adopt 端到端（t15 的 F-T5-01）、服务端 X9 副本、X12 服务端侧：不在 t11 验收范围，**未独立复核**。
- X1/X3 的整体关闭、X2/X8/X9/X10/X11/X12 的关闭：不因本文件的 W/C 组 PASS 而成立；E0 判定仍归 t8。
- 本文件没有修改任何产品代码、`test/**`、`docs/handoff/**`、`package.json`；写入仅 `scripts/e0-verify/**` 与
  `docs/evidence/workspace-agent/e0-v1/**`。

---

## 10. 结论

**t5 钉版（§1.1 字节）独立复核结论：FAIL（needs_revision）**，t8 **不得**以其作为 X6/X7 关闭证据。

- **A11O 复核 / X4：PASS**（W01–W04 + 重写后的 A11O：检查真跑 attempt 树/派生导出树，capabilities.check 独立）。
- **X5：PASS**（W05/W06）。
- **X6：主体 PASS，整体不能关闭**（W07/W08/W16 PASS；W17 FAIL：模型可自写摘要清单）。
- **X7：FAIL**（F1 adopt 边界 W13 钉版 FAIL；partial 信任 W14 FAIL；导出级证据完整性 W15 钉版 FAIL，t22 已修）。
- **句柄身份 / direct 接线：PASS**（W09–W12）。
- 漂移后（t22 修复中的混合态）复测：W13/W15 已修；**W14/W17 仍未修**。所有后续判定必须对稳定 revision 重跑。
- E1–E4 继续不开放；E0 结论最高仍为 `PARTIAL`（微信/真实模型未完成），且当前 X6/X7 缺陷未清前不得出 PASS。

---

*记录人：verifier3（t11 / E0-V1b）。本文件为增量复核证据，不是 E0 终局 verdict。*
