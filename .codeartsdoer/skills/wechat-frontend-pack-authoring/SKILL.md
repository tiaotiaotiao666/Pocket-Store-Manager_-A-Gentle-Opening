---
name: wechat-frontend-pack-authoring
description: 当已确认 VisualSpec 与能力覆盖（covered/partial），需要把需求写成受控 FrontendPackDraft JSON DSL，或实现/评审 frontend-pack-draft.v1 的 schema、确定性 renderer、私有物化与 Registry overlay 时使用。该技能强制只产生 5 类节点与白名单样式，禁止任意 WXML/WXSS/JS/WXS/路径/命令；候选只写应用私有 attempt 与 overlay，绝不写正式 templates 或重冻结全局 Registry。
---

# 微信小程序 FrontendPack 候选编写 Skill（VisualSpec → FrontendPackDraft DSL）

## 触发条件

- 已有 `wechat-visual-spec` 的 UiRequirement/VisualSpec，且 `wechat-capability-coverage` 给出 `covered` 或经确认的 `partial`，需要生成用户私有候选前端。
- 需要扩页/改布局/改主题，但**页面 JS、业务逻辑、门店菜品数据必须继续来自 Base**。
- 实现或评审 `server/src/agent/frontend-reconstruct/schema.ts` 的 `validateFrontendPackDraft`、`desktop/frontend-reconstruct/{schema,render,materialize,registry-overlay,workspace}.cjs`、四工具中的 `propose_frontend_draft`/`repair_frontend_draft`。
- 需要判断“这是正式资产入库还是用户私有候选重构”。

不适用 / 必须改走其它流程：

- 新增/修改 Base 页面控制器、服务层、领域逻辑或任意 `.js` → 不属于本链路。
- 正式资产入库：把新 UI Block / Feature Pack / FrontendPack 写进 `templates/**` 并登记冻结 Registry → 走 `wechat-template-builder`，不是本技能默认路径。
- 需要全新交互/后端能力 → 能力覆盖阶段就应 `rejected`。
- 要直接写 WXML/WXSS/JS/WXS、跑任意命令、给像素级复刻承诺 → 拒绝。

## 必读文件

- `docs/handoff/图片驱动前端重构-Flash实施计划.md` §3.4、§4、§5.3、§7-P2
- `docs/frontend-reconstruct-contract.md` §6（DSL）、§7.1（C1/C2）、§10（上限）、§14（红线）
- `docs/模板库/FrontendPack视图包标准与范例.md`（正式 FrontendPack 契约与插槽锚点）
- `server/src/agent/frontend-reconstruct/types.ts`（`FRONTEND_LIMITS`、五类节点、样式类型）
- `server/src/agent/frontend-reconstruct/schema.ts`（`validateFrontendPackDraft`）
- `desktop/frontend-reconstruct/README.md`（安全不变量、单一事实源、canon→WXML 映射）
- `desktop/frontend-reconstruct/schema.cjs`（执行侧镜像校验与 `DRAFT_*` code）
- `desktop/frontend-reconstruct/render.cjs`（确定性 renderer、预览四态、slot 锚点）
- `desktop/frontend-reconstruct/materialize.cjs`（staging → 自校验 → 原子提交 attempt）
- `desktop/frontend-reconstruct/registry-overlay.cjs`（私有 overlay、可信索引投影、禁止前缀）
- `desktop/frontend-reconstruct/workspace.cjs`（固定目录布局、symlink/junction 防护）
- `server/src/agent/frontend-reconstruct/capabilities.snapshot.json`（页面事实与 canonical dataPaths）
- 正式资产路径参考：`templates/registry/schema/frontend-pack.v1.json`、`templates/frontend-packs/warm-home-menu/1.0.0/`

## 输入

输入必须同时具备：

1. 已确认的 UiRequirement/VisualSpec（`home`/`menu`，首期不扩页）；
2. 服务端能力覆盖 `covered`，或 `partial` + 明确降级项与用户确认；
3. 当前页面事实：`pageFacts[pageId].components/slots/dataPaths`、组件 props/events、控制器 `actions`、`themeTokens`、`sizeKeys`；
4. 私有工作区参数：`userDataDir`（应用私有、仓库外）、`projectId`、`runId`（`frun-…`）、可选 `candidateId`。

DSL 顶层结构（`frontend-pack-draft.v1`）：

```json
{
  "schemaVersion": "frontend-pack-draft.v1",
  "displayName": "参考图首页候选",
  "pages": [
    {
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
            { "type": "text", "textToken": "store.businessHours", "style": { "size": "md", "weight": 600 } },
            { "type": "button", "label": "开始点餐", "action": "home.goMenu", "style": { "size": "lg", "weight": 600 } }
          ]
        }
      ],
      "styles": [],
      "pageJson": { "navigationBarTitleText": "扫码点餐", "navigationBarTextStyle": "white" }
    }
  ]
}
```

节点只允许五类，且每类只允许这些键：

| type | 允许键 | 规则 |
| --- | --- | --- |
| `component` | `type, componentId, props, events` | `componentId` 必须命中本页事实；`props` ≤8 且 prop 名命中组件白名单；`events` ≤8，事件名命中白名单，值必须是本页真实控制器 action |
| `slot` | `type, slotId` | `slotId` 必须是本页真实插槽；renderer 负责生成 fallback 锚点，DSL 不携带 WXML |
| `container` | `type, style?, children` | `children` 1–12；`style` 只用下面布局白名单 |
| `text` | `type, textToken, style?` | `textToken` 必须是本页 dataPath，不接受字面量/任意 WXML 表达式 |
| `button` | `type, label, action, style?` | `label` 1–16 字符纯文本；`action` 必须是本页真实控制器 action |

`props` 的值只能是显式绑定：

```json
{ "kind": "data", "dataPath": "store.name" }
{ "kind": "literal", "value": "A1" }
```

- `data.dataPath` 必须命中事实；`literal.value` 只允许 string/number/boolean/null，字符串 ≤120 字符且通过纯文本检查。
- 未知 `kind`、额外键、对象/数组值一律拒绝。

样式白名单（CSS 只由 renderer 按档位生成，不接受任何样式原文）：

| 作用域 | 允许键与值 |
| --- | --- |
| `container.style` | `direction(row|column)`、`align(start|center|end|stretch)`、`justify(start|center|end|between|around)`、`gap(none|xs|sm|md|lg|xl)`、`padding(none|xs|sm|md|lg|xl)`、`radius(none|sm|md|lg|full)`、`width(auto|full|40–750 整数)`、`minHeight(0–2000 整数)`、`backgroundColorToken`/`borderColorToken`（事实 theme token） |
| `text.style` / `button.style` | `size(sm|md|lg)`、`weight(400|500|600|700)`、`colorToken`（事实 theme token） |

显式给出 style 时不得为空对象；禁止 px/rem 自由值、渐变/定位/动画/任意 CSS、未知样式键。

`pageJson` 只允许：`navigationBarTitleText`（1–20）、`navigationBarBackgroundColor`（`#RRGGBB`）、`navigationBarTextStyle`（`black|white`）、`backgroundColor`（`#RRGGBB`）、`enablePullDownRefresh`（boolean）。**草稿不允许 `usingComponents`**。

上限（与服务端 `FRONTEND_LIMITS` 一致）：每页 ≤48 节点、深度 ≤4、container children ≤12、component props/events ≤8、`displayName` ≤40、button label ≤16、字符串 ≤120、页面 1–2 个且仅 `home`/`menu`。

数据路径必须用服务端 canonical 命名空间：`<pageId>.<key>`（如 `home.mode`、`menu.products`）、`cart.items`/`cart.totalCents`/`cart.count`、`store.*`。**不要**写原始 WXML token（`cartSummary.*`、`products.length`、`item.*`）；renderer 负责 canon → WXML：

- `<pageId>.<key>` → `{{key}}`（`home.mode` → `{{mode}}`、`menu.products` → `{{products}}`）；
- `cart.items/totalCents/count` → `{{cartSummary.items/totalCents/totalQuantity}}`；
- `store.*` 原样；
- 未知根/未知 cart key → `RENDER_DATA_PATH_UNSUPPORTED`（物化映射 `MATERIALIZE_DRAFT_INVALID` + `details.draftCode`）。

## 输出（含 schema 示例）

校验通过后由 renderer 生成 FrontendPack 候选文件（不经过模型写盘）：

```text
<candidateDir>/
├─ manifest.json                       # schemaVersion=frontend-pack.v1, kind=frontend-pack
├─ src/pages/home/index.wxml           # 结构 + 事件绑定 + 每个 slot 的 4 段 fallback 锚点
├─ src/pages/home/index.wxss           # 只含白名单档位生成的 CSS
├─ src/pages/home/index.json           # pageJson 白名单子集
└─ preview/{normal,empty,error,long}.json
```

`manifest.json` 关键字段：

```json
{
  "schemaVersion": "frontend-pack.v1",
  "identity": { "id": "fr-1a2b3c4d5e6f", "version": "1.0.0" },
  "kind": "frontend-pack",
  "displayName": "参考图首页候选",
  "entry": { "path": "src", "files": ["pages/home/index.wxml", "pages/home/index.wxss", "pages/home/index.json"], "assets": [] },
  "pages": ["home"],
  "boundary": { "allowNetwork": false, "allowRoutes": false, "allowGlobalState": false, "allowServices": false },
  "compatibility": { "baseRange": "^1.0.0", "minWechatLib": "3.0.0", "apiContract": "storefront.v1" },
  "requiresSlots": ["home-hero"],
  "preview": { "dir": "preview", "kinds": ["normal", "empty", "error", "long"] },
  "release": { "stage": "candidate", "knownLimits": ["…"] }
}
```

私有工作区与 overlay 固定布局（不接受调用方任意拼路径）：

```text
<userDataDir>/projects/<projectId>/frontend-runs/<runId>/
├─ run.json
└─ attempts/attempt-<n>/
   ├─ candidate/                       # 上面渲染出的 FrontendPack
   ├─ overlay/
   │  ├─ registry.v1.json              # 可信条目投影（路径+integrity 原样）+ 候选条目
   │  ├─ registry.lock.json            # contentDigest = registryDigest(index)
   │  └─ assets/frontend-packs/<candidateId>/<version>/{manifest.json,src/**,preview/**}
   └─ attempt.json
```

`materializeCandidate` 成功返回（只列关键字段）：

```json
{
  "ok": true,
  "attempt": 2,
  "attemptDir": "<userData>/projects/<projectId>/frontend-runs/<runId>/attempts/attempt-2",
  "candidateDir": "…/attempt-2/candidate",
  "overlayDir": "…/attempt-2/overlay",
  "overlayRegistryRoot": "…/attempt-2/overlay",
  "assetRoots": ["…/attempt-2/overlay", "<repo>"],
  "candidate": { "id": "fr-…", "version": "1.0.0" },
  "files": ["manifest.json", "src/pages/home/index.wxml", "…"],
  "degradations": [],
  "registryDigest": "sha256:…",
  "factsSource": { "…": "…" }
}
```

确定性要求：同一 Draft 两次渲染的文件逐字节一致、`draftDigest` 一致；产物不得含时间戳、随机数或本机绝对路径。候选版本默认 `1.0.0`，id 由 `draftDigest` 派生（也可显式传 `candidateId`）。

## 禁止项

1. **只允许 5 类节点**：`component`/`slot`/`container`/`text`/`button`；不给节点加 `id`，不发明第六类节点。
2. **禁止任意源码**：任何 HTML/WXML/WXSS/JS/WXS 原文、`<script>`、`{{}}` 模板、`import`/`include`、`usingComponents`、动态组件、事件属性都不允许；CSS 只能由白名单档位生成。
3. **禁止任意路径/URL/命令**：外部 URL、`data:`/`javascript:` scheme、绝对路径、反斜杠、`..`、盘符、模型提供的输出目录/脚本/命令全部拒绝。
4. **禁止自造能力**：未知组件/插槽/事件/action/dataPath/prop/theme token/尺寸档位一律拒绝，不“猜测近似组件”。
5. **禁止写正式资产**：候选只写应用私有 `attempts/attempt-<n>` + `overlay/`；不写仓库内 `templates/`、`miniprogram/`、`src/`、`server/`；不重冻结全局 Registry、不调用 `registry-check --write` 保存候选。
6. **禁止绕开 overlay**：Composer 必须显式使用本次 `overlayRegistryRoot`；候选缺失时明确 `FRONTEND_PACK_MISSING`，禁止静默回落到 Base 冒充候选。
7. **禁止改 Base**：页面 `.js`、服务层、控制器、主题基础样式都来自 Base；不经模型重写、不复制源码进候选包。
8. **禁止伪造确定性/证据**：不手写摘要、不写时间戳让两次渲染不同、不把未校验的 Draft 物化。
9. **禁止把 `partial` 当完成**：降级项必须写进 overlay/manifest `knownLimits` 与上报状态，等用户显式确认才可采用。
10. **禁止越界页面**：首期只 `home`/`menu`；其它页在覆盖阶段就 `rejected`，不要在这里硬写。

## 验收

- [ ] Draft 通过双侧校验：`server validateFrontendPackDraft` 与 `desktop validateDraft` 一致；未知节点/组件/事件/dataPath/样式/文本/路径全部给出稳定 `DRAFT_*` code + `$` path。
- [ ] 只出现五类节点；`styles` 为空数组；`pageJson` 只含白名单键；事件值都是本页真实 action；`textToken` 是本页 dataPath。
- [ ] 每个 slot 在生成的 WXML 中都有完整 4 段 fallback 锚点（`@slot` / `@slot-fallback` / `@slot-fallback:…:end` / `@slot:…:end`），缺一段即 `SLOT_ANCHOR_MISSING`。
- [ ] 页面 JS 逐字节来自 Base，候选包内没有 `.js` 文件；WXSS 在 Base 之后追加。
- [ ] 同一 Draft 两次渲染逐字节/摘要一致；`preview/{normal,empty,error,long}.json` 四态齐全可解析。
- [ ] 物化成功时 `overlay` 能被 Composer 原样 `loadRegistry({ verifyFreeze: true, registryRoot: overlay })` + `resolvePlan` + `buildProjectFiles` 跑通；全局冻结摘要漂移即失败。
- [ ] attempt 隔离：失败只清理本次 attempt，上一 attempt 原样保留；staging/symlink/junction 逃逸零写入。
- [ ] `git diff --quiet -- templates miniprogram` 退出码 0；候选不出现在仓库 `git status`。
- [ ] 定向测试全绿：

```powershell
node --test --test-isolation=none test/frontend-reconstruct.renderer.test.cjs test/frontend-reconstruct.workspace.test.cjs test/frontend-reconstruct.materialize.test.cjs
node --test --test-isolation=none test/composer-frontend-pack.test.cjs test/composer-resolve.test.cjs
```

- [ ] 过程报告含 runId/attempt/candidate id/version/状态/耗时；不展示绝对路径、源码或 base64。

## 失败退出

| 触发 | 退出方式 |
| --- | --- |
| Draft 结构/事实引用非法 | `MATERIALIZE_DRAFT_INVALID` + `details.draftCode`（`DRAFT_SCHEMA_INVALID`/`DRAFT_UNKNOWN_COMPONENT`/`DRAFT_UNKNOWN_EVENT`/`DRAFT_UNKNOWN_DATA_PATH`/`DRAFT_STYLE_INVALID`/`DRAFT_PAGE_JSON_INVALID`）+ `$` path；只把这些 path+code 交给受控 repair（≤8 条、≤2 轮） |
| 页面事实/快照缺失或非法 | `MATERIALIZE_FACTS_INVALID`（fail closed）；停止，不回退 WXML 猜测、不自动修复 |
| Base 可信注册表/Manifest 异常 | `MATERIALIZE_BASE_INVALID`；停止，属环境/Base 问题，交人工处理 |
| renderer 意外异常 | `MATERIALIZE_RENDER_FAILED`/`MATERIALIZE_FAILED`；不落半成品，消息截断且不含绝对路径 |
| overlay/Registry 自校验失败 | `MATERIALIZE_VERIFY_FAILED`/`OVERLAY_VERIFY_FAILED`；不提交 attempt、不采用 |
| 参数/路径不安全（仓库内根、非法 id、穿越、symlink/junction） | `WORKSPACE_*`/`MATERIALIZE_INPUT_INVALID`；零写入 |
| 页面超出 home/menu 或能力缺失 | 回到覆盖阶段 `rejected`；不生成 |
| 两轮 repair 仍失败 | 保留进入本轮前的 Draft（`keptDraft`）与上一 attempt；`adoption:'none'`，候选不可采用 |
| 无法验证（无私有目录/工具不可用） | 如实报 `BLOCKED`/`NOT_RUN`，不伪造物化成功 |

任何失败都只清理本次 attempt 的 staging/半成品；已提交的上一 attempt、全局 Registry、正式模板与镜像不得被修改。
