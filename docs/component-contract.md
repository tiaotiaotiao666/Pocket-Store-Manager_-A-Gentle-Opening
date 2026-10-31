# 小程序组件通信契约

## 1. 分层职责

```text
页面 Page    组合组件、调用服务层、处理导航、管理页面状态
组件 Component 只展示，只接收 properties，只派发 events
服务层 Service  封装 wx.request、Token、错误归一化
领域逻辑       价格展示、状态文案、购物车计算由纯函数模块承担
```

页面可删除未使用的组件，不得因删除组件而修改服务层或后端。

## 2. 组件硬性约束

组件内部禁止：

1. 调用 `wx.request`、`wx.uploadFile`、云函数或任何 API。
2. 读取/写入 `getApp().globalData`、页面栈或其他全局业务状态。
3. 使用 `wx.navigateTo`、`wx.redirectTo`、`wx.switchTab`、`wx.reLaunch` 等固定路由跳转。
4. 直接 `require` 服务层、页面模块或后端类型。
5. 在组件中登录、授予角色或推断店主权限。

组件允许：

- 使用 `properties` 接收数据。
- 使用 `triggerEvent` 向上派发用户意图。
- 维护纯 UI 状态（展开、选中、滚动位置），不得缓存业务数据副本作为事实来源。
- 使用 `wx.createSelectorQuery` 等无副作用能力。

## 3. 命名与数据类型

- 组件目录：`miniprogram/components/<kebab-case>/index.{js,json,wxml,wxss}`。
- 属性：小写短横线形式，JS 中通过 `properties` 驼峰访问；类型只用 `String`、`Number`、`Boolean`、`Object`、`Array`。
- 事件：小写短横线形式，统一动词：`select`、`change`、`submit`、`retry`、`close`、`add`、`remove`。
- 金额：`priceCents`、`totalCents` 等整数分；组件可格式化为 `¥28.00`，不得参与业务计算。
- 日期：组件接收已格式化的展示字符串；不在组件内解析 ISO 时间。
- 所有属性必须有默认值和类型；缺少数据时展示空状态，不抛异常。

## 4. 核心组件契约

### store-header

| 属性 | 类型 | 说明 |
| --- | --- | --- |
| `storeName` | String | 门店名 |
| `tableName` | String | 桌号，空串表示自取 |
| `businessHours` | String | 营业时间 |
| `mode` | String | `DINE_IN` / `TAKEAWAY` |

事件：无。

### category-nav

| 属性 | 类型 | 说明 |
| --- | --- | --- |
| `categories` | Array | `[{ id, name }]` |
| `activeId` | String | 当前分类 |

事件：`select` → `{ id }`

### product-card

| 属性 | 类型 | 说明 |
| --- | --- | --- |
| `product` | Object | `{ id, name, description, priceCents, imageUrl, available }` |
| `quantity` | Number | 购物车中数量，默认 0 |
| `disabled` | Boolean | 页面判定不可操作 |

事件：
- `add` → `{ productId }`
- `remove` → `{ productId }`
- `open-detail` → `{ productId }`

组件不得自行判断库存或售卖状态，`disabled` 由页面传入。

### product-detail

| 属性 | 类型 | 说明 |
| --- | --- | --- |
| `visible` | Boolean | 是否显示 |
| `product` | Object | 同 product-card |
| `quantity` | Number | 当前数量 |

事件：`close`、`add` → `{ productId }`、`remove` → `{ productId }`。

### cart-panel

| 属性 | 类型 | 说明 |
| --- | --- | --- |
| `items` | Array | `[{ productId, name, unitPriceCents, quantity, lineTotalCents }]` |
| `totalCents` | Number | 页面传入的合计，组件只展示 |
| `totalQuantity` | Number | 件数 |
| `submitting` | Boolean | 提交中禁用 |

事件：
- `add` → `{ productId }`
- `remove` → `{ productId }`
- `checkout` → `{ totalCents, items }`（页面重新计算并校验，不信任组件值）

### fulfillment-switch

| 属性 | 类型 | 说明 |
| --- | --- | --- |
| `value` | String | `DINE_IN` / `TAKEAWAY` |
| `dineInEnabled` | Boolean | 门店是否支持堂食 |
| `takeawayEnabled` | Boolean | 门店是否支持自取 |
| `tableName` | String | 当前桌号，可空 |
| `tableRequired` | Boolean | 提示用 |

事件：`change` → `{ value }`。是否允许缺少桌号由页面/后端判定。

### order-card

| 属性 | 类型 | 说明 |
| --- | --- | --- |
| `order` | Object | 订单展示模型 |
| `role` | String | `CUSTOMER` / `MERCHANT` |
| `actionable` | Boolean | 是否可操作 |

事件：
- `open` → `{ orderId }`
- `pay` → `{ orderId }`
- `accept` → `{ orderId }`
- `advance` → `{ orderId, toStatus }`
- `cancel` → `{ orderId, reason }`

组件不判断状态是否可转换；按钮可用性由页面按状态机传入。

### order-status

| 属性 | 类型 | 说明 |
| --- | --- | --- |
| `status` | String | 六态枚举 |
| `paymentStatus` | String | `UNPAID` / `DEMO_PAID` |
| `compact` | Boolean | 紧凑模式 |

事件：无。文案集中在本组件，供列表和详情复用。

### state-view

| 属性 | 类型 | 说明 |
| --- | --- | --- |
| `state` | String | `loading` / `empty` / `error` |
| `title` | String | 主文案 |
| `description` | String | 辅助说明 |
| `actionText` | String | 按钮文案，空串不显示 |

事件：`retry` → `{}`。仅表示“重试”，不携带路由或请求参数。

## 5. 页面接线示例

```xml
<product-card
  product="{{item}}"
  quantity="{{cart[item.id].quantity}}"
  disabled="{{item.available === false}}"
  bind:add="onAdd"
  bind:remove="onRemove"
/>
```

```js
Page({
  onAdd(event) {
    const { productId } = event.detail;
    this.cartService.add(productId);
  }
});
```

页面负责：读取门店配置、请求菜单、计算购物车、校验桌号、跳转结算、处理错误。组件不得代替页面做这些事。

## 6. 可删除性检查

删除任一组件时必须满足：

- 只在页面 JSON 的 `usingComponents` 和对应 WXML 中出现引用。
- 服务层、`app.json`、其他组件均无引用。
- 删除后其余页面可编译，`app.json` 注册路径不变。
- 不修改 API 契约或数据库结构。

## 7. 验收检查

- 全局搜索组件目录，确认无 `wx.request`、`navigateTo`、`switchTab`、`globalData`。
- 组件事件 detail 只含契约定义字段。
- 所有金额展示来自 `priceCents`/`totalCents`，无组件内价格计算。
- 页面切换门店后组件重新渲染，不保留上一门店数据。
## 8. 模板库中的组件分类（规划）

模板库将可插拔资产分为两类，不能把复杂业务都塞进纯组件：

| 类型 | 允许内容 | API 边界 |
| --- | --- | --- |
| UI Block | 展示组件、properties、events、纯 UI 状态 | 禁止 API |
| Feature Pack | 页面、UI Block、服务层、Manifest 和测试 | 仅页面或服务层 |

例如 `hero-carousel` 是纯 UI Block；优惠券中心是 Feature Pack，因为其还包含页面状态、领取服务和后端契约。组件分类不改变第 1–7 节的通信铁律。

## 9. Manifest 与版本（规划）

每个可组合资产必须提供机器可读 Manifest，声明：

- `id`、`version`、`kind` 和注册表版本；
- Base、最低微信基础库和后端 API 兼容范围；
- 可信入口、允许的插槽、依赖、冲突和容量；
- properties/events Schema、主题 Token 和预览数据；
- `preview-only` / `online-ready` 发布状态和已验证 Recipe。

Agent 只能读取 Manifest 摘要并选择已登记资产，不能通过阅读或生成源码绕过这些约束。

## 10. 页面插槽（规划）

页面拥有稳定的命名插槽，例如 `home.hero`、`home.marketing`。插槽必须声明允许的组件类型、数量和顺序语义。

组件不能假设自己一定位于某个页面；页面不能依赖组件内部私有状态。未分配插槽时，Base 页面仍应完整运行。禁止通过全局 WXSS 选择器或 `globalData` 形成隐式插槽依赖。

## 11. 构建期组合（规划）

CompositionPlan 由确定性 Composer 在构建期解析，生成静态 WXML、页面 JSON、`usingComponents`、`app.json` 和主题 WXSS。

不得运行时根据模型输出任意加载组件路径。组件版本由 Lock 固定；相同 Lock 应生成可复现工程。组件被删除时，其页面引用、服务绑定和资源注册应一并由 Composer 移除，而不是留下手工维护的隐式依赖。

## 12. 发布状态（规划）

- `preview-only`：允许桌面或示例数据预览，不具备真实在线后端能力，不得正式发布为在线功能。
- `online-ready`：后端契约、权限、异常路径和微信编译均已验证，可进入在线 Recipe。
- 候选 Recipe 不等于正式模板；必须经过组合测试、核心链路回归和发布审核。