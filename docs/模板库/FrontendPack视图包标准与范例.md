# FrontendPack 视图包标准与范例

> FrontendPack 是受控视图包：允许 Agent 在 Base 之上生成或替换指定页面的 `WXML`、`WXSS` 和页面 `JSON`，但禁止生成任何业务 JS，也禁止修改 Base 页面控制器、服务层和领域逻辑。
> 机器契约：`templates/registry/schema/frontend-pack.v1.json`；实现：`scripts/composer/{schema,registry,resolve,emit}.cjs`；样例：`templates/frontend-packs/warm-home-menu/1.0.0`。

## 1. 定位

```text
Runtime Base（页面 JS / 服务层 / 领域逻辑 / 页面生命周期）
        +
FrontendPack（只覆盖页面视图）
        ↓
Composer 合并出完整小程序工程
```

它解决的是“换一套首页/菜单视觉与布局”，不是“重写整个小程序”。

FrontendPack 可以：

- 重新组织页面结构、卡片布局、按钮位置、颜色和尺寸；
- 使用 Base 已声明的组件与插槽；
- 为页面提供新的 `WXSS`，在 Base 样式之后追加；
- 保留 Base 的页面事件绑定目标。

FrontendPack 不可以：

- 新增或修改任何 `.js` 文件；
- 引入 Base 未声明的 `usingComponents`；
- 调用网络、路由、全局状态或服务层；
- 使用 `wxs`、`script`、`import`、`include`、`eval`、动态组件；
- 引用外部 URL 或包外素材；
- 删除 Base 要求的插槽锚点；
- 改变页面集合或新增页面。

## 2. 目录契约

```text
templates/frontend-packs/<id>/<version>/
├─ manifest.json
├─ src/
│  └─ pages/
│     ├─ home/index.wxml
│     ├─ home/index.wxss
│     ├─ home/index.json
│     ├─ menu/index.wxml
│     ├─ menu/index.wxss
│     └─ menu/index.json
└─ preview/
   ├─ normal.json
   ├─ empty.json
   ├─ error.json
   └─ long.json
```

约束：

- ID 为 3–48 位 kebab-case；版本为精确 `MAJOR.MINOR.PATCH`；目录名等于版本。
- `entry.files` 只能包含 `pages/<pageId>/index.wxml|wxss|json`，出现 `.js` 立即 `FRONTEND_PACK_SOURCE_FORBIDDEN`。
- `pages[]` 中每个页面必须同时提供三类视图文件，否则 `FRONTEND_PACK_PAGE_FILE_MISSING`。
- `requiresSlots` 只能包含 Base 已声明的插槽；缺失或重复锚点会被拒绝。
- `preview.kinds` 必须覆盖 `normal/empty/error/long`。

## 3. Manifest 字段

```json
{
  "schemaVersion": "frontend-pack.v1",
  "identity": { "id": "warm-home-menu", "version": "1.0.0" },
  "kind": "frontend-pack",
  "displayName": "暖橙首页与菜单视图包",
  "entry": {
    "path": "src",
    "files": [
      "pages/home/index.wxml",
      "pages/home/index.wxss",
      "pages/home/index.json",
      "pages/menu/index.wxml",
      "pages/menu/index.wxss",
      "pages/menu/index.json"
    ],
    "assets": []
  },
  "pages": ["home", "menu"],
  "boundary": {
    "allowNetwork": false,
    "allowRoutes": false,
    "allowGlobalState": false,
    "allowServices": false
  },
  "compatibility": {
    "baseRange": "^1.0.0",
    "minWechatLib": "3.0.0",
    "apiContract": "storefront.v1"
  },
  "requiresSlots": ["home-hero", "home-marketing", "menu-hero", "menu-aside"],
  "preview": { "dir": "preview", "kinds": ["normal", "empty", "error", "long"] },
  "release": {
    "stage": "candidate",
    "knownLimits": [
      "只覆盖首页与菜单页的视图层，页面控制器与服务层仍来自 Base",
      "WXSS 在 Base 页面样式之后追加，不删除 Base 原有样式"
    ]
  }
}
```

| 字段 | 规则 |
| --- | --- |
| `kind` | 固定 `frontend-pack` |
| `entry.files` | 非空；只允许页面视图三件套 |
| `pages` | 被覆盖的 Base 页面 ID；必须是 Plan 已启用页面 |
| `boundary` | 四项必须全部 `false` |
| `compatibility` | `baseRange` 为 `^x.y.z`，`apiContract` 为 `storefront.v1` |
| `requiresSlots` | 视图包保留的 Base 插槽锚点 |
| `release.stage` | `candidate / preview-only / online-ready / blocked` |

## 4. Composer 合并语义

### 4.1 WXML：替换

FrontendPack 的 `pages/<pageId>/index.wxml` 会替换 Base 对应页面的 WXML。替换后仍必须保留 `requiresSlots` 对应的四段锚点：

```xml
<!-- @slot:home-hero -->
<!-- @slot-fallback:home-hero -->
<store-header ... />
<!-- @slot-fallback:home-hero:end -->
<!-- @slot:home-hero:end -->
```

插槽注入发生在覆盖之后，因此 Feature Pack / UI Block 仍能按 Plan 的 `slotOrder` 正常落位。

### 4.2 WXSS：追加

FrontendPack 的 `pages/<pageId>/index.wxss` 不是替换，而是追加到 Base 页面样式之后：

```text
Base page WXSS
+ /* FrontendPack <id>@<version>：在 Base 页面样式之后追加。 */
+ FrontendPack WXSS
```

这样新视图可以覆盖旧类名，也可以复用 Base 已有类名；不会因为缺少基础样式导致页面塌陷。

### 4.3 JSON：受限合并

页面 JSON 只允许以下键：

`navigationBarTitleText`、`enablePullDownRefresh`、`disableScroll`、`backgroundColor`、`backgroundTextStyle`、`usingComponents`。

- `usingComponents` 必须是 Base 页面已声明组件的子集，且映射路径必须一致；不得新增或改绑组件。
- 未声明的键会返回 `FRONTEND_PACK_JSON_FIELD_FORBIDDEN`。
- 合并后仍由 Composer 过滤 `usingComponents`，只保留页面实际使用的组件。

### 4.4 控制器与事件

页面 `index.js` 永远来自 Base。FrontendPack 的 WXML 中每个 `bind:` / `catch:` 处理函数都必须能在 Base 页面控制器中找到；否则构建期返回 `FRONTEND_PACK_EVENT_UNKNOWN`，不会依赖微信运行时才报错。

## 5. 安全门禁

| 门禁 | 错误码 |
| --- | --- |
| 存在 `.js` 文件 | `FRONTEND_PACK_SOURCE_FORBIDDEN` |
| WXML 含 `script/wxs/import/include` 或 `eval/Function` | `FRONTEND_PACK_SCRIPT_FORBIDDEN` |
| WXML/WXSS 引用外部 URL | `FRONTEND_PACK_EXTERNAL_URL` |
| 新增 Base 未声明组件 | `FRONTEND_PACK_COMPONENT_UNKNOWN` |
| 改绑 Base 组件路径 | `FRONTEND_PACK_COMPONENT_REMAP` |
| 缺少或重复插槽锚点 | `FRONTEND_PACK_SLOT_ANCHOR_MISSING` |
| 绑定控制器不存在的方法 | `FRONTEND_PACK_EVENT_UNKNOWN` |
| 页面 JSON 出现非白名单键 | `FRONTEND_PACK_JSON_FIELD_FORBIDDEN` |
| Plan 引用了非 frontend-pack 资产 | `ASSET_KIND_MISMATCH` |
| Plan 未启用视图包页面 | `FRONTEND_PACK_PAGE_NOT_IN_PLAN` |

## 6. Plan 引用

`composition.v1` 新增可选顶层字段：

```json
{
  "frontendPack": { "id": "warm-home-menu", "version": "1.0.0" }
}
```

规则：

- 只接受 `id` + 精确 `version`，禁止内联 WXML/WXSS/源码。
- `frontendPack` 进入 `planDigest`，并作为独立资产进入 `composition.lock.json` 的 `features` 与 `sourceDigests`。
- `frontendPack` 不计入业务 `capabilitySet`，也不参与插槽 `accepts` 校验。
- 未提供 `frontendPack` 的旧 Plan 行为不变。

## 7. 入库与生成

```powershell
node scripts/registry-check.cjs --write
node scripts/registry-check.cjs
node scripts/composer/cli.cjs `
  --plan templates/recipes/order-warm-home/1.0.0/plan.json `
  --out "C:\Users\<用户>\AppData\Local\Temp\smartstore-fp" `
  --mode development `
  --project-name order-warm-home
node scripts/composer/verify-cli.cjs --root "C:\Users\<用户>\AppData\Local\Temp\smartstore-fp\order-warm-home"
node scripts/validate-miniprogram.cjs --root "C:\Users\<用户>\AppData\Local\Temp\smartstore-fp\order-warm-home"
npm test
```

已知缺陷：`composer:verify` 会把产物内 `generation-report.json` 与 `生成报告.md` 的绝对 `projectPath` 判为 `PATH_ESCAPE`。把这两个文件临时移出后再跑，应得到 8 项全绿，与本视图包无关。

## 8. 本仓库样例的实测结果（2026-11-04）

- 注册表：`node scripts/registry-check.cjs --write` → 10 个资产冻结成功；`node scripts/registry-check.cjs` → `base 1 / ui-block 3 / feature-pack 1 / frontend-pack 1 / recipe 4（direct 2）`。
- 生成：`order-warm-home@1.0.0` → 137 个文件，产物树 `sha256:29e5f3411af9847c9708b6581727aaa77898a41f1f201fef42af700c507a3c9d`，Lock `sha256:34f49bd24fe19e0f20c2de6071e9ba4a01f046ac4c672d8914906d70a5c29762`。
- 产物校验：移出两份报告后 8 项全绿（app-json-pages、page-four-piece、app-json-disk-match、using-components、dynamic-component、static-check、security-scan、reproducibility）。
- 小程序静态校验：8 个页面、14 个组件目录、53 个 JS、25 个 WXSS，0 错误 0 警告。
- 全量测试：629 通过，0 失败。

## 9. 当前边界

- 本视图包只覆盖 `home`、`menu`；其他页面仍使用 Base 视图。
- 页面 JS、服务层、领域逻辑未改动。
- 尚未经过微信开发者工具真实编译与人工视觉验收，因此 Recipe 保持 `candidate`。
- 产品运行时还没有“自然语言 → WXML/WXSS”的自动生成端点；Agent 目前通过 `wechat-template-builder` skill 按本契约落盘视图包、登记、冻结并生成。若要做成按钮式能力，下一步是新增独立的 FrontendPack 生成服务与候选包存储。