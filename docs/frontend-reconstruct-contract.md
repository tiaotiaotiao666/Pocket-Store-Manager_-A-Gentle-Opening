# 图片驱动前端重构契约（frontend-reconstruct.v1）

> 状态：**P0 契约已冻结（2026-11-17）**。本文是唯一权威说明；`server/src/agent/frontend-reconstruct/`
> 下的类型、校验器、错误码与状态机必须与本文一致。
> 基线：`main@e2eb16ac2ce81f1975d8dccfc1a3c36ebda2d126`。
> 端点 `POST /api/v1/agent/frontend-reconstruct` 的 Controller/Service 注册在 **P1**；P0 只冻结
> 请求/响应、UiRequirement/VisualSpec、CapabilityCoverageReport、FrontendPackDraft DSL、
> `FRONTEND_*` 错误码、状态机与 repair 上限，并先红后绿落测试。P0 **没有**修改既有端点、
> 没有新增 npm 依赖、没有写入 `templates/**` 或 `miniprogram/**`。

相关文档：[`agent-turn-contract.md`](agent-turn-contract.md)、[`agent-runtime.md`](agent-runtime.md)、
实施计划 [`handoff/图片驱动前端重构-Flash实施计划.md`](handoff/图片驱动前端重构-Flash实施计划.md)。

---

## 1. 责任边界

| 角色 | 负责 | 不负责 |
| --- | --- | --- |
| 服务端（NestJS `agent` 模块） | 请求校验、视觉理解、需求结构化、能力覆盖判定、受控 DSL 校验、`FRONTEND_*` 错误码 | 不写仓库源码、不执行 shell、不写全局 Registry/模板、不物化候选文件 |
| 模型 | 从一张截图提出 `UiRequirement/VisualSpec` 与 `FrontendPackDraft` JSON DSL | 不决定能力是否覆盖、不产出任意 WXML/WXSS/JS/WXS、不猜隐藏手势/路由/支付/订单规则 |
| 服务端注入事实（`FrontendFacts`） | 提供唯一可信的页面/组件/props/events/slots/action/dataPath/theme token/size key | 不接受客户端或模型自行声明的 id 集合 |
| 桌面主进程（P2+） | 私有 workspace、Registry overlay、物化、Composer dry-run、真实微信验证、采用/撤销/持久化 | 不把模型文本当源码执行；不把私有候选写进正式资产 |

**硬规则**

1. 模型永远不是可信执行者：它只能产出本文允许的有界 JSON DSL，本地代码负责目录事实、路径约束、
   schema、WXML/WXSS/JSON 校验、Composer、编译与最终状态。
2. 单张参考图 + 可选文字是唯一输入；不接生图模型、不配置 `IMAGE_PROVIDER_*`。
3. 只允许 `home`/`menu` 两页；扩到其余 Base 页必须补页面卡、布局卡与运行时测试，并按新契约版本处理。
4. 页面 JS/业务/门店菜品不能被模型改写；候选 FrontendPack 只允许 WXML/WXSS/JSON 变化。
5. 日志、响应、持久化快照、fixture 不包含 API Key、base64 图片正文、完整 prompt、原始模型响应。
6. `partial`（微信运行时验证未完成）**不等于**验收通过；只有静态门禁全绿且运行时验证成功才是
   `ready`，采用 `partial` 必须显式确认。

---

## 2. 端点

```http
POST /api/v1/agent/frontend-reconstruct
Content-Type: application/json; charset=utf-8
Accept: application/json
Authorization: Bearer <宿主注入的短期 Token；development/test 且 AGENT_REQUIRE_AUTH=false 时可省略>
```

- 复用既有 `AgentAuthGuard`、requestId、统一异常过滤与既有图片大小限制；
- 成功返回 **200**；契约/请求错误 400/422，状态冲突 409，上游/内部 502/500；
- 错误体统一为 `{ code, message, requestId }`，同时写响应头 `X-Request-Id`；
- 请求体（JSON 文本）按 **UTF-8 字节**计上限 **2 MiB**；单图解码上限 **409600** 字节（沿用既有图片校验常量）；
- 服务端不信任客户端传入的 Registry/Catalog/Plan/能力 id；模型也不接收任何秘密。

> P0 阶段该路由尚未注册；`parseFrontendReconstructRequest` 等纯函数已可被 P1 的 Controller
> 直接复用。P0 不改变 `/agent/turn`、`/agent/run`、`/agent/template-revise` 等既有端点行为。

---

## 3. 请求

### 3.1 请求体字段

| 字段 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `contractVersion` | string | 是 | 固定 `"frontend-reconstruct.v1"`，否则 `FRONTEND_CONTRACT_MISMATCH` |
| `requestId` | string | 是 | `^fr-[A-Za-z0-9][A-Za-z0-9._-]{0,60}$` |
| `utterance` | string | 否 | 可省略/空串（只发图）；trim 后 ≤500 码点；禁止控制字符；超长/控制字符报 `FRONTEND_UTTERANCE_INVALID` |
| `images` | array | 是 | **恰好 1 项**，且 `kind` 必须为 `"reference"`；见 3.2 |
| `targetPages` | string[] | 是 | 1–2 项、不重复，取值仅 `"home"` / `"menu"`；不支持的页报 `FRONTEND_TARGET_PAGES_UNSUPPORTED` |
| `current.baseTemplate` | object | 是 | 严格 `{ id: "ordering-base", version: "<semver>" }` |
| `current.frontendPack` | object \| null | 是 | `null` 或严格 `{ id, version }`；`id` 为 `^[a-z][a-z0-9-]{1,63}$` |
| `current.presentationPatch` | object | 是 | 既有 presentation patch 原样透传；JSON 深度 ≤8、序列化 ≤16 KiB；本契约不解释其语义 |
| `client.surface` | string | 是 | 固定 `"desktop"` |
| `client.phase` | string | 是 | `"template-pick"` \| `"frontend-reconstruct"` |
| `projectId` | string \| null | 是 | `null` 或 `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` |

**严格未知键拒绝**：顶层、`current`、`current.baseTemplate`、`current.frontendPack`、
`client`、每个图片元素都只允许上表/下节列出的键；任何额外键（如 `script`、`registry`、
`bytes`、`data`）整包拒绝，报 `FRONTEND_REQUEST_INVALID`。图片只认 `dataBase64`，不接受
`agent-turn.v2` 的 `data` 别名。

### 3.2 图片规则

| 项 | 规则 | 错误码 |
| --- | --- | --- |
| 张数 | 必须且只能 1 张 | 缺失 `FRONTEND_IMAGE_REQUIRED`；多张 `FRONTEND_IMAGE_COUNT_INVALID` |
| kind | 只允许 `reference` | 其它 `kind`（含 `menu`/`store`/混发）`FRONTEND_IMAGE_KIND_INVALID` |
| mediaType | `image/jpeg` / `image/png` / `image/webp` | `FRONTEND_IMAGE_TYPE_UNSUPPORTED`（422） |
| base64 | 仅标准字符表，长度 4 的倍数，0–2 个尾部 `=` | `FRONTEND_IMAGE_INVALID`（422） |
| 文件头 | 解码后必须与声明 mediaType 的 magic 一致（PNG/JPEG/WebP） | `FRONTEND_IMAGE_INVALID`（422） |
| 单图体积 | 解码后 ≤ 409600 字节（绝不信任客户端声明） | `FRONTEND_IMAGE_TOO_LARGE`（422） |
| 错误详情 | 只带结构路径（如 `$.images[0].mediaType`），不回填 base64/正文 | — |

服务端复用 `agent-image.validator.ts` 的字节级规则，并把 `AGENT_IMAGE_*` 映射为稳定的
`FRONTEND_IMAGE_*`；映射表在 `schema.ts` 中集中维护。图片 fixture 只有 70 字节（PNG）与
160 字节（JPEG），见 `test/fixtures/frontend-reconstruct/`。

### 3.3 请求示例

```json
{
  "contractVersion": "frontend-reconstruct.v1",
  "requestId": "fr-0001",
  "utterance": "按截图重构首页，保留下单，整体更紧凑",
  "images": [
    { "kind": "reference", "mediaType": "image/png", "dataBase64": "<单张参考图 base64>" }
  ],
  "targetPages": ["home"],
  "current": {
    "baseTemplate": { "id": "ordering-base", "version": "1.0.0" },
    "frontendPack": null,
    "presentationPatch": {}
  },
  "client": { "surface": "desktop", "phase": "template-pick" },
  "projectId": null
}
```

### 3.4 校验顺序（稳定、可测试）

1. JSON 对象与 2 MiB（UTF-8 字节）体积；2. 顶层未知键；3. `contractVersion`；4. `requestId`；
5. `images`；6. `utterance`；7. `targetPages`；8. `current`；9. `client`；10. `projectId`。

解析结果只保留服务端需要的字段（`ParsedFrontendReconstructRequest`），不保留原始请求对象；
图片只保留 `mediaType/dataBase64/bytes`。

---

## 4. UiRequirement 与 VisualSpec

`UiRequirement` 是“截图看到了什么、哪些必须保留、哪些不确定”的结构化事实；`VisualSpec`
是其中的视觉子集。所有字符串都是纯文本：禁止控制字符、`<`/`>`、`{{`/`}}`、`javascript:`/
`vbscript:`/`data:`、`http(s)://`、反斜杠、`..` 与绝对路径前缀 `/`。违反一律
`FRONTEND_REQUIREMENT_INVALID`（422），错误详情只带结构路径。

### 4.1 字段

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| `summary` | string | 1–240 字符 |
| `mustKeep` | array | 1–32 项；`{ kind: "page"\|"action"\|"data", ref }`；`ref` 必须以 `kind:` 开头且命中注入事实；不得重复 |
| `pages` | array | 0–2 项；`pageId` 仅 `home`/`menu` 且必须在 `targetPages` 与事实内、不重复；`order` 递增；`layout` ∈ `single-column\|two-column\|grid\|list\|poster`；`targetSize.width` 320–1024、`height` 320–4096 |
| `pages[].regions` | array | 0–32 个节点/页；见 4.2 |
| `visual.theme` | object | 键仅七类 Base 颜色 token：`pageBackground/primaryColor/accentColor/textColor/tabBarBackground/tabBarColor/tabBarSelectedColor`；**且必须是当前注入事实 `themeTokens` 声明的子集**；值 `#RRGGBB`，输出统一大写 |
| `visual.sizes` | object | 键仅事实 `sizeKeys`（`homeHero/productCard/carousel`）；值 `sm\|md\|lg` |
| `visual.density` | string | 可省略；`compact\|comfortable`，缺省归一为 `comfortable` |
| `bindings` | array | 0–64 项；`regionId` 必须存在于本需求；`status=bound` 时**恰好一个** `dataPath` 或 `eventName`，且必须命中事实；`status=unknown` 时两者都不能有 |
| `unknownRegions` | array | 0–24 项；`{ regionId?, label, reason }`；`regionId` 若给出必须存在 |
| `lowConfidence` | array | 0–24 项；`{ regionId, confidence(0–1), reason }`；`regionId` 必须存在 |
| `inferredInteractions` | array | 0–16 项；`{ regionId, label, reason }`；只描述可观察交互。禁止出现 facts 里任何动作名，也禁止 `action:` / `page:` / `route:` / `/pages/` 前缀或路由路径 |
| `unsupported` | array | 0–16 项；`{ capability?, label, reason }`；`capability` 若给出必须是真实事实 id |
| `degradations` | array | 0–16 项；`{ regionId?, label, reason, severity: info\|warn }`；`regionId` 若给出必须存在 |

### 4.2 分区（RegionNode）

| 字段 | 约束 |
| --- | --- |
| `id` | `^[a-z][a-z0-9-]{0,31}$`，同一需求内全局唯一（含 children） |
| `type` | `header/hero/nav/list/grid/card/form/banner/footer/other` |
| `order` | 0–999；同一父级下严格递增（不允许靠重复 order 制造不确定顺序） |
| `rect` | 可选；`{x,y,w,h}` 全部 0–1 有限数，且 `x+w ≤ 1+1e-6`、`y+h ≤ 1+1e-6`；**只允许归一化坐标** |
| `children` | 0–12；嵌套深度 ≤3（根为 0）；超过报 `FRONTEND_REQUIREMENT_INVALID` |
| `confidence` | 0–1 |

`mustKeep` 语义：契约层强制“每个 `targetPages` 的 `page:<id>` 必须出现在 mustKeep”；P1 服务端
在此基础上从 Base 目标页补全已声明的关键动作/数据，**不能因为截图没画按钮就静默删功能**。
P1 硬化后还有 C1 组合不变量：`planned` 响应的每条 `mustKeep.ref` 与
`coverage.requiredCapabilities` 都必须真的出现在 draft 使用的能力集合里（见 7.1）。
任何 `mustKeep.ref` 不是真实事实都直接拒绝。

### 4.3 示例（节选）

```json
{
  "summary": "首页改为紧凑单列，保留开始点餐与门店名",
  "mustKeep": [
    { "kind": "page", "ref": "page:home" },
    { "kind": "action", "ref": "action:home.goMenu" },
    { "kind": "data", "ref": "data:store.name" }
  ],
  "pages": [{
    "pageId": "home",
    "order": 1,
    "layout": "single-column",
    "targetSize": { "width": 375, "height": 812 },
    "regions": [{
      "id": "r-header",
      "type": "header",
      "order": 1,
      "rect": { "x": 0, "y": 0, "w": 1, "h": 0.18 },
      "children": [{
        "id": "r-logo", "type": "other", "order": 1,
        "rect": { "x": 0.04, "y": 0.02, "w": 0.3, "h": 0.08 },
        "children": [], "confidence": 0.9
      }],
      "confidence": 0.92
    }]
  }],
  "visual": {
    "theme": { "primaryColor": "#B34A0F", "pageBackground": "#F7F3EC" },
    "sizes": { "homeHero": "lg", "productCard": "md" },
    "density": "compact"
  },
  "bindings": [
    { "regionId": "r-header", "dataPath": "store.name", "status": "bound" },
    { "regionId": "r-header", "status": "unknown" }
  ],
  "unknownRegions": [{ "label": "顶部右侧图标", "reason": "图形含义无法确定，未绑定任何动作" }],
  "lowConfidence": [{ "regionId": "r-header", "confidence": 0.7, "reason": "图标分辨率不足" }],
  "inferredInteractions": [{ "regionId": "r-header", "label": "点击门店名", "reason": "可见但未推定路由" }],
  "unsupported": [{ "label": "直播入口", "reason": "Base 没有对应页面与控制器动作" }],
  "degradations": [{ "regionId": "r-header", "label": "品牌图", "reason": "使用纯色占位", "severity": "warn" }]
}
```

### 4.4 禁止从截图推断

- 隐藏手势、扫码/支付/订单状态规则、网络请求、路由跳转、权限、后台能力；
- 把图中文字、品牌名、图片当业务数据或资产；
- 用任意文本冒充组件/事件/数据绑定。没有依据就进 `unknownRegions`/`lowConfidence`/
  `unsupported`/`degradations`，而不是编造。

---

## 5. CapabilityCoverageReport

覆盖结论**只能由服务端根据注入事实计算**，模型提出的 required 必须逐项落到事实。

| 字段 | 约束 |
| --- | --- |
| `status` | `covered` \| `partial` \| `rejected` |
| `requiredCapabilities` | 1–32 项、不重复；格式 `page:`/`component:`/`slot:`/`action:`/`data:` + id（`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`） |
| `missingCapabilities` | 0–32 项、不重复，必须是 required 的子集 |
| `coveredBy` | 键 ⊆ required；当前无别名，值必须**等于键**且是真实事实能力 id |
| `risks` | 0–16 项；`{ capability ∈ required, reason }` |
| `degradations` | 0–16 项；`{ label, reason, severity: info\|warn }` |

**状态判定（校验器强制）**

| status | 条件 | 结果 |
| --- | --- | --- |
| `covered` | missing 为空；required 全部在 coveredBy 且由事实覆盖；degradations 为空 | 允许生成；**响应级不得带 `requirement.degradations`（C2）** |
| `partial` | missing 为空；required 全部被事实覆盖；degradations **至少 1 项** | 可生成，但默认展示、不自动采用；响应必须 `trace.degraded=true` |
| `rejected` | missing **至少 1 项** | 不生成、不物化、不 Composer、不编译 |

模型不能伪造 covered：`coveredBy` 缺失、值不是事实、值不是同 id、required 缺事实、covered
却带 missing/降级项，全部报 `FRONTEND_COVERAGE_INVALID`（422）。因缺必需能力而拒绝时使用
`FRONTEND_COVERAGE_REJECTED`（422）语义（P1 端点直接返回 `status="rejected"` 响应，
`draft=null`）。

**C2 联动（P1 硬化）**：只要 `requirement.degradations` 非空，响应 `coverage.status` 必须是
`partial`、`coverage.degradations` 非空且 `trace.degraded=true`；`covered` 不得携带任何降级；
`partial` 但 `trace.degraded=false` 直接拒绝（`FRONTEND_RESPONSE_INVALID`，502）。桌面端据此
要求用户二次确认，状态机 `partial → adopted` 仍必须 `explicitPartialConfirmation: true`。

示例（rejected）：

```json
{
  "status": "rejected",
  "requiredCapabilities": ["page:checkout", "component:live-stream", "action:home.startLive"],
  "missingCapabilities": ["component:live-stream", "action:home.startLive"],
  "coveredBy": {},
  "risks": [
    { "capability": "component:live-stream", "reason": "Base 没有直播组件" }
  ],
  "degradations": []
}
```

---

## 6. FrontendPackDraft（受控 JSON DSL）

模型**不允许直接写 WXML/WXSS/JS/WXS**。首期只接受下列 DSL，由确定性 renderer（P2）转成
FrontendPack 文件并补 slot fallback 锚点。

### 6.1 顶层

| 字段 | 约束 |
| --- | --- |
| `schemaVersion` | 固定 `"frontend-pack-draft.v1"` |
| `displayName` | 1–40 字符纯文本 |
| `pages` | 1–2 项；`pageId` 仅 `home`/`menu`、不重复、必须在事实页内 |
| `pages[].nodes` | 1–48 个节点/页（含 children）；嵌套深度 ≤4 |
| `pages[].styles` | **必须为空数组**（CSS 由本地 renderer 输出，不接受样式表/原文） |
| `pages[].pageJson` | 只允许 6.4 的白名单键 |

节点由服务端/renderer 生成 id；草稿里出现 `id` 视为未知字段并拒绝。

### 6.2 节点

| type | 允许键 | 规则 |
| --- | --- | --- |
| `component` | `type, componentId, props, events` | `componentId` 必须是真实组件；`props` ≤8 项且每个 prop 名命中组件白名单；`events` ≤8 项，事件名命中组件白名单，值必须是真实控制器 action |
| `slot` | `type, slotId` | `slotId` 必须是真实插槽；renderer 负责 fallback 锚点，缺锚点由 P2 门禁报 `SLOT_ANCHOR_MISSING` |
| `container` | `type, style?, children` | `children` 1–12 个节点；`style` 只允许 6.3 布局白名单 |
| `text` | `type, textToken, style?` | `textToken` 必须是真实 dataPath；不接受任意 WXML 表达式或字面量 |
| `button` | `type, label, action, style?` | `label` 1–16 字符纯文本；`action` 必须是真实控制器动作 |

`props` 的每个值必须是显式绑定对象：

```json
{ "kind": "data", "dataPath": "store.name" }
{ "kind": "literal", "value": "A1" }
```

- `data`：`dataPath` 必须命中事实 `dataPaths`；
- `literal`：只允许 string/number/boolean/null；字符串 ≤120 字符且必须通过纯文本检查；
- 未知 `kind`、额外键、对象/数组值一律拒绝。

### 6.3 样式白名单

`container.style`：`direction(row|column)`、`align(start|center|end|stretch)`、
`justify(start|center|end|between|around)`、`gap(none|xs|sm|md|lg|xl)`、
`padding(none|xs|sm|md|lg|xl)`、`radius(none|sm|md|lg|full)`、
`width(auto|full|40–750 整数)`、`minHeight(0–2000 整数)`、
`backgroundColorToken`/`borderColorToken`（必须是事实 theme token）。显式给出时不得为空对象。

`text.style` / `button.style`：`size(sm|md|lg)`、`weight(400|500|600|700)`、
`colorToken`（事实 theme token）；显式给出时不得为空对象。

**禁止**：任意 CSS 文本、未知样式键、px/rem 自由值、渐变/定位/动画等无法确定性输出的属性。

### 6.4 pageJson 白名单

| 键 | 值 |
| --- | --- |
| `navigationBarTitleText` | 1–20 字符纯文本 |
| `navigationBarBackgroundColor` | `#RRGGBB`（归一化大写） |
| `navigationBarTextStyle` | `black` \| `white` |
| `backgroundColor` | `#RRGGBB` |
| `enablePullDownRefresh` | boolean |

`usingComponents`、`navigationStyle`、任意页面配置扩展都不允许。

### 6.5 示例

```json
{
  "schemaVersion": "frontend-pack-draft.v1",
  "displayName": "参考图首页候选",
  "pages": [{
    "pageId": "home",
    "nodes": [
      {
        "type": "component",
        "componentId": "store-header",
        "props": { "storeName": { "kind": "data", "dataPath": "store.name" } },
        "events": {}
      },
      { "type": "slot", "slotId": "home-hero" },
      {
        "type": "container",
        "style": { "direction": "column", "gap": "md", "padding": "md" },
        "children": [
          {
            "type": "text",
            "textToken": "store.businessHours",
            "style": { "size": "md", "weight": 600, "colorToken": "textColor" }
          },
          {
            "type": "button",
            "label": "开始点餐",
            "action": "home.goMenu",
            "style": { "size": "lg", "weight": 600, "colorToken": "primaryColor" }
          }
        ]
      },
      {
        "type": "component",
        "componentId": "cart-bar",
        "props": {
          "count": { "kind": "data", "dataPath": "cart.count" },
          "totalCents": { "kind": "data", "dataPath": "cart.totalCents" }
        },
        "events": { "checkout": "menu.onCheckout" }
      }
    ],
    "styles": [],
    "pageJson": {
      "navigationBarTitleText": "扫码点餐",
      "navigationBarTextStyle": "white",
      "backgroundColor": "#F7F3EC"
    }
  }]
}
```

### 6.6 明确禁止

- 任何 HTML/WXML/WXSS/JS/WXS 原文、`<script>`、事件属性、动态组件、`import`；
- 外部 URL、`data:`/`javascript:` scheme、绝对路径、反斜杠、`..`；
- 未知 node type / component / slot / event / dataPath / action / prop；
- 客户端或模型自造 id、`usingComponents`、任意 props、任意样式表；
- 超过节点数/深度/文本长度/列表长度上限的“大输出”。

---

## 7. 响应

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| `contractVersion` | string | 固定 `"frontend-reconstruct.v1"` |
| `runId` | string | `^frun-[A-Za-z0-9][A-Za-z0-9._-]{0,60}$` |
| `status` | string | `planned` \| `needs-input` \| `rejected` |
| `requirement` | `UiRequirement` | 见第 4 节 |
| `coverage` | `CapabilityCoverageReport` | 见第 5 节 |
| `draft` | `FrontendPackDraft \| null` | **仅 `planned` 非空** |
| `questions` | array | 0–8 项；`{ field(^[a-z][A-Za-z0-9.]{0,63}$), label, text }`，label ≤64、text ≤200 |
| `trace.modelCalls` | integer | 0–8 |
| `trace.toolCalls` | array | 0–16 项；`{ name ∈ 四工具, ok:boolean }` |
| `trace.stopReason` | string | `final_answer/needs_input/rejected/max_model_calls/max_tool_calls/loop_detected/time_limit/aborted` |
| `trace.degraded` | boolean | 是否发生降级；`coverage.status=partial` 时必须为 true（C2） |
| `meta.provider` | string | `^[a-z][a-z0-9-]{0,39}$` |
| `meta.model` | string \| null | `mock=false` 时必须为实际模型名（不得 null）；`mock=true` 可为 null |
| `meta.mock` | boolean | 真实模型调用固定 false |
| `meta.latencyMs` | integer | 0–120000 |

**status 语义与强制规则**

| status | 规则 |
| --- | --- |
| `planned` | `draft` 非空；`requirement.pages` ≥1；`coverage.status` ∈ covered/partial；draft 页集合必须与 requirement 页集合一致；`questions` 为空；必须通过 C1 组合不变量；partial 必须 `trace.degraded=true` |
| `needs-input` | `draft` 必须 null；`questions` 至少 1 项（具体问题，不得空泛） |
| `rejected` | `draft` 必须 null；`coverage.status` 必须 `rejected` 且 missingCapabilities 非空；不返回草稿 |

### 7.1 组合不变量（C1/C2）与 502/422 分层

> 命名说明：本节 “C1/C2” 是 P0 复核（t3）提出的两个组合不变量；与“C1 控制字符”
> （Unicode U+0080–U+009F）无关。C0/C1 控制字符在请求、Requirement、Draft、响应文本中一律拒绝。

**C1：requirement 需求 ⊆ coverage.requiredCapabilities，且 coverage.required 全部落 draft。**
`planned` 响应先由服务端从 requirement 重算必需集合：`mustKeep` + 每个 `page:` + `bindings`
的 `dataPath`/`eventName`（`data:`/`action:`）。`coverage.requiredCapabilities` 必须是该集合的
**超集**；`coverage.status=rejected` 时允许把未具备项如实列在 `missingCapabilities`。随后
`coverage.requiredCapabilities` 每一项都必须真的被 draft 使用，`mustKeep` 也必须落 draft。
典型负例：coverage 删掉 mustKeep 的 `action:home.goMenu`/`data:store.name`，或漏掉
requirement binding 的 `data:menu.products`；或 draft 删掉“开始点餐”按钮。违反时报
`FRONTEND_RESPONSE_INVALID`（502，`details.path="$.coverage.requiredCapabilities"` 或
`"$.draft"`），绝不能因为字段各自合法就发 `planned/covered`。

响应入口的 `targetPages` 是 C1 必需的交叉校验上下文：`validateFrontendReconstructResponse`
在缺省/空数组时 **fail closed**（`FRONTEND_RESPONSE_INVALID`，502），不允许跳过 pages/mustKeep
与 coverage/draft 的一致性检查。

**C2：降级必须联动 partial + degraded。**
`coverage.status=covered` 时不得携带 `coverage.degradations` 或 `requirement.degradations`；
存在任一降级时 coverage 只能是 `partial`，且 `trace.degraded=true`。`partial` 但未标记
degraded 视为组合不合约。该标记是桌面端“不自动采用、需显式确认”的契约信号，状态机
`partial → adopted` 仍强制显式确认。

**错误码分层（不要混淆 422 与 502）**

| 情况 | 错误码 | HTTP |
| --- | --- | --- |
| 响应顶层形状（未知键、缺字段、`status` 组合非法） | `FRONTEND_RESPONSE_INVALID` | 502 |
| C1/C2 组合不合约（requirement 需求未进 coverage.required、coverage/draft 脱节、covered+降级、partial 未 degraded、targetPages 缺省） | `FRONTEND_RESPONSE_INVALID` | 502 |
| 嵌套 `requirement` 单字段非法 | `FRONTEND_REQUIREMENT_INVALID` | 422 |
| 嵌套 `coverage` 单字段非法 / 伪造 covered | `FRONTEND_COVERAGE_INVALID` | 422 |
| 嵌套 `draft` 单字段非法 | `FRONTEND_DRAFT_INVALID` | 422 |

也就是说：单个嵌套字段的错误保持其 422 稳定错误码；只有“各自字段合法、组合起来不合约”才
升级为 502 `FRONTEND_RESPONSE_INVALID`。trace 只记录调用元数据，不含源码正文、prompt、图片。

示例（planned 概要）：

```json
{
  "contractVersion": "frontend-reconstruct.v1",
  "runId": "frun-0001",
  "status": "planned",
  "requirement": { "...": "见第 4 节" },
  "coverage": { "...": "见第 5 节" },
  "draft": { "...": "见第 6 节" },
  "questions": [],
  "trace": {
    "modelCalls": 2,
    "toolCalls": [
      { "name": "get_frontend_capabilities", "ok": true },
      { "name": "propose_frontend_draft", "ok": true }
    ],
    "stopReason": "final_answer",
    "degraded": false
  },
  "meta": { "provider": "deepseek", "model": "deepseek-chat", "mock": false, "latencyMs": 1200 }
}
```

---

## 8. FRONTEND_* 错误码

错误码是稳定事实；文案固定、不回填正文。`retryable` 只描述“同一请求重试是否可能成功”，
不触发自动重试。

| code | HTTP | retryable | 触发 |
| --- | ---: | --- | --- |
| `FRONTEND_REQUEST_INVALID` | 400 | 否 | 请求不是对象、体积超限、未知键、字段类型/格式错误、projectId/client 非法 |
| `FRONTEND_CONTRACT_MISMATCH` | 400 | 否 | `contractVersion` 不是 `frontend-reconstruct.v1` |
| `FRONTEND_UTTERANCE_INVALID` | 400 | 否 | utterance 超长或含控制字符 |
| `FRONTEND_IMAGE_REQUIRED` | 400 | 否 | 缺少参考图 / images 为空 |
| `FRONTEND_IMAGE_COUNT_INVALID` | 400 | 否 | 参考图不是恰好 1 张 |
| `FRONTEND_IMAGE_KIND_INVALID` | 400 | 否 | kind 不是 `reference`（含混发） |
| `FRONTEND_IMAGE_TYPE_UNSUPPORTED` | 422 | 否 | mediaType 不是 JPEG/PNG/WebP |
| `FRONTEND_IMAGE_INVALID` | 422 | 否 | base64 非法、文件头与 mediaType 不符 |
| `FRONTEND_IMAGE_TOO_LARGE` | 422 | 否 | 解码后单图超 409600 字节 |
| `FRONTEND_TARGET_PAGES_UNSUPPORTED` | 422 | 否 | targetPages 出现 home/menu 之外的页 |
| `FRONTEND_REQUIREMENT_INVALID` | 422 | 否 | UiRequirement/VisualSpec 结构、范围、文本或事实引用非法 |
| `FRONTEND_COVERAGE_INVALID` | 422 | 否 | 覆盖报告与事实不一致 / 伪造 covered / partial 无降级 |
| `FRONTEND_COVERAGE_REJECTED` | 422 | 否 | 缺必需页面/组件/数据/控制器动作，不能生成 |
| `FRONTEND_DRAFT_INVALID` | 422 | 否 | DSL 非法：未知节点/组件/事件/样式/原文/越界 |
| `FRONTEND_RESPONSE_INVALID` | 502 | 否 | 响应顶层形状非法，或 C1/C2 组合不合约（嵌套单字段错误仍报对应 422） |
| `FRONTEND_STATE_TRANSITION_INVALID` | 409 | 否 | 非法状态迁移 / 未走 repair、retry、adopt 专用入口 |
| `FRONTEND_REPAIR_ISSUES_INVALID` | 422 | 否 | repair 不是有界结构化 issues（path+code） |
| `FRONTEND_REPAIR_LIMIT_EXCEEDED` | 409 | 否 | 本 run 已修复 2 轮 |
| `FRONTEND_FACTS_INVALID` | 500 | 否 | 服务端注入能力事实快照非法（fail closed） |
| `FRONTEND_ABORTED` | 499 | 否 | 运行被取消 |
| `FRONTEND_TIME_LIMIT` | 504 | 是 | 超过 120 秒（或配置上限） |
| `FRONTEND_MODEL_CALL_LIMIT` | 429 | 否 | 模型调用超过 8 次 |
| `FRONTEND_TOOL_CALL_LIMIT` | 429 | 否 | 工具调用超过 16 次 |
| `FRONTEND_MODEL_RESPONSE_INVALID` | 502 | 是 | 模型返回非合法完整 JSON（截断 JSON 不得解析） |
| `FRONTEND_INTERNAL_ERROR` | 500 | 否 | 未预期内部错误 |

实现位置：`server/src/agent/frontend-reconstruct/errors.ts`。`FrontendReconstructError`
携带 `code/httpStatus/retryable/details?`，`toHttpException()` 只输出 `{code,message}`。

---

## 9. 状态机与 repair 上限

```text
idle → analyzing → planning → [awaiting-capability-confirmation?] → generating
     → validating → verifying-runtime → ready | partial
ready → adopted；partial →（显式确认）adopted
rejected / cancelled 为终态；failed 可用新 runId 显式重试
adopted 可显式撤销回 idle（恢复采用前版本）
```

### 9.1 合法迁移表

| from | 允许到 |
| --- | --- |
| `idle` | `analyzing` |
| `analyzing` | `planning`, `rejected`, `failed`, `cancelled` |
| `planning` | `awaiting-capability-confirmation`, `generating`, `rejected`, `failed`, `cancelled` |
| `awaiting-capability-confirmation` | `generating`, `rejected`, `failed`, `cancelled` |
| `generating` | `validating`, `rejected`, `failed`, `cancelled` |
| `validating` | `verifying-runtime`, `generating`（仅 repair）, `failed`, `cancelled` |
| `verifying-runtime` | `ready`, `partial`, `failed`, `cancelled` |
| `ready` | `adopted`（仅 adopt 入口）, `cancelled` |
| `partial` | `adopted`（必须显式确认）, `rejected`, `cancelled` |
| `rejected` | —（终态） |
| `failed` | `analyzing`（仅 retry 且换新 runId）, `cancelled` |
| `adopted` | `idle`（显式撤销） |
| `cancelled` | —（终态） |

### 9.2 特殊守卫

1. **repair**：`validating → generating` 只能调用 `beginFrontendRepair(state, issues)`；
   issues 必须是 1–8 条 `{ path: ^\$(\.[A-Za-z][A-Za-z0-9]*|\[\d{1,3}\]){1,12}$, code }`，
   `code` 仅允许 `DRAFT_SCHEMA_INVALID/DRAFT_UNKNOWN_COMPONENT/DRAFT_UNKNOWN_EVENT/
   DRAFT_UNKNOWN_DATA_PATH/DRAFT_STYLE_INVALID/DRAFT_PAGE_JSON_INVALID/SLOT_ANCHOR_MISSING/
   DRY_RUN_FAILED/MINI_CHECK_FAILED/CONSISTENCY_FAILED`。自由文本日志、shell、堆栈一律
   `FRONTEND_REPAIR_ISSUES_INVALID`。
2. **修复上限**：`FRONTEND_MAX_REPAIR_ROUNDS = 2`。第 3 次 repair 报
   `FRONTEND_REPAIR_LIMIT_EXCEEDED`，调用方必须把状态置 `failed`；**不得放宽上限**。
3. **重试**：`failed → analyzing` 只能调用 `retryFrontendRun(state, newRunId)`，新 runId 必须
   合法且不同于旧值；repair 计数清零。旧响应用 `runId + revision + AbortSignal` 丢弃。
4. **采用**：`ready → adopted` 走 `adoptFrontendCandidate`；`partial → adopted` 必须传
   `explicitPartialConfirmation: true`，否则拒绝。`partial` 绝不能显示“已验收”。
5. **撤销**：`undoAdoptedFrontend` 只接受 `adopted`，回到 `idle` 并清零 repair 计数；版本恢复
   由桌面持久化层负责。通用 `transitionFrontendRun(adopted, 'idle')` 被明确拒绝
   （`reason="undo-required"`），不允许绕过撤销入口。
6. **取消**：`cancelFrontendRun` 不接受终态与 `adopted`；取消后不产生已采用变更。
7. 每次合法迁移 `revision + 1`，用于丢弃旧响应与幂等复用判断。

---

## 10. 硬边界

| 项 | 上限 |
| --- | ---: |
| 请求体 JSON（UTF-8 字节） | 2 MiB |
| 单图解码字节 | 409600（恰好等于上限可通过，+1 即拒绝） |
| utterance | 500 码点 |
| presentationPatch（UTF-8 字节） | 16 KiB，深度 ≤8 |
| targetPages | 1–2 |
| requirement pages | 0–2（planned 时 ≥1） |
| requirement regions | 32/页，深度 ≤3，children ≤12 |
| mustKeep | 1–32 |
| bindings | 0–64 |
| unknown/lowConfidence/inferred/unsupported/degradations | 24/24/16/16/16 |
| draft pages | 1–2 |
| draft nodes | 48/页，深度 ≤4，container children ≤12 |
| component props / events | 8 / 8 |
| displayName / button label / nav title | 40 / 16 / 20 |
| questions | 0–8，text ≤200 |
| repair | 2 轮，issues 1–8 |
| model calls / tool calls / wall clock | 8 / 16 / 120000ms |
| trace toolCalls | 0–16 |

常量集中在 `types.ts` 的 `FRONTEND_LIMITS` 与 `state.ts` 的 `FRONTEND_MAX_REPAIR_ROUNDS`，
测试与文档共用同一组数字。

---

## 11. 注入事实（FrontendFacts）

`FrontendFacts` 是服务端打包的只读能力快照，不由客户端提供。P0 契约固定其形状：

```ts
interface FrontendFacts {
  version: 'frontend-facts.v1';
  pageIds: string[];                 // 首期仅 home/menu
  components: Record<string, { props: string[]; events: string[] }>;
  slots: string[];
  actions: string[];                 // 如 home.goMenu / menu.onCheckout
  dataPaths: string[];               // 如 store.name / cart.totalCents
  themeTokens: string[];             // 七类 Base 颜色 token 子集
  sizeKeys: string[];                // homeHero/productCard/carousel
}
```

派生能力 id：`page:<id>` / `component:<id>` / `slot:<id>` / `action:<id>` / `data:<path>`。
`validateFrontendFacts` 对快照本身 fail closed（未知键、非法 id、越界、未知 token 都报
`FRONTEND_FACTS_INVALID`）。P0 的 `test/fixtures/frontend-reconstruct/facts.base.json`
只是测试注入事实；**P1 才生成正式快照** `capabilities.snapshot.json`，并由根脚本从
`templates/catalog`、Base Manifest 与页面控制器确定性生成、测试同源。

---

## 12. 实现映射

| 文件 | 职责 |
| --- | --- |
| `server/src/agent/frontend-reconstruct/types.ts` | 契约常量、请求/响应、UiRequirement/VisualSpec、Coverage、DSL、状态与 repair 类型 |
| `server/src/agent/frontend-reconstruct/errors.ts` | `FRONTEND_*` 错误码表、`FrontendReconstructError`、`toHttpException()` |
| `server/src/agent/frontend-reconstruct/schema.ts` | 纯函数运行时校验：请求图片/字段、事实、Requirement、Coverage、Draft、响应 |
| `server/src/agent/frontend-reconstruct/state.ts` | 合法迁移、结构化 repair、2 轮上限、adopt/undo/retry/cancel |
| `server/src/agent/frontend-reconstruct/index.ts` | 公共出口（P1 只从 `index.ts` 取契约能力） |
| `server/test/frontend-reconstruct.contract.test.ts` | 90 条先红后绿契约测试（P0 冻结 + t15 硬化补测 + t21 C1/targetPages/WebP 正向） |
| `test/fixtures/frontend-reconstruct/` | 70B PNG、160B JPEG、`requirement.valid/partial`（bindings 含 `data:menu.products`）、`coverage.covered/partial`（required 含 `data:menu.products`）、`draft.valid`（含 `menu.products` 文本节点）、`draft.forbidden`、负向 rect fixture、测试注入事实；WebP 正向用测试内 16B RIFF/WEBP 头，不落二进制 fixture |

**范围说明**：P0 阶段只交付上面这些纯契约能力，没有注册 Controller/Service、生成能力快照或实现
桌面链路；P1 已按本契约新增 `controller.ts`/`service.ts`/`tools.ts`/`capabilities.ts` 与只读能力
快照，并用 C1/C2 硬化校验响应。契约以本文与 `schema.ts`/`state.ts` 为准，P1 只消费、不改语义。

---

## 13. 验证与先红后绿证据

命令（本机沙箱必须显式 `--configLoader native --pool=threads`，不得因默认 runner 的 spawn
EPERM 改测试语义）：

```powershell
cd server
npx vitest run --configLoader native --pool=threads test/frontend-reconstruct.contract.test.ts
npx tsc -p tsconfig.json --noEmit --incremental false
npx vitest run --configLoader native --pool=threads test/agent.controller.e2e.test.ts test/agent.service.test.ts test/agent-runtime.loop.test.ts test/agent-runtime.executor.test.ts
```

实测（2026-11-17，两轮）：

| 轮次 | 步骤 | 结果 |
| --- | --- | --- |
| P0 | 先写测试、未实现模块 | **红**：`Cannot find module '../src/agent/frontend-reconstruct/errors'`，0 tests，exit 1 |
| P0 | 实现后契约测试 | **绿**：`Test Files 1 passed`，**75/75 passed**，exit 0 |
| t15 | P1 硬化后旧 fixture/测试（01:15:46） | **红**：3 failed / 72 passed，失败为 P1/P4/P9；根因 `requirement.valid.json` 仍带降级，与 C2 “covered 不得带降级”冲突（实现正确拒绝） |
| t15 | 更新 fixture + C1/C2/低项补测后（01:18:43 全量验证） | **绿**：`Test Files 1 passed`，**87/87 passed**，exit 0 |
| t21 | T16-F1/F2 补测先红（01:32:18） | **红**：P15（coverage 漏 mustKeep/binding 仍接受）与 P16（targetPages 缺省可跳过）失败；另 P10 因 draft 新增 menu.products 文本节点需同步断言容器子节点数（测试维护，非放宽） |
| t21 | schema C1 超集 + targetPages fail closed 后（01:42:24 全量验证） | **绿**：`Test Files 1 passed`，**90/90 passed**，exit 0 |
| t15 | TypeScript | `npx tsc -p tsconfig.json --noEmit --incremental false` 通过（无输出） |
| t15 | 既有 Agent 回归 | 4 个文件 **46/46 passed**（agent.controller.e2e 13 / agent.service 12 / runtime.loop 9 / runtime.executor 12） |
| t15 | 依赖与范围 | 未新增依赖；未改 `server/src/agent/frontend-reconstruct/`、既有端点/响应、`desktop/`、`src/`、`templates/`、`miniprogram/`、`scripts/`；仅改契约测试、fixtures 与本文 |

测试覆盖（90 条）：请求未知键/嵌套未知键、恰好一图、多图、非 reference、mediaType、伪 base64、
文件头不符（含 WebP 正向 12+ 字节 RIFF/WEBP 头、WebP/PNG 错配）、单图 409600 字节边界、
空/超长/C0+C1 控制字符 utterance、targetPages、client/projectId/body（UTF-8 字节）/patch 上限；
Requirement 的 mustKeep、pages/regions/children、0–1 rect、绑定事实、颜色/尺寸/theme facts、
重复 id、order、深度、confidence、regionId 引用、inferredInteractions 禁动作/路由、恶意文本与
未知键；Coverage 的 covered/partial/rejected 与防伪造；Draft 五类节点、props/events/dataPath/
action、样式白名单、CSS/URL/路径/脚本、styles/pageJson、节点上限/深度、id 注入、C1 控制字符；
响应三态、C1 需求超集与 draft 一致性、C2 降级联动、targetPages 缺省 fail closed、trace/meta、
嵌套 422 与组合 502 分层；状态机全链路、非法迁移、2 轮 repair、partial 显式采用、
adopted→idle 只能 undo、重试与错误码表一致性。

---

## 14. 明确禁止项（红线）

1. 不接生图模型、不配置/伪造 `IMAGE_PROVIDER_*`，不生成或复刻品牌图片。
2. 不允许模型或客户端提交任意 JS/WXML/WXSS/WXS/HTML/命令/绝对路径/外部 URL。
3. 不写全局 `templates/**`、不重冻结全局 Registry、不改 `miniprogram/` 镜像。
4. 不在服务端写仓库源码、不执行 shell、不把模型输出当源码执行。
5. 不把 `partial` 当验收通过；不伪造编译/截图/微信运行时证据；不用 React 截图替代微信截图。
6. 不在日志/响应/快照/fixture 写入 API Key、base64 图片正文、完整 prompt 或原始模型响应。
7. 不因测试环境限制放宽断言、删测试或改测试语义；不把 C1/C2 组合不变量降级为“结构合法即通过”。
8. 不允许 `inferredInteractions` 携带动作名、能力前缀或路由路径，借自由文本绕过事实校验。
