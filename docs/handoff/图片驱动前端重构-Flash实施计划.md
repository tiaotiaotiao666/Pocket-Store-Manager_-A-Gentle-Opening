# 图片驱动前端重构：Flash 实施计划

> 基线：`main@e2eb16ac2ce81f1975d8dccfc1a3c36ebda2d126`（2026-11-16，工作区拉取后干净）。
> 执行者：Flash 编码模型。本文可直接作为实施任务书；先读仓库 `AGENTS.md`、项目概览和当前交接。
> 目标：用户上传一张前端截图并补充要求后，本地桌面 Agent 能生成受控候选前端，经本地校验/编译/截图验证，由用户确认采用、撤销和持久化。
> 非目标：本阶段不接生图模型，不配置 `IMAGE_PROVIDER_*`，不生成或复刻品牌图片，不新增任意业务 JS/后端能力，不承诺像素级复刻，不做自动发布。

## 0. 给 Flash 的执行总则

1. 先检查 `git status` 与 `git rev-parse HEAD`；若基线已变化，重读相关文件并映射任务，禁止盲目套用行号。
2. 按 P0→P7 顺序，小步提交/交付，每阶段先写失败测试再实现；不得删除、放宽测试或伪造模型、编译、截图证据。
3. 保留现有三条链路：`agent-turn.v2` 图片资料抽取、`agent-template-revise.v1` 展示补丁、`agent-run.v1` 多轮工具。新能力使用独立 `frontend-reconstruct.v1`，不要破坏旧请求和响应。
4. 保留零重型编排框架选择：不引 LangChain/LlamaIndex/OpenAI SDK；优先复用 `server/src/agent/runtime/`，不要另造第三套 loop。
5. 模型永远不是可信执行者：只产生有界 JSON DSL；本地代码负责目录事实、路径约束、schema、WXML/WXSS/JSON 校验、Composer、编译、证据和最终状态。
6. 不在 Nest 服务端写仓库源码、运行 shell 或修改全局 Registry。候选文件由 Electron 主进程写到应用私有项目工作区；服务端只负责视觉理解和受控规划。
7. 不改 `miniprogram/` 镜像；唯一 Base 真源是 `templates/base/ordering-base/1.0.0/src`。不改全局 `templates/**` 来保存某个用户的候选。
8. 新增 UI 控件有可访问名称，改 UI 后执行 `npm run agent:smoke`，为本链路补 UIA 断言；React 预览不是微信验收。
9. 日志、响应、持久化快照和测试 fixture 不包含 API Key、base64 图片正文、完整 prompt、原始模型响应或任意本机秘密。
10. 完成后更新 `docs/项目概览.md`、`docs/handoff/当前工作区交接.md` 和本计划末尾实测结果；未运行项明确标 `NOT_RUN/BLOCKED`。

## 1. 最新基线审计：哪些已有，哪些缺失

### 1.1 直接复用，不重复造

- `kind:'reference'` 单图输入与 `screen-reference.v1`：图片校验、目录白名单、结果裁剪、确认/候选/采用 UI。
- `ScreenReferencePanel.jsx`、`screenReference.mjs`、`screenReferenceService.js`：可升级为重构入口，保留旧识别结果兼容。
- `FrontendPack`：允许只改 `WXML/WXSS/JSON`，页面 JS 固定来自 Base；已有 Manifest、Composer 合并、事件/插槽/组件/URL 门禁。
- `scripts/composer/`：Plan 校验、冻结资产解析、dry-run 所需的 P0–P6、原子生成、Lock、静态/安全/可复现校验。
- `desktop/composer-ipc.cjs`、`preload.cjs`：可信 sender、审批目录、串行任务、取消、进度；候选 dry-run 需单独受限 IPC，不伪造成用户导出。
- `server/src/agent/runtime/`：工具 schema/执行/超时/重试/并发/上限/取消/循环检测/trace。
- `scripts/wechat-devtools-run.cjs`、`scripts/wechat-export-audit.cjs`：真实微信编译、自动化页面和截图证据。
- `desktop/output-consistency.cjs`：产物与 Lock/Report 一致性检查。
- `projectSnapshot.mjs`：项目持久化、旧版本恢复和非法状态回退。

### 1.2 当前不能宣称“按图重构”的原因

1. `screen-reference.v1` 只从现有 Recipe/Feature/Theme 中挑 id；`buildCandidateRecipe` 只改模板选择和样式，不能表达截图的新结构。
2. 只有一个 `warm-home-menu` FrontendPack，且当前仅覆盖 home/menu；不是模型按图生成的候选。
3. 多轮 Runtime 的 ChatMessage/DeepSeek adapter 只支持字符串内容，没有视觉消息，也没有前端重构工具。
4. 模型输出没有结构化的页面分区、数据绑定、事件绑定、置信度、未识别区域与能力覆盖报告。
5. 没有项目私有候选工作区、版本化 Registry overlay、受控生成工具、dry-run 工具、自动修复和回滚状态。
6. 没有“导出截图 → 对照原图 → 有界修复”的真实闭环，也没有完整验收矩阵。

结论：不是“再补一个 prompt”，而是新增一条受控生成链。现有 `screen-reference.v1` 可保留用于快速选模板，也可将其识别摘要作为新链路上下文，但不能把选模板响应冒充重构结果。

## 2. 最终用户链路和状态机

```text
上传 1 张截图 + 用户要求（可只发图）
→ 本地压缩/格式/体积校验
→ 服务端视觉分析 UiRequirement + VisualSpec
→ 本地读取组件/页面/控制器/布局能力，生成 CapabilityCoverageReport
→ 若必需能力缺失：返回 unsupported/needs-input，不写文件
→ 生成项目私有 FrontendPackDraft（JSON DSL，不直接接受任意源码）
→ Electron 在私有候选工作区物化版本化资产与 Registry overlay
→ Composer dry-run + mini:check + 一致性检查
→ 失败：仅结构化错误最多修复 2 轮；仍失败保留当前版本，不采用候选
→ 微信真实编译与关键页面截图（工具不可用时明确 pending/blocked）
→ 展示差异、降级项、验证状态和截图
→ 用户“采用候选”后才更新当前会话/项目
→ 可撤销到采用前版本；重开项目恢复已采用候选
```

状态建议：`idle → analyzing → planning → awaiting-capability-confirmation? → generating → validating → verifying-runtime → ready | partial | rejected | failed → adopted`；`cancelled` 为终态。只允许合法单向迁移和显式重试/撤销；旧响应用 `runId + revision + AbortSignal` 丢弃，不得覆盖新图/新任务。

`ready` 仅在必需静态门禁全绿且运行时验证成功时使用；微信工具不可用且其它门禁通过时为 `partial`，绝不能显示“已验收”。`rejected` 不产生候选文件；`failed` 不产生已采用变更。

## 3. 契约设计

### 3.1 新端点

新增 `POST /api/v1/agent/frontend-reconstruct`，复用 `AgentAuthGuard`、requestId、统一异常过滤和现有图片大小限制。请求：

```json
{
  "contractVersion": "frontend-reconstruct.v1",
  "requestId": "fr-...",
  "utterance": "按截图重构首页，保留下单，整体更紧凑",
  "images": [{ "kind": "reference", "mediaType": "image/png", "dataBase64": "..." }],
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

严格未知键拒绝；恰好一张 `reference`；`targetPages` 首期仅 `home/menu`（后续扩到其余 Base 页必须补页面卡、布局卡和运行时测试）；服务端不信任客户端 Registry/Catalog/Plan，模型也不接收秘密。

响应只返回有界 JSON：

```json
{
  "contractVersion": "frontend-reconstruct.v1",
  "runId": "frun-...",
  "status": "planned | needs-input | rejected",
  "requirement": {},
  "coverage": {},
  "draft": null,
  "trace": { "modelCalls": 0, "toolCalls": [], "stopReason": "final_answer", "degraded": false },
  "meta": { "provider": "deepseek", "model": "...", "mock": false, "latencyMs": 0 }
}
```

`draft` 仅 planned 存在；`needs-input` 给具体问题；`rejected` 给 missingCapabilities/unsupported，不返回草稿。所有自由文本限制长度并清理控制字符。trace 不含源码正文和图片。

### 3.2 UiRequirement + VisualSpec

在 `server/src/agent/frontend-reconstruct/types.ts` 固定 schema：

- `mustKeep[]`：必须保留的页面/动作/数据；默认从 Base 目标页保留所有已声明关键动作，不能因截图没画按钮就静默删功能。
- `pages[]`：每项 `pageId`、分区顺序、近似布局、目标尺寸。
- 分区：`id/type/order/rect?/children[]/confidence`；rect 只允许 0–1 归一化数。
- `theme`：七类现有颜色 token 的子集；`sizes`：现有 sm/md/lg；可选有界 `density: compact|comfortable`。
- `bindings[]`：`regionId → dataPath/eventName`，只能引用服务端注入的页面事实；没有绑定依据则标 `unknown`。
- `unknownRegions[]`、`lowConfidence[]`、`inferredInteractions[]`、`unsupported[]`、`degradations[]`。
- 禁止从截图推断隐藏手势、网络、路由、支付/订单规则；禁止把图中文字/品牌/图像当业务数据或资产。

### 3.3 CapabilityCoverageReport

由服务端根据真实能力目录计算，模型只提出需求，不决定覆盖结论：

```json
{
  "status": "covered | partial | rejected",
  "requiredCapabilities": ["page:home", "component:store-header", "controller:home.goMenu"],
  "missingCapabilities": [],
  "coveredBy": {},
  "risks": [],
  "degradations": []
}
```

- `covered`：允许生成。
- `partial`：仅非必需视觉差异，可在用户确认后生成并写 `degradations`；默认本阶段先展示，不自动采用。
- `rejected`：缺页面、组件、数据路径、控制器动作或必需业务能力；不物化、不 Composer、不编译。
- 能力事实来自服务端打包的只读能力快照，不来自客户端提供的一组可伪造 id。首期可生成 `server/src/agent/frontend-reconstruct/capabilities.snapshot.json`，由根脚本从 `templates/catalog`、Base Manifest 和页面控制器确定性生成并测试同源；安装包需包含该快照。

### 3.4 FrontendPackDraft：首选 DSL，而不是任意 WXML

模型返回：

```json
{
  "schemaVersion": "frontend-pack-draft.v1",
  "displayName": "参考图首页候选",
  "pages": [{
    "pageId": "home",
    "nodes": [
      { "type": "component", "componentId": "store-header", "props": {}, "events": {} },
      { "type": "slot", "slotId": "home-hero" },
      { "type": "text", "textToken": "store.name", "style": { "size": "lg", "weight": 600 } }
    ],
    "styles": [],
    "pageJson": {}
  }]
}
```

只允许以下节点：`component`、`slot`、`container`、`text`、`button`。每个节点有服务端生成 id；container 只含受限布局 style；text 只能绑定已知数据 token，不接受任意 WXML 表达式；button 只能绑定已知控制器事件和可读 label。禁止 HTML/WXML 原文、WXSS 原文、JS、WXS、外部 URL、import、动态组件和任意 props。

确定性 renderer 把 DSL 转为 WXML/WXSS/JSON，并补完整 slot fallback 锚点；props/events/dataPath 查真实目录；样式只有白名单属性及范围（颜色、spacing 档位、字号档位、圆角档位、flex 方向/对齐、gap、宽高上下限），最终 CSS 由本地代码输出。

**首期不做“模型直接写 WXML/WXSS”**。DSL 不能表达的非必需视觉效果进入 `degradations`；必需但 DSL 不支持的进入 `rejected` 并列后续资产/语法任务。这样才是可健壮交付，而非靠 prompt 侥幸。

### 3.5 本地工具结果

统一：`{ok, code, summary, details?, candidateId?, revision?, artifacts?}`。错误详情有界且可定位到 DSL path；不返回秘密。工具结果只回传模型修复所需最小字段。

## 4. 本地执行架构：Electron 拥有文件与命令

新增 `desktop/frontend-reconstruct/`：

- `workspace.cjs`：在应用私有数据目录的 `projects/<projectId>/frontend-runs/<runId>/` 下创建 workspace；固定根目录，拒绝任意用户路径、symlink/junction、路径穿越。
- `registry-overlay.cjs`：从已安装的可信 Registry 深拷贝/投影，加入候选 FrontendPack 和 candidate Recipe；不复用写全局 `registry-check --write`，不污染正式资产。若现有 `loadRegistry` 无法同时指定 asset 根，抽离可注入 root 的纯加载函数并用旧测试证明全局行为不变。
- `materialize.cjs`：验证 Draft → 生成候选 `manifest.json/src/pages/**/preview/**`、Plan/Lock 元数据；原子 staging 提交；失败清理；保留 attempts，不覆盖上一个 attempt。
- `dry-run.cjs`：调用 Composer 的内存/受控 staging P0–P6 + `mini:check` + `output-consistency`，返回结构化 issue；生成目录仅本次 run 私有。优先给 Composer 增加显式 `dryRun`/custom registry root API，不复制 Composer 逻辑。
- `verify-runtime.cjs`：显式命令包装 `wechat-devtools-run.cjs`，固定参数、超时、取消和证据路径；绝不执行模型提供的 command。
- `frontend-reconstruct-ipc.cjs`：只接受可信 sender；每项目单任务串行；按 runId 取消；payload/图片/DSL/文件数/文件大小上限；写操作必须来自本应用已创建 workspace。
- `preload.cjs` 只暴露语义 API：`analyzeFrontend`、`buildCandidate`、`validateCandidate`、`verifyCandidate`、`adoptCandidate`、`discardCandidate`、`cancelFrontendRun`、`onFrontendProgress`；禁止通用 read/write/exec IPC。

`App.jsx` 仅组合根接线，业务判断放 `src/domain/frontendReconstruct.mjs`，服务调用放 `src/services/frontendReconstruct/`。不在组件里直接写文件/跑命令。

候选采用时只把通过门禁的 DSL、资产摘要、Plan 引用、预览/证据元数据写入项目快照；不要把 base64、临时绝对路径、原始 trace 或运行时错误大文本持久化。候选包保留在应用私有版本目录，项目存相对 id/version/digest；打开项目先校验摘要，缺失/漂移则安全回退并提示。

`buildPlanFromSession` 增加 `frontendPack:{id,version}` 的项目 overlay 解析路径；不能拿私有 id 去全局 Registry 查找。正式“导出”仍走既有 Composer IPC，但需把已采用候选的 overlay 作为显式、已验证输入，且导出报告如实标 candidate/验证状态。缺 overlay 时禁止静默退回 Base 冒充候选。

## 5. 必须补齐的 Agent skills（仓库级，不是只改提示词）

放在 `.codeartsdoer/skills/<name>/SKILL.md`，每个都有触发条件、必读文件、输入输出、禁止项、验收和失败退出；在 `.codeartsdoer/skills/` 增加索引（如现有约定要求）。这些 skill 同时用于编码 Agent 和生成 Agent 的操作规范；可执行工具仍由 TS/CJS 实现，skill 本身不替代校验。

### 5.1 `wechat-visual-spec`

职责：一张截图 → UiRequirement/VisualSpec。

必须包含：页面/分区/组件/配色/尺寸识别；未知区域、低置信度、不可推断交互；不复制品牌/图片/对方文案；不猜数据/事件；恰好一图与图片错误处理；输出 schema 示例；无法识别即 `needs-input/rejected`。

### 5.2 `wechat-capability-coverage`

职责：需求 → 真实能力报告和最小改动路径。

必须读取 Catalog、组件卡、页面卡、区块卡、Base Manifest、控制器方法、服务/API；辨别 `base-page-fixed`、`registry-validation`、`slot-injection`；检查 props/events/data binding/插槽；输出 covered/partial/rejected；缺必需能力禁止生成；禁止客户端声明替代事实。

### 5.3 `wechat-frontend-pack-authoring`

升级现有 `wechat-template-builder` 并新增此专用 skill：VisualSpec → FrontendPackDraft。

必须包含 DSL 节点/样式白名单、Base 控制器复用、slot fallback 完整保留、page JSON 白名单、四态 preview、确定性 renderer、私有 Registry overlay、禁止任意 JS/WXML/WXSS/路径/命令；覆盖 home/menu，未支持页明确拒绝。

### 5.4 `wechat-frontend-verification`

职责：候选 dry-run → 真实微信验证 → 截图对照 → 最多 2 轮修复。

必须包含：P0–P6、mini:check、output consistency、真实 CLI、关键动作不回归、页面截图、参考图对照清单、视觉近似而非像素承诺、PASS/FAIL/BLOCKED/NOT_RUN；只有结构化错误允许回灌，修复不得改 Base/全局 Registry；两轮失败停止并保留当前版本。

另更新 `wechat-template-builder/SKILL.md`：说明“正式资产入库”与“用户私有候选重构”区别；后者不能直接写正式 templates 或重冻结全局 Registry。更新根 `AGENTS.md` 仅补必要命令和入口，不塞实现细节。

## 6. 工具清单与多轮 Runtime 改造

新 Agent 业务工具（模型可调用，但本地决定权限）：

1. `get_frontend_capabilities({pageIds})`：只读，返回最小组件/props/events/data/slots/layout。
2. `check_frontend_coverage({requirement})`：只读，服务端权威报告。
3. `propose_frontend_draft({draft})`：write（仅内存草稿），完整 schema 校验；不直接写磁盘。
4. `repair_frontend_draft({issues,patch})`：write，仅针对本次结构化 issues，限制 patch 路径和次数。

服务端 run 完成后由桌面调用本地工具；本地构建/验证工具不必暴露给远端模型循环，以免把桌面 IPC 变成远端控制通道。需要自动修复时，把本地最小 issues 通过受控 repair 请求发送，不能上传任意日志/路径。

给 Runtime ChatMessage 增加类型化 multimodal content（text + image_url），DeepSeek adapter 有图时选择 `DEEPSEEK_VISION_MODEL`，无图行为保持原样。工具与 `response_format` 是否兼容先按现有交接做真实 T0 探测；不要假设。输出较大时提高专用重构模型 maxTokens 配置，但必须有上限和截断失败处理，不能解析截断 JSON。

运行上限建议独立配置：最多 8 次模型调用、16 次工具、120 秒；最多 2 次修复；同图+同要求+同 revision 可幂等复用结果；超时/取消/旧响应不得应用。模型/API 错误继续使用现有稳定错误码并增加 `FRONTEND_*` 业务错误码。

## 7. 分阶段实施任务

### P0 契约冻结与失败测试

- 新增上述 schema/types、状态机、错误码表和文档。
- 固定截图样例：仅提交获准的测试小图/fixture，不带 base64 大正文和密钥。
- 写测试：非法请求、未知字段、图片超限、缺能力拒绝、不可推断交互、恶意 DSL、路径穿越、超长输出。
- 验收：契约测试先红；旧 Agent/Composer 测试全绿。

### P1 视觉与能力服务

- 新增 `server/src/agent/frontend-reconstruct/{controller,service,types,prompt,schema,capabilities}.ts`，注册 AgentModule。
- 扩展 Runtime 多模态，实现四工具；复用现有 image validator。
- 生成并校验只读能力快照，测试与 Catalog/Base 同源。
- 验收：真实模型对至少 3 种图（清晰首页、复杂/不支持、模糊图）分别产出 planned/rejected/needs-input 或合理近似；无图时不走新端点。

### P2 DSL renderer 与候选工作区

- 新增纯 CJS renderer + schema；输出合法 FrontendPack 文件和 preview JSON。
- 实现私有 workspace、overlay、物化、attempt 保留和原子回滚。
- Composer 支持显式自定义 registry root/overlay，默认路径完全不变。
- 验收：相同 DSL 产物摘要一致；禁止源码/外部 URL/非法事件/未知组件；全局 `git status` 不出现候选资产。

### P3 dry-run、修复与运行时验证

- 实现 dry-run 和结构化 issue；接本地最多两轮 repair。
- 包装真实微信脚本，返回 PASS/FAIL/BLOCKED/NOT_RUN 和截图清单；保留既有 AppID/服务端口处理。
- 对照只检查可观察项：分区顺序、主题、密度、关键组件/按钮、无空白/溢出、关键动作可点；不做无依据的“像素 100%”分数。
- 验收：故意制造未知事件/缺锚点/非法样式可自动定位；两轮仍失败则候选不可采用且当前项目不变。

### P4 桌面服务、状态与 UI

- 扩展 `ScreenReferencePanel`，保留“识别现有模板”兼容区，新增“生成候选前端”主链。
- 展示阶段进度、识别分区/近似/不支持、能力报告、验证报告、截图和修复次数；所有等待都有取消。
- 仅在静态门禁通过时允许采用；`partial` 必须明确“微信验证未完成”并单独确认；失败不清空输入、不覆盖当前版本。
- 接入 App/service/domain/reducer，不堆进组件；新按钮名称唯一，补 UIA verify。
- 验收：从上传到候选采用、放弃、重试、取消、重复点击、切页旧响应均可走查。

### P5 持久化、撤销和正式导出

- `projectSnapshot.mjs` 保存已采用候选引用/DSL/digest/Plan/证据状态，兼容旧快照；运行时进度和 base64 不落盘。
- 采用前保存上一版本；撤销恢复完整 Plan 和展示补丁；再次打开项目校验候选完整性。
- 正式导出使用同一 overlay，校验 digest，报告 candidate 状态；禁止静默回落。
- 验收：采用→保存→重开→导出摘要一致；撤销→重开恢复旧版；删除/篡改候选后提示并回退。

### P6 Skills、文档和可观测性

- 落地四个 skills，更新原 builder、项目概览、交接、Agent Runtime/模板生成文档。
- 过程卡增加真实工具标签，不展示内部敏感细节；所有报告有 runId/attempt/状态和耗时。
- 验收：新 Agent 只按 skill 与工具说明即可完成标准样例，不依赖开发者口头补充。

### P7 全量验收

- 执行下述测试矩阵和命令，保存真实退出码、候选/导出摘要、微信证据位置。
- 未执行微信真机、未接生图均明确范围外，不阻塞“本地受控重构”验收，但不得宣称上线/视觉完美。

## 8. 测试矩阵（最低要求）

### 单元/契约

- 图片：JPEG/PNG/WebP、伪 base64、超限、非 reference、多图、空 utterance 合法（只发图）、超长 utterance。
- VisualSpec：未知区域、低置信度、不可判断交互、恶意文本、非法颜色/尺寸。
- Coverage：已有能力 covered；视觉降级 partial；缺事件/组件/页面 rejected；模型不能伪造 covered。
- DSL：每类节点正常；未知 node/component/event/dataPath；非法 style；脚本/WXS/URL/绝对路径；slot 锚点缺失由 renderer 防护。
- Renderer：确定性、preview 四态、page JSON 子集、事件存在、WXML/WXSS 安全。
- Workspace/overlay：路径穿越、symlink、原子失败、attempt 隔离、全局 Registry 不变。
- Runtime：工具超时/重试/非法参数/循环/取消/上限；视觉消息 wire shape；无图旧行为不变。
- 状态：旧响应、重复采用、失败保留输入、撤销、重开、digest 漂移。

### 集成与负例

- 一张参考图生成 home 候选；一张生成 home+menu（若首期声明支持）。
- 模糊图不编造；不支持交互拒绝且不写 workspace。
- 首次 dry-run 失败→修复成功；连续两次失败→不可采用。
- 模型超时/429/401/无效 JSON/截断 JSON；微信未登录/服务端口关闭/AppID 错误均如实 blocked。
- 采用后正式导出与 dry-run 同源；不采用/放弃不改变现有 Plan。

### 真实场景

至少准备 3 张参考图：Base 近似首页、不同布局首页、包含不支持业务的截图。每张记录识别项、降级、生成结果、验证状态；至少一张完成真实微信编译+首页/菜单截图+关键下单路径不回归。工具不可用则该条 INCOMPLETE，不得用 React 截图替代。

## 9. 最终门禁命令

```powershell
npm test
npm run build
npm run registry:check
npm run catalog:check
npm run mini:check
npm run mirror:check
npm run test:desktop
node scripts/check-packaging.cjs
npm run agent:smoke

Set-Location server
npm test
npx tsc -p tsconfig.json --noEmit --incremental false
npm run build
Set-Location ..

# 对实际生成的候选工程执行，路径由测试报告给出：
npm run composer:verify -- --root <候选工程> --mode development
npm run mini:check -- --root <候选工程>
node scripts/wechat-devtools-run.cjs <候选工程> --json <证据.json> --shots <截图目录>
```

如新增专用命令，补 `frontend:verify` / `frontend:smoke` 并在 AGENTS.md 记录。打包检查必须包含能力快照、DSL schema/renderer、桌面执行模块；运行时不能只在本机仓库找到文件。

## 10. 明确完成标准（P7 实测判定，2026-11-17）

> 判定证据见 [`docs/evidence/frontend-reconstruct/completion-criteria.md`](../evidence/frontend-reconstruct/completion-criteria.md)、
> `gates.md`、`baseline.md`、`real-probe.md`、`real-probe-evidence.json`、`leak-check.md`。
> `PASS` = 有可复核证据；`UNVERIFIABLE` = 有摘要但原始件缺失、无法独立复核；`UNMET` = 条件未满足；
> `BLOCKED` = 环境不可用。**不得把 UNVERIFIABLE/BLOCKED/UNMET 写成通过。**
>
> **2026-11-17 t37 更正**：F3 收口清理删除了 `.tmp/frontend-real-probe/`（三张合成图、生成脚本、
> 候选 attempt 原件），仓库只剩摘要 → 真实模型链路不可独立复核。第 1 项因此由 `PASS` 改为
> `UNVERIFIABLE`；P1 三图矩阵中 `clear-home=UNVERIFIABLE`、`unsupported/blurry=UNMET`（见 §12 P1 行）。
> 第 2/3/5 项保留的 `PASS` 依据是服务端契约与定向测试；其中引用的真实模型/dry-run 摘要同样不可独立复核。

- [ ] 单张图片+可选文字可生成不是“选已有模板”的新候选 FrontendPack。
      —— **UNVERIFIABLE**（原 PASS，t37 降级）：t13 摘要记录 `clear-home` 复跑为 `planned`、draft home 19 节点、
      候选 `fr-5038d20dde55`、`DRY_RUN_OK`；但输入图/候选 attempt 原件已被 F3 清理、仓库无 sha256，
      无法独立复核。同一输入首次运行记录为 `needs-input`（F1），真实链路非确定。不得再据此标 PASS。
- [x] 能力覆盖和不确定项真实可见，缺必需能力不会生成假页面。
      —— **PASS（契约/测试）**；真实三图矩阵 `clear-home=UNVERIFIABLE`、`unsupported/blurry=UNMET`
      （见 `docs/evidence/frontend-reconstruct/completion-criteria.md` §8），不得声称三图能力矩阵已验证：
      server 定向 155/155 覆盖 covered/partial/rejected、模型不能伪造 covered、缺能力拒绝且不写 workspace
- [x] 页面 JS/业务/门店菜品不被模型改写；所有视图经过白名单 renderer 与 Composer。
      —— **PASS（契约/测试）**；**真实候选摘要 `UNVERIFIABLE`**（候选原件已 F3 清理，不得作为 PASS 依据）：
      P2/P4 测试证明 renderer/Composer 白名单、页面 JS 与 Base 逐字节一致、拒绝任意源码；
      t13 摘要中的“8 文件无 .js、WXML 无规范 token、slot fallback 完整”仅作历史记录值
- [x] 候选在私有工作区生成，不改全局模板/Registry，不执行任意命令。
      —— **PASS**（候选仅在系统临时 userData；`git diff --quiet -- templates miniprogram`=0；全局 Registry 摘要不变；
      微信验证拒绝自定义 scriptPath/任意 command）
- [x] dry-run 全绿，失败有最多两轮真实修复；失败不覆盖当前版本。
      —— **PASS（契约/测试）**；**真实 dry-run 摘要 `UNVERIFIABLE`**（候选原件已 F3 清理，不得作为 PASS 依据）：
      P3 repair 12/12 证明 ≤2 轮、`REPAIR_LIMIT_EXCEEDED`、失败 `adoption:'none'` 且保留进入本轮前版本；
      t13 摘要中的 `DRY_RUN_OK` 仅作历史记录值
- [ ] 至少一张样例完成微信真实编译、截图和关键下单动作回归；否则总体验收标 INCOMPLETE。
      —— **BLOCKED / 未满足**：本机无微信开发者工具 CLI，`verify-runtime` 返回 `BLOCKED / RUNTIME_TOOL_MISSING`、截图 0；
      不得用 React 预览截图替代 → **总体验收 INCOMPLETE**
- [x] 采用/放弃/撤销/取消/重试/持久化/重开/正式导出可用且同源。
      —— **PASS（L1 测试）**：app+persistence 41/41、desktop 23/23（adopt/undo/discard/cancel、旧响应丢弃、失败保留输入、
      candidateCheck 漂移阻断导出、撤销未校验版本仍阻断）；GUI 端到端走查 `agent:smoke` 因无窗口/沙箱无法 spawn 标 `BLOCKED`
- [ ] 四个 skills 和文档齐全，全量测试通过，无秘密/图片 base64 泄漏。
      —— **UNMET**：skills 11/11、文档齐全、泄漏扫描通过；但 root `npm test` 975/971（2 项基线失败：catalog 4 项漂移、
      MIRROR 摘要不一致），server `npm test` 460/545（6 个文件依赖 MySQL 失败）→ “全量测试通过”不成立
- [x] 生图模型仍保持未配置，未借此任务接入任何生图 provider。
      —— **PASS**（`IMAGE_PROVIDER_NAME=not-configured`、`IMAGE_MODEL_NAME` 为空；未新增生图依赖/端点）

**P7 结论：`INCOMPLETE`。** 可以说“本地受控候选重构链（P0–P6）已实现并通过定向门禁；t13 摘要记录过一张
参考图候选与 dry-run，但原始件已清理、仅存摘要，无法独立复核（`UNVERIFIABLE`）”；**不可**宣称“已验收 /
全量门禁全绿 / 微信运行时通过 / 三图真实场景矩阵通过 / 像素级复刻”。未执行/不可复核：微信真实编译与截图
（`BLOCKED`）、真机 R（范围外）、安装包 L3/L4、GUI 端到端走查（`BLOCKED`）、生图（按计划不接）、
`unsupported/blurry` 三图证据（`UNMET`）。

## 11. 推荐拆分给 Flash 的连续执行提示

> 在仓库 `E:\智能开店app` 按 `docs/handoff/图片驱动前端重构-Flash实施计划.md` 完整实施 P0–P7。先读 AGENTS.md 和当前交接，检查基线，禁止回滚用户改动。不要只写计划或 prompt；要落地代码、四个 skills、测试、桌面 UI、私有 workspace/Registry overlay、dry-run、真实微信验证和持久化。保留现有 Agent 与 Composer 契约，不接生图，不开放任意 JS/WXML/WXSS/命令。每阶段跑定向测试，结束跑全量门禁并回填真实证据；无法执行的微信步骤明确 INCOMPLETE，不得宣称像素级复刻或全链路已通过。

## 12. 实施实测回填（P7，2026-11-17）

> 证据目录：`docs/evidence/frontend-reconstruct/`（`gates.md` 门禁矩阵、`baseline.md` 基线判定、
> `real-probe.md` + `real-probe-evidence.json` 真实候选**归档摘要（原件已清理，UNVERIFIABLE）**、
> `completion-criteria.md` §10 判定、`leak-check.md` 泄漏检查）。
> `CAPTAIN_RUN` = captain 在 danger-full-access 下执行（日志 `.tmp/captain-gates/*.log`），不计作 verifier 通过。
> **t37 更正**：真实模型相关会话（P1/P3/P7 的参考图/候选/探针）原件已被 F3 清理，仓库仅存摘要，无法独立复核；
> 相关状态按 `real-probe.md` 的 provenance 与 `completion-criteria.md` §8 记为 `UNVERIFIABLE`/`UNMET`，不得写成通过。

| 阶段 | 提交/改动 | 命令与退出码 | 证据 | 状态 |
|---|---|---|---|---|
| P0 契约冻结 | `server/src/agent/frontend-reconstruct/{types,errors,schema,state,index}.ts`、`docs/frontend-reconstruct-contract.md`、fixtures | server 定向套件（含 contract 90）155/155 exit 0；server `tsc` 0；旧 agent 回归 46/46 | `gates.md`；`docs/frontend-reconstruct-contract.md` | PASS |
| P1 视觉与能力服务 | 端点 + 多模态 Runtime + 四工具 + `capabilities.snapshot.*` + `scripts/frontend-capabilities.cjs` | server 定向 155/155 exit 0；`frontend:capabilities:check` exit 0；`check-packaging` exit 0；真实模型：`clear-home=UNVERIFIABLE`（仅摘要）、`unsupported/blurry=UNMET`（无当前证据） | `real-probe.md`、`real-probe-evidence.json`、`completion-criteria.md` §8；`docs/api.md` §11 | **实现与静态门禁 PASS；真实模型证据 UNVERIFIABLE/UNMET** |
| P2 DSL renderer / 私有工作区 / overlay | `desktop/frontend-reconstruct/{schema,render,workspace,registry-overlay,materialize}.cjs`；Composer 显式 registryRoot/assetRoots | root 定向 158/158 exit 0（含 renderer/workspace/materialize）；composer 三文件 21/21 exit 0（P2 复核六文件 63/63）；`git diff --quiet -- templates miniprogram` exit 0 | `gates.md`；`desktop/frontend-reconstruct/README.md` | PASS |
| P3 dry-run / 2 轮修复 / 微信包装 | `dry-run.cjs`、`repair.cjs`、`compare.cjs`、`verify-runtime.cjs`、`scripts/frontend-verify.cjs` | root 定向 158/158 exit 0（dryrun 10/repair 12/verify-runtime 12）；真实候选 `DRY_RUN_OK` 仅为归档摘要（原件已清理）；微信 `BLOCKED` | `real-probe.md`、`real-probe-evidence.json`、`gates.md` | **PASS（测试）**；**真实 dry-run 摘要 `UNVERIFIABLE`**；微信 BLOCKED |
| P4 桌面 IPC / 状态 / UI | `desktop/frontend-reconstruct-ipc.cjs`、`preload.cjs`、`main.cjs`、`src/domain/frontendReconstruct.mjs`、`FrontendCandidatePanel.jsx` | `test:desktop` 23/23 exit 0（verifier 等价 + CAPTAIN_RUN）；root 定向含 app 测试 158/158 exit 0 | `gates.md` | PASS（GUI 走查 BLOCKED） |
| P5 采用 / 撤销 / 持久化 / 导出 | `adoptionBridge.js`、`App.jsx`、`projectSnapshot.mjs`、`exportService.js`、`planFromSession.mjs` | app+persistence 41/41 exit 0；desktop 23/23；t33/t34 复核 verified 门禁 | `completion-criteria.md` §7；`gates.md` | PASS（L1） |
| P6 skills / 文档 / 过程可观测性 | 四个 `.codeartsdoer/skills/*` + builder 更新 + 索引 + 文档 + `agentRunProcess`/`ChatStream` | skills 11/11 exit 0；process-labels 8/8；root `npm run build` 0（CAPTAIN_RUN，vite 6.4.5 / 4.34s） | `gates.md`；`.codeartsdoer/skills/README.md` | PASS |
| P7 全量验收 | `docs/evidence/frontend-reconstruct/*`、本表、§10 | GATE（#1–#7）全绿；CAPTAIN_RUN：`npm test` **1**（975/971，2 项基线失败）、`npm run build` 0、`test:desktop` 0、server `npm test` **1**（460/545，6 文件 MySQL）、server `tsc` 0、server `npm run build` 0；BASELINE：catalog 4 项、MIRROR 摘要；BLOCKED：agent:smoke（无窗口）、微信真实编译（无 CLI） | `docs/evidence/frontend-reconstruct/`（gates/baseline/real-probe/completion-criteria/leak-check） | **INCOMPLETE**（微信真实编译 BLOCKED + 全量门禁含 2 项基线失败）；**真实模型证据 UNVERIFIABLE/UNMET** |

**遗留与后续（交 captain 派发）**

1. 微信真实编译/截图/关键下单回归：需在装有微信开发者工具并登录的机器上执行
   `node scripts/frontend-verify.cjs --attempt <attemptDir> --draft <draft.json> --runtime`，或直接
   `node scripts/wechat-devtools-run.cjs <候选工程> --json <证据> --shots <截图目录>`；在此之前 §10 第 6 项保持 BLOCKED。
2. 基线修复（独立任务，禁止用 `--write`/`mirror:sync` 掩盖）：catalog 4 项 product-detail 重生成并 review；
   MIRROR 摘要与换行语义（`core.autocrlf=true` + DevTools `project.private.config.json`）统一后重算提交。
3. server 6 个 MySQL 依赖测试文件：需要可用 MariaDB/MySQL 或改造成可跳过，不等于功能失败。
4. 真实链路抖动（F1）：同图同请求可能 `needs-input` 后复跑才 `planned`；需评估提示词/预算或显式重试策略。
5. 探针残留清理：`server/src/agent/frontend-reconstruct/.write-probe` 与自忽略 `.gitignore`（见 `leak-check.md` §3）。
