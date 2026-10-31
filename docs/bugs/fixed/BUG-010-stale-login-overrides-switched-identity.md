# BUG-010 旧登录请求覆盖已切换的演示身份

- 状态：已修复
- 级别：P1 高
- 发现日期：2026-10-31
- 来源：两轮提交人工验收与可控异步复现
- 影响版本：`fd49d4f`（B2 小程序）
- 影响面：小程序登录、退出登录、演示身份切换及依赖当前会话的页面操作
- 涉及文件：`miniprogram/services/session.js`、`miniprogram/services/auth.js`、`miniprogram/services/request.js`

## 1. 现象

顾客登录请求尚未返回时切换到店主，若店主登录先成功、顾客登录后成功，旧顾客结果会最后写入 storage，导致界面刚完成店主切换，实际会话却回退成顾客。退出登录期间存在同类问题：旧登录晚返回会重新建立已退出的会话。

该问题不会让客户端越过后端权限校验，但会让后续操作使用非预期身份，造成店主入口消失、操作被错误拒绝或以错误身份创建订单。

## 2. 根因

`auth.login` 与 401 后的 `request.demoRelogin` 在异步请求完成后无条件调用 `session.saveLogin`。会话层没有身份代次，无法识别“请求发出后已经切换身份或退出登录”。

可控复现中让店主响应先返回、顾客响应后返回，修复前实际输出为：最终会话身份 `customer`、用户 `customer`。

## 3. 修复

- `session.js` 增加 `identityRevision`，只在 `clear()` 和真正切换 `setIdentity()` 时递增，普通登录成功与刷新用户资料不改变代次。
- 登录与自动重登在发起前记录代次；写入时同时校验代次和当前身份。
- 过期结果被拒绝并抛出 `SESSION_SUPERSEDED`，不再写入 Token、用户或身份，也不会用旧身份结果重放原请求。
- 正常同身份登录、并发去重和持久化流程保持不变。

## 4. 验证证据

| 命令/操作 | 结果 |
| --- | --- |
| 修复前可控异步复现 | 旧顾客登录覆盖店主，最终为 `customer` |
| 修复后同一复现 | 旧登录返回 `SESSION_SUPERSEDED`，最终保持 `owner` |
| `node --test test/miniprogram-regressions.test.cjs test/miniprogram-components.test.cjs` | 18/18 通过，含身份切换与退出登录竞争 |
| `npm test` | 139/139 通过 |
| `npm run mini:smoke` | 24/24 真实后端检查通过，顾客/店主切换无回归 |

## 5. 防回归与边界

回归用例位于 `test/miniprogram-regressions.test.cjs`。后续修改登录、自动重登或会话持久化时，必须保留“异步结果只能在原身份代次内落盘”的约束。微信开发者工具内的人工点击复验未执行，不以 Node 结果冒充渲染层验收。