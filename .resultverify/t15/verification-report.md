# T15 构建、门禁与安全扫描集成验证报告

- 任务：`.codeartsdoer/plans/full-chain-agent/plan.md` §3.3 T15（team-result-verifier）
- 仓库：`E:\智能开店app`
- 执行时间：2026-11-03 18:40–18:47（本机时间）
- 执行方式：逐条执行，不使用 `&&` 串联；每条独立记录退出码；日志保存在 `.resultverify/t15/`
- 修改边界：仅新增/修改 `.resultverify/t15/*` 与系统临时目录 `C:\Users\leiji\AppData\Local\Temp\smartstore-t15-NyXzYj\*`；未修改 `src/`、`server/src/`、`scripts/`、`templates/`、`test/`、`server/test/`、`package.json`、计划文件。
  - `npm run build` / `server npm run build` 会重写 `dist/`、`server/dist/`（均在 `.gitignore:13 dist/` 覆盖范围内），属于门禁 2、7 的预期产物。

## 1. 结论

**VERDICT: INCOMPLETE（不满足 PASS 条件，不是 PASS）**

- 门禁 1–5、7、8、9 全部退出码 0。
- 门禁 6（`server/ npm test`）退出码 1：6 个既有 DB 集成测试文件在数据库初始化阶段失败（`Can't reach database server at 127.0.0.1:3306`），85 个用例被跳过；其余 13 个文件 233 个用例全部通过，**未发生任何断言失败**。
- 门禁 10：本机 3306/6379 均未监听，按任务要求标记 INCOMPLETE，不写通过。
- 门禁 11：`composer:verify` 退出码 1，命中既有 `PATH_ESCAPE` 缺陷（6 条：`generation-report.json:84` ×5 + `生成报告.md:7` ×1），按任务要求标注为「既有缺陷，不计入本轮失败」，该项为 PARTIAL。
- 若按“任一必需门禁非零即 FAIL”的严格口径，本报告应等价读作 FAIL（失败项为门禁 6/10 的环境阻塞 + 门禁 11 的既有缺陷）；本报告选择 INCOMPLETE 是因为根因可复核为环境缺失与既有缺陷，**没有找到本轮代码回归证据**。
- 本轮引入的失败：**无**。

## 2. 门禁表

| # | 命令 | 退出码 | 关键输出 / 失败原因 |
| --- | --- | --- | --- |
| 1 | `npm test` | 0 | `tests 622 / pass 621 / fail 0 / cancelled 0 / skipped 0 / todo 1`，`duration_ms 6172.7807`；日志 `.resultverify/t15/01-npm-test.log` |
| 2 | `npm run build` | 0 | vite 6.4.5；`✓ 1660 modules transformed.`；`dist/assets/index-CgdUnHkZ.css 116.55 kB`、`dist/assets/index-U5YpcsTq.js 513.27 kB`；`✓ built in 2.95s`；仅有一条非致命警告 `Some chunks are larger than 500 kB after minification` |
| 3 | `npm run test:desktop` | 0 | `tests 13 / pass 13 / fail 0`，`duration_ms 128.4989`；日志 `.resultverify/t15/03-test-desktop.log` |
| 4 | `npm run registry:check` | 0 | `注册表校验通过：2026.11.0 · base 1 / ui-block 3 / feature-pack 1 / recipe 3（direct 0）`；`✓ 摘要冻结、Manifest、入口、预览、边界、晋升证据与扩展顺序均通过` |
| 5 | `npm run mini:check` | 0 | `小程序静态校验：7 个页面，14 个组件目录，42 个 JS 文件，24 个 WXSS 文件`；`静态校验通过：0 个错误，0 个警告` |
| 6 | `cd server && npm test`（实际 `workdir=server`） | **1** | `Test Files  6 failed | 13 passed (19)`；`Tests  233 passed | 85 skipped (318)`；6 个文件均为 `PrismaClientInitializationError` → `Can't reach database server at 127.0.0.1:3306`（失败文件见下） |
| 7 | `cd server && npm run build`（实际 `workdir=server`） | 0 | `> nest build` 无额外输出；`server/dist` 产物已刷新（`main.js`、`app.module.js`、`health.controller.js` 等，时间戳 18:42） |
| 8a | `node --check desktop/main.cjs` | 0 | 无输出（语法检查通过） |
| 8b | `node --check desktop/preload.cjs` | 0 | 无输出（语法检查通过） |
| 9 | `node .resultverify/t15/scan-secrets.mjs`（扫描 `dist/` 与 `server/dist/`） | 0 | 共扫描 202 个文件；`deepseekValueHits: []`、`skPrefixHits: []`、`inlineImageHits: []`；`env.deepseekKeyPresent: true`（只报告存在性，未输出密钥值） |
| 10 | TCP 探测 `127.0.0.1:3306` / `6379` + 服务/二进制检查 | 探测命令完成 | `3306=CLOSED:ECONNREFUSED`、`6379=CLOSED:ECONNREFUSED`；`Get-Service` 无 mysql/redis 服务；`where mysql/mysqld/mariadb/docker` 全部不存在 → **INCOMPLETE（环境原因）** |
| 11 | `npm run composer:verify -- --root "C:/Users/leiji/AppData/Local/Temp/smartstore-t15-NyXzYj/out/松月食堂"` | **1** | 前 6 项检查通过（`app-json-pages`、`page-four-piece`、`app-json-disk-match`、`using-components`、`dynamic-component`、`static-check`），随后 `✗ security-scan：PATH_ESCAPE@generation-report.json:84 | ...`（共 6 条 finding），`产物校验失败：PATH_ESCAPE · 安全扫描命中`；属既有缺陷，PARTIAL |

### 门禁 6 失败原文（逐字摘录）

```text
 FAIL  test/b1-merchant.test.ts [ test/b1-merchant.test.ts ]
PrismaClientInitializationError:
Invalid `prisma.$executeRawUnsafe()` invocation:

Can't reach database server at `127.0.0.1:3306`

Please make sure your database server is running at `127.0.0.1:3306`.
 ❯ ei.handleRequestError node_modules/@prisma/client/src/runtime/RequestHandler.ts:242:13
 ❯ ei.handleAndLogRequestError node_modules/@prisma/client/src/runtime/RequestHandler.ts:174:12
 ❯ ei.request node_modules/@prisma/client/src/runtime/RequestHandler.ts:143:12
 ❯ a node_modules/@prisma/client/src/runtime/getPrismaClient.ts:833:24
 ❯ ensureDatabaseExists test/helpers/b1-fixtures.ts:50:5
 ❯ prepareDatabase test/helpers/b1-fixtures.ts:205:3
 ❯ test/b1-merchant.test.ts:29:3
```

其余同因失败文件（每行均带 `N tests | N skipped`，说明用例在文件初始化阶段即被跳过，未执行断言）：

```text
❯ test/b3-imports.test.ts (10 tests | 10 skipped)
❯ test/b3-tables.test.ts (3 tests | 3 skipped)
❯ test/b1-orders.test.ts (29 tests | 29 skipped)
❯ test/b1-production.test.ts (3 tests | 3 skipped)
❯ test/b1-public-auth.test.ts (13 tests | 13 skipped)
❯ test/b1-merchant.test.ts (27 tests | 27 skipped)

Test Files  6 failed | 13 passed (19)
     Tests  233 passed | 85 skipped (318)
   Duration  26.29s (tests 59%, import 39%, transform 2%, setup 1%)
```

通过的 13 个文件（含本轮新增用例）：

```text
✓ test/template-candidates.test.ts (12 tests)
✓ test/template-revise.test.ts (15 tests)
✓ test/agent.controller.e2e.test.ts (13 tests)
✓ test/agent-turn-v2.test.ts (36 tests)
✓ test/body-limit.test.ts (8 tests)
✓ test/model-provider-images.test.ts (35 tests)
✓ test/env-validation.test.ts (10 tests)
✓ test/deepseek-agent.provider.test.ts (17 tests)
✓ test/presentation-patch.test.ts (29 tests)
✓ test/agent-draft.validator.test.ts (29 tests)
✓ test/agent.service.test.ts (12 tests)
✓ test/b3-import-diff.test.ts (12 tests)
✓ test/order-state.test.ts (5 tests)
```

## 3. 安全扫描（门禁 9）

扫描脚本：`.resultverify/t15/scan-secrets.mjs`（只读；只输出文件路径/计数，绝不输出密钥值，退出码：0=无命中，2=有命中）。

真实产物结果（`node .resultverify/t15/scan-secrets.mjs`，退出码 0）：

```json
{
  "scannedRoots": ["dist", "server/dist"],
  "scannedFileCount": 202,
  "env": { "envFileExists": true, "deepseekKeyPresent": true },
  "deepseekValueHits": [],
  "skPrefixHits": [],
  "inlineImageHits": []
}
```

- `DEEPSEEK_API_KEY`：`server/.env` 中存在真实值（仅检查形状：长度 35、`sk-` 前缀、非占位符；**未打印密钥值**）；`dist/` 与 `server/dist/` 中 **0 个文件**命中该值。
- `sk-` 前缀：0 个文件命中。交叉核对 `rg -o "sk-[A-Za-z0-9_-]{0,40}" dist server/dist` 无输出；`rg -c "DEEPSEEK|sk-"` 的命中全部是 `DEEPSEEK_*` 常量名/错误码名。
- `data:image` + base64：0 个文件存在 >1KB 内联块。交叉核对只有两处运行时代码模板：
  - `dist/assets/index-U5YpcsTq.js`：`data:image/svg+xml;base64,${btoa(...)}`（运行时由 SVG 生成，非内联大块）
  - `server/dist/generation/model-provider.service.js`：`data:image/png;base64,${image}`（运行时拼接）
- 扫描器自检（对抗探针）：构造含“假密钥值 / `sk-` 字符串 / 2KB base64”的诱饵文件，运行同一脚本，退出码 2，三类命中全部被识别（`deepseekValueHits`、`skPrefixHits`、`inlineImageHits` 各 1 文件）。诱饵文件已删除。

## 4. 环境探测（门禁 10）

| 探测项 | 结果 |
| --- | --- |
| `netstat -ano | grep LISTENING | grep -E ":3306|:6379"` | 无输出 |
| Node TCP 连接 `127.0.0.1:3306` | `CLOSED:ECONNREFUSED` |
| Node TCP 连接 `127.0.0.1:6379` | `CLOSED:ECONNREFUSED` |
| `Get-Service` 过滤 `mysql|redis` | 无匹配服务（仅 `GameInputRedistService` 命中名字片段） |
| `where mysql mysqld mariadb docker` | 全部不存在 |
| `C:\Program Files` 下 MySQL/MariaDB/XAMPP 目录 | 不存在 |

→ 本机不具备 MySQL/Redis，`GET /api/v1/health` 与 `GET /api/v1/ready` 的运行态验证**未执行**，门禁 10 标记 **INCOMPLETE**，不写通过。

## 5. 门禁 11：Composer 真实导出与 verify

在**系统临时目录**（不在仓库内）用当前生产代码生成 Plan 与导出工程：

```text
node .resultverify/t15/gen-plan.mjs C:/Users/leiji/AppData/Local/Temp/smartstore-t15-NyXzYj
→ recipeId=order-poster
   presentationTokens={ "homeHeroSize":"lg", "productCardSize":"sm" }
   slotOrder=[{ "featureId":"poster-carousel", "pageId":"home", "slotId":"home-hero" }]
   primaryColor=#1F6F5C, posterSize=lg
   warnings=[ "以下能力暂无模板资产，不会写入导出工程：门店环境" ]
退出码 0

node scripts/composer/cli.cjs --plan <TEMP>/plan.json --out <TEMP>/out --json
→ { "ok": true, "outputPath": "C:\\Users\\leiji\\AppData\\Local\\Temp\\smartstore-t15-NyXzYj\\out\\松月食堂",
    "treeSha256": "sha256:f1059993df31fa9e28698c0a19c7733e99029c1dc2c188f9123472d481c4fec8",
    "lockDigest": "sha256:da9a7832ece98a111bed825347db5974ea99fa76dab563ea429003e30b6ab47c",
    "fileCount": 129, "previewOnly": [], "degraded": [], "warnings": [] }
退出码 0
```

`npm run composer:verify -- --root "<TEMP>/out/松月食堂"` 完整输出（退出码 **1**）：

```text
  ✓ app-json-pages：7 个页面
  ✓ page-four-piece
  ✓ app-json-disk-match
  ✓ using-components
  ✓ dynamic-component
  ✓ static-check：7 页 / 15 组件
  ✗ security-scan：PATH_ESCAPE@generation-report.json:84 | PATH_ESCAPE@generation-report.json:84 | PATH_ESCAPE@generation-report.json:84 | PATH_ESCAPE@generation-report.json:84 | PATH_ESCAPE@generation-report.json:84

产物校验失败：PATH_ESCAPE · 安全扫描命中
```

完整 findings（直接调用 `scanOutput`，仅打印 code/file/line）：

```text
ok=false findings=6
1. PATH_ESCAPE @ generation-report.json:84
2. PATH_ESCAPE @ generation-report.json:84
3. PATH_ESCAPE @ generation-report.json:84
4. PATH_ESCAPE @ generation-report.json:84
5. PATH_ESCAPE @ generation-report.json:84
6. PATH_ESCAPE @ 生成报告.md:7
```

命中原因：`generation-report.json:84` 的 `"projectPath": "C:\\Users\\leiji\\..."` 与 `生成报告.md:7` 的输出目录绝对路径，被 `scripts/composer/safety.cjs` 的 `PATH_ESCAPE /[A-Za-z]:\\/` 规则命中。CLI 的 `security-scan` 检查只展示前 5 条 finding（`verify.cjs:201`），所以命令行只看到 5 条。

**既有性证据（本轮未修）**：

1. `scripts/composer/report.cjs`、`scripts/composer/safety.cjs`、`scripts/composer/verify.cjs` 均**未在 `git status` 中出现**（本轮未改动）。
2. `git show HEAD:scripts/composer/report.cjs` 第 52 行已存在 `projectPath: ctx.outputPath`，第 127–128 行把报告写进产物目录；`git show HEAD:scripts/composer/safety.cjs` 第 31 行已存在 `PATH_ESCAPE /[A-Za-z]:\\/`。
3. 仓库内旧导出工程 `generated-projects/松月食堂`（早于本轮）没有 `generation-report.json` / `生成报告.md`，所以 verify 通过（退出码 0）；一旦产物带报告文件即必然命中。
4. `docs/2026-11-03-模板Recipe驱动预览-构建说明.md` §7.5 已将本缺陷记录为既有缺陷，并说明“经典配方工程同样命中，与本轮改动无关”。

→ 门禁 11 判定：**PARTIAL / 既有缺陷，不计入本轮失败**。

对抗探针：`npm run composer:verify -- --root E:/智能开店app/src` 退出码 1，输出 `产物校验失败：OUTPUT_APP_JSON_MISSING · 产物缺少 app.json`，证明 verify 不是无条件放行（日志 `.resultverify/t15/11d-verify-adversarial.log`）。

## 6. 既有缺陷（非本轮）

1. **`composer:verify` 必然 PATH_ESCAPE**：见 §5。既有文档 §7.5 已登记；本轮未修，不影响桌面端导出（桌面端只调用 `compose`，不调用 `verify`）。
2. **服务端 6 个 DB 集成测试依赖本机 MySQL**：`test/b1-merchant.test.ts`、`test/b1-orders.test.ts`、`test/b1-production.test.ts`、`test/b1-public-auth.test.ts`、`test/b3-imports.test.ts`、`test/b3-tables.test.ts`。本机 3306 未监听时在 `ensureDatabaseExists`（`test/helpers/b1-fixtures.ts:50`）即失败，85 个用例被跳过。上述测试文件与 fixture 均未在本轮改动（`git status` 未列出），与本轮代码无关。
3. **根测试存在 1 个 todo**：`npm test` 汇总 `todo 1`、`fail 0`；属既有标记，不构成失败。
4. **构建 chunk 体积警告**：`index-U5YpcsTq.js 513.27 kB > 500 kB`，Vite 仅警告不失败（退出码 0）。
5. **Node 模块类型警告**：`MODULE_TYPELESS_PACKAGE_JSON`（`src/services/agentTurn/templateReviseTransport.js` 未声明 `"type":"module"`），仅性能提示，测试退出码 0。

## 7. 本轮引入的失败

**无。** 所有实际执行的断言（根 621 pass / server 233 pass / desktop 13 pass）均通过；唯一非零门禁（6/11）的根因分别为本机缺少 MySQL 与既有 PATH_ESCAPE 缺陷。

## 8. 未解决 / 未执行项

1. 门禁 6：6 个 DB 集成测试文件未真正执行（缺 MySQL），需要启动 MySQL 后复跑 `server/ npm test` 才能给出完整结论。
2. 门禁 10：`GET /api/v1/health`、`GET /api/v1/ready` 未做运行态请求（缺 MySQL/Redis），标记 INCOMPLETE。
3. 门禁 11：`security-scan` 的 PATH_ESCAPE 未修（既有缺陷），verify 无法全绿。
4. 本任务只证明门禁与构建结果，不证明端到端业务可用；后者由 T16 负责。

## 9. 证据文件

| 文件 | 内容 |
| --- | --- |
| `.resultverify/t15/01-npm-test.log` | 根 `npm test` 完整输出（622 tests） |
| `.resultverify/t15/02-npm-build.log` | Vite 构建完整输出 |
| `.resultverify/t15/03-test-desktop.log` | 桌面契约测试完整输出 |
| `.resultverify/t15/04-registry-check.log` | 注册表校验输出 |
| `.resultverify/t15/05-mini-check.log` | 小程序静态校验输出 |
| `.resultverify/t15/06-server-npm-test.log` | 服务端 vitest 完整输出（含 6 个失败原文） |
| `.resultverify/t15/07-server-build.log` | `nest build` 输出 |
| `.resultverify/t15/08a-node-check-main.log` / `08b-node-check-preload.log` | 空文件（语法检查无输出，退出码 0） |
| `.resultverify/t15/09-security-scan.json` | 安全扫描 JSON 结果 |
| `.resultverify/t15/11a-composer-build.log` | 临时目录导出结果 |
| `.resultverify/t15/11b-composer-verify.log` | 真实导出工程 verify 输出 |
| `.resultverify/t15/11c-composer-verify-baseline.log` | 旧导出工程 verify（通过，用于对照） |
| `.resultverify/t15/11d-verify-adversarial.log` | 非导出目录 verify 对抗探针 |
| `.resultverify/t15/scan-secrets.mjs` / `gen-plan.mjs` | 验证用只读脚本 |