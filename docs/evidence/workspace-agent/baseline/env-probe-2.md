# A3 环境复验（服务启动后）— server DB 测试、readyz 与端口证据

- 任务：`t13` / 总计划 §4 **A3：恢复验证环境**（复验口径；A0 遗留项收口）
- 执行者：verifier（只写 `docs/evidence/workspace-agent/baseline/**`；未改产品代码、未 commit）
- 时间：2026-11-24 17:49–17:53（+08:00）；HEAD `70e0057`；Node v24.14.0；DSH 沙箱 `workspace-write`
- 前置变化（Captain/用户）：MySQL 3306、后端 3000、Vite 5173 已启动；Redis 6379 仍关闭（`CACHE_DRIVER=memory`）。
- 结论一句话：**服务与 DB 已真实就绪（readyz database=ok）**，但 **server 的 6 个 DB 测试文件仍 BLOCKED**——
  原因从 A0 的“MySQL 不可达”变为**测试夹具 `execSync('npx prisma migrate deploy')` 被沙箱拒绝（`spawnSync cmd.exe EPERM`）**；
  `539 passed` 为不依赖 DB 的测试，6 文件共 **86 例被跳过（用例未执行）**。不得写成“server 全量测试通过”。

## 1. 命令 / 退出码 / 关键输出矩阵

| # | 命令 | 退出码 | 关键输出 | 判定 |
| ---: | --- | ---: | --- | --- |
| 1 | `cd server; npx vitest run --configLoader native --pool=threads`（第 1 次） | **-1073741819**（0xC0000005） | 16.3s 后进程异常终止（一次性的原生崩溃；未产出汇总） | **NOT_RUN/异常**（见 §4） |
| 2 | 同上（第 2 次） | **1** | `Test Files 6 failed | 29 passed (35)`；`Tests 539 passed | 86 skipped (625)`；24.38s；6 文件均为 `Error: spawnSync cmd.exe EPERM` @ `test/helpers/b1-fixtures.ts:206 execSync('npx prisma migrate deploy')` | **FAIL（BLOCKED 环境）**：6 文件未执行 |
| 3 | 同上（第 3 次，稳定性复核） | **1** | 与第 2 次一致：`6 failed | 29 passed`，`539 passed | 86 skipped`，24.37s | **FAIL（BLOCKED 环境）**，两连一致 |
| 4 | `cd server; npx tsc -p tsconfig.json --noEmit --incremental false` | **0** | 无输出（0 错误） | **PASS** |
| 5 | `GET http://127.0.0.1:3000/api/v1/health` | 200 | `{"status":"ok","service":"smart-store-server","environment":"development","timestamp":"2026-11-24T09:49:15.187Z"}` | **PASS**（进程存活的真实证据） |
| 6 | `GET http://127.0.0.1:3000/api/v1/readyz` | 200 | `{"status":"ok","database":"ok","cache":"memory","timestamp":"2026-11-24T09:49:15.232Z"}` | **PASS**（database=ok；cache=memory 见 §3） |
| 7 | `GET http://127.0.0.1:5173/` | 200 | body 729 B，含 `id="root"` 与 Vite 标记（`vite`/`@vite/client` 命中） | **PASS（仅页面可访问；不是 Vite/GUI 验收通过）** |
| 8 | `npm run agent:smoke`（一次） | **2** | `[agent-smoke] FAIL 无法启动 agent-desktop：spawnSync C:\Program Files\nodejs\node.exe EPERM` | **BLOCKED**（UIA 仍不可用） |
| 9 | 端口 3306/6379/3000/5173 | — | 3306 **OPEN**、6379 **CLOSED**、3000 **OPEN**、5173 **OPEN** | 见 §2 |
| — | 官方 `npm test` / `npm run build` | — | **未执行**（A0/A4 已实测 spawn EPERM；任务明确不做） | **NOT_RUN** |

## 2. 端口与就绪的准确含义

| 端口 | 状态 | 真实含义 |
| ---: | --- | --- |
| 3306 | **OPEN** | MySQL 可连接；后端 readyz 返回 `database:"ok"` → 服务端到 DB 的连接/查询链真实可用 |
| 6379 | **CLOSED** | **Redis 未就绪**；后端 `cache:"memory"` → 进程内内存缓存。**不得写“Redis 已就绪”**，也不代表缓存层已验证 |
| 3000 | **OPEN** | Nest 后端存活；`/health` 与 `/readyz` 均 200 |
| 5173 | **OPEN** | Vite dev server 可访问（HTML 含 `id="root"` 与 Vite 标记）；**未做 GUI/交互/真实模型验收**（Electron spawn EPERM 未变） |

## 3. server 测试的真实结果与分类

| 面 | A0（服务未起） | A3（服务已起） | 分类 |
| --- | --- | --- | --- |
| MySQL 可达性 | 3306 不可达；`Can't reach database server at 127.0.0.1:3306` | 3306 OPEN；readyz `database:"ok"` | **已解决**（环境） |
| 6 个 DB 文件（`b1-merchant` 27、`b1-orders` 29、`b1-production` 3、`b1-public-auth` 13、`b3-imports` 11、`b3-tables` 3） | 失败于 `ensureDatabaseExists`（MySQL 不可达） | 仍失败于 `prepareDatabase` → `execSync('npx prisma migrate deploy')` → **`spawnSync cmd.exe EPERM`**；86 例全部 **skipped，未执行** | **BLOCKED（仍不是产品 FAIL）** |
| 其余 29 文件 | 29 passed | **29 passed / 539 tests passed** | **PASS（不依赖 DB 的部分）** |
| server tsc | 0 | **0** | **PASS** |
| 测试总数 | 625（539 pass / 86 skip） | 625（539 pass / 86 skip） | 计数不变（6 文件始终未执行） |

根因说明：`server/test/helpers/b1-fixtures.ts:203-213` 的 `prepareDatabase()` **无条件** 调用
`execSync('npx prisma migrate deploy', { stdio:'pipe' })`。DSH 沙箱禁止 Node 以管道 stdio 派生子进程 → `EPERM`。
因此即使 DB 已就绪，这 6 个文件在当前沙箱**无法执行**；须在允许 spawn 的机器上重跑，才能得到 DB 测试的真实 PASS/FAIL。
（`ensureDatabaseExists` 的重试与 `resetDatabase/seedDemoData` 的 Prisma 直连不受影响，但都被第 206 行的 execSync 阻断在之前。）

## 4. 异常记录（如实）

- 第 1 次 vitest 进程以 `exit -1073741819`（0xC0000005 access violation）在 16.3s 后异常终止，未产出汇总；
  随后第 2、3 次均稳定为 `exit 1` + 6 文件 EPERM。该一次性崩溃**原因未定位**（可能为 Windows/沙箱下的原生崩溃），
  不改变结论：DB 测试在当前沙箱仍因 `execSync` 被拒而 BLOCKED。若在可 spawn 机器重跑再遇崩溃，应按 Node/Vitest 环境问题另立案。

## 5. 与 A0 的差异汇总

| 项 | A0（16:33–17:00） | A3（17:49） | 口径更新 |
| --- | --- | --- | --- |
| MySQL 3306 | CLOSED | **OPEN** | BLOCKED → 环境恢复 |
| 后端 3000 / readyz | 未监听 / 连接失败 | **200，database=ok** | BLOCKED → PASS（就绪） |
| Vite 5173 | 未监听 | **200（HTML 可访问）** | BLOCKED → 页面可达；GUI 仍未验收 |
| Redis 6379 | CLOSED | **CLOSED** | 仍 **BLOCKED/未启用**；cache=memory |
| server 全量测试（DB 6 文件） | 6 文件 `MySQL 不可达` 失败 | 6 文件 `spawnSync cmd.exe EPERM` 失败；86 例 skipped | **仍 BLOCKED**（原因变更为沙箱 spawn，不是 DB） |
| server 不依赖 DB 的测试 | 29 passed / 539 | 29 passed / 539 | PASS 保持 |
| server tsc | 0 | 0 | PASS 保持 |
| 微信 CLI | 写 AppData EPERM | 未复测（A0 结论保留） | **仍 BLOCKED** |
| Electron/UIA | spawn EPERM | `agent:smoke` 再次实测 `spawnSync … EPERM` | **仍 BLOCKED** |
| 官方 `npm test`/`build` | spawn EPERM | 未执行（任务不做） | **仍 BLOCKED（不得写成通过）** |

## 6. 对 I 阶段“全量门禁”结论的影响

1. **可以更新**：后端 `/health`、`/readyz`（database=ok）与 5173 页面可访问，说明“服务未启动”不再是全量门禁的阻塞项；
   server **不依赖 DB** 的 29 文件 / 539 测试与 tsc 真实通过。
2. **不能更新为全绿**：
   - server 的 6 个 DB 文件（86 例）仍未执行，原因是测试夹具 `execSync` 被沙箱拒绝 → 在 I 阶段必须在可 spawn 机器上补跑，
     否则“server 全量测试通过”不成立；
   - `agent:smoke`/UIA、微信 CLI、Electron GUI 仍 BLOCKED；
   - 官方 `npm test`/`npm run build` 仍 spawn EPERM（A0/A4 已实测）；
   - Redis 仍 CLOSED，`cache=memory`；不得宣称缓存层验证。
3. 因此 I 阶段的“全量门禁”结论应写为：**在受限沙箱内 = 部分可执行（backend readyz/健康、server 非 DB 测试、tsc）；
   DB 测试、UIA、微信、官方 root 门禁 = BLOCKED；需要一台允许 spawn 的机器做终验。** 不要把本次 A3 当成全量通过。

## 7. 边界与证据

- 只写 `docs/evidence/workspace-agent/baseline/env-probe-2.md` 与 `raw/10-env-probe-2.log`；
- 未改 `src/ server/src/ desktop/ templates/ miniprogram/ contracts/ test/ package.json`；未 commit；未跑任何 `--write`/`mirror:sync`。
- 原始日志：`raw/10-env-probe-2.log`（含端口、HTTP、vitest 汇总、tsc、agent:smoke；vitest 只保留汇总与失败堆栈，截断注明）。
