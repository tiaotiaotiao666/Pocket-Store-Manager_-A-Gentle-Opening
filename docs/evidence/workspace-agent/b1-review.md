# B1 独立复核（t6 / round 1）— 攻击用例、测试削弱与越界检查

- 复核对象：B1（t4）`desktop/agent-workspace/**` + `desktop/frontend-reconstruct/workspace.cjs` 共享化 + `test/agent-workspace*`
- 冻结依据：`docs/handoff/Workspace-Agent-B阶段接口冻结.md` rev3（§1.3/§1.4/§1.5/§1.6/§1.7/§1.8/§1.10、§13.3）
- 复核者：verifier（只读；除本文件外未写任何仓库文件）
- 时间：2026-11-24 17:08–17:32（+08:00）；HEAD `70e0057`；Node v24.14.0；DSH 沙箱 `workspace-write`
- **Verdict：`needs_revision`（2 条 findings；修复后需 review r2，B2 暂不开放）**

## 1. 门禁（真实退出码，单进程等价；≠官方）

| # | 命令 | 退出码 | 结果 |
| ---: | --- | ---: | --- |
| 1 | `node --test --experimental-test-isolation=none --test-force-exit "test/agent-workspace*.test.cjs"` | **0** | `tests 36 / pass 36 / fail 0 / skipped 0` |
| 2 | `node --test --experimental-test-isolation=none --test-force-exit test/frontend-reconstruct.workspace.test.cjs test/frontend-reconstruct.desktop.test.cjs test/desktop-contract.test.cjs` | **0** | `60/60`（旧链无回归） |
| 3 | `node --test --experimental-test-isolation=none --test-force-exit test/frontend-reconstruct*.test.cjs test/app-frontend-reconstruct.test.cjs`（13 文件） | **0** | `186/186` |
| 4 | 官方 `npm test` / `npm run build` | — | **BLOCKED**（沙箱 spawn EPERM，A0 已实测；本轮未重复，不写成通过） |
| 5 | `node --test --experimental-test-isolation=none --test-force-exit test/frontend-contract.test.cjs`（B1 门禁之外的契约守卫） | **1** | `tests 5 / pass 4 / fail 1`，失败点 `test/frontend-contract.test.cjs:73`（见 F1） |

36/60/186 与实现者自报及冻结 §1.10 完全一致；未见数量下降。

## 2. 独立攻击用例（verifier 自写，`%TEMP%` 临时工作区，未复用实现者测试）

脚本：`.tmp/a6/b1-attack.cjs`（仓库外临时脚本；运行根目录 `E:\智能开店app`）。
构造：`openWorkspace({userDataDir:%TEMP%/..., projectId:'p_review_0001'})` → `createAttempt({runId:'frun-a6review', turnId:'turn-a6review', attempt:1})` → 137 文件 Base 副本。
结果：**48 项，45 PASS / 2 FAIL / 1 BLOCKED**。

| 类别 | 用例（全部真实执行） | 结果 |
| --- | --- | --- |
| 路径穿越/非法路径 | `../escape.txt`、`..\escape.txt`、`C:\Windows\…`、`C:/Windows/…`、`\\server\share\…`、`a\b.txt`、`a\0b.txt`、241 字符、空串、`/`、`a//b.txt`、%TEMP% 绝对路径（POSIX 与原生） | **全部拒绝**，code=`AGENT_PATH_INVALID`；临时根/attempt 目录/绝对目标均**无落盘** |
| expectedBaseSha256 冲突 | 错 sha 写 `app.js`、错 sha 删 `app.js` | `AGENT_BASE_DIGEST_MISMATCH`；文件 sha 不变、删除未发生；正确 sha 可写入 |
| 部分失败/半提交 | 批内 `[好文件, ../evil]` | 整批拒绝（`AGENT_PATH_INVALID`），好文件**未落盘**，candidate treeDigest 不变，`.staging-*` 0 个 |
| 事务上限 | 33 文件批、单文件 >1 MiB | `AGENT_BATCH_TOO_LARGE` / `AGENT_FILE_TOO_LARGE` |
| 暂存清理 | 手工遗留 `.staging-deadbeef/` → `cleanupStagedTransactions` | `removed:1`，目录被清除 |
| 暂存篡改 | begin 后向 `staging/candidate` 注入文件再 commit | `AGENT_TXN_ABORTED`；candidate 摘要不变、注入文件未出现（整树 swap + 摘要复核） |
| 重开一致 | 写入后 `openAttempt` 重开读取 | 内容一致，`attempt.treeDigest === 磁盘重算`（`sha256:b9590bef…`，137→139 文件） |
| 相同输入相同 treeDigest | 连续 2 次 `buildManifest`；逆序 `treeDigestOfFiles` | 摘要相同；与**独立实现**（自写 walk+sha256+排序拼接）一致 |
| 空树 | `treeDigestOfFiles([])` | `sha256:e3b0c442…` = SHA-256(空串)，符合 §1.6 |
| 正式仓库指纹 | `templates/miniprogram/src/desktop/scripts/contracts` 全树摘要（自写） | 攻击前后**完全一致** `2dc9efc4…` |
| junction | candidate 内 junction 指向外部目录 | 写/读/manifest 均 `AGENT_PATH_LINK`，外部目录零落盘 |
| symlink | candidate 内目录 symlink | **BLOCKED**：`fs.symlinkSync(...,'dir')` → `EPERM`（沙箱限制，非产品）；B1 自带测试亦有条件跳过该子项 |
| LIMITS/错误码 | §1.4 全 13 项数值；§1.7 16+5 码 | 数值逐项一致；21 码全部存在；源码中无冻结外私有 `AGENT_*` 码 |
| 共享化 | 旧 `workspace.cjs` 是否仍定义 13 个安全 helper | 无本地定义，`require('../agent-workspace/paths.cjs')` 且函数引用同源（36 项测试含 `===` 断言） |
| 契约来源 | 旧 `workspace.cjs` 是否直接 require 生成契约 | **FAIL**（F1）；`constants.cjs:75` 本地复制 RUN_ID_PATTERN（F2） |

## 3. treeDigest 独立重算（冻结 §1.6）

- 独立实现（不调用 `manifest.cjs`）：遍历真实工作树 → 每个文件字节 SHA-256 → POSIX 相对路径**区分大小写升序** → 拼接 `"<path>\n<hex>\n"`（UTF-8）→ SHA-256。
- 真实树：Base 复制 attempt（137 文件）写入 2 个文件后 139 文件。
- 结果：独立重算 `sha256:b9590befa0973ae4f7a7c233eb46bf7c0049c8d31d82f365db0afdf5a5df35ac`
  = `buildManifest().manifest.treeDigest` = `treeDigestOfFiles()`（逆序输入同值）→ 与冻结一致。
- 另：`attempt.json.treeDigest`（写入前 137 文件）与磁盘重算一致
  `sha256:470cf96cafc713576618c72a1bff35fda0bd28d9d98fd1dca3f909fcc9554670`。

## 4. 测试削弱检查

- 既有 frontend-reconstruct / desktop / workspace 测试**零改动**：`git diff --stat` 对
  `test/frontend-contract.test.cjs`、`test/frontend-reconstruct.workspace.test.cjs`、
  `test/frontend-reconstruct.desktop.test.cjs`、`test/desktop-contract.test.cjs` 为空；`git status -- test`
  中新文件仅为 B1 的 `test/agent-workspace*`（A0 16:33 快照已记录 `test/app-assistant*` 为团队启动前既有改动）。
- B1 新测试无 `.skip/.todo`（grep 0 命中），36/36 实跑、0 skipped。
- 基数对账：36（B1）/60（旧链）/186（frontend-reconstruct 全量）与冻结 §1.10、实现者自报一致，**数量未减少、断言未见放宽**。
- 唯一「条件覆盖」：文件/目录 symlink 创建在沙箱返回 EPERM，B1 测试用 `tryCreateFileSymlink` 优雅跳过；junction 路径仍被真实覆盖。属环境限制，不计削弱（但建议在可创建 symlink 的机器补跑）。

## 5. 越界检查

`git status --porcelain` 中与 B1 相关的新增/修改只有：

- `?? desktop/agent-workspace/`（7 文件：constants/files/manifest/paths/transactions/workspace + README）
- `?? test/agent-workspace.{workspace,files,transactions,manifest,repo-safety}.test.cjs` + `helpers.cjs`
- `M desktop/frontend-reconstruct/workspace.cjs`（共享化，冻结 §1.1 允许）

以下**均无 B1 改动**：`desktop/main.cjs`、`desktop/preload.cjs`、`desktop/project-ipc.cjs`、
`desktop/frontend-reconstruct-ipc.cjs`、`templates/**`、`miniprogram/**`、`contracts/**`、`package.json`、
`server/**`（`git status -- <这些路径>` 为空）。
其余 `M/??`（docs、src/app-assistant 相关、scripts/app-assistant-smoke.cjs）是团队启动前既有改动（A0 16:33 快照）；
`scripts/model-capability-probe.cjs` 属 D0；`docs/evidence/**` 属各角色证据。**未发现 B1 越界。**

## 6. Findings（needs_revision）

### F1（severity: high）B1 共享化导致契约守卫测试失败（NEW 回归）

- 文件/行：`test/frontend-contract.test.cjs:73`（断言对象 `desktop/frontend-reconstruct/workspace.cjs`）；
  现 import 在 `desktop/frontend-reconstruct/workspace.cjs:36`（从 `../agent-workspace/paths.cjs` 取 `RUN_ID_PATTERN`）。
- 问题：B1 把旧链对生成契约的**直接** `require('./contract.generated.cjs')` 改为经 `paths.cjs` 间接引用；
  `paths.cjs:28` 本身确实直接 require 生成契约（单一来源未破），但契约守卫测试明确要求 legacy 消费面直接 require。
  实测：`test/frontend-contract.test.cjs` EXIT 1（5 项中 1 失败，正是该断言），A0 全量等价门禁亦因此记为唯一 NEW fail。
  这是 B 阶段门禁的阻断项，不能用“等价测试全绿”掩盖。
- requiredFix：在 `desktop/frontend-reconstruct/workspace.cjs` 恢复对 `./contract.generated.cjs` 的**直接** require
  （例如直接从生成契约取 `PROJECT_ID_PATTERN/RUN_ID_PATTERN`，其余安全函数继续用 `paths.cjs` 的同一实现，禁止另写第二份）；
  或保持 `paths.cjs` 为唯一安全实现的前提下、让 legacy 文件显式 re-require 生成契约常量。**不得删除/放宽/跳过该守卫测试**。
  修复后跑：`node --test --experimental-test-isolation=none test/frontend-contract.test.cjs`（应 5/5）+
  三条 B1 门禁（36/60/186）+ root 全量等价（不应再有 NEW fail）。

### F2（severity: medium）`constants.cjs:75` 本地复制冻结契约常量（第二事实源）

- 文件/行：`desktop/agent-workspace/constants.cjs:75` `const RUN_ID_PATTERN = /^frun-[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/;`
  vs `desktop/frontend-reconstruct/contract.generated.cjs:73` `new RegExp("^frun-[A-Za-z0-9][A-Za-z0-9._-]{0,60}$")`（逐字相同）。
- 问题：`paths.cjs:26/28` 已从生成契约取同一常量并由 `paths.cjs:477` 导出，`constants.cjs` 仍保留本地副本并被
  `workspace.cjs:57`、`manifest.cjs:32` 使用 → 契约若变更会出现“同一冻结 id 正则两份定义”的漂移风险，
  违反 §1.10「唯一安全路径实现/契约单一来源」与 R2「不另写同义常量」的仓库约定。
- requiredFix：删除 `constants.cjs` 中的本地 `RUN_ID_PATTERN`，改为从 `./paths.cjs` 重导出（或直接 require
  `../frontend-reconstruct/contract.generated.cjs`）；补一条测试断言二者**引用相同或逐字相同**（防回归）。
  同样检查 `TURN_ID_PATTERN`/`ATTEMPT_ID_PATTERN`/`VERSION_ID_PATTERN` 是否属于冻结契约常量（rev3 显示
  turnId 正则由冻结文档定义、runId 来自生成契约；若确非生成契约内容，保留于 constants 并注明来源即可）。

## 7. 非 finding 观察（不阻断）

1. 旧 `workspace.cjs` 仍有 2 处 `fs.lstatSync`（L215/L237，attempt/staging 目录身份校验），但安全原语
   （`realpathOf/samePath/isInside/...`）全部来自 `paths.cjs`，且测试断言函数引用 `===` 同源 → 判定为领域逻辑，
   不构成第二份安全实现。
2. 沙箱无法创建目录 symlink（EPERM），symlink 子项 BLOCKED；junction 子项真实 PASS。
3. `freeze.codesPresent` 覆盖 §1.7 全部 21 码（16 + rev3 新增 5），无冻结外私有码。

## 8. 结论

- 独立攻击用例在路径穿越、链接拒绝（junction）、base 摘要冲突、部分失败/无半提交、暂存清理、重开一致、
  treeDigest 与 LIMITS/错误码上**全部符合冻结**；旧链 60/60、全量 186/186 无回归；越界为零。
- 但存在 **F1（high，契约守卫失败）** 与 **F2（medium，同义常量第二事实源）** → **verdict=needs_revision**。
- repair（workspace-lead）后需 **review r2**；在 r2 通过前不开放 B2。
- 证据：本文件；攻击脚本 `.tmp/a6/b1-attack.cjs`（temp 脚本，非产品代码）；运行输出见下方摘要。
  临时工作区 `%TEMP%\dsh-lfO7Oi\a6-b1-attack-<rand>`（沙箱临时目录，不写入仓库）。

---

# Review r2（t8，2026-11-24 17:10–17:20）— 复检 F1/F2 修复

- 复核对象：t7 repair-round-2（仅 3 文件：`desktop/frontend-reconstruct/workspace.cjs`、
  `desktop/agent-workspace/constants.cjs`、`test/agent-workspace.repo-safety.test.cjs`）
- **Verdict：`pass`（0 findings；B1 满足冻结 §1.3–§1.7/§1.10，可开放 B2）**
- 前提不变：官方 `npm test`/`npm run build` 仍 spawn EPERM → BLOCKED（A0/A4 已实测），本 r2 只以单进程等价门禁判定。

## R2-1 门禁复跑（真实退出码）

| # | 命令 | 退出码 | 结果 |
| ---: | --- | ---: | --- |
| 1 | `node --test --experimental-test-isolation=none --test-force-exit test/frontend-contract.test.cjs` | **0** | **5/5**（t6 时 4/5 fail） |
| 2 | `node --test --experimental-test-isolation=none --test-force-exit "test/agent-workspace*.test.cjs"` | **0** | **37/37**（36 + Captain 允许的 1 条新同源断言），0 skipped |
| 3 | `node --test --experimental-test-isolation=none --test-force-exit test/frontend-reconstruct.workspace.test.cjs test/frontend-reconstruct.desktop.test.cjs test/desktop-contract.test.cjs` | **0** | **60/60**（旧链无回归） |
| 4 | `node --test --experimental-test-isolation=none --test-force-exit test/frontend-reconstruct*.test.cjs test/app-frontend-reconstruct.test.cjs`（13 文件） | **0** | **186/186** |
| 5 | root 全量等价（A0 口径：122 文件 / 7 块 / 单进程 / `--test-force-exit --test-timeout=120000`） | **1** | `tests 1295 / pass 1286 / fail 7 / skip 2`；失败集合 = **A0 的 7 项**（6 项沙箱 spawn EPERM：`agent-transport-config`、`app-capabilities`、`backend-readiness`、`component-catalog`、`composer-media`、`w5-wechat-export`；1 项 `w5d-table-source` = MIRROR PRE_EXISTING）。**A0 的 frontend-contract NEW fail 已消失，无新增失败** |

## R2-2 F1 复检（高）

- `desktop/frontend-reconstruct/workspace.cjs:38` 现为
  `const { PROJECT_ID_PATTERN, RUN_ID_PATTERN } = require('./contract.generated.cjs');`
  （`:64` 仍 `require('../agent-workspace/paths.cjs')` 取安全函数，同一实现，无本地 helper）。
- `git diff --stat -- test/frontend-contract.test.cjs` 为空 → **守卫测试零改动**（未删/未跳/未放宽）；测试 5/5 真实通过。
- 自写攻击脚本 `legacy.directContractRequire` 由 FAIL 转 **PASS**。

## R2-3 F2 复检（中）

- `desktop/agent-workspace/constants.cjs`：`RUN_ID_PATTERN` 已无本地字面量（`:14` 从 `./paths.cjs` 引入、`:142` 重导出）；
  `:83–88` 注释说明 RUN_ID 来自生成契约、TURN/VERSION/TRANSACTION 为 agent 域自有、ATTEMPT 复用旧链 `ATTEMPT_DIR_PATTERN`。
- 四引用同一对象（`node -e` 实测）：
  `constants.RUN_ID_PATTERN === paths.RUN_ID_PATTERN === contract.generated.RUN_ID_PATTERN === frontend-reconstruct/workspace.RUN_ID_PATTERN` → **true**；
  `constants.cjs` 无 `const RUN_ID_PATTERN = /.../` 字面量。
- `contract.generated.cjs` 中不存在 `TURN_ID_PATTERN`/`ATTEMPT_ID_PATTERN`/`VERSION_ID_PATTERN`/`TRANSACTION_ID_PATTERN`（实测 false）
  → 保留于 constants 不构成 frontend 契约同义副本，符合冻结 §1.3/§2.1/§1.10。

## R2-4 改动面与测试削弱

- t7 实际改动仅 3 文件（mtime 17:04:25 / 17:04:31 / 17:04:41）：legacy `workspace.cjs`、`constants.cjs`、`repo-safety.test.cjs`。
  `paths.cjs`（16:46:42）、`workspace/files/transactions/manifest.cjs`（16:44–16:47）、其余测试均未再触碰。
- `git status --porcelain -- desktop src server templates miniprogram contracts package.json`：产品侧只有
  `M desktop/frontend-reconstruct/workspace.cjs` + `?? desktop/agent-workspace/`；`src/` 的 6 个 `M` 是团队启动前既有
  app-assistant 改动（A0 16:33 快照已记录），与 B1/t7 无关；`server/templates/miniprogram/contracts/package.json` 零改动。
  无 t7 夹带。
- 新增测试为**真断言**：`test/agent-workspace.repo-safety.test.cjs:92`「契约常量单一来源…」含
  `assert.strictEqual(pathsMod.RUN_ID_PATTERN, generated.RUN_ID_PATTERN)`、
  `strictEqual(constantsMod.RUN_ID_PATTERN, pathsMod.RUN_ID_PATTERN)`、
  `strictEqual(frWorkspace.PROJECT_ID_PATTERN, generated.PROJECT_ID_PATTERN)` 与
  `assert.match(frSource, /require\('\.\/contract\.generated\.cjs'\)/)`；非恒真、无 skip。
- 文件 8989 B → 11314 B（+2325 B），原 4 条 repo-safety 用例（模块纯度/共享复用/仓库零写入/写入收敛）仍在，共 5 条；
  `grep .only/.skip/.todo` = 0；既有 frontend-reconstruct/desktop/contract 测试零改动。

## R2-5 独立攻击回归

`.tmp/a6/b1-attack.cjs` 对修复后代码重跑：**48 项 = 47 PASS / 0 FAIL / 1 BLOCKED**。
与 r1 相比：`shared.runIdPatternSingleSource`、`legacy.directContractRequire` 均转 PASS；
唯一 BLOCKED 仍是沙箱禁止创建目录 symlink（`EPERM`，环境限制；junction 已真实 PASS）。
其余（穿越/绝对/盘符/反斜杠/NUL/超长/空段、base 摘要冲突、无半提交、staging 清理、暂存篡改拒绝、重开一致、
treeDigest 独立重算、仓库指纹不变、LIMITS/错误码）结果与 r1 一致。

## R2-6 结论

- F1、F2 均已修复且可独立复验；门禁 5/5、37/37、60/60、186/186，root 失败集合不超出 A0；
  攻击用例零 FAIL；越界为零；测试未削弱。
- **verdict=pass（0 findings）**；B2 可开放。残余环境项：官方 npm 门禁 BLOCKED、目录 symlink 无法在沙箱验证
  （均已在基线/本文件记录，不阻断 B2，但需在可 spawn/可创建 symlink 的机器补跑）。

