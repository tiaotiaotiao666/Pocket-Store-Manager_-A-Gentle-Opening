---
name: wechat-visual-spec
description: 当用户上传一张微信小程序参考截图（可附一句文字要求），需要按图重构前端、识别页面分区/组件/配色/尺寸，或在实现与评审 frontend-reconstruct.v1 视觉阶段时使用。该技能强制恰好一张 reference 图、只输出有界 UiRequirement/VisualSpec，未知区域/低置信度/不可推断交互必须如实标注；图片无法判断时输出 needs-input，截图含 Base 不支持的必需业务时输出 rejected，绝不编造业务数据或交互。
---

# 微信小程序视觉规格 Skill（一张截图 → UiRequirement / VisualSpec）

## 触发条件

- 用户上传**一张**小程序截图并要求“按图重构首页/菜单”“照着这张图改版”“识别这张截图的布局与配色”。
- 需要实现或评审 `server/src/agent/frontend-reconstruct/` 的请求解析、图片校验、UiRequirement/VisualSpec 校验或视觉提示词。
- 需要判断一张图能否进入后续能力覆盖与候选生成阶段。

不适用：

- 多图、logo/菜品图/海报素材、非小程序界面截图 → 直接拒绝，不要静默挑一张。
- 要求生成或复刻品牌图片、接入生图模型 → 明确范围外。
- 要求直接产出 WXML/WXSS/JS/WXS、执行命令或修改仓库文件 → 本链路只接受有界 JSON。
- 把 React 预览截图当成微信运行时验收 → 不属于本技能。

## 必读文件

开始前读取（不要凭记忆）：

- `docs/handoff/图片驱动前端重构-Flash实施计划.md` §2、§3.1、§3.2、§5.1
- `docs/frontend-reconstruct-contract.md` §3（请求/图片规则）、§4（UiRequirement/VisualSpec）、§8（错误码）
- `server/src/agent/frontend-reconstruct/types.ts`（`UiRequirement`、`VisualSpec`、`FRONTEND_LIMITS`）
- `server/src/agent/frontend-reconstruct/schema.ts`（`parseFrontendReconstructRequest`、`validateUiRequirement`）
- `server/src/agent/frontend-reconstruct/prompt.ts`（系统提示词与页面级边界）
- `server/src/agent/frontend-reconstruct/errors.ts`（`FRONTEND_*` 稳定错误码）
- `server/src/agent/frontend-reconstruct/capabilities.snapshot.json`（`themeTokens`/`sizeKeys`/`pageFacts` 的唯一事实源）
- `templates/base/ordering-base/1.0.0/manifest.json`、`slots.json`、`theme.tokens.json`
- 测试样例：`test/fixtures/frontend-reconstruct/reference-tiny.png`（70B）、`reference-tiny.jpg`（160B）、`requirement.valid.json`、`requirement.partial.json`
- `docs/agent-runtime.md` §4/§7（多模态消息、maxTokens、截断处理）

## 输入

唯一入口：`POST /api/v1/agent/frontend-reconstruct`（`contractVersion` 固定 `frontend-reconstruct.v1`）。请求示例：

```json
{
  "contractVersion": "frontend-reconstruct.v1",
  "requestId": "fr-0001",
  "utterance": "按截图重构首页，保留开始点餐，整体更紧凑",
  "images": [
    { "kind": "reference", "mediaType": "image/png", "dataBase64": "<单张参考图 base64>" }
  ],
  "targetPages": ["home"],
  "current": {
    "baseTemplate": { "id": "ordering-base", "version": "1.0.0" },
    "frontendPack": null,
    "presentationPatch": {}
  },
  "client": { "surface": "desktop", "phase": "frontend-reconstruct" },
  "projectId": null
}
```

硬性输入规则：

| 项 | 规则 | 失败码 |
| --- | --- | --- |
| 图片张数 | **恰好 1 张**，`kind` 只能是 `reference` | `FRONTEND_IMAGE_REQUIRED` / `FRONTEND_IMAGE_COUNT_INVALID` / `FRONTEND_IMAGE_KIND_INVALID` |
| 媒体类型 | `image/jpeg`、`image/png`、`image/webp` | `FRONTEND_IMAGE_TYPE_UNSUPPORTED`（422） |
| base64 | 标准字符表、长度 4 的倍数、0–2 个尾部 `=` | `FRONTEND_IMAGE_INVALID`（422） |
| 文件头 | 解码后必须与声明的 mediaType magic 一致 | `FRONTEND_IMAGE_INVALID`（422） |
| 单图体积 | 解码后 ≤ **409600 字节**（不信任客户端声明） | `FRONTEND_IMAGE_TOO_LARGE`（422） |
| 请求体 | UTF-8 字节 ≤ **2 MiB** | `FRONTEND_REQUEST_INVALID` / 413 映射 |
| utterance | 可空（只发图）；trim 后 ≤ **500 码点**；禁止控制字符 | `FRONTEND_UTTERANCE_INVALID` |
| targetPages | 1–2 项且不重复，仅 `home` / `menu` | `FRONTEND_TARGET_PAGES_UNSUPPORTED` |
| 当前项目 | `current.baseTemplate` 严格 `ordering-base` + 精确版本；`frontendPack` 为 null 或 `{id,version}`；`presentationPatch` ≤16 KiB | `FRONTEND_REQUEST_INVALID` |

严格未知键拒绝：顶层、`current`、`baseTemplate`、`frontendPack`、`client`、每个图片元素多一个键都会整包 400。图片只认 `dataBase64`，不接受 `agent-turn.v2` 的 `data` 别名。

## 输出（含 schema 示例）

成功响应是一个有界对象；`requirement` 是视觉规格，`coverage`/`draft` 由后续阶段补齐。`planned` 时 `draft` 必须非空，`needs-input`/`rejected` 时 `draft` 必须为 null：

```json
{
  "contractVersion": "frontend-reconstruct.v1",
  "runId": "frun-0001",
  "status": "planned",
  "requirement": {
    "summary": "首页改为紧凑单列，保留开始点餐与门店名",
    "mustKeep": [
      { "kind": "page", "ref": "page:home" },
      { "kind": "action", "ref": "action:home.goMenu" }
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
        "children": [],
        "confidence": 0.92
      }]
    }],
    "visual": {
      "theme": { "primaryColor": "#B34A0F", "pageBackground": "#F7F3EC" },
      "sizes": { "homeHero": "lg", "productCard": "md" },
      "density": "compact"
    },
    "bindings": [],
    "unknownRegions": [{ "label": "顶部右侧图标", "reason": "图形含义无法确定，未绑定任何动作" }],
    "lowConfidence": [{ "regionId": "r-header", "confidence": 0.7, "reason": "图标分辨率不足" }],
    "inferredInteractions": [{ "regionId": "r-header", "label": "点击门店名", "reason": "可见但未推定路由" }],
    "unsupported": [],
    "degradations": []
  },
  "coverage": {
    "status": "covered",
    "requiredCapabilities": ["page:home", "component:store-header", "action:home.goMenu"],
    "missingCapabilities": [],
    "coveredBy": {
      "page:home": "page:home",
      "component:store-header": "component:store-header",
      "action:home.goMenu": "action:home.goMenu"
    },
    "risks": [],
    "degradations": []
  },
  "draft": {
    "schemaVersion": "frontend-pack-draft.v1",
    "displayName": "参考图首页候选",
    "pages": [{
      "pageId": "home",
      "nodes": [
        { "type": "component", "componentId": "store-header", "props": {}, "events": {} },
        { "type": "button", "label": "开始点餐", "action": "home.goMenu" }
      ],
      "styles": [],
      "pageJson": {}
    }]
  },
  "questions": [],
  "trace": {
    "modelCalls": 2,
    "toolCalls": [{ "name": "propose_frontend_draft", "ok": true }],
    "stopReason": "final_answer",
    "degraded": false
  },
  "meta": { "provider": "deepseek", "model": "deepseek-flash", "mock": false, "latencyMs": 1200 }
}
```

`needs-input` 示例（模糊图）只保留外层与 `questions`，不产出 `draft`：

```json
{
  "contractVersion": "frontend-reconstruct.v1",
  "runId": "frun-0002",
  "status": "needs-input",
  "requirement": {
    "summary": "截图整体模糊，无法判断按钮文字与分区边界",
    "mustKeep": [{ "kind": "page", "ref": "page:home" }],
    "pages": [],
    "visual": { "theme": {}, "sizes": {}, "density": "comfortable" },
    "bindings": [],
    "unknownRegions": [{ "label": "全部卡片区域", "reason": "分辨率不足，无法确认分区" }],
    "lowConfidence": [],
    "inferredInteractions": [],
    "unsupported": [],
    "degradations": []
  },
  "coverage": {
    "status": "partial",
    "requiredCapabilities": ["page:home"],
    "missingCapabilities": [],
    "coveredBy": { "page:home": "page:home" },
    "risks": [],
    "degradations": [{ "label": "视觉证据", "reason": "截图不清晰，未生成候选", "severity": "warn" }]
  },
  "draft": null,
  "questions": [
    { "field": "screenshot.quality", "label": "截图清晰度", "text": "请重新提供清晰的首页截图，当前按钮文字和分区边界无法辨认。" }
  ],
  "trace": { "modelCalls": 3, "toolCalls": [], "stopReason": "needs_input", "degraded": true },
  "meta": { "provider": "deepseek", "model": "deepseek-flash", "mock": false, "latencyMs": 9700 }
}
```

规则与上限：

- `summary` 1–240 字符；所有文本禁止 `<`/`>`、`{{`/`}}`、`javascript:`/`vbscript:`/`data:`、`http(s)://`、反斜杠、`..`、绝对路径前缀 `/`。
- `mustKeep` 1–32 项；`{kind: page|action|data, ref}` 必须命中注入事实；每个 `targetPages` 的 `page:<id>` 必须出现。
- `pages` 0–2；`pageId` 必须在 `targetPages` 与事实内；`order` 递增；`layout ∈ single-column|two-column|grid|list|poster`；尺寸 320–1024 × 320–4096。
- 分区 `id` 为 `^[a-z][a-z0-9-]{0,31}$` 且全局唯一；`type ∈ header|hero|nav|list|grid|card|form|banner|footer|other`；每页 ≤32 节点、深度 ≤3、children ≤12；`rect` 只能是 0–1 归一化数（`x+w≤1`、`y+h≤1`）。
- `visual.theme` 只能是事实 `themeTokens` 的子集（`pageBackground/primaryColor/accentColor/textColor/tabBarBackground/tabBarColor/tabBarSelectedColor`），值 `#RRGGBB`；`visual.sizes` 只能 `homeHero|productCard|carousel`，值 `sm|md|lg`；`density ∈ compact|comfortable`。
- `bindings` 0–64：`status=bound` 时恰好一个 `dataPath` 或 `eventName` 且命中事实；`status=unknown` 时两者都不能有。
- `inferredInteractions` 只描述“看到什么交互”，禁止出现动作名、能力前缀或 `/pages/` 路由。
- `unknownRegions` / `lowConfidence` / `inferredInteractions` / `unsupported` / `degradations` 上限分别为 24/24/16/16/16。

三种参考结果必须严格区分：

| 图像情况 | 结论 | 要求 |
| --- | --- | --- |
| 清晰、Base 能力内 | `planned` | `requirement.pages` ≥1、coverage 为 covered/partial、`draft` 非空（由后续阶段产出） |
| 模糊、按钮文字/分区边界看不清 | `needs-input` | `draft=null`；`questions` 至少 1 条具体问题；不生成候选 |
| 明确出现 Base 不支持的必需业务（直播/优惠券/转盘/客服/积分等） | `rejected` | `draft=null`；`coverage.status=rejected` 且 `missingCapabilities` 非空；不写 workspace、不 Composer、不编译 |

`questions` 是 `{field,label,text}`，≤8 条，`label` ≤64、`text` ≤200。`meta.model` 在 `mock=false` 时必须为实际模型名。

## 禁止项

1. **不接生图、不复刻品牌**：不生成/复刻品牌图片、logo、对方文案；图内文字只用于理解结构，不作为业务数据、菜单名、价格或事件名。
2. **不猜不可见能力**：隐藏手势、网络请求、路由跳转、扫码/支付/订单状态规则、权限、后台能力一律不推断；没有依据就进 `unknownRegions`/`lowConfidence`/`unsupported`/`degradations`。
3. **不写源码**：不输出 HTML/WXML/WXSS/JS/WXS、CSS 原文、外部 URL、绝对路径、`import`、`{{}}` 或任何命令；只输出本文件声明的有界 JSON。
4. **不决定覆盖结论**：模型只能提交 requirement/requestedCapabilities；`covered/partial/rejected` 由服务端按真实事实计算（见 `wechat-capability-coverage`）。不要自行填写 `covered`。
5. **不伪装图片**：不伪造 mediaType、base64、文件头或字节数；多图/非 reference 不静默接受。
6. **不泄漏**：日志、响应、fixture、报告不写 API Key、base64 图片正文、完整 prompt、原始模型响应、本机绝对路径。
7. **不在服务端写文件/起进程**：视觉阶段只读图片与事实，不写仓库源码、不执行 shell、不改全局 Registry/模板。
8. **不把 `partial` 当验收通过**：降级必须显式进入 `degradations` 并让 coverage 成为 `partial`，等用户确认。

## 验收

- [ ] 请求恰好一张 `reference`；JPEG/PNG/WebP 通过；伪 base64、文件头不符、解码超 409600 字节、多图、非 reference 全部按稳定错误码拒绝。
- [ ] 空 utterance（只发图）合法；超长/含控制字符被拒绝。
- [ ] `targetPages` 只出现 `home`/`menu`；未知页、重复页被拒绝。
- [ ] Requirement 的 id/order/rect/深度/children/文本黑名单/theme token/size/density 全部符合本文件上限；引用不存在的 `mustKeep`/`binding`/theme/size 一律 422 `FRONTEND_REQUIREMENT_INVALID`（错误详情只带 `$` 路径）。
- [ ] 清晰图 → `planned`（有 requirement，draft 由后续阶段产出）；模糊图 → `needs-input` 且 `draft=null`；含不支持必需业务 → `rejected` 且 `draft=null`。
- [ ] 响应/日志/测试 fixture 不含 base64、prompt、原始模型响应或绝对路径。
- [ ] 服务端截断（`finish_reason=length` 或字符裁剪）时直接 `FRONTEND_MODEL_RESPONSE_INVALID`，**不解析残片**。
- [ ] 定向测试全绿（先红后绿，不改断言语义）：

```powershell
Set-Location server
npx vitest run --configLoader native --pool=threads test/frontend-reconstruct.contract.test.ts test/frontend-reconstruct.service.test.ts
npx tsc -p tsconfig.json --noEmit --incremental false
Set-Location ..
```

- [ ] 真实模型调用属于可选证据：没有可用密钥/未执行时在报告中如实写 `NOT_RUN`，不得用 mock 结果冒充真实视觉理解。

## 失败退出

| 触发 | 退出方式 |
| --- | --- |
| 图片缺失/多图/非 reference/类型/base64/超限 | 返回对应 `FRONTEND_IMAGE_*` 稳定码，不进入模型调用；不创建候选 |
| utterance 非法 | `FRONTEND_UTTERANCE_INVALID`，不改写用户文本 |
| requirement 单字段非法 | 422 `FRONTEND_REQUIREMENT_INVALID` + `details.path`；让模型只修该字段后重试，不放松校验 |
| 模型输出非法/截断 JSON | 502 `FRONTEND_MODEL_RESPONSE_INVALID`，不产出 requirement/draft |
| 看不清、无法判断 | 输出 `needs-input` + 具体 questions；**禁止**编造 planned 或猜按钮 |
| 多图/非截图/要求生图或源码 | 明确拒绝并说明范围；不走本链路 |
| 依赖的能力快照缺失/非法 | `FRONTEND_FACTS_INVALID`（fail closed），不猜测事实 |
| 无法验证（无密钥、工具不可用） | 在报告写 `BLOCKED`/`NOT_RUN` 与原因，并保留输入；绝不写成通过 |

失败时只返回稳定 `code` + 有界 `message` + 结构路径；不回填用户原话、base64、prompt、原始响应或堆栈。
