# BUG-017 小程序组件调用 `event.stopPropagation`，微信运行时报错阻断加购

- 状态：已修复
- 级别：P1 高
- 发现日期：2026-11-01
- 来源：M10 微信开发者工具真实编译（用户点击加购）
- 影响版本：Base `ordering-base/1.0.0`、`miniprogram` 镜像、`product-card` UI Block
- 影响面：商品加购、数量增减、订单支付/取消/推进按钮
- 涉及文件：`templates/base/ordering-base/1.0.0/src/components/product-card/index.js`、`order-card/index.js`、`miniprogram/components/product-card/index.js`、`order-card/index.js`、`templates/components/product-card/1.0.0/src/index.js`、`test/miniprogram-components.test.cjs`

## 1. 现象

微信开发者工具中点击商品加购，控制台报：

```text
TypeError: MiniProgramError
event.stopPropagation is not a function
    at ui.onAdd (index.js:45)
```

加购不生效，购物车无法继续。

## 2. 根因

- WXML 的加购/减购按钮已经使用 `catch:tap`，微信会在模板层阻止事件冒泡。
- 组件 JS 里又调用了 `event.stopPropagation()`。微信小程序的事件对象没有这个方法（浏览器 DOM 事件才有）。
- 单测传入的是 `{ stopPropagation() {} }` 这类 mock 对象，掩盖了真实运行时的契约差异，导致 14 项组件测试一直通过。

## 3. 修复

1. 删除 5 处多余的 `event.stopPropagation()`：
   - `product-card`：`onAdd`、`onRemove`
   - `order-card`：`onPay`、`onCancel`、`onAdvance`
2. 同步修改四处源码：
   - Base：`templates/base/ordering-base/1.0.0/src/components/*`
   - 镜像：`miniprogram/components/*`
   - UI Block：`templates/components/product-card/1.0.0/src/index.js`
3. 组件测试改用真实事件形态（空对象 / 只带 `currentTarget.dataset`），不再注入 `stopPropagation`；如果组件重新引入该调用，测试会直接失败。
4. 因 Base 与 UI Block 内容变化，按约定执行 `node scripts/registry-check.cjs --write` 重冻结；`registryVersion` 仍为 `2026.11.0`，只更新 integrity / contentDigest。

## 4. 验证证据

| 命令 | 结果 |
| --- | --- |
| `node --test test/miniprogram-components.test.cjs` | 14/14 通过 |
| `npm run mini:check` | 0 错误 / 0 警告 |
| `npm run mini:dup-check` | 0 错误，Base 与镜像一致 |
| `npm run registry:check` | 2026.11.0 通过（重冻结后） |
| `npm test` | 338 项：337 pass / 0 fail / 1 todo |
| `npm run build` | exit 0，1639 模块 |

## 5. 复测结果

2026-11-01 用户在微信开发者工具中重新编译后，完成加购、减购、购物车、结算、演示支付、订单与店主接单全流程，确认不再出现 `stopPropagation is not a function`。M10–M12 同时确认通过。

## 6. 防回归

- 小程序事件处理器不要调用浏览器 DOM 方法（`stopPropagation`、`preventDefault` 等）；阻止冒泡用 WXML 的 `catch:tap` / `catch:touchmove`。
- 组件单测的事件对象必须使用微信真实形态，不要补 `stopPropagation` 之类的方法；mock 越像“方便测试”，越容易掩盖线上差异。
- 改 Base 或 UI Block 后必须同步 `miniprogram` 镜像并重新冻结注册表。