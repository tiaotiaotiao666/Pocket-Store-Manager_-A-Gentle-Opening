---
name: wechat-template-builder
description: 当店主需要新建或扩展微信原生小程序模板、入库 UI Block 或 Feature Pack、或根据文字/参考图生成一套新的 Recipe 并导出可编译工程时使用。该技能强制执行“注册表冻结 + 精确版本 + 缺能力即拒绝 + 微信真实编译验收”的流程。
---

# 微信小程序模板生成 Skill

## 角色

你是资深微信小程序开发工程师，负责在当前仓库根目录内生成或扩展版本化模板资产。你的产出不是一份新写的业务源码，而是一组符合冻结契约的资产文件、一份 Recipe，以及可复现的导出工程和验证证据。

## 绝对不可违反的规则

1. **不直接生成业务 JS。** 页面控制器、服务层、领域逻辑只能复用 Base 中已验收的实现。Agent 只允许新增/修改 `index.wxml`、`index.wxss`、`index.json` 和声明式 Manifest / Plan（Feature Pack 还可包含 `pages/<pageId>.extend.json` 声明）。
2. **不绕过注册表。** 任何新资产必须先落盘到 `templates/components/` 或 `templates/features/`，再登记到 `templates/registry/registry.v1.json`，然后执行 `node scripts/registry-check.cjs --write`。
3. **精确版本。** Plan 和 Manifest 中的版本必须是 `MAJOR.MINOR.PATCH`；禁止 `latest`、`^`、`~`、`*`、范围。
4. **缺能力即拒绝。** 必需组件、控制器动作、服务能力或后端契约任一缺失，输出 `CapabilityCoverageReport(status="rejected")` 并停止；不生成空壳页面，不静默删需求。
5. **预览不等于验收。** 正式模板必须经过微信开发者工具真实编译和核心闭环回归；React 预览只能称为“效果预览”。
6. **不写秘密。** API Key、AppSecret、Token、绝对路径、内网地址、外部 URL 一律不得出现在资产、Plan、Lock、报告或日志中。

## 第一步：读取真实上下文

在开始编码前读取（不要凭记忆）：

- `docs/模板库/README.md`
- `docs/模板库/组件入库标准.md`
- `templates/registry/registry.v1.json`
- `templates/registry/schema/manifest.v1.json`
- `templates/registry/schema/composition.v1.json`
- `scripts/composer/version.cjs`
- 至少一个现有资产：`templates/components/product-card/1.0.0/` 或 `templates/features/poster-carousel/1.0.0/`

报告你读到的 `registryVersion`、现有资产数量和 `COMPOSER_VERSION`。

## 第二步：结构化需求

把用户输入整理为：

```json
{
  "requestId": "<唯一 ID>",
  "utterance": "<原始需求>",
  "images": ["<本地图片路径，可为空>"],
  "mustKeep": ["<必须保留的业务动作>"],
  "pages": ["home", "menu", "orders", "mine", "checkout", "order-detail", "product-detail", "merchant-orders"],
  "themePreference": {},
  "sizePreference": {},
  "requiredAssets": [],
  "requiredControllers": [],
  "requiredApiCapabilities": []
}
```

如果用户提供参考图，只识别页面分区、近似组件、颜色和大致布局；同时记录未识别项、低置信度项和无法从图片判断的交互。不要承诺像素级复现。

## 第三步：能力覆盖门禁

生成前必须输出：

```json
{
  "requestId": "<ID>",
  "status": "covered | partial | rejected",
  "requiredCapabilities": [],
  "missingCapabilities": [],
  "coveredBy": {},
  "confidence": 0.0,
  "risks": []
}
```

判定规则：

- `covered`：全部必需能力存在，继续。
- `partial`：只有非必需视觉项缺失；必须获得用户确认，并把降级项写入 Plan 的 `degradations[]`。
- `rejected`：任一必需能力缺失；立即停止，不调用 Composer、不写正式目录、不启动微信编译。

执行这次检查时必须同时查：

- Base 内置组件：`templates/base/ordering-base/1.0.0/manifest.json#builtinComponents`
- Registry UI Block：`templates/components/`
- Feature Pack：`templates/features/`
- 页面控制器：`templates/base/ordering-base/1.0.0/src/pages/*/index.js` 的 `methods`
- 服务层：`templates/base/ordering-base/1.0.0/src/services/`
- 后端 API 契约：`docs/api.md`

## 第四步：选择最小改动路径

| 需求 | 做法 |
| --- | --- |
| 换主色/强调色/文字色/背景色 | 只改 Plan 的 `themeTokens`，7 个 Token 用大写 `#RRGGBB` |
| 调组件大小 | 只改 Plan 的 `presentationTokens`，`sm|md|lg` |
| 移动已有区块 | 只改 Plan 顶层 `slotOrder`，且必须是已占用 Feature 的完整排列 |
| 新增纯展示块 | 在 `templates/components/` 新增 UI Block |
| 新增业务能力 | 在 `templates/features/` 新增 Feature Pack；先确认后端契约 |
| 换一套现有页面视觉/布局，保留 Base 控制器 | 在 `templates/frontend-packs/` 新增 FrontendPack，只生成 WXML/WXSS/JSON |
| 需要全新交互逻辑 | 拆成独立的新资产/后端任务，不在本次模板生成中放开任意 JS |

不要把尺寸写进 `themeTokens`，不要改写 `features[].slots[]` 来表达移动落位。

## 第五步：新增 UI Block 的文件契约

```text
templates/components/<id>/<version>/
├─ manifest.json
├─ src/index.js
├─ src/index.json
├─ src/index.wxml
├─ src/index.wxss
└─ preview/{normal,empty,error,long}.json
```

`manifest.json` 必须包含：

```json
{
  "schemaVersion": "manifest.v1",
  "identity": { "id": "<kebab-case>", "version": "<x.y.z>" },
  "kind": "ui-block",
  "displayName": "<≤48 字符>",
  "entry": { "path": "src", "files": ["index.js", "index.json", "index.wxml", "index.wxss"], "assets": [] },
  "interface": {
    "props": [{ "name": "<camelCase>", "type": "string|number|boolean|array|object", "required": true, "description": "<≤200 字符>" }],
    "events": [{ "name": "<camelCase>", "payload": ["<字段名>"], "description": "<≤200 字符>" }]
  },
  "boundary": { "allowNetwork": false, "allowRoutes": false, "allowGlobalState": false, "allowServices": false },
  "compatibility": { "baseRange": "^1.0.0", "minWechatLib": "3.0.0", "apiContract": "storefront.v1" },
  "requiredPages": ["<Base 已声明页面>"],
  "requiresSlots": [],
  "dependencies": [],
  "conflicts": [],
  "preview": { "dir": "preview", "kinds": ["normal", "empty", "error", "long"] },
  "release": { "stage": "candidate", "knownLimits": [], "verifiedRecipes": [] }
}
```

实现要求：

- `properties` 的键与 `interface.props` 完全一致，类型映射为 `String/Number/Boolean/Array/Object`，且每个 prop 有默认值。
- 每个 `triggerEvent('x', detail)` 的 `x` 必须在 `interface.events` 中声明；detail 只含声明字段。
- 允许纯 UI 状态；禁止 `wx.request`、`wx.uploadFile`、云函数、固定路由、`globalData`、`require` 服务层。
- 样式引用 Base 的 `--color-*` / `--store-*` 变量，禁止写死主题色。
- 四类预览 JSON 必须可解析：正常、空态、异常、超长。

## 第六步：新增 Feature Pack 的文件契约

```text
templates/features/<id>/<version>/
├─ manifest.json
├─ src/components/<component-id>/index.{js,json,wxml,wxss}
├─ src/pages/<pageId>.extend.json
├─ src/assets/...
└─ preview/{normal,empty,error,long}.json
```

关键要求：

- `kind` 必须是 `feature-pack`。
- `entry.path` 指向包内相对 POSIX 目录，例如 `src/components/poster-carousel`。
- `requiresSlots` 必须列出该能力必需的 Base 插槽（当前合法值：`home-hero`、`home-marketing`、`menu-aside`、`menu-hero`）。
- `pages/<pageId>.extend.json` 只声明 `pageId`、`slotId`、`component`、`hooks`、`note`，不得包含可执行脚本。
- 组件边界仍为四项全 `false`；网络请求只能出现在页面或服务层。
- 未被任何正式 Recipe 使用前保持 `release.stage: "candidate"`。

### 6.1 FrontendPack：只覆盖视图层

当需求是“换一套首页/菜单视觉与布局”，而业务逻辑不需要新增时，新增 FrontendPack，不要重写页面 JS：

```text
templates/frontend-packs/<id>/<version>/
├─ manifest.json
├─ src/pages/<pageId>/index.{wxml,wxss,json}
└─ preview/{normal,empty,error,long}.json
```

硬要求：

- `schemaVersion` 必须是 `frontend-pack.v1`，`kind` 必须是 `frontend-pack`。
- 包内不得出现任何 `.js` 文件；页面控制器始终来自 Base。
- `entry.files` 只允许 `pages/<pageId>/index.{wxml,wxss,json}`。
- `requiresSlots`（如 `home-hero`、`home-marketing`、`menu-hero`、`menu-aside`）对应的四段锚点必须完整保留。
- 页面 JSON 只允许 `navigationBarTitleText`、`enablePullDownRefresh`、`disableScroll`、`backgroundColor`、`backgroundTextStyle`、`usingComponents`；`usingComponents` 只能是 Base 页面的子集。
- 事件绑定必须命中 Base 页面控制器已有方法；否则构建期报 `FRONTEND_PACK_EVENT_UNKNOWN`。
- Plan 顶层增加 `frontendPack: { id, version }`，不得内联 WXML/WXSS。
- WXSS 会追加在 Base 页面样式之后，不替换 Base 样式。
- 完整契约见 `docs/模板库/FrontendPack视图包标准与范例.md`。

## 第七步：创建 Recipe 并生成

Recipe 目录：

```text
templates/recipes/<id>/<version>/
├─ recipe.json
├─ plan.json
└─ release.json
```

`plan.json` 只允许以下顶层键：

`schemaVersion`、`planId`、`planVersion`、`baseTemplate`、`registryVersion`、`pages`、`features`、`components`、`themeTokens`、`apiBinding`、`storeProfile`、`previewOnlyAck`、`degradations`，以及可选的 `presentationTokens`、`slotOrder`。

禁止键：`source`、`code`、`script`、`command`、`url`、`token`、`secret`、`password`、`apiKey`、`priceText`、`totalCents`。

推荐命令：

```powershell
node scripts/registry-check.cjs --write
npm run registry:check
npm run composer:build -- --plan templates/recipes/<id>/<version>/plan.json --out "C:\Users\<用户>\AppData\Local\Temp\smartstore-build" --mode development
npm run composer:verify -- --root "C:\Users\<用户>\AppData\Local\Temp\smartstore-build\<id>"
npm run mini:check -- --root "C:\Users\<用户>\AppData\Local\Temp\smartstore-build\<id>"
npm test
```

注意：

- `--out` 是父目录，工程名默认取 `planId`。
- 导出必须放在工作区外；工作区内大目录 rename 可能因本机环境返回 EPERM。
- `composer:verify` 当前存在既有 `PATH_ESCAPE` 缺陷：报告文件含绝对路径。如果命中仅限 `generation-report.json` / `生成报告.md`，按既有缺陷处理，不误判为资产问题。

## 第八步：报告

完成后报告：

- 改动文件清单（与 `git status` 对齐）
- 执行的命令与真实退出码
- 生成的工程目录、`lockDigest`、`treeSha256`、文件数
- 已验证项与未验证项
- 若拒绝：`missingCapabilities[]`、风险说明和后端待实现建议

## 质量门禁（全部必须满足才可宣称完成）

- [ ] 资产类型判定正确（UI Block / Feature Pack / 仅 Plan）。
- [ ] Manifest 必填字段齐全、无禁止键、目录版本一致。
- [ ] `entry.files` / `entry.assets` 与磁盘一致。
- [ ] props / events 与实现双向一致。
- [ ] 四类预览数据齐全且可解析。
- [ ] 未触网、未固定路由、未读全局状态、未依赖服务层。
- [ ] FrontendPack 目录内没有 `.js`，页面 JSON 只用白名单键，事件全部命中 Base 控制器。
- [ ] FrontendPack 的 `requiresSlots` 锚点在覆盖后的 WXML 中各出现一次。
- [ ] `registry:check` 退出码 0。
- [ ] 至少一份 Recipe 真实生成成功。
- [ ] 微信开发者工具真实编译与核心闭环回归完成（或明确标注 NOT_RUN/INCOMPLETE）。