# M7 逐资产证据

日期：2026-10-31 · 等级：L1（未运行验证）

> 每个资产独立记录，不以“整包通过”替代单项证据。

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
| 验证 | 已验证（2026-10-31 验收轮）：`composer-assets` 全绿，注册表门禁通过 |

## product-card@1.0.0

| 项 | 内容 |
| --- | --- |
| Manifest | `templates/components/product-card/1.0.0/manifest.json` |
| 四类预览 | normal / empty / error（缺价）/ long（超长菜名与 99 份） |
| 边界 | 四项 false |
| props | `product/quantity/disabled` |
| events | `openDetail/add/remove` |
| 金额 | 只展示 `priceCents` 派生文本，无 `priceText` |
| 验证 | 已验证（2026-10-31 验收轮）：`composer-assets` 全绿；事件名按契约改为 camelCase `openDetail`（Base 与 miniprogram 镜像同步） |

## cart-bar@1.0.0

| 项 | 内容 |
| --- | --- |
| Manifest | `templates/components/cart-bar/1.0.0/manifest.json` |
| 四类预览 | normal / empty / error（submitting）/ long（999999 分、99 份） |
| 边界 | 四项 false |
| props | `totalCents/totalQuantity/submitting` |
| events | `expand/checkout` |
| 金额 | 只展示 `totalCents` |
| 验证 | 已验证（2026-10-31 验收轮）：`composer-assets` 全绿，注册表门禁通过 |

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
| 验证 | 已验证（2026-10-31 验收轮）：`composer-assets` 全绿；`order-poster` CLI 生成成功（124 文件），产物静态校验 0 错 0 警，首页 `home-hero` 已替换为 `<poster-carousel>`；微信编译未执行 |

> 备注：manifest 的 `entry.path` 指向 `src/components/poster-carousel`，Composer 会把该目录复制为产物 `components/poster-carousel/`。