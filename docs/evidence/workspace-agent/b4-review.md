# B4 独立复核（t21 / round 1）— 注册表 / 参数白名单 / BLOCKED 语义 / dispatcher 安全

- 复核对象：B4（t20）`desktop/agent-workspace/checks.cjs`、`scripts/agent-checks/run-check.cjs`、
  `scripts/agent-checks/output-consistency.cjs`、`desktop/agent-tools-ipc.cjs`（注入替换）、
  `test/agent-workspace.checks.test.cjs`、`test/agent-tools-ipc.test.cjs`
- 冻结依据：`docs/handoff/Workspace-Agent-B阶段接口冻结.md` rev8 §3.4/§3.5/§3.7
- 复核者：verifier（只读；除本文件外未写仓库文件；攻击脚本 `.tmp/a21/b4-attack.cjs`；未启动 Electron/微信；未做 git 写操作）
- 时间：2026-11-24 19:17–19:33（+08:00）；Node v24.14.0；DSH 沙箱 `workspace-write`
- 环境限制定性：本沙箱 **spawn EPERM**，真实子进程检查（frontend-capabilities / validate-miniprogram /
  verify-cli / node --test / wechat CLI）**未真实执行** → 相关真实运行一律 `BLOCKED/NOT_RUN`，未写 PASS。
- **Verdict：`needs_revision`（1 条 finding；修复后需 review r2，**B4 暂不闭环**）**

## 1. 门禁（真实退出码，单进程等价；官方 npm 门禁仍 BLOCKED）

| # | 命令 | 退出码 | 结果 |
| ---: | --- | ---: | --- |
| 1 | `… test/agent-workspace.checks.test.cjs test/agent-tools-ipc.test.cjs` | **0** | **27/27**（8 + 19） |
| 2 | `… "test/agent-workspace*.test.cjs" test/desktop-contract.test.cjs test/frontend-contract.test.cjs test/frontend-reconstruct.workspace.test.cjs test/frontend-reconstruct.desktop.test.cjs` | **0** | **127/127** |
| 3 | `… "test/frontend-reconstruct*.test.cjs" test/app-frontend-reconstruct.test.cjs`（13 文件） | **0** | **186/186** |
| 4 | `require('desktop/agent-workspace/checks.cjs')` + `require('desktop/agent-tools-ipc.cjs')` | **0** | ok |
| 5 | root 全量等价（129 文件 / 7 块 / 单进程 / `--test-force-exit --test-timeout=120000`） | **1** | `tests 1363 / pass 1354 / fail 7 / skip 2`；失败集 = **A0 的 7 项**（6 沙箱 spawn EPERM + 1 MIRROR），**无 NEW** |
| 6 | 官方 `npm test` / `npm run build` | — | **BLOCKED**（spawn EPERM，未伪装） |

## 2. 注册表与参数白名单（自写攻击，`%TEMP%` 临时 userData + fake runner）

脚本 `.tmp/a21/b4-attack.cjs`：**28 项 = 27 PASS / 1 FAIL**（FAIL = F1；其余全部真实执行）。

| 类别 | 用例与结果 |
| --- | --- |
| 注册表 | `CHECK_IDS` **恰好 10 个**（source.check/mini.check/composer.dry-run/output.consistency/unit.targeted/unit.full/desktop.contract/catalog.check/registry.check/wechat.verify），无隐式命令导出。PASS |
| 未知 id | `evil.check` → `AGENT_CHECK_UNKNOWN`。PASS |
| 禁止键 | command/cmd/shell/exec/spawn/env/cwd/dir/directory/path/script/argv 全部 `AGENT_PAYLOAD_INVALID`。PASS |
| timeoutMs | 999 / 600001 / 1.5 / "1000" / null 全部拒绝；1000 合法（fake runner 走通）。PASS |
| targetFiles | 空数组 / 6 项 / `test/../evil.cjs` 全部拒绝；白名单 1 项通过且 argv 带 `--target`。PASS |
| appId | `wx123`/大写 `WX…` 拒绝；`wx0123456789abcdef` 合法。PASS |
| 非对象/控制字符 | params 字符串、含 `\u0000` 的值 → 拒绝。PASS |
| scoped | 无 workspace → `NOT_RUN`（issue `AGENT_WORKSPACE_NOT_FOUND`，未 spawn）；有 v2 workspace → 走 runner。PASS |
| fail-closed | fake runner EPERM/ENOENT/ETIMEDOUT/不可解析/非法 status → **BLOCKED**；非零退出但 stdout 带 `PASS` → **FAIL（绝不当 PASS）**。PASS |
| dispatcher 固定 argv | 请求 = `node.exe <repo>/scripts/agent-checks/run-check.cjs --check source.check --timeout …`；无调用方命令/未知参数透传。PASS |
| issues | 300 条 → 截断 200；字段统一 `{file,line,column,code,message,source}`；绝对 `C:\…` file → null；`sk-…` → `[redacted]`；无仓库路径/源码全文。PASS |
| wechat（fake runner） | 工具缺失/输出非法 status → BLOCKED；wrapper PASS 时 pages/screenshots 恒为 []（**不伪造截图**）；非法/绝对 evidenceRelative 被丢弃，合法相对引用保留。PASS |

## 3. dispatcher 真实 CLI 尝试（沙箱内，如实标 BLOCKED）

| 调用 | 退出码 | 输出 | 判定 |
| --- | ---: | --- | --- |
| `node scripts/agent-checks/run-check.cjs`（无参） | 0 | `status:"BLOCKED"` `AGENT_CHECK_UNKNOWN`「checkId 未注册」 | BLOCKED（fail-closed） |
| `--check evil.check` | 0 | 同上 | BLOCKED（未知 checkId） |
| `--check source.check --command whoami` | 0 | `BLOCKED` `AGENT_CHECK_UNKNOWN`「未知参数」 | BLOCKED（拒绝未知参数） |
| `--check source.check --timeout 30000` | 0 | `BLOCKED` `CHECK_FAILED`「检查进程异常」 | **BLOCKED（环境 spawn EPERM，未执行）** |
| `--check unit.targeted --target test/desktop-contract.test.cjs` | 0 | `BLOCKED` `CHECK_FAILED`「检查进程异常」 | **BLOCKED（环境 spawn EPERM，未执行）** |

说明：dispatcher 在 `execFile` 同步抛 EPERM 时由 `main().catch` 兜底为 BLOCKED（fail-closed 正确），
但 issue code 是 `CHECK_FAILED` 而非工具缺失码（并入 F1 的语义问题；状态仍是 BLOCKED）。

## 4. 非 Composer 工程（真实执行，无 spawn）

`node scripts/composer/verify-cli.cjs --root <v2 source>` → **EXIT 1**，`产物校验失败：USING_COMPONENT_MISSING ·
usingComponents 指向不存在组件：poster-carousel`。
即 `composer.dry-run` 的底层脚本对非 Composer 工程如实失败（经 dispatcher 会映射 FAIL，不会 PASS）；
本沙箱 dispatcher 的真实调用仍为 BLOCKED（未执行）。

## 5. 注入替换（agent-tools-ipc）

| `checks` 取值 | 行为 | 判定 |
| --- | --- | --- |
| `false` | `agent:run-check` → `AGENT_RUNTIME_TOOL_MISSING`（确定性，不 spawn） | PASS |
| 对象（B3 形状） | 透传 `status:"BLOCKED"` 等，不伪造 PASS | PASS |
| 未传 / `null` | 懒加载真实注册表 → 默认 runner `execFile` 被沙箱 EPERM **同步抛出** → B3 withRun 捕获后返回 **`AGENT_CHECK_FAILED`（“任务执行失败”）**，而不是 `data.status:"BLOCKED"` | **FAIL → F1** |

## 6. 源码核对

- `checks.cjs`：`CHECK_IDS` 10 项 + `CHECK_DEFINITIONS` 固定映射 + `validateParams` 白名单；
  `defaultRunner` 使用 `execFile(... shell:false ... env:fixedEnv())`；scoped 无版本 → `NOT_RUN`；
  `parseReport` 失败/非法 status → `BLOCKED`；checks.cjs + agent-tools-ipc 中 `status:'PASS'` 硬编码 = **0**
  （唯一 PASS 来源是 dispatcher 的 exit-0 映射）。PASS（除 F1）。
- `scripts/agent-checks/run-check.cjs`：固定 `CHECKS` 表 10 项、只接受 `--check/--root/--target/--timeout`、
  `TARGET_ALLOWLIST`、`execFile(shell:false)` + `fixedEnv`、无 `exec(`/`spawn(`、wechat 固定包装
  `scripts/wechat-devtools-run.cjs`。PASS。
- `scripts/agent-checks/output-consistency.cjs`：只读 `inspectOutput`，不缺参数 exit 2、不一致 exit 1，无写盘。PASS。
- `wechat.verify`：checks.cjs/dispatcher 均固定 `scripts/wechat-devtools-run.cjs`；只透传 wrapper 合法 status，
  缺证据/非法输出 → BLOCKED；**无截图生成/伪造代码**。PASS。

## 7. Finding（needs_revision）

### F1（severity: medium）默认 runner 未捕获同步 spawn 异常，EPERM 被分类为 `AGENT_CHECK_FAILED` 而非 BLOCKED

- 文件/行：`desktop/agent-workspace/checks.cjs:226-253`（`defaultRunner` 在 Promise executor 内直接
  `execFile(...)`；沙箱/受限环境里 `execFile` **同步 throw EPERM**，导致 `runCheck` reject）、
  `desktop/agent-tools-ipc.cjs:912-916`（`withRun` 捕获后统一 `fail(CODES.CHECK_FAILED,'任务执行失败')`）。
  同一模式也存在于 `scripts/agent-checks/run-check.cjs:136-165`（`runProcess`，由 `main().catch` 兜底为 BLOCKED，
  但 code 为 `CHECK_FAILED`）。
- 问题：验收要求“工具缺失/超时/EPERM → **BLOCKED**”，且环境限制必须如实标 BLOCKED/NOT_RUN。实测
  `checks` 未传/null（懒加载真实注册表）时，`agent:run-check` 返回 `{ok:false, code:"AGENT_CHECK_FAILED",
  message:"任务执行失败"}`（data:null），不是 `data.status:"BLOCKED"`；UI 会把“环境不可用”显示为“检查失败”。
  dispatcher CLI 同场景虽被 catch 成 BLOCKED，但 issue code 仍是 `CHECK_FAILED`。
- requiredFix：`defaultRunner`（及 `run-check.cjs` 的 `runProcess`）用 try/catch 包裹 `execFile`，把同步异常
  归一成 `{ok:false, code: error.code || 'EPERM'}`；`runCheck` 的 blocked 判定已含 EPERM/EACCES/ENOENT/ETIMEDOUT，
  即可返回 `status:"BLOCKED"`；`agent-tools-ipc` 对 `outcome.ok===false` 的 EPERM 也应映射 BLOCKED（或在 checks
  层先归一）。补测试：runner 同步 throw EPERM → `status==='BLOCKED'`；CLI dispatcher 同场景 code 为工具缺失码。

## 8. 非 finding 观察

1. `checks.cjs` 的 `verifyWechat` 固定返回 `pages:[] / interactions:[] / screenshots:[]`，即使 wrapper 自报
   合法 pages/screenshots 也不透传（只透传 status/evidenceRelative）。符合 acceptance“只透传合法 status、不伪造截图”，
   但 B3 handler 本可转发；E3 需要截图时应由后续 rev 明确（当前不算 finding）。
2. dispatcher 的 `--root` 只校验绝对路径，不校验位于 `<userData>/projects/<id>/agent-workspace` 内；dispatcher 是
   主进程内部固定 argv 调用，不暴露给 renderer，且检查脚本只读，故不构成越权；建议 rev 注明“仅内部调用”。
3. `git status` 中 `templates/miniprogram/catalog/server` 的 staged 改动属并发 C1/C2 任务（非 B4）；
   `desktop/main.cjs` staged diff 为 B3 接线（63 insertions，`checks:null` 未改），mtime 19:10 但 worktree 无 diff，
   B4 未改其内容。

## 9. 测试削弱与越界

- `test/agent-workspace.checks.test.cjs` **8 例**、`test/agent-tools-ipc.test.cjs` **19 例** = 27，全部真断言；
  fake runner 不 spawn；`.skip/.todo/.only` 命中仅断言字符串 `skipped`；既有 127/186 不回归。
- B4 改动面（mtime）：`checks.cjs`(19:07)、`run-check.cjs`(19:07)、`output-consistency.cjs`(19:05)、
  `agent-tools-ipc.cjs`(19:07)、两份测试(19:08/19:09)；`desktop/agent-workspace` 其他模块仍 17:xx；
  `main/preload/project-ipc/composer-ipc/facade` 为 B3 的 18:01–18:03（B4 未改）；HEAD 仍 `437bf5f`（B4 未提交）。
- 越界：B4 未改 server/templates/miniprogram/contracts/package.json 与 B3 wiring；verifier 未做任何 git 写操作。
- **B4 自身越界为零**（其他 staged 文件为并发任务）。

## 10. 结论

- 10 checkId 注册表、参数白名单（命令/env/路径/控制字符/非标量/timeout/targetFiles/appId）、
  fail-closed（不可解析/非法 status/非零退出 → BLOCKED/FAIL，无假 PASS）、dispatcher 固定 argv/shell:false/env 白名单、
  output-consistency 只读、wechat 固定包装且不伪造截图、agent-tools `false`/对象注入、issues 归一与脱敏——**均实测通过**；
  root 失败集未超出 A0；测试未削弱、越界为零。
- 但 **F1（默认 runner 同步 spawn 异常 → AGENT_CHECK_FAILED 而非 BLOCKED）** 使“懒加载真实注册表”在受限环境
  把环境限制误报为检查失败 → **verdict=needs_revision**。
- repair 后需 **review r2**；r2 通过前 B4 不闭环（C3/C4 是否开放由 Captain 决定，B4 门禁未过）。
- 证据：本文件；攻击脚本 `.tmp/a21/b4-attack.cjs`；临时 userData 在 `%TEMP%\dsh-lfO7Oi\a21-b4-*`（不写仓库）。

---

# Review r2（t23，2026-11-24 19:35–19:48）— 复检 F1 修复

- 复核对象：t22 repair-round-2（`desktop/agent-workspace/checks.cjs`、`scripts/agent-checks/run-check.cjs`、
  `desktop/agent-tools-ipc.cjs`、两份测试）
- **Verdict：`pass`（0 findings；B4 满足 rev8 §3.4/§3.5，可闭环）**
- 环境：verifier 的 shell 仍 **spawn EPERM**；官方 npm 门禁仍 BLOCKED。真实子进程检查只能记 BLOCKED，
  Captain 在 full-access shell 的 PASS 证据仅作外部参考，不计入 verifier PASS。

## R2-1 门禁复跑（真实退出码）

| # | 命令 | 退出码 | 结果 |
| ---: | --- | ---: | --- |
| 1 | `… test/agent-workspace.checks.test.cjs test/agent-tools-ipc.test.cjs` | **0** | **29/29**（10 + 19） |
| 2 | `… "test/agent-workspace*.test.cjs" test/desktop-contract.test.cjs test/frontend-contract.test.cjs test/frontend-reconstruct.workspace.test.cjs test/frontend-reconstruct.desktop.test.cjs` | **0** | **129/129** |
| 3 | `… "test/frontend-reconstruct*.test.cjs" test/app-frontend-reconstruct.test.cjs`（13 文件） | **0** | **186/186** |
| 4 | `require(checks.cjs)` + `require(agent-tools-ipc.cjs)` | **0** | ok |
| 5 | root 全量等价（129 文件 / 7 块 / 单进程 / `--test-force-exit --test-timeout=120000`） | **1** | `tests 1365 / pass 1356 / fail 7 / skip 2`；失败集 = **A0 的 7 项**（6 沙箱 spawn EPERM + 1 MIRROR），**无 NEW** |
| 6 | 官方 `npm test` / `npm run build` | — | **BLOCKED**（spawn EPERM，未伪装） |

## R2-2 F1 复验（工具类错误 → BLOCKED）

- 代码：`checks.cjs:231`（defaultRunner 内 try/catch 包裹 execFile）、`runCheck` 对 `await runner` 再兜底 catch；
  `:46` 新增 `CHECK_TOOL_MISSING`；`run-check.cjs:138-182`（可注入 `spawnImpl`、`buildFailureReport`：
  工具类→BLOCKED+CHECK_TOOL_MISSING，真实非零→FAIL+CHECK_FAILED）、`:241` main 使用归一、`:271` 导出 helpers；
  `agent-tools-ipc.cjs:81/614/941/986`（`TOOL_UNAVAILABLE_CODES`、withRun catch→CHECK_TOOL_MISSING、
  run-check/verify-wechat 对工具类 `outcome.ok===false` 返回成功 envelope `data.status:"BLOCKED"` + issue `CHECK_TOOL_MISSING`）。
- 自写攻击（新增 r2 回归，全部真实执行）：
  - runner **同步 throw EPERM** → `{ok:true,status:"BLOCKED",issues[0].code:"CHECK_TOOL_MISSING"}`；
  - runner throw 未知错误 → 仍 `BLOCKED`（兜底不冒泡）；
  - `buildFailureReport(EPERM)` → `BLOCKED`/`CHECK_TOOL_MISSING`；`buildFailureReport({code:1,stdout:'{"status":"PASS"}'})`
    → **`FAIL`/`CHECK_FAILED`**（非零退出+stdout PASS 绝不当 PASS）；
  - `agent-tools-ipc` 工具类 throw → `data.status:"BLOCKED"` + issue `CHECK_TOOL_MISSING`；
    非工具内部错误 → `AGENT_CHECK_FAILED`（保持）；
  - **懒加载**（`checks` 未传 / `null`）→ 两条均 `ok:true,data.status:"BLOCKED"`（修前为 AGENT_CHECK_FAILED）。
- 自写攻击套件重跑：**34 项 = 34 PASS / 0 FAIL**（t21 为 28 项 27 PASS / 1 FAIL）。

## R2-3 真实 CLI（verifier 沙箱仍 EPERM）

| 调用 | 退出码 | 输出 | 判定 |
| --- | ---: | --- | --- |
| `node scripts/agent-checks/run-check.cjs --check source.check --timeout 5000` | 0 | `{"checkId":"source.check","status":"BLOCKED","issues":[{"code":"CHECK_TOOL_MISSING","message":"spawn EPERM",…}]}` | **BLOCKED（工具缺失码已正确）** |
| `--check evil.check` | 0 | `BLOCKED` `AGENT_CHECK_UNKNOWN` | BLOCKED（未知 id） |

说明：Captain 在 full-access shell 复跑 `source.check`/`registry.check`/`catalog.check`/`unit.targeted` = PASS、
`mini.check` = FAIL（MIRROR PRE_EXISTING）、`wechat.verify`（无 root）= BLOCKED `AGENT_CHECK_UNKNOWN`。
verifier 沙箱无法 spawn，**未独立复现这些 PASS**，仅记录为外部证据，不写成 verifier PASS。

## R2-4 其余验收（与 t21 一致，未回归）

- 注册表恰好 10 checkId、未知 id `AGENT_CHECK_UNKNOWN`、无隐式命令面。PASS
- 12 类禁键/控制字符/绝对/盘符/UNC/`..`/非标量 → `AGENT_PAYLOAD_INVALID`；timeout 1000..600000；
  targetFiles 1..5 白名单；appId `wx`+16hex。PASS
- fail-closed：不可解析/非法 status/工具缺失/超时 → BLOCKED；非零真实退出 → FAIL；无伪造 PASS（源码无硬编码 PASS）。PASS
- issues ≤200、字段统一、绝对路径→null、`sk-`→[redacted]。PASS
- dispatcher：固定 argv、`execFile` 默认 spawnImpl、`shell:false`、env 白名单、`--check/--root/--target/--timeout`
  白名单、无 shell `exec(`；wechat 固定 `scripts/wechat-devtools-run.cjs`、不伪造截图。PASS
- `composer.dry-run` 对非 Composer source 真实 FAIL（`USING_COMPONENT_MISSING`，t21 实测，未变）。PASS

## R2-5 测试削弱与越界

- `agent-workspace.checks` 8→**10**（+2 条 r2 回归：同步 throw/归一），`agent-tools-ipc` **19** 不变，总 **29**；
  无 `.skip/.todo/.only`（命中仅为断言字符串 `skipped`）；既有 129/186 不回归。
- t22 改动面 mtime：`checks.cjs`(19:27)、`run-check.cjs`(19:29)、`agent-tools-ipc.cjs`(19:28)、
  两份测试(19:28)；`output-consistency.cjs` 19:05 未再动；`desktop/agent-workspace` 其他模块 17:xx；
  preload/project-ipc/composer-ipc 18:01–18:03；HEAD 仍 `437bf5f`（B4 未提交）。
- 越界：B4 未改 main/preload/project-ipc/composer-ipc/agent-workspace 其他模块、server/templates/miniprogram/contracts/package.json；
  verifier 未做任何 git 写操作；`git status` 中并发 C1/C2 的 staged 文件非 B4。

## R2-6 结论

- F1 已修复并有独立回归：工具/环境类错误统一 `BLOCKED + CHECK_TOOL_MISSING`，真实失败仍 `FAIL + CHECK_FAILED`，
  懒加载 IPC 返回 `data.status:"BLOCKED"`；无假 PASS。其余验收项与 t21 一致、无回归；测试未削弱、越界为零。
- **verdict=pass（0 findings）**；B4 可闭环（C3/C4 是否开由 Captain 决定）。
- 残余环境项：官方 npm 门禁 BLOCKED；真实 spawn 检查在 verifier 沙箱只能 BLOCKED，需在 full-access 机器终验。

