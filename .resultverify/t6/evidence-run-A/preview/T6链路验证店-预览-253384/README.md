# T6链路验证店 · 小程序工程

本工程由 Composer 确定性生成，请勿手改生成文件（文件头均带“由 Composer 生成”标记）。

- Plan：`order-classic@1.0.0`
- Base：`ordering-base@1.0.0`
- FrontendPack：`fr-251f19338c2e@1.0.0`（仅覆盖 home 的视图层；页面 JS 仍来自 Base）
- 模式：`development`
- 生成时间：确定性快照（真实导出时间见 `generation-report.json`）

## 导入微信开发者工具

1. 打开微信开发者工具 → 导入项目 → 选择本目录。
2. AppID 使用测试号（工程内为 `touristappid`）。
3. 本地联调时在 `config/store.generated.js` 的 `api.baseUrl` 指向后端，或在开发模式使用默认 `http://127.0.0.1:3000/api/v1`。
4. 生产导出必须使用 HTTPS 地址，否则生成会被拒绝。

## 能力边界

- 演示付款，不产生真实交易；不包含外送、公开店主注册与客户端授权。
- 不包含任何密钥、AppSecret 或内部地址。

本轮不含仅预览资产，全部能力可在线使用。

## 版本提示

未发现可用升级。
