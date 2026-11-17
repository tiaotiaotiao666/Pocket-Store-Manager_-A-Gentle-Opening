# P7 门禁结果（计划 §9）

> 执行时间：2026-11-17 02:52–03:00（+08:00）；基线 `main@e2eb16ac`（工作区含 P0–P6 未提交改动）。
> 标注：`GATE` = verifier 本会话实际执行；`CAPTAIN_RUN` = captain 在 danger-full-access 下执行（日志
> `.tmp/captain-gates/*.log`，`summary.txt` 记录 11 条退出码）；`BASELINE` = 仓库既有基线失败；
> `BLOCKED` = 环境不可用。**`CAPTAIN_RUN` 不记作 verifier 通过；`BLOCKED` 不记作通过。**

## 1. verifier 可执行门禁（本会话）

| # | 命令 | 退出码 | 输出摘要 | 分类 |
| --- | --- | ---: | --- | --- |
| 1 | `node scripts/registry-check.cjs` | 0 | `注册表校验通过：2026.11.0 · base 1 / ui-block 3 / feature-pack 1 / frontend-pack 1 / recipe 4（direct 2）`；摘要冻结/Manifest/入口/预览/边界/晋升证据通过 | GATE |
| 2 | `node scripts/check-packaging.cjs` | 0 | `打包资源契约检查：368 个必需文件，14 条 files 规则`；注册表/Base/Composer/能力快照/desktop/dist 均被 `files` 覆盖；旧复制模板脚本未入包 | GATE |
| 3 | `node --test --test-isolation=none test/frontend-reconstruct.renderer.test.cjs test/frontend-reconstruct.workspace.test.cjs test/frontend-reconstruct.materialize.test.cjs test/frontend-reconstruct.dryrun.test.cjs test/frontend-reconstruct.repair.test.cjs test/frontend-reconstruct.verify-runtime.test.cjs test/frontend-reconstruct.skills.test.cjs test/frontend-reconstruct.desktop.test.cjs test/app-frontend-reconstruct.test.cjs` | 0 | `tests 158 / pass 158 / fail 0 / duration 30020.5ms` | GATE（等价于 root 定向套件） |
| 4 | `cd server; npx vitest run --configLoader native --pool=threads test/frontend-reconstruct.{contract,service,runtime,capabilities,capabilities-script}.test.ts` | 0 | `Test Files 5 passed (5) / Tests 155 passed (155)`，4.73s；stderr 的 `FRONTEND_MODEL_RESPONSE_INVALID` 是负例用例日志 | GATE |
| 5 | `cd server; npx tsc -p tsconfig.json --noEmit --incremental false` | 0 | 无输出（0 错误） | GATE |
| 6 | `node scripts/frontend-capabilities.cjs --check` | 0 | `能力快照校验通过：2 页、10 组件、25 动作、21 数据路径、2 页级事实、2 页关键动作` | GATE |
| 7 | `node --test --test-isolation=none test/desktop-contract.test.cjs` | 0 | `tests 23 / pass 23 / fail 0`（与 `npm run test:desktop` 同一文件的等价执行，用于本会话交叉印证） | GATE |

说明：本会话固定 workspace-write，Node 的 `child_process` 带管道 stdio 会 `spawn EPERM`（已实测
`spawnSync('git')` 返回 EPERM），因此官方 `npm test`（默认逐文件子进程隔离）、`npm run build`
（vite/esbuild）、`cd server; npm test`（默认 pool 子进程）无法在本会话运行；按任务要求改用
`node --test --test-isolation=none` 与 `--pool=threads` 等价命令，官方命令由 captain 补跑。

## 2. captain 补跑（CAPTAIN_RUN，不作为 verifier 通过）

| # | 命令 | 退出码 | 输出摘要（取自 `.tmp/captain-gates/*.log`） | 分类 |
| --- | --- | ---: | --- | --- |
| 8 | root `npm test` | **1** | `tests 975 / pass 971 / fail 2 / skipped 2`，48.1s；2 个失败**仅为**：(a) `组件目录必须与源码同源：--check 退出码为 0`（catalog 4 项漂移），(b) `miniprogram/ 是受控镜像：…摘要与内容一致`（MIRROR 摘要/CRLF）。无本功能相关失败 | CAPTAIN_RUN + BASELINE |
| 9 | root `npm run build` | 0 | `vite v6.4.5`，1684 modules，`dist/index.html 0.60 kB` / `index-*.css 138.46 kB` / `index-*.js 675.36 kB`，`✓ built in 4.34s`，dist 已刷新 | CAPTAIN_RUN |
| 10 | root `npm run registry:check` | 0 | 同 verifier #1 | CAPTAIN_RUN |
| 11 | root `npm run test:desktop` | 0 | `tests 23 / pass 23 / fail 0`，274.7ms | CAPTAIN_RUN |
| 12 | `cd server; npm test` | **1** | `Test Files 6 failed | 24 passed (30)`；`Tests 460 passed | 85 skipped (545)`；6 个失败文件均为 `b1-*`/`b3-*`，堆栈指向 `prepareDatabase` → MySQL `CREATE DATABASE` 失败（本机无 MySQL），与本功能无关 | CAPTAIN_RUN + BASELINE(环境) |
| 13 | `cd server; npm run build` | 0 | `nest build` 无错误输出 | CAPTAIN_RUN |
| 14 | server `npx tsc --noEmit` | 0 | 0 错误（与 verifier #5 一致） | CAPTAIN_RUN |

## 3. 基线失败 / 环境不可用（不得写成通过）

| # | 命令 | 退出码 | 输出摘要 | 分类 |
| --- | --- | ---: | --- | --- |
| 15 | `node scripts/component-catalog.cjs --check`（`npm run catalog:check` 等价） | **1** | `组件目录校验失败：4 项`；`sections/ordering-base@1.0.0/product-detail/{product-body,product-cart-bar,product-cart-panel,product-hero}.json` 内容漂移 | BASELINE（pre-existing，见 `baseline.md`） |
| 16 | `node scripts/validate-miniprogram.cjs`（`npm run mini:check` 等价） | **1** | `小程序静态校验：8 页/15 组件目录/55 JS/26 WXSS`；`✗ 镜像身份校验失败：镜像内容与清单摘要不一致（镜像已陈旧）` | BASELINE（pre-existing） |
| 17 | `node scripts/sync-miniprogram-mirror.cjs --check`（`npm run mirror:check` 等价） | **1** | `镜像清单校验失败：镜像内容与清单摘要不一致（镜像已陈旧）` | BASELINE（pre-existing） |
| 18 | `npm run agent:smoke` | **2** | `[agent-smoke] FAIL 没有找到标题包含「智能开店」的可见窗口。请先启动 npm run agent:app` | CAPTAIN_RUN + BLOCKED（GUI 未启动；本会话连 agent-desktop 也不可 spawn） |
| 19 | 微信真实编译/截图（`scripts/wechat-devtools-run.cjs` 经 P3 `verify-runtime`） | — | `status=BLOCKED / code=RUNTIME_TOOL_MISSING`：本机 `WX_CLI_PATH` 未设且三个候选 `cli.bat` 均不存在；真实链路证据 `real-probe-evidence.json` 中 `runtime.screenshots=0` | BLOCKED（环境） |
| 20 | 真机 `R`、安装包 `L3/L4` | — | 本阶段范围外，未执行 | NOT_RUN（范围外） |

## 4. 结论

- 可执行的定向门禁（#1–#7）**全部 exit 0**；官方命令由 captain 补跑：`npm run build`、`server npm run build`、
  `server tsc` 为 0；root `npm test` 与 server `npm test` 各因**基线/环境**原因非 0，**不是本功能回归**。
- 计划 §9 中 `catalog:check`、`mini:check`、`mirror:check`、`agent:smoke`、微信真实编译无法全绿；
  其中前三项为仓库既有基线（`baseline.md` 证明输入未改），后两项为环境不可用。
- 因此 P7 不能宣称"全量门禁全绿"；整体验收见 `completion-criteria.md`：**INCOMPLETE**。
