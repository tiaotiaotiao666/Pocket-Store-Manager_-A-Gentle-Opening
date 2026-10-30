# 后端数据模型（B 套餐基线）

> 本文是 B 套餐（A + B2）的数据层契约。字段以 `docs/api.md` 为准，订单规则以 `docs/order-state.md` 为准。
> 数据库目标：MySQL 8（生产映射华为云 RDS）；本地开发使用 MySQL 8 ZIP 免安装实例。
> 金额一律整数分；时间存 UTC；主键使用应用侧生成的 ULID 风格字符串（`<prefix>_<26位>`）。

## 1. 表清单

| 表 | 用途 |
| --- | --- |
| `users` | 微信用户 |
| `sessions` | 服务端不透明会话 Token |
| `stores` | 门店、主题、履约开关、目录版本 |
| `store_members` | 门店成员与角色（唯一角色来源） |
| `categories` | 菜单分类 |
| `products` | 商品（含上下架） |
| `store_tables` | 堂食桌号 |
| `orders` | 订单主表 |
| `order_items` | 下单商品快照 |
| `order_status_logs` | 状态变更历史 |
| `idempotency_keys` | 创建订单幂等记录 |

## 2. 字段定义

### users

| 字段 | 类型 | 约束 / 说明 |
| --- | --- | --- |
| `id` | CHAR(26) | PK，`usr_` 前缀 |
| `openId` | VARCHAR(64) | UNIQUE，微信 OpenID；禁止出现在日志与错误响应 |
| `displayName` | VARCHAR(64) | 默认「微信顾客」 |
| `createdAt` | DATETIME(3) | UTC |
| `updatedAt` | DATETIME(3) | UTC |

### sessions

| 字段 | 类型 | 约束 / 说明 |
| --- | --- | --- |
| `id` | CHAR(26) | PK |
| `userId` | CHAR(26) | FK → users |
| `tokenHash` | CHAR(64) | UNIQUE，SHA-256(token) |
| `expiresAt` | DATETIME(3) | 默认 7 天 |
| `createdAt` | DATETIME(3) | UTC |

索引：`(userId)`、`(expiresAt)`。

### stores

| 字段 | 类型 | 约束 / 说明 |
| --- | --- | --- |
| `id` | VARCHAR(64) | PK，演示值 `store-demo-001` |
| `name` | VARCHAR(64) | 门店名 |
| `address` | VARCHAR(255) | 地址 |
| `phone` | VARCHAR(32) | 电话 |
| `businessHours` | VARCHAR(64) | 营业时间 |
| `dineInEnabled` | BOOLEAN | 堂食开关 |
| `takeawayEnabled` | BOOLEAN | 自取开关 |
| `backgroundColor` | CHAR(7) | 主题背景 |
| `textColor` | CHAR(7) | 主题文字 |
| `primaryColor` | CHAR(7) | 主题主色 |
| `catalogVersion` | INT | 目录版本，上下架时 +1 |
| `createdAt` | DATETIME(3) | UTC |
| `updatedAt` | DATETIME(3) | UTC |

### store_members

| 字段 | 类型 | 约束 / 说明 |
| --- | --- | --- |
| `id` | CHAR(26) | PK |
| `storeId` | VARCHAR(64) | FK → stores |
| `userId` | CHAR(26) | FK → users |
| `role` | ENUM(`OWNER`,`STAFF`) | 唯一角色来源 |
| `createdAt` | DATETIME(3) | UTC |

唯一键：`(storeId, userId)`。绑定只允许服务端种子/运维操作。

### categories

| 字段 | 类型 | 约束 / 说明 |
| --- | --- | --- |
| `id` | VARCHAR(64) | PK |
| `storeId` | VARCHAR(64) | FK → stores |
| `name` | VARCHAR(64) | 分类名 |
| `sortOrder` | INT | 升序 |
| `createdAt` | DATETIME(3) | UTC |

索引：`(storeId, sortOrder)`。

### products

| 字段 | 类型 | 约束 / 说明 |
| --- | --- | --- |
| `id` | VARCHAR(64) | PK |
| `storeId` | VARCHAR(64) | FK → stores |
| `categoryId` | VARCHAR(64) | FK → categories |
| `name` | VARCHAR(64) | 商品名 |
| `description` | VARCHAR(255) | 描述 |
| `priceCents` | INT UNSIGNED | 单价，整数分 |
| `imageUrl` | VARCHAR(512) | 可为空 |
| `available` | BOOLEAN | 是否可售 |
| `sortOrder` | INT | 升序 |
| `createdAt` | DATETIME(3) | UTC |
| `updatedAt` | DATETIME(3) | UTC |

索引：`(storeId, categoryId, sortOrder)`、`(storeId, available)`。

### store_tables

| 字段 | 类型 | 约束 / 说明 |
| --- | --- | --- |
| `id` | VARCHAR(64) | PK，如 `tbl_A01` |
| `storeId` | VARCHAR(64) | FK → stores |
| `name` | VARCHAR(32) | 展示名，如 `A01` |
| `sortOrder` | INT | 升序 |
| `createdAt` | DATETIME(3) | UTC |

索引：`(storeId, sortOrder)`。

### orders

| 字段 | 类型 | 约束 / 说明 |
| --- | --- | --- |
| `id` | CHAR(26) | PK，`ord_` 前缀 |
| `storeId` | VARCHAR(64) | FK → stores |
| `userId` | CHAR(26) | FK → users |
| `tableId` | VARCHAR(64) NULL | 自取为 NULL |
| `fulfillmentType` | ENUM(`DINE_IN`,`TAKEAWAY`) | 履约方式 |
| `status` | ENUM(`PENDING_PAYMENT`,`PENDING_ACCEPT`,`PREPARING`,`READY`,`COMPLETED`,`CANCELLED`) | 六态 |
| `paymentStatus` | ENUM(`UNPAID`,`DEMO_PAID`) | 演示支付状态 |
| `totalCents` | INT UNSIGNED | 服务端计算 |
| `note` | VARCHAR(255) | 可为空 |
| `createdAt` | DATETIME(3) | UTC |
| `updatedAt` | DATETIME(3) | UTC |

索引：`(storeId, status, createdAt)`、`(userId, storeId, createdAt)`、`(storeId, createdAt)`。

### order_items

| 字段 | 类型 | 约束 / 说明 |
| --- | --- | --- |
| `id` | CHAR(26) | PK |
| `orderId` | CHAR(26) | FK → orders |
| `productId` | VARCHAR(64) | 下单商品 ID |
| `name` | VARCHAR(64) | 下单时名称快照 |
| `unitPriceCents` | INT UNSIGNED | 下单时单价快照 |
| `quantity` | INT UNSIGNED | 1–99 |
| `lineTotalCents` | INT UNSIGNED | `unitPriceCents * quantity` |

索引：`(orderId)`。

### order_status_logs

| 字段 | 类型 | 约束 / 说明 |
| --- | --- | --- |
| `id` | CHAR(26) | PK |
| `orderId` | CHAR(26) | FK → orders |
| `fromStatus` | ENUM(...) NULL | 创建时为空 |
| `toStatus` | ENUM(...) | 变更后状态 |
| `actorType` | ENUM(`CUSTOMER`,`MERCHANT`,`SYSTEM`) | 操作者类型 |
| `actorId` | CHAR(26) NULL | 用户 ID |
| `reason` | VARCHAR(255) NULL | 取消原因等 |
| `createdAt` | DATETIME(3) | UTC |

索引：`(orderId, createdAt)`。

### idempotency_keys

| 字段 | 类型 | 约束 / 说明 |
| --- | --- | --- |
| `id` | CHAR(26) | PK |
| `userId` | CHAR(26) | FK → users |
| `storeId` | VARCHAR(64) | FK → stores |
| `key` | VARCHAR(128) | 客户端 `Idempotency-Key` |
| `requestHash` | CHAR(64) | 规范化 payload 的 SHA-256 |
| `orderId` | CHAR(26) NULL | 首次成功创建后写入 |
| `expiresAt` | DATETIME(3) | 创建后 24 小时 |
| `createdAt` | DATETIME(3) | UTC |

唯一键：`(userId, storeId, key)`。索引：`(expiresAt)`。

## 3. 事务与并发

1. **创建订单**（单事务）：
   1. 校验门店、履约方式、桌号归属。
   2. 读取商品（`storeId` + `id`，`available=true`），缺失返回 `409 PRODUCT_UNAVAILABLE`。
   3. 合并重复商品 ID，校验数量 1–99。
   4. 按数据库单价计算行小计与总额。
   5. 写 `orders`、`order_items`、首条 `order_status_logs`、`idempotency_keys`。
   6. 幂等键唯一冲突时读取已有记录：请求指纹一致返回原订单，否则 `409 IDEMPOTENCY_CONFLICT`。

2. **状态更新**（单事务）：
   1. 读取订单并校验门店/归属。
   2. 校验状态转换矩阵。
   3. `UPDATE orders SET status=?, paymentStatus=?, updatedAt=? WHERE id=? AND status=?`。
   4. 受影响行数为 0 → `409 STATUS_CONFLICT`。
   5. 写一条 `order_status_logs`。

3. **目录版本**：商品上下架在事务内 `catalogVersion = catalogVersion + 1`，提交后删除 Redis `catalog:{storeId}`。

## 4. 演示种子

- 门店：`store-demo-001` / 柑橘小馆 / 示范市演示路 1 号 / 10:00-21:00 / 堂食+自取。
- 主题：`#F7F3EC`、`#232323`、`#E86A17`。
- 分类：招牌主食、小食饮品。
- 商品：6 个，含一个用于演示下架的商品。
- 桌号：`tbl_A01`（A01）、`tbl_A02`（A02）。
- 成员：`demo-owner-001` → `OWNER`；可选 `demo-staff-001` → `STAFF`。
- 顾客：`demo-customer-001`。

## 5. 迁移与种子约定

- 迁移：`npx prisma migrate dev`（本地）/ `npx prisma migrate deploy`（部署）。
- 种子：`npx tsx prisma/seed.ts`，必须可重复执行（upsert）。
- 测试库：`DATABASE_URL` 指向独立 schema（如 `smart_store_test`），每次集成测试前迁移并清库。
- 禁止在生产执行种子脚本；生产门店由运维流程导入。