# Agent 草稿实时驱动小程序预览统一计划

- 功能名：`agent-realtime-preview`
- 计划修订：P1
- 目标路径：`.codeartsdoer/plans/agent-realtime-preview/plan.md`

## 1. Requirements
### R1 完整 turn 的未确认草稿实时闭环
- When 一个 `agent-turn.v1` 完整响应经现有 transport、normalize/validate 和 `AGENT_TURN_SUCCESS` 接受，the 预览 shall 在下一次 React 提交中反映该响应草稿的 `storeName/category/businessHours/fulfillment/dishes`，不得等待店主确认，也不得以 `readyForReview` 为投影门槛。
- When 草稿菜品包含合法名称与整数 `priceCents`，the 预览 shall 以菜品草稿替换示例商品，并以整数分格式化价格；缺名或非整数价格的菜品不得进入展示列表。
- While 草稿仍缺项或存在字段错误，the 预览 shall 仅展示可安全投影的字段，并对其余字段使用既有示例或明确的待完善文案，不得伪造完整资料。
- When 同一草稿同时用于 compact 与 full 预览，the 两种尺寸 shall 展示一致的门店、商品、营业时间与履约事实，仅允许数量和布局密度不同。

### R2 唯一声明式预览投影与既有视觉能力
- The 预览 shall 由唯一、纯白名单的 ViewModel 驱动，展示数据不得由各 tab 或 compact/full 分支分别硬编码。
- The 预览 shall 保留 `home/menu/orders/mine` 四种 tab、`menu/catalog/editorial` 三种布局、主题色、商品渐变缩略图及 tab 切换能力。
- When 商品或 tab 被渲染，the 预览 shall 使用稳定且唯一的 React key；不得使用数组下标作为商品 key。
- The 系统 shall 将该能力称为 React DOM 视觉近似预览，不得宣称其为真实 WXML/WXSS、微信运行时或原生编译结果。
- The ViewModel 边界 shall 允许后续以新适配器接入经校验的展示修改，但本轮不得提供模板、主题或布局的 Agent 修改入口。

### R3 请求、失败、过期响应与编辑状态
- While Agent 请求处于 `requesting`，the 预览 shall 保留最近一次已接受草稿，不得提前展示未完成响应或清空为初始状态。
- If Agent 传输失败或响应的结构/契约校验失败，then the 预览 shall 保留最近一次已接受草稿，且现有错误与手动重试行为保持可用；`readyForReview=false` 本身不属于失败。
- If 成功或失败响应的本地请求标识与当前活动请求不一致，then the 状态机 shall 忽略该过期响应，预览、草稿、消息和错误状态均不得改变。
- When 用户手动编辑未确认草稿，the 预览 shall 按同一投影规则更新；非法编辑值不得绕过金额、营业时间或长度约束形成不安全展示。
- When 当前 tab 因草稿更新而重新渲染，the 预览 shall 尽量保留当前 tab；只有组件生命周期结束才允许重置 tab 状态。

### R4 确认、重新打开与持久化兼容
- When 未确认草稿驱动预览，the 系统 shall 不提前修改 confirmed `store/build/visual`，不得改变现有导出、发布或确认门槛。
- When 店主确认草稿，the 系统 shall 保持现有确认语义，仅按既有规则晋升 `storeName/category` 到 `store`，其他资料继续保留在 `agentDraft`。
- When 店主重新打开已确认草稿并修改，the 预览 shall 展示最新草稿，而已确认 `store` 在新一次确认前保持不变。
- When 旧项目快照或未确认草稿被重新打开，the 系统 shall 保留并投影其中可恢复的数据，不得为配合实时预览而清除、迁移或覆盖用户资产。
- The 本轮实现 shall 不改变 `project.json` schema；本地自动保存未确认草稿与“后端确认前不写库/发布”是不同边界，文档不得再把二者混为一谈。
- When 项目重置、切换或重新打开时仍有 pending flush 或会话消息，the 系统 shall 保持现有保存与消息顺序，不得因预览改造丢弃草稿或让晚响应追加到已失效会话。

### R5 实时口径、性能目标与范围约束
- The 本轮“实时” shall 定义为完整响应体接收、校验并成功 dispatch 后的本地同步重投影，不包含模型网络等待，也不要求 token 流式渲染。
- The 本地 React commit 到浏览器 paint 的性能目标 shall 为 P95 ≤150ms；测量时须记录 commit 起点、paint 终点、样本与环境，未测量时只能标为“目标，未实测”，不得以领域函数耗时冒充。
- The Agent 实时闭环 shall 仅覆盖 `STORE_INFO` 的 Web 效果预览；`TEMPLATE_PICK` 只保留既有模板切换能力，本轮不得宣称完成全量 M5-6-06。
- The 本轮范围 shall 排除自研 Web 小程序运行时、每轮自动启动微信开发者工具、后端 `agent-turn.v2` 实现、独立 base 持久化体系及全仓重构。
- The 微信开发者工具自动验收 shall 仅保留为未来按需建议，不得成为本轮默认副作用。

### R6 测试、构建说明与后端待办
- The 开发交付 shall 包含 ViewModel 领域测试、预览组件结构检查和 Agent 状态/预览集成测试，并保持 `test/app-imports.test.cjs` 门禁有效。
- When 本轮构建完成，the 团队 shall 生成面向其他 AI 的中文构建说明，列出改动文件、真实命令与结果、实时定义、v1/v2 边界及未解决问题。
- The 团队 shall 将 `agent-turn.v2` 的 `presentationPatch`、候选稳定 ID、白名单校验、过期与确认语义建议追加到后端待实现文档，但不得在本轮实现这些后端能力。
- When 全部实现与独立验证通过，the 团队领导 shall 才可在 Windows 桌面创建 `已完成.txt`；该文件不属于任何编码任务 write_set。

## 2. Technical Design

### 2.1 Architecture and Implementation Boundaries
**基线与栈**：已读 `package.json`、现有预览、`App.jsx`、`sessionMachine.mjs`、`planFromSession.mjs`、CompositionPlan schema 与相关测试。继续使用 React 18 + JavaScript/`.mjs` 纯函数 + Node `node:test` + Vite；不新增运行时、状态库、测试框架或 TypeScript 迁移。公开数据形状以 2.2 的 JSDoc/字段表冻结。

**数据流**：`agent-turn.v1` → 现有 service normalize/validate → 带本地 request identity 的 reducer → `buildPlanFromSession(..., { storeNameSource: 'draft-first' })` → 纯 Preview ViewModel/selector → `MiniProgramPreview` props → React DOM。响应为 `collecting` 时也走同一投影；网络或结构失败不进入 reducer 成功分支。

**职责边界**：
1. **Composition/ViewModel 适配器（T1）**：复用 `CompositionPlan.storeProfile/themeTokens` 作为展示事实，补充布局、固定 tab、示例订单和 React key 元数据；`agentDraft` 仅用于对齐本地菜品 key，不覆盖 Plan 的展示值。提供 session 级 selector，避免 App 熟知投影细节。
2. **预览展示组件（T2）**：只消费 ViewModel、尺寸和内部 tab 事件；图标由组件侧固定白名单映射。不得 import service、调用 API、读取 session 或复制商品/营业时间数据。
3. **组合根与生命周期（T3）**：`App.jsx` 只构建/传递 selector 结果并关联请求标识；`TemplateGallery` 改为接收按模板 ID 准备的 ViewModel；reducer 保持 confirmed 状态与持久化边界，增加最小晚响应防护。
4. **文档（T4）**：记录真实证据和 v1/v2 边界，区分本机快照与后端写库；只提交后端 v2 建议，不实现。
5. **独立验证（T5）**：在稳定集成代码上运行门禁和独立验收；规划本身不代表已执行或已通过。

**明确不改**：`project.json` schema、自动保存调度、Composer schema/registry、后端 v1 transport、Composer/mini-capture、微信开发者工具自动化、真实 WXML/WXSS 运行时。模板选择阶段仍可使用重构后的组件，但 Agent 新闭环只针对 `STORE_INFO`。

### 2.2 Interface Contracts
计划修订：P1。契约索引：`C-PLAN-PREVIEW@1`、`C-PREVIEW-VM@1`、`C-PREVIEW-COMPONENT@1`、`C-TEMPLATE-GALLERY@1`、`C-AGENT-REQUEST@1`，当前全部 READY；以下定义为执行期唯一权威版本。

#### C-PLAN-PREVIEW@1 — CompositionPlan 预览适配（READY）
- Provider：T1；Consumers：T3、T5；需求：R1、R4、R5。
- 变更现有 `src/composition/planFromSession.mjs` 的 `buildPlanFromSession(state, options = {})`。保留 `options.role: 'customer'|'merchant'|'combined'` 及原返回 `{ plan, warnings, unmappedCapabilities, recipeId, themePresetId }`。
- 新增可选 `options.storeNameSource: 'confirmed-first'|'draft-first'`，缺省及未知值均为 `confirmed-first`。`confirmed-first` 完全保持现状：`store.name || draft.storeName || '我的餐馆'`；`draft-first` 仅改为 `draft.storeName || store.name || '我的餐馆'`，随后沿用 trim/48 字截断。
- 该选项不序列化进 Plan，不改变 category、businessHours、fulfillment、dishes、themeTokens 的现有映射，不向 CompositionPlan 增加菜品 ID 或其他字段，不修改 state。export 调用不传新选项，故默认行为不变。
- 失败/空值：沿用现有安全归一化；本适配不抛新的业务异常，不执行持久化。

#### C-PREVIEW-VM@1 — 纯 Preview ViewModel 与 session selector（READY）
- Provider：T1；Consumers：T2、T3、T5；需求：R1、R2、R3、R4、R5。
- 新模块 `src/composition/previewViewModel.mjs`，无 React/DOM/service/存储副作用，导出：
  - `buildPreviewViewModel({ plan, layout = 'menu', featureIds = [], draft = {} }) -> PreviewViewModel`；
  - `buildSessionPreviewViewModels(state) -> { selected: PreviewViewModel, byTemplateId: Record<string, PreviewViewModel> }`。
- selector 仅调用一次 `buildPlanFromSession(state, { storeNameSource: 'draft-first' })`，按 `state.build.candidates[{id,layout}]` 和 `selectedId` 生成各模板 VM；无候选时 `selected.layout='menu'`。`selected` 必须与当前选中候选的 `byTemplateId[id]` 是同一对象引用；候选 ID 重复时取首个，未知 layout 回落 `menu`。
- `PreviewViewModel` 的完整公共形状（所有键必有，数组可为空，不用 `any`）：

```js
/**
 * @typedef {'menu'|'catalog'|'editorial'} PreviewLayout
 * @typedef {{ key:string, name:string, note:string, priceCents:number,
 *   priceDisplay:string, thumbnail:'theme-gradient' }} PreviewProduct
 * @typedef {{
 *   schemaVersion:'preview-view-model.v1', layout:PreviewLayout,
 *   theme:{ pageBackground:string, primaryColor:string, accentColor:string,
 *     textColor:string, tabBarBackground:string, tabBarColor:string,
 *     tabBarSelectedColor:string },
 *   store:{ name:string, initial:string, category:string,
 *     businessHoursText:string, fulfillmentText:string, subtitle:string },
 *   hero:{ kicker:string, title:string, cta:string, sectionTitle:string,
 *     story:string|null },
 *   products:PreviewProduct[], menuCountText:string,
 *   tabs:Array<{ id:'home'|'menu'|'orders'|'mine', label:string,
 *     icon:'home'|'menu'|'orders'|'mine' }>,
 *   order:{ number:string, context:string, status:string, estimate:string,
 *     steps:Array<{ key:string, label:string,
 *       state:'done'|'current'|'pending' }> },
 *   capabilities:Array<{ key:string, label:string }>
 * }} PreviewViewModel
 */
```

- 展示事实仅取 `plan.storeProfile`、`plan.themeTokens` 和显式白名单常量；`draft` 只用于给 Plan 中已过滤菜品对齐本地 key，任何 draft 展示值不得覆盖 Plan。金额只读取整数 `priceCents`，`priceDisplay=formatCents(priceCents)`；不读取 `priceText`。
- 菜品仅接受非空名称及 `1..999999` 的整数分。无合法 Plan 菜品时使用四个既有示例商品（2800/1600/1000/2200 分），示例 key 为 `sample-dish-1..4`；草稿菜品优先使用对应本地 `dish.id`，缺失时回退 `dish:<name>:<priceCents>`，重复时追加稳定的 `#<出现次数>`，保证唯一且不以数组下标或其字符串形式作 key。
- 颜色仅接受 `#RRGGBB`，缺失/非法时逐项回落到现有 warm-orange tokens；layout 仅接受三种枚举。tabs 固定顺序 `home/menu/orders/mine`，capabilities 来自现有 catalog label 映射，最多 4 项。
- `fulfillmentText/subtitle` 只由 `plan.storeProfile.fulfillment` 决定，禁止用 features 反推取餐方式；category 可参与 subtitle。营业时段以 `HH:MM-HH:MM` 中文逗号连接，空数组显示 `营业时间待完善`；空 category 显示 `品类待完善`。
- hero/order/示例商品是明确的演示投影常量，不代表后端订单或真实商品图片。`thumbnail='theme-gradient'` 是唯一 v1 商品图类型。所有函数对同一输入深相等且不修改输入；异常形状安全回落，不发起请求、不写存储。

#### C-PREVIEW-COMPONENT@1 — MiniProgramPreview props 与展示事件（READY）
- Provider：T2；Consumers：T3、T5；需求：R1、R2、R3。
- 默认导出签名固定为 `MiniProgramPreview({ viewModel, size = 'full' })`；`viewModel` 必须是 `C-PREVIEW-VM@1`，`size: 'compact'|'full'`，未知 size 按 full。删除 `template/theme/storeName/features` 公共 props。
- 组件仅在 full 模式发出内部 tab 切换事件，初始 tab 为 `home`；ViewModel 更新不得因 key 改变而重建整个组件。compact/full 必须读取同一个 `viewModel`，不得各自构造数据。
- 商品 key=`product.key`，tab key=`tab.id`，订单步骤 key=`step.key`，能力 key=`capability.key`；组件仅把 `tab.icon` 映射到固定 lucide 图标，不接受任意组件/代码/URL。
- `viewModel == null` 时渲染静态不可用占位且不抛异常；不得通过 import ViewModel builder 自行补数据。组件不得 import service、调用 fetch、访问 storage 或修改 confirmed state。
- 保持现有 CSS class 体系与四种 tab、三种布局的视觉密度；本轮复用现有样式，不新增或修改 CSS 文件。

#### C-TEMPLATE-GALLERY@1 — 模板库的 ViewModel 接线（READY）
- Provider/Consumer：T3（`TemplateGallery` 与 App 同一所有者）；Consumers：T5；需求：R2、R5。
- `TemplateGallery({ candidates = [], selectedId = null, onSelect, onConfirm, viewModelsByTemplateId = {} })`；删除 `theme/storeName/features` props。
- `viewModelsByTemplateId` 是 `Record<string, PreviewViewModel>`，每个候选以 `item.id` 读取对应 VM，并原样传给 compact `MiniProgramPreview`；选中项 full 预览使用同一对象。不得根据 size 再建 VM。
- `onSelect?.(item.id)` 与 `onConfirm?.()` 保持不变；`disabled={!selectedId}` 保持不变。候选卡片其它展示字段沿用现有 `badge/name/summary/source/score/customized/note`。
- 缺失 VM 交给 `C-PREVIEW-COMPONENT@1` 的不可用占位处理，不得在 Gallery 内请求或构造第二份数据。

#### C-AGENT-REQUEST@1 — 最小请求身份与晚响应防护（READY）
- Provider：T3（`sessionMachine.mjs`）；Consumers：T3（`App.jsx`）、T5；需求：R3、R4。
- App 为每次新请求/重试生成非空、进程内单调递增的 `requestId`（建议 `agent-request-<counter>`），在 request/retry 及对应 success/failure action 中原样传递；计数器不得随 RESET/项目切换倒退或复用。
- action 形状：`AGENT_TURN_REQUEST { type, utterance, requestId? }`、`AGENT_TURN_RETRY { type, requestId? }`、`AGENT_TURN_SUCCESS { type, requestId?, ...result }`、`AGENT_TURN_FAILURE { type, requestId?, error }`。request/retry 进入 requesting 时设置 `agent.activeRequestId=requestId ?? null`。
- success/failure 仅当 `agent.status==='requesting'` 且 `agent.activeRequestId === (action.requestId ?? null)` 时接受；否则返回原 state 引用，不得修改草稿、消息、attempts、错误或预览。接受后置 `activeRequestId=null`。
- 缺省 requestId 的现有 Node 测试/旧调用形成兼容路径：request 存 null，对应 completion 也只有缺省 null 时才接受。App 新代码必须始终提供非空 ID，不得走该兼容路径。
- `activeRequestId` 是 transient，不进入 `project.json`，不需要修改 snapshot schema 或自动保存依赖；RESET/打开项目后旧响应因状态或身份不符被忽略，reset+新请求也不会接受旧响应。
- `AGENT_TURN_REQUEST` 仍禁止 requesting 重入；failure/retry、确认、重新打开的既有状态迁移不变。requesting/failure/stale 均不得直接改 `agentDraft`，因此预览保留最后已接受草稿。


### 2.3 Shared Behavior, Integration, and Open Decisions
**共享状态规则**（公共形状见 `C-PREVIEW-VM@1` / `C-AGENT-REQUEST@1`）：

| 场景 | agentDraft / confirmed 状态 | 预览行为 |
| --- | --- | --- |
| requesting | 保留最后已接受草稿；store/build/visual 不变 | 原样保留，可显示既有请求状态，但不伪造新响应 |
| success + collecting/reviewing | 接受完整 normalize 后的部分或完整草稿，不以 readyForReview 拦截 | 同一 selector 同步投影安全字段 |
| transport/结构失败 | 草稿与 confirmed 不变，记录现有 lastError | 保留最后已接受草稿，允许既有重试 |
| request identity 不符 | 返回原 state，消息/错误也不变 | 无任何更新 |
| confirm | 只按原规则晋升 storeName/category 到 store | 继续投影同一 agentDraft，不跳变 |
| reopen/edit | agent 回到 reviewing，confirmed store 保持到再次确认 | 投影最新安全草稿 |
| 本地快照重开 | 沿用现有 fromDocument 恢复与校验 | 恢复草稿可直接投影，无破坏性迁移 |

**既有接口基线**：
- `src/services/agentTurn/agentTurnService.js::requestAgentTurn` 已负责完整响应的 normalize/validate；本轮不改其请求/响应形状，不引入流式协议。
- `src/domain/projectSnapshot.mjs::toDocument/fromDocument` 与 `SNAPSHOT_SCHEMA_VERSION=1` 保持不变；`activeRequestId` 不进入文档。`src/App.jsx` 现有自动保存 effect、pending flush 和 sessions 保存顺序不得被预览接线改写。
- `src/composition/planFromSession.mjs` 的 export 默认仍为 confirmed-first；只有 preview selector 显式使用 draft-first。CompositionPlan schema/registry 不改，不能借预览将菜品本地 ID 加入导出 Plan。
- `test/app-imports.test.cjs` 继续作为 App 组合根静态门禁；各任务不得通过复制组件绕过 import。

**集成规则**：T1/T2/T3 可依据 READY 契约并行 authoring。T3 的集成测试执行与全量 build 需等待实际 T1/T2 交付，但这不是其开始编码的 blocker。T4 必须等 T1–T3 稳定后记录真实命令；T5 在文档与代码稳定后独立复验。若任何契约需不兼容变更，先由 planner 通知 leader，再统一修订受影响任务与证据。

**开放决策/证据边界**：无阻塞 v1 实施的产品或接口未知项。P95≤150ms 是 commit→paint 目标而非已测结果；本轮按用户给定“目标非实测”口径，不以此虚构通过，领域函数耗时不得替代 UI paint。真实微信运行时、完整 M5-6-06、v2 presentationPatch、候选稳定 ID 的服务端权威生成/校验/确认语义均为后续事项，只写建议，不影响当前 READY 状态。

## 3. Tasks

### 3.1 Implementation Tasks
- [ ] **T1 — 实现 CompositionPlan 预览适配与唯一 ViewModel**
  - `objective`：交付纯函数 selector/ViewModel，支持 draft-first 店名、安全部分草稿、稳定 key 与 compact/full 共用投影。
  - `requirement_refs`：R1、R2、R4、R5、R6。
  - `write_set`：`src/composition/planFromSession.mjs`；新增 `src/composition/previewViewModel.mjs`；`test/compose-plan-from-session.test.cjs`；新增 `test/preview-view-model.test.cjs`。
  - `provides`：`C-PLAN-PREVIEW@1`、`C-PREVIEW-VM@1`。
  - `consumes`：既有 `src/domain/agentDraft.mjs::formatCents`、`src/domain/catalog.mjs::features`、`src/composition/themePresets.mjs::resolveThemeTokens`；不消费任何待实现接口。
  - `blocked_by`：无；所需输入与公开形状已冻结。
  - `verify_after`：T2、T3 交付后由 T4/T5 执行全量 `npm test` 与 `npm run build`；本地纯领域测试不等待其他任务。
  - `acceptance_and_local_checks`：覆盖 `readyForReview=false` 的逐字段投影、五类草稿字段、draft-first 与 export 默认不变、fulfillment 不被 features 覆盖、整数分/非法价格、空值回落、三种布局、四 tab、主题回落、稳定唯一 key、selector 引用相等、纯函数不改输入；运行 `node --test test/preview-view-model.test.cjs test/compose-plan-from-session.test.cjs` 并全过。
  - `delivery_evidence`：上述四个文件、采用契约修订、真实测试命令/退出码；全量 build/集成检查明确交给 T4/T5，不得把 deferred 写成 PASS。
  - `dispatch_priority`：P0，初始关键路径；与 T2/T3 并行启动。
- [ ] **T2 — 重构 MiniProgramPreview 为纯展示组件**
  - `objective`：消除商品、营业时间、tab 和 compact/full 重复数据分支，保留视觉近似布局与 tab 交互。
  - `requirement_refs`：R1、R2、R3、R6。
  - `write_set`：`src/components/preview/MiniProgramPreview.jsx`；新增 `src/components/preview/PreviewShared.jsx`；新增 `src/components/preview/PreviewTabs.jsx`；新增 `test/mini-program-preview-structure.test.cjs`。不得修改 CSS 或其他组件。
  - `provides`：`C-PREVIEW-COMPONENT@1`。
  - `consumes`：`C-PREVIEW-VM@1`；既有 `lucide-react` 图标与现有 CSS class。
  - `blocked_by`：无；VM 字段已 READY，可并行编写，不要求 T1 实现先完成。
  - `verify_after`：T1 提供真实 VM、T3 完成调用方接线后，由 T4/T5 执行 Vite build 和运行时集成检查；本地结构测试不等待它们。
  - `acceptance_and_local_checks`：组件只接收约定 props；无 service/fetch/storage/domain 数据 import；无 `PRODUCTS`/硬编码营业时间副本；商品/tab/step/capability 使用约定 key；full 四 tab 可切换，compact/full 共享 VM；null VM 安全占位；复用现有 class，不改 CSS。运行 `node --test test/mini-program-preview-structure.test.cjs` 并全过。
  - `delivery_evidence`：四个文件、采用契约修订、静态测试真实结果；组件编译与浏览器渲染检查由 T4/T5 执行并明确标记 deferred，直至实际完成。
  - `dispatch_priority`：P0，与 T1/T3 并行；是集成 build 的必要产物。
- [ ] **T3 — 接线 STORE_INFO 预览并加固 Agent 请求生命周期**
  - `objective`：App/TemplateGallery 使用唯一 VM，App 为 turn 关联 request identity，reducer 忽略晚响应，同时保持确认、导出与本地快照语义。
  - `requirement_refs`：R1、R2、R3、R4、R5、R6。
  - `write_set`：`src/App.jsx`；`src/components/flow/TemplateGallery.jsx`；`src/state/sessionMachine.mjs`；`test/agent-intake-flow.test.cjs`；新增 `test/agent-preview-integration.test.cjs`。不得修改 `projectSnapshot.mjs`、自动保存 effect、Composer 或 transport。
  - `provides`：`C-TEMPLATE-GALLERY@1`、`C-AGENT-REQUEST@1`。
  - `consumes`：`C-PLAN-PREVIEW@1`、`C-PREVIEW-VM@1`、`C-PREVIEW-COMPONENT@1`；既有 `requestAgentTurn` 与 snapshot 接口。
  - `blocked_by`：无；全部跨任务契约 READY。T1/T2 是后续集成测试和 build 的执行前提，不是 authoring blocker。
  - `verify_after`：T1 后执行新 `agent-preview-integration`；T1+T2 后由 T4/T5 执行全量测试与 build。局部状态测试和 App import 门禁可立即执行。
  - `acceptance_and_local_checks`：部分/完整 turn 均驱动五类字段；requesting/failure 保留旧预览；旧 requestId 的 success/failure 返回原 state，覆盖 reset+新请求后旧响应；confirm/reopen 不提前改 store/build/visual；export 默认不传 draft-first；快照恢复保留草稿且 activeRequestId 不落盘；TemplateGallery 新旧 props 完全替换。先运行 `node --test test/agent-intake-flow.test.cjs test/app-imports.test.cjs`，再按实际依赖运行 `node --test test/agent-preview-integration.test.cjs`。
  - `delivery_evidence`：五个文件、采用契约修订、上述已执行命令的真实结果；未到时机的集成/build 检查注明 owner T4/T5，不得提前宣称通过。
  - `dispatch_priority`：P0，与 T1/T2 并行；优先完成 reducer 与 App 接线以缩短集成关键路径。
- [ ] **T4 — 编写中文构建说明并登记 agent-turn.v2 后端建议**
  - `objective`：基于稳定代码和真实命令结果交付面向其他 AI 的构建说明，修正持久化口径并追加后端待办，不实现 v2。
  - `requirement_refs`：R4、R5、R6。
  - `write_set`：新增 `docs/2026-11-03-Agent草稿实时预览-构建说明.md`；`docs/agent-turn-contract.md`；`docs/后端待实现接口清单.md`。不得修改生产代码、测试或桌面文件。
  - `provides`：无代码契约；交付三份文档供 T5 核验。
  - `consumes`：全部五个 P1 契约及 T1–T3 的实际文件/测试交付证据。
  - `blocked_by`：T1、T2、T3；需要真实改动文件、可执行集成产物和局部测试结果，契约不能替代这些事实。
  - `verify_after`：T1–T3 全部完成后先运行根目录 `npm test` 与 `npm run build`，再如实书写；T5 在其后独立复验文档与命令。
  - `acceptance_and_local_checks`：构建说明列出实际改动文件、命令/退出码/关键输出、完整 turn 后本地实时的定义、commit→paint P95 目标（未测就写未测）、仅 STORE_INFO Web 近似预览、v1/v2 边界、未解决问题；明确本地快照可保存未确认草稿/会话消息与 pending flush，后端确认前不得写库/发布，不做迁移。后端待办追加 v2 `presentationPatch` 白名单、候选稳定 ID、baseRevision/turnId 过期规则、校验与显式确认/持久化建议，禁止任意源码/CSS/URL，不宣称已实现；C 仅写未来按需微信工具验收建议。
  - `delivery_evidence`：三份文档、`npm test` 和 `npm run build` 的真实原始结果；失败必须上报并由对应实现 owner 修复，不得在文档中粉饰或通过。
  - `dispatch_priority`：P2，实现任务中的最后串行文档工作；完成后释放 T5。


### 3.2 Ownership and Dispatch Readiness
**所有权图**：T1 独占 composition 实现与两个领域测试；T2 独占 preview 三个组件文件及结构测试；T3 独占 App、TemplateGallery、sessionMachine 与两个状态/集成测试；T4 独占三份文档；T5 只读。所有并行 write_set 均不重叠，CSS、snapshot、transport、Composer/schema 均无写入 owner 且明确禁改。完整 build/运行时资源不由各 coder 并发操作：T4 做首次完整集成执行，T5 在其后独立复验；局部 Node 测试无共享数据库。

| Task ID | Provides / consumes revisions | Contract evidence | Ownership result | Genuine start prerequisites | Planning readiness / blocker | Priority |
| --- | --- | --- | --- | --- | --- | --- |
| T1 | 提供 C-PLAN-PREVIEW@1、C-PREVIEW-VM@1；消费已核实现有纯函数 | 2.2 完整输入/返回/回落规则 | 四个 write_set 文件独占，无重叠 | 无 | PLANNING_READY | P0 |
| T2 | 提供 C-PREVIEW-COMPONENT@1；消费 C-PREVIEW-VM@1 | 2.2 props、key、空值和事件规则完整 | 三个组件文件及一个新结构测试独占，不改 CSS | 无；契约依赖不等待 T1 实现 | PLANNING_READY | P0 |
| T3 | 提供 C-TEMPLATE-GALLERY@1、C-AGENT-REQUEST@1；消费 C-PLAN-PREVIEW@1、C-PREVIEW-VM@1、C-PREVIEW-COMPONENT@1 | 2.2 接线与 identity 规则完整，2.3 状态表明确 | App、Gallery、machine 与两个测试独占；禁止写持久化文件 | 无；仅集成执行等待 T1/T2 产物 | PLANNING_READY | P0 |
| T4 | 提供文档；消费全部 P1 契约及 T1–T3 实际证据 | 2.3 文档/持久化/性能边界明确 | 三份文档独占，不写代码 | T1、T2、T3 的真实交付与局部结果 | BLOCKED：等待 T1/T2/T3 完成后方可记录真实集成结果 | P2 |
| T5 | 提供独立 verdict；消费全部 P1 契约与 T1–T4 证据 | 2.2/2.3 与 R1–R6 均可追踪 | 只读，无 write_set 冲突 | T4 完成且代码/文档稳定 | BLOCKED：等待 T4；最终质量门 | P0 |

**初始 ready set 与回填顺序**：候选初始集合为 T1、T2、T3（均 P0，按 T3/T1/T2 的关键路径优先序安排可用槽位，但不形成层级等待）；任一完成即可回填其他已就绪工作。T1–T3 全部真实交付后 T4 转为可启动，T4 完成后 T5 转为可启动。未知运行时容量，不预设 agent 数量或启动时长。用户已授权本轮执行，无额外计划审批门；PLANNING_READY 不等于 leader 已 dispatch，更不等于验证通过。

> The team leader must inspect the relevant contract definitions and ownership evidence before dispatch. After that check, launch ready tasks consecutively up to available capacity. Do not wait or perform blocking output collection between independent launches. Refill capacity as tasks finish; do not wait for an entire wave. Recheck affected entries after contract, ownership, or prerequisite changes.

### 3.3 Validation and Testing Tasks
- [ ] **T5 — team-result-verifier 独立集成与最终验收**
  - `objective`：在 T1–T4 稳定交付上独立验证功能、契约、持久化兼容、构建与文档真实性；owner 必须为 team-result-verifier，而非实现 coder。
  - `requirement_refs`：R1–R6 全部。
  - `write_set`：无代码/文档写入；只读验证并返回证据。桌面 `已完成.txt` 仅由 leader 在 PASS 后创建。
  - `provides`：独立验证 verdict 与真实证据，无新接口契约。
  - `consumes`：全部五个 P1 契约、T1–T4 交付物及其声称的命令结果。
  - `blocked_by`：T4；其本身要求 T1–T3 已完成并记录集成结果，最终验证必须针对稳定代码与文档。
  - `verify_after`：T1–T4 全部交付；若相关代码随后变化，受影响的测试、build 和运行时证据必须重跑。
  - `acceptance_and_local_checks`：独立复验 scoped 测试、跨边界 `agent-preview-integration`、`app-imports`、根目录完整 `npm test` 与 `npm run build` 均真实通过；目标还包括 STORE_INFO 部分/完整 turn 的实际 React 渲染、四 tab/三布局、失败与晚响应、confirm/reopen、快照恢复以及文档所列文件和 v1/v2 边界。不得以 mock 领域测试证明真实 DOM paint，不得以源码检查代替运行时渲染；无法执行的必需检查必须报告缺口而非 PASS。P95 若未按 commit→paint 实测，应明确保留“目标未实测”。
  - `delivery_evidence`：每项实际命令、退出码、测试计数/构建结果、运行时检查证据、文档一致性 verdict 和未解决问题；失败退回对应 owner，修复后独立复验。
  - `dispatch_priority`：P0 最终质量门；只有独立 PASS 才允许 leader 宣告完成并创建桌面标记。