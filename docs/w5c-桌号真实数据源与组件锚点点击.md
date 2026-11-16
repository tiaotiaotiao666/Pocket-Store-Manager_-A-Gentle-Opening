# W5c：桌号真实数据源与组件内真实点击补验

基线：`bd1eff3`（W5b）。本轮只做两件事：菜单页桌号改为真实后端数据源；组件宿主加锚点后做一次真实点击补验。
不扩张新功能，不重做已通过项目；演示支付仍只有 `DEMO_PAID`，不发布、不上传体验版。

## 1. 结论摘要

| 项目 | 状态 | 证据 |
| --- | --- | --- |
| 菜单页桌号来自 `/stores/:id/tables` | PASS | 页面桌号 `["tbl_A01/A01","tbl_A02/A02"]` = 后端桌号（运行时对比） |
| 加载中 / 空列表 / 请求失败 / 重试 四态 | PASS | 5 条单测（成功映射、空列表、失败不清空为演示桌号、重试恢复、无 DEMO_TABLES 引用） |
| 选桌 → 结算 → 订单桌号一致 | PASS | 菜单 `A01/tbl_A01` = 结算页 `A01` = 真实订单 `tableId=tbl_A01` |
| 演示模拟支付 | PASS | `paymentStatus: UNPAID → DEMO_PAID`，`payResult=success`（演示态，无真实交易） |
| 组件内真实点击（分类 / 加购 / 购物车） | PASS | 三条锚点点击全部改变状态，详见 §4 |
| 资产重冻结与门禁 | PASS | `registry-check.cjs --write` 重冻结 10 个资产摘要；A1–A10 审核 PASS |
| 发布 / 体验版 / 真机 | NOT_RUN | 按边界不执行，也不宣称 |

W5b 遗留的唯一 BLOCKED（自定义组件内部节点点击）在本轮解除：给组件宿主加稳定 `id`/`class` 锚点后，
`automator` 可以定位宿主，并在宿主范围内查到组件内部节点并真实点击。

## 2. 桌号改为真实数据源

改动文件：`templates/base/ordering-base/1.0.0/src/pages/menu/index.{js,wxml,wxss}`

- `data` 不再有 `tableOptions: config.DEMO_TABLES`，改为空数组 + `tablesLoading` / `tablesError` 两个状态位。
- 新增 `loadTables(storeId)`：`storeService.getTables(storeId)` → 过滤出合法 `{id, name}`；
  失败时**清空列表**并写入错误文案，绝不回退 A01/A02；门店标识缺失时直接给出「缺少门店标识」错误态。
- 新增 `onRetryTables()`：错误态下的重试入口，重新走 `loadTables`。
- `loadCatalog()` 成功后调用 `loadTables()`；下拉刷新同时刷新桌号。
- 模板把桌号区从「仅未选桌时显示」改为「堂食态常显」，并显式渲染四态：
  加载中「正在读取门店桌号…」→ 失败（文案 + 重试）→ 空列表「当前门店还没有可用桌号，请联系店员确认」→ 桌号列表（当前选中高亮）。

单测 `test/w5c-menu-tables.test.cjs`（5 条，全部通过）：

```text
✔ 成功时把后端 tables 映射成桌号选项
✔ 后端返回空列表时保持空态，不塞演示桌号
✔ 请求失败时进入错误态并清空列表，不回退 A01/A02
✔ 失败后重试可恢复真实数据
✔ 页面不再引用 DEMO_TABLES，模板覆盖加载/空/失败/重试四态
```

注：`config/env.js` 的 `DEMO_TABLES` 仍被首页/结算页的「演示入口」使用，本轮按「不扩张范围」未改动它们；
菜单页已完全脱离该常量（单测第 5 条守护这一点）。

## 3. 组件宿主锚点与资产重冻结

- `category-nav` → `id="menu-category-nav" class="menu__nav-host"`
- `product-card` → `id="menu-product-{{item.id}}" class="menu__card-host"`
- `cart-bar` → `id="menu-cart-bar" class="menu__cart-host"`

按既有流程重冻结（未绕过 Composer）：

```text
node scripts/registry-check.cjs --write
  → 已重新冻结 10 个资产摘要：sha256:926caf8c1530b5ee…
  → 注册表校验通过：2026.11.0 · base 1 / ui-block 3 / feature-pack 1 / frontend-pack 1 / recipe 4
node scripts/component-catalog.cjs --write
  → 15 个组件 / 8 个页面 / 1 个布局 / 61 个区块（0 error / 1 warning）
```

导出与 AppID 写入（与 W5b 同一条流水线，未手改产物）：

```text
node scripts/composer/cli.cjs --plan .arts/w5/plan.json --out D:\dsh_work\w5c-export --project-name w5c-real
  → 生成成功，137 文件，树摘要 sha256:169ec2b0…
applyAppid({ outputPath: 'D:\dsh_work\w5c-export\w5c-real', appid: 'wx3b1c04**********d0' })
  → applied=true verified=true fileCount=137，侧车 appid-postprocess.json
node scripts/wechat-export-audit.cjs D:\dsh_work\w5c-export\w5c-real → 结论 PASS（A1–A10）
```

## 4. 真实点击补验（本次唯一一次尝试，未升级 automator）

工具链不变：微信开发者工具 2.02 + `miniprogram-automator` 0.13。
路径：`page.$('#宿主锚点')` 定位宿主 → `host.$$('组件内部类名')` 定位内部可点节点 → `.tap()` → 读页面数据断言。

| 交互 | 定位路径 | 状态断言 | 状态 |
| --- | --- | --- | --- |
| 分类切换 | `#menu-category-nav` → `host.$$('.category-nav__item')`（点最后一个） | `activeCategoryId: cat_sig → cat_snack` | PASS |
| 菜品加购 | `#menu-product-prd_beef_rice` → `host.$$('.product-card__step--add')` | `quantityMap[prd_beef_rice]: 0 → 1` | PASS |
| 购物车展开 | `#menu-cart-bar` → `host.$$('.cart-bar__summary')` | `cartVisible: false → true` | PASS |

对比 W5b 的结论（当时无锚点）：`page.$('category-nav')`=null、`page.$$('product-card')`=0，
说明当时缺的是**宿主可定位性**，不是 automator 能力缺失。加了 `id`/`class` 后一次通过，未更换版本、未继续探针。

页内点击链路（页面级节点，仍为真实点击）：

| 步骤 | 断言 | 状态 |
| --- | --- | --- |
| 首页「开始点餐」 | 当前页面 → `pages/menu/index` | PASS |
| 选桌 `.menu__table` | `tableName="" → "A01"`，`tableId=tbl_A01`（2 个可点节点，来自后端） | PASS |
| 结算提交 | 落到 `pages/order-detail/index`，真实订单 `ord_01M7HXS57199CB1ZFR0V5B`；桌号 菜单 `A01/tbl_A01` = 结算页 `A01` = 订单 `tableId=tbl_A01` | PASS |
| 演示模拟支付 | `UNPAID → DEMO_PAID`，`payResult=success`（演示支付，未发生真实交易） | PASS |

`HANDLER_CALL`（非点击）证据继续单独标注保留，作为业务逻辑层佐证，不与点击结论混算。

## 5. 已知差异与未做的事

- `miniprogram/` 是旧复制脚本时代的镜像目录，本身就落后于 `templates/base/ordering-base/1.0.0`（HEAD 版本里
  menu 页甚至没有 `slots.generated.js` / `extensions.generated.js` 的 require）。本轮未把它当作验收对象，
  也未新增同步改动；`npm run mini:check` 仍对镜像绿态通过，产物真源是 Composer 导出。
- `product-detail` 页面不展示桌号，因此「订单详情桌号一致」以订单对象 `tableId` 佐证，而非页面文案。
- 未发布、未上传体验版、未做真机与真实支付验证。
- 未改动首页/结算页的演示桌号兜底逻辑（超出本轮范围），如需彻底统一可另开一轮。

## 6. 回归

| 命令 | 结果 |
| --- | --- |
| `npm test` | PASS · 779 通过 / 0 失败（含 W5c 新增 5 条） |
| `npm run build` | PASS · vite built in 5.09s（仅 chunk 体积提示） |
| `npm run registry:check` | PASS · 2026.11.0 · 10 个资产摘要重冻结后一致 |
| `npm run mini:check` | PASS · 0 错误 0 警告 |
| `node scripts/component-catalog.cjs --check` | PASS · 0 error / 1 warning（既有 gap） |
| `cd server && npx vitest run test/agent.service.test.ts test/model-provider-images.test.ts` | PASS · 2 文件 47 用例 |
| `cd server && npx tsc --noEmit` / `npm run build` | 未改动服务端代码，沿用 W5b 绿态 |
| `git diff --check` | PASS · 无空白错误 |

## 7. 证据路径（已脱敏）

| 证据 | 路径 |
| --- | --- |
| 编译/运行/交互报告 | `.arts/w5c/devtools-run.json` |
| 运行截图（4 页） | `.arts/w5c/shots/` |
| 原始产物审核 | `.arts/w5c/audit-appid.json` |
| 后端启动日志 | `.arts/w5c-server.log`、`.arts/w5c-server-err.log` |
| 导出工程（真实 AppID，脱敏为 `wx3b1c04**********d0`） | `D:\dsh_work\w5c-export\w5c-real` |

## 8. 复现

```powershell
cd server; node dist/main.js         # 另开终端；GET /api/v1/readyz 应为 200 且 database=ok
cd ..
node scripts/registry-check.cjs --write
node scripts/composer/cli.cjs --plan .arts/w5/plan.json --out D:\dsh_work\w5c-export --project-name w5c-real
node -e "require('./desktop/appid-postprocess.cjs').applyAppid({outputPath:'D:\\dsh_work\\w5c-export\\w5c-real',appid:'wx3b1c04f63cf6cfd0'})"
node scripts/wechat-export-audit.cjs D:\dsh_work\w5c-export\w5c-real --json .arts/w5c/audit-appid.json
node scripts/wechat-devtools-run.cjs D:\dsh_work\w5c-export\w5c-real --json .arts/w5c/devtools-run.json --shots .arts/w5c/shots
```
