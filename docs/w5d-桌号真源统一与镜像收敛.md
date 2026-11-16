# W5d：桌号真源统一与 miniprogram 镜像收敛

- 基线：`670082b`（W5c 完成点）
- 本轮范围：清理最后两处固定桌号（首页、结算页）、收敛 `miniprogram/` 镜像身份、重新冻结受影响资产并回归。
- 本轮不新增功能。

## 1. 结论

| 项目 | 结论 | 关键证据 |
| --- | --- | --- |
| 首页/结算页消费真实后端桌号 | PASS | `.arts/w5d/devtools-run.json` 中「桌号数据源」一条：后端/菜单/首页/结算四组数据完全一致 |
| 业务链路移除 `DEMO_TABLES` | PASS | `test/w5d-table-source.test.cjs` 9/9；`grep DEMO_TABLES` 在模板源码、镜像、`emit.cjs` 中均为 0 命中 |
| 三页共用一套桌号逻辑 | PASS | 三个页面都 `require('../../domain/tableOptions.js')`，调 `loadTableOptions()` |
| 首页选桌 → 菜单 → 结算 → 订单详情真实点击 | PASS | 订单 `ord_01M7J12QN87J0MPKDA5A7G`；菜单 A01/tbl_A01 · 结算 A01 · 订单 tableId=tbl_A01 |
| 演示支付仍为 `DEMO_PAID` | PASS | 同上报告：`UNPAID → DEMO_PAID`，`payResult=success`（模拟，无真实支付） |
| `miniprogram/` 镜像性质明确且有校验闸门 | PASS | `miniprogram/MIRROR.json`；`npm run mirror:check`；`mini:check` 输出镜像身份警告 |
| 资产重新冻结 + 导出工程直接编译 | PASS | 导出 `w5d-ship` 138 文件，产物树 `sha256:bd84ebac…`；AppID `verified:true`；四页 + 3 锚点点击全 PASS |
| 回归 | PASS | `npm test` 789/789 · `build` · `registry:check` · `component-catalog --check` · `mini:check` · `mini:dup-check` · `mini:smoke` 25 项 · `mini:pages` 22 项 · 服务端 47/47 · `git diff --check` |

未宣称：真机验证、体验版上传/发布、真实支付。

## 2. 桌号真源统一

新增 `templates/base/ordering-base/1.0.0/src/domain/tableOptions.js`，作为唯一桌号读取实现：

- `mapTables(payload)`：过滤非字符串/空 id，`name` 缺失时回退用 `id`，丢掉 `sortOrder` 等后端附加字段。
- `loadTableOptions(storeId)`：返回 `{ tableOptions, tablesLoading, tablesError }` 三件套；无 `storeId` 直接返回「缺少门店标识，无法读取桌号」；请求失败返回空列表 + 错误文案，**不回退任何本地固定桌号**。
- `nameOfTable(list, tableId)`：扫码进入只带 `tableId` 时，用后端列表翻译展示名称。

三个页面接线一致：

| 页面 | 变化 |
| --- | --- |
| 首页 | 删除 `versionGuard.resolveTables` 兜底与 `DEMO_TABLES`；`loadTables()` 走 `loadTableOptions`；新增 `onRetryTables`；`loading` 覆盖到桌号与身份加载完成之后（避免先闪「无桌号」） |
| 菜单页 | `loadTables()` 改用 `loadTableOptions`（W5c 已改，本轮补 `nameOfTable` 名称补全） |
| 结算页 | 新增 `loadTables()` + `onRetryTables()`，四态渲染与菜单页一致 |

三页 wxml 都是四态：加载中（`tablesLoading`）→ 失败（`tablesError` + 「重试」）→ 空列表（「还没有可用桌号」）→ 列表（选中项高亮）。

同时清理的遗留：

- `config/env.js` 删除 `DEMO_TABLES` 常量与导出；`scripts/composer/emit.cjs` 不再 emit 该常量。
- `state/visit-store.js` 的 `resolveTableName()` 不再查本地表，名称只由后端数据决定。
- `domain/versionGuard.js` 仅保留 `compareVersions`，去掉 `resolveTables`。
- 文案去掉「演示桌号」措辞（`home`/`menu`/`checkout`/`fulfillment-switch`）。

## 3. miniprogram/ 镜像收敛

`miniprogram/` 仍是 `mini:check`/`mini:smoke`/`mini:pages`/`mini:dup-check` 的检查对象，但它**不是交付入口**：

- 真源唯一：`templates/base/ordering-base/1.0.0/src`。
- `scripts/sync-miniprogram-mirror.cjs`（`npm run mirror:sync`）从真源受控覆盖同步，写入 `miniprogram/MIRROR.json`：
  `role: mirror`、`deliverable: false`、`sourceOfTruth`、`digest`（对文件 `path:sha256` 排序后取 sha256）、`fileCount`、`syncedAt`。
- `npm run mirror:check`（`--check`）校验清单与摘要，陈旧即报错；`mini:check` 在目标为仓库内 `miniprogram/` 时会一并校验，并把镜像身份作为警告输出：
  「镜像身份已声明（MIRROR.json）：149 个文件，真源 templates/base/ordering-base/1.0.0/src；本目录不是导出成果」。
- 仅存在于镜像里的用户资产（`assets/tabbar/*.svg`、`components/poster-carousel/*`）不被同步删除。
- 交付物只来自 Composer 导出目录；入口文档 `AGENTS.md` 已写明这条边界与命令。

## 4. 冻结与导出

- `node scripts/registry-check.cjs --write` 重新冻结模板注册表（`registry.v1.json` / `registry.lock.json`）。
- `node scripts/component-catalog.cjs --write` 重新生成组件目录（15 组件 / 8 页面 / 1 布局 / 61 区块，gap 1 warning）。
- 导出：`node scripts/composer/cli.cjs --plan .arts/w5/plan.json --out D:\dsh_work\w5d-export --project-name w5d-ship`
  - 产物树 `sha256:bd84ebac074bf931adea14dd279ea510eaff1f4d7f2f7e64b8753e4881eb484a`，Lock `sha256:24a8e295…`，138 文件。
- AppID 后处理：`applyAppid` 写入 `wx3b1c04f63cf6cfd0`，`verified:true`；导出审计 `.arts/w5d/audit-appid.json` 结论 PASS（A1–A10）。

## 5. 运行时验证（开发者工具 2.02 + automator）

证据：`.arts/w5d/devtools-run.json`、截图 `.arts/w5d/shots/pages-*.png`。

- 登录 / 编译（2.6s）/ 自动化端口：PASS。
- 四页渲染：首页、菜单、菜品详情、结算均 PASS。
- 三个页面处理器直调（分类切换、加购、购物车展开）：PASS。
- 真实点击：
  - 首页选桌 →「开始点餐」→ 菜单：首页 `A01/tbl_A01`，菜单 `A01/tbl_A01`（两页一致）。
  - 菜单选桌：`A01/tbl_A01`。
  - 结算提交：落到订单详情，真实后端订单 `ord_01M7J12QN87J0MPKDA5A7G`，桌号一致性通过。
  - 订单详情「演示模拟支付」：`UNPAID → DEMO_PAID`。
- 桌号数据源比对：后端 = 菜单 = 首页 = 结算 = `["tbl_A01/A01","tbl_A02/A02"]`，三页 `tablesLoading=false`、`tablesError` 为空。
- 组件宿主锚点点击（`#menu-category-nav` / `#menu-product-*` / `#menu-cart-bar`）：PASS。

本轮新增的运行时闸门：跑测前用「首页 data 是否含 `tablesLoading`」判断模拟器是否已加载新包，最多重试 10 次；仍失败则整轮记 `BLOCKED`，不会把旧包数据当成结果。

## 6. 回归

| 命令 | 结果 |
| --- | --- |
| `npm test` | 789 pass / 0 fail |
| `npm run build` | vite build 成功 |
| `node scripts/registry-check.cjs` | 通过 |
| `node scripts/component-catalog.cjs --check` | 0 error / 1 warning |
| `npm run mini:check` | 0 error / 1 warning（镜像身份提示） |
| `npm run mirror:check` | 通过（149 文件摘要一致） |
| `npm run mini:dup-check` | 一致 137 文件 / 警告 13 / 错误 0 |
| `npm run mini:smoke` | 25 项通过 |
| `npm run mini:pages` | 22 项通过 |
| 服务端 `vitest test/agent.service.test.ts test/model-provider-images.test.ts` | 47/47 |
| `git diff --check` | 无空白错误 |

顺手修掉的两处校验脚本陈旧断言（与业务实现对齐，不是放宽标准）：

- `scripts/miniprogram-smoke.cjs`：原先断言扫码后 `visit.tableName === 'A01'` 来自本地固定表；改为断言扫码只带 `tableId`、名称由后端 `/tables` 解析。
- `scripts/miniprogram-pages-smoke.cjs`：店主分段的键值写的是不存在的 `working`（真实键为 `pending/preparing/ready/history`）；并改为推进到 READY 后切到「待取餐」分段断言。

## 7. 已知限制

- `miniprogram/` 里 12 个仅存于镜像的资产（tabbar 图标、poster-carousel）与真源无对应文件，`mini:dup-check` 会持续给出 13 条警告。
- 运行时验证依赖本机微信开发者工具与本地后端（`http://127.0.0.1:3000/api/v1`，readyz 需为 ok）。
- 若开发者工具同时打开多个工程窗口，自动化端口可能连到旧窗口；跑测前先 `cli close --project <旧工程>`，或依赖本轮新增的「新包就绪」闸门直接暴露问题。
- 演示支付始终是模拟：`DEMO_PAID` 不代表真实交易。
