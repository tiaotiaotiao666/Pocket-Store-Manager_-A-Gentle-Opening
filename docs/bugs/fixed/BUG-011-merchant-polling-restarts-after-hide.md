# BUG-011 店主页离开后异步初始化重新启动轮询

- 状态：已修复
- 级别：P2 中
- 发现日期：2026-10-31
- 来源：两轮提交人工验收与生命周期复现
- 影响版本：`fd49d4f`（B2 小程序）
- 影响面：店主订单台初始化、10 秒轮询、订单分段与商品管理切换
- 涉及文件：`miniprogram/pages/merchant-orders/index.js`

## 1. 现象

进入店主订单台后立即离开，若鉴权或初始化尚未完成，`onHide` 只能清理当时尚未创建的 timer；随后 `bootstrap()` 继续执行并重新启动 10 秒轮询，违反“离开页面即停止”。

同类异步问题还包括：待处理/进行中分段快速切换时，较慢的旧响应可能覆盖新分段列表；切到商品管理后，旧订单请求仍可能回写错误或订单状态。

## 2. 根因

- 页面只有 `stopPolling()`，没有记录当前是否可见，`bootstrap()` 完成后无条件 `startPolling()`。
- `loadOrders()` 读取可变的页面分段并直接提交响应，没有请求新旧标识，无法丢弃过期响应。

修复前最小复现输出为：页面离开后轮询仍存在 `true`。

## 3. 修复

- 增加 `pageActive`：`onLoad/onShow` 标记可见，`onHide/onUnload` 标记不可见。
- `startPolling()` 同时检查可见性、轮询开关和当前 tab；不可见时初始化不再补拉订单或启动 timer，回到页面后由 `onShow` 恢复。
- 增加 `ordersRequestSerial`，每次订单请求取唯一序号；离开页面或切到商品管理时使旧请求失效，仅允许最新请求更新页面。
- 订单请求固定捕获发起时的 `storeId` 和分段，避免读取后续变化造成错配。

## 4. 验证证据

| 命令/操作 | 结果 |
| --- | --- |
| 修复前生命周期复现 | 离开后轮询仍存在 `true` |
| 修复后同一复现 | 轮询为 `false`，订单请求序号保持离开时的失效值，未补发订单加载 |
| `node --test test/miniprogram-regressions.test.cjs test/miniprogram-components.test.cjs` | 18/18 通过，含离开初始化与旧分段响应用例 |
| `npm test` | 139/139 通过 |
| `npm run mini:pages` | 21/21 真实后端页面检查通过，正常进入、离开和商品切换无回归 |

## 5. 防回归与边界

回归用例位于 `test/miniprogram-regressions.test.cjs`。后续新增异步加载或定时任务时必须同时处理 `onHide/onUnload` 与过期响应。Node 页面运行时只验证逻辑和 timer，不代表微信渲染层已经人工走查。