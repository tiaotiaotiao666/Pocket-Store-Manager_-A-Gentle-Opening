# 智能开店 · 独立小程序生成器（smart-store-generator）

用自然语言开一家餐饮小店：桌面客户端里和 AI 聊几句，填出门店资料、挑一套页面骨架，最后导出一个**可以直接交给微信开发者工具**的小程序工程。全程本地落盘，不上传、不发布、不产生真实交易。

- 桌面端：Electron 33 + React 18 + Vite 6
- 服务端：NestJS 11 + Prisma + MySQL（`server/`）
- 小程序真源：`templates/base/ordering-base/1.0.0/src`（`miniprogram/` 只是只读镜像，不是交付物）

文档入口：[`docs/项目概览.md`](docs/项目概览.md)、索引 [`docs/README.md`](docs/README.md)、交接 [`docs/handoff/README.md`](docs/handoff/README.md)、P5 交付（演示脚本 / 答辩 / 证据索引）见 [`docs/交付/`](docs/交付/)。

---

## 1. 安装

前置：Node.js ≥ 20、npm ≥ 10、一个可用的 MySQL（8.x 或 5.7）。

```powershell
npm install                 # 根目录：桌面端 + 生成器
cd server
npm install
copy .env.example .env      # 至少填 DATABASE_URL；要真实 AI 再填 DEEPSEEK_*
cd ..
```

`server/.env` 里与演示相关的键（照 `.env.example` 抄，值自己填，**不要提交**）：

| 键 | 作用 | 演示时需要 |
| --- | --- | --- |
| `DATABASE_URL` | MySQL 连接串 | 是 |
| `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` / `DEEPSEEK_MODEL` | 真实门店资料填写 | 是（不填会回落到本地规则） |
| `DESKTOP_ORIGIN` | 允许的桌面端来源，默认 `http://127.0.0.1:5173` | 是 |
| `CACHE_DRIVER` | `memory` 时不需要 Redis | 否 |
| `ALLOW_DEMO_LOGIN` / `ALLOW_DEMO_PAYMENT` | 演示登录与演示支付（模拟，不真实收款） | 否 |

## 2. 启动（可复现的一键方式）

```powershell
npm start                                   # MySQL → 后端 → 桌面端
npm run start:all -- -Seed                  # 同上，先 migrate deploy + 演示数据 seed
npm run start:all -- -ServerOnly            # 只起 MySQL + 后端
npm run start:all -- -SkipMysql             # 3306 已有 MySQL 时跳过启动
npm run start:all -- -RestartBackend        # 3000 有进程但 readiness 不通过时重启
npm stop                                    # 停后端 + 停 3306 上的 MySQL
```

- `-Seed` 执行 `server` 里幂等的 `prisma db seed`，写入演示门店 `store-demo-001`（柑橘小馆）、2 个分类、6 个菜品、2 张桌台、2 套海报模板；重复执行不会重复插入，**不依赖手工改库**。
- 脚本默认 MySQL 便携版在 `E:\smartstore-tools\mysql`。若 3306 已被别的 MySQL 占用（例如 phpStudy），脚本直接复用、不覆盖现有实例；此时 `npm stop` 会停掉占用 3306 的那个 MySQL。
- 桌面端仍可用 `npm run desktop:dev`（普通终端）或 `npm run agent:app`（agent shell，自动清 `ELECTRON_RUN_AS_NODE`）单独启动。

### 启动后自检（真检查，不靠日志猜）

```powershell
curl.exe http://127.0.0.1:3000/api/v1/readyz
# {"status":"ok","database":"ok","cache":"memory",...}
curl.exe http://127.0.0.1:5173          # 200
```

`database":"ok"` 才算后端可用；`cache":"memory"` 表示未接 Redis，属预期降级。

## 3. 演示路径（普通开店主线）

1. 打开客户端 → **新建项目** → 命名小程序。
2. 勾选功能（扫码点餐 / 商品与菜单 / 购物车结算 / 订单进度为必选）→ 加入定制能力。
3. 3 套候选骨架（街巷食集 / 一杯日常 / 主厨推荐），点选实时换图；底部「首页 / 菜单 / 订单」可真实切换。
4. 店铺装修：一句话描述，例如
   `店名是柑橘小馆，社区家常菜，10:00-21:00，堂食和自取，招牌牛肉饭 28 元、柠香鸡腿饭 26 元、时令小食拼盘 16 元。`
   AI 回填店名 / 品类 / 营业时间 / 取餐方式 / 菜品到 5/5；可再让它改价、加菜。
5. 附加材料：上传别人的首页截图 → 识别 → 候选确认或放弃（识别不可用时界面明确报错，不生成假候选、不改动项目）。
6. 生图提示词 → 海报素材（可选；本版本未接入真实生图，界面如实说明，可上传自有 PNG 或跳过）。
7. 导出：确认体检提示 → 选择导出位置 → 生成本地工程目录。

## 4. 导出

- 界面导出由主进程 `dialog.showOpenDialog` 选父目录，随后走 Composer 生成工程。
- 等价命令行导出（同一 Composer 实现，便于复现与 CI）：

```powershell
node scripts/composer/cli.cjs --plan .arts/w5/plan.json --out D:\out --mode development --project-name p5-ship --json
```

产物含 `project.config.json`、`output-lock.json`、`REPORT.md`、`output-report.json` 与完整小程序工程。

- 写入真实 AppID（`wx` + 16 位十六进制）：

```powershell
node -e "console.log(require('./desktop/appid-postprocess.cjs').applyAppid({outputPath:'D:/out/p5-ship',appid:'wx3b1c04f63cf6cfd0'}))"
```

回填后返回 `verified: true`，并生成 `appid-postprocess.json` 与备份目录。

## 5. 微信开发者工具验证

```powershell
& 'D:\Downloads\微信web开发者工具\cli.bat' open --project D:\out\p5-ship
```

打开后可看首页 / 菜单 / 订单 / 我的四页，桌号与门店配置一致。未在真机预览、未发布体验版：这两步需要你的 AppID 与微信账号，本项目不代做，也不宣称已做。

## 6. 测试与校验

```powershell
npm test                     # 前端 + 生成器 789 项 node:test
npm run build                # vite 构建
npm run registry:check       # 注册表摘要/边界
npm run catalog:check        # 组件目录（0 error / 1 warning）
npm run mini:check           # 小程序镜像静态校验
npm run mirror:check         # 镜像与真源一致（149 文件摘要）
npm run mini:dup-check       # 镜像一致性
cd server; npm run build; npx vitest run
```

`server` 中 6 个 `test/b1-*.test.ts` 需要数据库账号具备 `CREATE DATABASE` 权限（测试会建临时库）：当前演示机账号没有该权限，这 6 个套件在准备阶段失败，其余 19 个套件 / 296 项通过。要全绿，把 `DATABASE_URL` 换成可建库的账号即可。

## 7. 目录速查

```
desktop/     Electron 主进程、IPC、AppID 回填、导出
src/         React 界面与会话状态机
scripts/     启动、CDP 走查、Composer CLI、各类校验
templates/   页面骨架真源（miniprogram/ 是只读镜像）
server/      NestJS + Prisma + Agent
docs/        概览、交接、交付文档（含 P5 证据索引）
```

## 8. 已知边界

- 未接入真实生图服务；海报素材一步只支持上传自有图片或跳过。
- 参考截图识别依赖上游视觉模型，模型 502 时界面提示「图片识别服务当前不可用」，不生成候选模板。
- 华为云相关能力**未开通、未验证，非本次演示依赖**。
- 支付为演示模拟（`DEMO_PAID`），没有真实支付通道。
- 窗口最小 1120×740；当前分辨率下长面板需要滚动。
