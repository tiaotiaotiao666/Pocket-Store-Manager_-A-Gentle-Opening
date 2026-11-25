# C4 人工切片：menu + product-card

本目录是 **人工** 构造的 `frontend-source-bundle.v1` overlay，用于 C4 垂直切片；
**没有调用模型、没有生成图片、没有改正式 `templates/**` 或 `miniprogram/**`**。

## 改动点

- `pages/menu/index.wxml`
  - 根节点增加 `c4-menu` 类；新增顶部推荐 hero（静态文案，不改 data/handler）。
  - 商品列表项增加 `c4-menu__product` 类；保留全部状态、事件、`@slot:menu-hero` / `@slot:menu-aside` 锚点。
- `pages/menu/index.wxss`
  - 新增 hero 渐变卡片、分类导航间距、商品项留白等视觉规则（纯 WXSS）。
- `components/product-card/index.wxml`
  - media 区域新增“人气推荐”徽标；保留 `product`/`quantity`/`disabled` 绑定与 `onOpen/onAdd/onRemove` 事件。
- `components/product-card/index.wxss`
  - 卡片圆角/阴影、图片尺寸、名称字重、徽标样式；不改 properties/observers/triggerEvent。

## 契约

`source-bundle.json` 固定：

- `base`：`ordering-base@1.0.0` + 当前 Base 源树摘要（`sha256:df05a262…`）。
- `targetPage` / `targetPages`：`menu`。
- `files`：上面四个最终完整文件的相对路径 + sha256。
- `components`：`product-card` 为 `page` scope，仅影响 `menu`（Composer 生成 `components/product-card--menu` 变体）。
- `assets`/`deleted`：空（本切片不新增/删除资产）。

## 消费方式

`test/agent-workspace.c4-slice.test.cjs` 将本目录文件经 B1 事务写入 attempt →
B2 `adoptAttempt` 生成版本 → 从版本 `source` 目录加载 overlay → C3 Composer 导出；
不直接复制本目录到正式模板。
