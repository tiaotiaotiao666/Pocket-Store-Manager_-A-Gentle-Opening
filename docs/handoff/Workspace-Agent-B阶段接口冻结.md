# Workspace-Agent B 阶段接口冻结（B1 范围 / B2 版本模型 / B3 RPC）

> 版本：rev12。日期：2026-11-24。状态：**Captain 冻结；B1–B4 r2 pass 已推送；C1/C2 已推送；C3 已实现，r1 复核 needs_revision（reparse 边界，返修中）；C4 待 C3 闭环；B3.x `adopt-attempt` 待 E1 前补；rev2 的 F1–F9 见 §9/§10；D0 见 §12；A0/环境/仓库同步见 §13**。
> 所有者：Captain（`lead`）。团队：`workspace-agent-refactor`（workspace-lead / runtime-engineer / product-ui / verifier）。
> 上游：`docs/handoff/Workspace-Agent大规模重构与遗留收尾-Flash总计划.md` §5、§14.4；`AGENTS.md`；
> `docs/handoff/当前工作区交接.md` §1.6/§4.7/§8。
>
> 本文件只冻结**接口与边界**，不代替实现，也不放宽总计划里的证据口径。
> 任何成员不得自行改动本文件或按“更顺手”的另一种形状实现；需要变更时先报 Captain，由 Captain 出 rev。

## 0. 当前基线（2026-11-24 实测）

- 环境：Windows，Node v24.14.0，`git rev-parse HEAD` = `70e0057`，工作区 21 项未提交改动（禁止回滚/提交）。
- 既有候选链：`<userData>/projects/<projectId>/frontend-runs/<runId>/attempts/attempt-<n>/`，
  主进程实现 `desktop/frontend-reconstruct/`，IPC `desktop/frontend-reconstruct-ipc.cjs`，
  preload 8 个语义 API（`analyzeFrontend` 等）。
- 既有安全路径实现：`desktop/frontend-reconstruct/workspace.cjs`（`resolvePrivateRoot` / `auditPath` /
  `ensureDirectory` / `assertCanonicalDir` / `isLinkLike` / `removeTreeSafely` 等，已覆盖 symlink、
  Windows junction（realpath 复核）、仓库内根拒绝）。**B1 必须抽共享，不得复制第二份。**
- 沙箱事实：`npm test`(`node --test test/*.test.cjs`) 与 `npm run build`(vite) 会 `spawn EPERM`，
  用例未执行 → 官方门禁只能记 `BLOCKED`；可执行门禁是
  `node --test --experimental-test-isolation=none <文件…>`（已实测可用，支持引号 glob）。

## 1. B1 范围冻结（workspace-lead 独占）

### 1.1 允许写入（inScope）

- `desktop/agent-workspace/**`（新增：`README.md`、`workspace.cjs`、`files.cjs`、`transactions.cjs`、
  `manifest.cjs`，以及必要的 `paths.cjs` 等共享模块）。
- `desktop/frontend-reconstruct/workspace.cjs`、`desktop/frontend-reconstruct/index.cjs`
  （只允许“改为调用共享实现 / 再导出”，不得改变既有候选链行为）。
- `test/agent-workspace.<区域>.test.cjs`（新测试，glob `test/agent-workspace*.test.cjs` 必须匹配）。

### 1.2 禁止写入（outOfScope，越界先停并报 Captain）

`templates/**`、`miniprogram/**`、`src/**`、`server/**`、`contracts/**`、`docs/**`、`package.json`、
`desktop/main.cjs`、`desktop/preload.cjs`、`desktop/project-ipc.cjs`、`desktop/frontend-reconstruct-ipc.cjs`。
B1 **不接模型、不做版本/采用语义（B2）、不做 IPC/preload（B3）、不改 Composer**。

### 1.3 目录布局（固定，B2 在此之上加版本）

```text
<userData>/projects/<projectId>/agent-workspace/
  project.json                                   # B2 维护；B1 不在其中写版本指针
  versions/<versionId>/...                       # B2
  runs/<runId>/
    run.json
    turns/<turnId>/
      turn.json
      attempts/attempt-<n>/
        attempt.json
        candidate/**                             # B1 工作树（完整可构建源码）
        verification/**                          # B4/B3 证据
        .staging-<8hex>/                          # 事务暂存，提交后清除
```

- id 正则沿用既有：projectId 与 `desktop/frontend-reconstruct-ipc.cjs` 一致；
  `runId` = `/^frun-[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/`；`attempt` = `/^attempt-([1-9][0-9]{0,3})$/`；
  `turnId`（rev3 补冻结）= `/^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/`。
- **所有**写入必须落在上面这个私有根内；`templates/**`、`miniprogram/**`、`src/**` 等正式仓库路径零写入。
- 工作树来源两种：`base`（`templates/base/ordering-base/1.0.0/src`）与 `version`（已采用版本的 `source/`）。
  从 base 复制时只复制真实文件，不跟随链接；不复制 `.git`、`node_modules`。

### 1.4 数值上限（冻结，B1 实现必须按此默认值，并被测试覆盖）

| 项 | 值 |
|---|---|
| 工作树最大文件数 | 4000 |
| 单文件最大写入字节 | 1 MiB |
| 工作树总字节 | 64 MiB |
| 最大目录深度 | 24 |
| 单次读默认 / 最大字节 | 64 KiB / 256 KiB |
| 单次读最大行数 | 4000 |
| 搜索最大命中 | 50 |
| 单批写入文件数 / 总字节 | 32 / 2 MiB |
| diff 最大文件数 / 总字节 | 64 / 512 KiB |
| 单条路径最大长度 | 240（POSIX 相对路径，`/` 分隔） |

### 1.5 路径与事务不变量（冻结）

1. 路径只接受 POSIX 相对路径：拒绝绝对路径、盘符（`^[A-Za-z]:`）、`..`、空段、`\`、NUL/控制字符、
   超长、空字符串；拒绝解析后越出工作树根。
2. 已存在段必须不是 symlink/junction（`lstat` + `realpath` 双检，junction 靠 realpath 识别）；
   真实路径必须留在根内。
3. `write_file` 是**完整文件覆盖**（`content` 为完整内容，不接受残片拼接、不接受 unified diff）；
   空字符串不得解释为删除；删除只走显式 `delete_file`。
4. `expectedBaseSha256`：提供时必须与该文件当前内容一致，否则返回冲突码且**不落盘**；整批事务任一失败
   则不提交并清理暂存。事务提交为原子 rename；相同输入重复执行 `treeDigest` 必须相同。
5. 失败清理与重开：遗留 `.staging-*` 必须能被安全识别与清除；重开后读回状态一致。
6. 不允许通用 shell / `child_process` 执行入口；模块不依赖 Electron（可被纯 Node 测试直接 require）。

### 1.6 摘要与 manifest（冻结）

- 文件摘要：`sha256:<hex>`（小写），对文件**字节**求 SHA-256。
- `treeDigest` 算法：文件按 POSIX 相对路径**升序**（区分大小写）排列，逐个拼接
  `"<path>\n<sha256hex>\n"`（UTF-8），再对拼接结果求 SHA-256，输出 `sha256:<hex>`；
  空树 = `sha256:` + SHA-256(空串)。
- manifest 逐文件输出 `{path, sha256, bytes, status}`，`status ∈ added|modified|deleted|unchanged`；
  同一输入必须确定性输出（排序稳定、无时间戳进入摘要）。
- `attempt.json` / `run.json` / `turn.json` 只存元数据与相对引用：不得含绝对路径、base64、完整 prompt、
  密钥、原始模型响应或大日志。

### 1.7 错误码（新命名空间 `AGENT_*`；旧 `WORKSPACE_*`/`FRONTEND_*` 保持不动）

`AGENT_PROJECT_INVALID`、`AGENT_ROOT_INVALID`、`AGENT_WORKSPACE_NOT_FOUND`、`AGENT_WORKSPACE_INVALID`、
`AGENT_PATH_INVALID`、`AGENT_PATH_ESCAPE`、`AGENT_PATH_LINK`、`AGENT_PATH_PROTECTED`、
`AGENT_FILE_NOT_FOUND`、`AGENT_FILE_TOO_LARGE`、`AGENT_FILE_COUNT_EXCEEDED`、`AGENT_TREE_TOO_LARGE`、
`AGENT_DEPTH_EXCEEDED`、`AGENT_BASE_DIGEST_MISMATCH`、`AGENT_IO_FAILED`、`AGENT_TXN_ABORTED`。
rev3 采纳 B1 新增 5 码（语义确需区分，不合并）：`AGENT_ID_INVALID`、`AGENT_ARGUMENT_INVALID`、
`AGENT_BATCH_TOO_LARGE`、`AGENT_PATCH_REJECTED`、`AGENT_BINARY_FILE`。
失败返回必须带稳定的 `code`，消息里不得回传本机绝对路径或源码全文（路径用相对路径或省略）。

### 1.8 目标 API 形状（B1 报告时发布实际签名，Captain 出 rev3 复核）

语义必须包含（命名可微调，但职责不得合并或缺失）：

- `workspace.cjs`：打开/校验私有根；按 projectId+runId+turnId+attempt 推导目录；断言工作区归属；
  创建 attempt 目录；安全删树。
- `files.cjs`：list / read（offset+limit）/ search（文件名+内容，带上限）/ 路径规范化与越界/链接检查。
- `transactions.cjs`：begin → stage → commit / abort；批量写；显式删；冲突检测；失败清理。
- `manifest.cjs`：manifest 构建、两棵树 diff、`treeDigest`、attempt/run 元数据读写。
- `README.md`：布局、不变量、上限、错误码、与旧候选链的复用关系（给后续 B2/B3 看）。

`desktop/frontend-reconstruct/workspace.cjs` 的行为必须保持不变（既有
`test/frontend-reconstruct.workspace.test.cjs`、`test/frontend-reconstruct.desktop.test.cjs`、
`test/desktop-contract.test.cjs` 全绿）。

### 1.9 B1 验收命令（固定；官方命令另记 `BLOCKED`）

```powershell
node --test --experimental-test-isolation=none "test/agent-workspace*.test.cjs"
node --test --experimental-test-isolation=none test/frontend-reconstruct.workspace.test.cjs test/frontend-reconstruct.desktop.test.cjs test/desktop-contract.test.cjs
node -e "for (const f of ['workspace','files','transactions','manifest']) require('./desktop/agent-workspace/'+f+'.cjs'); console.log('agent-workspace modules ok')"
```

### 1.10 B1 实际签名与偏差裁定（rev3，2026-11-24）

B1 已完成（t4，workspace-lead，attempt 1）。Captain 独立复跑门禁：`agent-workspace*` **36/36**、
旧链 `frontend-reconstruct.workspace`+`frontend-reconstruct.desktop`+`desktop-contract` **60/60**、
`frontend-reconstruct*`+`app-frontend-reconstruct` **186/186**、四模块 require **ok**；
官方 `npm test`/`npm run build` 仍 `spawn EPERM` → 记 `BLOCKED`（用例未执行）。

实际导出（B2/B3 只依赖这些；改名或语义变化需 rev）：

| 模块 | 导出（摘要） |
|---|---|
| `workspace.cjs` | `openWorkspace({userDataDir,projectId})`；`readProjectFile(ws)`；`workspacePaths({userDataDir,projectId})`；`attemptPaths({userDataDir,projectId,runId,turnId,attempt})`；`createAttempt(ws,{runId,turnId,attempt?,source?,limits?})`；`openAttempt(ws,{runId,turnId,attempt,limits?})`；`listAttempts(ws,{runId,turnId})`；`removeAttempt(ws,{runId,turnId,attempt})`；`assertOwnership(attempt,absPath)`；`normalizeRelativePath`；`CODES/LIMITS/SCHEMAS/RUN_ID_PATTERN/TURN_ID_PATTERN/ATTEMPT_ID_PATTERN/VERSION_ID_PATTERN` |
| `files.cjs` | `listFiles(attempt,{dir?})`；`readFile(attempt,{path,offset?,limitBytes?,maxLines?})`；`searchFiles(attempt,{query,mode?,caseSensitive?,maxResults?})`；`writeFile(attempt,{path,content,expectedBaseSha256?})`；`deleteFile(attempt,{path,expectedBaseSha256?})`；`normalizeRelativePath`；`isBinaryBuffer` |
| `transactions.cjs` | `beginChanges(attempt,changes)`；`commitChanges(attempt,transactionId)`；`discardChanges`；`applyChanges`；`listStagedTransactions`；`cleanupStagedTransactions`；`changes=[{op:"write"\|"delete",path,content?,expectedBaseSha256?,format?}]` |
| `manifest.cjs` | `digestOfContent`；`treeDigestOfFiles`；`buildManifest(treeDir,{limits?})`；`diffManifests(before,after,{maxFiles?,maxBytes?})`；`sanitizeMetadata`；`readAttemptMeta`/`writeAttemptMeta`/`readRunMeta`/`writeRunMeta`/`readTurnMeta` |
| `paths.cjs`（共享，唯一安全路径实现） | `LEGACY_CODES`/`AGENT_CODES` + 18 个函数：`resolvePrivateRoot`/`auditPath`/`ensureDirectory`/`ensureCanonicalDirectory`/`assertCanonicalDir`/`isLinkLike`/`removeTreeSafely`/`assertSafeRelativePath`/`resolveInside`/`writeJsonAtomic`/`normalizeAgentRelativePath`/`sanitizeFailure` 等 |

偏差裁定（对应 B1 报告 6 条）：

| # | 偏差 | 裁定 |
|---|---|---|
| 1 | 新增 5 个 `AGENT_*` 码（ID_INVALID/ARGUMENT_INVALID/BATCH_TOO_LARGE/PATCH_REJECTED/BINARY_FILE） | **采纳**，已并入 §1.7；不得再私增，后续新增需 rev |
| 2 | `turnId` 正则 `/^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/` | **采纳**，已并入 §1.3 |
| 3 | `project.json` 只建 schemaVersion/projectId/createdAt/updatedAt，不写版本指针 | **采纳**，符合 §2.1（B2 是唯一真相） |
| 4 | Base 复制对来源链接“跳过并计数”（`attempt.json.copied.skippedLinks`），candidate 树内链接 fail-closed | **采纳**（来源可信、目标 fail-closed 正确） |
| 5 | 额外 `paths.cjs`/`constants.cjs` 共享模块 | **采纳**，符合 §1.1 允许的共享模块 |
| 6 | 测试文件 `changedPaths` 被判 undeclared（inScope 写 `test/agent-workspace` 无通配） | **Captain 合同缺陷**：实际文件 `test/agent-workspace.{workspace,files,transactions,manifest,repo-safety}.test.cjs` + `helpers.cjs` 已逐个核对属于 B1 范围，接受；后续任务 inScope 用 `test/agent-workspace*` 或显式列文件 |

证据：任务 t4 结构化报告（命令 + 真实退出码）+ `test/agent-workspace.repo-safety.test.cjs`
（含 `templates/miniprogram/src/desktop/scripts/contracts` 指纹前后一致断言、旧链无重复 lstat/realpath 实现断言）。
**独立复核由 verifier 的 review 任务另行出具，通过后才开 B2**；B2 的 `versions.cjs` 必须建立在这些签名之上。

## 2. B2 版本模型接口冻结（workspace-lead 在 B1 之后实现）

### 2.1 版本目录与不可变性

```text
agent-workspace/
  project.json                    # 当前指针与历史索引（B2 唯一真相）
  migration.json                  # 迁移记录（append-only，可选存在）
  versions/<versionId>/
    version.json
    source/**                     # 完整可构建源树快照（不可变）
    diff/summary.json             # 相对父版本的逐文件摘要
    evidence/**                   # 检查/微信/截图等证据引用
```

- `versionId` = `v<正整数>`（v1, v2, …，项目内单调递增；格式 `^v[1-9][0-9]{0,5}$`，与 B1 `VERSION_ID_PATTERN` 一致）。
  同一 versionId 一旦写定不得原地修改。
- `project.json` 形状（冻结字段名）：

```json
{
  "schemaVersion": "agent-workspace.v1",
  "projectId": "…",
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601",
  "currentVersionId": "v2",
  "previousVersionId": "v1",
  "redoVersionId": null,
  "versions": [{ "versionId": "v1", "parentVersionId": null, "createdAt": "…", "treeDigest": "sha256:…",
                 "reason": "import-base", "isCurrent": false, "fileCount": 0, "screenshotCount": 0,
                 "verification": { "static": "unknown", "runtime": "NOT_RUN" } }],
  "migratedFrom": null
}
```

- `version.json`（冻结字段名）：`schemaVersion:"agent-version.v1"`、`versionId`、`parentVersionId`、
  `createdAt`、`reason`、`base:{templateId,version,treeDigest}`、`treeDigest`、
  `source:{kind:"base-copy"|"import-adopted"|"agent-edit", attempt?:{runId,turnId,attempt}, files:{count,bytes}}`、
  `diff:{parentVersionId,added,modified,deleted,unchanged,summaryRelative}`、
  `verification:{static:"pass"|"fail"|"unknown", runtime:"PASS"|"FAIL"|"BLOCKED"|"NOT_RUN", repairs, screenshots, checkedAt}`、
  `evidence:{checks:[{checkId,status,at}], dryRunRelative, runtimeRelative}`、
  `adoption:{sourceKind:"agent-edit"|"legacy-migration", projectId,runId,attempt,candidateId,candidateVersion,integrity, registryDigest?}`（仅采用/迁移产生）、
  `storeDraftRef?`、`presentationPatchRef?`（只存相对引用/摘要，不存正文）。

### 2.2 指针语义（冻结）

- 采用 = 固化当时 attempt 的候选树为新 `versionId`（parent = 当时 `currentVersionId`），
  写 `source`/`diff`/`evidence`，然后 `currentVersionId` 指向新版本；`redoVersionId` 清空。
- `undo`：`currentVersionId = previousVersionId`，把被撤销版本记入 `redoVersionId`；没有父版本 →
  `AGENT_UNDO_UNAVAILABLE`。
- `redo`：只在 `redoVersionId` 非空时把指针推回；没有 → `AGENT_REDO_UNAVAILABLE`。
- 重开：重算 `currentVersionId` 的 `treeDigest` 与 `project.json` 登记值比对；漂移/缺失时状态为
  `unavailable` 并给出明确错误码（`AGENT_VERSION_CONFLICT`），**绝不回退 Base 冒充当前版本**。
- 线性历史：v1 阶段只允许单父链；出现分叉（同父多子）时 `redo` 明确失败，不做自动合并。
- B2 允许的新错误码（`AGENT_*`）：`AGENT_VERSION_NOT_FOUND`、`AGENT_VERSION_CONFLICT`、
  `AGENT_VERSION_IMMUTABLE`、`AGENT_UNDO_UNAVAILABLE`、`AGENT_REDO_UNAVAILABLE`、`AGENT_ADOPTION_FAILED`、
  `AGENT_MIGRATION_FAILED`、`AGENT_EXPORT_IDENTITY_MISMATCH`；不得私增其他码（需 rev）。

### 2.3 旧链迁移（冻结，禁止双写当前真相）

- 触发：项目 `project.json` 无 `agent-workspace/project.json`，且快照存在
  `frontendCandidate.status === "adopted"`（`frontendCandidate` schema 仍为 `frontend-candidate-adoption.v1`）。
- 迁移只能发生一次：先建 `agent-workspace/`，从 Base 复制为 `v1`（`reason:"import-base"`），
  再把已采用候选的 `source` 导入为 `v2`（`reason:"import-adopted"`，记录 `adoption` 身份），
  `currentVersionId="v2"`；`migration.json`（rev5 明确 schema，按 B2 实际形状）为
  `{schemaVersion:"agent-migration.v1", migrations:[{migrationId, from:{frontendCandidate:{candidateId,runId,attempt,adoptedAt}}, createdVersions:["v1","v2"], at}]}`
  （append-only，每次迁移追加一项）。
- 迁移后：`frontend-runs/**` 只作为历史证据，不再作为当前版本真相；项目快照里的
  `frontendCandidate` 只保留为兼容字段（读得到、不再作为导出依据）。
- 迁移失败必须整体失败（不留下半套工作区），错误码 `AGENT_WORKSPACE_INVALID` /
  `AGENT_VERSION_CONFLICT`，并保持旧项目可打开。

### 2.4 导出身份（冻结）

- 正式导出入口不变（现有 `composer:*` / `exportService`），但 B2 必须在导出前校验：
  `currentVersionId` 存在、`treeDigest` 与磁盘一致、overlay/Registry digest 与记录一致、指针未漂移；
  不一致即明确失败，不回落 Base。
- 导出使用的源码树必须就是 `versions/<currentVersionId>/source/**` 的同一份工作树（同源）。

### 2.5 实现边界（B2 纯主进程模块；接线在 B3）

- B2 只写 `desktop/agent-workspace/**`（新增 `versions.cjs` 与必要辅助模块）+ `test/agent-workspace*`；
  可**只读复用** `desktop/frontend-reconstruct/adoption.cjs`、`desktop/project-store.cjs` 与 B1 模块，但**不修改**它们。
- B2 **不接** IPC/preload/主窗口：`desktop/main.cjs`、`desktop/preload.cjs`、`desktop/project-ipc.cjs`、
  `desktop/composer-ipc.cjs`、`desktop/frontend-reconstruct-ipc.cjs`；不改 `src/**`（renderer）、`server/**`、
  `contracts/**`、`templates/**`、`miniprogram/**`、`package.json`。
- 导出身份检查在 B2 以**纯函数**提供（如 `verifyExportIdentity` / `resolveVersionSource`），B3 在 `agent:*`
  与 Composer 导出路径接线；B2 只保证语义与测试，不声称“导出已接线”。
- 迁移只读旧 `project.json` 的 `frontendCandidate` 与 `frontend-runs` attempt（经 `adoption.inspectAdoption`
  只读校验），不写 renderer 快照、不双写当前真相。
- **与总计划 §5 B2 的受控偏差**：计划列了 `desktop/project-ipc.cjs`、`src/domain/projectSnapshot.mjs`；
  本 rev 把接线推迟到 B3/G，避免 IPC 契约冻结前同时改 renderer 与主进程；B3 必须补接线测试（含重开/导出）。

### 2.6 B2 实际签名与裁定（rev4，2026-11-24）

B2（t9，workspace-lead）完成。Captain 独立复跑：`agent-workspace*` **50/50**（B1 37 + B2 13）、
`frontend-contract`+旧链 **65/65**、五模块 require ok；官方 `npm test`/`npm run build` 仍 `spawn EPERM` → BLOCKED。
写入面核对：只 `desktop/agent-workspace/**` + `test/agent-workspace.versions.test.cjs`、
`test/agent-workspace.migration.test.cjs`；`adoption.cjs`（11-19）、`project-store.cjs`（11-19）、
legacy `workspace.cjs`（11-24 17:04，t7 修复）均未被 B2 触碰。

实际导出（B3 只依赖这些）：`versions.cjs` 的 `readProjectState` / `listVersions` / `readVersion` /
`resolveVersionSource` / `verifyExportIdentity` / `reopenProject` / `initProject` / `adoptAttempt` /
`undoVersion` / `redoVersion`；`constants.cjs` 增 §2.2 八码与 version/diff/migration schema；
`workspace.cjs` 增 `copySourceTree`；README 增 B2 章节。

6 点裁定：

| # | 提案 | 裁定 | 理由/要求 |
|---|---|---|---|
| ① | versionId 用 `v1`/`v2`（任务写 `v-<n>`） | **采纳并修正冻结**：`versionId = v<正整数>`，删除 `v-<n>` 写法 | B1 `VERSION_ID_PATTERN=/^v[1-9][0-9]{0,5}$/` 与 §2.1 示例 `v1` 已是该形状；不应为此放宽 B1 正则 |
| ② | agent-edit adoption：candidateId=`attempt-<n>`、candidateVersion=attempt revision、integrity=attempt treeDigest | **采纳**，另加 `sourceKind:"agent-edit"\|"legacy-migration"` | 两类来源必须可区分；只有迁移才记真实 overlay integrity |
| ③ | 迁移 adoption 额外存 `registryDigest` | **采纳为可选字段** `adoption.registryDigest`（仅 legacy-migration 必填） | §2.4 导出身份要比对 Registry digest |
| ④ | `storeDraftRef`/`presentationPatchRef` 固定 null | **采纳** | presentation 未持久化是既有欠账（A2b）；G 阶段再迁移，不得伪造引用 |
| ⑤ | `initProject` 兼容 B1 minimal `project.json`（`created:false`/`upgraded:true`，不丢 attempts） | **采纳** | 必须有测试证明升级不丢 attempts、不重复建版本、不双写 |
| ⑥ | 迁移源 = 旧链 `candidate/src` → `versions/v2/source`；旧 `project.json`/`frontend-runs` 只读 | **采纳** | 符合 §2.3；`frontend-runs` 仅历史证据 |

待办：B2 独立复核（verifier，review）。**复核 pass 前不开 B3**；B3 接线时按 §2.6 签名消费。

### 2.7 B2 复核 r1 结果与返修（2026-11-24）

t10 verdict = **needs_revision**（2 × medium）。门禁真实：`agent-workspace*` 50/50、contract+旧链 65/65、
全量 186/186、五模块 ok；root 等价 1308/1299/7/2，失败集与 A0 一致（6 spawn + 1 MIRROR），无 NEW。
自写 38 项攻击 34 PASS / 4 FAIL（归并 2 findings）：PASS 覆盖 adopt 后旧版本逐字节不变、重复采用、全流程指纹、
undo/redo 边界、reopen 篡改 fail-closed、迁移幂等/回滚、导出身份篡改。证据：`docs/evidence/workspace-agent/b2-review.md`。

| ID | 级别 | 问题 | 返修要求 |
|---|---|---|---|
| F1 | medium | `desktop/agent-workspace/files.cjs:32` 与 `transactions.cjs:45` 的 `guardAttempt` 只校验字段为字符串；伪造句柄可写穿 `versions/<id>/source`（实测 v1 指纹被改），违反 t10 验收 | 增加归属校验（按 `runs/<runId>/turns/<turnId>/attempts/attempt-<n>/` 布局或 `assertOwnership`），拒绝指向 `versions/`、`project.json`、仓库的句柄，零落盘测试；**不接受只写文档约束** |
| F2 | medium | `versions.cjs:709`（迁移）与 `:841`（agent-edit）的 adoption 缺 `sourceKind` | 两处补 `sourceKind:"agent-edit"` / `"legacy-migration"`，补测试断言与 README 说明 |

`migration.json` schema 已按实际形状写定（§2.3），返修无需改结构。r2（t12）验收：F1/F2 复验、
`agent-workspace*` 50(+N)、contract 5/5、旧链 65/65、全量 186/186、root 失败集不超 A0、无测试削弱、越界为零；
**r2 pass 前 B3 不开放**。

**r2 结果（2026-11-24，t12）：PASS，0 findings。** 53/53、65/65、186/186、五模块 ok；root 等价 1311/1302/7/2
（失败集与 A0 一致）；攻击套件重跑 38/38 PASS；F1 单实现 `transactions.assertAttemptHandle` 且伪造句柄零落盘；
F2 两处 `adoption.sourceKind` 独立抽检通过；测试 50→53 全为真断言。→ **B2 门禁关闭，B3 开放。**


## 3. B3 受控任务 RPC 与 preload 冻结

### 3.1 唯一出口

- 新命名空间：`window.smartStore.workspaceAgent`（**不新增第二个 window 全局**；
  旧 `frontend:*` 与既有 preload API 在 B3 不改、不删）。
- renderer 只能传：`projectId`、`runId`、`turnId`、`attemptId`/`revision`、**相对虚拟路径**、
  有界参数；**绝不传目录**、绝对路径、命令、脚本、模块名、env。
- 主进程负责：sender 信任（复用 `isTrustedSender`）、项目归属、版本/revision 校验、
  payload/结果体积上限、每项目串行写、读操作有界并发（≤4）、迟到响应可丢弃。

### 3.2 命令清单（冻结；channel = `agent:<name>`）

| 命令 | 参数（有界） | data（有界） |
|---|---|---|
| `agent:get-context` | `{projectId, runId?, turnId?}` | 项目/当前版本/门店草稿摘要/组件与页面事实摘要/可用 checkId/验证摘要 |
| `agent:list-files` | `{projectId, versionId?, pathPrefix?, maxDepth?}` | `[{path,bytes,sha256?}]`, `truncated` |
| `agent:read-file` | `{projectId, versionId?, path, offset?, limitBytes?}` | `{path,content,bytes,sha256,totalBytes,nextOffset}` |
| `agent:search-files` | `{projectId, versionId?, query, mode:"name"\|"content"\|"both", maxResults?}` | `{matches:[{path,line?,preview?}], truncated}`（rev7 按实现修正） |
| `agent:write-files` | `{projectId, runId, turnId, baseVersionId, changes:[{path,content,expectedBaseSha256?}]}` | `{transactionId,files:[{path,status,sha256}],revision,treeDigest}` |
| `agent:delete-files` | `{projectId, runId, turnId, baseVersionId, paths:[{path,expectedBaseSha256?}]}` | `{transactionId,files:[{path,status}],revision,treeDigest}` |
| `agent:add-image-asset` | `{projectId, runId, turnId, attachmentRef}`（`attachmentRef` = 既有 assetId，不是路径） | `{assetId,relative,caption?}`（复用 `project:attach-images`，不新增写路径） |
| `agent:get-diff` | `{projectId, comparedTo:{versionId?} \| {runId,turnId,attempt}, basePath?}`（结构化，禁止裸 attemptId；二者只给一个） | `{files:[{path,status,additions,deletions,sha256,diff?}],truncated}` |
| `agent:run-check` | `{projectId, runId, attemptId?, checkId, params?}`（`params` 按 checkId 白名单，无 command/env/shell/cwd/任意路径） | `{checkId,status:"PASS"\|"FAIL"\|"BLOCKED"\|"NOT_RUN",durationMs,issues:[{file,line,column,code,message,source}],evidenceRelative?}` |
| `agent:verify-wechat` | `{projectId, runId, attemptId, appId?, timeoutMs?}` | `{status,pages,interactions,screenshots,evidenceRelative}`（工具缺失 → `BLOCKED`） |
| `agent:read-verification` | `{projectId, runId, attemptId?, versionId?, source:"attempt"\|"version"}` | 有界 issues + 截图相对引用（无绝对路径、无 base64）；`source:"version"` 用于 E3 的 before 基线 |
| `agent:read-artifact` | `{projectId, attemptId?, versionId?, kind:"screenshot"\|"report"\|"diff", ref}`（`ref` 必须是本会话返回过的相对引用） | 文本：`{mime,bytes,sha256,content}`（≤64 KiB）；二进制：`{mime,bytes,sha256,contentBytes:Uint8Array}`（≤2 MiB，**不用 base64**；renderer 用短生命周期 Blob URL，不落盘） |
| `agent:submit-candidate` | `{projectId, runId, turnId, attemptId, targetPage, summary?}`（rev7 补 turnId） | `{candidateId,revision,treeDigest,targetPage,status:"submitted"}`（**不能** adopted/exported/verified） |
| `agent:versions` | `{projectId}` | `{currentVersionId, redoVersionId, versions:[{versionId,parentVersionId,createdAt,reason,isCurrent,treeDigest,verification,fileCount,screenshotCount}]}` |
| `agent:adopt-version` | `{projectId, versionId, partialConfirmed?}` | `{currentVersionId, adoption}`（只支持 current 幂等 / previous / redoVersionId；任意历史版本 → `AGENT_VERSION_CONFLICT`） |
| `agent:adopt-attempt`（rev6 新增，B3.x/E 前置） | `{projectId, runId, turnId, attempt, targetPage, partialConfirmed?}` | `{currentVersionId, adoption}`（走 B2 `adoptAttempt`；**B3 当前未实现**，E1 接线前由 workspace-lead 补并复核） |
| `agent:undo` / `agent:redo` | `{projectId}` | `{currentVersionId}` |
| `agent:reopen` | `{projectId}` | 版本身份 + 漂移状态（不抛半套数据） |
| `agent:cancel-run` | `{projectId, runId}` | `{state:"requested"\|"cancelled"\|"too-late", stage?, cancelled:bool}`（`too-late` 不得显示成失败） |

- 进度事件：`agent:progress`，payload 只含
  `{projectId,runId,turnId,attemptId,phase,stage,status,at,message≤120}`；不含路径、源码、base64、prompt、密钥。
  `status ∈ running|succeeded|failed|cancelled`；`stage` 必须来自 §9.1 冻结清单；UI 遇到未知 `stage` 必须显示
  “未知阶段（<stage>）”，**不得静默丢步**（rev2 裁定 F5）。B3 目前只透传 `stage`；B4/E 接线必须只发白名单值（rev6）。
- `run-check` 只接受注册 checkId：`source.check`、`mini.check`、`composer.dry-run`、`output.consistency`、
  `unit.targeted`、`unit.full`、`desktop.contract`、`catalog.check`、`registry.check`、`wechat.verify`
  （后续 `installer.check`、`ui.smoke` 另加）。**模型/UI 只能选 checkId，不能给 command/shell/env/任意参数。**

### 3.3 统一结果 envelope（冻结，只用于 `agent:*`）

```json
// 成功
{ "ok": true, "data": { }, "issues": [], "meta": { "projectId": "…", "versionId": "v2", "runId": "…",
  "turnId": "…", "attemptId": "…", "durationMs": 42, "truncated": false } }
// 失败
{ "ok": false, "code": "AGENT_…", "message": "≤240 字，无路径/源码", "data": null,
  "issues": [{ "code": "…", "severity": "low|medium|high", "file": "pages/menu/index.wxml",
               "line": 12, "column": 3, "message": "…", "source": "composer|wxss|wechat|…" }],
  "meta": { } }
```

- 旧 `frontend:*` 通道保持现有 `{ok,code,message,details}` 形状，B3 **不retrofit**；UI 侧做一个适配层，
  不要求主进程为统一而改旧链。
- B3 新错误码（`AGENT_*`）：`AGENT_UNTRUSTED_SENDER`、`AGENT_PAYLOAD_INVALID`、`AGENT_PAYLOAD_TOO_LARGE`、
  `AGENT_BUSY`、`AGENT_CANCELLED`、`AGENT_TIMEOUT`、`AGENT_CHECK_UNKNOWN`、`AGENT_CHECK_FAILED`、
  `AGENT_RUNTIME_TOOL_MISSING`、`AGENT_VERIFICATION_MISSING`、`AGENT_VERSION_NOT_FOUND`、
  `AGENT_ATTEMPT_NOT_FOUND`、`AGENT_PROJECT_MISMATCH`、`AGENT_RESULT_TOO_LARGE`、
  `AGENT_ARTIFACT_NOT_FOUND`、`AGENT_TARGET_PAGE_UNSUPPORTED`、`AGENT_PARTIAL_CONFIRM_REQUIRED`，
  并复用 §1.7 的工作区码。
- 取消/超时/迟到：`agent:cancel-run` 只取消指定 `runId`；结果携带 `runId/turnId/attemptId`，
  renderer 用 revision 丢弃旧响应；并发写按项目串行（第二个写返回 `AGENT_BUSY`）。
- 日志/返回体：不得回传绝对路径、base64、完整 prompt、原始模型响应、密钥或大段源码；
  `read_file` 结果只回内容本身与其摘要，不回传本地真实路径。

### 3.4 B4 验证注册表（在 B3 之后，冻结边界）

- `desktop/agent-workspace/checks.cjs` 只做注册表与适配：checkId → 固定脚本/包装器；
  不接受命令、shell、env、cwd；只返回有界 issues。
- `wechat.verify` 固定包装 `scripts/wechat-devtools-run.cjs`（复用现有 `frontend-verify` 语义），
  工具缺失/超时/证据矛盾 → `BLOCKED`，不得伪造截图。
- 环境不可用归一（rev9）：同步 spawn `EPERM/EACCES/ENOENT/ETIMEDOUT` 一律 `status:"BLOCKED"`；
  CLI dispatcher 用**工具缺失码**（如 `CHECK_TOOL_MISSING`），`CHECK_FAILED` 只留给“工具存在但检查真的失败/非零退出”。
- dispatcher 仅主进程内部调用（固定 argv）；`--root` 只做绝对路径校验，不暴露给 renderer。
- `verifyWechat` 当前不透传 `pages/interactions/screenshots`（wrapper 无产出即空）；E3 可扩展为**只透传 wrapper 自报的相对引用**，
  不得伪造截图。

### 3.5 B3/B4 边界与 B3 范围（rev5）

- **B3 全量注册命令面**（§3.2 当前 19 个 + `agent:progress`），但 `run-check` / `verify-wechat` 通过**注入的
  checks 接口**调用：B4 落地前必须确定性返回 `AGENT_CHECK_UNKNOWN` / `AGENT_RUNTIME_TOOL_MISSING`，
  **不得伪造 PASS**；B4 提供真实 `checks.cjs` 后替换注入实现。
- **B3 含接线**：`project-ipc.cjs` 项目加载接 `versions.reopenProject`（漂移 → unavailable + 码，项目仍可打开）；
  `composer-ipc.cjs` 有 agent-workspace 时导出前 `verifyExportIdentity`（不一致中止、不回落 Base；无 workspace 旧路径不变）。
  **真实“源码树导出”仍属 C3**；B3 只做身份守卫，不改 Composer 产物模型。
- **B3 不改 renderer**：`src/App.jsx`、`src/state/`、`src/domain/`、`src/components/` 一律不动；唯一新增 renderer 代码是
  `src/services/workspaceAgent/` facade（新增代码中唯一允许用 `window.smartStore` 的地方）。
- **B3 不修改 `desktop/agent-workspace/`**（B1/B2 已冻结签名）；确需改动先报 Captain 出 rev。
- `test/desktop-contract.test.cjs` 只做加法断言，不得删/放宽既有 preload 断言。
- **B4** 只加 `desktop/agent-workspace/checks.cjs`、`scripts/agent-checks/*`、注册表测试，并把注入接口替换为真实实现；
  仍不接受任意 command/shell/env。

### 3.6 B3 实际交付与 5 缺口裁定（rev6，2026-11-24）

B3（t16）完成。Captain 独立复跑：`agent-tools-ipc` + facade **24/24**、`desktop-contract`+契约+旧链+agent-workspace
**119/119**、`frontend-reconstruct*` **186/186**、`require('desktop/agent-tools-ipc.cjs')` ok。
`desktop/preload.cjs` 相对 `origin/main` **只多出 B3 的 `workspaceAgent` 改动**，旧 API 全保留。

实际交付：`desktop/agent-tools-ipc.cjs`（19 命令 + progress；统一 envelope；`isTrustedSender`；每项目写锁 + 读并发 4；
cancel 三态；版本命令只调 B2；checks/attachments 注入，B4 前确定性 `AGENT_CHECK_UNKNOWN`/`AGENT_RUNTIME_TOOL_MISSING`）；
`desktop/preload.cjs`（仅加 `smartStore.workspaceAgent`，19 方法 + onProgress，freeze）；`desktop/main.cjs` 注册（checks:null、progress 广播）；
`src/services/workspaceAgent/index.js`（renderer facade）；`desktop/project-ipc.cjs`（`project:load` 附只读 `versionState`，项目仍可打开）；
`desktop/composer-ipc.cjs`（有 agent-workspace 时写盘前 `verifyExportIdentity`，漂移中止、不回落 Base）；测试 17+7 + desktop-contract +1。

5 缺口裁定（rev6）：

| # | 缺口 | 裁定 |
|---|---|---|
| ① | `adopt-version` 只支持 current/previous/redo；无 attempt→新版本命令 | **接受 B3 现状**：任意历史版本跳转一律 `AGENT_VERSION_CONFLICT`，UI 不得展示为“采用”；新增 `agent:adopt-attempt` 作为 **B3.x/E 前置**（B2 已有 `adoptAttempt`），E1 接线前补；`submit-candidate` 仍只 submitted |
| ② | `get-diff` 的 `comparedTo.attemptId` 是 turn 局部 id | **采纳**：改为结构化 `{versionId}` 或 `{runId,turnId,attempt}`，禁止裸 attemptId（已并入 §3.2） |
| ③ | `read-artifact` 文本/二进制返回形状 | **采纳**：文本 ≤64 KiB 回 `content`；二进制回 `{mime,bytes,sha256,contentBytes:Uint8Array}` ≤2 MiB，**不用 base64**，renderer Blob URL（已并入 §3.2） |
| ④ | progress `stage` 只透传、未强制白名单 | **接受 B3 现状**，B4/E 必须只发 §9.1 白名单；UI 未知 stage 显示“未知阶段（x）”，不丢步 |
| ⑤ | `run-check` 的 checkId 参数白名单未定 | **B4 定义**：标量有界、禁 command/env/shell/cwd/任意路径；B3 现有“拒绝 command/env/shell/cwd”作为下限保留 |

**B3 复核通过前不开 B4**；复核需覆盖：19 命令/envelope/无绝对路径、sender、写锁与 cancel、preload 只加不改、
facade 唯一出口、project-ipc/composer-ipc 接线、注入 checks 不伪造 PASS、测试未削弱、写入面零越界。

### 3.7 B3 复核 r1 结果与返修（rev7，2026-11-24）

t17 verdict = **needs_revision**（2 × medium）。门禁真实：`agent-tools-ipc`+facade 24/24、`desktop-contract`+契约+旧链+
agent-workspace* 119/119、`frontend-reconstruct*` 186/186、require ok；root 等价 1343/1334/7/2，失败集与 A0 一致。
自写攻击 64 项 63 PASS / 1 FAIL（F2），另有行为观察 F1。证据：`docs/evidence/workspace-agent/b3-review.md`。

| ID | 级别 | 问题 | 返修要求 |
|---|---|---|---|
| F1 | medium | `agent:cancel-run` 无 `requested` 态：活动 run 首次 cancel 直接返回 `cancelled` | 首次 cancel → `state:"requested"` + `requestedAt`；停止后查询 → `cancelled`；完成/未知 → `too-late`；补测试 |
| F2 | medium | `read-artifact` 二进制未返回 `contentBytes`（rev6 ③ 未落地） | 二进制 → `{mime,bytes,sha256,contentBytes:Uint8Array}` ≤2 MiB；超限 → **`AGENT_RESULT_TOO_LARGE`**（不用 ARTIFACT_NOT_FOUND）；文本保持 ≤64 KiB `content` |

补充裁定（rev7）：`read-artifact` 超 2 MiB 使用 `AGENT_RESULT_TOO_LARGE`（§3.3 已列），`AGENT_ARTIFACT_NOT_FOUND`
只用于“引用不存在/非法”。返修只允许改 `desktop/agent-tools-ipc.cjs` 与其测试，不动 preload/main/project-ipc/composer-ipc
与 `desktop/agent-workspace/`；r2 通过前 B4 不开放。

非 finding 观察同步（rev7）：① `submit-candidate` 实际要求 `turnId`，§3.2 表已补；② `search-files` 实际返回
`{matches,truncated}`，§3.2 表已按实现修正；③ adopt 不存在/非 current 版本返回 `AGENT_VERSION_CONFLICT`（符合 rev6 ①）；
④ artifact 非法 ref 复用 §1.7 码（符合 §3.3）。

**r2 结果（2026-11-24，t23）：PASS，0 findings。** 29/29、129/129、186/186、require ok；root 等价 1365/1356/7/2
（失败集与 A0 一致）；攻击套件 34/34；F1 工具类错误→`BLOCKED`+`CHECK_TOOL_MISSING`（同步 throw EPERM、懒加载路径、
非零退出+stdout PASS→FAIL 均独立复验）；测试 27→29、无削弱、越界为零。→ **B4 闭环，C3/C4 开放。**

### 3.8 B4 实际交付（rev10，2026-11-24）

B4（t20 + t22 返修）完成并通过 r2（t23=pass，0 findings）。checkId → 实际执行：

| checkId | 实际执行 |
|---|---|
| source.check | `scripts/frontend-capabilities.cjs --check` |
| mini.check | `scripts/validate-miniprogram.cjs` |
| composer.dry-run | `scripts/composer/verify-cli.cjs --root <版本 source>` |
| output.consistency | `scripts/agent-checks/output-consistency.cjs`（只读包装 `desktop/output-consistency.cjs`） |
| unit.targeted | `node --test <白名单 targetFiles 1..5>` |
| unit.full | `node --test test` |
| desktop.contract | `node --test test/desktop-contract.test.cjs` |
| catalog.check | `scripts/component-catalog.cjs --check` |
| registry.check | `scripts/registry-check.cjs` |
| wechat.verify | `scripts/wechat-devtools-run.cjs <版本 source>`（wrapper 自报合法 status 才透传，否则 BLOCKED） |

- 参数白名单：timeoutMs 1000..600000；unit.targeted targetFiles 固定白名单 1..5；wechat.verify appId `wx`+16hex；
  拒绝 command/cmd/shell/exec/spawn/env/cwd/dir/directory/path/script/argv、控制字符、绝对/盘符/UNC/`..`/非标量
  → `AGENT_PAYLOAD_INVALID`。
- 环境错误归一：工具类（EPERM/EACCES/ENOENT/ETIMEDOUT/CHECK_TOOL_MISSING）→ `status:"BLOCKED"` + issue
  `CHECK_TOOL_MISSING`；`CHECK_FAILED` 只用于真实非零/真实失败。
- `wechat.verify` 缺派生 root → `AGENT_CHECK_UNKNOWN`（视为“检查上下文未知”，rev10 记录）。
- 真实集成（Captain full-access shell）：source.check / registry.check / catalog.check / unit.targeted **PASS**；
  mini.check **FAIL** = MIRROR `PRE_EXISTING`；wechat.verify 无 root → **BLOCKED**。
- 注入：`checks` 未传/null → 懒加载真实注册表；对象 → B3 形状；false → `AGENT_RUNTIME_TOOL_MISSING`。
- 门禁：29/29、129/129、186/186；root 等价 1365/1356/7 无 NEW。


r2 观察裁定（rev8）：
① >64 KiB 文本类 artifact 走 `contentBytes`（文本 ≤64 KiB 才回 `content`）——**采纳**，冻结 §3.2 已按此口径；
② 已取消并停止的 run 再次 cancel 返回 `cancelled`（普通完成/未知仍 `too-late`）——**采纳**，这是“取消已生效”的查询语义，
   与 `requested` 首次请求、`too-late` 未参与区分开。

## 4. 依赖门禁与开放顺序（Captain 控制）

| 轮次 | 开放 | 前置门禁 |
|---|---|---|
| 第 1 轮（已启动） | verifier A0（t1）、A4（t5，依赖 A0）；workspace-lead B1（t4）；runtime-engineer D0（t2）；product-ui 只读调研（t3） | 无 |
| B 内核 | B1 → B2 → B3 → B4（串行，workspace-lead 独占写） | B1 报告 + Captain rev3 复核 B1 签名 |
| C 静态与 Composer | C1/C2（runtime-engineer）**已于 2026-11-24 并行启动**（用户批准）；C3/C4（workspace-lead）待 B4 落地 | C4 必须消费已审查的 SourceFacts/source-check；C3 不得改 renderer/IPC 语义 |
| D 模型接入 | D1–D4（runtime-engineer） | D0 结论 + B3 RPC 契约落地；product-ui 才可接真实 facade |
| E 核心交付 | 只做 `menu + product-card` 切片 | **C4 人工切片通过 + verifier 独立复核**；否则禁止任何真实图片生成 |
| F/G/H/I/J | 按总计划 | 各自阶段门禁；不一次展开 |

- **硬门禁**：C4 人工 menu + product-card 垂直切片未通过（含 verifier 独立复核）前，
  不得开始 E 的真实图片生成；不得用 React 预览截图冒充微信运行时截图。
- 每阶段必须同时收到**实现报告**与**独立验证报告**才开下一阶段；不把“计划存在”当交付。
- A 的遗留失败不阻塞 B 原型，但必须保留到 I 阶段收口。

### 4.1 C3 Composer 源码覆盖契约（rev11，C3 已实现待复核）

- **输入**：`overlayRoot` 由主进程派生（不由模型/渲染进程给目录）；根下
  `<overlayRoot>/source-bundle.json` = `{schemaVersion:"frontend-source-bundle.v1", base:{id,version,treeSha256},
  targetPage|targetPages, files:[{path,sha256}], deleted:[…], components:[{componentId,scope:"page"|"shared",pages?}], assets:[…]}`；
  `files` 为**最终完整文件内容**（不是 diff）。
- **校验（fail-closed）**：真实目录且拒链接/reparse；Base 身份 + 源树 sha256；路径仅 `pages/`、`components/`、`assets/`，
  禁绝对路径/盘符/`..`/反斜杠/NUL；声明 sha 与真实字节一致；资产真实魔数 png/jpeg/webp、单件 ≤2 MiB、≤20；
  新增组件四件套；page scope 的页面必须在 Plan 内。
- **覆盖语义**：页面/组件直接覆盖（无 WXML 替换/WXSS 追加，全仓无 `styleMode` 第二套样式）；page-scoped 组件生成
  `components/<id>--<page>` 且只改目标页 `usingComponents`；shared 覆盖共享组件并在报告列出 affected pages；
  支持新增组件/JSON/JS、页面 JS、本地资产；`usingComponents` 按最终 WXML 重算（保留已用/补变体/清新未用）。
- **错误码**：`SOURCE_OVERLAY_COMPONENT_UNKNOWN`（未知标签）、`SLOT_REQUIRED_BY_PLAN`（已分配插槽缺锚点）、
  `SOURCE_OVERLAY_CONFLICT`（与 FrontendPack 同时出现，先于 Recipe 状态门禁）、`FEATURE_ASSET_MISSING`、
  `SOURCE_OVERLAY_*` 输入校验族。
- **source-changes.v1**：`base{id,version,treeSha256}` + `plan.digest` + `lock{path,registryDigest}` +
  `overlay{digest,targetPages,components,sharedImpacts}` + `summary{added,modified,deleted,unchanged}` +
  `files[{path,status,sha256,baseSha256?}]`；无时间戳/绝对路径，自身不入 diff。
- **同源确定性**：dry-run / 重复导出 / 重开 / 正式导出同一实现；两次 compose 的 treeSha + lockDigest 一致；
  `buildProjectFiles` 与导出逐字节一致。
- **entry.assets**：从 pack 根读取并保留 `assets/<id>/<relative>` 相对子路径；找不到回落 entry.path 并按旧 basename
  落盘（兼容注释保留）；旧空行为不变。
- **真实门禁（Captain full-access）**：composer 全量 **133/133 PASS**、overlay **6/6**、frontend-reconstruct **186/186**；
  沙箱 EPERM 环境下 composer-media 那条只能记 BLOCKED，不得写 PASS。
- **reparse 边界（rev12 返修要求）**：`loadSourceOverlay` 根必须 `realpath(root) === 规范化词法 root`
  （win32 大小写不敏感），否则 `SOURCE_OVERLAY_ROOT_INVALID`；每个文件/资产读取的 `realpath` 必须仍在 `realRoot` 内，
  并逐段拒绝 reparse（junction 的 lstat 是普通目录，必须用 realpath 双检），拒绝时不得继续 compose、不得读入外部内容。
- **treeSha 口径（rev12）**：`result.treeSha256` 指**项目文件树**；`generation-report.json`/`生成报告.md`/`composition.lock.json`
  含时间/耗时属易变元数据，确定性比较排除它们（三次比较口径一致）。


## 5. 写入锁（共享文件串行）

- `desktop/agent-workspace/**`、版本模型、`desktop/agent-tools-ipc.cjs`、`desktop/main.cjs`、
  `desktop/preload.cjs`：仅 workspace-lead；B3 相关改动作为一个串行任务提交，不与其他任务并行编辑。
- `src/App.jsx`、`src/state/sessionMachine.mjs`：同一时刻只允许一个任务编辑，由 Captain 排期。
- `contracts/**` 与 `contract.generated.*`：改契约源后必须 `node scripts/frontend-contract.cjs --write`，
  再 `--check` 与 `test/frontend-contract.test.cjs` 全绿；生成物不得手改。
- `templates/**`、`miniprogram/**`、`templates/registry/**`、`templates/catalog/**`：只经 Composer/Registry/
  Catalog 脚本，不手改；禁止 `catalog:write`/`mirror:sync`/`registry-check --write` 掩盖基线漂移。
- `docs/handoff/**`：仅 Captain；成员只写自己的证据目录与任务报告。

## 6. 证据与汇报口径（冻结）

- 每个任务按总计划 §0.3 模板汇报；状态词只用 `PASS / FAIL / BLOCKED / NOT_RUN`，`partial` 不等于通过。
- 官方门禁（`npm test`/`npm run build`）在沙箱内 `spawn EPERM` → 记 `BLOCKED` 并说明等价门禁；
  等价门禁 ≠ 官方门禁 ≠ GUI/微信运行时验收。
- 真实模型/微信/UIA/安装包证据必须可复核（含 sha256、runId/attempt、tree digest、原件或明确清理说明）；
  缺证据写 `NOT_RUN`/`BLOCKED`，不改写历史证据。
- 发现越界、删除用户改动、伪造证据、要求绕过路径/命令边界时，立即停止该任务并报 Captain。

## 7. 变更流程

1. 成员发现本冻结不可实现（例如上限与真实文件冲突）→ 停止扩范围，给 Captain 一页证据 + 建议。
2. Captain 更新本文件（rev+1）并在任务描述/消息中同步；B2/B3 实现按新 rev 执行。
3. 不得在实现里“先按另一种形状写，事后再改契约”。

## 8. 待补（rev7 内容）

- B3 独立复核若返修，rev7 记录返修点与最终签名。
- B4 落地后补：checkId → 脚本映射表、各命令 payload/artifact 上限具体数值（当前 artifact 上限 2 MiB）。
- B3.x：`agent:adopt-attempt`（attempt→新版本）在 E1 接线前补并复核。
- B3 接线后补：`agent:*` 与 composer 导出路径的实际调用点（`resolveVersionSource`/`verifyExportIdentity`）。

## 9. rev2 修订裁定（product-ui t3 提案 F1–F9）

裁定时间 2026-11-24。依据 `docs/evidence/workspace-agent/ui-survey.md`（product-ui，t3，已完成）。
**裁定只改本冻结，不开新任务，不扩大首轮范围。**

| 提案 | 裁定 | 落地方式 |
|---|---|---|
| F1 截图引用 + read-artifact | 采纳（改字段名） | 截图引用字段用 `relative`（禁用 `path`，避免被当绝对路径）；新增 `agent:read-artifact`，只接受本会话返回过的相对引用，单件 ≤ 2 MiB，返回 `{mime,bytes,sha256,content}`；renderer 用短生命周期 Blob URL 展示，不落盘、不回绝对路径 |
| F2 before 基线（E3） | 采纳（不新增命令） | `agent:read-verification` 增加 `source:"attempt"\|"version"` 与可选 `versionId`；before 取值必须同 route/尺寸/门店/身份 |
| F3 单页 targetPage | 采纳 | `get-context.targetPages:[{id,enabled,reasons}]` 由 SourceFacts/page-contract 可用性推导（**不是**硬编码 8 页，v1 只有 home/menu 有事实时其余 `enabled:false`）；`submit-candidate` 必填 `targetPage` 并写入 attempt.json |
| F4 cancel 三态 | 采纳 | `{state:"requested"\|"cancelled"\|"too-late"}`；`too-late` 显示“已完成，无法取消”，不得报成失败 |
| F5 进度终态 + 不静默丢阶段 | 采纳 | `status` 枚举与“未知阶段不得丢弃”已并入 §3.3；stage 清单见 §9.1 |
| F6 versions 字段 | 采纳 | 已并入 §3.2 行（`redoVersionId` + `isCurrent/treeDigest/verification/fileCount/screenshotCount`） |
| F7 版本 undo 与字段撤销 | 采纳（文档 + UI 约束） | 版本 undo/redo 只由版本卡触发、只动指针；既有 Ctrl+Z（字段撤销，`sessionMachine.mjs:2631-2661`）保持不变；两处文案必须区分“撤销字段 / 撤销版本”，禁止同一状态双写 |
| F8 get-diff 对照 | 采纳 | `comparedTo:{versionId?\|attemptId?}` 只给一个 + `basePath`；files 含 `sha256`；体积沿用 §1.4 |
| F9 smartStore 只在 `src/services/**` | 采纳为架构规则，**不在 B3 落地** | 列为 G4/UI 清理项（现状 6 处越界见 §11）；B3 新增代码只经 `src/services/**` |

附项裁定：
- `run-check.params` 按 checkId 白名单化（无 command/env/shell/cwd/任意路径）；白名单在 B4 `checks.cjs` 内定义并测试。
- `add-image-asset.attachmentRef` = 既有 assetId（`project:pick-images`/`attach-images` 产物），不是路径/base64。

### 9.1 `agent:progress` stage 清单（冻结；新增需 rev）

`analyze / read-context / plan / edit / write / materialize / validate / render / workspace / verify /
compose / mini-check / consistency / observable / wechat / repair / adopt / done`。

旧 `frontend:progress` 的 9 阶段保持不动（不 retrofit 旧链）。

## 10. 已记录缺陷（product-ui t3 发现；**不属于首轮修复**）

| ID | 级别 | 事实 | 处置 |
|---|---|---|---|
| D-UI-1 | P0 | 真实进度静默丢步：`materialize.cjs` 发出 validate/render/workspace/write/commit，renderer 只认 9 阶段且未知阶段 `return sameState`（`src/domain/frontendReconstruct.mjs:73-83,848-849`） | 旧链缺陷；B3 新链按 §3.3/§9.1 不得继承。修复另派（进 A2/F 清理清单） |
| D-UI-2 | P0 | 微信截图在 IPC 层丢失：`verify-runtime.cjs:335` 产出 `{label,path,bytes}`，`frontend-reconstruct-ipc.cjs:1256` 读 `shot.name` → screenshots 恒空，`pages[].screenshot` 未映射。**Captain 已复核行号属实** | E3 的 before/after 不能靠旧链补，须走 rev2 `read-artifact`；旧链修复由 Captain 决定派给谁（不在首轮） |
| D-UI-3 | P1 | 阶段标签三份副本（IPC 142-156 / renderer 85-95 / `agentRunProcess.mjs:45-55`） | 收敛到单一来源；G/清理阶段 |
| D-UI-4 | P1 | `screen-reference` 渲染进程直连后端且不带授权（`screenReferenceService.js:95-100`、`App.jsx:3000`），与 B2 凭证模型冲突 | G4 退出点，不在首轮 |

处置口径：只登记，不派修复；进入 I 阶段“遗留/阻塞”表。任何人不得拿这些缺陷当“B1/B2 可以不做”的理由，
也不得让新链复用 D-UI-1/D-UI-2 的形状。

## 11. smartStore 出口规则（rev2）

- 新增代码：`window.smartStore` 只允许出现在 `src/services/**`；组件与 hook 不得直接调用。
- 现状越界：`src/components/chat/MarkdownView.jsx:13`、`src/components/preview/RealPreviewPanel.jsx:64-76`、
  `PreviewLaunchButton.jsx:20`、`DevtoolsPreviewDock.jsx:84,139`、`src/App.jsx:2057,2183,2211,2252,2265`。
  由 G 阶段清理任务统一收口；B3 不顺手改这些文件。

## 12. D0 结论与 D1 约束（rev2 附录，2026-11-24）

依据：runtime-engineer t2 报告 + `docs/evidence/workspace-agent/d0/{probe.md,requests.md}`，
真实网关 `api.deepseek.com`，46 次真实调用（2026-11-24T08:43:22Z–08:44:15Z），脱敏形状已归档。
**D0 未改任何产品代码**（只新增 `scripts/model-capability-probe.cjs` 与证据）。

### 12.1 能力矩阵

| 能力 | 结论 | 备注 |
|---|---|---|
| tools / tool_calls / 多轮工具循环 | **PASS** | deepseek-flash 与 deepseek-chat 别名均返回 tool_calls；回填 assistant tool_calls + tool 后第二轮 `stop`；HTTP 适配器与主进程直连两条通道都验证 |
| 多模态 content parts（image_url） | **PASS** | 64×64 红 PNG 问答，两模型 `answerIsRed=true`；直连带图 200 |
| tools + response_format 同请求 | 不互斥 | 同请求 200 且返回 tool_calls；response_format 未强制成 JSON 正文 |
| 截断/上限 | 部分 PASS | `max_tokens` 请求层接受至 262144（未真生成）；适配器硬上限 8000；`finish=length` + `truncated=true` |
| 错误形状 | PASS | 400/401 错误体键 `code/message/param/type`；超时 → `DEEPSEEK_TIMEOUT` |
| 模型名 | PASS | `/models` 仅 `deepseek-flash`、`deepseek-v4-pro`；`deepseek-chat` 被接受但响应 `model=deepseek-flash`；`deepseek-v4.1-flash` 与 `cn:` 前缀均 400 |
| 本地代理原样透传 | **BLOCKED** | `127.0.0.1:17863` ECONNREFUSED、`192.168.222.1:17863` ETIMEDOUT；未用官方 API 结果代替代理结论 |

### 12.2 D1 实现约束（必须写进 D1 任务描述与验收）

1. **视觉预算**：带图请求 `max_tokens ≥ 2000`；默认超时放宽（30 s 偏紧，成功样本 18.0 s；建议 ≥60 s 或按 run 预算）。
2. **截断信号不得丢**：适配器必须在抛 `DEEPSEEK_RESPONSE_INVALID` 之前先判定 `finish_reason=length`/`truncated`；
   “空正文 + length”必须作为 truncated 返回，禁止当“无响应”。
3. **tool_calls 不保证 `finish=stop`**：`truncated=true` 时**拒绝执行/回放该批工具调用**（适配器已映射 truncated，D1 必须消费）。
4. **response_format 不能替代工具协议**：带 tools 时仍可能返回 tool_calls，D1 不得假设 json_object 得到纯 JSON 正文。
5. **直连对等**：主进程 `modelChat` 返回体缺 `finish_reason/truncated`，且丢弃 `response_format/reasoning_effort`；
   D1 走直连须自建截断检测，或按 D2 扩展 IPC 返回体。
6. **错误码归一**：模型名统一 `deepseek-flash`；HTTP 与直连 402 映射不同（直连 `RATE_LIMITED` / HTTP `REQUEST_REJECTED`），D1 需归一。
7. **协议结论**：Flash 支持 tools，D1 可做真实工具循环，**不必**退回“结构化输出 + 外部编排”；
   但“不支持工具时的降级路径”仍按总计划 §7 保留（不因本次 PASS 删除）。

### 12.3 新增 runtime 缺陷（不属首轮修复；D1/D4 输入）

| ID | 级别 | 事实 | 处置 |
|---|---|---|---|
| D-RT-1 | P0 | 带图 + 长回答 + `max_tokens=100` → 空正文 + `finish=length`；适配器在算 truncated 前抛 `DEEPSEEK_RESPONSE_INVALID`，截断信号丢失（3 次 1 次复现） | D1 按 §12.2-2 修；修复前不得声称“截断可见/可回灌” |
| D-RT-2 | P1 | 直连 `modelChat` 无 `finish_reason/truncated`，丢弃 `response_format/reasoning_effort`，thinking 固定 disabled | D2 对等项 |
| D-RT-3 | P2 | 代理透传未验证（17863 不可达） | 需先起代理再用同一探针重跑；在此之前代理结论保持 BLOCKED |

### 12.4 影响边界

- 影响：D1/D2 的任务描述与验收（视觉预算、截断、错误码归一）。
- 不影响：B1 主线、C1/C2 SourceFacts、Composer 与模板资产。
- **D1 仍未开放**：需 B3 RPC 落地；product-ui 的真实 facade 接线同理。

## 13. A0 基线摘要与本轮返修项（2026-11-24）

依据 verifier t1（A0）与 `docs/evidence/workspace-agent/baseline/{baseline.md,env-probe.md,raw/*.log}`。

### 13.1 环境事实（实测）

- MySQL 3306 / Redis 6379 / 后端 3000 / Vite 5173 **均未监听**；`readyz` 连接失败。
- 微信 CLI 存在于 `E:\微信web开发者工具\cli.bat`，但 `cli islogin` 初始化写 AppData 被 `EPERM` → 微信运行时 BLOCKED。
- Electron 33.2.1 仅 `--no-sandbox --version` 可执行（exit 0）；GUI/UIA **NOT_RUN**。
- `server/.env`：`DEEPSEEK_*` 存在；`WECHAT_APP_ID/SECRET`、`IMAGE_API_KEY`、`VISION_MODEL_NAME` 为占位
  → **C4 前不得接真实生图**（与总计划一致）。

### 13.2 官方门禁现状（A0，真实退出码）

| 结果 | 命令 |
|---|---|
| PASS（6） | `registry:check` 0、`catalog:check` 0（**旧 4 项漂移已由 `8adb88c` 修复，旧基线结论作废**）、`check:packaging` 0、`frontend:capabilities:check` 0、`app:capabilities:check` 0、server `tsc --noEmit` 0 |
| FAIL（2，PRE_EXISTING） | `mini:check` 1、`mirror:check` 1（MIRROR 摘要 `30a411f3…` 五种变体均无法复现；内容与真源逐字节 0 差异，另有 gitignored DevTools 文件使 149→150）——修法需 A2f/I 决策，禁止 `mirror:sync` 洗绿 |
| BLOCKED（4，`spawn EPERM`，用例未执行） | `npm test`、`npm run build`、`test:desktop`、server `npm test`；`agent:app` 同 BLOCKED |
| 用法缺口（1） | `composer:verify` 裸命令 exit 2（脚本要求 `--root`）→ 产物校验本轮 **NOT_RUN** |
| 等价门禁（≠官方） | root 单进程 1294 tests / 1284 pass / 8 fail（6 沙箱 spawn + 1 PRE_EXISTING MIRROR + 1 NEW，见 §13.3）；desktop 23/23；server 539 pass / 6 文件 MySQL 不可达 |

### 13.3 本轮 NEW 回归（B1 引入，B 阶段门禁必须收口）

- 现象：`test/frontend-contract.test.cjs:73`（`assert.match(workspace.cjs, /require\('\.\/contract\.generated\.cjs'\)/)`）
  在 B1 共享化后失败。根因：旧 `desktop/frontend-reconstruct/workspace.cjs` 不再直接 require 生成契约，
  改为从 `desktop/agent-workspace/paths.cjs` 间接取（paths.cjs 自身确实直接 require，单一来源未破）。
- 附带疑点：`desktop/agent-workspace/constants.cjs:75` 本地声明 `RUN_ID_PATTERN = /^frun-…/`，与
  `contract.generated.cjs:73` 逐字相同 → 构成第二份同义常量，需改为引用生成契约。
- 处置：t6 独立复核确认 → repair 任务（workspace-lead）→ review r2。**t6 verdict=pass 前不开放 B2。**
- 约束：修复不得删除/放宽契约守卫测试来变绿；优先让 legacy 消费面继续直接 require 生成契约。

### 13.5 t6 独立复核结论与返修口径（2026-11-24）

t6 verdict = **needs_revision**（review failed），2 条 finding；独立攻击用例 48 项（45 PASS / 2 FAIL / 1 BLOCKED，
symlink 仅因沙箱 EPERM）。B1 其余事实经独立复核成立：路径穿越/绝对/盘符/反斜杠/NUL/超长/空段全部拒绝且零落盘；
junction 读写与 manifest 均 `AGENT_PATH_LINK` 零逃逸；`expectedBaseSha256` 冲突不落盘；批内部分失败无半提交、
无 `.staging-*`；暂存篡改 commit 拒绝；重开一致；treeDigest 独立重算 `sha256:b9590bef…`（139 文件）与
buildManifest/逆序同值、空树 `sha256:e3b0c442…`；正式仓库 6 目录指纹前后不变；LIMITS 13 项与 §1.7 全部 21 码对齐；
无 `.skip/.todo`、既有测试零改动；越界为零。证据：`docs/evidence/workspace-agent/b1-review.md`。

| ID | 级别 | 问题 | 返修要求 |
|---|---|---|---|
| F1 | high | legacy `desktop/frontend-reconstruct/workspace.cjs` 不再直接 require `./contract.generated.cjs`（经 paths.cjs 间接），触发 `test/frontend-contract.test.cjs:73` 失败（NEW） | 恢复直接 require 取 RUN_ID_PATTERN 等契约常量；路径安全函数仍用 paths.cjs；**不得删/放宽/跳过守卫测试** |
| F2 | medium | `desktop/agent-workspace/constants.cjs:75` 本地 `RUN_ID_PATTERN` 与生成契约逐字相同（第二事实源） | 删除本地副本，从生成契约取；补同源断言；TURN/ATTEMPT/VERSION 属 agent 域自有，需注释说明不来自 frontend 契约 |

r2 验收（verifier t8）：`test/frontend-contract.test.cjs` 5/5、`agent-workspace*` 36(+1)/36、旧链 60/60、
frontend-reconstruct 全量 186/186、root 等价全量失败集合不得比 A0 多；仍不得削弱测试。

**r2 结果（2026-11-24，t8）：PASS，0 findings。** 独立复验：contract 5/5、agent-workspace 37/37、旧链 60/60、
全量 186/186；root 等价 1295 tests / 1286 pass / 7 fail / 2 skip，失败集合与 A0 完全一致（6 spawn EPERM +
1 MIRROR PRE_EXISTING），NEW 已消失；攻击套件重跑 47 PASS / 0 FAIL / 1 BLOCKED（目录 symlink 仅沙箱 EPERM，
junction 真实 PASS）；F1 守卫测试零改动、F2 四引用全等且 agent 域模式注释在案；t7 仅 3 文件、无夹带。
→ **B1 门禁关闭，B2 开放。**

### 13.4 与总计划的口径修正

- 总计划 §4 A0 说“旧基线 catalog 4 项漂移失败”，**作废**：现 `catalog:check` = 0。
- 总计划 §4 A4 的 P7 真实模型矩阵不再可复核（原件已清），A4 只能按 `BLOCKED/UNMET` 收口，不重造。

### 13.6 环境更新（2026-11-24 17:48，用户已启动服务）

- Captain 实测：**3306 MySQL OPEN、3000 后端 OPEN、5173 Vite OPEN**；`/api/v1/health` 200、
  `/api/v1/readyz` 200 `{status:ok, database:ok, cache:memory}`。
- **6379 Redis CLOSED**：后端走 `CACHE_DRIVER=memory`，不得宣称“Redis 链路已验收”。
- 仍未解除：微信 CLI 写 AppData `EPERM`；Electron/UIA `spawn EPERM`；官方 `npm test`/`npm run build`
  `spawn EPERM`；微信真实编译/截图仍 `BLOCKED`。
- 影响：A0 记 `BLOCKED` 的 server DB 测试现在可判定真实结果（由 A3 复验任务取证）；
  B/C 阶段纯 Node 模块不受影响；E 的微信运行时证据仍需可 spawn + 已登录 DevTools 的机器。

**t13 复验结果（2026-11-24，verifier）**：`GET /health` 200、`/readyz` 200（database=ok）、`5173` HTML 200（含 `id="root"`）；
server `npx vitest run --configLoader native --pool=threads` → **EXIT 1**：6 files failed / 29 passed，539 pass / 86 skip，
6 文件均因测试夹具 `execSync('npx prisma migrate deploy')` → `spawnSync cmd.exe EPERM`，**仍 BLOCKED（环境），不是 DB 不可达**；
server `tsc --noEmit` → 0；`agent:smoke` → 2（`spawnSync node.exe EPERM`，UIA 仍 BLOCKED）。
一次 `0xC0000005` 异常退出已如实记录为一次性环境异常。
→ 可更新的口径只有“服务/DB 就绪 + server 非 DB 测试 539/539 + tsc 通过”；**DB 6 文件（86 例）、UIA、微信、官方 root 门禁仍须可 spawn 的机器终验**，
不得宣称“server 全量测试通过”。

### 13.7 微信 DevTools 探测（2026-11-24 17:52，用户已打开开发者工具）

- 进程枚举可用（23 个进程），但 **9420/9421/9422 全部 CLOSED** → 自动化端口未开。
- `& 'E:\微信web开发者工具\cli.bat' islogin` → 初始化失败：
  `EPERM: operation not permitted, open 'C:\Users\<user>\AppData\Local\微信开发者工具\User Data\<id>\Default\.cli'`
  （沙箱禁止写 AppData，CLI 无法落登录/服务状态）。
- `scripts/wechat-devtools-run.cjs:131` 用 `spawn(cmd.exe /d /s /c, ['cli.bat', …])` 驱动 → 本会话 `spawn EPERM`。
- 结论：**打开 DevTools 是必要但不充分**。要产真实微信证据需要（C4 通过后执行）：
  1. 在**普通终端**跑 `cli.bat islogin`（应返回 true）并 `cli auto --project <导出/候选副本> --auto-port 9420`；
     或在 DevTools「设置 → 安全设置」开启服务端口；
  2. 端口 9420 监听后，automator 可用 TCP 连接（无需我们 spawn）；
  3. 我们的固定入口目前把 CLI 步骤与 automator 合在一个进程里，E 阶段需要“connect-only”模式（属 C4 后工作，未开始）。
- 在此之前微信运行时证据保持 `BLOCKED`，不得用截图/预览替代。

### 13.8 仓库同步策略（2026-11-24，用户已确认）

- 远端 `origin/main` 在另一条线上领先 5 个提交（`70e0057..f407c49`），涉及 `src/App.jsx`、`src/state/sessionMachine.mjs`、
  `desktop/main.cjs`、`templates/**`、`miniprogram/**`、`.resultverify/t6/**` 等；本地工作树仍基于 `70e0057`。
- 已按阶段推送 3 个提交到远端（用临时 worktree 叠到 `origin/main` 上，未触碰本地脏工作区）：
  `fb6065d`（A0/A4 证据）、`8ed7e28`（D0 探针）、`5053118`（B1/B2 内核）。远端 HEAD = `5053118`。
- 推送通道：本机 git 全局 `http.proxy=http://127.0.0.1:7877`（Clash）对 HTTPS 握手失败；
  一次性使用 `socks5h://127.0.0.1:7877` + `http.sslBackend=openssl` 成功。**未修改用户全局 git 配置，未 force push。**
- 本地 `main` 与远端分叉（ahead 3 / behind 8）；那 3 个本地提交与远端 3 个内容相同、SHA 不同。
  安全备份：本地分支 `backup/local-before-sync-20261124`（指向 `13928c3`）。
- **用户决定的策略：等 B3/C1 完成并提交后，统一对齐一次**，然后一次性 push；此前不推送新提交。
  对齐步骤（届时执行，需备份 + 不用 force）：
  1. 先把 B3/C1 提交到本地；
  2. 预存用户既有未提交改动（commit 到 `wip/pre-existing-changes` 分支，不用 stash 丢弃）；
  3. `git rebase --onto origin/main 13928c3 main` 把 B3/C1 叠到远端最新（冲突逐文件裁决）；
  4. 解冲突后跑 `agent-workspace*`、`frontend-contract`+旧链、`frontend-reconstruct*`、以及 B3/C1 的测试；
  5. `git push origin main`（直连或 socks5h+openssl），并核对远端 HEAD。
- 风险提醒：B3 触碰的 `desktop/{main,preload,project-ipc,composer-ipc}.cjs` 与远端 5 个提交有重叠，rebase 时可能有冲突；
  不得用 `-X ours/theirs` 整包吞掉，必须逐文件对照远端语义。

**对齐执行结果（2026-11-24 19:0x）**：

- 以 `origin/main`（`5053118`）为基准用临时 worktree 重建并推送：
  `183eb16` C1、`d61d70d` C2、`3ff97ea` C1 快照对齐远端模板、`a248685` B3；随后补 `1841c4e`
  修复 `main.cjs` 漏注入 `userDataDir`（否则导出身份守卫会静默跳过）。远端 HEAD = `1841c4e`。
- 对齐暴露并修复的真实问题：远端 5 个提交改过 Base 模板 → C1 快照在旧基线生成会 `--check` 漂移，
  已在新 Base 重新生成（78,120 B，8 页/15 组件/4 Plan/84 UI 状态不变）。
- 本地干净路径已对齐远端内容：`templates/`、`miniprogram/`、`server/src/agent/frontend-reconstruct/`、
  `server/src/agent/workspace/`（重新生成的 C1 快照）、`desktop/main.cjs`。
- 本地 `main` 仍与远端分叉，**未做 `reset --hard`/`checkout -- .`**（工作区有用户未提交改动）；
  后续阶段提交继续用“worktree 叠到 origin/main + push”的方式，等用户决定是否整体对齐本地分支。
- 推送通道：`socks5h://127.0.0.1:7877` + `http.sslBackend=openssl` 一次性参数；未改全局 git 配置、未 force push。

