# W5b：真实后端、有效 AppID 原始工程与交互验证

基线：`e478340`（W5）。本次不重做 W5 的静态审核，补充 W5 遗留的三件事：
服务端编译错误、真实后端运行验证、有效 AppID 的**原始导出产物**编译，以及自定义组件交互的实测结论。
所有结论只用 PASS / FAIL / BLOCKED / NOT_RUN。

## 1. 结论摘要

| 项目 | 状态 | 关键证据 |
| --- | --- | --- |
| `agent.service.ts` 两个 TypeScript 错误 | PASS | `npx tsc --noEmit` exit=0；`npm run build`（nest build）exit=0 |
| Agent 相关服务端测试 | PASS | 4 个文件 95 个用例全通过 |
| 真实 NestJS 后端 | PASS | `GET /api/v1/readyz` → `{"status":"ok","database":"ok","cache":"memory"}`（HTTP 200） |
| 原始导出产物（含有效 AppID）编译 | PASS | `cli open --project` exit=0，1.4s；工程内 `appid: wx3b1c04f63cf6cfd0`（未手改副本） |
| 首页 / 菜单 / 菜品详情 / 结算四页真实运行 | PASS | 数据全部来自真实后端（门店「柑橘小馆」、菜品「柑橘牛肉饭 ¥28.00」） |
| 分类切换 / 加购 / 购物车展开（组件内部节点点击） | BLOCKED | automator 无法定位自定义组件宿主与内部节点，最小复现见 §5 |
| 分类切换 / 加购 / 购物车展开（页面处理器直调 + 状态断言） | PASS | `activeCategoryId: cat_sig → cat_snack`；`quantityMap: 0 → 1`，总额 `¥16.00`；`cartVisible: false → true` |
| 真实点击：首页 CTA / 选桌 / 结算提交 / 演示模拟支付 | PASS | 订单 `ord_01M7HVYFGZ6PSY8E7WZ4KB`，`UNPAID → DEMO_PAID`（演示支付） |
| 发布 / 体验版上传 / 真机验证 | NOT_RUN | 按边界要求不执行，也不宣称 |

结论：W5 遗留的三项缺口已补齐；唯一仍 BLOCKED 的是「自定义组件内部节点点击」这一类交互，
原因是本机开发者工具 2.02 + `miniprogram-automator` 0.13 的平台限制，不是业务逻辑问题。

## 2. 服务端 TypeScript 错误修复

- 位置：`server/src/agent/agent.service.ts:188`（`handleScreenReference`）、`:264`（`handleTurnV2`）。
- 报错：`TS2322 / TS2345`，`ValidatedAgentImage` 不能赋给 `AgentProviderImage`。
- 根因：`AgentImageKind = 'menu' | 'store' | 'reference'`（校验器支持参考截图），
  而 Provider 侧的 `AgentProviderImage.kind` 只声明了 `'menu' | 'store'`，两者类型不兼容。
- 修法：把 `server/src/agent/provider/agent-provider.interface.ts` 的 `kind` 扩到
  `'menu' | 'store' | 'reference'`，与校验器保持一致，并注明 Provider 只用 `mediaType + data`
  构造多模态消息、`kind` 仅作来源标注（`deepseek-agent.provider.ts` 确认未按 kind 分支）。
- 没有使用 `any`、`@ts-ignore`，也没有跳过检查：

```text
npx tsc -p tsconfig.json --noEmit   → exit=0
npm run build (nest build)          → exit=0
npx vitest run test/agent.service.test.ts test/agent-turn-v2.test.ts \
  test/model-provider-images.test.ts test/agent-runtime.executor.test.ts
  → 4 files / 95 tests 全部通过
```

全量服务端测试：`Test Files 6 failed | 19 passed (25)`、`Tests 296 passed | 85 skipped`。
6 个失败文件（`b1-merchant`/`b1-orders`/`b1-production`/`b1-public-auth`/`b3-imports`/`b3-tables`）
在收集阶段即失败，属 W5 已记录的既有 DB 依赖问题，本次未改动。

## 3. 真实后端运行验证

```text
GET http://127.0.0.1:3000/api/v1/readyz
{"status":"ok","database":"ok","cache":"memory","timestamp":"2026-11-16T09:47:24.587Z"}   HTTP 200

GET http://127.0.0.1:3000/api/v1/stores/store-demo-001
{"id":"store-demo-001","name":"柑橘小馆","address":"示范市演示路 1 号", ...}

GET http://127.0.0.1:3000/api/v1/stores/store-demo-001/tables
{"storeId":"store-demo-001","tables":[{"id":"tbl_A01","name":"A01"},{"id":"tbl_A02","name":"A02"}]}
```

- 后端为 `server/dist/main.js`（本次重新构建后的产物），数据库 MySQL `smart_store` 真实连接。
- `scripts/wechat-runtime-stub.cjs` **未启动**，本次所有 PASS 均不使用桩数据；
  桩脚本作为明确标注的开发辅助保留，不计入本轮结论。

## 4. 有效 AppID 的原始导出产物

导出用既有 Composer 流水线（不做手改副本）：

```text
node scripts/composer/cli.cjs --plan .arts/w5/plan.json --out D:\dsh_work\w5b-export --project-name w5b-real
  → 生成成功：D:\dsh_work\w5b-export\w5b-real，文件数 137
```

AppID 走仓库既有的后置写入通道 `desktop/appid-postprocess.cjs#applyAppid`
（含 `APPID_RE = /^wx[0-9a-f]{16}$/` 门禁、manifest/lock/report 自洽校验、回滚备份、侧车记录）：

```text
applyAppid({ outputPath: 'D:\dsh_work\w5b-export\w5b-real', appid: 'wx3b1c04f63cf6cfd0' })
  → applied=true verified=true fileCount=137
  → digest 8c74134d… → fba3e434…；lockDigest 5efdcf95… → d96d6d2f…；treeDigest f04da99e… → fd4bb114…
  → backupDir D:\dsh_work\w5b-export\.appid-backup\w5b-real-2026-11-16T092915Z
  → sidecar  w5b-real\appid-postprocess.json
```

门禁未被绕过：Composer 仍然输出 `touristappid`；只有经由后置写入（含校验）后才变成真实 AppID，
`touristappid` 场景继续保持「开发者工具拒绝打开」的 BLOCKED 语义。

AppID 写入后对该**原始产物**重跑静态审核：`A1–A10 全 PASS`，AppID 分类为「真实 AppID」，141 个文件
（137 产物 + lock + report + Markdown + 侧车）。`scripts/wechat-export-audit.cjs` 的 A10 补充了
侧车元数据豁免（`appid-postprocess.json`），并加了回归用例。

编译直接对**该原始产物**执行，不再使用手改副本：

```text
cli islogin                 → {"login":true}              exit=0  0.2s
cli open --project <原始产物> → 编译通过                    exit=0  1.4s
cli auto --project <原始产物> --auto-port 9420              exit=0  6.1s
```

## 5. 四页运行结果（真实后端）

| 页面 | 状态 | 真实数据证据 | 截图 |
| --- | --- | --- | --- |
| `/pages/home/index` | PASS | 门店「柑橘小馆」 | `.arts/w5b/shots/pages-home-index.png` |
| `/pages/menu/index` | PASS | 2 个分类、3 个菜品 | `.arts/w5b/shots/pages-menu-index.png` |
| `/pages/product-detail/index?productId=prd_beef_rice` | PASS | 「柑橘牛肉饭」¥28.00 | `.arts/w5b/shots/pages-product-detail-index.png` |
| `/pages/checkout/index` | PASS | 购物车 1 件、合计 ¥56.00，演示支付提示文案完整 | `.arts/w5b/shots/pages-checkout-index.png` |

此前 W5 的菜品详情是「缺少 productId → 已下架降级态」，本轮按页面真实入参
（`onLoad(options.productId)`）传参，因此渲染的是真实菜品。

## 6. 交互验证：哪些是真实点击，哪些不是

### 6.1 真实点击（PASS）

| 步骤 | 断言 | 状态 |
| --- | --- | --- |
| 首页「开始点餐」`.home__cta` | 点击后当前页面 = `pages/menu/index` | PASS |
| 菜单页选桌 `.menu__table` | `tableName="" → "A01"`（可点节点 2 个） | PASS |
| 结算页提交 `.checkout__bar-button` | 落到 `pages/order-detail/index`，真实后端订单号 `ord_01M7HVYFGZ6PSY8E7WZ4KB`，结算页提示「提交后进入订单详情，再点击「演示模拟支付」，本流程不产生真实支付。」 | PASS |
| 订单详情「演示模拟支付」`.detail__bar-primary` | `paymentStatus UNPAID → DEMO_PAID`，`payResult=success`（演示支付，无真实交易） | PASS |

### 6.2 组件内部节点点击（BLOCKED）

| 交互 | 状态 | 最小复现结论 |
| --- | --- | --- |
| 分类切换（`category-nav` 内 `.category-nav__item`） | BLOCKED | `page.$('category-nav')` = null；`page.$$('.category-nav__item')` = 0 |
| 菜品加购（`product-card` 内 `.product-card__add`） | BLOCKED | `page.$$('product-card')` = 0；点击宿主 `.menu__product` 不触发 `bind:add` |
| 购物车展开（`cart-bar` 内 `.cart-bar__summary`） | BLOCKED | `page.$$('cart-bar')` = 0；宿主无 id/class 锚点 |

同一限制的其余佐证（探针脚本保留在 `.arts/w5b/`）：

- `page.getElementsByXpath('//category-nav')` → `Cannot read properties of undefined (reading 'map')`；
- appservice 内 `page.selectComponent('category-nav')` / `page.selectAllComponents('product-card')` → null / 0；
- `element.dispatchEvent({ eventName:'add', $:'product-card', detail:{productId} })` 不改变 `quantityMap`；
- `page.callMethod('onSelectCategory', …)` → `No context found for objectId`；
- 页面实例上不存在 `__wxExparserNode`，无法从 appservice 遍历组件树。

### 6.3 页面处理器直调（PASS，明确标注非点击）

组件内部节点不可点击，但页面事件处理器可达。用 `miniProgram.evaluate` 在 appservice 里
以组件 `triggerEvent` 的等价负载调用页面处理器，并断言状态真的变化：

| 交互 | 等价负载 | 状态断言 | 状态 |
| --- | --- | --- | --- |
| 分类切换 | `{ detail: { id } }`（`category-nav` emits `{id}`） | `activeCategoryId: cat_sig → cat_snack`，菜品切换为 `prd_snack_platter, prd_tea` | PASS |
| 菜品加购 | `{ detail: { productId } }`（`product-card` emits `{productId}`） | `quantityMap[prd_snack_platter]: 0 → 1`；购物车 `0 → 1`；`¥16.00` | PASS |
| 购物车展开 | `{ detail: {} }`（`cart-bar` emits `{}`） | `cartVisible: false → true` | PASS |

这三条只证明业务逻辑与真实后端数据联动正确，**不冒充点击通过**；点击路径依旧是 BLOCKED。

## 7. 边界与未做的事

- 未发布、未上传体验版、未做真机验证，也没有宣称真实支付（演示态 `DEMO_PAID`）。
- 未放宽 Composer 白名单、AppID 门禁或 Lock 校验；未为了测试删除任何业务功能。
- 发现但**未擅自修改**的产品差距：菜单页桌号来自 `config/env.js` 的 `DEMO_TABLES` 常量，
  真实后端 `/stores/:storeId/tables` 虽返回 A01/A02，小程序并未消费该接口；
  改成读接口属于功能变更，超出 W5b 范围，此处仅记录。
- 为定位组件实例曾尝试给模板组件宿主加 `id/class` 锚点，触发资产冻结校验
  （`ASSET_INTEGRITY_MISMATCH`，模板内容变更需重新冻结）；该改动已回滚，
  本轮结论不依赖任何模板改动。

## 8. 回归

| 命令 | 结果 |
| --- | --- |
| `npm test` | PASS · 774 通过 / 0 失败（含新增的 AppID 侧车用例） |
| `npm run build` | PASS · vite built in 1.85s（仅 chunk 体积提示） |
| `npm run registry:check` | PASS · 2026.11.0（base 1 / ui-block 3 / feature-pack 1 / frontend-pack 1 / recipe 4） |
| `npm run mini:check` | PASS · 0 错误 0 警告 |
| `cd server && npx tsc --noEmit` | PASS · exit=0 |
| `cd server && npm run build` | PASS · exit=0 |
| `cd server && npx vitest run` | 部分 PASS · 19/25 文件、296 用例通过；6 个 DB 依赖文件收集失败（既有问题） |
| `git diff --check` | PASS · 无空白错误 |

## 9. 证据路径

| 证据 | 路径 |
| --- | --- |
| 真实后端 readyz | `.arts/w5b/readyz.json` |
| 原始产物静态审核 | `.arts/w5b/audit-original-appid.json` |
| 编译 + 运行 + 交互报告 | `.arts/w5b/devtools-run.json` |
| 运行截图（5 张） | `.arts/w5b/shots/` |
| 后端启动日志 | `.arts/w5b-server.log`、`.arts/w5b-server-err.log` |
| 交互能力探针（组件定位/派发/树遍历） | `.arts/w5b/probe-interact.cjs`、`probe-dispatch.cjs`、`probe-root.cjs`、`probe-chain.cjs`、`probe-exparser.cjs`、`probe-tables.cjs` |
| 导出工程（原始产物，含真实 AppID） | `D:\dsh_work\w5b-export\w5b-real`（AppID 未写入的对照产物：`w5b-real` 的导出前存档见同目录 `.appid-backup\`） |
| W5 原始证据 | `.arts/w5/`（未删除、未覆盖） |

## 10. 复现

```powershell
# 1) 服务端编译与真实后端
cd server; npx tsc -p tsconfig.json --noEmit; npm run build
node dist/main.js            # 另开终端，确认 GET /api/v1/readyz = 200 & database=ok

# 2) 导出 + AppID 后置写入（门禁内）
cd ..
node scripts/composer/cli.cjs --plan .arts/w5/plan.json --out D:\dsh_work\w5b-export --project-name w5b-real
node -e "require('./desktop/appid-postprocess.cjs').applyAppid({outputPath:'D:\\dsh_work\\w5b-export\\w5b-real',appid:'wx3b1c04f63cf6cfd0'})"

# 3) 静态审核 + 真实编译 + 运行/交互
node scripts/wechat-export-audit.cjs D:\dsh_work\w5b-export\w5b-real --json .arts/w5b/audit-original-appid.json
node scripts/wechat-devtools-run.cjs D:\dsh_work\w5b-export\w5b-real --json .arts/w5b/devtools-run.json --shots .arts/w5b/shots
```

前提：本机微信开发者工具已登录，且 `security.enableServicePort=true`（否则 CLI 报「服务端口未开启」→ BLOCKED）。
