# M7 Recipe 证据

日期：2026-10-31 · 等级：L1（未运行验证）

## order-classic@1.0.0

- 计划：`templates/recipes/order-classic/1.0.0/plan.json`（7 页、无 Feature）
- 状态：`candidate`
- 已知限制：演示付款；无外送与公开店主注册
- 四类证据：`wechatCompile: not-run`、`regression: not-run`、`secretScan: pass`、`approvals: []`
- 晋升：**不满足**，保持 candidate

## order-poster@1.0.0

- 计划：`templates/recipes/order-poster/1.0.0/plan.json`
- `features[0]`：`poster-carousel@1.0.0` → `home-hero`，`dataKey homeHero`，3 张海报 props
- 状态：`candidate`
- 预期产物：`pages/home/index.wxml` 的 `home-hero` fallback 替换为 `<poster-carousel ... />`；`usingComponents` 增加 `poster-carousel`；`config/slots.generated.js` 的 `homeHero` 数组含 3 项
- 验证：**未生成工程、未编译**

## order-classic-candidate@0.1.0

- 计划：`templates/recipes/order-classic-candidate/0.1.0/plan.json`（深绿主题）
- 状态：`candidate`
- `candidate.json`：记录晋升门槛（编译/回归/扫描/审核）
- 用途：候选/正式分离样本，**不得进入店主可选列表**

## 统一说明

- `recipe.json.recipe.stage` 与 `release.json.stage` 均只允许 `direct/candidate/expired`。
- `direct` 需要 `wechatCompile=pass`、`regression=pass`、`secretScan=pass`、`approvals.length>0`；本轮 0 个 direct。
- 微信开发者工具人工导入三份工程并编译 **未执行**（CLI 端口关闭，需人工 GUI）。