# 导出模板与配置契约

> 本文区分“当前已实现的门店配置”与“规划中的组合规格”。两者不得混为一份配置，也不得把规划字段当作现有代码能力。

## 1. 当前实现：`store.generated.js` schemaVersion=1

当前模板位于 `templates/mini-program/`。`scripts/generate-mini-program.cjs` 复制模板后写入 `app.json`、`project.config.json` 和 `config/store.generated.js`，页面使用微信原生 WXML/WXSS/JavaScript。

配置文件必须是 `.js` 模块并由 `module.exports` 导出，原因是微信小程序 `require` 只解析 `.js`：`require('./config/store.generated')` 会被补成 `config/store.generated.js`，若磁盘上是 `.json` 会直接抛 `module 'config/store.generated.js' is not defined`，`App()` 不注册、四个页面全部白屏。禁止再把门店配置写成 JSON 文件或让页面 `require` 任何 `.json` 路径。

`store.generated.js` 当前主要字段：

- `store`：门店名称、地址、电话、营业时间和公告。
- `catalog`：分类及商品；`priceCents` 是金额事实，现有 `priceText` 仅是旧版展示副本。
- `fulfillmentOptions`：堂食/自取开关，外送固定关闭。
- `capabilities`：已配置、模板声明和待开发的功能 ID；登记 ID 不等于对应业务模块已经实现。
- `template`、`theme`、`icons`：模板标识、视觉和资源路径。
- `demoPaymentDisclaimer`：说明演示项目不含真实支付。

当前限制：模板为静态展示，营业资料与菜品未完整从 AgentDraft 映射，页面和布局不随功能进行通用组合，配置也未关联后端门店。

变更 v1 时必须同步生成脚本、示例配置和导出测试。后续新版本应以 `priceCents` 为唯一金额事实，在展示层格式化，不再增加第二份金额事实。

## 2. 规划实现：CompositionPlan

CompositionPlan 描述“如何组合工程”，不保存门店运营数据。目标契约为 `composition.v1`，至少包含：

- `schemaVersion`；
- `baseTemplate` 与精确/可解析版本；
- `registryVersion`；
- `features[]`；
- `pages[]`、`layout` 和命名 `slots`；
- 组件版本与可序列化 `props`；
- `themeTokens`；
- 公开 `apiBinding.contractVersion`。

CompositionPlan 只允许注册表中的 ID、版本、插槽和属性，不包含源码、任意路径、脚本或秘密。详细规则见 `docs/模板库与组合生成规划.md`。

## 3. 规划实现：composition.lock.json

Composer 解析 CompositionPlan 后生成 Lock，固定：

- Base、注册表、功能包、组件和 Composer 精确版本；
- 解析后的依赖关系；
- 可信源版本和产物校验信息；
- 生成所需的后端契约版本。

相同 Lock 必须可复现。禁止生成时未经确认自动升级到最新组件。

## 4. 数据职责分离

| 数据 | 责任 | 不得包含 |
| --- | --- | --- |
| 门店配置 | 门店、目录、履约、主题和公开绑定 | 组件源码、密钥 |
| CompositionPlan | 页面、功能、插槽和视觉组合 | 运营订单、秘密、任意代码 |
| Lock | 精确版本和可复现依据 | 用户业务数据、Token |
| 后端业务数据 | 门店、商品、订单和权限事实 | 由前端自行计算的总价 |

B3 需要实现 `store.generated.js.schemaVersion` 到后端配置版本的受控映射。重复导入必须防重，不得覆盖既有运营数据。

## 5. 安全与兼容

生成配置只能包含公开 API Base URL、`storeId`、公开主题和资源信息，严禁写入 AppSecret、数据库密码、模型密钥、支付密钥或用户 Token。

Manifest 必须声明 Base、微信基础库和后端 API 兼容范围。不兼容组合在生成前拒绝，不生成带隐式降级的工程。当前“复制并替换配置”与未来 Composer 是两种实现状态，文档和 UI 不得混称。