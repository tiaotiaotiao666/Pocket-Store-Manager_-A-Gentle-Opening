# BUG-012 cart-panel 结算事件负载不符合组件契约

- 状态：已修复
- 级别：P3 低
- 发现日期：2026-10-31
- 来源：组件契约人工验收
- 影响版本：`fd49d4f`（B2 小程序）
- 影响面：`cart-panel` 组件复用与事件契约测试
- 涉及文件：`miniprogram/components/cart-panel/index.js`、`test/miniprogram-components.test.cjs`

## 1. 现象

`docs/component-contract.md` 规定 `cart-panel` 的 `checkout` 事件 detail 为 `{ totalCents, items }`，实现却返回 `{ totalCents, totalQuantity }`。

当前页面没有读取该事件的 detail，因此主流程未受阻断；但其他页面若按契约复用组件，会拿不到 `items`，且事件包含契约外字段。

## 2. 根因

组件实现和原测试同时沿用了 `cart-bar` 的 `totalQuantity` 负载，没有按 `cart-panel` 的独立契约校验，导致测试虽然通过却没有发现契约偏差。

## 3. 修复

`checkout` 改为只返回 `{ totalCents: this.data.totalCents, items: this.data.items }`。页面仍负责重新读取购物车、校验桌号并生成下单 payload，不信任组件金额或明细。组件契约本身无需修改。

## 4. 验证证据

| 命令/操作 | 结果 |
| --- | --- |
| `test/miniprogram-components.test.cjs` 契约断言 | 明确验证 detail 含 `totalCents/items`，不再用 `totalQuantity` 替代 |
| `node --test test/miniprogram-regressions.test.cjs test/miniprogram-components.test.cjs` | 18/18 通过 |
| `npm test` | 139/139 通过 |
| `npm run mini:check` | 7 页面、13 组件，0 错误 0 警告 |
| `npm run mini:pages` | 21/21 通过，购物车和结算主链路无回归 |

## 5. 防回归

组件事件测试必须逐字段对照 `docs/component-contract.md`，不能只验证“有事件发出”。后续若要增加字段，应先修订契约，再修改实现和测试。