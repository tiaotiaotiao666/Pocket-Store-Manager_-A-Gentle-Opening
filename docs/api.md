# API 契约 v1

本文件是前后端联调的唯一接口依据。任何字段增删必须先改本文件，再改实现。

## 1. 通用约定

- Base URL：`https://<api-domain>/api/v1`；本地为 `http://127.0.0.1:3000/api/v1`。
- 传输：HTTPS + `application/json; charset=utf-8`。
- 字段命名：camelCase。
- 金额：整数“分”，字段名以 `Cents` 结尾；禁止浮点和字符串金额。
- 时间：ISO 8601 UTC，例如 `2026-10-29T04:30:00.000Z`；界面按 `Asia/Shanghai` 展示。
- 鉴权：除 `POST /auth/wechat/login` 和 `GET /health` 外，均需 `Authorization: Bearer <token>`。
- 租户：所有门店资源都必须带 `storeId`。服务端以 Token 中的用户和门店成员记录判定权限；不接受客户端传入角色。
- 成功响应：直接返回资源对象或分页对象，不额外包 `data`。
- 错误响应：

```json
{
  "code": "PRODUCT_UNAVAILABLE",
  "message": "商品已停售，请刷新菜单",
  "requestId": "req_01J...",
  "details": { "productId": "prd_001" }
}
```

`message` 可直接展示给用户；`details` 可选。禁止在错误中返回堆栈、SQL、密钥或 OpenID。

## 2. 鉴权

### POST /auth/wechat/login

请求：

```json
{
  "code": "wx.login 返回的临时 code",
  "demoOpenId": "可选；仅开发环境模拟登录"
}
```

- 正式流程：服务端用 `code` 调用微信 `jscode2session`，只接受服务端换取的 OpenID。
- 模拟流程：仅当 `NODE_ENV !== production` 且 `ALLOW_DEMO_LOGIN=true` 时接受 `demoOpenId`；其他情况返回 `403 DEMO_LOGIN_DISABLED`。
- 首次登录创建用户；不创建门店成员，不授予任何角色。

响应 `200`：

```json
{
  "token": "opaque-session-token",
  "expiresIn": 604800,
  "user": {
    "id": "usr_001",
    "displayName": "微信顾客",
    "memberships": [
      { "storeId": "store-demo-001", "role": "OWNER" }
    ]
  }
}
```

`memberships` 只来自数据库预绑定的门店成员记录，可能为空。角色只有 `OWNER`、`STAFF`。

### GET /auth/me

响应同登录响应中的 `user` 对象，额外返回 `serverTime`：

```json
{
  "id": "usr_001",
  "displayName": "微信顾客",
  "memberships": [],
  "serverTime": "2026-10-29T04:30:00.000Z"
}
```

## 3. 门店与菜单

### GET /stores/:storeId

公开接口，无需登录。

```json
{
  "id": "store-demo-001",
  "name": "柑橘小馆",
  "address": "示范市演示路 1 号",
  "phone": "000-0000-0000",
  "businessHours": "10:00-21:00",
  "fulfillment": { "dineIn": true, "takeaway": true },
  "theme": {
    "backgroundColor": "#F7F3EC",
    "textColor": "#232323",
    "primaryColor": "#E86A17"
  }
}
```

### GET /stores/:storeId/catalog

公开接口。只返回 `available=true` 的商品；下架商品不出现。服务端用 Redis 缓存，键为 `catalog:{storeId}`，店主修改商品售卖状态后主动删除该键。

```json
{
  "storeId": "store-demo-001",
  "version": 12,
  "updatedAt": "2026-10-29T04:30:00.000Z",
  "categories": [
    {
      "id": "cat_001",
      "name": "招牌主食",
      "sortOrder": 1,
      "products": [
        {
          "id": "prd_001",
          "name": "柑橘牛肉饭",
          "description": "现炒牛肉，配时蔬",
          "priceCents": 2800,
          "imageUrl": "",
          "available": true,
          "sortOrder": 1
        }
      ]
    }
  ]
}
```

## 4. 顾客订单

### 订单对象

```json
{
  "id": "ord_001",
  "storeId": "store-demo-001",
  "storeName": "柑橘小馆",
  "tableId": "tbl_A01",
  "tableName": "A01",
  "fulfillmentType": "DINE_IN",
  "status": "PENDING_PAYMENT",
  "paymentStatus": "UNPAID",
  "items": [
    {
      "productId": "prd_001",
      "name": "柑橘牛肉饭",
      "unitPriceCents": 2800,
      "quantity": 1,
      "lineTotalCents": 2800
    }
  ],
  "totalCents": 2800,
  "note": "",
  "createdAt": "2026-10-29T04:30:00.000Z",
  "updatedAt": "2026-10-29T04:30:00.000Z"
}
```

- `fulfillmentType`：`DINE_IN`（堂食）或 `TAKEAWAY`（自取）。
- `tableId`、`tableName`：仅堂食有值，自取为 `null`。
- `paymentStatus`：`UNPAID`、`DEMO_PAID`。`DEMO_PAID` 仅表示演示模拟支付，不代表微信支付成功。
- 订单项保存下单时的名称和单价快照，菜单后续修改不影响历史订单。
- 详情接口额外返回 `statusHistory`（见 `docs/order-state.md`）。

### POST /orders

请求头必须带 `Idempotency-Key`：8–128 个可见 ASCII 字符，前端每次结算生成一个，重试时复用。

```json
{
  "storeId": "store-demo-001",
  "fulfillmentType": "DINE_IN",
  "tableId": "tbl_A01",
  "items": [
    { "productId": "prd_001", "quantity": 2 }
  ],
  "note": "少辣"
}
```

规则：

- 堂食必须提供属于该门店的 `tableId`，缺失返回 `422 TABLE_REQUIRED`，不属于该店返回 `422 TABLE_NOT_FOUND`。
- 自取忽略 `tableId`，服务端存 `null`。
- 只接受现有接口里 `available=true` 的商品；任一不可售返回 `409 PRODUCT_UNAVAILABLE`，不创建订单。
- `quantity` 为 1–99 的整数；商品 ID 重复时合并数量，超过 99 返回 `422 VALIDATION_ERROR`。
- 服务端按数据库单价计算 `lineTotalCents` 和 `totalCents`。请求中出现价格、总价等字段一律忽略。
- 服务端校验商品、餐桌均属于 `storeId`。
- 同一用户 + 同一门店 + 同一 `Idempotency-Key` 重复提交：payload 相同则返回原订单（`200`）；payload 不同返回 `409 IDEMPOTENCY_CONFLICT`。保留期 24 小时。
- 新订单状态 `PENDING_PAYMENT`，`paymentStatus=UNPAID`。

响应：`201` 订单对象；幂等重放为 `200`。

### POST /orders/:id/demo-payment

无请求体。仅订单所属用户可调用，且仅当订单为 `PENDING_PAYMENT`。

- 成功：`PENDING_PAYMENT → PENDING_ACCEPT`，`paymentStatus=DEMO_PAID`，写状态记录。
- 重复调用：订单已是 `PENDING_ACCEPT` 或更后状态时，幂等返回当前订单（`200`），不再写状态记录。
- 订单已取消：`409 INVALID_STATUS_TRANSITION`。
- 非本人订单：`404 ORDER_NOT_FOUND`。
- `ALLOW_DEMO_PAYMENT=false` 或生产环境：`403 DEMO_PAYMENT_DISABLED`。
- 响应文案必须由前端标注“演示模拟支付”，后端不返回“微信支付成功”。

### GET /orders

查询当前用户自己的订单。

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `storeId` | 是 | 门店 ID，校验门店存在 |
| `status` | 否 | 单个状态，逗号分隔可多个 |
| `active` | 否 | `true` 时只返回待付款/待接单/制作中/可取餐 |
| `page` | 否 | 默认 1 |
| `pageSize` | 否 | 默认 20，最大 50 |

响应：

```json
{
  "items": [],
  "page": 1,
  "pageSize": 20,
  "total": 0
}
```

### GET /orders/:id

仅订单所属用户或该门店成员可读。非本人且非成员返回 `404 ORDER_NOT_FOUND`，避免泄露订单是否存在。

## 5. 店主接口

以下接口要求 Token 用户在该 `storeId` 拥有 `OWNER` 或 `STAFF` 成员记录。`storeId` 从路径或订单归属解析，**不信任客户端声明的角色**。跨店访问返回 `403 FORBIDDEN`；资源不存在返回 `404`。

### GET /merchant/stores/:storeId/orders

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `status` | 否 | 逗号分隔；默认 `PENDING_PAYMENT,PENDING_ACCEPT` |
| `page` | 否 | 默认 1 |
| `pageSize` | 否 | 默认 20，最大 50 |

返回分页订单对象（含 `paymentStatus`），按 `createdAt` 升序，先到先处理。店主订单台前端每 10 秒刷新，离开页面停止。

### PATCH /merchant/orders/:id/status

```json
{
  "toStatus": "PREPARING",
  "expectedStatus": "PENDING_ACCEPT",
  "reason": "可选，取消时填写"
}
```

- 校验订单属于 Token 成员所在门店。
- 校验转换合法（见 `docs/order-state.md`）；非法转换返回 `409 INVALID_STATUS_TRANSITION`。
- `expectedStatus` 可选；提供且与当前状态不一致返回 `409 STATUS_CONFLICT`，防止两个设备互相覆盖。
- 店主不能修改 `PENDING_PAYMENT` 订单；返回 `409 MERCHANT_CANNOT_HANDLE_UNPAID`。
- 成功返回更新后的订单对象，并追加状态记录。

### PATCH /merchant/products/:id/availability

```json
{ "available": false }
```

- 仅该商品所属门店的成员可操作。
- 成功后删除 Redis 的 `catalog:{storeId}`，并递增目录 `version`。
- 返回商品对象（含 `available`、`updatedAt`）。
- 不提供新增、改价、删除商品接口（首版范围外）。

## 6. 健康检查

### GET /health

无需登录，不访问数据库和 Redis，仅用于进程存活检查：

```json
{
  "status": "ok",
  "service": "smart-store-server",
  "environment": "development",
  "timestamp": "2026-10-29T04:30:00.000Z"
}
```

## 7. 错误码

| HTTP | code | 含义 |
| --- | --- | --- |
| 400 | `BAD_REQUEST` | JSON 或请求头格式错误 |
| 401 | `AUTH_REQUIRED` | 缺少或无效 Token |
| 401 | `AUTH_INVALID` | 微信 code 无效或会话过期 |
| 403 | `FORBIDDEN` | 无该门店角色或跨店操作 |
| 403 | `DEMO_LOGIN_DISABLED` | 当前环境不允许模拟登录 |
| 403 | `DEMO_PAYMENT_DISABLED` | 当前环境不允许模拟付款 |
| 404 | `STORE_NOT_FOUND` | 门店不存在 |
| 404 | `ORDER_NOT_FOUND` | 订单不存在或无权查看 |
| 404 | `PRODUCT_NOT_FOUND` | 商品不存在或不属于该店 |
| 409 | `PRODUCT_UNAVAILABLE` | 商品已停售 |
| 409 | `INVALID_STATUS_TRANSITION` | 状态转换不允许 |
| 409 | `STATUS_CONFLICT` | `expectedStatus` 与当前状态不一致 |
| 409 | `MERCHANT_CANNOT_HANDLE_UNPAID` | 店主不能处理待付款订单 |
| 409 | `IDEMPOTENCY_CONFLICT` | 同一幂等键对应不同请求 |
| 422 | `TABLE_REQUIRED` | 堂食缺少桌号 |
| 422 | `TABLE_NOT_FOUND` | 桌号不属于该门店 |
| 422 | `VALIDATION_ERROR` | 字段校验失败 |
| 429 | `RATE_LIMITED` | 请求过于频繁 |
| 500 | `INTERNAL_ERROR` | 服务端错误（不返回内部细节） |
| 502 | `WECHAT_UPSTREAM_ERROR` | 微信登录上游暂时不可用（B1 实现，2026-10-31 增补） |
| 503 | `WECHAT_NOT_CONFIGURED` | 服务端未配置微信小程序凭据（B1 实现，2026-10-31 增补） |

## 8. 前端调用约束

- 所有请求集中在服务层；组件不得直接调用 API。
- 登录 Token 只存内存或 `wx.storage`，不得写入日志。
- 创建订单必须生成并复用 `Idempotency-Key`；按钮提交期间禁用。
- 收到 `PRODUCT_UNAVAILABLE` 后刷新菜单并提示用户重新选择。
- 收到 `AUTH_REQUIRED` / `AUTH_INVALID` 时清理本地 Token 并重新登录。
- 店主入口必须以后端 `memberships` 为准；前端隐藏入口不是权限控制。
## 9. B 套餐增补接口（v1.1，2026-10-31）

本节为 B 套餐（可演示闭环）增补，原章节编号不变。

### POST /orders/:id/cancel

仅订单所属顾客可调用，且订单必须为 `PENDING_PAYMENT`。

请求：

```json
{ "reason": "可选，顾客取消原因" }
```

- 成功：`PENDING_PAYMENT → CANCELLED`，`paymentStatus` 保持 `UNPAID`，写一条 `actorType=CUSTOMER` 的状态记录。
- 订单已为 `CANCELLED`：幂等返回当前订单（`200`）。
- 订单已 `PENDING_ACCEPT` 及之后：`409 INVALID_STATUS_TRANSITION`。
- 非本人订单：`404 ORDER_NOT_FOUND`。
- 顾客取消不受 `ALLOW_DEMO_PAYMENT` 开关影响。

### GET /merchant/stores/:storeId/products

要求 Token 用户在该门店拥有 `OWNER` 或 `STAFF`。返回包含下架商品的完整目录，供店主上下架使用。

```json
{
  "storeId": "store-demo-001",
  "categories": [
    {
      "id": "cat_001",
      "name": "招牌主食",
      "sortOrder": 1,
      "products": [
        {
          "id": "prd_001",
          "name": "柑橘牛肉饭",
          "description": "现炒牛肉，配时蔬",
          "priceCents": 2800,
          "imageUrl": "",
          "available": true,
          "sortOrder": 1,
          "updatedAt": "2026-10-29T04:30:00.000Z"
        }
      ]
    }
  ]
}
```

- 跨店访问：`403 FORBIDDEN`。
- 与公开 `GET /stores/:storeId/catalog` 的区别：不过滤 `available`、不读 Redis、不返回目录 `version`。

### GET /readyz

无需登录，用于部署就绪检查，会访问数据库与缓存。

```json
{
  "status": "ok",
  "database": "ok",
  "cache": "redis",
  "timestamp": "2026-10-29T04:30:00.000Z"
}
```

- 数据库不可用：`503`，`status: "error"`，`database: "unavailable"`。
- 缓存使用内存降级模式时：`cache: "memory"`，`status` 仍为 `ok`；Redis 连接失败并已降级时同样报告 `memory`，由服务端日志告警。
- 不返回连接串、密钥或驱动错误细节。
- 该接口不替代 `GET /health`；`/health` 仍保持不访问数据库与缓存。
## 10. B3 受控导入增补（2026-10-31）

> 目标：把桌面端由 Agent 收集的结构化门店资料，经**受控通道**写入后端，且不覆盖运营数据。
> 全部接口前缀 `/api/v1`；除公开桌号外均需 `Authorization: Bearer <sessionToken>`。

### 10.1 `POST /merchant/stores/:storeId/imports`

店主（`OWNER`）把 AgentDraft 导入门店配置。`STAFF` 与跨店访问一律 `403 FORBIDDEN`。

请求头：

| 头 | 必填 | 说明 |
| --- | --- | --- |
| `Authorization` | 是 | Bearer 会话 Token |
| `Idempotency-Key` | `mode=apply` 必填 | 8–128 位可见 ASCII；同一键重复提交返回首次结果 |
| `Content-Type` | 是 | `application/json` |

请求体：

```json
{
  "mode": "preview",
  "payload": {
    "profile": {
      "name": "松月食堂",
      "category": "社区餐馆",
      "address": "上海市静安区示例路 8 号",
      "phone": "13800000000",
      "notes": "社区家常菜",
      "businessHours": [
        { "start": "10:00", "end": "14:00" },
        { "start": "17:00", "end": "21:00" }
      ]
    },
    "categories": [
      { "draftId": "cat-1", "name": "招牌主食", "sortOrder": 1 }
    ],
    "products": [
      {
        "draftId": "dish-1",
        "categoryDraftId": "cat-1",
        "name": "宫保鸡丁",
        "priceCents": 2800,
        "description": "微辣",
        "available": true
      }
    ],
    "tables": [
      { "draftId": "table-1", "name": "A01", "sortOrder": 1 }
    ],
    "sourceDraftDigest": "64 位小写十六进制 sha256",
    "unsupported": { "images": true, "modifiers": false, "specs": false }
  },
  "confirmations": []
}
```

约束：

- `profile.name` 1–48；`category` 1–48；`address` ≤120；`phone` ≤32；`notes` ≤200。
- `businessHours` 1–3 段，`HH:MM-HH:MM`，不重叠，拼接后 ≤64 字符。
- `categories` ≤3；`products` 3–5；`tables` ≤20。
- `priceCents` 1–999999 的整数（分）；不得出现 `priceText/totalCents`。
- 分类名、同分类商品名、桌号名在**请求内**不允许重复。
- `delivery` 出现时必须为 `false`；图片/加料/规格字段一律拒绝（放入 `unsupported` 说明）。
- 请求体上限 256 KB。

`mode=preview` 响应（200）：

```json
{
  "importId": "imp_preview_01",
  "mode": "preview",
  "previewToken": "1770000000000.<64hex>",
  "expiresAt": "2026-11-01T00:10:00.000Z",
  "diff": {
    "profile": [
      { "field": "name", "current": "柑橘小馆", "incoming": "松月食堂", "action": "conflict", "confirmationKey": "profile.name" }
    ],
    "categories": [
      { "draftId": "cat-1", "name": "招牌主食", "action": "create", "confirmationKey": "category:cat-1" }
    ],
    "products": [
      { "draftId": "dish-1", "name": "宫保鸡丁", "action": "create", "confirmationKey": "product:dish-1" }
    ],
    "tables": [
      { "draftId": "table-1", "name": "A01", "action": "create", "confirmationKey": "table:table-1" }
    ]
  },
  "conflicts": ["profile.name"],
  "notImported": ["菜品图片", "加料", "规格"],
  "summary": { "create": 4, "update": 0, "skip": 0, "conflict": 1 }
}
```

- `preview` **不写库**、不消耗幂等键。
- `action` 只允许 `create/update/skip/conflict`；默认动作 `skip`，不静默改价、不静默上架、不删除未声明项。
- `previewToken` 绑定 `storeId + userId + payload`，默认 10 分钟有效。

`mode=apply` 请求额外携带：

```json
{
  "mode": "apply",
  "previewToken": "1770000000000.<64hex>",
  "confirmations": ["profile.name"],
  "payload": { "...": "与 preview 完全一致" }
}
```

`apply` 响应（200）：

```json
{
  "importId": "imp_01",
  "mode": "apply",
  "status": "APPLIED",
  "replay": false,
  "mapping": {
    "categories": { "cat-1": "cat_xxx" },
    "products": { "dish-1": "prd_xxx" },
    "tables": { "table-1": "tbl_xxx" }
  },
  "configVersion": 4,
  "catalogVersion": 6,
  "cacheRefreshed": true,
  "notImported": ["菜品图片", "加料", "规格"],
  "conflicts": []
}
```

语义：

- **整体事务**：分类/商品/桌号 upsert → 更新门店 profile → `configVersion+1`、`catalogVersion+1` → 写入 `store_imports(status='APPLIED')`；任一步失败整体回滚。
- **幂等**：`(storeId, userId, idempotencyKey)` 唯一；同键同 `requestHash` 返回首次 `resultJson`（`replay: true`）；同键不同内容 → `409 IDEMPOTENCY_CONFLICT`。
- **确认**：`confirmations` 必须覆盖全部 `conflicts`，否则 `422 CONFIRMATION_REQUIRED`。
- **过期**：`previewToken` 过期或与 payload 不匹配 → `422 PREVIEW_STALE`。
- **缓存**：事务提交后失效 `catalog:<storeId>`；失效失败返回 `cacheRefreshed: false`，不回滚数据。
- **不删除**：未在请求中声明的既有分类/商品/桌号保持原样。
- **不覆盖**：`skip` 项不更新既有记录；`update` 必须由 `confirmations` 明确允许。

错误码：

| HTTP | code | 场景 |
| --- | --- | --- |
| 400 | `BAD_REQUEST` | 缺少 storeId / 请求体为空 |
| 401 | `AUTH_REQUIRED` | 未登录或 Token 失效 |
| 403 | `FORBIDDEN` | 非门店成员、`STAFF`、跨店 |
| 404 | `STORE_NOT_FOUND` | 门店不存在 |
| 409 | `IDEMPOTENCY_CONFLICT` | 同键不同内容 |
| 422 | `VALIDATION_ERROR` | DTO 校验失败（含价格、时段、数量） |
| 422 | `DUPLICATE_CATEGORY` / `DUPLICATE_PRODUCT` / `DUPLICATE_TABLE` | 请求内重名 |
| 422 | `CONFIRMATION_REQUIRED` | 冲突未逐项确认 |
| 422 | `PREVIEW_STALE` | previewToken 过期/不匹配 |
| 422 | `DELIVERY_NOT_SUPPORTED` | 出现 `delivery: true` |

### 10.2 `GET /merchant/stores/:storeId/imports/:importId`

返回导入结果（需 `OWNER`）：

```json
{
  "importId": "imp_01",
  "status": "APPLIED",
  "createdAt": "2026-11-01T00:00:00.000Z",
  "result": { "...": "与 apply 响应相同" }
}
```

- 不存在或不属于该门店 → `404 IMPORT_NOT_FOUND`。

### 10.3 `GET /stores/:storeId`

公开接口增补两个版本字段（不改变其它字段与错误语义）：

```json
{
  "id": "store-demo-001",
  "name": "柑橘小馆",
  "configVersion": 3,
  "catalogVersion": 5
}
```

### 10.4 `GET /stores/:storeId/tables`

公开、只读、无需登录：

```json
{
  "storeId": "store-demo-001",
  "tables": [
    { "id": "tbl_A01", "name": "A01", "sortOrder": 1 }
  ]
}
```

- 只返回 `id/name/sortOrder`，不返回订单、占用状态或任何顾客信息。
- 门店不存在 → `404 STORE_NOT_FOUND`。
- 排序稳定：`sortOrder asc, id asc`。

### 10.5 与小程序导出配置的关系

- 导出工程 `config/store.generated.js` 的 `meta` 写入 `storeConfigVersion/catalogVersion`；缺失写 `null` 并进入 `versionGaps`。
- 小程序启动时对比本地 `meta.catalogVersion` 与在线 `GET /catalog.version`，落后时提示刷新，但**以在线数据为准**。