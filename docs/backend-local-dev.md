# 后端本地开发与复现（B 套餐）

> 目标：在一台干净的 Windows 机器上，按本文可以从零启动 MySQL、迁移、种子、后端服务，并验证 `/health` 与 `/readyz`。
> 生产目标仍是华为云 RDS MySQL + DCS Redis；本文只描述本地开发。

## 0. 一键启动（推荐）

在工作区根目录执行：

```bash
npm start
```

`scripts/start-all.ps1` 按顺序完成：

1. 检测 `3306`，未监听则用 `E:\smartstore-tools\mysql` 的 ZIP 实例启动 MySQL（`--basedir/--datadir` 均为纯 ASCII 路径）；
2. 检测 `3000` 与 `http://127.0.0.1:3000/api/v1/health`，未就绪则后台启动后端，并注入 `CACHE_DRIVER=memory`（`server/.env` 默认 `redis`，6379 不可达会让 Nest 启动中止）；
3. 检测 `5173`，若已有桌面端实例则明确报错退出（Electron 固定加载 `http://127.0.0.1:5173`，重复启动只会连到旧 Vite 的旧代码）；否则清除 `ELECTRON_RUN_AS_NODE` 后启动 Vite + Electron。

常用变体：

| 命令 | 作用 |
| --- | --- |
| `npm start` / `npm run start:all` | MySQL → 后端 → 桌面端 |
| `npm run start:all -- -ServerOnly` | 只起 MySQL + 后端 |
| `npm run start:all -- -SkipMysql` | 跳过 MySQL |
| `npm run start:all -- -RestartBackend` | 杀掉旧 `3000` 监听后重启后端 |
| `npm stop` | 停止后端与 MySQL（Electron 窗口需手动关闭） |

日志落在 `.npm-logs/start-all/`（已被 `.gitignore` 忽略），文件名带启动时间戳；失败时脚本会直接打印对应日志尾部。

> 脚本内提示语保持纯 ASCII：Windows PowerShell 5.1 按 ANSI 解析无 BOM 的 UTF-8 文件，中文会导致语法错误。
> 想验证真实 Redis 链路时，先用进程环境变量 `CACHE_DRIVER=redis` 启动并确认 `6379` 可达；否则保持 `memory` 降级。

## 1. 前置

- Node.js 22+（本机实测 24.14.0）
- MySQL 8.x
- Redis（可选；未安装时自动使用内存缓存降级）

## 2. 本机已落地的 MySQL

本机未安装 MySQL 服务，采用 **ZIP 免安装实例**（无需管理员权限）：

| 项 | 路径 |
| --- | --- |
| MySQL 程序 | `E:\smartstore-tools\mysql` |
| 数据目录 | `E:\smartstore-tools\mysql-data` |
| 端口 | `3306` |
| root | 无密码（仅本地） |

> 为什么不在工作区内：MySQL 的 Windows 版无法解析包含中文的 `basedir`（会把 `E:\智能开店app\...` 截断为 `E:\`），因此运行时放在纯 ASCII 路径。数据目录同样使用 ASCII 路径。

### 启动

```bash
cd /e/smartstore-tools/mysql
nohup ./bin/mysqld --basedir=E:/smartstore-tools/mysql --datadir=E:/smartstore-tools/mysql-data --port=3306 --console > /e/smartstore-tools/mysql.out.log 2>&1 &
```

Windows PowerShell 方式：

```powershell
Start-Process -FilePath "E:\smartstore-tools\mysql\bin\mysqld.exe" `
  -ArgumentList "--basedir=E:\smartstore-tools\mysql","--datadir=E:\smartstore-tools\mysql-data","--port=3306" `
  -RedirectStandardOutput "E:\smartstore-tools\mysql.out.log" `
  -RedirectStandardError "E:\smartstore-tools\mysql.err.log"
```

### 检测

```bash
/e/smartstore-tools/mysql/bin/mysqladmin --host=127.0.0.1 --port=3306 --user=root ping
```

输出 `mysqld is alive` 即成功。

### 停止

```powershell
Get-NetTCPConnection -LocalPort 3306 -State Listen | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force }
```

## 3. 环境变量

```bash
cd server
cp .env.example .env
```

本地默认值：

```env
NODE_ENV=development
PORT=3000
DATABASE_URL="mysql://root@127.0.0.1:3306/smart_store"
TEST_DATABASE_URL="mysql://root@127.0.0.1:3306/smart_store_test"
REDIS_URL=redis://127.0.0.1:6379
CACHE_DRIVER=auto
ALLOW_DEMO_LOGIN=true
ALLOW_DEMO_PAYMENT=true
```

- `CACHE_DRIVER=auto`：优先 Redis，连接失败降级内存。
- `CACHE_DRIVER=redis`：Redis 不可用时启动失败（用于确认缓存链路）。
- `CACHE_DRIVER=memory`：强制内存，不尝试 Redis。
- 生产环境必须 `ALLOW_DEMO_LOGIN=false`、`ALLOW_DEMO_PAYMENT=false`，并配置微信凭据，否则启动失败。
- 真实进程环境变量优先于 `.env` 文件（2026-10-31 起）。容器、CI 或 `CACHE_DRIVER=memory npm run start:prod` 这类注入不会被仓库里的 `.env` 覆盖。

## 4. 安装依赖

```bash
cd server
npm install
```

> 本机 npm 全局缓存位于 C 盘时可能出现 EBADF。使用工作区缓存：
> `NPM_CONFIG_CACHE=E:/智能开店app/.npm-cache NPM_CONFIG_LOGS_DIR=E:/智能开店app/.npm-logs npm install`

## 5. 迁移与种子

```bash
cd server
npm run db:migrate     # prisma migrate dev
npm run db:seed        # tsx prisma/seed.ts
```

首次 `db:migrate` 会自动创建 `smart_store` 数据库（本地 root 权限）。生产使用 `npm run db:deploy`，不要执行种子。

种子内容：

- 门店 `store-demo-001` / 柑橘小馆
- 2 个分类、6 个商品（其中 `prd_seasonal` 默认停售）
- 2 个桌号 `tbl_A01`、`tbl_A02`
- 店主 `demo-owner-001`（OWNER）、店员 `demo-staff-001`（STAFF）
- 顾客 `demo-customer-001`

## 6. 启动后端

推荐从**工作区根目录**启动（脚本自动注入 `CACHE_DRIVER=memory`，避免 6379 未开时 Nest 启动中止）：

```powershell
npm run server:dev
```

脚本入口是 `scripts/start-server-local.ps1`，等价于在 `server/` 下执行：

```bash
CACHE_DRIVER=memory PORT=3000 npm run start:dev
```

生产模式（需要先确认 `3306` 已监听）：

```bash
cd server
npm run build
npm run start:prod
```

手动开发模式：

```bash
cd server
npm run start:dev
```

> 前置：`3306` 必须已监听，否则 Prisma 初始化直接抛 `P1001` 并中止启动；`6379` 不可达时必须带 `CACHE_DRIVER=memory`。

## 7. 验证

```bash
curl http://127.0.0.1:3000/api/v1/health
curl http://127.0.0.1:3000/api/v1/readyz
```

预期：

```json
{"status":"ok","service":"smart-store-server","environment":"development","timestamp":"..."}
{"status":"ok","database":"ok","cache":"memory","timestamp":"..."}
```

`cache` 为 `memory` 表示 Redis 未运行并已降级；安装 Redis 后重新启动应变为 `redis`。

## 8. 服务端测试（真实 MySQL 测试库）

```bash
cd server
npm test
```

- 测试使用 `TEST_DATABASE_URL`（默认 `mysql://root@127.0.0.1:3306/smart_store_test`），不 mock Prisma。
- 测试辅助会自动创建测试库、执行 `prisma migrate deploy`、清库并写入固定演示数据；测试库名必须包含 `test`。
- 测试强制 `CACHE_DRIVER=memory`，不需要 Redis。
- 多个测试文件共用同一测试库，`vitest.config.mts` 已设 `fileParallelism: false`，不要改为并行。
- 仅运行某个用例：`npx vitest run test/b1-orders.test.ts`。

## 9. 生产配置红线验证

```bash
cd server
node -e "require('reflect-metadata');require('dotenv').config();const{validateEnv}=require('./dist/common/config/env.validation');try{validateEnv({...process.env,NODE_ENV:'production',ALLOW_DEMO_LOGIN:'true'});console.log('NOT_REJECTED')}catch(e){console.log('REJECTED:',e.message)}"
```

应输出：

```text
REJECTED: 生产环境禁止开启 ALLOW_DEMO_LOGIN / ALLOW_DEMO_PAYMENT
```

## 10. Redis（WSL 本地实例，2026-11-01 起网络不可达，链路待复验）

> 状态更正：2026-10-31 曾在 mirrored 网络下以 `CACHE_DRIVER=redis` 验收通过；2026-11-01 实测 Windows 侧 `6379` 不再监听（`.wslconfig` 的 mirrored 未生效），**当前本地默认走 `CACHE_DRIVER=memory`**。下列步骤保留，恢复镜像网络后需重新验收。

当前机器无 Windows 管理员权限，Redis 通过 **WSL Ubuntu 24.04 + mirrored 网络** 提供，已在 Windows 侧以 `CACHE_DRIVER=redis` 验收通过。

### 安装（一次）

```bash
wsl -d Ubuntu-24.04 -u root -- bash -lc "export DEBIAN_FRONTEND=noninteractive; apt-get update && apt-get install -y redis-server"
```

### 网络配置

`C:\Users\<user>\.wslconfig`：

```ini
[wsl2]
networkingMode=mirrored
```

mirrored 模式下 Windows 的 `127.0.0.1:6379` 直接映射到 WSL，无需端口转发。

### 启动与保活

```bash
wsl -d Ubuntu-24.04 -u root -- bash -lc "service redis-server start; nohup tail -f /dev/null >/dev/null 2>&1 &"
```

`tail -f /dev/null` 用于防止 WSL VM 空闲挂起导致端口映射失效；如果长期不用可忽略，但再次访问前需先唤醒 WSL。

### 验证

```bash
wsl -d Ubuntu-24.04 -u root -- redis-cli ping          # PONG
cd server && node -e "const R=require('ioredis');const r=new R('redis://127.0.0.1:6379',{lazyConnect:true,retryStrategy:()=>null});r.on('error',e=>console.log(e.message));r.connect().then(()=>r.ping()).then(v=>{console.log(v);return r.quit()})"
```

后端启动后：

```bash
curl http://127.0.0.1:3000/api/v1/readyz
# {"status":"ok","database":"ok","cache":"redis",...}
```

### 停止

```bash
wsl -d Ubuntu-24.04 -u root -- redis-cli shutdown nosave
```

### 与生产的关系

WSL Redis 只用于本地开发验收。生产使用华为云 DCS，设置 `REDIS_URL` 与 `CACHE_DRIVER=redis` 即可；`CACHE_DRIVER=auto` 在 Redis 不可用时自动降级内存，保证演示可继续。

### 已修复的坑

- WSL NAT 的端口转发会间歇失效，已改用 mirrored。
- ioredis 的 client 首次连接失败后不可复用，`CacheService` 改为每次重试新建 client，最多 5 次 × 1 秒。
- Redis 默认只监听 `127.0.0.1`，需把 `/etc/redis/redis.conf` 的 `bind` 改为 `0.0.0.0`（mirrored 下也可保留 `127.0.0.1`，按实际验证为准）。

## 11. 常见问题

| 现象 | 处理 |
| --- | --- |
| `Can't connect to MySQL server (10061)` | 检查 3306 是否监听；查看 `E:\smartstore-tools\mysql.out.log` |
| `Failed to set datadir to 'E:\data\'` | basedir 含中文导致；必须使用 ASCII 路径 |
| 端口 3000 被占用 | `netstat -ano | findstr :3000` 后结束进程 |
| 迁移报数据库不存在 | 用 root 连接执行 `npm run db:migrate`，Prisma 会创建库 |
| `CACHE_DRIVER=redis` 启动失败 | Redis 未运行；改回 `auto` 或 `memory` |