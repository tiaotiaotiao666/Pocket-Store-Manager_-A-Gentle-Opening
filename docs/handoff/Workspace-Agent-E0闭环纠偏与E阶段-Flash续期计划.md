# Workspace Agent：E0 闭环纠偏与 E 阶段 Flash 续期计划

> 日期：2026-11-24。状态：**审计完成，待执行**。上游：总计划 A–J、接口冻结 rev14、C4/D1 独立复核。
>
> 审计基线：当前工作区 HEAD `437bf5f`，`origin/main=a540d78`，本地 ahead 5 / behind 22；存在 staged、unstaged 和 untracked 交付/用户改动。禁止 reset/checkout/clean，禁止在未做集成身份确认前继续叠加 E。
>
> 本计划不是否定 B/C/D1，而是修复抽查发现的实际断点。**E0 未通过，不开放真实图片生成 E1–E4。**

---

## 0. 对上一轮交付的评价

### 0.1 值得保留的实质成果

- B1/B2 私有工作区、事务、摘要、不可变版本和采用/undo/redo 基础可复用。
- C1/C2 有真实 SourceFacts 和 AST 检查，不是提示词空壳。
- C3/C4 人工 menu + product-card 切片经过独立复现：页面/组件最终源码可进入 Composer，导出、diff、版本和静态检查同源。
- D0 有真实模型证据，D1 的 HTTP 契约、mock、Runtime 复用和单测有实质价值。
- 报告诚实地区分了静态 PASS、真实模型 NOT_RUN、微信/UIA BLOCKED，没有冒充用户可用。

### 0.2 完成度的准确口径

- **基础设施：较好；核心功能：尚未打通；用户可用：0。** 该口径保持不变。
- C4 的 PASS 是“人工 fixture 的静态/导出链 PASS”，不是模型生成或微信运行时 PASS。
- D1 的 PASS 是“服务端契约和 mock/fake proxy 边界 PASS”，不是桌面 RPC 或真实模型工具循环 PASS。
- 不能把 0 findings 理解为架构无断点；独立复核主要验证任务合同，未覆盖下面的跨模块闭环。

---

## 1. 审计发现：必须先修的“左右脑互搏”

| ID | 严重度 | 事实 | 为什么阻断 E | 修正决策 |
|---|---|---|---|---|
| X1 | blocker | D1 工具经 `WorkspaceRpcProxy`，默认实现固定 `WORKSPACE_RPC_UNAVAILABLE`；没有桌面到 Nest 的桥接 | 真实模型不能读写/验证任何项目 | 桌面主进程成为执行所有者，优先 direct 本地编排；HTTP 只能经显式本机 RPC channel，不作 E 主链 |
| X2 | blocker | D1 图片只在 prompt 写 `assetId`，没有读图并构造多模态 content parts | 模型看不到参考图 | 主进程按当前项目 assetId 解析受控资产、复检 MIME/大小，形成有界 data URL，再进入 ChatModel |
| X3 | blocker | 工具写文件要求已有 attempt，但没有开始 run/turn/attempt 的完整工具；读文件只读已采用 version | 主循环无法从当前版本创建工作副本并迭代 | 本地编排器创建 run/turn/attempt；工具统一 `subject={kind:attempt|version,...}`，E 主链只用 attempt |
| X4 | blocker | `source.check` 实际执行旧 frontend-capabilities；`mini.check` 查只读镜像；`composer.dry-run` 只看已采用 version | “验证通过”可能完全没有检查刚生成的候选 | 每个 checkId 绑定明确 subject；source.check 执行 C2 checkProject，Composer 先 compose 当前 attempt，再 mini/output 检查导出树 |
| X5 | blocker | `submit-candidate` 仍复用 v1 `home/menu` 枚举 | 其余 6 页无法提交 | 8 页目标从 workspace-agent/SourceFacts 同源，不复用 v1 DSL 常量 |
| X6 | blocker | B1 写文件不自动生成 `source-bundle.json`；人工 C4 显式写入，adoptAttempt 不补 | Agent 正常读写产生的 attempt 无法被 Composer 消费 | 提交前由本地确定器从“当前版本 → attempt”diff 派生 bundle，校验/写定后再重算 treeDigest；模型不写摘要清单 |
| X7 | high | `submit-candidate` 不强制 source-check/Composer 通过；`adopt-version` 可接收任意证据字符串 | 未验证候选可进入当前版本 | 提交门禁静态必须通过；采用读取磁盘证据并校验 treeDigest；runtime BLOCKED/NOT_RUN 只能 partial 显式确认 |
| X8 | high | Runtime 记录 `truncated/finish_reason=length` 但仍可能 final_answer 或执行工具；直连无 finishReason | 长源码/参数被截断后可能当完整结果 | Workspace loop 遇截断立即停止本批工具执行并返回 `output_truncated`，可定向重试；直连补 finishReason/truncated 和预算 |
| X9 | high | D1 用正则把“已验证/已采用”替换为“待本地确认” | 把模型文本改成看似事实，不是可信状态 | 删除该伪状态修正；模型回复仅供参考，UI 状态完全来自本地版本/检查证据；敏感信息单独 scrub |
| X10 | medium | UI 调研发现 progress 丢阶段、旧截图 IPC 丢 screenshots、标签三份、screen-reference 直连 | E 用户反馈和截图对比会失真 | E 使用统一 run 状态和单页枚举；修真实截图读取；旧链不在本轮扩写 |
| X11 | process | 本地/远端分叉且 staged/unstaged/untracked 混合 | 无法可靠判断某次修改属于哪一交付，容易覆盖用户资产 | 先完成 E0-Git 集成审计，不经用户批准不做破坏性同步 |
| X12 | high | 服务端 `AGENT_MAX_CONCURRENT` 默认 2 且只限制 Agent HTTP 请求；一次请求内部多轮调用模型，桌面 direct 也没有共享上游调度器 | 用户 API 上游并发上限为 3，简单改环境变量仍可能超限 | E0-R1 增加统一 `ModelCallScheduler`，每次实际上游调用 acquire/release，默认上限 3，排队而非报忙；HTTP/direct 各自进程内全覆盖 |

---

## 2. 架构修正：一个执行所有者，两种模型通道

### 2.1 不再让“服务端 HTTP 请求天然拥有桌面 RPC”

采用以下结构：

```text
React 统一会话
→ workspaceAgent facade
→ Electron 主进程 WorkspaceRunCoordinator
     · 创建 run/turn/attempt
     · 持有当前 project/version/attempt
     · 调度 direct 或 HTTP 模型通道
     · 执行本地工具、检查、证据和候选提交
→ 模型工具调用回到同一 Coordinator（不是另一条状态链）
→ submitted attempt
→ 本地 adoptAttempt → 不可变 version → 同源导出
```

- **direct（E 默认）**：复用主进程 `modelChat` 与 D0 已验证的真实多模态/tools 能力，工具直接调 B3/B4 本地模块。
- **HTTP（可选）**：Nest `workspace-agent.v1` 保留，但由 Coordinator 注册显式、短期、项目/run 绑定的 RPC channel；服务端只通过该 channel 回调，不自行猜桌面地址，不开放公网文件代理。
- direct 与 HTTP 共享工具语义、预算、截断处理、trace 和提交规则；不能出现 direct 已改源码、HTTP 仍 unavailable 的两套产品事实。
- mock 只用于测试并显式标识，绝不参与真实完成汇报。

### 2.2 本地生命周期由平台负责，不让模型管理目录

新增/冻结内部 API（不是任意模型命令）：

```text
startWorkspaceRun({projectId, baseVersionId, targetPage, operation, utterance, imageAssetIds})
→ {runId, turnId, attemptId, baseTreeDigest}

工具上下文固定包含：
{projectId, runId, turnId, attemptId, subject:{kind:"attempt", attemptId}}
```

- UI/Coordinator 创建 attempt，模型只接收句柄。
- `get_context/list_files/read_file/search_files/write_files/delete_files/get_diff` 默认操作当前 attempt。
- `read_file` 可显式只读 base version，但写入永远只针对 attempt。
- 每次写事务后重算 treeDigest；继续编辑同一 attempt 增加 revision，repair 可新建 attempt，不覆盖已提交候选。
- 服务端/模型不能提供 runId/turnId/attemptId 以外的目录或用户私有根。

### 2.3 图片进入模型

1. UI 只能选择当前项目已上传资产；发送前沿用用户 consent。
2. 主进程从 assetId 派生路径，canonical 检查，拒绝链接/越界。
3. 检查魔数、真实 MIME、像素/解码、大小与总预算；支持 PNG/JPEG/WebP。
4. 转成模型适配器需要的多模态 `image_url` data URL，只存在于本次调用内存，不写日志、run metadata 或 project snapshot。
5. 图片缺失/格式不支持/超预算明确失败，不把 assetId 文本当视觉输入。
6. E 首轮只接受一张目标页参考图；附 targetPage 和 utterance。

### 2.4 候选检查、提交、采用

```text
写完成
→ deriveSourceBundle(currentVersion, attempt)
→ source.check(attempt)
→ composer.dry-run(attempt) → verification/dry-run/exported
→ mini.check(exported) + output.consistency(exported)
→ submit-candidate（读取并保存上述证据，绑定 treeDigest）
→ verify-wechat(exported)（可用时）
→ adopt-attempt（读取 submitted + evidence；partial 需显式确认）
```

- `source.check` 直接调 `scripts/frontend-source/check.cjs#checkProject`，不再映射旧 capabilities。
- 保留 `capabilities.check` 作为独立 repo check，不能冒名 source.check。
- `mini.check` 接收**派生导出根**；无根时不得默认查仓库镜像。
- Composer 从 attempt 的 source-bundle 生成完整导出树；后续 mini/output/wechat 都引用该树摘要。
- `source-bundle.json` 由平台派生，包含 base、targetPages、文件 sha、deleted、组件 scope 和 assets；派生后重写 attempt manifest/treeDigest，提交采用再次核对。
- `submit-candidate` 使用独立 8 页枚举，要求静态 PASS；缺证据拒绝。
- `adopt-attempt` 调 B2 `adoptAttempt`，保存 verification/evidence；不能只 adopt-version 传字符串。
- runtime 四态统一 `PASS/FAIL/BLOCKED/NOT_RUN`，静态四态可用 `PASS/FAIL/BLOCKED/NOT_RUN` 或统一转换，避免 pass/unknown/PASS 多套。
- 模型文字不做“已验证”正则替换；UI 只展示本地事实。

---

## 3. 新一轮团队分工

继续使用 1 Captain + 4 成员，但 E0 期间 `workspace-lead` 是唯一主干写入者；Runtime 与 UI 只在冻结接口后接线。

| 成员 | E0 任务 | E 任务 | 禁止 |
|---|---|---|---|
| Captain | X11 集成审计、rev15 冻结 X1–X11、依赖与合并 | 控制单页垂直交付，不提前开 F/G/H | 不用 0 findings 替代跨链验收 |
| `workspace-lead` | **E0-W1/W2**：Coordinator、attempt subject、bundle 派生、检查目标、adopt-attempt | E2 本地生成/修复、attempt 生命周期、导出同源 | 不改 Nest 模型循环，不同时接 App |
| `runtime-engineer` | **E0-R1/R2**：direct loop、真实图片输入、截断/预算、HTTP 可选桥 | E1 视觉需求与源码生成、E2 定向修复、D3/D4 | 不创建第二套 Workspace，不把 assetId 当图片 |
| `product-ui` | **E0-U1**：只读接口差距和原型；rev15 后做单页输入/进度原型 | E3 图片+设想、diff/截图、采用/undo、错误状态 | 不直调 IPC，不提前改 App/reducer |
| `verifier` | **E0-V1**：攻击链和独立集成复现 | E4 真实模型/微信/UIA、证据归档 | 不写实现，不将 mock 当真实 |

### 3.1 依赖

```text
E0-Git + rev15
→ E0-W1（Coordinator/生命周期）与 E0-R1（direct loop 接口）可并行设计
→ E0-W2（检查/bundle/adopt）与 E0-R2（图片/截断）并行实现
→ E0-Integration（无 UI 的真实 Node/Electron 主进程垂直测试）
→ verifier 独立 PASS
→ E1/E2/E3 接 UI 与真实图片
→ E4 独立验收
```

E0-R1 可以先在临时/自有模块中写接口和测试，但不能自行发明另一套工具状态。E0-W1 冻结 Coordinator 后才能合并 Runtime。

---

## 4. 任务书

### E0-Git：集成身份确认（Captain）

1. 对 `origin/main=a540d78`、HEAD、index、worktree 分别生成变更清单和摘要。
2. 对照 17 个远端提交，确认 B3/B4/C3/C4/D1 的磁盘文件与远端是否一致。
3. 将用户未提交改动与 Agent 交付分类，尤其 `src/App.jsx`、Base/miniprogram、app-assistant、docs。
4. 备份分支保留；如需 merge/rebase/stash，先向用户列出计划和冲突，不自行破坏工作区。
5. 形成唯一“下一轮基线树”和提交/未提交清单。

**门禁：** 后续每个任务能准确说清基线与变更归属；禁止直接在当前混乱状态上叠加 E。

### E0-W1：WorkspaceRunCoordinator 与生命周期（workspace-lead）

- 新增 `desktop/agent-workspace/run-coordinator.cjs` 或同职责模块。
- start run → 当前 version → createAttempt → 工具 subject 注入 → revision/treeDigest。
- 工具默认 attempt，base version 只读；提交后只读，repair 新 attempt。
- 不暴露路径给 renderer/模型；进度/取消/trace 统一。
- 增加主进程内部直接调用工具执行器的方法，供 direct/HTTP 共用，不经 renderer 回环。

**测试：** 无 UI 创建 attempt、读 base、写 candidate、跨项目/版本拒绝、取消、迟到工具、重复提交。

### E0-W2：真实检查、SourceBundle 与采用（workspace-lead）

- 修 X4/X5/X6/X7；source-bundle 自动派生。
- `composer.dry-run` 返回相对导出引用与 treeDigest；mini/output 只查该导出。
- `submit-candidate` 静态门禁、8 页、证据绑定；新增 `agent:adopt-attempt` 并接 B2。
- 修 verification 四态和 evidence 持久化；导出复核 submitted/adopted tree。
- 可保留旧 `capabilities.check` 独立 checkId。

**测试：** 未经检查不能 submit；旧 tree 证据不能采用；缺失 bundle 自动补；agent 正常 write→compose 成功；partial 确认；8 页目标；错误 mini 根不再查镜像。

### E0-R1：direct Workspace Runtime（runtime-engineer）

- 在 `src/services/workspaceAgent/` 与必要的 desktop model 边界实现 direct transport/coordinator 接口。
- 不复制服务端第二套 Workspace；工具统一调 Coordinator 提供的 invoke。
- 复用 D0 已验证 tools/tool_calls 回填协议、预算、取消、loop detection、安全 trace。
- `modelChat` 返回 `finishReason/truncated/finish_reason`；遇 length 停止工具执行，返回 `output_truncated`。
- 直连 maxTokens 不再非法回退 1200；工具数量和输出预算满足源码编辑，超限明确报错。
- HTTP 保留为可选 transport，RPC channel 未连接时明确 unavailable，不影响 direct。

#### E0-R1a：上游模型调用并发上限 = 3（X12）

**这项必须在 direct 真实工具循环前完成。**

用户 API 允许的最大并发是 **3**。这里的“并发”指**正在发往该 API 的上游模型 HTTP 请求数**，不是页面请求数、Agent Team 人数，也不是工具调用数。

实现要求：

1. 新增共享 `ModelCallScheduler`（建议 `desktop/model-call-scheduler.cjs`；若服务端也要直接控制，则抽为可被两侧复用的纯 CJS/TS 共享模块）。**上游每一次 `chat/completions` 实际请求**都必须经过它：包括主对话、图片理解、设置页测试、repair、vision 探测等。
2. 默认上限从配置 `MODEL_MAX_CONCURRENT=3` 读取（范围 1–3；用户上限为 3，**任何路径都不得配置成更高**）。没有配置时也用 3，不接受“看情况自动放大”。
3. 槽位获取采用**公平 FIFO 排队**，等待超时返回可读 `MODEL_QUEUE_TIMEOUT` 或 `MODEL_BUSY`；不要直接向用户暴露 429。排队等待默认上限 180s（可配置 30–600s），应覆盖一次正常长生成；**模型请求自身的 timeout 从拿到槽位后开始计时**，排队时间不能先把请求超时耗尽。
4. 每个槽位在**拿到响应并读完 body、或确认失败/超时/取消之后**才释放；不能在只拿到 HTTP 头时释放。长任务进度应显示“排队中/调用中”，避免用户误以为卡死。
5. 429/5xx 重试必须继续持有或重新排队该槽位；不能一边等待重试一边占用另一个槽位导致 3 变 4。
6. 请求被取消（用户取消、项目切换、run abort）必须从等待队列移除并释放已占槽位；取消后不得再发起上游请求。
7. 调度器只控制**进程内**并发。桌面与 Nest 服务端若同时运行，二者进程各自限 3 仍可能合计超 3；因此需要以下之一：
   - 优先方案：E 阶段真实调用只走**桌面 direct 单一出口**，服务端只作为可选通道；
   - 若同时启用 HTTP + direct，必须共用一个外部/跨进程限流器（本机文件锁或主进程 IPC），否则必须禁用其中一条通道并在 UI 显示原因。
8. 不把并发上限混同于 Agent 运行次数：`AGENT_MAX_CONCURRENT` 只控制 Nest 的 Agent 请求入口，不能替代 `ModelCallScheduler`。服务端的默认值应改为与上游一致或显式说明它只是入口门槛；入口请求可以排队，不能因为并发 3 就把合法 Agent 请求直接 429。
9. 配置文档和安全设置页只显示“最多同时 3 次模型请求”，不显示 Key；模型测试连接也走调度器，避免“测试”挤爆正在进行的生成。
10. 可观测性：日志/trace 只记录入队/出队/等待时长/当前占用/最大排队数，不记录 prompt、源码、图片或 Key。诊断页可显示 3 个槽位状态，但不得展示用户内容。

当前代码事实（供执行者核对，不要照抄旧值）：

- 服务端 `server/src/common/config/env.validation.ts` 的 `AGENT_MAX_CONCURRENT` 默认是 **2**，且 `AgentConcurrencyInterceptor` 限制的是 HTTP Agent 请求，不是上游每次调用。
- 桌面 `desktop/model-credentials.cjs#requestChat` 目前没有并发调度；`settings:model:test` 和 `settings:model:chat` 都走同一个 `credentials.chat`，因此必须在这个底层出口加调度，而不是只在 UI 或 direct transport 加。
- 服务端模型适配器与桌面模型通道是两个进程/两套出口；不要把只加在其中一个上的上限当成全局保证。

**测试：**

- 同时发起 5 次 fake `credentials.chat`，观测只有 3 个 fetch 并发，其余 2 个排队；完成后全部成功。
- 1 个慢请求占槽，4 个排队；取消 1 个排队任务不减少已执行任务数；取消运行中任务释放槽位。
- 排队 179s 后拿到槽位的请求，模型调用仍有完整 timeout；排队超过 180s 明确 `MODEL_QUEUE_TIMEOUT`，不误报为上游超时。
- 429→重试期间不出现第 4 个并发请求；重试成功后槽位释放。
- 上游返回错误、超时、响应体解析失败都能释放槽位，不泄漏。
- 测试连接与真实生成同时触发时，仍不超过 3。
- 配置 >3 被拒绝或 clamp 并给出可见警告，不能静默接受。
- direct 与 HTTP 同时启用时，有明确互斥/共享限流测试，证明合计不超 3。

**E0-R1 验收补充：** 没有该调度器测试通过，不得进行真实多轮/多工具生成，也不得把 `AGENT_MAX_CONCURRENT=3` 当作已满足用户限制。

### E0-R2：图片资产与视觉消息（runtime-engineer）

- 实现 X2 主进程资产解析与多模态消息构造。
- 提供 vision budget、空正文+length、图像 MIME/大小/总数的明确处理。
- 图片只传内存，不进入日志/快照/trace。
- 缺图、坏图、模型无视觉能力时 fail/needs-input，不静默文本生成。

**测试：** 用真实小图走 direct 模型，证明回答依赖图片内容；不能只用 assetId 文本断言多模态。

### E0-U1：产品接口与原型（product-ui）

- 只读梳理 rev15 facade；产出目标页选择、图片上传/consent、utterance、进度、diff、截图、采用/undo 的组件接口。
- 可先写独立展示组件和测试，但不得修改 `App.jsx/sessionMachine`。
- 统一 targetPage 八页、progress 阶段和四态，不复制第三份标签表。

### E0-V1：独立端到端门禁（verifier）

必须独立复现以下无 UI 垂直链：

```text
临时 userData + 当前 Base
→ init/adopt base version
→ start run/attempt
→ fake model 读 menu/product-card 并写入真实修改
→ derive bundle
→ source.check(attempt)
→ Composer dry-run
→ mini/output(exported)
→ submit
→ adopt-attempt
→ undo/redo/reopen/export
```

另外执行真实 Flash：

- 一张真实小参考图 + menu 目标；
- 证明模型收到图片、调用工具、写出源码、读取检查结果并修复一次；
- 记录输入 sha、实际响应 model、工具 trace、treeDigest、截断/重试；
- 微信/UIA 不可用仍 BLOCKED，不阻止判定 direct 工具闭环，但 E4 最终不能称微信通过。

**E0 通过条件：** 上述链和负例通过，X1–X12 有代码与测试关闭（X12 为模型上游并发 ≤3），X10 接入项冻结，X11 基线明确。

---

## 5. E 阶段（E0 通过后才开放）

### E1：单图单页输入与视觉分析（runtime + product-ui）

- 一个 targetPage、一张参考图、utterance、consent；
- 复用 C1 页面/组件事实和真实源码；
- L1 业务能力缺失明确 rejected/degraded，L2 缺同款视觉组件不阻断；
- 图片真实进入模型，禁止 assetId-only。

### E2：源码生成与定向修复（workspace-lead + runtime）

- 首轮只改 menu 与必要 product-card；
- 本地 source/Composer issues 回灌，最多 2 次修复；
- 每次 revision/attempt 和 treeDigest 可追溯；
- 截断不执行工具，失败不覆盖已提交候选。

### E3：候选 UI（product-ui）

- 修改文件、源码 diff、组件影响、静态/运行时四态；
- before/after 微信截图同 route/尺寸，缺图如实；
- 采用 attempt、partial 显式确认、undo/redo、重开、导出；
- 真实进度，未知阶段不得静默丢弃；
- 修旧截图 IPC 字段问题只用于复用工具，不把旧链扩成第二主链。

### E4：独立真实验收（verifier）

- 真实参考图（非 64×64 探针图）与真实设想；
- 页面和 product-card 内部都发生合理变化；
- 至少一次真实 issue→repair；
- 分类/详情/加减购/购物车/桌号/checkout 真实交互（环境允许）；
- 采用→undo→redo→重开→导出同源；
- 证据原件、输入图片 sha、模型名、trace、候选与截图归档；
- 真实微信/UIA BLOCKED 时总结为 partial，不得称 E 完整验收。

---

## 6. 启动指令（可直接交给 Flash Team）

```text
读取 docs/handoff/Workspace-Agent-E0闭环纠偏与E阶段-Flash续期计划.md、
接口冻结 rev14、总计划和当前工作区交接。不要直接开始 E1–E4。

Captain 先执行 E0-Git 并冻结 rev15，关闭 X1–X12 的任务边界。
workspace-lead 负责 E0-W1/W2；runtime-engineer 负责 E0-R1（含 R1a 上游并发=3）/R2；
product-ui 只做 E0-U1 接口和独立原型；verifier 准备 E0-V1 独立攻击链。

采用桌面 WorkspaceRunCoordinator 为唯一执行所有者；direct 是 E 默认通道。
上游每次模型请求共享 ModelCallScheduler，并发上限 3；HTTP 与 direct 不得各算一套后叠加超限。
HTTP 可选，未连接 RPC 不得影响 direct。图片必须真实进入多模态消息。
所有检查必须针对当前 attempt/其导出树，不得用 Base/镜像检查冒充候选检查。
source-bundle 由平台派生，submit 静态门禁，adopt-attempt 证据绑定。
E0 独立验收通过前，禁止接 App 主链和真实图片生成。

每项按总计划 0.3 模板汇报。任何 reset/checkout/clean、覆盖用户改动、
伪造模型/微信证据或将 mock 当真实的行为立即停止。
```

---

## 7. 后续顺序

- E0 PASS → E1–E4：用户第一次可见核心功能。
- E4 静态/真实模型 PASS 但微信 BLOCKED：可交付开发态 partial，继续修环境，不扩 8 页。
- E4 微信与 menu 业务 PASS → F/G 全 8 页和统一会话。
- A1/A2、H/I 业务与生产欠账由独立后续团队接，不与 E0 同批改共享主干。
