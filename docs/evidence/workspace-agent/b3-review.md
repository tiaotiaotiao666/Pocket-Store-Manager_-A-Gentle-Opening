# B3 独立复核（t17 / round 1）— 命令面 / envelope / 安全边界 / preload / 版本接线

- 复核对象：B3（t16）`desktop/agent-tools-ipc.cjs`、`desktop/{main,preload,project-ipc,composer-ipc}.cjs`、
  `src/services/workspaceAgent/index.js`、`test/{agent-tools-ipc,workspace-agent-service}.test.cjs` + `desktop-contract +1`
- 冻结依据：`docs/handoff/Workspace-Agent-B阶段接口冻结.md` rev6 §3.1–§3.3、§3.5、§3.6（含 5 缺口裁定）
- 复核者：verifier（只读；除本文件外未写仓库文件；攻击脚本 `.tmp/a17/b3-attack2.cjs`；未启动 Electron、未做 git fetch/rebase）
- 时间：2026-11-24 18:28–18:44（+08:00）；Node v24.14.0；DSH 沙箱 `workspace-write`
- **Verdict：`needs_revision`（2 条 findings；修复后需 review r2，**B4 暂不开放**）**

## 1. 门禁（真实退出码，单进程等价；官方 npm 门禁仍 BLOCKED）

| # | 命令 | 退出码 | 结果 |
| ---: | --- | ---: | --- |
| 1 | `node --test --experimental-test-isolation=none --test-force-exit test/agent-tools-ipc.test.cjs test/workspace-agent-service.test.cjs` | **0** | **24/24**（17 + 7） |
| 2 | `… test/desktop-contract.test.cjs test/frontend-contract.test.cjs test/frontend-reconstruct.workspace.test.cjs test/frontend-reconstruct.desktop.test.cjs "test/agent-workspace*.test.cjs"` | **0** | **119/119** |
| 3 | `… "test/frontend-reconstruct*.test.cjs" test/app-frontend-reconstruct.test.cjs`（13 文件） | **0** | **186/186** |
| 4 | `node -e "require('./desktop/agent-tools-ipc.cjs')"` | **0** | `agent-tools-ipc ok` |
| 5 | root 全量等价（A0 口径：127 文件 / 7 块 / 单进程 / `--test-force-exit --test-timeout=120000`） | **1** | `tests 1343 / pass 1334 / fail 7 / skip 2`；失败集 = **A0 的 7 项**（6 沙箱 spawn EPERM + 1 MIRROR PRE_EXISTING），**无 NEW fail** |
| 6 | 官方 `npm test` / `npm run build` | — | **BLOCKED**（spawn EPERM，A0/A3/A4 已实测；本轮未伪装） |

## 2. 自写攻击用例（`%TEMP%` 假 ipcMain，不复用实现者测试）

脚本 `.tmp/a17/b3-attack2.cjs`。临时 userData 内建 B2 工作区（v1 base → v2/v3 adopt，attempt 真实存在），
并用假 `ipcMain.handle` 注册真实 handler。**64 项 = 63 PASS / 1 FAIL**（FAIL 见 F2；F1 为行为观察，已单独列）。

| 类别 | 用例与结果 |
| --- | --- |
| 命令面 | `commandNames` **恰好 19** + `agent:progress`；progress 不能当命令 invoke（PAYLOAD_INVALID）；未知命令拒绝。PASS |
| envelope | 成功键 = `{ok,data,issues,meta}`、失败键 = `{ok,code,message,data:null,issues,meta}`；message ≤240；结果无 userDataDir/仓库绝对路径/base64。PASS |
| 未知键 | 对 19 个命令各加 `bogusKey` → 全部 `AGENT_PAYLOAD_INVALID`。PASS |
| 参数 | 非对象/缺 projectId/非法 runId/非法 versionId/`../` 路径全部拒绝（AGENT_PAYLOAD_INVALID / AGENT_ID_INVALID / AGENT_VERSION_NOT_FOUND / AGENT_PATH_INVALID）。PASS |
| 体积上限 | 33 文件批 → `AGENT_BATCH_TOO_LARGE`；2MiB+ 单文件 → `AGENT_FILE_TOO_LARGE`；read `limitBytes=300000` → 实际 ≤256 KiB 且给 nextOffset；search `maxResults=500` → 实际 50 + truncated；get-diff 返回 64 文件上限。PASS |
| sender | 不可信 event → `AGENT_UNTRUSTED_SENDER`；可信 → 正常 envelope。PASS |
| 并发 | 同项目两个 write-files 并发 → 恰好一个 `AGENT_BUSY`；注入读限流器 → `AGENT_BUSY`。PASS |
| cancel | 活动 run → `{state:"cancelled",stage:"running"}`；其他 run / 已结束 run → `too-late`（不是失败）；**未见 `requested` 分支** → F1 |
| checks 注入 | `checks=null` 时已知 checkId → `AGENT_RUNTIME_TOOL_MISSING`、未知 → `AGENT_CHECK_UNKNOWN`、verify-wechat → `AGENT_RUNTIME_TOOL_MISSING`；`params` 含 command/env/shell/cwd 全部拒绝；注入 checks 后才出现 PASS；模块源码无硬编码 PASS。PASS |
| 版本接线 | adopt current/previous 成功；任意历史版本（v3 在 v1 活动后）→ `AGENT_VERSION_CONFLICT`；不存在版本 → `AGENT_VERSION_CONFLICT`（与 rev6 ① 一致）；**无 `agent:adopt-attempt`**（rev6 ①）；submit-candidate 只返回 `status:"submitted"`；undo/redo 走 B2。PASS |
| project-ipc | `versionState`：ok / none / 漂移 → `{status:"unavailable",code:"AGENT_VERSION_CONFLICT",reason:"drift"}`，项目仍可读。PASS |
| composer-ipc | 无 workspace → `{ok:true,skipped:true}`；有 workspace → `{ok:true,skipped:false}`；篡改 current source → `{ok:false,code:"AGENT_EXPORT_IDENTITY_MISMATCH"}`；恢复后 ok。PASS |
| artifact | 绝对路径 ref 拒绝（`AGENT_PATH_INVALID`）；缺失 → `AGENT_ARTIFACT_NOT_FOUND`；**二进制无 `contentBytes`** → F2 |
| progress | 白名单字段、message 300 字 → 截断 120；非法 status/未知键拒绝。PASS |
| 泄露扫描 | 全部成功结果无 userDataDir/仓库绝对路径/长 base64。PASS |

## 3. preload / facade

- `git diff desktop/preload.cjs`：**46 insertions / 0 deletions** → 旧 API 键全部保留、仅新增 `workspaceAgent`
  （19 方法 + `onProgress`，`Object.freeze`）；`exposeInMainWorld` 仍只有 1 处；无 `channel/fs/child_process/ipcRenderer` 直出。
- facade `src/services/workspaceAgent/index.js`：`WORKSPACE_AGENT_METHODS` 19 项；只经
  `window.smartStore.workspaceAgent`，源码无 `ipcRenderer`/`agent:` channel 字符串；`normalizeEnvelope` 存在；
  超时/AbortSignal 映射（7 项测试覆盖）。
- main/project-ipc/composer-ipc diff 均为增量（157 insertions / 5 deletions 集中在 project-ipc 的旧 handler 改造），
  无删除旧 API 导出。

## 4. rev6 五缺口裁定确认（均与裁定一致，不算 finding）

1. `adopt-version` 只支持 current/previous/redo，任意历史版本 `AGENT_VERSION_CONFLICT`；`agent:adopt-attempt` **未实现**（rev6 ① 接受现状）。
2. `get-diff` 只接受结构化 `{versionId}` 或 `{runId,turnId,attempt}`；裸 `comparedTo:"attempt-1"` → `AGENT_PAYLOAD_INVALID`（rev6 ② 采纳）。
3. `read-artifact` 文本回 `content`（≤64 KiB 分支存在）；**二进制回 contentBytes 未实现**（见 F2，rev6 ③ 采纳项）。
4. progress `stage` 只透传（无强白名单），未知 stage 不丢弃（rev6 ④ 接受现状）。
5. `run-check` 仅拒绝 command/env/shell/cwd；具体 checkId 参数白名单留 B4（rev6 ⑤ B4 定义）。

## 5. Findings（needs_revision）

### F1（severity: medium）`agent:cancel-run` 三态缺 `requested`，活动 run 直接返回 `cancelled`

- 文件/行：`desktop/agent-tools-ipc.cjs:1155-1170`（`agent:cancel-run`；`:1163` 活动 run 立即 `state:'cancelled'`，
  `:1168` 仅 `too-late`）。全模块 `requested` 出现次数 = **0**。
- 问题：冻结 §3.2 明确 `{state:"requested"|"cancelled"|"too-late"}`；t17 acceptance 也要求三态。
  实测活动 run 调用即得 `cancelled`（任务尚未停止；`withRun` 稍后才返回 `AGENT_CANCELLED`），
  UI 无法区分「已请求取消」与「已取消完成」，也无法按三态显示。只有 `cancelled`/`too-late` 两态可达。
- requiredFix：活动 run 首次 cancel → `state:"requested"`（记录 token.requestedAt）；任务确认停止后（withRun 观察到
  cancelled）→ `cancelled`；未在途/已结束 → `too-late`。补三态测试（含重复 cancel、取消后结果仍是 `AGENT_CANCELLED`）。

### F2（severity: medium）`read-artifact` 二进制未返回 `contentBytes`（rev6 ③ 未落地）

- 文件/行：`desktop/agent-tools-ipc.cjs:976-1018`（`agent:read-artifact`；`:1017` 只对文本回 `content`；
  全模块 `contentBytes` 出现次数 = **0**）。
- 问题：rev6 §3.2/§3.6③ 冻结：文本 ≤64 KiB 回 `content`；二进制回
  `{mime,bytes,sha256,contentBytes:Uint8Array}`（≤2 MiB，**不用 base64**），renderer 用 Blob URL。
  实测在 attempt/verification 放 8B PNG 后调用：返回 `{kind,ref,bytes,sha256,mime}` —— **无 contentBytes**，
  二进制内容无法交付；这意味着证据截图/报告二进制在 B3 不可读。
- requiredFix：二进制分支返回 `contentBytes: Uint8Array`（读取后转 Uint8Array，≤2 MiB；超限 → `AGENT_ARTIFACT_NOT_FOUND`
  或 `AGENT_RESULT_TOO_LARGE`，按冻结语义），保持无 base64；补二进制与文本两条测试。

## 6. 非 finding 观察

1. `agent:submit-candidate` 实现要求 `turnId`（`agent-tools-ipc.cjs` spec keys 含 turnId，缺省 → `AGENT_ID_INVALID`），
   而冻结 §3.2 表格只列 `{projectId,runId,attemptId,targetPage,summary?}`。实现语义合理（定位 attempt 需要 turn），
   建议 rev7 同步表格；B3 实现侧不改。
2. `agent:search-files` 返回 `{matches,truncated}`（非表格字面 `[{...}]`）；行为有界且测试覆盖，建议 rev7 明确形状。
3. `adopt-version` 不存在版本返回 `AGENT_VERSION_CONFLICT`（rev6 ① 写“任意历史版本一律 conflict”），可接受；
   若日后要区分 `AGENT_VERSION_NOT_FOUND`，需 rev。
4. 非法 artifact ref 返回 `AGENT_PATH_INVALID`/`AGENT_ID_INVALID`（§1.7 复用），符合 §3.3「复用工作区码」。

## 7. 测试削弱与越界

- 新增测试 **17 + 7 = 24**（真实断言：命令面/参数/ sender/版本接线/reopen 漂移/读接口/并发/cancel/checks/artifact/progress/
  project-ipc/composer-ipc）；`desktop-contract` **+78 insertions / 0 deletions**（只加断言）；
  `grep .skip/.todo/.only` 命中仅为断言字符串 `skipped`，无跳过测试。
- 既有测试零删除/放宽：`git diff --stat` 除 desktop-contract 外无 test/ 改动（新增两个测试为 `??`）。
- B3 改动面：`M desktop/{main,preload,project-ipc,composer-ipc}.cjs`、`?? desktop/agent-tools-ipc.cjs`、
  `?? src/services/workspaceAgent/`、两个新测试 + desktop-contract 增量；`desktop/agent-workspace/**` mtime 仍为
  B2 r2 的 17:17–17:46（未触碰）；`server/templates/miniprogram/contracts/package.json` 零改动；
  `src/` 的 6 个 `M` 为团队启动前既有 app-assistant 改动（A0 快照），非 B3。
- 仓库状态说明：复核期间 HEAD 由 `70e0057` 前进到 `49926fd`（其他任务已提交 A0/A4、D0、B1+B2、C1），
  B3 自身改动仍为未提交工作区；verifier 未做任何 git fetch/rebase/checkout/reset/commit。
- **越界为零。**

## 8. 结论

- 19 命令 + progress、envelope、未知键/参数/体积/路径上限、sender 信任、每项目写锁、读并发、cancel 两态、
  checks 未注入的确定性错误（无假 PASS）、版本接线（历史版本 conflict / submit 仅 submitted / 无 adopt-attempt）、
  project-ipc versionState、composer-ipc 导出身份守卫、preload 只加不改、facade 唯一出口——**均实测通过**；
  root 失败集合未超出 A0；测试未削弱、越界为零。
- 但 **F1（cancel 缺 requested）** 与 **F2（read-artifact 二进制缺 contentBytes）** 是冻结 rev6/acceptance 明确项 →
  **verdict=needs_revision**。
- repair 后需 **review r2**；r2 通过前 **不开放 B4**。
- 证据：本文件；攻击脚本 `.tmp/a17/b3-attack2.cjs`；临时 userData 在 `%TEMP%\dsh-lfO7Oi\a17-b3-*`（不写仓库）。

---

# Review r2（t19，2026-11-24 18:49–18:58）— 复检 F1/F2 修复

- 复核对象：t18 repair-round-2（仅 `desktop/agent-tools-ipc.cjs` + `test/agent-tools-ipc.test.cjs`）
- **Verdict：`pass`（0 findings；B3 满足 rev6 §3.1–§3.6，可开放 B4）**
- 前提不变：官方 `npm test` / `npm run build` 仍 spawn EPERM → BLOCKED（A0/A3/A4 实测）。

## R2-1 门禁复跑（真实退出码）

| # | 命令 | 退出码 | 结果 |
| ---: | --- | ---: | --- |
| 1 | `… test/agent-tools-ipc.test.cjs test/workspace-agent-service.test.cjs` | **0** | **25/25**（18 + 7） |
| 2 | `… desktop-contract + frontend-contract + 旧链两文件 + "agent-workspace*.test.cjs"` | **0** | **119/119** |
| 3 | `… "frontend-reconstruct*.test.cjs" test/app-frontend-reconstruct.test.cjs`（13 文件） | **0** | **186/186** |
| 4 | `node -e require('./desktop/agent-tools-ipc.cjs')` | **0** | ok |
| 5 | root 全量等价（128 文件 / 7 块 / 单进程 / `--test-force-exit --test-timeout=120000`） | **1** | `tests 1354 / pass 1345 / fail 7 / skip 2`；失败集 = **A0 的 7 项**（6 沙箱 spawn EPERM + 1 MIRROR），**无 NEW**（含并发 C1 新增测试也通过） |
| 6 | 官方 `npm test` / `npm run build` | — | **BLOCKED**（未重跑冒充） |

## R2-2 F1 复检（cancel 三态）

- 代码：`desktop/agent-tools-ipc.cjs:1202-1230` 三态实现（`requested`/`cancelled`/`too-late`），
  `:545-547` token 持有 `state/requestedAt`，`:581-585` withRun settle 后置 cancelled 并返回 `AGENT_CANCELLED`。
- 自写攻击链（真实 pending 任务，注入慢 checks 后中途 cancel）：
  1) 首次 cancel → `{state:"requested",cancelled:false,requestedAt:"2026-11-24T10:51:56.305Z"}`；
  2) 重复 cancel → 仍 `requested`，`requestedAt` **相同**（幂等）；
  3) 其他 run → `too-late`（非失败）；
  4) 放行任务后 invoke 返回 **`AGENT_CANCELLED`**；
  5) 已停止再 cancel → `{state:"cancelled",cancelled:true,requestedAt:...}`；
  6) 未知 run → `too-late`。
  全部 **PASS**（t17 的观察项已消除）。

## R2-3 F2 复检（read-artifact 二进制）

- 代码：`agent-tools-ipc.cjs:1038-1058`；>2 MiB → `AGENT_RESULT_TOO_LARGE`；文本 ≤64 KiB → `content`；
  其余（二进制/大文本）→ `contentBytes:new Uint8Array(buffer)`，无 base64。
- 自写攻击：
  - 12 B PNG → `data.contentBytes instanceof Uint8Array`、长度 12、`sha256` 与独立 crypto 计算一致；
  - `note.txt` → `content:"hello artifact"` 且无 contentBytes；
  - 2 MiB+1 文件 → `AGENT_RESULT_TOO_LARGE`（data:null）；
  - 全结果无 base64/绝对路径。
  全部 **PASS**。

## R2-4 攻击套件与测试

- `.tmp/a17/b3-attack2.cjs` 重跑：**68 项 = 68 PASS / 0 FAIL**（t17 为 63/64 + 1 项 requested 观察）。
- 测试：`agent-tools-ipc` 17→18（+1 条真实 pending 任务三态/二进制用例），facade 7 条不变，合计 **25/25**；
  `desktop-contract` 保持 t17 的 `+78 insertions / 0 deletions`；`grep .skip/.todo/.only` 命中仅为断言字符串
  `skipped`（`assert.strictEqual(skipped.skipped, true)`），无跳过测试；既有测试零删除/放宽。
- 改动面：t18 仅 `desktop/agent-tools-ipc.cjs`(18:41)、`test/agent-tools-ipc.test.cjs`(18:42)；
  `main/preload/project-ipc/composer-ipc`(18:01–18:03)、facade(18:02)、facade 测试(18:05) 均未再变；
  `desktop/agent-workspace/**` 仍为 17:17–17:46（未触碰）；HEAD 仍 `49926fd`（B3 未提交）；verifier 无 git 写操作。
- 越界：`server/templates/miniprogram/contracts/package.json` 零改动；`test/fixtures/frontend-source/`、
  `test/frontend-source.test.cjs` 为并发 C1 任务新增（非 B3）。

## R2-5 说明（非 finding）

- >64 KiB 的文本类 artifact（json/txt/md/log）走 `contentBytes`（字节交付、无 base64）。冻结只规定
  “文本 ≤64 KiB 回 content / 二进制回 contentBytes”，未规定大文本；该选择安全且可复核，建议 rev7 明确。
- 已取消停止的 run 再次 cancel 返回 `cancelled`（而非 too-late），因为它是“取消完成”；普通完成/未知仍 `too-late`，
  与 UI 语义一致，已记录。

## R2-6 结论

- F1/F2 均已修复并有独立复验 + 真断言测试；19 命令/envelope/安全边界/preload/facade/版本接线/checks/project-ipc/
  composer-ipc 全部实测通过；root 失败集不超出 A0；测试未削弱、越界为零。
- **verdict=pass（0 findings）**；B4 可开放。残余环境项：官方 npm 门禁仍 BLOCKED（需可 spawn 机器终验）。

