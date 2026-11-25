# B2 独立复核（t10 / round 1）— 不可变/指针/重开/迁移/导出身份与越界

- 复核对象：B2（t9）`desktop/agent-workspace/versions.cjs` + constants/workspace/README 增量 + 两份新测试
- 冻结依据：`docs/handoff/Workspace-Agent-B阶段接口冻结.md` §2（§2.1–§2.5、rev4 §2.6）与总计划 §5 B2
- 复核者：verifier（只读；除本文件外未写仓库文件；攻击脚本在 `.tmp/a10/b2-attack.cjs`）
- 时间：2026-11-24 17:30–17:48（+08:00）；HEAD `70e0057`；Node v24.14.0；DSH 沙箱 `workspace-write`
- **Verdict：`needs_revision`（2 条 findings；修复后需 review r2，**B3 暂不开放**）**

## 1. 门禁（真实退出码，单进程等价；官方命令仍 BLOCKED）

| # | 命令 | 退出码 | 结果 |
| ---: | --- | ---: | --- |
| 1 | `node --test --experimental-test-isolation=none --test-force-exit "test/agent-workspace*.test.cjs"` | **0** | **50/50**（B1 37 + B2 13），0 skipped |
| 2 | `… test/frontend-contract.test.cjs test/frontend-reconstruct.workspace.test.cjs test/frontend-reconstruct.desktop.test.cjs test/desktop-contract.test.cjs` | **0** | **65/65** |
| 3 | `… test/frontend-reconstruct*.test.cjs test/app-frontend-reconstruct.test.cjs`（13 文件） | **0** | **186/186** |
| 4 | `node -e "for (const f of ['workspace','files','transactions','manifest','versions']) require(...)"` | **0** | `agent-workspace modules ok` |
| 5 | root 全量等价（A0 口径：124 文件 / 7 块 / 单进程 / `--test-force-exit --test-timeout=120000`） | **1** | `tests 1308 / pass 1299 / fail 7 / skip 2`；失败集合 = **A0 的 7 项**（6 沙箱 spawn EPERM + 1 `w5d-table-source` MIRROR PRE_EXISTING），**无 NEW fail** |
| 6 | 官方 `npm test` / `npm run build` | — | **BLOCKED**（spawn EPERM，A0/A4 已实测；本轮未伪装） |

## 2. 独立攻击用例（自写，不复用实现者测试，`%TEMP%` 临时 userData）

脚本：`.tmp/a10/b2-attack.cjs`。三个独立 project：A=版本/指针/重开/导出（真实 adopt），B=伪造句柄越界写，C/D=旧项目迁移（复制仓库内 T6 evidence-run 旧 attempt 作为只读迁移源）。
结果：**38 项 = 34 PASS / 4 FAIL / 0 BLOCKED**（4 FAIL 归并为 2 条 findings）。

### 2.1 不可变与指针

| 用例 | 结果 |
| --- | --- |
| `initProject` → v1（`import-base`，目录/字段/摘要） | PASS |
| adopt v2 后 v1 的 source/diff/version.json/treeDigest **逐字节不变** | PASS（v1 目录指纹前后相同；`treeDigest=sha256:470cf96c…`） |
| 同一 attempt 重复采用 → 生成 v3（确定性“新版本”），v2 不变 | PASS（v2 指纹与 treeDigest 不变） |
| 全部操作（undo/redo/adopt/reopen/导出身份/fork）后 v1/v2/v3 旧版本仍不变 | PASS（三者目录指纹与初始一致） |
| undo：v3→v2（redo=v3）→v1（redo=v2） | PASS |
| v1 再 undo → `AGENT_UNDO_UNAVAILABLE` | PASS |
| redo：v1→v2 且 redo 清空；再 redo → `AGENT_REDO_UNAVAILABLE` | PASS |
| 新采用清空 redo（current=v4、previous=v1、redo=null） | PASS |
| 分叉 redo（v1 有 v2/v4 两个子）→ `AGENT_VERSION_CONFLICT` | PASS |
| undo/redo **不产生新版本目录** | PASS（`versions/` 列表前后一致） |
| `versions[]`/`previousVersionId`/`redoVersionId` 索引一致（唯一 isCurrent） | PASS |
| **伪造 attempt 句柄经 files/transactions 写 `versions/<id>/`** | **FAIL → F1**（写入成功并改变 v1 目录指纹） |

### 2.2 重开 fail-closed

| 用例 | 结果 |
| --- | --- |
| 正常 reopen（current=v4）幂等 | PASS（两次 treeDigest/版本数一致） |
| 直接篡改 current 版本 source 文件 → `AGENT_VERSION_CONFLICT`，`state.unavailable=true`、current 仍为 v4（不回退 v1/Base） | PASS |
| 恢复文件后 reopen 恢复可用 | PASS |
| 移走 current 版本目录 → `AGENT_VERSION_CONFLICT`（missing） | PASS |
| 恢复目录后 reopen 正常 | PASS |

### 2.3 旧链迁移

| 用例 | 结果 |
| --- | --- |
| 首次迁移：v1=`import-base`、v2=`import-adopted`、current=v2、migration 记录（migrationId/from/createdVersions=[v1,v2]/at） | PASS |
| 二次 `initProject` 幂等（created=false、migrated=false、版本数仍 2） | PASS |
| 迁移只读：`frontend-runs/**` 与旧 `project.json` 指纹不变 | PASS |
| 损坏 attempt（attempt.json 破坏）→ `AGENT_MIGRATION_FAILED`，旧 project.json 仍可解析，无半套 `agent-workspace/` | PASS |
| 迁移 adoption 记录 `sourceKind:"legacy-migration"`（rev4 §2.6 裁定②） | **FAIL → F2**（实际字段集 `{projectId,runId,attempt,candidateId,candidateVersion,integrity,registryDigest}`，无 sourceKind） |

### 2.4 导出身份

| 用例 | 结果 |
| --- | --- |
| `resolveVersionSource` / `verifyExportIdentity` 同一 `sourceRoot` 与 `treeDigest`，且 versionId=current | PASS |
| 纯函数不写盘（`project.json` 哈希前后一致） | PASS |
| 篡改 `adoption.integrity` + 传 overlayDigest → `AGENT_EXPORT_IDENTITY_MISMATCH` | PASS |
| 把非 current 版本传给导出身份 → `AGENT_EXPORT_IDENTITY_MISMATCH` | PASS |
| `previousVersionId` 指针漂移 → `AGENT_EXPORT_IDENTITY_MISMATCH` | PASS |

### 2.5 错误码

`versions.cjs` 中出现的 `AGENT_*` 均在冻结集合内（无私有码）；§2.2 八码全部存在。**PASS**。

## 3. Findings（needs_revision）

### F1（severity: medium）files/transactions 未校验 attempt 句柄归属，可写穿到 `versions/<id>/`

- 文件/行：`desktop/agent-workspace/files.cjs:32`（`guardAttempt` 仅检查 `candidateDir/attemptDir` 为字符串）、
  `desktop/agent-workspace/transactions.cjs:45`（同一校验）；调用链 `writeFile`→`applyChanges`→`beginChanges`/`commitChanges`。
- 问题：验收要求「通过 files/transactions API 写 `versions/<id>/` 必须被拒绝（只能写 attempt 工作树）」。
  实测伪造句柄 `{candidateDir: <v1>/source, attemptDir: <v1>, attemptFile: ...}` 后：
  - `files.writeFile` **成功**写入 `versions/v1/source/evil-a10.txt`；
  - `transactions.applyChanges` **成功**写入 `evil-a10-b.txt`；
  - v1 目录指纹由 `84aa3dd9…` 变为 `c40b9f52…`，v1 `treeDigest` 与磁盘不再一致（随后 reopen 会 fail-closed，但“不可变”已被破坏）。
  说明：正常 API（`openAttempt`/`createAttempt`）只派生 runs 布局，B3 契约也只传 id，因此**当前外部不可达**；
  但这是 B2 不可变不变量的 API 级缺口，验收明确要求拒绝。
- requiredFix：在 `files.cjs`/`transactions.cjs` 的 `guardAttempt` 增加归属校验（例如复用
  `workspaceMod.assertOwnership` 或按 `<root>/projects/<projectId>/agent-workspace/runs/<runId>/turns/<turnId>/attempts/attempt-<n>/`
  布局验证 `candidateDir/attemptDir`），拒绝任何指向 `versions/`、`project.json` 或仓库的句柄；
  补一条测试（句柄候选目录=版本 source → 必须返回 `AGENT_PATH_ESCAPE/AGENT_WORKSPACE_INVALID` 且不落盘）。
  若不改代码，则需 Captain/冻结文档明确「句柄只由主进程派生、B3 不得透传调用方句柄」并把该约束写成 B3 验收项——
  但按当前 t10 acceptance 条文，仍应实现拒绝。

### F2（severity: medium）adoption 缺 `sourceKind`，与 rev4 §2.6 裁定②不一致

- 文件/行：`desktop/agent-workspace/versions.cjs:709`（迁移 adoption 对象，字段见 :714–:716）、
  `desktop/agent-workspace/versions.cjs:841`（agent-edit adoption 对象，字段见 :846–:847）。
- 问题：rev4 §2.6 裁定②明确「agent-edit adoption：…，另加 `sourceKind:"agent-edit"|"legacy-migration"`；
  只有迁移才记真实 overlay integrity」。实测：
  - agent-edit（v4）adoption = `{projectId,runId,attempt,candidateId,candidateVersion,integrity}`，无 `sourceKind`；
  - legacy-migration（v2）adoption = `{…,registryDigest}`，同样无 `sourceKind`。
  `version.source.kind` 是 `agent-edit`/`import-adopted`，但 adoption 侧无法区分两类来源（B3/导出需要按裁定②识别）。
- requiredFix：在 `adoptAttempt` 的 adoption 里加 `sourceKind:'agent-edit'`；在迁移 adoption 里加
  `sourceKind:'legacy-migration'`；补测试断言两版本 adoption.sourceKind；同步 README/B3 消费说明。

## 4. 非 finding 观察

1. `migration.json` 实际形状为 `{schemaVersion:"agent-migration.v1", migrations:[{migrationId,from,createdVersions,at}]}`，
   而 §2.3 字面写“追加一条 {…}”。字段与追加语义满足，但外层包装未在冻结中显式规定；
   建议 rev5 明确 schema（不影响本条 verdict，B3 消费前需统一）。
2. 沙箱禁止目录 symlink、junction 不属 B2 新面；B1 已覆盖链接拒绝，本轮未重复。
3. 版本不可变在**正常 API 路径**下成立：adopt/reuse-adopt/undo/redo/reopen/fork 全流程后 v1/v2/v3 目录指纹与
   treeDigest 不变（除 F1 的伪造句柄路径）。

## 5. 测试削弱与越界

- 门禁 50/50、65/65、186/186 与实现者自报一致；`test/agent-workspace*.test.cjs` 无 `.skip/.todo/.only`（grep 0）。
- 新增 13 例为真断言（versions 10 + migration 3，含 adopt 原子失败、指针边界、reopen 漂移、导出身份、仓库零写入）；
  既有 B1 37 例保留，无删除/放宽。
- B2 写入面 mtime：`versions.cjs`(17:22)、`constants.cjs`(17:17)、`workspace.cjs`(17:17)、`README.md`(17:23)、
  `agent-workspace.versions.test.cjs`(17:22)、`agent-workspace.migration.test.cjs`(17:16)；
  `files/paths/manifest/transactions.cjs` 保持 16:44–16:47 未动。
- 越界核对：`desktop/frontend-reconstruct/adoption.cjs`(11-19 17:12)、`project-store.cjs`(11-19 23:41)、
  `main.cjs`(11-19 22:07)、`preload.cjs`(11-19 23:41)、`project-ipc.cjs`(11-21 18:27)、
  `frontend-reconstruct-ipc.cjs`(11-21 18:27)、`composer-ipc.cjs`(11-19 17:12)、`package.json`(11-20) 均未变；
  legacy `frontend-reconstruct/workspace.cjs` 为 t7 修复 17:04；`git status` 产品侧仅 `M desktop/frontend-reconstruct/workspace.cjs`
  + `?? desktop/agent-workspace/`（src 的 `M` 为团队启动前既有 app-assistant 改动）；HEAD 未变（无 commit）。
- **未发现 B2 越界或测试削弱。**

## 6. 结论

- B2 的版本不可变（正常路径）、指针/undo/redo、重开 fail-closed、迁移幂等与回滚、导出身份纯函数、错误码与越界均**符合冻结**；
  门禁 50/50、65/65、186/186，root 失败集合未超出 A0。
- 但存在 **F1（medium，API 级不可变缺口）** 与 **F2（medium，adoption.sourceKind 缺失）** → **verdict=needs_revision**。
- repair（workspace-lead）后需 **review r2**；r2 通过前 **不开放 B3**。
- 证据：本文件；攻击脚本 `.tmp/a10/b2-attack.cjs`；临时 workspace 位于 `%TEMP%\dsh-lfO7Oi\a10-b2-attack-<rand>`（不写仓库）。

---

# Review r2（t12，2026-11-24 17:55–18:02）— 复检 F1/F2 修复

- 复核对象：t11 repair-round-2（`files.cjs` / `transactions.cjs` / `versions.cjs` / `README.md` / `test/agent-workspace.versions.test.cjs`）
- **Verdict：`pass`（0 findings；B2 满足冻结 §2.1–§2.4、rev4 §2.6，可开放 B3）**
- 前提不变：官方 `npm test` / `npm run build` 仍 spawn EPERM → BLOCKED（A0/A4/A3 已实测）；r2 以单进程等价门禁判定。

## R2-1 门禁复跑（真实退出码）

| # | 命令 | 退出码 | 结果 |
| ---: | --- | ---: | --- |
| 1 | `node --test --experimental-test-isolation=none --test-force-exit "test/agent-workspace*.test.cjs"` | **0** | **53/53**（B1 37 + B2 10 + F1/F2 3 + migration 3），0 skipped |
| 2 | `… test/frontend-contract.test.cjs test/frontend-reconstruct.workspace.test.cjs test/frontend-reconstruct.desktop.test.cjs test/desktop-contract.test.cjs` | **0** | **65/65** |
| 3 | `… test/frontend-reconstruct*.test.cjs test/app-frontend-reconstruct.test.cjs`（13 文件） | **0** | **186/186** |
| 4 | `node -e require` 五模块（含 versions） | **0** | `agent-workspace modules ok` |
| 5 | root 全量等价（A0 口径：124 文件 / 7 块 / 单进程 / `--test-force-exit --test-timeout=120000`） | **1** | `tests 1311 / pass 1302 / fail 7 / skip 2`；失败集合 = **A0 的 7 项**（6 沙箱 spawn EPERM + 1 `w5d-table-source` MIRROR PRE_EXISTING），**无 NEW fail** |
| 6 | 官方 `npm test` / `npm run build` | — | **BLOCKED**（spawn EPERM，未重跑冒充） |

## R2-2 F1 复检（伪造句柄写穿 versions）

- 代码：`transactions.assertAttemptHandle`（`desktop/agent-workspace/transactions.cjs:62`）为**唯一**归属校验实现；
  `files.cjs` 的 `guardAttempt` 直接 `return transactions.assertAttemptHandle(attempt)`（无第二套）。
- 独立抽检（verifier 自写 `node -e`，不复用实现者测试）：临时 project 完成 init→attempt→adopt 后，
  用伪造句柄 `{candidateDir:<versions/vN>/source, attemptDir:<versions/vN>, attemptFile:<versions/vN>/version.json}`：
  - `files.writeFile` → `{ok:false, code:"AGENT_WORKSPACE_INVALID"}`，`evil-r2.txt` 不存在；
  - `transactions.applyChanges` → `{ok:false, code:"AGENT_WORKSPACE_INVALID"}`，`evil2-r2.txt` 不存在。
- 自写攻击套件重跑：`immutable.forgedHandleWriteRejected` / `forgedHandleTxnRejected` /
  `v1UnchangedAfterForgedAttempt` 全部 **PASS**；总计 **38 项 = 38 PASS / 0 FAIL**（r1 为 34/4）。
- 实现者测试亦覆盖：`test/agent-workspace.versions.test.cjs:505`（伪造指向 versions/project.json → 全部拒绝、版本 source 树哈希不变）、`:548`（仓库/异常布局 + 正常句柄不回归）。

## R2-3 F2 复检（adoption.sourceKind）

- 代码：`versions.cjs:718`（迁移 adoption `sourceKind:'legacy-migration'`）、`:851/:858`（agent-edit `sourceKind:'agent-edit'`）；
  `source.kind` 与 `adoption.sourceKind` 分离，语义符合 rev4 §2.6②。
- 独立抽检：新建 project → adopt → `readVersion` 返回 `adoption.sourceKind = "agent-edit"`；
  迁移场景攻击脚返回 `adoptionKeys` 含 `sourceKind:"legacy-migration"`（并含 `registryDigest`）。
- 实现者测试：`:325`、`:579`、`:593` 分别断言 agent-edit / 迁移两类 sourceKind（真断言，非恒真）。

## R2-4 测试削弱与改动面

- 50→53（+3：2 条 F1 伪造句柄用例 + 1 条 F2 sourceKind 用例），均为真断言；`grep .skip/.todo/.only` = 0。
- 既有测试零删除/放宽：`agent-workspace.migration.test.cjs`（17:16）、`files/transactions/manifest/workspace/repo-safety` 测试
  mtime 未再变；仅 `agent-workspace.versions.test.cjs`（17:46）与实现同步更新。
- t11 实际改动面：`files.cjs`(17:46)、`transactions.cjs`(17:46)、`versions.cjs`(17:39)、`README.md`(17:40)、
  `agent-workspace.versions.test.cjs`(17:46)；`constants/manifest/paths.cjs` 未动（16:44–17:17）。
- 观察（非 finding）：`workspace.cjs` mtime 由 t10 的 17:17 变为 17:45，但**字节数未变（28,698 B）**，
  t11 报告称 sha256 与 t10 快照一致；本轮门禁 53/65/186 全绿、无内容回归迹象。
- 越界核对：`adoption.cjs`(11-19)、`project-store.cjs`(11-19)、`main.cjs`(11-19)、`preload.cjs`(11-19)、
  `project-ipc.cjs`(11-21)、`frontend-reconstruct-ipc.cjs`(11-21)、`package.json`(11-20) 均未变；
  legacy `frontend-reconstruct/workspace.cjs` 保持 t7 的 17:04；HEAD 未变（无 commit）。
  `git status` 产品侧仍只有 `M desktop/frontend-reconstruct/workspace.cjs` + `?? desktop/agent-workspace/`（src 的 M 为团队启动前既有改动）。

## R2-5 结论

- F1（伪造句柄写穿 versions）与 F2（adoption.sourceKind 缺失）均已修复，且有独立复验 + 真断言测试；
  门禁 53/53、65/65、186/186、root 1311/1302/7（失败集不超出 A0）；自写攻击套件 38/38。
- **verdict=pass（0 findings）**；B3 可开放。残余环境项：官方 npm 门禁仍 BLOCKED（需可 spawn 机器终验），不阻断 B3。

