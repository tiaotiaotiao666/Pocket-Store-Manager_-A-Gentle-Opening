# M7 Recipe 证据

日期：2026-11-03 · 等级：L1 + W

## order-classic@1.0.0

- 计划：`templates/recipes/order-classic/1.0.0/plan.json`（7 页、无 Feature、无 components）
- 状态：**`direct`**
- 已知限制：演示付款；无外送与公开店主注册
- 四类证据：`wechatCompile: pass`、`regression: pass`、`secretScan: pass`、`approvals: 1 条（project-owner，2026-11-03T19:49:13+08:00）`
- 产物：125 文件，tree `sha256:b3f550418ae3aea1…`，lock `sha256:8e9911a28efac430…`，7 页 / 14 组件目录
- 静态校验：0 错 0 警
- 微信编译：`cli auto` 成功（9420），渲染 13 view / 11 text，`store.name=柑橘小馆`
- 截图：`wechat/order-classic-home.png`
- 晋升：**已满足**，2026-11-03 晋升 direct

## order-poster@1.0.0

- 计划：`templates/recipes/order-poster/1.0.0/plan.json`
- `features[0]`：`poster-carousel@1.0.0` → `home-hero`，`dataKey homeHero`，3 张海报 props
- 状态：**`direct`**
- 四类证据：`wechatCompile: pass`、`regression: pass`、`secretScan: pass`、`approvals: 1 条（project-owner，2026-11-03T19:49:13+08:00）`
- 产物：129 文件，tree `sha256:60e06faa2789cab1…`，lock `sha256:908225e51586f622…`，7 页 / 15 组件目录
- 实际产物：`pages/home/index.wxml` 的 `home-hero` fallback 替换为 `<poster-carousel ... />`；`usingComponents` 由 `store-header` 变为 `poster-carousel`；`config/slots.generated.js` 的 `homeHero` 含 3 项
- 静态校验：0 错 0 警
- 微信编译：`cli auto` 成功（9421），`slotProps.homeHero` 3 项，13 view / 11 text
- 截图：`wechat/order-poster-home.png`
- 晋升：**已满足**，2026-11-03 晋升 direct

## order-classic-candidate@0.1.0

- 计划：`templates/recipes/order-classic-candidate/0.1.0/plan.json`（深绿主题）
- 状态：`candidate`
- `candidate.json`：记录晋升门槛（编译/回归/扫描/审核）
- 产物：125 文件，tree `sha256:b1c1967b5f909f4f…`，7 页 / 14 组件目录，静态校验 0 错 0 警
- 微信编译：`cli auto` 成功（9424），13 view / 11 text；截图 `wechat/order-classic-candidate-home.png`
- 用途：候选/正式分离样本，**不得进入店主可选列表**

## 统一说明

- `recipe.json.recipe.stage` 与 `release.json.stage` 均只允许 `direct/candidate/expired`。
- `direct` 需要 `wechatCompile=pass`、`regression=pass`、`secretScan=pass`、`approvals.length>0`；
  2026-11-03 轮实测 **direct = 2**（`order-classic`、`order-poster`），`candidate = 1`。
- 编译使用只读副本（`m7wx/`）替换 AppID 为 `wx3b1c04f63cf6cfd0`，原始产物与摘要不受影响。
- 真机扫码与安全区（R）未执行，不得据此宣称「可直接上架」。