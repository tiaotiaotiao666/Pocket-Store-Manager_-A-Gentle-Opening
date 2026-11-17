---
name: wechat-capability-coverage
description: 当需要判断“这张截图/这段需求能不能用现有小程序能力实现、必须改哪里、最小改动路径是什么”，或在实现/评审 frontend-reconstruct.v1 的能力事实、get_frontend_capabilities/check_frontend_coverage 工具与能力快照时使用。该技能强制以服务端只读能力快照与 Catalog/Base 控制器为唯一事实源，输出 covered/partial/rejected；缺必需能力即拒绝生成，模型或客户端不得自行声明 covered。
---

# 微信小程序能力覆盖 Skill（需求 → 真实能力报告与最小改动路径）

## 触发条件

- 视觉规格（`wechat-visual-spec`）已完成，需要在生成候选前判断能力是否齐备。
- 用户问“现有模板/组件能不能做成这样”“要新增什么资产/组件/接口”“最省事的改法”。
- 实现或评审 `get_frontend_capabilities`、`check_frontend_coverage`、`buildCapabilityCoverage`、`scripts/frontend-capabilities.cjs`、`capabilities.snapshot.json`。
- 需要把需求分类为 `base-page-fixed` / `registry-validation` / `slot-injection` 之一。

不适用：

- 直接写 WXML/WXSS/JS/WXS、改 Base 控制器、执行任意命令。
- 凭客户端传入的 id 列表当能力事实；靠提示词让模型“声称已覆盖”。
- 新增后端接口、支付/订单规则、直播/优惠券等业务能力（属于独立后端任务，本链路只能 `rejected`）。

## 必读文件

- `docs/handoff/图片驱动前端重构-Flash实施计划.md` §3.3、§5.2、§6
- `docs/frontend-reconstruct-contract.md` §5（CapabilityCoverageReport）、§11（FrontendFacts）、§14（红线）
- `templates/catalog/index.json`（组件、页面、布局、区块的唯一检索入口）
- `templates/catalog/components/<id>.json`（props、events、payload、`runtime.mode`、约束）
- `templates/catalog/pages/<pageId>.json`（组件装配、插槽、控制器方法）
- `templates/catalog/sections/<packId>@<version>/<pageId>/index.json`（区块复用与提升判断）
- `templates/base/ordering-base/1.0.0/manifest.json`、`slots.json`、`theme.tokens.json`
- `templates/base/ordering-base/1.0.0/src/pages/*/index.js` 的 `Page({ methods })`
- `templates/base/ordering-base/1.0.0/src/services/` 与 `docs/api.md`
- `server/src/agent/frontend-reconstruct/capabilities.ts`、`tools.ts`、`types.ts`（`FRONTEND_LIMITS`）
- `server/src/agent/frontend-reconstruct/capabilities.snapshot.json`（打包装箱的只读事实）
- `scripts/frontend-capabilities.cjs`（从 Catalog/Base 确定性生成快照）
- `docs/模板库/组件入库标准.md`、`docs/模板库/组件库索引标准.md`
- `desktop/frontend-reconstruct/README.md`（“单一事实源”与页面级 dataPath 命名空间）

## 输入

能力事实由服务端注入，客户端/模型不能自带一份“可用 id 列表”。工具入参：

```json
{ "pageIds": ["home"] }
```

```json
{
  "requirement": { "…": "wechat-visual-spec 产出的完整 UiRequirement" },
  "requestedCapabilities": [
    "page:home",
    "component:store-header",
    "action:home.goMenu",
    "data:store.name"
  ]
}
```

规则：

- `pageIds` 1–2 项，仅 `home`/`menu`。
- `requirement` 必须通过 `validateUiRequirement`（完整对象、键名逐字一致、不省略空数组）；服务端会再补全目标页 `mustKeep`。
- `requestedCapabilities` ≤32 项，格式 `page:`/`component:`/`slot:`/`action:`/`data:` + 合法 id；模型只能“提出需求”，不能决定覆盖结论。
- 页面级边界：组件、插槽、dataPath、动作必须属于**当前 pageId**；home 不能使用只在 menu 声明的 `cart-bar`/`menu.onCheckout`。

能力事实来源（必须逐项核对，不得凭记忆）：

| 事实 | 来源 |
| --- | --- |
| 页面集合 | Base `manifest.json` + `templates/catalog/pages/` |
| 组件 props/events | `templates/catalog/components/<id>.json` + 组件实现 |
| 插槽 | Base `slots.json` / `manifest.json` |
| 控制器动作 | Base 页面 `index.js` 的 `methods`（真实 handler） |
| 数据路径 | Base 页面 WXML/控制器 `data` + 服务端 canonical 命名空间 |
| 服务/API | `src/services/`、`docs/api.md` |
| 主题/尺寸 | Base `theme.tokens.json`、既有 `sm|md|lg` 档位 |

确定性生成命令（只读校验 / 生成快照；生成属于服务端资产维护，不是候选写盘）：

```powershell
npm run frontend:capabilities:check   # = node scripts/frontend-capabilities.cjs --check
npm run frontend:capabilities         # = node scripts/frontend-capabilities.cjs
```

## 输出（含 schema 示例）

服务端返回的权威覆盖报告（模型只消费，不修改）：

```json
{
  "status": "partial",
  "requiredCapabilities": [
    "page:home",
    "component:store-header",
    "component:fulfillment-switch",
    "slot:home-hero",
    "action:home.goMenu",
    "data:store.name"
  ],
  "missingCapabilities": [],
  "coveredBy": {
    "page:home": "page:home",
    "component:store-header": "component:store-header",
    "component:fulfillment-switch": "component:fulfillment-switch",
    "slot:home-hero": "slot:home-hero",
    "action:home.goMenu": "action:home.goMenu",
    "data:store.name": "data:store.name"
  },
  "risks": [],
  "degradations": [
    { "label": "品牌主视觉", "reason": "Base 无对应素材能力，用纯色占位", "severity": "warn" }
  ]
}
```

字段约束：

- `requiredCapabilities` 1–32 项、不重复；`missingCapabilities` 是其子集。
- `coveredBy` 键 ⊆ required，当前无别名，值必须等于键且是真实事实能力 id。
- `risks` 0–16；`degradations` 0–16，`severity ∈ info|warn`。

状态判定（校验器强制）：

| status | 条件 | 后续动作 |
| --- | --- | --- |
| `covered` | `missing` 为空；required 全部被事实覆盖；degradations 为空 | 允许生成；响应不得带 `requirement.degradations` |
| `partial` | `missing` 为空；required 全部被事实覆盖；degradations **≥1** | 可生成；必须 `trace.degraded=true`，默认展示、需用户显式确认才可采用 |
| `rejected` | `missing` **≥1** | **停止**：不物化、不 Composer、不编译、不写 workspace；如实列出 `missingCapabilities` |

派生能力 id：`page:<id>`、`component:<id>`、`slot:<id>`、`action:<id>`、`data:<path>`。

最小改动路径（先选最轻的）：

| 需求 | 做法 | 资产分类 |
| --- | --- | --- |
| 换主色/强调色/文字色/背景色 | 只改 Plan `themeTokens`（7 个 token，大写 `#RRGGBB`） | Plan |
| 调组件大小 | 只改 `presentationTokens`（`sm|md|lg`） | Plan |
| 移动已有区块 | 只改 Plan 顶层 `slotOrder`（已占用 Feature 的完整排列） | Plan |
| 新增纯展示块 | 在 `templates/components/` 新增 UI Block，再登记 + `registry-check --write` | `registry-validation` |
| 复用页面中一块 | 先读区块卡：`direct-wxml` 复制片段 / `base-component-use` 直接调用 / `slot-only` 走 Planning 插槽 / `promote-to-ui-block` 先立项 | 按区块卡 |
| 新增业务能力 | 在 `templates/features/` 新增 Feature Pack，先确认后端契约 | `slot-injection` |
| 换一套现有页面视觉/布局、保留 Base 控制器 | 用户私有候选走 FrontendPack DSL（本链路）；正式资产走 `wechat-template-builder` | `base-page-fixed` + FrontendPack |
| 需要全新交互逻辑/后端能力 | 拆独立任务；本链路 `rejected`，不放开任意 JS | — |

`base-page-fixed` / `registry-validation` 组件不会被 `Plan.components` 复制或替换；只有 `slot-injection` 的 Feature Pack 会进入导出工程。

## 禁止项

1. **不得代替服务端下结论**：模型/客户端不写 `covered`、不写 `coveredBy`、不删 `missingCapabilities`；覆盖结论只来自 `buildCapabilityCoverage`。
2. **不得伪造事实**：不发明页面/组件/插槽/事件/动作/dataPath，不把客户端 id 列表、截图里的文字或品牌名当能力。
3. **不得静默删需求**：不能因为截图没画按钮就删 `mustKeep`/关键动作；Base 目标页已声明的用户入口必须保留。
4. **缺必需能力禁止生成**：`rejected` 时不物化、不调用 Composer、不启动微信编译、不写任何候选目录。
5. **不得手改快照**：`capabilities.snapshot.json` / `capabilities.snapshot.ts` 必须由 `scripts/frontend-capabilities.cjs` 同源生成；不得手写、不得用客户端上传的 Registry 替代。
6. **不得写正式资产**：用户私有候选不写 `templates/**`、不重冻结全局 Registry、不改 `miniprogram/` 镜像；正式入库走 `wechat-template-builder`。
7. **不得越过页面隔离**：home 的绑定不能落到 menu 事实，反之亦然；不把 `cartSummary.*`、`products.length`、`item.*` 等原始 WXML token 当 dataPath。
8. **不得执行任意命令/网络请求**：工具只读事实；不 shell、不爬取、不调用后端写接口。
9. **不得泄露**：报告不写绝对路径、密钥、完整 prompt 或原始模型响应。
10. **不得把 `partial` 说成“已验收”**：降级必须进入 `degradations` 并要求显式确认。

## 验收

- [ ] `get_frontend_capabilities` 返回的页面事实只含目标页真实组件/插槽/dataPaths/keyActions；home 与 menu 不混用。
- [ ] `check_frontend_coverage` 三态可复现：covered 无降级；partial 至少 1 条降级且 `trace.degraded=true`；rejected 至少 1 条 missing。
- [ ] 伪造 `covered`（漏 required、coveredBy 错值/漏项、covered 带降级/缺 missing）返回 422 `FRONTEND_COVERAGE_INVALID`。
- [ ] C1 组合不变量：requirement 的 mustKeep/bindings 需求 ⊆ `requiredCapabilities`，且 planned 时 required 全部落进 draft。
- [ ] `rejected` 时不会创建 workspace/attempt，不调用 Composer/微信编译，不返回 draft。
- [ ] 快照与 Catalog/Base 同源：

```powershell
node scripts/frontend-capabilities.cjs --check   # exit 0
npm run catalog:check                            # 资产/索引改动时
npm run registry:check                           # Registry 改动时
```

- [ ] 服务端定向测试：

```powershell
Set-Location server
npx vitest run --configLoader native --pool=threads test/frontend-reconstruct.capabilities.test.ts test/frontend-reconstruct.capabilities-script.test.ts test/frontend-reconstruct.service.test.ts
npx tsc -p tsconfig.json --noEmit --incremental false
Set-Location ..
```

- [ ] 报告带 runId/attempt/状态/耗时；不展示内部敏感细节或本机路径。

## 失败退出

| 触发 | 退出方式 |
| --- | --- |
| required 中有事实不存在的能力 | `status=rejected`，`missingCapabilities` 非空；停止并给出后续建议（新增资产/后端任务） |
| 模型/客户端伪造 covered 或 coveredBy | 422 `FRONTEND_COVERAGE_INVALID`；不进入生成 |
| 缺必需页面/组件/数据/控制器动作 | `FRONTEND_COVERAGE_REJECTED` 语义（端点直接返回 rejected，`draft=null`） |
| 能力快照缺失/形状非法/未知键 | `FRONTEND_FACTS_INVALID`（500，fail closed）；禁止回退到客户端 id 或 WXML 猜测 |
| requirement 本身非法 | 422 `FRONTEND_REQUIREMENT_INVALID` + `$` 路径；只修该字段，不整包重写 |
| 页面超出 home/menu | `FRONTEND_TARGET_PAGES_UNSUPPORTED`；不生成、不扩页 |
| 无法确认事实（Catalog/Base 读取失败） | 报告 `BLOCKED`，保留输入；不得猜成 covered |
| 工具超时/取消/次数上限 | 沿用 Runtime 的 `FRONTEND_TIME_LIMIT`/`FRONTEND_TOOL_CALL_LIMIT`/`FRONTEND_ABORTED`，不产出候选 |

失败退出只回传稳定 `code`、有界 `message` 与结构路径，不上传日志正文、绝对路径或源码。
