# 小程序模板库：组件入库与模板生成规范

> 更新日期：2026-11-04。
> 适用对象：维护微信原生小程序模板资产的工程师、桌面端 Agent、后端契约维护者，以及后续接手本项目的 AI。
> 本目录是“组件入库”和“从资产组合生成新模板”的唯一规范入口。具体字段以 `templates/registry/schema/` 下的冻结 Schema 和 `scripts/composer/` 的真实实现为准；文档与实现冲突时，先核对代码和测试，再修订文档。

## 1. 这套规范解决什么问题

目标是让 Agent 在不生成业务 JS 的前提下，从版本化资产库中组合或受控生成新的微信原生小程序视图，并交给微信开发者工具做真实渲染验收。

规范的核心不是“让模型自由写页面”，而是：

```text
冻结的 Base
+ 版本化 UI Block / Feature Pack
+ 受控 FrontendPack（只允许 WXML/WXSS/页面 JSON）
+ 机器可读 Manifest
+ 声明式 CompositionPlan
+ 确定性 Composer
+ 真实微信编译与回归证据
```

## 2. 当前基线（2026-11-04）

| 类型 | 数量 | 位置 |
| --- | --- | --- |
| Base | 1 | `templates/base/ordering-base/1.0.0` |
| UI Block | 3 | `templates/components/{store-header,product-card,cart-bar}/1.0.0` |
| Feature Pack | 1 | `templates/features/poster-carousel/1.0.0` |
| FrontendPack | 1 | `templates/frontend-packs/warm-home-menu/1.0.0` |
| Recipe | 4（direct 2） | `templates/recipes/` |
| 注册表 | `2026.11.0` | `templates/registry/registry.v1.json` |

当前正式 Recipe 为 `order-classic@1.0.0`、`order-poster@1.0.0`；`order-classic-candidate@0.1.0` 只作为候选/正式分离的样本；`order-warm-home@1.0.0` 是 FrontendPack 纵向样例，仍为候选。

## 3. 五层资产模型

### 3.1 Base

所有模板共享的稳定运行基线：微信原生工程骨架、主题 Token、服务层、领域层、通用状态组件和页面插槽锚点。

- 源码唯一事实源：`templates/base/ordering-base/1.0.0/src`
- 参考镜像：`miniprogram/`（迁移状态见 `templates/registry/migration.json`）
- Base Manifest：`templates/base/ordering-base/1.0.0/manifest.json`
- 插槽说明：`templates/base/ordering-base/1.0.0/slots.json`（人类可读镜像；当前未列入 `menu-hero`，该插槽以 Base Manifest 为准）

Base 版本变化属于结构性变更，必须走显式的版本升级流程，不应在新增组件时顺手修改。

### 3.2 UI Block

只负责展示的纯组件，通过 `properties` 接收数据、通过 `triggerEvent` 发出用户意图。它不新增页面、不请求 API、不读全局业务状态、不决定路由。

### 3.3 Feature Pack

承载一项业务能力的版本化资产包，可以包含若干纯展示组件，以及声明页面扩展位置的 `pages/<pageId>.extend.json`。网络请求只能存在于页面或服务层，不能出现在组件内部。

### 3.4 FrontendPack

受控视图包。它是 Agent 唯一允许生成 WXML/WXSS/页面 JSON 的资产类型，用于在 Base 之上替换页面视图；页面控制器 `index.js`、服务层和领域逻辑仍来自 Base。FrontendPack 不含任何 JS，也不能新增 Base 未声明的组件。

详见 [`FrontendPack视图包标准与范例.md`](FrontendPack视图包标准与范例.md)。

### 3.5 Recipe

一份经过验证的组合配方，引用 Base、FrontendPack、Feature Pack、UI Block、主题、数据（示例或后端）、API 契约和晋升证据，而不是复制一份独立维护的小程序源码。

## 4. 四条硬规则

1. **视图层可生成，业务 JS 不可生成。** Agent 可以在 FrontendPack 中生成 WXML/WXSS/页面 JSON；页面控制器、服务层、领域逻辑只能复用 Base。不得就地改写 Base、已有 Recipe 或运行时动态加载模型输出的组件。
2. **精确版本 + 冻结摘要。** Plan 中的版本必须是精确 `MAJOR.MINOR.PATCH`；任何资产内容变化后必须重新冻结注册表，否则 Composer 会拒绝生成。
3. **缺能力即拒绝。** 必需组件、控制器动作或后端能力缺失时，生成流程立即失败并返回缺失清单，不允许静默删除需求、降级成“看起来能点”的页面。
4. **预览不等于微信验收。** 桌面或图片概览只证明展示效果；正式 Recipe 必须经过微信开发者工具真实编译与核心链路回归。

## 5. 文档导航

| 我要做什么 | 阅读 |
| --- | --- |
| 新增一个纯展示组件 | [`组件入库标准.md`](组件入库标准.md) §2–§9；[`组件入库范例.md`](组件入库范例.md) §1 |
| 新增一个业务能力包 | [`组件入库标准.md`](组件入库标准.md) §3–§9；[`组件入库范例.md`](组件入库范例.md) §2 |
| 生成一套新的页面视图 | [`FrontendPack视图包标准与范例.md`](FrontendPack视图包标准与范例.md) |
| 从用户需求生成一套新模板 | [`模板生成标准.md`](模板生成标准.md)；[`模板生成范例.md`](模板生成范例.md) |
| 组件入库后如何部署、验证、回滚 | [`组件入库后部署指南.md`](组件入库后部署指南.md) |
| 让 AI 按固定流程执行 | [`wechat-template-builder`](../../.codeartsdoer/skills/wechat-template-builder/SKILL.md) |