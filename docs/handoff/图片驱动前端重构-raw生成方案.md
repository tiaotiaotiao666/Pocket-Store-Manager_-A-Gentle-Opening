# 图片驱动前端重构：私有候选源码改造方案（修订版）

> 状态：**方案，未实现**。修订日期：2026-11-23。目标范围：Base 全 8 页，首个垂直切片只做 `menu + product-card`。
>
> 用户已明确授权：**为了按参考图实现新前端，可以修改小程序前端源码，不应再用“架构不允许改源码”否定需求。**
>
> 本方案允许修改的是候选工程中的页面、组件及必要的纯 UI 控制器源码；不把业务服务、订单状态机或后端契约伪装成“前端调整”。
>
> 兼容原则：现有 `frontend-reconstruct.v1` 与 `frontend-pack-draft.v1` 保持不动；新增 `frontend-reconstruct.v2` 和独立源码候选资产，不污染 v1 语义。
>
> 事实依据：`templates/base/ordering-base/1.0.0/src`、`templates/catalog`、`scripts/composer/emit.cjs`、`desktop/frontend-reconstruct`、`server/src/agent/frontend-reconstruct`（2026-11-23 只读核对）。

---

## 0. 评审结论

原方案的方向——突破五节点 DSL、保留 v1、逐页生成、静态门禁、私有 attempt、真实微信验证——是正确的，但**不建议按原稿直接实施**。它仍然只是“模型直出页面三件套”，不是充分的前端源码改造，且有六处关键缺口：

| 原设计 | 问题 | 修订决策 |
|---|---|---|
| 每页只生成 `wxml/wxss/pageJson` | 页面 WXSS 不能可靠修改默认样式隔离的组件内部；`product-card` 等主体视觉仍改不动 | 允许候选覆盖页面与现有组件的 WXML/WXSS；纯 UI JS 后续受控开放 |
| `styleMode: append/replace` | 追加会样式打架，整页替换又无法解决组件内部样式；模型从空白重写易丢状态 | 模型读取 Base 最终文件并返回**修改后的完整文件**，Composer 计算差异并原子覆盖，不增加 `styleMode` |
| 把 raw 继续塞进 `frontend-pack.v1` | 该 Manifest 明确只允许页面三件套，`boundary` 也锁定视图层；继续扩展会形成同名异义 | 新增独立 `frontend-source-bundle.v1` 资产和 Plan 引用，不复用 v1 Pack 语义 |
| 服务端 lint 后，在桌面 dry-run 再修复 | 一次服务端 Agent 会话拿不到后续本地 Composer/微信问题，修复闭环没有真正闭合 | 由桌面主进程做总编排：本地门禁 → 有界 issue → 再次请求服务端修复 → 新 attempt |
| 每页 6000–8000 tokens，8 页统一预算 | `merchant-orders` 源码与 WXSS 很容易截断；14 次调用也不足以覆盖 8 页各自 2 轮修复 | 单页独立预算，按实际文件估算 token；修复只返失败文件，不把 8 页作为一个事务 |
| `mini:check + source-lint` 被当成编译保证 | 它能提前发现问题，但不等于微信编译，也不能证明关键业务动作仍可用 | 明确分为静态检查、真实编译、交互回归、视觉核对四层证据 |

**修订后的核心不是“安全限制更少”，而是“可修改的产物更完整，业务边界更清楚”。** 布局、层级、循环、条件、样式和本地图片表达全部放开；模型仍不能提供命令、输出目录、网络请求或业务服务实现。

---

## 1. 已核对的真实现状

### 1.1 当前能力缺口

- v1 能力快照只含 `home/menu`，现有 10 个组件、4 个插槽、25 个动作、21 个数据路径只是**快照投影**，不是组件库全部事实。
- `loading-block`、`order-status`、`status-timeline`、`pay-result` 已有 Base 实现，不是“组件库缺实现”；`poster-carousel` 是独立资产且被 Base Manifest 排除，不能混称为 Base 内置组件。
- Base Manifest 当前列出 14 个内置组件。组件卡已包含 props/events、真实源码路径、示例和限制，可直接作为生成上下文，无需重新发明组件。
- `checkout`、`mine` 等页面主体确实是手写 WXML，所以“是否已有同名组件”只能是信息项；业务动作、数据、页面能力才是生成前的阻断依据。
- Composer 当前只执行“WXML 替换、页面 WXSS 追加、JSON 受限合并”；Base 页面控制器 JS 始终保留，Base 同名组件不会被 `Plan.components` 替换。
- `frontend-pack.v1` 的 schema 只允许 `pages/<pageId>/index.{wxml,wxss,json}`，不能靠悄悄多写几个文件完成组件源码覆盖。
- pack 的 `entry.assets` 当前没有被 Composer 复制；仅 feature-pack 有资产复制逻辑。
- `mini:check` 已做标签配对、组件路径、handler、部分表达式和 WXSS 检查，但没有完整数据作用域校验，更不是微信编译器。

### 1.2 本次授权改变的边界

| 位置 | 是否允许修改 | 说明 |
|---|---|---|
| 私有 attempt 中的页面 WXML/WXSS/JSON | **允许** | 本方案主路径 |
| 私有 attempt 中的现有组件 WXML/WXSS | **允许** | 复用现有 props/events，按影响范围生成共享覆盖或页面变体 |
| 私有 attempt 中的组件纯 UI JS | **后续受控允许** | 只允许展示派生、UI 状态和原有事件，不允许网络、路由、业务事实 |
| 页面业务控制器 JS | 首期不自动生成 | 保留登录、购物车、下单、支付、接单、导航等现有接线；确需新业务能力另立任务 |
| `services/**`、`domain/**`、`state/**`、后端 | 不允许由本链路修改 | 不是视觉重构，不得借参考图改变订单/API 事实 |
| 正式 `templates/**`、全局 Registry | 不由模型或候选流程直写 | 正式入库仍需人工采用后的既有资产流程 |
| `miniprogram/**` | 不手改 | 它是只读镜像；真源仍是 Base，交付物来自 Composer 导出 |

“不改全局 Base”不等于“不能改源码”：**候选副本就是可真实编译、可真实导出、可回滚的源码改造单位。**

---

## 2. 目标与输入语义

### 2.1 目标

一张页面参考图 + 可选文字要求，生成一个可编译候选：

1. 复用 Base 真实业务数据、事件和现有组件实现；
2. 修改目标页面及必要的组件源码，而不只换主题色；
3. 保留正常、加载、空、错误、长内容等状态；
4. 保留关键动作与既有插槽；
5. 候选、采用、重开、导出使用同一份源码与摘要；
6. 微信不可用时如实为 `partial/BLOCKED`，不宣称验收通过。

### 2.2 一张图只锚定一个页面

v2 使用单数 `targetPage`。一张首页截图不能作为其余七页的视觉事实，也不能默认“一次生成 8 页”。

- 支持的目标页仍是全 8 页：`home/menu/checkout/orders/order-detail/product-detail/mine/merchant-orders`。
- 每次运行只生成一个目标页及其必要组件；用户可继续上传其他页面图，在同一项目的不同 attempt 中逐页完善。
- 跨页风格复用只能作为后续“沿用已采用设计 Token/组件变体”的显式操作，不伪称从一张图识别了其他页面。
- 首个垂直切片：`menu` + `product-card`，验证“页面与组件都能改、加购与结算不回归、采用后导出同源”。通过后再复制流水线，而不是先造 8 页空壳。

---

## 3. 修订后的总体架构

```text
上传一张页面图，选择 targetPage
  → 服务端视觉分析：区域、布局、文字、视觉样式、未知项
  → 本地权威能力覆盖：页面/动作/数据/组件/插槽
       L1 缺业务能力：rejected 或明确降级，不伪造实现
       L2 缺同款视觉组件：不阻断，用原生视图或现有组件表达
  → 本地生成“页面事实包”
       Base 页面最终三件套
       相关组件真实源码 + props/events + 使用示例
       本页 data/setData 访问器、事件签名、关键动作、插槽
  → 服务端单页源码生成（完整最终文件，不是 AST，也不是自由命令）
  → 共享 source-check：语法/作用域/事件/组件契约/资产/业务边界
  → 桌面私有 attempt：Base 内存文件图 + SourceBundle overlay
  → Composer + mini:check + 页面接线/契约回归
  → 失败：只将失败文件与有界 issues 送回修复，另起 attempt，旧版不覆盖
  → 微信真实编译与关键链路 automator（可用时）
  → 截图回填后做定向视觉修复（后续增强，不伪称首轮像素一致）
  → 用户采用/撤销 → 同一 overlay 正式导出
```

### 为什么由桌面主进程编排

模型和服务端都无法在一次 HTTP 请求里看到之后的本地 Composer、微信编译和截图结果。由桌面主进程持有 `runId/attempt/revision`，才能形成真实闭环。服务端只做无状态或有界会话内的分析/生成/修复，不假装知道本地结果。

---

## 4. 新契约与资产模型

### 4.1 保持 v1 冻结

- 不修改 `contracts/frontend-reconstruct.v1.json` 的枚举、默认值和 39 例 parity 语义。
- 新增 `contracts/frontend-reconstruct.v2.json`，由 `scripts/frontend-contract.cjs` 生成独立的 `contract.v2.generated.ts/cjs`。
- 新请求显式使用 `contractVersion: "frontend-reconstruct.v2"`；旧请求继续走 DSL，不增加含义含混的 `draftMode` 自动探测。

### 4.2 生成载荷

建议 schema 名：`frontend-source-draft.v1`。模型提交虚拟路径和**最终完整内容**：

```json
{
  "schemaVersion": "frontend-source-draft.v1",
  "targetPage": "menu",
  "baseRevision": "ordering-base@1.0.0:<digest>",
  "files": [
    { "path": "pages/menu/index.wxml", "content": "<view>...</view>" },
    { "path": "pages/menu/index.wxss", "content": ".menu {...}" },
    { "path": "pages/menu/index.json", "content": "{\"usingComponents\":{...}}" },
    { "path": "components/product-card/index.wxml", "content": "<view>...</view>" },
    { "path": "components/product-card/index.wxss", "content": ".product-card {...}" }
  ],
  "componentScopes": [
    { "componentId": "product-card", "scope": "page", "pages": ["menu"] }
  ],
  "assetRefs": [],
  "degradations": []
}
```

约束：

- 页面三件套必须完整返回；组件只返回确实需要修改的文件，但每个被修改文件都是完整内容，不接受 `diff/patch` 文本。
- `path` 只能来自服务端为该页开放的虚拟文件集合，不能由模型创造任意路径。
- 不允许模型提交二进制/base64；图片只能引用用户已上传并经本地解码验证的 `assetId`。
- `baseRevision` 不一致即拒绝，防止拿旧底稿覆盖新 Base。
- 候选落盘前由本地把虚拟组件路径映射为共享覆盖或确定性的页面变体；模型不提供真实输出目录。

### 4.3 新资产而不是扭曲 FrontendPack v1

新增 `frontend-source-bundle.v1` Manifest、Registry kind `frontend-source` 和 Plan 字段：

```json
"frontendSource": { "id": "frs-...", "version": "1.0.0" }
```

Manifest 至少记录：

- Base id/version/digest；
- 目标页与完整文件清单、逐文件 sha256、整树摘要；
- 组件覆盖范围（`shared` 或 `page`）及受影响页面；
- 原始 Base 文件摘要与候选最终摘要；
- 资产映射、保留的插槽、关键动作、静态/运行时证据；
- `release.stage = candidate`，验证不足不得晋升 `online-ready`。

现有 `plan.frontendPack` 和 v1 Registry overlay 原样保留；v2 的采用记录增加 `frontendSource` 身份，不复用 kind 检查来假装两者相同。

### 4.4 操作拆分与预算

v2 请求使用明确的 `operation`：

1. `analyze`：返回视觉 requirement/coverage，不生成源码；
2. `generate`：针对一页生成最终文件；
3. `repair`：输入目标文件、上一次源码、服务端认可的本地 issues，只返回需修复的最终文件。

预算按“项目 run 总账 + 单文件上限”计算，而不是全 8 页共享 240 秒：

- 每页首轮 1 次生成，最多 2 次定向修复；
- 修复只带失败文件及必要上下文，不重发整个工程；
- `maxOutputTokens` 按 Base 文件大小与允许增幅估算，并设置契约硬上限；返回 `length/truncated` 直接失败，不解析残片；
- 单页超限时可按“页面三件套”和“单组件文件”拆成确定性子任务，不能中途拼 JSON 字符串；
- 失败页不阻断其他已采用页面，也不覆盖上一可用 attempt。

---

## 5. 页面事实包：直接利用组件库现实实现

不要再只给组件名和少量数据 token。每页由确定性生成器产出以下只读上下文：

| 内容 | 来源 | 用途 |
|---|---|---|
| 页面 Base 三件套 | Base 真源 | 在现有状态、事件、插槽之上改，而非空白重写 |
| data 初始形状、`setData` 字面路径、常用嵌套字段 | 页面 JS 静态提取 + 人工校验快照 | 校验 `{{}}` 根和嵌套访问，不只收集旧 WXML 已用字段 |
| 页面公开 handler 与事件读取方式 | 页面 JS + 页面目录 | 保留 `event.detail`、`dataset` 等接线 |
| 组件完整四件套或请求的文件 | Base 组件真源 | 修改真实实现，保留展示派生和事件 |
| props/events/示例/限制 | `templates/catalog/components` | 避免猜 props、事件名和金额规则 |
| 页面组件/插槽/关键动作 | Base Manifest + 页面目录 + Recipe | 防止删关键业务与静默丢 Feature Pack |
| 可用本地资产 | 用户上传后的私有资产清单 | 图片引用，不接受模型造 URL |

快照分为 v1 DSL 投影和 v2 SourceFacts，二者不互相改语义。v2 必须包含 `loading/error/submitting` 等真实 UI 状态，否则模型只能通过删除状态来“美化”。

生成策略是**底稿编辑**：提示词要求保留未要求改变的结构和接线，只改变参考图需要的布局与样式。完整文件返回是为了避免模型生成脆弱 unified diff，并不要求它从零写所有代码。

---

## 6. 页面、组件与样式的修改规则

### 6.1 页面

允许：

- 原生 WXML 标签、嵌套、`wx:for/wx:if/wx:elif/wx:else`、本地图片和微信内置表单/滚动组件；
- 任意合法 WXSS 布局、尺寸、颜色、层级、背景与安全区表达；
- 使用本页已声明或 SourceFacts 明确兼容的 Base 内置组件；
- 保留并移动既有插槽锚点；
- 修改页面 JSON 的导航/背景/下拉配置和真实 `usingComponents`。

不允许：

- 新增不存在的业务数据或 handler；
- 通过 WXML 表达式伪造金额计算、权限、支付结果或订单状态；
- 擅自改路由、页面注册、tabBar、网络域名和全局配置。

### 6.2 组件

默认保持现有 `properties + observers 对外行为 + triggerEvent 名称/detail` 不变，允许修改组件 WXML/WXSS。这样 `product-card` 可以真正改成参考图样式，同时仍由 `menu.onProductAdd/onProductRemove/onOpenDetail` 处理业务。

组件覆盖必须显式区分：

- `page`：默认。Composer 从 Base 组件复制为确定性候选变体，只改目标页 `usingComponents`，不影响其他页面；变体目录与 Base 保持相同相对深度，原有纯展示 `require` 可安全解析。
- `shared`：确需多页统一修改时才用，UI 必须列出受影响页面并由用户确认；所有引用页都跑编译和回归。

首期不自动生成新的业务组件；可复用全部真实 Base 组件，不局限于该页旧 `usingComponents`。Feature/UI Block 仍按可信 Registry 与插槽规则使用。

### 6.3 纯 UI JS 的开放条件

首个 `menu + product-card` 切片只改 WXML/WXSS，先证明主链。后续确有需要时允许组件 `index.js`，但必须：

- AST 解析并比较 props/events 公共契约；
- 只允许展示格式化、纯 UI data/observers、`setData/triggerEvent/createSelectorQuery`；
- 禁止新增 `require` 服务/页面/后端模块，禁止网络、存储、路由、`globalData`、动态执行和权限判断；
- 金额、库存、订单状态等业务事实不得新增第二份计算；
- 运行现有组件 Node 测试及受影响页面测试。

页面业务 JS 若确需改动，应另立“页面接线变更”任务和测试，不混入图片重构的首期自动链路。

### 6.4 不再引入 `styleMode`

候选页 WXSS 是基于 Base 底稿产生的最终完整文件，Composer 直接替换该页文件；组件 WXSS 同理。这样不存在 Base 旧规则残留，也不需要全局 append/replace 开关。全局 `app.wxss/theme.generated.wxss` 仍按原 Composer 流程生成。

---

## 7. Composer 与私有工作区改造

### 7.1 执行顺序

在 `buildProjectFiles` 中按以下顺序处理：

1. 读取可信 Base 到内存 `files`；
2. 校验 SourceBundle 的 Base digest、文件清单和每个补丁；
3. 应用页面/组件最终文件覆盖及页面变体；
4. 复制并映射候选本地资产；
5. 处理既有 feature slot 注入；
6. 根据最终 WXML 重算 `usingComponents`，保留真实组件路径；
7. 运行完整静态、接线和输出一致性检查，生成 Lock/report。

dry-run、采用后的重开与正式导出必须调用同一实现，禁止预览一套覆盖、导出另一套。

### 7.2 差异与证据

Composer 不只是复制文件，还要生成 `source-changes.json`：

- `added/modified/unchanged` 文件；
- Base/候选摘要；
- 页面与组件影响范围；
- 保留的关键 handler、数据绑定、slot；
- 被丢弃或降级的要求及原因。

未修改文件不得因格式化产生伪差异。相同 Base + SourceBundle + Plan 必须得到相同树摘要。

### 7.3 资产

- 仅接受用户主动上传的 PNG/JPEG/WebP，本地校验真实魔数、尺寸、数量与字节上限；模型只提交 `assetId`。
- 输出路径由 Composer 确定为 `/assets/frontend-source/<candidateId>/<assetId>.<ext>`，并回写受控引用。
- 禁止外链静态资源和模型提供的 data URI；动态业务图片如 `{{product.imageUrl}}` 仍按现有后端与微信域名机制处理，不能用粗暴 `http` 正则误杀。
- 初版不接受模型生成 SVG；已有可信 Base SVG 原样复制，不影响现状。

### 7.4 插槽不静默丢弃

如果当前 Plan 已为插槽分配 Feature Pack，候选缺少该锚点应是 `SLOT_REQUIRED_BY_PLAN` 阻断项；只有用户明确选择“移除该功能”才可降级。不能像原 D5 一样自动丢弃已配置业务再只记一条 degradation。

---

## 8. source-check：有效的静态门禁，而不是伪编译器

共享实现建议放在 `scripts/frontend-source/`，服务端与桌面通过同一 CJS 模块/同一 fixtures 执行，Composer 最后再次执行。规则源码只进受控校验上下文，不进聊天过程卡或日志正文。

| 类别 | 必查内容 |
|---|---|
| WXML AST | 标签/属性/注释闭合，非法标签，重复属性；不能只靠正则 |
| 表达式 | 微信支持子集；禁函数调用、赋值和动态执行；检查字符串中的 URL 与真实代码要分开 |
| 数据作用域 | 全部 `{{}}`，含文本、属性、条件、循环；支持嵌套 `wx:for-item/wx:for-index` 局部作用域与 `item/index` 默认值 |
| 数据形状 | 根属于本页 data/setData facts；已知对象字段、组件 props 类型和数组项字段尽量校验，未知形状给有界警告而非编造 |
| 事件 | `bindtap/bind:tap/catch/capture` 等形式；handler 必须存在，组件事件必须与目录一致，关键动作不得丢 |
| 组件 | 标签已声明、目标文件真实存在、props/events 兼容、页面变体路径由 Composer 生成 |
| JSON | 严格解析、允许键和类型、组件路径闭合；禁止任意 app/tabBar 配置 |
| WXSS | AST/括号/注释/字符串检查，禁外部 `@import` 和外链静态 URL；允许合法本地资源 |
| JS（后续） | AST 公共契约、允许 API、禁网络/路由/存储/globalData/eval/Function/任意 require |
| 文件与资产 | 路径白名单、字节/数量上限、真实类型、声明闭合、无 symlink/穿越 |
| 业务保留 | 每页关键动作、必需状态、必需插槽、原有服务/领域/state 文件逐字节不变 |

本地 lint 失败只返回 `{code,file,line,column,path,message}`，message 截断且不包含整份源码、绝对路径、prompt 或密钥。

**通过 source-check 只能称“静态检查通过”，不能称“微信编译通过”或“页面可完整使用”。**

---

## 9. 关键业务回归

每页定义机器可读 `page-contract`，至少包含必需数据、handler、状态、路由出口和核心交互。首版关键集合：

| 页面 | 不得退化的核心链路 |
|---|---|
| home | 进入菜单、门店/履约信息、已配置插槽 |
| menu | 分类、详情、加/减购、购物车、桌号、`onCheckout` |
| checkout | 商品明细、桌号、备注、`onSubmit`、重复提交保护、错误重试 |
| orders | 列表、筛选/分页、打开订单、可用订单动作 |
| order-detail | 状态/时间线、演示支付及订单操作 |
| product-detail | 详情展示、加/减购、购物车与结算入口 |
| mine | 身份与门店资料、身份切换及已有入口 |
| merchant-orders | 列表/筛选、接单、推进状态、商品管理相关既有动作 |

验证分三层：

1. 静态接线：handler 存在、事件 detail 兼容、关键节点未被无条件移除；
2. 现有 Node 组件/领域测试 + 新增页面交互测试：尤其加购、结算、提交、接单；
3. `miniprogram-automator` 真实点击与截图：正常、空、错误、长文本，至少一条端到端下单链路。

静态扫描不能证明按钮在运行时可见或可点，最终状态必须分别记录 `PASS/FAIL/BLOCKED/NOT_RUN`。

---

## 10. 实施拆分

### M0：基线与单页事实（0.5–1 人日）

- 固化 Base/Registry 当前可用基线，记录已有 catalog/mirror/微信环境失败，不用 `--write` 掩盖。
- 生成 `menu + product-card` SourceFacts、page-contract 与基准源码摘要。
- 验收：事实与源码同源，关键 data/handler/props/events 无遗漏。

### M1：SourceBundle + Composer 垂直切片（2.5–3.5 人日）

- 新 v2 契约骨架、独立资产/Plan 引用、文件覆盖、页面组件变体、资产复制、差异报告。
- 先用**人工构造**的 menu/product-card SourceBundle，不接模型，验证改页面与组件、加购结算、采用导出。
- 验收：手工候选 dry-run 全绿；原 v1 Composer fixtures 不变；重开导出摘要一致。

### M2：共享 source-check + 服务端单页生成（3–4 人日）

- 8 页 SourceFacts 生成器可复用，但只开放 menu；
- analyze/generate/repair 操作、完整文件响应、截断检测、日志脱敏；
- AST 检查、数据作用域、事件/组件契约与修复 issue。
- 验收：真实模型至少多次生成均可静态通过；失败能定向修复，失败不覆盖旧版。

### M3：组件覆盖、纯 UI 扩展与运行时闭环（2.5–4 人日）

- 完成共享/页面组件影响测试；按需开放纯 UI JS；
- 微信 CLI 固定入口编译、automator 核心链路、正常/空/错/长四态截图；
- 根据真实截图做一轮定向修复（仍受总轮次限制）。
- 验收：微信可用时 menu 真实通过；不可用时明确 `BLOCKED/partial`。

### M4：逐页扩展（4–6 人日）

- 顺序：`checkout` → `home` → `orders/order-detail` → `product-detail/mine` → `merchant-orders`。
- 每页先补 SourceFacts/page-contract/交互 fixture，再开放生成，不把“枚举加了 8 页”当完成。
- `merchant-orders` 单独做事实裁剪、token 压力和完整状态流回归。

### M5：UI、采用迁移与文档（1.5–2 人日）

- 候选面板展示目标页、修改文件、组件影响范围、降级和真实证据；提供受控源码 diff 查看入口，不在聊天卡倾倒源码。
- v2 adoption 持久化、撤销、重开、导出、旧 v1 项目兼容。
- 更新 AGENTS、契约说明、交接与证据。

**总估算：14–19 人日**（不含等待微信环境和大规模视觉调优）。原 6.5–8.5 人日只够页面三件套原型，无法覆盖本修订版的组件源码、修复闭环和采用导出。M0–M2 可形成约 6–8.5 人日的 menu 可用切片；不应以“3 人日全链路”作为承诺。

---

## 11. 测试与验收清单

### 11.1 兼容与确定性

- [ ] v1 39 例 parity、现有 DSL renderer、FrontendPack overlay 和旧项目采用行为不变。
- [ ] v2 不改变 Base/全局 Registry/miniprogram 镜像；输入 Base digest 漂移时拒绝。
- [ ] 同输入重复生成相同文件树、Lock 和 export 报告。
- [ ] 页面与 page-scoped 组件变体只影响目标页；shared 覆盖列出并验证全部受影响页。

### 11.2 静态与负例

- [ ] WXML/WXSS/JSON AST 正负例，循环局部变量、嵌套访问、所有事件写法均被覆盖。
- [ ] 未知绑定/handler/组件、篡改组件事件、删关键动作、越权 JS、路径穿越、外链、伪图片均拒绝。
- [ ] `product.imageUrl` 等合法动态业务图片不被静态外链规则误杀。
- [ ] Plan 已分配插槽缺失时阻断，不静默丢 Feature Pack。
- [ ] 模型截断、超页、超预算、2 次修复失败均无新可用候选，上一 attempt 保留。

### 11.3 首个垂直切片

- [ ] 人工 SourceBundle 能同时改变 `menu` 页面和 `product-card` 内部视觉，而非只覆盖页面外壳。
- [ ] 分类、详情、加减购、购物车、桌号和结算接线回归通过。
- [ ] 正常/空/错误/长文本没有空白、未解析 `{{}}`、明显固定高度裁切。
- [ ] 采用 → 撤销 → 重开 → 正式导出均使用同一 SourceBundle 与摘要。

### 11.4 全 8 页

- [ ] 每页各有自己的参考图、page-contract 和真实生成记录；不能用一张 home 图替代 8 页验收。
- [ ] checkout 提交、order-detail 演示支付、merchant-orders 接单/推进等动作不被视觉修改破坏。
- [ ] 缺业务能力时 rejected/明确降级且不伪造实现；缺视觉组件不机械拒绝。
- [ ] 每页模型调用、修复、静态检查、编译、交互、截图证据可独立追溯。

### 11.5 真实性与环境

- [ ] source-check/mini:check 只写“静态通过”，不冒充微信编译。
- [ ] 微信 CLI 不可用则运行时 `BLOCKED`，候选最多 `partial` 且采用需显式确认。
- [ ] 不使用 React 截图冒充微信截图，不把 dry-run 当视觉达标。
- [ ] 既有 catalog/mirror/DB 基线失败单独列出，不用生成器重写快照掩盖。

---

## 12. 风险与回滚

| 风险 | 处理 |
|---|---|
| 模型返回超长或漏文件 | 完整文件 schema + base digest + token 估算 + 按文件子任务；残缺不解析 |
| 为追求视觉删除状态/业务按钮 | page-contract + 关键动作静态检查 + 真实交互回归 |
| 修改共享组件波及其他页面 | 默认页面变体；shared 明示影响并全量回归 |
| 模型猜数据/事件 | 提供 Base 底稿和完整 SourceFacts；lint 不通过即定向修复 |
| 本地 dry-run 与服务端修复脱节 | 桌面主进程统一 run/revision/issues 编排，修复结果新建 attempt |
| 视觉首次生成不一致 | 真实截图回填后一轮定向修复；不承诺首轮像素级复刻 |
| v1/v2 双链维护 | 契约/资产/Plan 字段分离，共享底层门禁，v1 默认不变 |
| 本机微信仍 BLOCKED | 不虚构 PASS；M1 人工 bundle 先证明 Composer，运行时另补环境验收 |

回滚以 attempt 和采用记录为单位：撤销 v2 `frontendSource` 即回到此前 Plan/Base/v1 Pack；不修改全局 Base，不需要靠 Git 回滚用户资产。

---

## 13. 最终决策

1. **采纳原方案的 v1 冻结、逐页生成、私有工作区、结构化修复与真实验证口径。**
2. **否决“只生成页面三件套 + styleMode 就完成前端源码改造”的设计。**
3. 实施从 `menu + product-card` 的人工 SourceBundle 垂直切片开始，先改通 Composer，再接模型；不要先写 8 页 prompt。
4. 组件库已有实现必须直接复用；能力快照缺项只是事实投影问题，不应重造已有组件。
5. 本链路可以真实修改前端源码，但不借视觉需求篡改业务服务、订单事实或后端契约。
6. 首个可交付目标不是“8 页都能返回文本”，而是“一个页面的页面与组件源码确实改变、业务仍可用、采用与导出同源”。
