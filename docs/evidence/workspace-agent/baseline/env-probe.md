# A0 环境可用性探测（如实记录，只判存在与可执行，不打印密钥值）

- 时间：2026-11-24 16:33–17:00（+08:00）
- 主机：`Microsoft Windows NT 10.0.26200.0`，Node `v24.14.0`（win32 x64），npm `11.9.0`，PowerShell 5.1
- DSH 沙箱：`workspace-write`；`DSH_SHELL=1`、`DSH_PROFILE=desktop`、会话 `ca4c3914-…`
- 关键继承变量：`ELECTRON_RUN_AS_NODE=1`（Electron 宿主派生，AGENTS.md 记载的坑，未在验证中全局清理，只在单条探测里局部移除）

## 1. 端口与本地服务

`Test-NetConnection 127.0.0.1 -Port <port>`：

| 端口 | 期望服务 | TcpTestSucceeded | 说明 |
| ---: | --- | --- | --- |
| 3306 | MySQL | **False** | server 测试 `b1-*/b3-*` 的阻塞点 |
| 6379 | Redis | **False** | — |
| 3000 | 后端 Nest | **False** | `GET /api/v1/readyz` → `无法连接到远程服务器` |
| 5173 | Vite dev | **False** | `GET http://127.0.0.1:5173/` → `无法连接到远程服务器` |
| 5174 | Vite 备用 | **False** | — |
| 5432 | PostgreSQL | **False** | 本项目未用，仅作背景 |

- `Get-NetTCPConnection -State Listen` 过滤上述端口：无任何监听项。
- `Get-Service` 过滤 `mysql|redis|docker|postgres|mariadb`：**无** 对应服务（唯一命中 `GameInputRedistService`
  是 `Redis` 子串误命中，与 Redis 无关）。
- 进程列表仅见 `node`（A0 自己的测试进程），无 `mysql/redis/electron/微信` 进程。
- 结论：**MySQL / Redis / 后端 / Vite 当前均未启动**，相关检查只能 `NOT_RUN` 或（server 测试）`BLOCKED`。

## 2. 后端与 Vite 启动可行性

| 探测 | 命令 | 结果 | 判定 |
| --- | --- | --- | --- |
| 后端 readyz | `Invoke-WebRequest http://127.0.0.1:3000/api/v1/readyz` | `无法连接到远程服务器` | NOT_RUN（服务未启动） |
| Vite 启动 | `npm run dev` | 配置加载阶段 `Error: spawn EPERM`（esbuild `ensureServiceIsRunning`） | **BLOCKED** |
| Vite 页面 | `Invoke-WebRequest http://127.0.0.1:5173/` | `无法连接到远程服务器` | NOT_RUN |
| Electron+Vite 组合 | `npm run agent:app` | `desktop:dev` → `concurrently` 启动即 `Error: spawn EPERM` | **BLOCKED** |

## 3. 模型代理与密钥（只看变量是否存在）

来源 `server/.env`（793 B，26 个变量；未打印任何值）。判定规则：空值或以 `your/change/xxx/todo/<` 开头视为
`EMPTY_OR_PLACEHOLDER`，其余视为 `SET`（非空）。

| 变量 | 状态 | 备注 |
| --- | --- | --- |
| `NODE_ENV` / `PORT` / `DESKTOP_ORIGIN` | SET | — |
| `DATABASE_URL` / `TEST_DATABASE_URL` / `REDIS_URL` | SET | 指向本机 3306/6379，但服务未启动 |
| `CACHE_DRIVER` / `SESSION_TTL_SECONDS` / `AGENT_REQUIRE_AUTH` | SET | — |
| `ALLOW_DEMO_LOGIN` / `ALLOW_DEMO_PAYMENT` | SET | 仅记录存在，未判定取值是否生产安全 |
| `DEEPSEEK_API_BASE_URL` / `DEEPSEEK_API_KEY` / `DEEPSEEK_MODEL` / `DEEPSEEK_TIMEOUT_MS` | **SET** | 文本/视觉 Agent 的模型通道“已配置”（值未打印、未调用；真实模型探测属 D0） |
| `WECHAT_APP_ID` / `WECHAT_APP_SECRET` | **EMPTY_OR_PLACEHOLDER** | 真实微信登录/支付不可用 |
| `DEMO_OWNER_OPEN_ID` / `DEMO_STAFF_OPEN_ID` / `DEMO_CUSTOMER_OPEN_ID` | SET | demo 账号 |
| `IMAGE_PROVIDER_NAME` | SET | 图生 provider 名称存在 |
| `IMAGE_API_BASE_URL` / `IMAGE_API_KEY` / `IMAGE_MODEL_NAME` / `VISION_MODEL_NAME` | **EMPTY_OR_PLACEHOLDER** | **真实图片生成/视觉模型密钥未配置** → C4 通过前不得接真实生图，符合总计划边界 |

- 根目录只有 `.env.example`（1361 B），无 `.env`；`server/.env.example` 4103 B。
- 未发起任何模型 HTTP 请求（A0 不探测真实模型；D0 负责 `scripts/model-capability-probe.cjs`）。

## 4. 微信开发者工具 CLI

| 项 | 结果 |
| --- | --- |
| `WX_CLI_PATH` | **NOT_SET** |
| 固定候选 | `C:\Users\leiji\AppData\Local\Programs\微信web开发者工具\cli.bat` 不存在；`C:\Users\leiji\AppData\Local\微信web开发者工具\cli.bat` 不存在；`C:\Program Files\Tencent\…` 不存在；`C:\Program Files (x86)\Tencent\…` 不存在；`D:\微信web开发者工具\cli.bat` 不存在 |
| 实际存在 | **`E:\微信web开发者工具\cli.bat`（904 B）存在**（`desktop/devtools-cli.cjs` 候选清单内） |
| 执行尝试 | `cmd /d /s /c "E:\微信web开发者工具\cli.bat islogin"` → CLI 自身返回 0，但输出 `- initialize` + `× initialize error: Error: EPERM: operation not permitted, open 'C:\Users\leiji\AppData\Local\微信开发者工具\User Data\<id>\Default\.cli'`（`resources/app.asar.unpacked/js/common/cli/index.js`）；另有 `DEP0040 punycode` 弃用警告 |
| 判定 | **BLOCKED**：CLI 存在，但沙箱禁止其写 AppData 下的 IDE 状态文件 → 无法确认登录态/编译；不是“工具缺失” |

## 5. Electron

| 探测 | 结果 |
| --- | --- |
| 包版本 | `node_modules/electron/package.json` = **33.4.11**；`node_modules/electron/dist/version` = **33.2.1**（包与二进制版本不一致，记录备查） |
| `electron.exe --version`（继承 `ELECTRON_RUN_AS_NODE=1` 未清理） | 无输出，退出码 **-2147483645**（0x80000003） |
| `electron.exe --no-sandbox --version` | 输出 **v33.2.1**，退出码 **0** → 二进制可执行 |
| GUI/窗口 | **未启动、未看到任何窗口/无障碍树**（`npm run agent:app` 在 vite/concurrently 阶段即 spawn EPERM） |
| 判定 | 二进制可用（加 `--no-sandbox`）；**GUI/UIA = NOT_RUN（BLOCKED 环境）**，不得用单测冒充 |

## 6. 沙箱边界（解释本文件所有 BLOCKED 的根因）

1. **Node 子进程**：`node -e "require('child_process').execFileSync('git',['--version'])"` → `ERR EPERM spawnSync git EPERM`。
   `node:test` runner 为每个测试文件派生子进程 → 117 文件全 EPERM；esbuild service、vitest config 打包（内部 `execFile`）
   同理。这是 DSH Windows 沙箱对“管道 stdio 子进程”的限制，**不是产品缺陷**。
2. **Shell 文件写入**：本会话 shell（pwsh）**无法写入** `docs/**`、`src/**`、`test/**`、`scripts/**`、`server/**`、
   `dist/**`（`Out-File`/`Add-Content`/`[IO.File]::WriteAllText`/`cmd copy` 均为“拒绝访问”），只能写工作区根目录文件与 `.tmp/**`；
   `docs/evidence/**` 只能由文件工具（本报告所用写入通道）写入。`raw/.probe` 即为该边界的探针占位（shell 无法删除它）。
3. **外部工具写状态目录**：微信 CLI 要写 `C:\Users\leiji\AppData\Local\微信开发者工具\…` 被 EPERM 阻断（§4）。
4. **TEMP** 可写（`%TEMP%\dsh-lfO7Oi`），被用于 `git archive` 导出 HEAD 镜像树做只读复算（未写入仓库）。

## 7. 本轮明确未执行（NOT_RUN）

- 真实模型调用（DeepSeek 文本/视觉）：未调用；`DEEPSEEK_*` 仅确认存在。
- 真实图片生成：`IMAGE_*`/`VISION_MODEL_NAME` 为空占位 → 无环境条件。
- 真实微信编译/自动化/截图：CLI 初始化被 EPERM 阻断。
- Electron GUI/UIA 走查、安装包构建、`build:win`。
- `npm start` / `server:dev`（会写数据库/端口，属 A1/A3）。
- `catalog:write`、`mirror:sync`、`registry-check --write`、无 `--check` 的写快照命令：**一律未执行**（禁止洗绿）。
