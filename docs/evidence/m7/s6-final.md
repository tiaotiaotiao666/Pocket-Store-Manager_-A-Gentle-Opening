# M7 门禁汇总

日期：2026-11-03 · 结果：**通过（L1 + W）；R 未执行**

> 本文件替代 2026-10-31 旧草案（旧版写「注册表未冻结、测试未运行」），旧结论已作废。

## 门禁表

| 检查 | 命令 | 预期 | 实际 | 退出码 |
| --- | --- | --- | --- | --- |
| 注册表登记与冻结 | `npm run registry:check` | base 1 / ui-block 3 / feature-pack 1 / recipe 3 | `2026.11.0`，`direct 2`，摘要/Manifest/入口/预览/边界/晋升证据/扩展顺序全通过 | 0 |
| 重冻结 | `node scripts/registry-check.cjs --write` | 8 个资产摘要更新，版本号不变 | `sha256:7cdfa0b9…`，`registryVersion` 仍 `2026.11.0` | 0 |
| 资产 Manifest/预览/实现 | `node --test test/composer-assets.test.cjs` | 全绿，todo 清零 | 13 项 13 pass / 0 fail / 0 todo | 0 |
| 候选/正式分离 | `node --test test/composer-recipe-stage.test.cjs` | 全绿 | direct 四类证据校验、候选不进列表均通过 | 0 |
| 配置 v2 与 preview-only | `node --test test/store-config-v2.test.cjs` | 全绿 | 通过 | 0 |
| 版本守卫 | `node --test test/version-guard.test.cjs` | 全绿 | 通过 | 0 |
| 模板目录同步 | `node --test test/recipe-catalog-sync.test.cjs` | 全绿 | 通过 | 0 |
| M7 组合门禁 | 上述 5 个测试文件 | 全绿 | **34 项 34 pass / 0 fail / 0 todo** | 0 |
| 三份 Recipe 生成 | `node scripts/composer/cli.cjs --plan … --out …` | 3 个工程 | 125 / 129 / 125 文件，全部成功 | 0 |
| 产物静态校验 | `node scripts/validate-miniprogram.cjs --root …` | 0 错 | 三份均 0 错 0 警 | 0 |
| 可删除性 | `classic-noblock` 对照 | 删 Block 后仍完整 | 125 文件、7 页、静态校验 0 错、编译通过 | 0 |
| 关闭海报 | `poster-solo` 对照 | 首页回落 `store-header` | `homeHero: []`、无 `poster-carousel`、编译通过 | 0 |
| 微信编译（W） | `cli auto --project … --auto-port …` | 编译成功 | 5 份工程 `✔ auto`，渲染 12–13 view | 0 |
| 真机走查（R） | 微信真机 | 扫码/安全区 | **未执行** | — |
| 安装包（L3/L4） | `build:win` | 安装验收 | **未执行**（M5 遗留，非 M7 范围） | — |

## 资产计数（目录层面）

- Base：1
- UI Block：3（store-header / product-card / cart-bar）
- Feature Pack：1（poster-carousel）
- Recipe：3（order-classic、order-poster、order-classic-candidate）

## 晋升状态

- `order-classic@1.0.0`：**direct**
- `order-poster@1.0.0`：**direct**
- `order-classic-candidate@0.1.0`：`candidate`（候选/正式分离样本，不进店主可选列表）
- 店主可选 Recipe 数：**2**

## 扩展顺序

- `templates/registry/expansion-order.json` 已登记 `poster-carousel → home-marketing → ad-slot → coupon`。
- `home-marketing`、`ad-slot`、`coupon` **未实现**，未登记资产，保持 `[ ]`。
- 顺序门禁代码在 `scripts/registry-check.cjs`，本轮实测通过。

## preview-only 机制

- 本轮 3 个资产均为 online-ready，**没有真实 preview-only 资产**。
- 机制由测试构造验证：`store-config-v2` 断言 `onlineReady` 与 `previewOnly` 交集为空、
  README 含「仅预览资产」小节、`capabilities.previewOnly[]` 存在。

## 已知偏差

| 偏差 | 证据 | 处理 |
| --- | --- | --- |
| `Plan.components` 不覆盖 Base 同名组件实现 | `classic-blocks` 与 `classic-noblock` 页面/组件源码逐字节一致；`emit.cjs:654-701` 只从 Base 复制，Feature Pack 才按插槽复制 | 按现状记录，不擅自改已冻结行为；如需覆盖层另立任务 |
| Composer 产物固定 `touristappid` | `emit.cjs:304`；新版工具返回 `APPID_ERROR` | 编译用只读副本替换 AppID，不改验收产物 |
| automator 不穿透自定义组件 | `page.$$('poster-carousel')` 返回 0 | 以 `slotProps` + 产物 WXML + 截图为间接证据，视觉待人工确认 |

## 未执行项

- 真机扫码与安全区（R）：需真实设备。
- 海报轮播视觉人工目视：AI 无法读图。
- Windows 安装包（L3/L4）：M5 遗留。

## 结论

M7 的资产、生成、可删除性、编译与门禁**全部闭环**，两份正式 Recipe 已晋升 `direct`。
仍有 R、安装包与人工视觉三项未执行，不得据此宣称「可直接上架」。