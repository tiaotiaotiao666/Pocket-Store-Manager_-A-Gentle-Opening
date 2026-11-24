# A0 当前事实基线（workspace-agent 重构首轮）

- 任务：`t1` / 总计划 §4 **A0：建立当前事实基线**
- 执行者：verifier（独立验证，未改产品代码）
- 执行窗口：2026-11-24 16:33–17:00（+08:00），Windows 10.0.26200，Node **v24.14.0**（win32 x64），npm **11.9.0**，PowerShell 5.1，DSH 沙箱 `workspace-write`
- 快照 HEAD：`70e0057b35e9d966f61eade76672d4352d7fa537`（`main`，2026-11-21 18:24:46 +0800，`新增：侧栏单图直出骨架并打通微信预览（T1–T9）`）
- 状态词口径（总计划 §0.4）：`PASS` 真实执行且通过 / `FAIL` 已执行且不满足要求 / `BLOCKED` 环境阻止且附实际错误 / `NOT_RUN` 未执行。**等价门禁 ≠ 官方门禁 ≠ GUI/真实模型/微信验收。**

> 并发说明：A0 执行期间工作区是活的。16:33 快照后，workspace-lead 的 B1 改动在 16:39–16:47 出现
> （`desktop/agent-workspace/**` 新增、`desktop/frontend-reconstruct/workspace.cjs` 被改），runtime-engineer 的
> `scripts/model-capability-probe.cjs` 也在 `git status` 中出现。本文件所有命令均标注执行顺序；凡受这些
> **本轮未提交改动**影响的失败，分类为 `NEW` 并注明归属，不写成 verifier 缺陷。

## 1. 环境身份与工作区快照

```text
$ node --version            -> v24.14.0
$ npm --version             -> 11.9.0
$ git rev-parse HEAD        -> 70e0057b35e9d966f61eade76672d4352d7fa537
$ git rev-parse --abbrev-ref HEAD -> main
$ git log -1 --format='%H %ad %s' --date=iso
  -> 70e0057... 2026-11-21 18:24:46 +0800 新增：侧栏单图直出骨架并打通微信预览（T1–T9）
```

`git status --short`（仅记录，未回滚/未提交/未 reset）：

- **16:33 首次快照（21 项）**：15 个 `M`（`docs/app-assistant-contract.md`、`docs/evidence/app-assistant/README.md`、
  `docs/evidence/frontend-reconstruct/sidebar-t6-real-chain.md`、`docs/handoff/README.md`、
  `docs/handoff/当前工作区交接.md`、`scripts/app-assistant-smoke.cjs`、`src/App.jsx`、
  `src/components/agent/AgentSidebarPanel.jsx`、`src/components/agent/AppAssistantChangeCard.jsx`、
  `src/domain/appAssistantProposal.mjs`、`src/state/sessionMachine.mjs`、`src/styles/agent-sidebar.css`、
  `test/app-assistant-proposal.test.cjs`、`test/app-assistant-reducer.test.cjs`、
  `test/app-assistant-sidebar-panel.test.cjs`）+ 6 个 `??`（`.resultverify/t6/evidence-run-A/summary.json`、
  `Untitled.md`、总计划、`docs/handoff/图片驱动前端重构-raw生成方案.md`、`华为云码道…md`、`测试.md`）。
  这些是**团队启动前既有的未提交改动**，不属本轮引入。
- **16:52 二次快照（32 项）**：新增 `M desktop/frontend-reconstruct/workspace.cjs`（mtime 16:39:20，diff 404 行、
  多数为删除）、`?? desktop/agent-workspace/`（7 文件，16:42–16:47）、`?? test/agent-workspace.*.test.cjs`
  （5 个）、`?? scripts/model-capability-probe.cjs`、`?? docs/evidence/workspace-agent/`、
  `?? docs/handoff/Workspace-Agent-B阶段接口冻结.md` → **B1/D0 本轮在写**。
- `git status --porcelain -- templates miniprogram` → 空；`git diff --quiet -- templates miniprogram` → exit 0。
  即模板/镜像是 HEAD 字节（忽略行尾归一化），未受本轮改动。
- `git status --short` 伴随无害告警 `error: fsmonitor_ipc__send_query ... .git/fsmonitor--daemon.ipc`（不影响结果）。

## 2. 官方门禁命令（逐条真实退出码）

| # | 命令 | 退出码 | 关键输出（原文摘录） | 判定 |
| ---: | --- | ---: | --- | --- |
| 1 | `npm test` | **1** | `✖ test\*.test.cjs` ×117；`ℹ tests 117 / pass 0 / fail 117 / duration_ms 60.5862`；每个文件同一 `Error: spawn EPERM`（`errno: -4048, syscall: 'spawn'`，`node:internal/child_process:421`）→ **用例未执行** | **BLOCKED**（非产品失败） |
| 2 | `npm run build` | **1** | `failed to load config from E:\智能开店app\vite.config.js` → `Error: spawn EPERM` @ `esbuild/lib/main.js:1978 ensureServiceIsRunning` → `error during build: Error: spawn EPERM` | **BLOCKED** |
| 3 | `npm run test:desktop` | **1** | `✖ test\desktop-contract.test.cjs`；`ℹ tests 1 / pass 0 / fail 1`；`Error: spawn EPERM`（test runner 派生子进程） | **BLOCKED**；等价门禁 23/23 PASS |
| 4 | `npm run registry:check` | **0** | `注册表校验通过：2026.11.0 · base 1 / ui-block 3 / feature-pack 1 / frontend-pack 1 / recipe 4（direct 2）`；`✓ 摘要冻结、Manifest、入口、预览、边界、晋升证据与扩展顺序均通过` | **PASS** |
| 5 | `npm run catalog:check` | **0** | `组件目录校验通过：15 个组件 / 8 个页面 / 1 个布局 / 61 个区块；gap 1 项（0 error / 1 warning）` | **PASS**（旧基线 4 项漂移在 HEAD 已消失，见 §5） |
| 6 | `npm run mini:check` | **1** | `小程序静态校验：8 个页面，15 个组件目录，55 个 JS 文件，26 个 WXSS 文件`；`✗ 镜像身份校验失败：镜像内容与清单摘要不一致（镜像已陈旧）`；`静态校验失败：1 个错误，0 个警告` | **FAIL（PRE_EXISTING）** |
| 7 | `npm run mirror:check` | **1** | `镜像清单校验失败：镜像内容与清单摘要不一致（镜像已陈旧），请重新运行 node scripts/sync-miniprogram-mirror.cjs` | **FAIL（PRE_EXISTING）** |
| 8 | `npm run composer:verify`（总计划裸命令） | **2** | `参数错误：必须提供 --root <工程目录>` | **PRE_EXISTING（用法缺口）**；实际产物校验 **NOT_RUN** |
| 9 | `npm run check:packaging` | **0** | `打包资源契约检查：372 个必需文件，15 条 files 规则` + 3 条 `✓`（注册表/Base/Composer/能力快照/desktop/dist 覆盖；旧复制模板脚本未进包；微信运行依赖就位） | **PASS** |
| 10 | `npm run frontend:capabilities:check` | **0** | `能力快照校验通过：2 页、10 组件、25 动作、21 数据路径、2 页级事实、2 页关键动作` | **PASS** |
| 11 | `npm run app:capabilities:check` | **0** | `[app-capabilities] 快照一致（digest=c6df6763）` | **PASS** |
| 12 | `cd server; npm test`（`vitest run`） | **1** | `failed to load config from ...\server\vitest.config.mts` → `Startup Error: Build failed with 1 error ... Error: spawn EPERM` @ `vite/.../node.js:2492 optimizeSafeRealPathSync`（内部 `execFile`）→ **测试未启动** | **BLOCKED**（非产品失败） |
| 13 | `cd server; npx tsc -p tsconfig.json --noEmit --incremental false` | **0** | 无输出 | **PASS** |

补充探测（A0 环境核对的一部分）：

| 命令 | 退出码 | 结果 | 判定 |
| --- | ---: | --- | --- |
| `npm run dev`（Vite） | **1** | 同 build：配置加载阶段 `Error: spawn EPERM`（esbuild service） | **BLOCKED** |
| `npm run agent:app` | **1** | 进入 `desktop:dev` → `concurrently` 启动即 `Error: spawn EPERM`（`node:internal/child_process:421`），vite/Electron 均未启动 | **BLOCKED** |

**官方全量门禁结论：** 13 条中 PASS 6 条（registry/catalog/packaging/frontend-caps/app-caps/server-tsc），
FAIL 2 条（mini/mirror，均 PRE_EXISTING），BLOCKED 4 条（npm test、build、test:desktop、server npm test），
用法缺口 1 条（composer:verify）。**不能把 BLOCKED 当 PASS，也不能把等价门禁当官方门禁。**

## 3. 等价门禁（沙箱内唯一可执行替代，≠官方门禁）

单进程测试开关：`--experimental-test-isolation=none`；`--test-force-exit` 防止 open handle 挂死；
`--test-timeout=120000`。全量根测试按 20 文件/块分 7 块执行（一次性整跑在 16:36 启动后 >30 分钟无 CPU 进展、被终止，原因未定位，记为工具/环境限制而非产品结论）：

| 块 | 文件数 | 退出码 | tests / pass / fail / skip | 秒 |
| ---: | ---: | ---: | --- | ---: |
| 1 | 20 | 1 | 244 / 243 / 1 / 0 | 25.6 |
| 2 | 20 | 1 | 189 / 187 / 2 / 0 | 6.9 |
| 3 | 20 | 1 | 198 / 196 / 2 / 0 | 10.2 |
| 4 | 20 | 1 | 197 / 196 / 1 / 0 | 37.1 |
| 5 | 20 | 0 | 241 / 241 / 0 / 0 | 0.4 |
| 6 | 20 | 0 | 207 / 205 / 0 / 2 | 19.8 |
| 7 | 2 | 1 | 18 / 16 / 2 / 0 | 0.3 |
| **合计** | **117** | **1** | **1294 / 1284 / 8 / 2** | — |

（117 是该快照时 `test/*.test.cjs` 数量；16:52 已增至 122，新增的 5 个 `test/agent-workspace.*.test.cjs` 另跑：**36/36 PASS**，23.2s。）

等价门禁的 8 个失败（逐条定性见 §4）：

1. `test/agent-transport-config.test.cjs`：`C3 真正设置 VITE_AGENT_TRANSPORT=http …` → `spawnSync … node.exe EPERM`
2. `test/app-capabilities.test.cjs`：`服务端只读快照与源文件一致（--check exit 0）` → `spawnSync … EPERM`
3. `test/backend-readiness.test.cjs`：`CLI：就绪时退出码 0、未就绪时退出码 1 …` → `spawn EPERM`
4. `test/component-catalog.test.cjs`：`组件目录必须与源码同源：--check 退出码为 0` → `spawnSync … EPERM`
5. `test/composer-media.test.cjs`：`CLI 相对 media.json 读取 Buffer …` → 子进程 status `null`（spawn EPERM 的后果）
6. `test/frontend-contract.test.cjs`：`三处消费面都从同一份生成契约取值 …` → **真实断言失败**（见 §4 #9）
7. `test/w5-wechat-export.test.cjs`：`W5 编译验证脚本：CLI 不存在或工程缺失时如实 BLOCKED` → 子进程 status `null`（spawn EPERM）
8. `test/w5d-table-source.test.cjs`：`miniprogram/ 是受控镜像…摘要与内容一致` → **真实断言失败**（MIRROR 基线）

其它等价门禁：

| 命令 | 退出码 | 结果 | 口径 |
| --- | ---: | --- | --- |
| `node --test --experimental-test-isolation=none --test-force-exit test/desktop-contract.test.cjs` | **0** | `tests 23 / pass 23 / fail 0`，173.6ms | `npm run test:desktop` 等价，**不是**官方命令 |
| `node_modules\@esbuild\win32-x64\esbuild.exe src/main.jsx --bundle --outfile=.tmp\a0-build-check.js --loader:.js=jsx --jsx=automatic --log-level=warning` | **0** | 1.2s；产物 `a0-build-check.js` **2,641,101 B** + `a0-build-check.css` **214,672 B**；2 条 `import.meta`/iife 警告（vite 用 esm，属已知差异） | 只证明 JSX/CSS 可打包；**未跑** rollup 分包/压缩/指纹。产物已删除 |
| `cd server; npx vitest run --configLoader native --pool=threads` | **1** | `Test Files 6 failed | 29 passed (35)`；`Tests 539 passed | 86 skipped (625)`；34.37s；6 个失败文件 `b1-merchant / b1-orders / b1-production / b1-public-auth / b3-imports / b3-tables`，堆栈均为 `ensureDatabaseExists` → `Can't reach database server at 127.0.0.1:3306` | 绕过 config 打包 + 子进程池后的**等价**服务端全量；仍**不是** `npm test` |

## 4. 失败分类表（PRE_EXISTING / NEW / BLOCKED / NOT_RUN）

| # | 失败/未执行项 | 分类 | 判定依据（对照旧 `frontend-reconstruct/baseline.md` 与交接 §4.7） | 是否本轮引入 |
| ---: | --- | --- | --- | --- |
| 1 | 官方 `npm test` 117 文件全部 `spawn EPERM`，0 用例执行 | **BLOCKED** | 沙箱禁止 Node `child_process` 管道 spawn；与交接 §4.8.2「改动前基线同样如此」一致；调用栈不含本轮文件 | 否（环境） |
| 2 | 官方 `npm run build` 配置加载 `spawn EPERM`（esbuild service） | **BLOCKED** | 同上；§4.7 CAPTAIN_RUN 在可 spawn 环境 exit 0（vite 6.4.5），本沙箱不可复现 | 否（环境） |
| 3 | 官方 `test:desktop` 单文件 `spawn EPERM` | **BLOCKED** | 同 1；等价单进程 23/23 PASS，说明用例本身可用 | 否（环境） |
| 4 | `mini:check` 镜像摘要不一致 | **PRE_EXISTING** | `git status` 对 `templates/ miniprogram/` 为空、`git diff --quiet` exit 0；HEAD `70e0057` 未改 `miniprogram/`；旧 `baseline.md` §2 已记录同一失败。**独立复算**：`MIRROR.json` 记 `30a411f3…/149`（syncedAt 2026-11-20T04:06:41Z），当前工作区按同算法得 `75263963…/150`；LF 归一化 `9bbaec21…`、只算 tracked `9bae113e…`、tracked+LF `9cadbab5…`、HEAD `git archive` 树 `996124ed…/149`，**没有任何一致变体复现清单摘要** → 清单摘要与已提交镜像内容自始不可复算（另加 gitignored 的 `project.private.config.json` 149→150）。旧文把原因归为 `core.autocrlf` + DevTools 产物，实测行尾只能解释部分 | 否（仓库基线） |
| 5 | `mirror:check` 同上 | **PRE_EXISTING** | 同 4 | 否 |
| 6 | `composer:verify` 裸命令 exit 2（缺 `--root`） | **PRE_EXISTING（用法缺口）** | `scripts/composer/verify-cli.cjs:19-23` 明确要求 `--root`；总计划列的是裸命令，故裸跑必然 exit 2。实际产物校验本轮 **NOT_RUN**（A0 无导出产物） | 否（脚本设计） |
| 7 | 官方 `cd server; npm test` 在 config 加载期 `spawn EPERM` | **BLOCKED** | 同 1；等价命令可跑（#4 表），失败面收缩为 MySQL | 否（环境） |
| 8 | 等价服务端测试 6 文件失败（`b1-*/b3-*`） | **BLOCKED** | `Can't reach database server at 127.0.0.1:3306`；3306 端口探测 False；旧基线 §3「本机没有可用 MySQL」同因；非产品断言失败 | 否（环境；服务未启动） |
| 9 | `frontend-contract.test.cjs:73` 真实断言失败：`desktop/frontend-reconstruct/workspace.cjs` 不再 `require('./contract.generated.cjs')` | **NEW** | 该文件在 16:33 快照中**未**修改，16:39:20 被 workspace-lead/B1 改写（`git diff` 404 行、新增 `desktop/agent-workspace/`）；HEAD 版本的同一行**确实** `require('./contract.generated.cjs')`（`git show HEAD:…` 验证）。现经 `desktop/agent-workspace/paths.cjs:28` 间接引用同一生成契约，功能同源但契约测试按“直接 require”断言 → 需 B1 更新测试或保留直接 require。**不是 verifier 缺陷、不是 HEAD 基线** | **是**（B1 进行中） |
| 10 | `w5d-table-source.test.cjs` MIRROR 断言失败 | **PRE_EXISTING** | 与 4/5 同源（`verifyMirrorManifest` 返回同一错误） | 否 |
| 11 | 等价门禁中 6 个 `spawnSync/spawn EPERM` 失败（#3 表 1/2/3/4/5/7） | **BLOCKED** | 同一沙箱边界；其中 `catalog`/`app-capabilities` 的官方脚本**直接执行 PASS**（#2 表第 5/11 行），证明失败来自测试内的子进程调用而非产品 | 否（环境） |
| 12 | MySQL 3306 / Redis 6379 / 后端 3000 / Vite 5173 / 5174 / 5432 均不可连接 | **NOT_RUN**（服务未启动） | `Test-NetConnection` 全部 `False`；`GET http://127.0.0.1:3000/api/v1/readyz` → `无法连接到远程服务器`；无 MySQL/Redis 服务（`Get-Service` 仅匹配到 `GameInputRedistService`，系 `Redis` 子串误命中） | 否（环境） |
| 13 | 微信开发者工具 CLI | **BLOCKED** | `E:\微信web开发者工具\cli.bat` 存在（904 B），`WX_CLI_PATH` 未设置；`cli.bat islogin` 初始化即 `× initialize error: Error: EPERM: operation not permitted, open 'C:\Users\leiji\AppData\Local\微信开发者工具\User Data\…\.cli'`（CLI 自身仍返回 0） | 否（环境） |
| 14 | Electron GUI / UIA 走查 | **NOT_RUN** | `electron.exe --version` 无 `--no-sandbox` 时退出码 `-2147483645`（0x80000003）无输出；加 `--no-sandbox` 得 `v33.2.1` exit 0（二进制可用，但 GUI/自动化未启动）；`npm run agent:app` → `spawn EPERM`。无人看到任何窗口/无障碍树 | 否（环境） |
| 15 | 真实模型 / 真实微信编译 / 安装包 | **NOT_RUN** | A0 范围不执行；模型密钥与图生密钥状态见 `env-probe.md` | — |

**本轮 verifier 未引入任何产品失败**：未改 `src/ server/src/ desktop/ templates/ miniprogram/ contracts/ test/ package.json`；
未运行 `catalog:write`、`mirror:sync`、`registry-check --write`、无 `--check` 的写快照命令；未 commit/reset/clean。

## 5. 与旧基线的对照（差异必须解释，不能照抄）

| 项 | 旧基线（`docs/evidence/frontend-reconstruct/baseline.md`，HEAD `e2eb16a`，2026-11-17） | 本次实测（HEAD `70e0057`，2026-11-24） | 解释 |
| --- | --- | --- | --- |
| `catalog:check` | exit 1，4 项 product-detail 内容漂移 | **exit 0 PASS**（0 error / 1 warning） | 旧基线之后 `8adb88c 修复：生成物行尾耦合（契约摘要 / 组件目录随平台漂移）`（2026-11-19）修掉了行尾耦合；`templates/` 当前无未提交改动，属 HEAD 事实。**旧失败不再是当前失败** |
| `mini:check` / `mirror:check` | exit 1，摘要不一致（归因 CRLF + DevTools 产物） | exit 1 | 仍失败；本次独立复算证明清单摘要即使做行尾归一化也**不可复现**，归因为**清单本身与已提交内容不一致**的仓库基线缺陷（非本轮） |
| root `npm test` | 975 tests / 971 pass / 2 fail（catalog + MIRROR） | 官方命令 BLOCKED（0 用例执行，沙箱）；等价门禁 1294 tests / 1284 pass / 8 fail | 计数增长来自 HEAD 后新增测试；等价门禁的 8 fail 中 6 个是沙箱 spawn、1 个 PRE_EXISTING（MIRROR）、1 个本轮 B1 NEW |
| server `npm test` | MySQL 缺失 6 文件失败，`Test Files 6 failed | 24 passed (30)`，`Tests 460 pass | 85 skip (545)` | 官方 BLOCKED；等价 `Test Files 6 failed | 29 passed (35)`，`Tests 539 pass | 86 skip (625)` | 同一失败面（`b1-*/b3-*` + `127.0.0.1:3306`），计数随 HEAD 增长 |
| `check:packaging` | 368 必需文件 / 14 条规则 | 372 / 15 条规则 | HEAD 新增文件；PASS |

## 6. 对后续任务的输入（A0 结论）

1. **官方门禁在本沙箱不可全绿**：`npm test`、`npm run build`、`test:desktop`、server `npm test` 一律 BLOCKED（spawn EPERM），
   只能在可 spawn 的机器上终验；本文所有“PASS”若来自等价门禁均已显式标注。
2. **当前唯二真实 FAIL 是 `mini:check` / `mirror:check`（PRE_EXISTING）**，修法需仓库级决定（A2f / I 阶段），
   禁止用 `mirror:sync` 洗绿；`w5d-table-source` 测试随之失败。
3. `catalog:check` 已 PASS，不要再引用旧基线的“4 项漂移”；但 `component-catalog.test.cjs` 仍因
   **测试内部 spawnSync** 在沙箱内 BLOCKED（不等价于 catalog 失败）。
4. `composer:verify` 必须带 `--root <导出工程>`；A0 未做真实产物校验。
5. 本轮新增风险点：**B1 进行中的 `desktop/frontend-reconstruct/workspace.cjs` 改动触发 `frontend-contract` 契约测试失败**
   （§4 #9），进入 B 阶段门禁前必须由 B1 收口（补直接 require 或更新契约测试并说明同源）。
6. 环境：MySQL/Redis/后端/Vite 全未启动；微信 CLI 存在但被沙箱写 AppData 阻断；Electron 二进制可用但 GUI 未验证；
   图生密钥为占位符（见 `env-probe.md`）→ C4/E 阶段的真实图片生成**不具备环境条件**，不得接真实生图。

## 7. 证据清单

- `docs/evidence/workspace-agent/baseline/baseline.md`（本文）
- `docs/evidence/workspace-agent/baseline/env-probe.md`
- `docs/evidence/workspace-agent/baseline/raw/00-identity-and-git.log`
- `docs/evidence/workspace-agent/baseline/raw/01-official-gates.log`
- `docs/evidence/workspace-agent/baseline/raw/02-npm-test-build-vite-agent-app.log`
- `docs/evidence/workspace-agent/baseline/raw/03-server-vitest-tsc.log`
- `docs/evidence/workspace-agent/baseline/raw/04-equivalent-gates.log`
- `docs/evidence/workspace-agent/baseline/raw/05-mirror-recompute.log`
- `docs/evidence/workspace-agent/baseline/raw/06-env-probe.log`
- `docs/evidence/workspace-agent/baseline/raw/.probe`（沙箱写权限探针占位：证明 shell 无法写入 `docs/**`，文件工具可以；见 `env-probe.md` §7）

日志已去除密钥/完整 prompt/base64；`npm test` 的 117 段相同堆栈按“同一 `spawn EPERM` 堆栈”截断并注明。

---

## 8. A3 复验更新（2026-11-24 17:49，t13；append-only，不改上文结论）

服务已启动后复验，详见 [`env-probe-2.md`](env-probe-2.md) 与 `raw/10-env-probe-2.log`。对本文件 §4 失败分类的**增量口径**：

| A0 项 | A3 结果 | 更新 |
| --- | --- | --- |
| MySQL 3306 / 后端 3000 / Vite 5173 未启动 | 3306/3000/5173 **OPEN**；`/health` 200、`/readyz` 200 `{database:"ok",cache:"memory"}`；5173 HTML 可访问 | BLOCKED → **PASS（就绪）**；仍非 GUI/真实模型验收 |
| server `npm test` 6 文件失败（MySQL 不可达） | 6 文件仍失败，原因变为测试夹具 `execSync('npx prisma migrate deploy')` → **`spawnSync cmd.exe EPERM`**；86 例 skipped 未执行；不依赖 DB 的 29 文件 / 539 tests 通过 | **仍 BLOCKED**（根因从 DB 不可达变为沙箱 spawn；不是产品 FAIL） |
| server 全量测试等价 = 539 pass / 86 skip | 同样 539 / 86（6 文件未执行） | 计数不变；DB 测试真实结果仍未知 |
| Redis 6379 未监听 | 仍 **CLOSED**；后端 `cache:"memory"` | **仍 BLOCKED/未启用**，不得写“Redis 已就绪” |
| UIA / 微信 CLI / Electron / 官方 npm 门禁 | `agent:smoke` 仍 `spawnSync … EPERM`；其余 A0 结论保留（未复测） | **仍 BLOCKED** |

I 阶段口径：A3 只恢复“服务与 DB 就绪”与“server 非 DB 测试/tsc”的可执行性；**DB 6 文件（86 例）、UIA、微信、
官方 root `npm test`/`build` 仍 BLOCKED**，全量门禁不能据此宣称通过，需在允许 spawn 的机器终验。

