# M7 门禁汇总

日期：2026-10-31 · 结果：**未通过（未运行）**

## 门禁表

| 检查 | 命令 | 预期 | 实际 |
| --- | --- | --- | --- |
| 注册表登记与冻结 | `npm run registry:check` | base 1 / ui-block 3 / feature-pack 1 / recipe 3 | **未运行**；当前注册表仍是 M5 的 1/0/0/1 |
| 资产 Manifest/预览/实现 | `node --test test/composer-assets.test.cjs` | 全绿 | **未运行** |
| 候选/正式分离 | `node --test test/composer-recipe-stage.test.cjs` | 全绿 | **未运行** |
| 配置 v2 与 preview-only | `node --test test/store-config-v2.test.cjs` | 全绿 | **未运行** |
| 版本守卫 | `node --test test/version-guard.test.cjs` | 全绿 | **未运行** |
| 三份 Recipe 生成 | `node scripts/composer/cli.cjs --plan ...` | 3 个工程 | **未运行** |
| 产物静态校验 | `node scripts/validate-miniprogram.cjs --root <out>` | 0 错 | **未运行** |
| 微信编译（W） | 微信开发者工具人工导入 | 编译成功截图 | **未执行** |
| 真机走查（R） | 微信真机 | 扫码/安全区 | **未执行** |

## 资产计数（目录层面）

- Base：1
- UI Block：3（store-header / product-card / cart-bar）
- Feature Pack：1（poster-carousel）
- Recipe：3（order-classic、order-poster、order-classic-candidate）

## 晋升状态

- 3 份 Recipe 全部 `stage: candidate`；`direct` 为 0。
- 原因：微信编译、核心回归、审核记录均未产生，按 M7-5 红线不得晋升。
- 候选 `order-classic-candidate@0.1.0` 仅作候选/正式分离样本，不在店主可选列表。

## 扩展顺序

- `templates/registry/expansion-order.json` 已登记 `poster-carousel → home-marketing → ad-slot → coupon`。
- `home-marketing`、`ad-slot`、`coupon` **未实现**，未登记资产。
- 顺序门禁代码在 `scripts/registry-check.cjs`，本轮未运行。

## 结论

M7 的资产文件、Recipe、测试与门禁规则已落盘，但**注册表未冻结、测试未运行、微信未编译**，因此不得宣称 M7 完成。