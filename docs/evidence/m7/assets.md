# M7 逐资产证据

日期：2026-11-03 · 等级：L1 + W

> 每个资产独立记录，不以“整包通过”替代单项证据。
> 2026-11-03 轮补充：注册表重冻结（`direct 2`）、三份工程生成、微信开发者工具编译与渲染验证。

## store-header@1.0.0

| 项 | 内容 |
| --- | --- |
| Manifest | `templates/components/store-header/1.0.0/manifest.json` |
| 四类预览 | `preview/{normal,empty,error,long}.json` |
| 兼容声明 | `baseRange ^1.0.0`、`minWechatLib 3.0.0`、`apiContract storefront.v1` |
| 边界 | 网络/路由/全局状态/服务层 全 false |
| props | `storeName/tableName/businessHours/mode/address/compact` |
| events | 无 |
| 已知限制 | 不含门店实景图；深色渐变底色固定 |
| 验证 | `composer-assets` 全绿；`registry:check` 通过；作为 Base 首页头部出现在 `order-classic`、`poster-solo` 编译产物中（截图 `wechat/order-classic-home.png`、`wechat/poster-solo-home.png`） |
| 编译记录 | 2026-11-03 `cli auto` 成功，页面渲染 13 view / 11 text |

## product-card@1.0.0

| 项 | 内容 |
| --- | --- |
| Manifest | `templates/components/product-card/1.0.0/manifest.json` |
| 四类预览 | normal / empty / error（缺价）/ long（超长菜名与 99 份） |
| 边界 | 四项 false |
| props | `product/quantity/disabled` |
| events | `openDetail/add/remove` |
| 金额 | 只展示 `priceCents` 派生文本，无 `priceText` |
| 验证 | `composer-assets` 全绿；事件名 camelCase `openDetail`（Base 与 `miniprogram` 镜像同步）；删除该可选 Block 后菜单页仍编译通过（`wechat/classic-noblock-menu.png`，3 商品 / 2 分类） |
| 编译记录 | 2026-11-03 `cli auto` 成功；`usingComponents` 无悬空引用 |

## cart-bar@1.0.0

| 项 | 内容 |
| --- | --- |
| Manifest | `templates/components/cart-bar/1.0.0/manifest.json` |
| 四类预览 | normal / empty / error（submitting）/ long（999999 分、99 份） |
| 边界 | 四项 false |
| props | `totalCents/totalQuantity/submitting` |
| events | `expand/checkout` |
| 金额 | 只展示 `totalCents` |
| 验证 | `composer-assets` 全绿；`registry:check` 通过；跟随 `order-classic` / `order-poster` 编译产物进入菜单页 |
| 编译记录 | 2026-11-03 `cli auto` 成功 |

## poster-carousel@1.0.0

| 项 | 内容 |
| --- | --- |
| Manifest | `templates/features/poster-carousel/1.0.0/manifest.json` |
| 四类预览 | normal（3 张）/ empty / error（图片失败 + interval 越界）/ long |
| props | `items/autoplay/interval/showIndicator` |
| events | `select/error` |
| 插槽 | `requiresSlots: ["home-hero"]` |
| 组件 | `src/components/poster-carousel/index.*`，无网络/路由/全局状态/服务层 |
| 素材 | 主题渐变色块，无 PNG；`knownLimits` 已声明 |
| 验证 | `composer-assets` 全绿；`order-poster` 生成 129 文件、静态校验 0 错 0 警；首页 `usingComponents` 由 `store-header` 变为 `poster-carousel`，`slotProps.homeHero` 携带 3 项；微信编译 `cli auto` 成功（截图 `wechat/order-poster-home.png`） |
| 删除验证 | Plan 置 `features: []` 后生成 `poster-solo`：首页无 `poster-carousel`、回落 `store-header`，编译通过（`wechat/poster-solo-home.png`，`homeHero: []`） |

> 备注：manifest 的 `entry.path` 指向 `src/components/poster-carousel`，Composer 会把该目录复制为产物 `components/poster-carousel/`。
> 已知限制：`miniprogram-automator` 不穿透自定义组件标签，`page.$$('poster-carousel')` 返回 0 属工具限制；
> 海报视觉需人工目视截图确认。