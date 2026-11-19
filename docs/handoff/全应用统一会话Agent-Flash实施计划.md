# 全应用统一会话 Agent：Flash 实施计划

> 计划日期：2026-11-20  
> 已核对基线：`main@d6e7a7f85043cfdee8e29390ee4c880bf1ba0a1f`；核对时 `git status --short` 无输出。  
> 执行者：Flash 团队。本文是自包含任务书，不依赖对话上下文。  
> 当前状态：**T1–T8 已实现；T9 自动化门禁 PASS，真实模型/GUI/微信运行时 NOT_RUN 或 BLOCKED**。
> 实测证据见 `docs/evidence/app-assistant/README.md`（含命令退出码、测试计数、契约偏差）。  
> 开始执行前必须再读根目录 `AGENTS.md`、`docs/项目概览.md`、`docs/handoff/当前工作区交接.md`，并复查 HEAD 与工作区；行号只用于定位，不得覆盖已有改动。

## 0. 目标、范围与默认决策

### 0.1 目标

把项目页右侧栏升级为**跨阶段、按项目工作的统一会话 Agent**：

- 用户在任意项目阶段都能发送文字或图片，不再由当前阶段决定“能不能问、能改什么”。
- 应用显式向 Agent 提供能力目录和完整项目上下文，而不是只给一段提示词，也不从 DOM/截图猜项目数据。
- Agent 只返回有类型、有范围的字段修改、追问或已有业务动作请求。
- 桌面端重新校验所有修改，经现有 reducer/业务入口写回；表单立即更新，可查看变更并撤销。
- 菜单识别、模板修改、参考图重构继续复用现有专用链路，不合并成一个无边界工具。

### 0.2 首批必须打通的纵向流程

```text
任意阶段输入店名、营业时间、取餐方式、菜品
→ app-assistant.v1 生成字段修改
→ 桌面端按同一能力目录校验
→ 一次性写回 agentDraft 与对应 store 字段
→ 所有绑定表单立即更新
→ 自动保存并重开项目仍保留
→ 可撤销/重做

随后：发送门店氛围图
→ 提取用户明确要求的视觉偏好
→ 更新 visual.styleId / visual.prompt
→ 若用户要求保存素材，经确认后写入项目资产与对应引用
→ 可检查、撤销、重开恢复
```

### 0.3 非目标

- 不让模型直接操作 DOM、任意 IPC、文件系统、shell 或 reducer 之外的状态。
- 不把整个 React 组件树、设置页 API Key、绝对路径、base64、完整 prompt、原始 trace 发给模型或写入快照。
- 不重写 `agent-turn.v2`、`template-revise`、`frontend-reconstruct.v1`，不改变它们的校验与确认边界。
- 不自动采用前端候选、不自动导出、不自动发布、不自动写 AppID、不自动选择任意导出路径。
- 不把功能勾选描述成“会裁剪导出工程”：当前 `features.selected` 只影响推荐，Base 内置能力仍由 Recipe 决定导出。
- 不把全局设置（模型 Key、服务地址、超时、自动保存）纳入项目 Agent 可写范围。
- 不用 React 预览截图冒充微信运行时证据；统一入口不会使既有前端重构的 `BLOCKED/NOT_RUN` 变成通过。

### 0.4 已冻结的实施决策

1. 新契约名为 `app-assistant.v1`，新 HTTP 端点为 `POST /api/v1/agent/app-assistant`。
2. 服务端只生成**提案**，绝不声称已经修改桌面项目；最终写入只发生在桌面 reducer/既有业务入口。
3. 字段目录的前端事实源是 `src/domain/appCapabilities.mjs`，约束直接引用现有领域常量/校验器；服务端只读由它生成的快照，禁止手抄第二份字段限制。
4. 统一会话的迟到响应守卫改为 `projectId + requestId + contextRevision`；`phase` 仅作上下文，不再作为拒收条件。
5. 字段修改按批次原子应用；任一项非法则整个字段修改批次不写。业务动作与素材落盘分别走自己的确认和结果状态。
6. HTTP 与 DeepSeek 直连都提供 `app-assistant.v1` transport，避免统一入口在本机服务未启动时退化为纯指引；图片仍按现有视觉能力边界处理，不支持时明确报错，不能静默丢图。

## 1. 已核对的现状与方案修正

### 1.1 可以直接复用的事实

| 现有能力 | 代码事实 | 本方案用法 |
| --- | --- | --- |
| 阶段路由侧栏 | `src/domain/agentSidebar.mjs` 的 `PHASE_ROUTES` 只允许资料/模板阶段调用模型；`buildAgentChatSubmitPlan` 是提交入口 | 用统一意图入口替换阶段路由，保留消息规范化、数量限制、错误与安全过程卡 |
| 项目权威状态 | `src/state/sessionMachine.mjs` 已有 `store/features/build/visual/agentDraft/screenRef/presentation/assets/project` | 从状态构造安全项目上下文；不读 DOM，不复制 React 状态 |
| 资料校验 | `src/domain/agentDraft.mjs` 提供 `normalizeAgentDraft`、`validateAgentDraft`、`applyDraftPatch`、`AGENT_DRAFT_LIMITS` | 字段目录直接复用这些约束；桌面写回后重新计算缺项和错误 |
| 项目持久化 | `src/domain/projectSnapshot.mjs` 白名单保存业务切片和 `agentChat.messages` | 新字段修改继续走现有快照；不持久化在途请求、图片正文和待确认提案 |
| 撤销/重做 | `sessionMachine.mjs` 的 reducer 包装层，栈深 20，仅业务切片变化才压栈 | 一批 Agent 字段修改只产生一个撤销单元 |
| 服务端 Runtime | `server/src/agent/runtime/` 已有工具注册、schema、超时、重试、并发、循环检测与上限 | 新服务复用 Runtime，不另写服务端 loop |
| 直连 Runtime | `src/services/agentTurn/directAgentRunTransport.js` 通过主进程 `modelChat` 调模型，密钥不进渲染层 | 新 direct transport 复用 `modelChat` 出口，实现同一响应契约 |
| 菜单/环境图片 | `agent-turn.v2`、`agentImageInput.mjs`、`agentImageUpload.js` | 菜单图片继续走 v2；环境图可用于视觉理解 |
| 图片资产落盘 | `projectService.attachImageData` → 受限 IPC → `desktop/asset-store.cjs`，主进程复检 MIME/大小/摘要 | 用户确认保存素材后复用，不新增任意文件写入通道 |
| 展示修改 | `template-revise` + `presentationPatch` + 现有 reducer/撤销 | 统一会话只调度，仍由原服务生成和校验补丁 |
| 参考图候选 | `frontend-reconstruct.v1` + 私有 attempt + dry-run/微信验证 + 采用链 | 侧栏可发起并展示真实状态，但采用/撤销/验证仍在原链 |

### 1.2 原方案必须修正的四个点

1. **不能只把阶段名换成意图名。** 当前 `store.name/type` 与 `agentDraft.storeName/category` 是双写关系；必须先定义 canonical fieldId 与写回映射，否则 Agent 填了草稿，另一个表单可能不更新。
2. **不能继续用 phase 判断迟到响应。** 用户跨阶段是该功能的核心场景；如果发请求后切换页面就拒收，会误伤合法结果。应以项目业务内容版本判断是否可以写入。
3. **不能让服务端返回 `applied`。** Runtime 的工具只写单次请求内存，桌面项目不在服务端；服务端状态只能是 `proposal/needs-input/rejected`，`applied` 是桌面本地事实。
4. **不能只做 HTTP transport。** 当前设置页推荐直连 DeepSeek，已有 `modelChat` 安全出口。只接 HTTP 会让一部分现有用户失去可用会话，因此 direct 文本闭环属于首批范围，不是后续可选优化。

## 2. 目标架构

```text
AgentSidebarPanel（任意阶段统一输入与附件）
  ↓
App.jsx 组合根：冻结 projectId/requestId/contextRevision
  ↓
buildProjectAgentContext(state) + buildAppCapabilityCatalog()
  ↓
appAssistantService
  ├─ HTTP → /api/v1/agent/app-assistant → 服务端 Runtime + 受控工具
  └─ direct → 主进程 modelChat → 本地受控工具循环
  ↓
app-assistant.v1：reply + changes + questions + actionRequests + trace
  ↓
桌面端再次校验 catalogVersion/contextRevision/字段/值/动作前置条件
  ├─ 字段批次 → 现有 reducer → 校验/撤销/自动保存/表单同步
  ├─ 菜单识别 → agent-turn.v2 → 结果转换为标准字段批次 → 同一 reducer
  ├─ 模板修改 → template-revise 原入口
  ├─ 参考图 → frontend-reconstruct.v1 原候选链
  └─ 素材保存/模板采用/导出等 → 用户确认 → 既有业务入口
```

### 2.1 服务端受控工具

新增业务服务，不修改 Runtime 的通用语义。工具白名单如下：

| 工具 | sideEffect | 作用 |
| --- | --- | --- |
| `get_project_capabilities` | read | 按 domain 返回可写字段、选项、限制和可用动作；数据来自服务端只读生成快照 |
| `get_project_context` | read | 返回本轮客户端提供的安全项目快照、缺项、校验错误和候选状态 |
| `propose_project_changes` | write（仅内存） | 累积字段修改提案；按 catalog 做初步校验，不写数据库或桌面项目 |
| `request_business_action` | write（仅内存） | 登记已有业务动作请求；不真正导航、导出、采用候选或写文件 |
| `ask_follow_up` | write（仅内存） | 记录有界追问，尤其是图片用途歧义和信息不足 |

模型无权注册工具、传入新工具名、决定校验通过、降低确认级别或声明项目已写入。

## 3. 应用能力目录与项目上下文

### 3.1 字段总表

下列 fieldId 是对模型暴露的稳定业务 ID，不等同于某个 React props 名。`M1/M2/M3` 是开放写入的先后，不影响从第一版就提供只读上下文。

| fieldId / 能力 | 权威状态与写回 | 校验/限制来源 | 风险与阶段 |
| --- | --- | --- | --- |
| `store.name` | `agentDraft.storeName` + `store.name` 同步 | `AGENT_DRAFT_LIMITS.maxStoreName`，trim，1–48 字 | 明确设置可自动；清空需确认；M1 |
| `store.category` | `agentDraft.category` + `store.type` 同步 | `maxCategory`，1–24 字 | 同上；M1 |
| `store.businessHours` | `agentDraft.businessHours` | `normalizeBusinessHoursText`、`validateAgentDraft`、营业时间规则 | 非法整批拒绝；M1 |
| `store.fulfillment` | `agentDraft.fulfillment.{dineIn,takeaway}` | 两个 boolean，至少一个为 true 才能进入 review | 明确设置可自动；M1 |
| `store.dishes` | `agentDraft.dishes`，稳定 `dish.id` | 1–8 道；菜名≤24；描述≤60；价格整数分 1–999999 | upsert 可自动；remove 需确认；M1 |
| `store.address` | `store.address` | 与 `projectSnapshot.pickStore` 一致，≤120 | 明确设置可自动；M1 |
| `store.phone` | `store.phone` | ≤32；本阶段只做长度/字符校验，不猜真实号码 | 明确设置可自动；M1 |
| `store.notes` | `store.notes`；兼容旧 `intro` 的读取，不新写 `intro` | ≤200 | 只记录用户提供或明确要求代拟的文案；M1 |
| `visual.styleId` | `visual.styleId`，复用 `SET_STYLE` 对 theme patch 的清理语义 | `STYLE_PRESETS` id | 明确选择可自动；M2 |
| `visual.prompt` | `visual.prompt` | `projectSnapshot.pickVisual` ≤2000 | 只写用户偏好/图片可观察事实；M2 |
| `store.imageAssetIds` | 项目素材元数据 + 门店环境图引用 | 真实 assetId，最多 6 张，主进程复检 | 保存/解除引用需确认；M2 |
| `visual.imageAssetId` | 海报素材引用 | 真实 assetId，区分 user-upload/ai-generated | 保存/替换需确认；M2 |
| `features.selected` | `features.selected`，复用 `TOGGLE_FEATURE` 语义 | `catalog.mjs` id；required 不可移除 | 勾选/取消可自动；必须披露“不裁剪导出”；M3 |
| `features.custom` | `features.custom` | ≤500 | 明确文本可自动；M3 |
| `project.appid` | `project.appid`，复用现有 AppID 动作 | 现有 AppID 校验 | 需确认；M3 |
| `build.selectedId` | 不作为普通字段写；映射 `template.select` | 必须来自当前 candidates/Recipe | 需确认，沿用模板切换清理 patch 语义；M3 |
| `deploy.directory` | 禁止模型写字符串路径 | 只能调现有目录选择器 | 用户选择目录；M3 |
| `build.candidates/screenRef/frontendCandidate/deploy.result` | 只读上下文 | 现有领域状态 | 只能请求对应业务动作 |
| `settings.*`、模型 Key、API 地址、项目搜索、输入草稿、动画/请求态 | 不进入可写目录 | 非项目业务字段或秘密 | 永久排除 |

**菜品描述红线：** 用户没有明确要求代拟时，不得因为图片或店名“看起来很合理”就生成描述；未提供的描述保持原值或空字符串。不得编造价格、营业时间、地址、电话、AppID、资产 ID。

### 3.2 安全项目上下文

新增 `src/domain/projectAgentContext.mjs`，输出有界 JSON：

- `projectId`、`contentRevision`、当前 `phase`（仅供理解，不做写入权限判断）。
- 上表所有项目字段的当前值；未开放写入的字段标为只读。
- `validateAgentDraft` 产生的 `missingFields/errors/readyForReview/nextQuestion`。
- 功能目录与已选状态、模板 candidates/selectedId、当前展示补丁的安全摘要。
- 视觉风格、素材元数据（assetId、文件名、MIME、尺寸、来源），**没有 dataUrl/base64/绝对路径**。
- 参考图和前端候选的状态、runId、attempt、验证结论与降级项；不含原始 trace。
- 部署仅包含状态、AppID 是否已填、preflight 摘要；`deploy.directory` 不出现在模型上下文。

禁止输出 `settings`、`unmappedFields`、完整 sessions、模型原始响应、完整 prompt、文件系统路径和密钥。

### 3.3 contextRevision：跨阶段与防串的唯一版本口径

新增内存态 `project.contentRevision`，初始为 0：

1. 在 reducer 包装层比较动作前后的**业务上下文快照**（排除 phase/view/chat/请求态/设置/绝对路径）;实际变化时递增。
2. 页面切换、会话切换、输入草稿变化不递增；手改任何项目字段、撤销/重做、素材引用变化都递增。
3. 打开/新建/重置项目仍放弃在途会话；重开项目从 0 开始即可，因为旧请求已按 projectId/requestId 失效。
4. 请求发起时冻结 `requestContextRevision`；响应必须带回同值，桌面以当前值再次比较。
5. 版本不同则返回 `APP_ASSISTANT_CONTEXT_STALE`，不写任何字段，提示“项目在此期间已变化，这次结果未写入，请重试”。本版不做自动 rebase/三方合并。
6. `agentChat` 的旧 `requestPhase` 可保留为消息上下文，但不再参与 `isChatResponseAcceptable`；旧的 `requestDraftRevision` 不能代表 features/visual/assets，统一请求必须改用 `requestContextRevision`。

## 4. `app-assistant.v1` 契约

### 4.1 请求

```json
{
  "contractVersion": "app-assistant.v1",
  "requestId": "chat_req_...",
  "catalogVersion": "app-capabilities.v1",
  "contextRevision": 7,
  "utterance": "店名改为松月食堂，10点到21点营业，支持堂食和自取，加牛肉面28元",
  "history": [
    { "role": "user", "text": "上一条用户消息" },
    { "role": "assistant", "text": "上一条助手回复" }
  ],
  "client": { "surface": "desktop", "phase": "template-pick" },
  "project": {
    "projectId": "p_...",
    "context": {}
  },
  "attachments": []
}
```

约束：

- 顶层和嵌套协议对象严格拒绝未知键。
- `history` 最多 12 条，仅 user/assistant 安全正文，总长度≤6000；不传 system 消息、附件正文或运行 trace。
- 纯文字时 utterance 为 1–500 字；有附件时允许为空，由客户端按附件用途生成内部指令，用户气泡如实显示“发送了图片”。
- `project.context` 必须经安全 schema 校验和大小限制；服务端不根据 projectId 查库，也不信任其中的“校验通过”声明。
- `catalogVersion` 与服务端生成快照不一致时 fail closed，避免旧客户端向新字段写入错误值。
- `requestId` 同时进入现有 `X-Agent-Request-Id` 请求头；如请求头也携带，二者必须一致。补充 CORS 回归，不能只测健康 GET。

### 4.2 响应

```json
{
  "contractVersion": "app-assistant.v1",
  "requestId": "chat_req_...",
  "runId": "run_...",
  "catalogVersion": "app-capabilities.v1",
  "contextRevision": 7,
  "status": "proposal",
  "reply": "已整理这些资料，请核对。",
  "proposalId": "proposal_...",
  "changes": [
    {
      "opId": "op_1",
      "op": "field.set",
      "fieldId": "store.name",
      "value": "松月食堂",
      "evidence": { "source": "utterance", "excerpt": "店名改为松月食堂" },
      "reason": "用户明确指定店名"
    }
  ],
  "questions": [],
  "actionRequests": [],
  "trace": {
    "modelCalls": 2,
    "toolCalls": [],
    "stopReason": "final_answer",
    "degraded": false
  },
  "meta": {
    "transport": "http",
    "provider": "deepseek",
    "mock": false,
    "model": "deepseek-chat",
    "latencyMs": 1200,
    "runId": "run_..."
  }
}
```

`status` 只有：

- `proposal`：有字段修改或动作请求，或已经给出完整答复；不代表桌面已应用。
- `needs-input`：缺少依据或用途不明，必须给具体问题，不得附带猜测性写入。
- `rejected`：请求超出能力目录或安全边界，不提供替代写入。

桌面本地另算 `applyStatus: applied | awaiting-confirmation | stale | rejected | failed`，不能来自模型。

### 4.3 修改与动作类型

首期只允许：

- `field.set`：`{fieldId,value}`，值类型由 catalog 决定。
- `dish.upsert`：按现有 `dishId` 或精确菜名匹配；新增时由桌面 `createDishId` 分配 ID。价格只接受整数分或 null。
- `dish.remove`：按存在的 dishId；必须确认。
- `action.request`：`{actionId,params,attachmentIds?}`，actionId 必须来自 catalog；模型不能提供 reducer action type、函数名、IPC 名或路径。

每个 change 都有 opId 与 evidence；excerpt 最长 120 字，图片证据只引用 attachmentId，不含 base64。单轮最多 24 个 changes、3 个 questions、2 个 actionRequests；reply≤500 字。

### 4.4 风险与确认

风险由**桌面 catalog** 决定，模型传 `requiresApproval:false` 无效。

- 可直接应用：用户明确给出的非空 field.set、dish.upsert、features 勾选/自定义、视觉偏好。
- 必须确认：清空已有值、dish.remove、保存/替换/解除素材引用、模板选择、AppID 写入、候选采用/放弃、正式导出。
- 原链已有确认：partial 候选采用、导出 preflight 警告、AppID 写文件等仍执行原确认，不得被统一会话跳过。
- 字段批次原子应用；高风险项形成独立 pending confirmation，不与低风险字段混成半批。若任一字段校验失败，则该字段批次全部不写。

### 4.5 稳定错误码

至少覆盖：

`APP_ASSISTANT_REQUEST_INVALID`、`APP_ASSISTANT_CONTRACT_MISMATCH`、`APP_ASSISTANT_CATALOG_MISMATCH`、`APP_ASSISTANT_CONTEXT_INVALID`、`APP_ASSISTANT_CONTEXT_STALE`、`APP_ASSISTANT_RESPONSE_INVALID`、`APP_ASSISTANT_FIELD_UNKNOWN`、`APP_ASSISTANT_FIELD_READ_ONLY`、`APP_ASSISTANT_VALUE_INVALID`、`APP_ASSISTANT_OPERATION_DENIED`、`APP_ASSISTANT_CONFIRMATION_REQUIRED`、`APP_ASSISTANT_ACTION_UNAVAILABLE`、`APP_ASSISTANT_ATTACHMENT_PURPOSE_UNKNOWN`、`APP_ASSISTANT_PROPOSAL_DUPLICATE`。

上游模型/网络错误沿用现有 `DEEPSEEK_*` / `AGENT_*` 映射，不新建同义错误体系。

## 5. 图片统一入口与路由

### 5.1 附件模型

右侧栏在所有项目阶段都可添加图片，附件包含：

`id/kind/mediaType/dataBase64/previewDataUrl/name/bytes`，其中 `kind = auto | menu | store | reference`。

- `auto`：让 Agent 判断用途；不确定就追问“识别菜单、提取门店氛围，还是参考界面重构？”。
- `menu`：走 `agent-turn.v2`，结果转换为标准 `field.set/dish.upsert` 批次后由统一 reducer 写入。
- `store`：走 `app-assistant.v1` 视觉输入，可提出 `visual.styleId/visual.prompt`；只有用户明确要求保存时才产生素材动作。
- `reference`：恰好一张进入 `frontend-reconstruct.v1`，目标页未说明时默认 home 并在回复中明示；需要其他页时先问，不擅自多页生成。
- 允许只发图片；`auto` 的内部 utterance 为“请判断图片用途，不确定时先追问”，这不是伪造用户文字。

复用现有 JPEG/PNG/WebP、单张/合计字节、压缩和数量限制；不要把 `auto/reference` 传给只接受 menu/store 的旧 `validateAgentImages`，应在新附件校验器中复用底层字节/MIME规则并增加用途规则。

### 5.2 不重复实现专用链

| 用户意图 | 调用 | 写入边界 |
| --- | --- | --- |
| “识别这张菜单” | `agent-turn.v2` | 只有 `vision.analyzed=true` 才把差异转标准字段批次；否则不写入 |
| “按这张照片做成清爽青绿风格” | `app-assistant.v1` 带 store 图 | 只写视觉字段，不自动保存素材 |
| “把这张保存为门店环境图” | 先确认 → `attachImageData` → `ADD_PROJECT_IMAGES`/引用更新 | 真实 assetId 才能入状态；撤销恢复项目引用与元数据，物理内容寻址文件可留作 redo，不得显示 phantom asset |
| “照这个界面重构首页” | `frontend-reconstruct.v1` 既有 service/domain/IPC | 原验证、partial 确认、采用/撤销链不变 |
| “修改当前模板主题色” | `template-revise` 原入口 | 原 presentationPatch 校验和撤销不变 |

direct 文本必须可用；如果 direct 当前 `modelChat` 不支持图片片段，带图时明确提示使用本机模型服务，不得把图片从请求里静默删除后继续。

## 6. 写回、撤销、持久化与重复提交

1. 新增 `src/domain/appAssistantProposal.mjs`：校验响应外壳、字段、操作、证据、动作和 catalog/context 版本。
2. reducer 新增统一批次动作（建议 `APP_ASSISTANT_CHANGES_APPLY`），只接受领域层已规范化提案，并在 reducer 内再校验当前 contextRevision。
3. `store.name/category` 必须同步两个现有切片；`store.notes` 不再写第二份 `intro`。必要时调整 `StoreInfoStep` 的读取为 `notes ?? intro`，消除表单不更新。
4. 每批只加入一次 `UNDOABLE_ACTIONS`，key 使用 proposalId；连续字段操作不能逐字段产生多个撤销格。
5. 变更摘要以桌面实际 before/after 生成，显示字段中文名和值，不直接相信模型的“已修改”文案。
6. “撤销本轮”按钮仅当当前 contextRevision 仍等于该批应用后的版本时可用，避免撤销到后续用户修改；其他情况使用现有全局撤销。
7. `agentChat.lastAppliedProposal` 等运行态不落盘；assistant 消息只保存安全摘要。重开后业务字段恢复，undo 栈仍按现有规则不恢复。
8. `requestId` 防止同一响应重复回调；`proposalId` 防止同提案重复应用；素材由内容摘要去重。重试生成新 requestId，不重复追加 user 消息。
9. M2 若允许撤销素材添加，`undoSnapshot/UNDO_APPLY` 必须同时覆盖 `assets.images` 与所有素材引用；自动保存后重开验证没有幽灵素材。物理文件保留用于 redo 需在文档中如实说明。

## 7. Flash 分步任务

### 执行规则

- 按依赖顺序执行，先写失败测试再实现；不得删弱既有测试。
- 每个任务只写自己的 write_set；必须越界时先停下来报告，不得悄悄扩大。
- 不提交 git commit，除非用户另行明确要求。
- 每个任务结束都运行自己的定向测试，并记录真实退出码；环境失败写 `BLOCKED`，不是 PASS。
- T3/T4/T5 可并行；共享工作区时不得同时改 App.jsx 或 sessionMachine.mjs。T6 之后接线任务串行。

---

### T1：冻结协议、字段总表与契约夹具

**依赖：** 无，Flash 从这里开始。  
**write_set：**

- `contracts/app-assistant.v1.json`
- `docs/app-assistant-contract.md`
- `test/fixtures/app-assistant/contract/cases.json`
- `test/app-assistant-contract.test.cjs`

**实现：**

1. 把第 4 节的请求/响应、状态、操作、附件、限制、错误码写成机器可读契约。
2. 明确 settings/任意路径/任意 action type/外部 URL/base64 持久化均为拒绝项。
3. 夹具至少覆盖：合法文字、附件-only、未知键、错误 contract/catalog、history 超限、未知 field、只读 field、错误值类型、菜品非法价格、缺失证据、危险 action、path 注入、data URL 滥用、重复 opId。
4. 契约文档说明“服务端 proposal ≠ 桌面 applied”。

**验收：** 新契约测试能运行并对非法夹具给出稳定拒绝路径；既有 `node --test test/agent-sidebar.test.cjs` 不回归。

---

### T2：应用能力目录、项目上下文与服务端快照生成

**依赖：** T1。  
**write_set：**

- `src/domain/appCapabilities.mjs`
- `src/domain/projectAgentContext.mjs`
- `scripts/app-capabilities.cjs`
- `server/src/agent/app-assistant/capabilities.snapshot.json`（仅生成物）
- `test/app-capabilities.test.cjs`
- `test/app-assistant-context.test.cjs`
- `package.json`（仅新增 `app:capabilities[:check]` 脚本）

**实现：**

1. 用 `AGENT_DRAFT_LIMITS`、`STYLE_PRESETS`、`catalog.features`、现有 snapshot 限制生成字段描述，禁止复制数值常量。
2. catalog 包含 fieldId、label、type、writable、risk、options、缺项来源、写回语义与允许附件用途；函数/动作实现不进 JSON。
3. context 覆盖整个项目而非当前 phase，严格剔除第 3.2 节禁项。
4. 实现 `buildProjectContextSnapshot`，供 contentRevision 比较；不包含 phase/chat/transient。
5. 脚本 `--write` 生成服务端只读快照，`--check` 逐字节校验；快照带 `app-capabilities.v1` 和确定性摘要。

**验收：** 修改输入状态只影响预期上下文；快照无绝对路径/base64/Key/settings；生成两次一致，`--check` exit 0；字段约束与现有领域常量有断言绑定。

---

### T3：桌面提案校验、原子写回、版本与撤销

**依赖：** T2。  
**write_set：**

- `src/domain/appAssistantProposal.mjs`
- `src/state/sessionMachine.mjs`
- `src/domain/projectSnapshot.mjs`（仅确需快照白名单调整时）
- `test/app-assistant-proposal.test.cjs`
- `test/app-assistant-reducer.test.cjs`

**实现：**

1. 实现响应和字段批次校验，未知字段/动作、只读字段、非法值、重复 opId 全部 fail closed。
2. 增加 project.contentRevision 及包装层递增规则；phase/chat 变化不递增，业务变化/undo/redo 递增。
3. 实现统一批次 reducer，完成 store 与 agentDraft 双写、营业时间/价格/菜品校验、缺项重算。
4. 一批一撤销；无实际变化不压栈；stale/duplicate/非法提案连 undo 元数据都不改变。
5. 保持原 `handleAgentTurn` 主面板和 template-revise 的行为，不在本任务改 App。

**验收：** 覆盖跨阶段接受、手改后 stale、重复 proposal、非法整批拒绝、店名双写、营业时间跨天、菜品 upsert/remove 确认标记、undo/redo、重开快照恢复。

---

### T4：服务端 `app-assistant.v1` Runtime 服务

**依赖：** T2。  
**write_set：**

- `server/src/agent/app-assistant/**`（`capabilities.snapshot.json` 除外，只读）
- `server/src/agent/agent.module.ts`
- `server/src/common/config/env.validation.ts`（仅确需新增上限时）
- `server/.env.example`（同上）
- `server/test/app-assistant*.test.ts`

**实现：**

1. 新增 controller/service/types/prompt/tools，端点 `/api/v1/agent/app-assistant`，复用 `AgentAuthGuard` 和现有错误过滤。
2. 注册第 2.1 节五个工具；Runtime 上限沿用 6 模型调用/12 工具/60s，除非契约另有配置。
3. 所有写工具只修改单次请求 proposal buffer；无数据库、文件、桌面 IPC。
4. 严格验证 context、附件、catalogVersion、requestId、history 和输出；模型截断时拒绝解析残片。
5. trace 只含调用元数据，不含上下文正文、utterance、工具参数/结果、prompt、图片。

**验收：** 在 `server/` 下执行 `npx vitest run test/app-assistant*.test.ts` 全绿；`npx tsc -p tsconfig.json --noEmit --incremental false` exit 0；stub model 覆盖五工具、歧义追问、非法写入、上限、降级、无实际项目副作用。

---

### T5：HTTP、direct、mock transport 与统一服务

**依赖：** T1/T2；可与 T3/T4 并行。  
**write_set：**

- `src/services/appAssistant/**`
- `test/app-assistant-service.test.cjs`
- `test/app-assistant-transports.test.cjs`

**实现：**

1. `appAssistantService.js` 负责组请求、选择 transport、校验响应外壳，不写业务状态。
2. HTTP transport 使用 `/api/v1/agent/app-assistant`、超时/取消、`X-Agent-Request-Id`、现有 Authorization 获取方式；不打印 Key。
3. direct transport 复用 `window.smartStore.modelChat`，实现同样的工具白名单、调用上限、循环检测和 proposal 响应；密钥仍只在主进程。
4. mock 只用于确定性测试；带图时不伪造 `vision.analyzed` 或真实识别结果。
5. direct 不支持图片时返回结构化可读错误；HTTP/direct 响应后续都进入同一个桌面校验器。

**验收：** 同一 stub 对话在 HTTP/direct 得到相同标准提案；覆盖超时、取消、非法响应、catalog mismatch、无桥、无图片静默丢弃回归。

---

### T6：替换阶段路由，完成文字纵向闭环

**依赖：** T3、T5；真实 HTTP 联调另需 T4。  
**write_set：**

- `src/domain/agentSidebar.mjs`
- `src/components/agent/AgentSidebarPanel.jsx`
- `src/components/agent/AppAssistantChangeCard.jsx`（新增）
- `src/components/build/StoreInfoStep.jsx`（仅 notes 兼容需要时）
- `src/styles/agent-sidebar.css`
- `src/App.jsx`
- `test/agent-sidebar.test.cjs`
- `test/app-agent-sidebar-wiring.test.cjs`
- `test/app-assistant-sidebar-panel.test.cjs`

**实现：**

1. `buildAgentChatSubmitPlan` 不再按 phase 返回 guide；有项目即进入统一 app-assistant，模板修订等由结果 actionRequest 分流。
2. 请求冻结 projectId/requestId/contextRevision，响应按新三元组验收；切阶段不拒收，切项目/手改业务数据拒收。
3. App 只负责协调 service/reducer/既有 handler；意图和字段规则留在 domain。
4. 应用后显示真实 before/after 变更卡、应用状态和“撤销本轮”；追问/拒绝/stale 不显示成功。
5. 自动保存沿用现有项目机制；不重写 projectService。
6. 控件补唯一可访问名称：统一输入区、发送、变更卡、撤销本轮、重试。

**验收：** 在模板/视觉/部署阶段输入第 0.2 节文字，店名、营业时间、取餐方式、菜品立即出现在对应表单；undo/redo 正确；保存并重开保留；重复点击/重试/迟到响应不写重复数据。

---

### T7：图片附件、氛围纵向流程与素材撤销

**依赖：** T6；在 App.jsx 接线串行执行。  
**write_set：**

- `src/domain/appAssistantAttachments.mjs`
- `src/components/agent/AgentChatAttachments.jsx`
- `src/services/appAssistant/attachmentRouter.js`
- `src/state/sessionMachine.mjs`
- `src/domain/projectSnapshot.mjs`
- `src/App.jsx`
- `src/styles/agent-sidebar.css`
- `test/app-assistant-attachments.test.cjs`
- `test/app-assistant-image-wiring.test.cjs`
- `test/app-assistant-asset-undo.test.cjs`

**实现：**

1. 全阶段开放 auto/menu/store/reference 附件选择，允许只发图；保留压缩/限制和拖拽。
2. 按第 5 节路由到 app-assistant/agent-turn.v2/frontend-reconstruct；歧义只追问。
3. 菜单结果转标准 changes 后统一写回；不可信或 `analyzed=false` 不写。
4. 氛围图可写 style/prompt；素材保存必须确认后走 attachImageData，并显示真实 assetId 对应预览。
5. undo 快照补齐 assets 与引用，验证保存/撤销/redo/重开无幽灵素材。
6. reference 只调用原候选链，保留 partial/BLOCKED/NOT_RUN 和采用确认。

**验收：** “参考这张门店照片，使用清爽青绿，并保存为门店环境图”能更新 `fresh` 风格，经确认保存环境图；重开恢复；撤销解除本轮引用；菜单/参考图不错误进入环境素材链。

---

### T8：开放剩余项目字段与已有业务动作

**依赖：** T7。  
**write_set：**

- `src/domain/appCapabilities.mjs`
- `src/domain/appAssistantProposal.mjs`
- `src/services/appAssistant/actionExecutor.js`
- `src/state/sessionMachine.mjs`
- `src/App.jsx`
- `server/src/agent/app-assistant/capabilities.snapshot.json`（重新生成）
- `test/app-assistant-actions.test.cjs`
- `test/app-assistant-action-wiring.test.cjs`

**实现：**

1. 开放 features.selected/custom、project.appid（确认）及 M3 动作。
2. actionExecutor 只含显式映射：`navigate.phase`、`template.select/revise`、`frontend.reconstruct/adopt/discard`、`agentDraft.confirm`、`export.preflight/choose-directory/run`。
3. 每个动作检查 candidates/preflight/忙碌状态等当前前置条件；采用、导出、AppID、目录仍走原确认。
4. 禁止通用 `dispatch(action.type)`、任意 IPC、模型提供路径。
5. 功能勾选变更附近显示“影响模板推荐，不会从 Base 工程移除未勾选内置能力”。

**验收：** 非法 actionId/过期候选/重复导出/无 preflight 均拒绝；真实动作只调用一次既有入口；不存在绕确认路径。

---

### T9：端到端验收、文档与交付收口

**依赖：** T1–T8。  
**write_set：**

- `scripts/app-assistant-smoke.cjs`（UIA 验收脚本）
- `package.json`（仅新增 smoke 脚本）
- `docs/evidence/app-assistant/`
- `docs/项目概览.md`
- `docs/agent-runtime.md`
- `docs/api.md`
- `docs/待完成目标.md`
- `docs/README.md`
- `docs/handoff/当前工作区交接.md`
- `docs/handoff/README.md`
- `docs/handoff/全应用统一会话Agent-Flash实施计划.md`（只回填实测）
- 根目录 `AGENTS.md`（仅新增必要命令/边界）

**实现：** 执行第 8–10 节全部验收，按真实结果记录 PASS/FAIL/BLOCKED/NOT_RUN；最后才整理文档，不把计划写成已完成事实。

## 8. 最低测试矩阵

### 8.1 契约与领域

- 全字段合法/非法/边界值；店名和品类双写；notes/intro 兼容。
- 营业时间单段、多段、跨天、非法段；价格元转整数分、null、非整数、越界。
- 菜品新增/按 id 更新/按精确名更新/重名/超过 8 道/删除确认/无授权描述不生成。
- required feature 不可移除；功能勾选不被宣称为导出裁剪。
- 未知字段/只读字段/非法 action/路径/任意 IPC/外部 URL/脚本/data URL 全拒绝。
- context 不包含设置、Key、绝对路径、base64、完整会话和原始 trace。

### 8.2 并发与持久化

- 任意 phase 切换后合法响应仍可应用。
- project 切换、重置、删除后响应拒收。
- 请求期间手改字段、撤销、素材变化 → stale，整批不写。
- 同 request 回调两次、同 proposal 重放、重试、连点发送 → 不重复写、不重复气泡。
- 一批一次 undo；undo/redo 后 revision 前进；重开业务数据恢复、运行态不恢复。
- 自动保存与素材主进程写盘交错后无旧快照覆盖新资产。

### 8.3 服务端与 transport

- 五工具正常/未知工具/参数错误/超时/重试/循环/上限/取消/截断。
- HTTP/direct 同一 fixture 语义一致；direct 无桥、图片不支持如实报错。
- HTTP 真实业务 POST 覆盖 CORS `X-Agent-Request-Id`，不能用健康 GET 代替。
- trace/log/响应/快照不含秘密或图片正文。

### 8.4 UI 与专用链

- 所有阶段有统一输入与图片入口；控件可访问名称唯一。
- 追问、校验拒绝、pending confirmation、partial、stale、失败、重试均有真实可见状态。
- 菜单图只有 analyzed=true 才写；store 图不自动变素材；reference 图不绕过候选验证。
- 模板修订仍走 presentationPatch；前端候选采用/撤销仍走原状态机。

## 9. 必跑命令与真实纵向验收

### 9.1 定向与全量门禁

```powershell
npm test
npm run build
npm run test:desktop
npm run app:capabilities:check
npm run frontend:capabilities:check
node scripts/check-packaging.cjs

Set-Location server
npx vitest run test/app-assistant*.test.ts
npx tsc -p tsconfig.json --noEmit --incremental false
```

如修改了前端重构共享契约或生成脚本，再按 AGENTS.md 跑 `frontend-contract --check`；不得擅自重冻结 Registry。DB 测试只有在 MySQL 可用时运行；不可达要明确写环境 BLOCKED，不得把 skip 当通过。

### 9.2 UIA 闭环

先 `npm run agent:app`，再运行新 `app-assistant-smoke` 和既有 `npm run agent:smoke`。UIA 脚本通过真实界面新建/打开项目，不得手改 project.json 造数据。

至少自动走查：

1. 在非资料阶段发送：“店名改为松月食堂，每天10点到21点，支持堂食和自取，加一道牛肉面28元。”
2. 验证对应表单真实 DOM/无障碍树出现“松月食堂”“10:00-21:00”“牛肉面”“28”。
3. 点“撤销本轮”验证恢复，再 redo；随后保存并重开项目验证恢复。
4. 请求期间手改店名，返回后显示 stale 且手改值未被覆盖。
5. 发“看看这张图”且图片用途不明，验证出现三选一式追问，没有字段写入。
6. 发门店图并明确要求“清爽青绿 + 保存为门店环境图”，验证视觉字段、确认卡、素材预览、撤销和重开。
7. 菜单图、模板修改、参考图分别核对进入原链；参考图验证不可用时必须显示 BLOCKED/NOT_RUN。

### 9.3 真实模型证据

- 至少一次 HTTP 真实文字请求和一次直连文字请求，记录 requestId/runId、模型、耗时、结果摘要，不记录 Key/完整 prompt。
- 至少一次真实菜单或氛围图片请求；只有真实 `analyzed=true` 才能声称图片识别成功。
- 模型/API Key/MySQL/微信工具不可用时分项标 BLOCKED；自动化 stub 全绿也不能把整体标为真实 E2E PASS。

## 10. 完成定义与交付报告

只有同时满足以下条件才可写 PASS：

- M1 文字纵向流程在至少两个非资料阶段通过真实 UI，表单同步、撤销、保存重开均正确。
- M2 氛围图能写视觉字段，保存素材经过确认且可撤销/恢复；歧义图片不会误写。
- M3 已登记动作全部映射既有业务入口，危险动作无绕确认路径。
- HTTP 与 direct 文本路径都有真实证据；不支持图片的路径有明确限制，不静默降级。
- 定向测试、TypeScript、构建和桌面门禁有真实输出；既有失败逐项区分 BASELINE 与本轮回归。
- `docs/evidence/app-assistant/` 含命令、退出码、测试计数、关键输出、UIA 结果和真实模型摘要。
- 更新项目概览、API、Runtime、待完成目标、文档索引和当前交接；未完成项保留在待办，不写“全应用已全部验收”。

最终报告必须逐条列出：

1. 实际修改文件（对照 `git status/diff`）。
2. 每项契约偏差、实现决策及证据。
3. 所有命令退出码与失败原文；未运行项及原因。
4. 真实模型、GUI、微信运行时各自的 PASS/FAIL/BLOCKED/NOT_RUN。
5. 遗留问题、已知限制和下一阶段建议。

**Flash 的第一项工作就是 T1；按 T1 → T2 →（T3/T4/T5）→ T6 → T7 → T8 → T9 执行，不需要再等待方案确认。**
---

## 11. 执行记录（2026-11-20，Flash 团队）

| 任务 | 状态 | 证据 |
| --- | --- | --- |
| T1 契约与夹具 | PASS | `node --test test/app-assistant-contract.test.cjs` → 10/10，exit 0 |
| T2 能力目录/上下文/快照 | PASS | 12/12，exit 0；`app:capabilities:check` digest `c6df6763`，exit 0 |
| T3 桌面提案与原子写回 | PASS | proposal 6 + reducer 13，exit 0 |
| T4 服务端端点与五工具 | PASS | `cd server && npx vitest run test/app-assistant.test.ts` → 34/34，exit 0；`npx tsc --noEmit --incremental false` exit 0 |
| T5 三条 transport | PASS | 26/26，exit 0 |
| T6 侧栏统一入口与变更卡 | PASS | 19 + 23 + 7 例，exit 0 |
| T7 图片分流与素材撤销 | PASS（自动化） | 14 例，exit 0；真实图片识别 NOT_RUN |
| T8 字段与动作开放 | PASS | 8 例，exit 0；仅 `navigate.phase` 自动执行 |
| T9 门禁与文档 | 部分 | `npm test` 1229/1227 pass、build、test:desktop 23/23、check-packaging exit 0；UIA smoke exit 2（`PERM_DENIED` → BLOCKED） |

未执行项与偏差逐条记录在 `docs/evidence/app-assistant/README.md` §2/§3，未在此重复。
