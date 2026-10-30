# 导出模板与配置契约

模板位于 `templates/mini-program/`，生成器将它复制到店主选定目录，再写入 `app.json`、`project.config.json` 和 `config/store.generated.json`。页面采用微信原生 WXML/WXSS/JavaScript，可在微信开发者工具直接导入。

`store.generated.json` 的 `schemaVersion` 当前为 1，主要字段：

- `store`: 门店名称、地址、电话、营业时间和公告。
- `catalog`: 分类及商品；金额用整数分存储，另有展示用 `priceText` 字符串。
- `fulfillmentOptions`: 堂食/自取开关；外送固定关闭。
- `capabilities`: 已配置、由模板提供和待开发的功能 ID。
- `theme`: 风格 ID 与颜色；`icons`: 页面名称及导出图片路径。
- `demoPaymentDisclaimer`: 明确说明演示项目不含真实支付。

生成的数据不能包含凭据。变更 schema 时需同步更新生成脚本、演示配置和导出测试。当前模板仅用于本地预览；订单、登录、店主工作台等线上能力需要另行实现并接入后端。
