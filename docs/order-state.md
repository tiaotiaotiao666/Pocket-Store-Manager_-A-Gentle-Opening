# 订单状态与权限规则

本文件定义订单状态机。后端实现、数据库约束、测试用例和前端状态展示均以此为准。

## 1. 状态枚举

| 枚举 | 中文名 | 含义 | 是否进行中 |
| --- | --- | --- | --- |
| `PENDING_PAYMENT` | 待付款 | 订单已创建，尚未模拟付款 | 是（仅顾客可见） |
| `PENDING_ACCEPT` | 待接单 | 演示模拟支付完成，等待店主接单 | 是 |
| `PREPARING` | 制作中 | 店主已接单，正在制作 | 是 |
| `READY` | 可取餐 | 制作完成，等待顾客取餐 | 是 |
| `COMPLETED` | 已完成 | 顾客已取餐，流程结束 | 否 |
| `CANCELLED` | 已取消 | 订单终止 | 否 |

支付状态独立存储：`UNPAID`、`DEMO_PAID`。`DEMO_PAID` 不代表真实微信支付成功。

## 2. 转换矩阵

| 当前状态 | 目标状态 | 允许操作者 | 前置条件 |
| --- | --- | --- | --- |
| `PENDING_PAYMENT` | `PENDING_ACCEPT` | 订单所属顾客 | 调用模拟付款；`ALLOW_DEMO_PAYMENT=true` 且非生产环境 |
| `PENDING_PAYMENT` | `CANCELLED` | 订单所属顾客 | 可选；记录 `reason=USER_CANCELLED` |
| `PENDING_ACCEPT` | `PREPARING` | 该门店 `OWNER`/`STAFF` | 订单属于该门店 |
| `PENDING_ACCEPT` | `CANCELLED` | 该门店 `OWNER`/`STAFF` | 必须提供 `reason`；模拟支付不退款，仅标记取消 |
| `PREPARING` | `READY` | 该门店 `OWNER`/`STAFF` | 订单属于该门店 |
| `PREPARING` | `CANCELLED` | 该门店 `OWNER`/`STAFF` | 必须提供 `reason` |
| `READY` | `COMPLETED` | 该门店 `OWNER`/`STAFF` | 订单属于该门店 |
| `READY` | `CANCELLED` | 该门店 `OWNER`/`STAFF` | 必须提供 `reason` |
| `COMPLETED` | — | 无人 | 终态，不可变更 |
| `CANCELLED` | — | 无人 | 终态，不可变更 |

禁止：

- 跳过中间状态（例如 `PENDING_ACCEPT → READY`、`PREPARING → COMPLETED`）。
- 状态回退（例如 `READY → PREPARING`）。
- 店主修改 `PENDING_PAYMENT` 订单：必须返回 `409 MERCHANT_CANNOT_HANDLE_UNPAID`。
- 顾客修改任何已付款订单状态。
- 顾客取消 `PENDING_ACCEPT` 及之后状态的订单。

## 3. 支付规则

1. 创建订单：`status=PENDING_PAYMENT`、`paymentStatus=UNPAID`，不允许直接创建已支付订单。
2. 模拟付款：只允许订单所属用户在 `PENDING_PAYMENT` 状态调用，成功后同时写入 `status=PENDING_ACCEPT`、`paymentStatus=DEMO_PAID`。
3. 重复模拟付款：订单已处于 `PENDING_ACCEPT` 或之后状态时，幂等返回当前订单，不重复写状态记录。
4. 已取消订单调用模拟付款：`409 INVALID_STATUS_TRANSITION`。
5. 生产环境或 `ALLOW_DEMO_PAYMENT=false`：`403 DEMO_PAYMENT_DISABLED`。
6. 首版没有真实支付、退款和对账；取消已模拟付款订单只记录状态，不产生退款流水。

## 4. 幂等与并发

- 创建订单依赖 `Idempotency-Key`：用户 + 门店 + Key 唯一，保存请求指纹与订单 ID 24 小时。
- 状态更新使用事务 + 条件更新：`UPDATE orders SET status=:to WHERE id=:id AND status=:expected`；受影响行数为 0 时返回 `409 STATUS_CONFLICT`。
- 每次成功状态变更写一条状态记录，失败不写。
- 重试非法状态更新不得产生部分更新或重复记录。

## 5. 状态记录

表 `order_status_logs` 至少包含：

| 字段 | 说明 |
| --- | --- |
| `id` | 主键 |
| `orderId` | 订单 ID |
| `fromStatus` | 变更前状态；创建时可为空 |
| `toStatus` | 变更后状态 |
| `actorType` | `CUSTOMER` / `MERCHANT` / `SYSTEM` |
| `actorId` | 用户 ID；系统操作为空 |
| `reason` | 取消原因等，可为空 |
| `createdAt` | 变更时间 |

`GET /orders/:id` 返回按 `createdAt` 升序的 `statusHistory`，供顾客和店主查看。

## 6. 展示规则

- 顾客首页只突出 `paymentStatus=DEMO_PAID` 且状态为 `PENDING_ACCEPT`/`PREPARING`/`READY` 的订单；待付款订单在订单页单独提示“待付款”。
- 店主订单台默认显示 `PENDING_PAYMENT,PENDING_ACCEPT`，并明确标记支付状态；待付款订单不可接单。
- 所有模拟付款相关界面必须含“演示模拟支付”字样，禁止显示“微信支付成功”。
- 状态未知或接口失败时显示错误状态，不猜测订单已完成。

## 7. 验收用例

| 编号 | 场景 | 期望 |
| --- | --- | --- |
| S1 | 顾客创建堂食订单但无桌号 | `422 TABLE_REQUIRED`，不落单 |
| S2 | 顾客用其他门店桌号 | `422 TABLE_NOT_FOUND` |
| S3 | 创建订单后重复提交同一幂等键 | 返回同一订单，不重复落单 |
| S4 | 修改幂等键对应的商品数量后重试 | `409 IDEMPOTENCY_CONFLICT` |
| S5 | 顾客模拟付款自己的待付款订单 | 变为 `PENDING_ACCEPT`/`DEMO_PAID` |
| S6 | 再次模拟付款同一订单 | 幂等返回当前订单 |
| S7 | 店主尝试接单待付款订单 | `409 MERCHANT_CANNOT_HANDLE_UNPAID` |
| S8 | 店主跨门店修改订单 | `403 FORBIDDEN` |
| S9 | 店主 `PENDING_ACCEPT → PREPARING → READY → COMPLETED` | 全部成功并各写一条记录 |
| S10 | 店主 `PENDING_ACCEPT → READY` | `409 INVALID_STATUS_TRANSITION` |
| S11 | 生产环境模拟登录或模拟付款 | `403`，不创建会话/不改变订单 |
| S12 | 商品停售后刷新菜单 | 商品消失；旧订单快照不变 |