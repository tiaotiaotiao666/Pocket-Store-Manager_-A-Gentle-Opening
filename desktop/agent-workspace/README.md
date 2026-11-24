# B1：Workspace Agent 私有工作区内核

> 契约：`docs/handoff/Workspace-Agent-B阶段接口冻结.md` rev1（§1 为 B1 范围）。
> 本轮只做 B1：**不接模型、不做版本/采用语义（B2）、不做 IPC/preload（B3）、不改 Composer**。
> 所有模块是纯 CJS 主进程模块：不依赖 Electron、不 `require('electron')`、没有
> `child_process`/shell 执行入口，可被纯 Node 测试直接 `require`。

## 1. 目录布局（固定，见冻结文档 §1.3）

```text
<userData>/projects/<projectId>/agent-workspace/
  project.json                          工作区元数据（schemaVersion/projectId/createdAt/updatedAt）
                                        B1 不写版本指针（currentVersionId/versions 留给 B2）
  versions/<versionId>/source/**        B2 的不可变版本源；B1 只读它作为“已采用版本”来源
  runs/<runId>/
    run.json                            {schemaVersion:"agent-run.v1", turns:[turnId…]}
    turns/<turnId>/
      turn.json                         {schemaVersion:"agent-turn.v1", attempts:[attempt-<n>…]}
      attempts/attempt-<n>/
        attempt.json                    来源、treeDigest、revision、fileCount、totalBytes
        candidate/**                    工作树（list/read/search/write/delete 的对象）
        verification/**                 B3/B4 证据（B1 只创建空目录）
        .staging-<8hex>/                事务暂存（提交/丢弃后必须消失）
```

- `projectId` 用 `desktop/frontend-reconstruct/contract.generated.cjs` 的 `PROJECT_ID_PATTERN`（唯一事实源）。
- `runId` = `/^frun-[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/`；`attempt` = `attempt-<1..9999>`；
  `turnId` = `/^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/`；`versionId` = `v<1..999999>`。
- 工作树来源两种：`{kind:'base'}`（`templates/base/ordering-base/1.0.0/src`，唯一模板真源）
  与 `{kind:'version', versionId}`（`versions/<versionId>/source`）。复制只复制真实文件、
  不跟随链接、跳过 `.git`/`node_modules`。

## 2. 不变量（每条都 fail closed）

1. 写入只允许落在调用方传入的 `<userData>` 私有根内；仓库内根（`templates/**`、
   `miniprogram/**`、`src/**`、`desktop/**` 等）一律 `AGENT_PATH_PROTECTED`。
2. 路径只接受 POSIX 相对路径：拒绝绝对路径、盘符、UNC、`..`、空段、`.`、`\`、NUL/控制字符、
   首尾空白、结尾 `/`、超过 240 字符、超过 24 层；解析后不得越出工作树根。
3. 已存在段必须是真实目录/文件：`lstat` + `realpath` 双检拒绝 symlink 与 Windows junction；
   清理只删链接本身，绝不跟随到工作区之外。
4. `write_file` 是**完整文件覆盖**：`content` 是完整内容，不接受残片拼接、不接受 unified diff
   （`AGENT_PATCH_REJECTED`）；空字符串写 0 字节文件，**不是**删除；删除只走显式 `delete_file`。
5. `expectedBaseSha256`（接受 `sha256:<hex>` 或裸 hex）必须与当前文件摘要一致；`null` 表示
   “期望文件不存在”。不一致立即 `AGENT_BASE_DIGEST_MISMATCH`，**不落盘**、不留暂存。
6. 事务：先把完整下一棵树复制/变更到 `.staging-<8hex>/candidate`，再用原子 rename 交换；
   任一步失败整批不提交并清理暂存；提交成功后删除暂存并更新 `attempt.json` 的
   `treeDigest/fileCount/totalBytes/revision`。重开时遗留 `.staging-*` 被安全清理。
7. `manifest`/diff 确定性：文件按 POSIX 相对路径升序；**不含时间戳**；相同输入必然相同摘要。

## 3. `treeDigest`（冻结算法 §1.6）

- 文件摘要：`sha256:<hex>`（小写）对文件**字节**求 SHA-256。
- `treeDigest`：文件按 POSIX 相对路径升序（区分大小写）排列，逐个拼接
  `"<path>\n<sha256hex>\n"`（UTF-8），对拼接结果求 SHA-256，输出 `sha256:<hex>`；
  空树 = `sha256:` + SHA-256(空串)。
- manifest 逐文件输出 `{path, sha256, bytes, status}`；`status ∈ added|modified|deleted|unchanged`。
  `deleted` 条目使用“最后已知内容”的摘要。

## 4. 上限（默认值 = 冻结文档 §1.4）

| 项 | 默认值 | 触发错误码 |
|---|---|---|
| 工作树最大文件数 | 4000 | `AGENT_FILE_COUNT_EXCEEDED` |
| 单文件最大写入字节 | 1 MiB | `AGENT_FILE_TOO_LARGE` |
| 工作树总字节 | 64 MiB | `AGENT_TREE_TOO_LARGE` |
| 最大目录深度（段数） | 24 | `AGENT_DEPTH_EXCEEDED` |
| 单次读默认 / 最大字节 | 64 KiB / 256 KiB | 超过最大字节按 256 KiB 截断（`truncated:true`） |
| 单次读最大行数 | 4000 | 截断（`truncated:true`） |
| 搜索最大命中 | 50 | 截断（`truncated:true`） |
| 单批写入文件数 / 总字节 | 32 / 2 MiB | `AGENT_BATCH_TOO_LARGE` |
| diff 最大文件数 / 总字节 | 64 / 512 KiB | B3 的 `get-diff` 用；B1 `diffManifests` 可显式截断 |
| 单条路径最大长度 | 240 | `AGENT_PATH_INVALID` |

`createAttempt(workspace, {limits:{...}})` 只允许覆盖上表已知键（未知键/非正整数
`AGENT_ARGUMENT_INVALID`），用于测试与后续参数化，默认值不得被静默放宽。

## 5. 错误码（`AGENT_*`，冻结 §1.7 + B1 补充）

冻结：`AGENT_PROJECT_INVALID`、`AGENT_ROOT_INVALID`、`AGENT_WORKSPACE_NOT_FOUND`、
`AGENT_WORKSPACE_INVALID`、`AGENT_PATH_INVALID`、`AGENT_PATH_ESCAPE`、`AGENT_PATH_LINK`、
`AGENT_PATH_PROTECTED`、`AGENT_FILE_NOT_FOUND`、`AGENT_FILE_TOO_LARGE`、
`AGENT_FILE_COUNT_EXCEEDED`、`AGENT_TREE_TOO_LARGE`、`AGENT_DEPTH_EXCEEDED`、
`AGENT_BASE_DIGEST_MISMATCH`、`AGENT_IO_FAILED`、`AGENT_TXN_ABORTED`。

B1 为“语义必须区分”补充（待 Captain rev2 复核）：`AGENT_ID_INVALID`（runId/turnId/attempt 非法）、
`AGENT_ARGUMENT_INVALID`（参数形状非法）、`AGENT_BATCH_TOO_LARGE`（单批文件数/字节超限）、
`AGENT_PATCH_REJECTED`（unified diff 不是完整文件写）、`AGENT_BINARY_FILE`（二进制不按文本读）。

失败体固定形状：`{ok:false, code, path?, message}`；`message ≤ 240` 字，`path` 是**相对路径**或 `.`，
不回传本机绝对路径、源码全文、base64 或密钥。

## 6. 与旧候选链的复用关系（禁止第二份安全路径实现）

`desktop/frontend-reconstruct/workspace.cjs` 的历史安全逻辑（`resolvePrivateRoot`、`auditPath`、
`ensureDirectory`、`ensureCanonicalDirectory`、`assertCanonicalDir`、`isLinkLike`、
`removeTreeSafely`、`assertSafeRelativePath`、`resolveInside`、`writeJsonAtomic`、`samePath` 等）
已在本轮抽到 `desktop/agent-workspace/paths.cjs`，旧模块改为 `require` 并**再导出同一函数引用**。

`paths.cjs` 的唯一实现在不同调用方之间用错误码 profile 区分：

- `LEGACY_CODES`：旧链 `WORKSPACE_*` 字符串保持完全不变（PATH_* 折叠为
  `WORKSPACE_PATH_REJECTED`），既有候选链行为零回归；
- `AGENT_CODES`：B1 使用，路径非法/解析逃逸/链接/受保护路径分为不同 `AGENT_*` 码。

## 7. 导出签名（B1 报告 / Captain rev2 依据）

```text
workspace.cjs : openWorkspace({userDataDir,projectId}) -> {ok,workspace}
                readProjectFile(workspace) -> {ok,project}
                workspacePaths({userDataDir,projectId}) -> {ok,paths}
                attemptPaths({userDataDir,projectId,runId,turnId,attempt}) -> {ok,paths}
                createAttempt(workspace,{runId,turnId,attempt?,attemptId?,source?,limits?}) -> {ok,attempt}
                openAttempt(workspace,{runId,turnId,attempt|attemptId,limits?}) -> {ok,attempt}
                listAttempts(workspace,{runId,turnId}) -> {ok,attempts:[n]}
                removeAttempt(workspace,{runId,turnId,attempt|attemptId}) -> {ok,removed}
                assertOwnership(attempt,absoluteTarget) -> {ok,path}
                normalizeRelativePath(relative,{limits?}) -> {ok,relative}
                CODES / LIMITS / SCHEMAS / *_PATTERN
files.cjs     : listFiles(attempt,{dir?}) / readFile(attempt,{path,offset?,limitBytes?,maxLines?})
                searchFiles(attempt,{query,mode?,caseSensitive?,maxResults?})
                writeFile(attempt,{path,content,expectedBaseSha256?}) / deleteFile(attempt,{path,expectedBaseSha256?})
                normalizeRelativePath / isBinaryBuffer
transactions.cjs : beginChanges(attempt,changes) / commitChanges(attempt,transactionId)
                discardChanges(attempt,transactionId) / applyChanges(attempt,changes)
                listStagedTransactions(attempt) / cleanupStagedTransactions(attempt)
                changes: [{op:"write"|"delete", path, content?, expectedBaseSha256?, format?}]
manifest.cjs  : digestOfContent(value) / treeDigestOfFiles(files) / buildManifest(treeDir,{limits?})
                diffManifests(before,after,{maxFiles?,maxBytes?}) / sanitizeMetadata(meta)
                readAttemptMeta(attempt) / writeAttemptMeta(attempt,patch)
                readRunMeta(workspace,runId) / writeRunMeta(workspace,runId,patch)
                readTurnMeta(workspace,{runId,turnId})
paths.cjs     : 共享安全路径实现（LEGACY_CODES / AGENT_CODES / resolvePrivateRoot / auditPath /
                ensureDirectory / ensureCanonicalDirectory / assertCanonicalDir / isLinkLike /
                removeTreeSafely / assertSafeRelativePath / resolveInside / writeJsonAtomic / …）
```

## 8. B2 版本模型（`versions.cjs`，纯主进程）

冻结契约：`docs/handoff/Workspace-Agent-B阶段接口冻结.md` §2（B2）。**不接 IPC/preload/renderer/Composer**，
只读写应用私有目录；`versions/<versionId>/source/**` 写定后不可变。

```text
agent-workspace/
  project.json                 当前指针与历史索引（唯一真相）
  migration.json               旧 frontendCandidate 一次性迁移记录（append-only）
  versions/<versionId>/
    version.json
    source/**                  完整可构建源树快照（不可变）
    diff/summary.json          相对父版本的逐文件摘要
    evidence/**
```

- `versionId = v<正整数>`（v1 起）：与冻结 §2.1 示例、§3.2 `agent:versions` 及 B1
  `VERSION_ID_PATTERN`（`/^v[1-9][0-9]{0,5}$/`）一致；任务文本的 `v-<正整数>` 按 `v<n>` 实现。
- 采用 = 固化 attempt 候选树为新版本（parent=当时 current），写 `diff`/`evidence`/`adoption`，
  然后 `redoVersionId=null`、`previousVersionId=旧 current`。
- `undo`/`redo` 只移动指针，不新增版本目录；无父/无 redo → `AGENT_UNDO_UNAVAILABLE` /
  `AGENT_REDO_UNAVAILABLE`；分叉（同父多子）redo → `AGENT_VERSION_CONFLICT`。
- 重开按 `treeDigest` fail-closed：漂移/缺失 → `AGENT_VERSION_CONFLICT` + `state.unavailable=true`，
  绝不回退 Base；只读、幂等。
- 迁移（§2.3）：仅当无 `agent-workspace/project.json` 且旧 `project.json` 的
  `frontendCandidate.status==="adopted"` 时发生一次：v1=`import-base`、v2=`import-adopted`，
  `migration.json` 追加；旧 `frontend-runs/**` 只读。失败整体回滚（不留下半套 `agent-workspace`）。
  B1 已建过 minimal `project.json` 的项目走“升级”路径：补 `versions/` 与指针（v1），不丢 attempts。
- 导出身份纯函数（不写盘）：`resolveVersionSource` / `verifyExportIdentity` 校验
  currentVersionId、treeDigest、overlay(`adoption.integrity`)/Registry(`adoption.registryDigest`) 摘要与
  指针不变量，返回同源 `sourceRoot`；不一致 → `AGENT_EXPORT_IDENTITY_MISMATCH`。
- `adoption.sourceKind` 区分两类来源（rev4 §2.6②，B3/导出按此分支）：
  `agent-edit`（attempt 候选树采用）/ `legacy-migration`（旧 `frontendCandidate` 迁移导入）。
- **归属校验（F1）**：`files.cjs`/`transactions.cjs` 的入口复用 `workspace.assertAttemptHandle`，只接受
  `<root>/projects/<projectId>/agent-workspace/runs/<runId>/turns/<turnId>/attempts/attempt-<n>/candidate` 布局；
  伪造句柄指向 `versions/**`、`project.json`、`migration.json`、仓库或链接一律 `AGENT_PATH_ESCAPE`/
  `AGENT_WORKSPACE_INVALID`，保证不可变版本树只能经 `versions.cjs` 写入。

导出签名：

```text
versions.cjs : readProjectState({userDataDir,projectId}) / listVersions(...) / readVersion({...,versionId?})
               resolveVersionSource({...,versionId?}) -> {versionId,sourceRoot,treeDigest,fileCount,...}
               verifyExportIdentity({...,versionId?,overlayDigest?,registryDigest?})
               reopenProject({...}) -> {available:true,...} | {code:AGENT_VERSION_CONFLICT,state:{unavailable:true,...}}
               initProject({userDataDir,projectId}) -> {state,created,upgraded,migrated}
               adoptAttempt({userDataDir,projectId,runId,turnId,attempt,verification?,evidence?})
               undoVersion({...}) / redoVersion({...})
               CODES（含冻结 §2.2 的 8 个 AGENT_* 码）/ SCHEMAS / VERSION_ID_PATTERN
```

B2 错误码只用冻结集合：§1.7（含 rev3 采纳的 5 个）+ §2.2 的 `AGENT_VERSION_NOT_FOUND` /
`AGENT_VERSION_CONFLICT` / `AGENT_VERSION_IMMUTABLE` / `AGENT_UNDO_UNAVAILABLE` / `AGENT_REDO_UNAVAILABLE` /
`AGENT_ADOPTION_FAILED` / `AGENT_MIGRATION_FAILED` / `AGENT_EXPORT_IDENTITY_MISMATCH`。

## 9. 测试

`test/agent-workspace.{workspace,files,transactions,manifest,repo-safety}.test.cjs`
（glob `test/agent-workspace*.test.cjs`）。覆盖：路径穿越、绝对路径/盘符/UNC、symlink/junction、
冲突写入、显式删除、超长/超量文件、部分失败回滚、重开与遗留暂存清理、相同输入确定性、
正式仓库零写入（仓库指纹对比）、旧候选链共享复用（函数引用一致）。

沙箱内官方门禁 `npm test` / `npm run build` 会 `spawn EPERM`（用例未执行），可执行门禁：

```powershell
node --test --experimental-test-isolation=none "test/agent-workspace*.test.cjs"
node --test --experimental-test-isolation=none test/frontend-reconstruct.workspace.test.cjs test/frontend-reconstruct.desktop.test.cjs test/desktop-contract.test.cjs
node -e "for (const f of ['workspace','files','transactions','manifest']) require('./desktop/agent-workspace/'+f+'.cjs'); console.log('agent-workspace modules ok')"
```
