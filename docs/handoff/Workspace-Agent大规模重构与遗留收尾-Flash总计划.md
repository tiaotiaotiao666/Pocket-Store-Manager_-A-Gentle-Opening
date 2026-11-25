# Workspace Agent 大规模重构与遗留收尾：Flash 总计划

> 版本：v1.0。日期：2026-11-24。状态：**待执行，未实现**。
>
> 执行对象：Flash 模型及其任务团队。本文是自包含任务书，不依赖聊天上下文。
>
> 核心授权：本项目是 Agent 项目。Agent 应能阅读、编写和修复真实前端源码，不再被五节点 DSL、页面枚举和预定义样式档位限制。允许修改候选工作区内的 WXML/WXSS/JSON/JS，允许新增前端组件和测试。
>
> 总目标：形成“理解项目 → 修改源码 → 构建测试 → 微信验证与截图 → 读取反馈继续修复 → 用户采用/撤销 → 同源导出”的完整编码 Agent，同时收尾已有未完成任务。
>
> 上游资料：根 `AGENTS.md`、`docs/项目概览.md`、`docs/handoff/当前工作区交接.md`、`docs/待完成目标.md`、`docs/handoff/核心闭环重构计划-业务优先.md`、`docs/handoff/图片驱动前端重构-raw生成方案.md`、既有 app-assistant/frontend-reconstruct 契约与证据。

---

## 0. 给 Flash 的执行协议

### 0.1 不要一次重写整个项目

保留业务后端、Base 业务逻辑、组件库、Composer、Registry、Electron 主进程、现有 Runtime、候选采用/撤销和验证脚本。重构的是 Agent 控制层、工作区产物模型与反馈闭环，采用绞杀者模式逐段替换。

旧文档中的以下产品决策由本计划**明确取代**，不要再当作禁止源码生成的理由：

- “Agent 只能输出 DSL/CompositionPlan，不能生成源码”；
- “前端重构只能覆盖页面三件套，不能改组件和 JS”；
- “新增一种布局/动作必须先扩 DSL 枚举”；
- “每页只能使用既有 WXML 已消费的数据与组件”。

仍然有效的工程边界不是能力天花板：

- 模型不直接写正式 `templates/**`、全局 Registry 或只读 `miniprogram/**`；先写当前项目的私有工作副本，验证后由用户采用。
- 不执行模型提供的任意 shell、脚本或绝对路径；验证命令来自平台注册表。
- 不读其他项目、系统秘密、`.env`、API Key 或无关用户文件。
- 不伪造编译、交互、截图、模型调用、安装包或真机证据。
- 不把模拟支付说成真实微信支付，不在生产开启 demo 登录/支付。
- 不用 `git reset --hard`、`checkout -- .`、`clean -fd`，不覆盖或删除既有未提交用户改动。
- 不为了让测试变绿而删除、跳过或放宽既有业务断言。

### 0.2 任务执行规则

1. **严格按阶段和依赖执行**；未标可并行的任务默认串行。
2. 每个任务开始前读取最新代码和相关测试，先写会失败的行为测试，再实现。
3. 每个任务只修改自己的 `write_set`；确需越界时停止并报告原因，不静默扩大范围。
4. 共享工作区中，同一文件不得并行修改；`App.jsx`、`sessionMachine.mjs`、Composer、契约生成器相关任务尤其要串行。
5. 每个任务必须产出：实现摘要、变更文件、真实命令/退出码、新增证据路径、遗留问题。未执行写 `NOT_RUN`，环境不可用写 `BLOCKED`。
6. 不用 `catalog:write`、`mirror:sync`、重生成契约或修改基线快照来掩盖未解释漂移。
7. 不默认提交 git commit；如用户或执行环境要求提交，每个阶段单独提交，不混入无关文件。
8. 一个阶段未通过门禁时，先修复该阶段，不继续堆叠后续功能。
9. 遇到模型不支持工具调用、输出截断或微信工具缺失，按本计划的降级/阻塞口径处理，不伪造成功。
10. 所有 UI 新控件需有可访问名称；关键容器提供 role/aria-label/稳定 id，并更新 UIA smoke。

### 0.3 单个任务的统一交付模板

```text
任务 ID：
目标是否完成：YES / NO / PARTIAL
实际修改文件：
行为变化：
新增测试：
执行命令与真实退出码：
真实模型/微信/UIA/安装包证据：PASS / FAIL / BLOCKED / NOT_RUN
与计划的偏差：
剩余问题：
下一任务是否可开始：YES / NO
```

### 0.4 状态词

- `PASS`：对应真实检查已执行且通过。
- `FAIL`：已执行且产品结果不满足要求。
- `BLOCKED`：环境/权限/工具阻止执行，附实际错误。
- `NOT_RUN`：未执行。
- `partial`：候选可使用静态证据但未完成真实运行时验收，不等于通过。

---

## 1. 目标架构与完成定义

### 1.1 统一工作循环

```text
用户在统一项目会话中输入目标/图片
→ Agent 读取项目上下文、文件目录、组件契约、参考实现
→ 输出计划与拟修改文件
→ 在项目私有 Workspace 中读取/写入/删除真实源码
→ 平台运行静态检查、Node 测试、Composer、导出一致性
→ 微信开发者工具编译、automator 点击、截图（可用时）
→ Agent 读取有界错误/diff/截图，定向修复并生成新 revision
→ 展示修改文件、业务影响、前后截图与真实证据
→ 用户采用形成不可变项目版本；撤销/重做移动版本指针
→ 正式导出使用该版本的同一工作树和摘要
```

### 1.2 通用工具面

不再为每一种 CSS/布局增加专用工具。服务端 Runtime 负责模型循环；Electron 主进程通过受控任务 RPC 提供本地能力。

| 工具/RPC | 能力 | 边界 |
|---|---|---|
| `get_project_context` | 当前版本、门店草稿、目标、组件/页面事实、验证状态 | 安全摘要，无秘密和绝对路径 |
| `list_files` | 列出允许项目源文件 | 只限当前 Workspace |
| `read_file` | 按路径和区间读取源码 | 有字节/行数限制，可续读 |
| `search_files` | 内容/文件名检索 | 有结果上限，忽略二进制与秘密目录 |
| `write_file` / `delete_file` | 创建、完整覆盖、删除文件 | 相对路径、事务暂存、完整文件内容 |
| `get_component_spec` | 读取组件 props/events/示例/源码 | 来自真实 Base/Catalog |
| `add_image_asset` | 引用用户明确上传的图片 | 主进程校验，模型不传 base64/路径 |
| `get_diff` | 当前 revision 相对父版本的源码差异 | 有大小限制和文件摘要 |
| `run_check` | 执行已注册 lint/test/build/composer 检查 | 只能传 checkId 和有界参数，不传命令 |
| `verify_wechat` | 调固定微信脚本，返回页面/交互/截图 | 复用 `scripts/wechat-devtools-run.cjs` |
| `read_verification` | 读取有界 issues、报告和截图引用 | 不返回密钥、绝对路径或大日志 |
| `submit_candidate` | 固化 revision、diff、证据，等待用户采用 | 模型不能直接 adopted/export/publish |

### 1.3 源码开放层次

| 层次 | 本计划是否开放 | 验证要求 |
|---|---|---|
| 页面 WXML/WXSS/JSON | 首批开放 | AST/绑定/组件/JSON/微信编译 |
| 现有组件 WXML/WXSS | 首批开放 | props/events 契约 + 影响页面回归 |
| 组件纯 UI JS | 第一批后续开放 | AST/API 边界 + 组件 Node 测试 |
| 页面 JS、路由与新组件 | 第二批开放 | 页面交互 + 导航 + 全链路测试 |
| 服务/domain/state | 仅明确业务任务开放 | API/业务/权限/回归测试，不随视觉任务擅改 |
| 后端、数据库 | 独立业务阶段 | 先契约/迁移/权限，再实现，不与 UI 任务混合 |

页面业务 JS 的保留只是早期切片策略，不是永久架构限制。Agent 最终可以修改真实前端业务源码，但必须提出并运行对应验证。

### 1.4 总体验收

只有同时满足以下条件，核心重构才算完成：

- [ ] 用户通过同一会话要求修改当前项目，Agent 能直接生成真实源码，而不是 DSL。
- [ ] `menu + product-card` 垂直切片能修改页面和组件内部，加购、详情、购物车、结算不回归。
- [ ] Agent 能读取本地构建/微信错误和截图，至少完成一次真实定向修复闭环。
- [ ] 全 8 页分别具备源码事实、page-contract、生成与验证能力；一张图只锚定一个页面。
- [ ] 支持新增组件和必要页面 JS，修改范围由源码 diff 和测试证明。
- [ ] 项目版本、候选、采用、撤销、重做、重开和正式导出共用同一版本事实。
- [ ] v1 旧项目仍可读取；旧 DSL 退出新入口但不破坏历史证据。
- [ ] 静态检查、真实模型、UIA、微信、安装包、真机证据分别如实记录。

---

## 2. 工作区与版本模型

### 2.1 固定目录

```text
<userData>/projects/<projectId>/agent-workspace/
  project.json
  versions/<versionId>/
    version.json
    source/                 # 完整可构建项目源树或明确快照
    diff/
    evidence/
  runs/<runId>/
    run.json
    turns/<turnId>/
      attempts/attempt-<n>/
        candidate/
        verification/
```

实现时尽量复用现有 `frontend-runs`、workspace canonical/audit、Registry overlay 与 adoption 代码，避免另造一套安全路径库。新旧目录可通过迁移层映射，不能双写两份当前版本真相。

### 2.2 不可变版本

- `versionId/parentVersionId/baseDigest/treeDigest/createdAt` 固定。
- Agent 每次提交产生新 attempt/revision；采用产生新 `versionId`，不原地修改旧版本。
- `undo/redo` 只移动 `currentVersionId`。
- `storeDraft/presentationPatch/frontendCandidate/agentChat` 等旧切片逐步接入统一版本模型；未迁移前不得造成双事实。
- 正式导出前重算工作树摘要、验证 version 身份、overlay/Registry digest 和当前指针。
- 缺失或漂移时明确失败，不回退 Base 冒充当前版本。

### 2.3 源码变更协议

首版使用完整文件写操作，不接收模型 unified diff：

```json
{
  "path": "pages/menu/index.wxml",
  "content": "<view>...</view>",
  "expectedBaseSha256": "sha256:..."
}
```

- `write_file` 为原子操作，一批文件可形成事务；任一失败不提交该批。
- `expectedBaseSha256` 防止旧上下文覆盖新修改。
- 删除使用显式 `delete_file`，不允许用空字符串隐式删除。
- 所有变更在提交前生成 `added/modified/deleted/unchanged` 与逐文件摘要。
- 允许 Agent 写大文件时分段读取旧文件，但写入仍必须是可解析的完整文件；不接受残片拼接。

---

## 3. 阶段与任务依赖总表

| 阶段 | 内容 | 依赖 | 可否并行 | 完成门槛 |
|---|---|---|---|---|
| A | 基线盘点、遗留小修复、执行环境 | 无 | 子任务可并行 | 基线可解释，环境与失败项有证据 |
| B | Workspace 内核、通用 RPC、版本模型 | A0 | B1/B2 先后，测试并行 | 无模型也能读改验、采用撤销导出 |
| C | SourceFacts、source-check、Composer 完整源码覆盖 | B 内核 | facts/lint 可并行，Composer 串行 | 人工 bundle 改 menu/product-card 全绿 |
| D | 服务端/直连统一 Agent loop 与工具调用 | A、B RPC | provider 与 UI 可局部并行 | 真实工具调用可用，失败如实 |
| E | 图片生成单页闭环与截图修复 | C、D | 服务端与面板可并行，接线串行 | menu 真实生成、验证、修复、采用 |
| F | 全 8 页、新组件与页面 JS | E | 每页可独立，但共享文件串行 | 每页独立证据与业务回归 |
| G | 统一会话、版本 UI、旧链迁移 | E/B | UI 分件可并行 | 单入口、版本历史、v1 兼容 |
| H | 门店运营与业务生产化前置 | B/F 稳定 | 各业务模块可并行 | 契约、后端、前端和权限闭环 |
| I | 全量验收、安装包、清理与文档 | A–G；生产项另看条件 | 验证可并行 | 所有结果有证据，无冒充通过 |
| J | 云、生图、真实支付、正式发布 | 用户条件/独立批准 | 独立项目 | 外部真实证据，不阻塞核心 Agent |

总估算（一名熟悉仓库的实现者）：**A–G 约 35–50 人日，H/I 约 15–25 人日**。Flash 实际耗时取决于并行能力，但依赖关系不能因并行而跳过。J 不做固定工期承诺。

---

## 4. 阶段 A：基线、历史欠账与执行环境

### A0：建立当前事实基线

**write_set：** `docs/evidence/workspace-agent/baseline/**`、必要的测试日志路径，不改产品代码。

执行：

```powershell
node --version
git rev-parse HEAD
git status --short
npm test
npm run build
npm run test:desktop
npm run registry:check
npm run catalog:check
npm run mini:check
npm run mirror:check
npm run composer:verify
npm run check:packaging
npm run frontend:capabilities:check
npm run app:capabilities:check
```

在 `server/` 执行全量测试和 `tsc --noEmit`。记录实际数字与失败，不沿用旧计数。核对 MySQL/Redis/后端/Vite/模型代理/微信 CLI/Electron 是否可用。

**验收：** 形成失败分类 `PRE_EXISTING / NEW / BLOCKED / NOT_RUN`；后续任务知道哪些不是本轮引入。

### A1：启动脚本健康探测

**write_set：** `scripts/start-all.ps1`、`scripts/start-server-local.ps1`、相关脚本测试、启动文档。

- 端口可连接不再等同于健康；后端要求 `/api/v1/readyz` 200 且 database ok。
- Vite/模型代理也检查预期内容/健康状态；端口被旧进程占用时明确告警。
- 修复必须保留 Electron `ELECTRON_RUN_AS_NODE` 环境坑处理。

**验收：** 构造健康、不健康、端口占用、服务未启动四类用例；真实启动一次。

### A2：修复独立遗留缺陷

可拆成 A2a–A2f，每个独立测试：

- A2a `composer:verify PATH_ESCAPE`：报告绝对路径不应污染产物安全检查；不能通过全局豁免吞掉真实逃逸。
- A2b `presentationPatch` 未持久化；重开恢复，撤销语义明确。
- A2c `assets.images` 删除/解除引用与撤销/redo；物理内容文件可保留，但不能出现 phantom asset。
- A2d `AgentExceptionFilter` 按既有错误契约透出受控 422 details；不含原始模型正文/秘密。
- A2e `RealPreviewPanel` 补 `PREVIEW_BRIDGE_UNAVAILABLE/SCREENSHOT_INVALID` 等真实错误文案。
- A2f catalog/MIRROR 基线：逐文件解释漂移，区分用户资产与生成物；只在源码事实确认后更新，不直接 `mirror:sync` 覆盖用户 SVG/poster 资产。

### A3：恢复验证环境

- 用 `npm start` 或 `agent:app` 启动真实服务；处理沙箱 spawn EPERM 时在可授权环境运行，不伪装结果。
- 确认微信 CLI、固定 AppID/游客模式、自动化端口和项目身份检查。
- 执行 `agent:smoke` 与 `app:assistant:smoke`，保存 UIA 证据。
- 固定编译副本处理 `touristappid`，不修改正式导出事实来迎合本机工具。

### A4：旧 P7/T16 证据收口

**write_set：** `docs/evidence/frontend-reconstruct/**`、`docs/evidence/workspace-agent/p7-t16/**`、对应计划/交接的状态回填；不得把旧证据改写成通过。

- 按旧 P7 完成矩阵重新执行仍可执行的 frontend-reconstruct 定向门禁与全量门禁。
- 真实模型探针必须归档输入图片或其可复核受控副本、sha256、请求/响应摘要、runId/attempt、候选 tree digest、dry-run 和 runtime 原件；清理策略不得再把唯一原件删掉导致 `UNVERIFIABLE`。
- unsupported/blurry/clear 图片分别记录结果；缺业务能力不写候选，模糊图给具体追问。
- T16 补做模板三套切换、Ctrl+Z/redo、Electron/微信真实走查等旧覆盖缺口；已完成历史步骤不重复伪造。
- 旧 v1 结果用于兼容基线，不要求先把 v1 扩成 raw；Workspace v2 的真实证据在 E/I 阶段另行建立。
- 如果微信/UIA 环境仍不可用，保留 `BLOCKED/NOT_RUN`，在 A3/I 阶段复验，不写 PASS。

**门禁：** A0 必做；A1/A2/A4 不阻塞 B 的新目录原型，但所有未修项进入最终 I 阶段清单。

---

## 5. 阶段 B：Workspace Agent 内核

### B1：工作区与事务 API

**主要新增：** `desktop/agent-workspace/{README.md,workspace.cjs,files.cjs,transactions.cjs,manifest.cjs}` 与对应测试。

实现：

- 从当前 Base/已采用版本创建完整私有工作树；
- `list/read/search/write/delete` 纯主进程 API；
- 路径规范化、symlink/junction 拒绝、文件数/字节/深度限制；
- expected base digest、事务暂存、原子提交、失败清理；
- 文件 diff、树摘要、运行和 attempt 元数据；
- 保留已有 `desktop/frontend-reconstruct/workspace.cjs` 可复用实现，优先抽共享而不是复制。

**测试：** 路径穿越、绝对路径、链接、冲突写入、删除、超长文件、部分失败、重开、相同输入确定性、正式仓库零写入。

### B2：统一版本与采用/撤销

**主要新增/修改：** `desktop/agent-workspace/versions.cjs`、`desktop/project-ipc.cjs`、`src/domain/projectSnapshot.mjs` 与测试。

- 建立不可变 version 和 current 指针；
- 兼容读取旧 `projectSnapshot.frontendCandidate`，首次写新模型前生成迁移记录；
- 采用、撤销、重做、重开、删除项目、导出身份检查；
- 保存 presentation patch、素材引用、候选和验证索引；
- 不持久化在途请求、base64、完整 prompt、秘密和绝对路径。

**验收：** Base → v1 → v2 → undo → redo → 重开 → 导出，树摘要一致。

### B3：受控任务 RPC 与 preload

**主要新增：** `desktop/agent-tools-ipc.cjs`、preload 命名空间、`src/services/workspaceAgent/`、IPC 测试。

- renderer 只通过语义 facade 调主进程；不暴露通用 fs/child_process。
- RPC 参数使用 projectId/runId/turnId/attempt + 相对虚拟路径，renderer 不提供目录。
- 支持取消、超时、项目串行写、读操作有界并发、迟到响应丢弃。
- 检查 sender、项目归属、版本/revision、payload 和结果大小。
- 工具结果使用统一 `{ok,code,data,issues,meta}`；错误不泄漏路径/源码全文。

### B4：验证注册表

**主要新增：** `desktop/agent-workspace/checks.cjs`、`scripts/agent-checks/*.cjs` 或复用既有脚本、测试。

注册 checkId：

- `source.check`、`mini.check`、`composer.dry-run`、`output.consistency`；
- `unit.targeted`、`unit.full`、`desktop.contract`、`catalog.check`、`registry.check`；
- `wechat.verify` 固定包装真实 DevTools；
- 后续 `installer.check`、`ui.smoke`。

Agent 只能选择 checkId，不能提供 command/shell/env/任意参数。检查结果转为有界 issues，包含 `file/line/column/code/message/source`，没有绝对路径。

**B 阶段门禁：** 用人工脚本/测试直接调工具，不依赖模型即可完成“读取 → 修改 → 检查 → diff → 版本采用 → 撤销 → 导出”。

---

## 6. 阶段 C：源码事实、静态检查与 Composer 开放

### C1：全项目 SourceFacts

**主要新增：** `scripts/agent-source-facts.cjs`、`server/src/agent/workspace/source-facts.*`、生成快照与测试。

每页事实至少包含：

- Base 三件套和必要 JS 的可读取路径；
- data 初始形状、setData 路径、页面 handler 和事件读取方式；
- 组件四件套、props/events/示例/限制；
- usingComponents、插槽、Plan 当前分配、关键动作；
- 本地资产 ID 和主题 token；
- page-contract 与可用 checkId。

v1 DSL 快照保持不动；v2 SourceFacts 包含 loading/error/submitting 等 UI 状态。事实生成必须失败关闭，但不得把“旧 WXML 没用过”误判为“数据不可用”。

### C2：共享 source-check

**主要新增：** `scripts/frontend-source/{parse,check,bindings,events,components,wxss,js-policy}.cjs`、共享 fixtures。

- WXML/WXSS/JS 使用真实 parser/AST，不能只靠正则；选型需轻量、可打包、可 mock，不为解析引入大型 Agent 框架。
- 校验表达式支持子集、全部 `{{}}`、嵌套 for 局部作用域、数据根/已知字段、事件、组件声明与 props/events。
- JSON 允许前端必要配置，但路由/app/tabBar/网络域名的修改必须有对应业务契约。
- WXSS 允许自由合法布局，禁静态外链；动态 `{{product.imageUrl}}` 不误杀。
- JS 分策略：UI 组件、页面、service/domain/state 各自检查；不永久禁止页面 JS。
- 业务不变量由 page-contract 和测试承担，不靠“看到 wx.request 就拒绝所有页面”。

### C3：Composer SourceBundle/Workspace 覆盖

**修改：** `scripts/composer/{schema,resolve,emit,digest}.cjs`、Registry schema、导出 report 与测试。

决策：以 **Workspace 完整源树引用**为长期主模型；`frontend-source-bundle.v1` 只作为可选交换/兼容格式，不要求两套产物同时建设。

- Composer 接受经校验的私有 workspace/source overlay，不再只支持 WXML 替换/WXSS 追加。
- 页面/组件最终文件直接覆盖，删除 `styleMode` 设计。
- 组件修改默认 page-scoped 变体；shared 修改列出所有受影响页面。
- 支持新增组件、组件 JSON/JS、页面 JS 和本地资产；根据最终 WXML 重算 usingComponents。
- 已分配插槽缺失必须阻断，除非用户显式移除功能。
- 生成 `source-changes.json`、逐文件摘要、Base/Plan/Lock 关系。
- dry-run、采用、重开和正式导出同一实现。
- 修复 pack `entry.assets` 复制问题；若旧 pack 不再使用也至少保持原行为/明确兼容。

### C4：人工垂直切片，不接模型

构造一个人工 Workspace：修改 `menu` 页面与 `product-card` WXML/WXSS，形成明显但合理的视觉变化。

验收：

- 页面和组件内部都改变；
- 分类、详情、加减购、购物车、桌号、checkout 正常；
- 静态检查、Composer、mini:check、一致性通过；
- 采用/撤销/重开/导出同源；
- 微信工具可用则真实编译和截图，不可用标 BLOCKED。

**C4 通过后才允许接模型。**

---

## 7. 阶段 D：统一 Agent Runtime 与真实模型

### D0：模型能力探测

实测目标 Flash/当前配置模型：

- 是否支持 tools/tool_calls、多模态 content parts；
- tools 与 response_format 是否互斥；
- 最大输出、截断标记、超时和错误；
- 本地代理是否原样透传，不只根据 `/models` 判断。

只保存脱敏请求/响应形状、模型名和状态，不保存 key/完整敏感内容。不支持 tools 时可使用结构化输出生成完整文件，但仍需实现外部工具编排；不能因此恢复五节点 DSL。

### D1：统一 Workspace Agent 服务

新增 `POST /api/v1/agent/workspace` 与 `workspace-agent.v1` 契约，复用 `server/src/agent/runtime`，不另写第二套 loop。

- 操作：`plan | edit | repair | explain`；
- 输入：project/version/run/turn 身份、utterance、图片、工具结果引用；
- 工具通过受控 RPC 代理到桌面；服务端不直接访问本机磁盘；
- 工具超时、取消、总预算、重复调用、并发写入、结果截断；
- 模型不能声明 adopted/exported/verified，由本地事实决定；
- 响应包含安全 reply、计划、工具 trace 元数据、stopReason，不返回“已应用”假状态。

### D2：HTTP 与 direct 对等

- HTTP 走 Nest 服务；
- direct 复用主进程 `modelChat`，本地执行同一工具协议；
- direct 不支持图片时明确提示，不静默丢图；
- mock 必须能模拟读改验，用于离线测试，且显式 `mock=true`。

### D3：Agent 上下文与提示词

- 提供项目任务、组件契约、当前版本、可用工具、验证规则和文件编辑策略。
- 优先读必要文件，不一次塞入全仓库；长文件分区间读取。
- 要求保留未要求修改的业务逻辑，优先复用组件现实实现。
- 不把“防御性少”理解为删除校验；减少重复 DTO/空兜底，保留外部输入和产物事实校验。
- 支持 Markdown 回复，使用安全渲染方案；禁 raw HTML、危险链接，Electron 外链走主进程。

### D4：Runtime 欠账收口

- 错误码粒度、工具参数错误、预算耗尽、循环检测、取消和 partial；
- 真实 turn/template-revise/app-assistant/workspace 的 HTTP/direct 证据；
- 不在本轮重写已稳定业务 Provider 的所有实现；能通过适配器复用就复用。

**D 阶段验收：** 真实 Flash 至少完成一次多工具读取与写入、一次构建错误回灌修复；失败和截断均有负例。

---

## 8. 阶段 E：图片驱动源码生成完整闭环

### E1：单图单页视觉分析

- `targetPage` 为单数；全 8 页可选，但每次运行一页。
- 输出区域、布局、颜色、字号、间距、图像位、交互可见项、未知区域和置信度。
- L1 业务能力缺失：rejected 或经用户确认的明确降级；不能伪造直播、优惠券、支付等业务。
- L2 视觉组件不齐全：不阻断，可写原生 WXML 或新组件。
- 一张 home 图不能成为其余七页的视觉验收依据。

### E2：源码生成与修复

- Agent 基于当前版本源码编辑，返回完整文件，不从空白重写。
- 首轮针对页面和必要组件；输出截断不解析。
- 本地 lint/Composer/微信 issues 回灌，最多 2 次定向修复；每次新 attempt。
- 修复只带失败文件和必要依赖，避免重新生成整个项目。
- 超预算/失败不覆盖上一可用版本。

### E3：真实截图与对比

- before/after 同 route、同尺寸、同门店/身份；
- 读取既有私有截图，renderer 使用受控字节/短生命周期 Blob URL；
- 展示改前/改后、修改文件、组件影响范围、验证状态；
- 缺图显示 NOT_RUN/BLOCKED/MISSING，不用 React 截图代替；
- 真实截图可回传 Agent 做一轮定向视觉修复，计入修复预算。

### E4：menu + product-card 真实验收

- 使用清晰参考图真实调用 Flash；
- 生成、静态检查、Composer、交互、截图、至少一次修复；
- 采用、partial 显式确认（如运行时未完成）、撤销、重开、导出；
- 保存可复核的输入摘要、图片 sha256、模型/工具 trace 摘要、候选 tree digest、报告与截图，避免旧 P7 原件被清理后 UNVERIFIABLE。

---

## 9. 阶段 F：全 8 页与更强编码能力

### F1：页面契约与开放顺序

每页先补 SourceFacts/page-contract/fixture，再开生成：

1. `menu`：E 阶段完成；
2. `checkout`：商品明细、桌号、备注、提交、重复提交保护、错误重试；
3. `home`：门店/履约、goMenu、已配置插槽；
4. `orders/order-detail`：列表、筛选/分页、状态、演示支付、订单动作；
5. `product-detail/mine`：加购/购物车、身份/门店/多店入口；
6. `merchant-orders`：刷新、筛选、接单、状态推进、商品管理，单独做 token 与长页面预算。

每页必须有自己的参考图、真实生成记录、正常/空/错误/长内容检查和关键交互，不能只把 targetPages 枚举改为 8 页。

### F2：组件与页面 JS 升级

- 允许新增前端组件与必要页面 JS；
- 保持组件 API 通信原则；确需变更 props/events 时必须更新所有调用方和 Catalog；
- 路由改变需同步 app.json、tabBar、导航和返回链路；
- 服务/domain/state 的修改必须单独说明业务原因、测试和 API 影响；
- 不使用动态 eval/Function、运行时加载模型代码或不受控远程脚本。

### F3：Base 与 Catalog 缺口

- `Plan.components` 对 Base 同名组件的语义由 Workspace 覆盖方案取代或明确修正；
- Base 无可选组件时独立运行，删除可选组件后真实微信编译；
- 评估并实现 10 个 `promote-to-ui-block` 中确有复用价值的区块，不为数量全部提升；
- 每次 Base/组件变更按真实来源更新 Registry/Catalog/Mirror，保留用户 SVG/poster 资产；
- `home-marketing/ad-slot/coupon` 等未完成业务先标 preview-only/独立业务任务，不用空 UI 冒充 online-ready。

---

## 10. 阶段 G：统一会话、项目流程与旧链退出

### G1：统一入口

- 任意项目阶段都可发文字/图片；不再由 phase 决定 Agent 是否能工作。
- 路由意图：资料字段、菜单识别、视觉修改、源码开发、已有业务动作。
- 资料字段继续使用 app-assistant 原子批次；源码任务进入 Workspace Agent。
- 菜单识别结果转为统一变更卡，可撤销；不再由旧 `AGENT_TURN_SUCCESS` 绕过变更卡直接写。
- reference 图片直接从侧栏发起 Workspace 候选，而不是只定位旧面板。
- direct/HTTP/mock 状态明确，失败保留输入，可重试和取消。

### G2：项目主流程

```text
创建/打开项目
→ 最小门店资料（可跳过非必要项）
→ 图文说明目标
→ Agent 修改当前版本
→ 真实预览/截图/diff/证据
→ 采用或继续修改
→ 撤销/重做/版本回看
→ 导出
```

- 功能勾选、模板匹配、生图、Prompt Studio 退出强制主流程，可作为可选工具。
- 删除假构建/假部署进度；没有真实任务就显示本地状态，不播放成功动画。
- 常驻微信预览入口，区分未安装、未构建、启动中、已打开、失败、BLOCKED。

### G3：版本 UI 与桌面拆分

- 候选卡升级成版本卡：版本、父版本、源码 diff、业务影响、截图、验证、采用。
- Ctrl+Z、按钮 undo/redo 与版本指针统一。
- 在行为测试保护下逐步拆 `App.jsx` 和 `sessionMachine.mjs`，每次只拆一个职责，不与功能修改混做。
- 所有关键 UIA 控件补 smoke；新增页面/状态断言。

### G4：旧链迁移与清理

- v1 DSL/frontend-pack 保留旧项目只读兼容，新项目默认 Workspace Agent。
- `screen-reference.v1` 退出新入口，旧快照可打开。
- grep 证明无生产引用后再删除旧 generator IPC、不可达 preview fallback、重复 DTO 和旧状态分支。
- 更新 `AGENTS.md`、项目概览、待完成目标、契约和交接，移除已经过时的“永不生成源码”描述。
- 不删除历史证据；把旧计划标为 superseded，并链接本计划。

---

## 11. 阶段 H：既有业务与生产化欠账

这些是用户要求的“之前没做的任务”中的业务部分，与 Agent 核心分开提交。每项先更新 `docs/api.md`/权限/数据契约，再实现。

### H1：门店日常运营优先包

1. 商品/分类 CRUD、排序、改价、上下架、软删除、乐观锁、catalogVersion 和缓存失效；
2. OWNER/STAFF 权限矩阵、受控成员开通/解绑、防止删除最后 OWNER、跨店隔离；
3. 真实桌台维护、停用、桌码生成/失效/防伪造，下单服务端校验；
4. 门店资料、营业时间、临时打烊、堂食/自取设置及下单执行；
5. 商品图片上传/替换/删除、归属校验、失败回退；需要对象存储条件时先实现接口与本地/测试适配，不伪称 OBS 已接通；
6. 历史订单与操作审计。

### H2：订单队列与交互

- 第 51/100/500 单可达，游标/分页不漏单不重单；
- 默认新订单/制作中/待取餐/历史队列，待付款不占默认工作队列；
- 轮询不重叠、旧响应隔离、离开停止、断网恢复；
- 每卡独立处理状态、冲突刷新、取消原因和防误触；
- 商品详情加购反馈采用“连续加购但数量、反馈、结算入口明显”的现有产品方向，除非用户另行改选；
- 店主端固定中性工具 UI，与顾客品牌主题解耦；
- 多门店选择与切换，所有数据/权限刷新，防旧响应串店。

### H3：Agent 与生产边界

- Agent 接真实 Session/OWNER 权限、无效/过期 Token、跨店、限流和额度保护；
- `Idempotency-Key + turnId` 去重，项目/Agent 会话持久化在云端阶段另做；
- production 导出禁 localhost/demo store/demo 身份，真实 storeId 与 HTTPS/版本守卫；
- 没有真实凭据和外部条件时仅完成可测代码并标 BLOCKED，不宣称生产可用。

### H4：明确需要独立批准

真实微信支付/退款/对账、客户端员工授权、公开店主注册、外送、复杂库存/规格、真实营收报表，不在未获外部条件与产品确认时自动实施。可以先写设计，不直接改编码任务。

---

## 12. 阶段 I：全量验证、交付与旧欠账清零

### I1：自动化矩阵

按当前实际脚本执行，记录真实数量：

```powershell
npm test
npm run build
npm run test:desktop
npm run registry:check
npm run catalog:check
npm run mini:check
npm run mirror:check
npm run mini:dup-check
npm run mini:smoke
npm run mini:pages
npm run composer:verify
npm run check:packaging
npm run frontend:capabilities:check
npm run app:capabilities:check
```

服务端全量 Vitest/tsc/build；MySQL 不可用标 BLOCKED，不把 skipped 当 pass。

### I2：桌面 UIA 与真实模型

- 工作台 → 设置 → 返回；
- 统一会话字段修改 → 变更卡 → undo/redo → 保存重开；
- 菜单图识别 → 统一变更卡 → 撤销；
- 参考图 → 源码候选 → diff/截图 → 采用/撤销 → 导出；
- HTTP/direct 文本、真实图片、工具调用、取消、迟到响应、错误码；
- 所有新关键控件有 UIA 断言，失败不用截图目测代替。

### I3：微信与业务端到端

- 四个 tab、详情/加购/结算/提交/订单详情/演示支付；
- 店主接单、制作、可取餐、完成、取消和权限；
- 正常、空、错误、长文本、长列表、安全区；
- 同一导出版本的 before/after、tree digest 与报告一致；
- 记录 Console、网络、requestId、截图、交互结果。

### I4：安装包与旧人工清单

- `npm run build:win`，安装到干净目录；
- 安装版 Workspace/Composer/微信 CLI/模型直连可用；
- 构建资源包含新 Workspace、解析器、固定验证脚本和生产依赖；
- 补做旧 M1–M9/M13、BUG-018、BUG-014、A-UI-1/2/3、M8/M9、门店图片 UI 复验；磁盘写满等不可做项标 BLOCKED；
- L2 删除可选组件、L3/L4 安装版真实导出；
- 真机 HTTPS、安全区、扫码、滚动性能和海报视觉另列真实设备证据。

### I5：文档与答辩材料

- README、部署、API、组件契约、Agent 架构、项目概览、待完成目标和交接与代码同版本；
- 每项 `[x]` 必须链接代码与证据；
- 清理演示数据库按运维流程执行，不能由 Agent 擅自删除；
- 答辩展示真实“一句话/图片 → 源码 diff → 微信运行 → 修复 → 采用导出”，而不是预录动画或 mock 冒充真实模型。

---

## 13. 阶段 J：独立排期的外部能力

### J1：生图与素材

需要真实 provider 的 base URL/model/key 或明确服务。完成适配、任务状态、迭代、资产归属和审核后，才能移除 `not-configured/local-demo` 标识。生图不是 Workspace Agent 核心闭环的前置。

### J2：云端协作

项目/会话/候选/Lock/任务/部署持久化、owner 隔离、冲突合并、限流、审核、OBS、注册表同步。云端 Composer 必须复用本地验证语义；不把模型源码直接写成可信正式资产。

### J3：真实支付与生产发布

需要商户、AppID/AppSecret、HTTPS、隐私、审核和运维条件。支付回调验签、幂等、退款、对账先独立冻结契约；真实证据缺失始终 BLOCKED。

---

## 14. Flash Agent Team：分阶段分工与启动方式

### 14.1 用户能看到什么、什么时候看到

**E 阶段完成就是第一个可实际使用的核心功能：**

1. 用户选择一个目标页，上传该页参考图并描述设想；
2. Agent 读取 Base、组件库真实实现和当前项目版本；
3. 修改页面与必要组件的真实 WXML/WXSS/JS 源码；
4. 自动执行检查、Composer 和可用的微信验证；
5. 用户看到修改文件、源码 diff、真实微信截图和降级/失败原因；
6. 用户可采用、撤销、继续要求修改，并从同一版本导出。

E 只承诺 `menu + product-card` 垂直切片，不代表全 8 页完成。**A–G 完成**后才具备全 8 页、统一会话、新增组件/页面 JS 和完整版本历史。H/I/J 的门店运营、生产化、安装包、云端与真实支付不是核心图片改造体验的前置，但各自只能按真实证据宣称完成。

如果微信 CLI 本机仍不可用，E 可以交付静态候选与 `partial/BLOCKED`，但“看到真实微信截图/交互通过”必须等待工具环境，不能用 React 预览替代。

### 14.2 推荐团队：1 名 Captain + 4 名成员

不要一次启动八个互相改代码的 Flash。先建立五角色团队，成员可以空闲，按门禁唤醒；H 业务扩展另开团队或后续加成员。

| 名称 | 角色 | 主要职责 | 默认权限 |
|---|---|---|---|
| `captain` | 集成负责人/架构守门 | 拆任务、冻结接口、控制依赖、集成、最终汇报；不代替验证者自验 | 可协调，原则上不写主线代码 |
| `workspace-lead` | 主线工程师 | B1–B4、C3–C4、E2 本地编排；维护 Workspace/版本/Composer 一致性 | 唯一可写 Workspace 与 Composer 主干 |
| `runtime-engineer` | 模型与源码分析工程师 | D0–D4、C1/C2、服务端/直连 Runtime、有界 issues | 不写 `emit.cjs`、不改版本模型 |
| `product-ui` | 产品前端工程师 | E1/E3 面板、G1–G3 统一会话/版本 UI、facade 与 UIA 可访问性 | 只通过 facade；不直写主进程文件系统 |
| `verifier` | 独立验证工程师 | A0/A4、C4/E4/F/I 独立复核、真实微信/UIA/证据归档 | 默认只读；修复另派，不能自验自批 |

### 14.3 分阶段激活矩阵

| 时段 | Captain | workspace-lead | runtime-engineer | product-ui | verifier |
|---|---|---|---|---|---|
| 启动 | 确认基线与任务边界 | 阅读并设计 B1 | **D0 模型能力探测** | 阅读现有 facade/UI，不改代码 | **A0/A4 基线与旧 P7/T16** |
| B 内核 | 冻结目录、版本、RPC 契约 | **B1→B2→B3→B4 串行** | 设计工具 schema/离线 mock，不写主干 | 设计 facade 消费类型与面板原型 | 审查 B 测试，做只读攻击用例 |
| C 静态与 Composer | 解决接口冲突 | **C3→C4 人工切片** | **C1/C2 facts 与 AST 检查** | 可做独立展示组件，不接 App | 验证人工切片与 v1 回归 |
| D 模型接入 | 审查 D0 结果与预算 | 提供真实 RPC 服务 | **D1–D4 HTTP/direct/工具循环** | 接运行状态/错误/Markdown | 真实工具调用与负例复核 |
| E 核心可见交付 | 控制只做一个页面 | 本地生成/修复/attempt 编排 | 图片分析与 Agent 工具循环 | 图片输入、diff、截图、采用/撤销 | **E4 独立真实验收** |
| F/G 扩面 | 控制共享文件合并 | Composer/Base 共享修改串行 | 每页 SourceFacts/生成支持 | 统一会话、版本历史、旧入口退出 | 每页 page-contract 与微信/UIA |
| H/I | 分派业务与收尾 | 仅提供 Workspace 支持 | Agent 鉴权/限流支持 | 门店运营 UI（如启动） | 全量、安装包、真机与旧人工清单 |

### 14.4 严格依赖和写入锁

- `A0` 先报告事实；A 的遗留失败不自动阻塞 B 原型，但必须保留到最终收口。
- `B1→B2→B3→B4` 是主干，只有 `workspace-lead` 写；Runtime 可同时做 D0。
- `B3` 的 RPC 契约冻结后，Runtime 和 product-ui 才能接实现。
- `C3/C4` 与 `C1/C2` 可并行，但 C4 必须消费已经过审查的 SourceFacts/source-check。
- **C4 人工源码切片未通过，不得开始 E 的真实图片生成。** 先用人工输入证明 Composer/版本/导出，不让模型问题与构建问题混在一起。
- E 期间 `App.jsx`、`sessionMachine.mjs`、preload、IPC 的接线由一个任务串行完成。
- F 可按页分派研究/验证，但共享 Base、组件、Catalog、Registry、Composer 的写操作全部经 workspace-lead 串行集成。
- H 是另一业务工作包，不与 Agent 核心在同一未集成分支大爆炸。

### 14.5 每个成员的执行提示词

#### workspace-lead

```text
你是 Workspace 主线工程师。阅读总计划和 AGENTS，先承担 B1；未经 Captain 分派不要跳到模型生成。
你的目标是让真实源码在私有工作区中可读、可改、可验证、可版本化、可撤销和同源导出。
你独占 Workspace/版本/Composer 主干写入。每个子任务先写失败测试，失败不提交半批。
保持 v1 旧项目兼容，不写正式 templates、不改 miniprogram 镜像，不执行模型给的命令。
B3 契约稳定后向 Captain 报告，让 Runtime/UI 可以接。C4 人工 menu+product-card 切片是你进入 E 前的门禁。
```

#### runtime-engineer

```text
你负责模型与源码分析能力。启动时先做 D0，不改 Workspace/Composer 主干。
实测 Flash tools、多模态、截断和错误；随后实现 C1/C2、D1–D4，复用既有 Runtime。
工具通过冻结 RPC 调桌面，不直接读本机文件。模型输出是候选，不是 applied/verified。
所有错误形成有界 issues，不泄漏秘密、绝对路径、完整 prompt 或大日志。
真实模型证据与静态测试分开汇报；不支持工具调用时实现外部编排，不退回五节点 DSL。
```

#### product-ui

```text
你负责统一会话和候选/版本体验。只消费 facade，不直接操作 IPC、文件、shell 或微信 CLI。
启动阶段先读代码和定义接口，不抢改 App.jsx。B3 冻结后才接真实 facade。
E 阶段交付目标页选择、图片+设想输入、真实进度、修改文件/diff、微信 before/after、采用/撤销。
partial/BLOCKED/NOT_RUN 必须清楚显示；缺图不能用 React 截图补位。
所有关键控件有 UIA 名称和断言，主接线串行执行。
```

#### verifier

```text
你是独立验证者，不写自己的实现来代替被验功能，不接受实现者的口头结论。
启动先做 A0/A4，保存真实命令、退出码和可复核原件，旧 P7/T16 不得被改写为通过。
每个阶段检查测试是否削弱、v1 是否兼容、业务链路是否回归、证据是否属于当前 tree digest。
微信/UIA/真机/安装包未运行就如实标 BLOCKED/NOT_RUN。发现问题提交结构化 finding，由 Captain 派修复。
```

#### Captain

```text
你是集成负责人，不是第五个并行编码者。按总计划建立依赖任务，保护共享文件写锁。
先启动 workspace-lead=B1、runtime-engineer=D0、verifier=A0/A4，product-ui 只做接口调研。
每个阶段必须收到实现报告和独立验证报告才能开放下一阶段。C4 未通过不得接真实图片生成。
任何任务越界、删除用户改动、伪造证据或要求绕过路径/命令边界时立即停止该任务。
最终以功能、自动化、真实运行、遗留/阻塞四张表汇报，不把计划存在当交付。
```

### 14.6 可直接发送给 Flash Team 的启动指令

```text
读取 docs/handoff/Workspace-Agent大规模重构与遗留收尾-Flash总计划.md、AGENTS.md、docs/项目概览.md 和当前工作区交接。
按第 14 节建立 Captain + workspace-lead + runtime-engineer + product-ui + verifier。
本轮只启动：
1. verifier：A0 当前基线，并在环境允许时继续 A4；
2. workspace-lead：B1 设计、失败测试与实现；
3. runtime-engineer：D0 Flash 能力探测；
4. product-ui：只读梳理 facade/现有候选 UI，不写产品代码。
Captain 负责冻结 B1 范围和后续 B2/B3 接口，不开放其他源码任务。
每项完成后按 0.3 模板报告。不要一次执行完整 A–J，不要接真实图片生成，直到 C4 人工垂直切片通过。
```

实际只有单个 Flash 时，按 `A0/D0 → B1–B4 → C1–C4 → D1–D4 → E1–E4 → F/G → H/I` 串行；J 按外部条件另排。每个工作包完成后立即运行定向测试并写交付报告，不能等全部完成才测试。

---

## 15. 总追踪清单

### 核心 Agent

- [ ] A0 当前基线与失败分类
- [ ] B1–B4 私有 Workspace、事务、版本、RPC、验证注册表
- [ ] C1–C2 全项目 SourceFacts 与 AST source-check
- [ ] C3–C4 Composer 完整源码覆盖与人工 menu/product-card 切片
- [ ] D0–D4 真实 Flash 工具调用、HTTP/direct、多轮修复
- [ ] E1–E4 单图单页生成、真实截图、对比、采用导出
- [ ] F1 全 8 页独立源码生成与业务回归
- [ ] F2 新组件、页面 JS、必要路由能力
- [ ] G1–G3 统一会话、项目版本 UI、主流程与 UIA
- [ ] G4 旧 DSL 新入口退出、旧项目兼容与文档更新

### 历史欠账

- [ ] A1 启动健康探测
- [ ] A2a composer:verify PATH_ESCAPE
- [ ] A2b presentation 持久化
- [ ] A2c 图片删除/撤销/redo
- [ ] A2d 受控 422 details
- [ ] A2e RealPreview 错误文案
- [ ] A2f catalog/MIRROR 基线处理
- [ ] A4 旧 P7/T16 重验与可复核证据归档
- [ ] F3 可选组件删除、Base/Catalog/Mirror 同源
- [ ] H1 门店运营优先包
- [ ] H2 订单队列、轮询、多门店和店主 UI
- [ ] H3 Agent 鉴权/幂等/限流、production 导出
- [ ] I1–I5 全量测试、真实模型、微信、安装包、人工清单、文档

### 条件性任务

- [ ] J1 真实生图 provider
- [ ] J2 云端协作
- [ ] J3 真实支付、真机生产发布与云资源

---

## 16. 最终停止条件与汇报口径

Flash 不得以“代码很多”“测试大多通过”“页面已生成”作为总计划完成理由。只有真实证据支持的任务才能标 PASS。

出现以下情况应暂停对应分支并报告，不继续扩大改动：

- 需要删除/回滚用户未提交资产才能继续；
- 需要任意 shell、任意目录或读取秘密才能绕过工具；
- v1 旧项目无法打开或业务核心测试被削弱；
- 修改源码后无法确定采用/撤销/导出是否同源；
- 真实 Flash 不支持所需协议且没有完成替代编排；
- 微信/安装包/真机未运行却被要求写“验收通过”；
- H/J 的真实支付、生产、云资源缺外部条件。

最终汇报至少分四张表：**功能实现、自动化门禁、真实运行证据、仍未完成/阻塞**。核心 Agent、历史欠账、生产化能力分别给结论，不能相互掩盖。
