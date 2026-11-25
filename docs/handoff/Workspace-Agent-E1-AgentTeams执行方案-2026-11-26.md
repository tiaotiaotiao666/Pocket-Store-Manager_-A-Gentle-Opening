# Workspace Agent E1 AgentTeams 执行方案（2026-11-26）

> 基线：`origin/main@3ca4fb2`（E0 技术闭环已通过）。
> 目标：一条受控流水线完成 E1，用户第一次能在产品 UI 中走完
> “一张参考图 + 一句设想 → Agent 修改真实源码 → 检查 → 采用/撤销/导出”。
> 范围：`menu` 页 + `product-card` 组件内部；不扩 8 页，不做云协作，不接支付。
> 结论先说：**可以作为一次 E1 团队运行跑到尾，但不是所有角色同时开工**。必须经过
> 3 个屏障：接口冻结 → Runtime/UI 并行 → 独立真实验收。

## 1. 为什么不能“所有人一步并行”

必须串行的原因：

1. `continueTurn`、preload/facade 方法面、`getCandidateView` 是 UI 与 Runtime 的共同依赖；
   不先冻结，UI 会对着不存在的方法写，Runtime 会造出第二套状态。
2. `App.jsx` 只能由一个 owner 改；UI 外壳可以在接口冻结后先做，但 App 集成必须等
   Runtime 修复回合可用，否则只能演示假成功。
3. verifier 不能边实现边自验。它必须先拿稳定接口和稳定集成结果，再独立复现。
4. `product-card` 内部视觉、真实模型修复、微信截图三者任一未达成，只能记
   `BLOCKED/NOT_RUN/partial`，不能“测试全绿 = E1 完成”。

可以并行的部分：

- 接口/Coordinator 完成后，Runtime 修复回合与 UI 外壳可以并行。
- verifier 的独立测试骨架可以在接口冻结时先写，但不能对未集成 UI 出 PASS。

## 2. 波次与依赖（推荐执行）

```text
Wave 0：Captain 基线、干净工作树、冻结范围
   │
Wave 1：T1 接口 + Coordinator（workspace-lead）        T5a verifier 测试骨架（只写验证器）
   │
Wave 2：T2 Runtime 修复回合（runtime-engineer）  ┐
        T3 UI 外壳（product-ui）                 ├─ 并行，文件不重叠
   │                                             ┘
Wave 3：T4 App/右栏集成 + UIA 冒烟（product-ui，依赖 T2/T3）
   │
Wave 4：T5 E1 独立验证器 + T6 真实 E1 验收（verifier，依赖 T4）
   │
Wave 5：T7 Captain 合并、文档、最终签署（依赖全部 terminal）
```

失败回路：

```text
T6 FAIL/needs_revision
  → 出 finding（文件/行/复现命令/期望）
  → 对应 owner 修复（T2 或 T3/T4）
  → 重跑 T5 回归 + T6 真实链
  → 最多 1 轮修复；仍失败则 E1 不签收
```

## 3. 角色与文件所有权

| 角色 | 负责 | 只能改 | 不能改 |
| --- | --- | --- | --- |
| Captain | 基线、DAG、冲突裁决、合并、最终签署 | `docs/handoff/**`、任务状态 | 不替成员写实现；不批准自己的实现 |
| workspace-lead | E1-A 接口/Coordinator/证据视图 | `contracts/workspace-agent.v1.json`、`desktop/agent-workspace/run-coordinator.cjs`、`desktop/agent-tools-ipc.cjs`、`desktop/preload.cjs`、`src/services/workspaceAgent/index.js`、对应测试 | `src/App.jsx`、Runtime prompt、verifier 目录 |
| runtime-engineer | E1-B 修复回合、product-card、prompt/预算 | `desktop/agent-runtime/**`、`test/runtime/**` | Coordinator 接口、App UI、verifier |
| product-ui | E1-C UI 外壳与 App/右栏集成 | `src/components/agent/workspace/**`、`src/hooks/**`、`src/App.jsx`、UI 测试 | preload/facade/Coordinator、Runtime |
| verifier | E1 独立验证器、真实图片/模型/UIA/微信证据 | `scripts/e1-verify/**`、`docs/evidence/e1/**` | 任何产品实现、任务书、其他 owner 文件 |

文件冲突规则：

- 同一时间只有一个 owner 能改 `preload.cjs`、`workspaceAgent/index.js`、`App.jsx`。
- `package.json` 只在 T4 增加 npm script；T1/T2/T3 不碰。
- 文档按 owner 分开写：`docs/evidence/e1/t1/report.md`、`…/t2/…`、`…/t3/…`；
  最终 `docs/handoff` 只由 Captain 合并。

## 4. 任务卡（可直接落 AgentTeams）

### T1（implementation，workspace-lead，无依赖）

**主题**：E1-A 接口冻结 + `continueTurn` + 候选安全视图

交付：

- `contracts/workspace-agent.v1.json` 增加并冻结：
  - `continueTurn({projectId,runId,turnId,attemptId,utterance})`
  - `getCandidateView({projectId,runId,turnId,attemptId})`
  - `repairTurn` 语义：只允许同一 open attempt，最多 2 个 direct turn。
- Coordinator 实现：
  - attempt 必须 `open`；submitted/adopted/cancelled 一律拒绝；
  - 平台生成 repair prompt 的 issues 摘要（有界、脱敏，不含路径/源码全文）；
  - 返回 turnNumber/usage/attempt 摘要；不让 UI 传 messages、root、命令。
- IPC/preload/facade 接线；渲染层仍不能拼 channel。
- 证据视图只返回：文件相对路径/状态/增删行、检查四态/issues、submission/partial、
  revision/treeDigest、是否可 adopt；不返回绝对路径、源码全文、图片 data URL。

必须的负例：

- 已提交 attempt 调 `continueTurn` → `AGENT_ATTEMPT_IMMUTABLE`；
- 第 3 个 turn → `AGENT_TURN_LIMIT`（或冻结码表内的明确码）；
- 跨 run/turn/attempt、伪造 projectId → 拒绝且零落盘；
- issues 超限/含路径/含 base64 → 截断或拒绝，不进入模型消息。

验收：

- `test/agent-tools-ipc.test.cjs`、`test/desktop-contract.test.cjs`、
  `test/workspace-agent-service.test.cjs`、`test/agent-workspace.coordinator.test.cjs` 全绿；
- 产出一份接口差异说明（rev15 → E1 接口），不得只改代码不写契约。

### T2（implementation，runtime-engineer，依赖 T1）

**主题**：E1-B 真实修复回合 + `product-card` 内部修改能力

交付：

- 系统提示词明确：先读页面和卡片组件；涉及商品卡视觉时，必须同时读
  `components/product-card/index.wxml` / `index.wxss`，不能只改页面外层。
- 修复回合：
  - 从 T1 的 issues 摘要出发，只带失败文件/必要依赖；
  - 重新 `write_files` 后，由平台重跑四项检查；不得拿旧检查证据提交；
  - 最多 2 轮；截断/失败不覆盖上一可用版本。
- 失败回包保留 `images/multimodal`、真实 `code/message`、tool trace 摘要。
- fake model 回归：一次真实页面+组件写入；一次 issue→repair；一次截断零执行。

验收：

- `test/runtime/**` 全绿；
- 新增用例证明候选 diff 命中 `components/product-card/**`，不是只命中页面 WXML；
- 真实模型调用前不伪造 trace/截图。

### T3（implementation，product-ui，依赖 T1）

**主题**：E1-C UI 外壳（只做受控组件与状态，不接 App）

交付：

- `src/components/agent/workspace/`：目标页、图片/consent、设想输入、运行/取消、
  进度、候选摘要、diff 入口、检查四态、采用确认、undo/redo、导出入口、错误态。
- 纯 props/events；所有可交互控件有 aria 名称/稳定 id；未知 stage 显示“未知阶段”。
- `src/hooks/useWorkspaceRun*`：只经 facade，维护 runId/revision/attempt 请求防串。
- 组件测试：缺图、partial、BLOCKED、NOT_RUN、证据陈旧、取消、桥缺失。

验收：新增 UI 测试全绿；不改 `App.jsx`；不直连 IPC/Node。

### T4（implementation，product-ui，依赖 T2、T3）

**主题**：E1-C App/右栏集成 + UIA 冒烟

交付：

- 在项目工作台/右栏接入“按参考图改源码”模式；复用统一会话入口，不新建第二套会话。
- 串起：上传图 → consent → runTurn → 进度 → 候选视图 → submit → partial 确认 adopt
  → undo/redo → 导出。
- 检查失败时可触发 `continueTurn`（最多 1 次），显示修复前后 revision/treeDigest。
- `package.json` 增加唯一 E1 冒烟脚本；新增 UIA 断言。
- 不把 React 预览截图叫微信截图；微信不可用时显示 `BLOCKED/NOT_RUN`。

验收：

- UI/契约测试全绿；
- 本机 UIA 冒烟通过；无窗口环境记 `BLOCKED`，不冒充；
- `App.jsx` 最终只有 product-ui 改动。

### T5（verification，verifier，依赖 T1、T2）

**主题**：E1 独立验证器骨架

交付：

- `scripts/e1-verify/`：只 require 产品公开导出，不复制实现。
- 攻击/状态用例：
  - 无 consent/缺图/两图/坏图；
  - 第二轮修复越权、超轮次、已提交后修复；
  - 证据陈旧、partial 未确认、导出树篡改；
  - UI facade 事件顺序、未知 stage、BLOCKED 不丢失。
- 报告只写 PASS/FAIL/BLOCKED/NOT_RUN；不写 E1 PASS（签署归 T6/T7）。

验收：verifier 自测断言能在失败路径抛错；不修改任何产品文件。

### T6（verification，verifier，依赖 T4、T5）

**主题**：E1-D 真实图片 → 源码 → 修复 → 采用/撤销/导出

输入：

- 清晰 `menu` 参考图（建议 `docs/evidence/m7/wechat/classic-noblock-menu.png`，104KB）；
- 真实设想，明确要求商品卡视觉变化，例如“商品卡图片更大、价格更突出、卡片圆角”；
- 真实 `deepseek-flash`，Key 只从加密存储/环境读取。

必须证明：

1. 图片 sha/bytes 与输入一致，`multimodal=true`；B/C 对照不得“看懂图”。
2. 页面 + `components/product-card/**` 至少一处内部源码变化。
3. 一次真实的 `source.check`/`composer.dry-run` issue → 修复；
   若首轮全 PASS，可用 test-only 注入坏 WXSS 触发修复，但证据必须标 `injected`，
   不得声称“模型自然犯错后修复”。
4. 四项检查 PASS，submit partial，未确认被拒，确认后新版本；
5. undo/redo/重开/导出同源；
6. 微信可用则 before/after 同 route/尺寸截图；不可用写 `BLOCKED`，E1 记 partial。

证据：

- 原件：输入图、输入 sha、模型名、调用次数、trace 摘要、候选 treeDigest、导出摘要；
- 不得只留摘要；不得保存 Key/data URL/完整 prompt；
- 报告明确区分产品 PASS 与环境 BLOCKED。

### T7（integration/signoff，Captain，依赖 T1–T6）

交付：

- 合并稳定分支；跑 E1 回归 + T5 静态 + T6 真实证据；
- 更新 `docs/handoff` 和 E1 完成度；
- 逐项确认 T1–T6 terminal，成员 idle；
- E1 未达完成定义则写 `INCOMPLETE` 和具体缺口，不强行签 PASS。

## 5. 建队参数（给 AgentTeams）

```text
team name: workspace-agent-e1
description: 完成 E1 用户可见的图片→真实源码→检查→采用/撤销/导出闭环
approval: required（先审 staged plan，再运行）

members:
  workspace-lead  （接口/Coordinator/证据视图）
  runtime-engineer（修复回合/product-card/prompt）
  product-ui      （UI 外壳/App 右栏/UIA）
  verifier        （独立验证器/真实图片/模型/微信证据）

tasks:
  T1 implementation workspace-lead  deps: []
  T2 implementation runtime-engineer deps: [T1]
  T3 implementation product-ui      deps: [T1]
  T4 implementation product-ui      deps: [T2,T3]
  T5 verification  verifier         deps: [T1,T2]
  T6 verification  verifier         deps: [T4,T5]
  T7 integration   captain          deps: [T1,T2,T3,T4,T5,T6]
```

注意：

- T3 在 T1 完成后才能改 `src/services/workspaceAgent`；T1 完成后该文件归 T1 结束状态。
- T4 是 product-ui 的第二个任务，必须等 T3 完成，不允许同一成员同时持两个未完成任务。
- T5 与 T6 同一成员顺序执行；T5 未完成前 T6 不启动。
- 任何 finding 回到对应 owner；T7 前不得跳过 T6 直接签 E1。
- 每个任务提交时必须带：改动文件、命令、证据路径、未做项、状态（PASS/FAIL/BLOCKED/NOT_RUN）。

## 6. 完成定义（E1 总体）

只有全部成立才签 E1：

1. 用户可在应用 UI 上传一张图、输入设想、看到真实进度；
2. Agent 修改真实页面和 `product-card` 内部源码；
3. 四项检查与一次修复/重跑可见且证据绑定当前 attempt；
4. 采用需 partial 确认，undo/redo/重开/导出同源；
5. 真实模型与输入图证据可复核；
6. 微信不可用明确 partial，不用 React 截图冒充；
7. T5/T6 独立验证通过，T7 合并完成。

## 7. 停止条件

立即停止并报告：

- 出现 reset/checkout/clean、覆盖用户改动；
- 模型/微信/UIA 证据造假，或 mock 当真实；
- 写正式 `templates/**`、`miniprogram/**`、全局 Registry；
- 任何 owner 越界改共享文件导致主线不可构建；
- 真实 Key、图片 data URL、完整 prompt 进入日志/证据；
- 连续两次修复仍无法通过同一 finding。

## 8. 执行口令（可直接粘贴给 Captain）

```text
以 origin/main@3ca4fb2 为唯一基线，执行 workspace-agent-e1。
先做 T1 接口冻结，不得让 product-ui 或 runtime 先改 preload/facade/Coordinator。
T1 完成后再并行 T2/T3；T4 依赖 T2/T3；T5 依赖 T1/T2；T6 依赖 T4/T5。
verifier 只写 scripts/e1-verify 与 docs/evidence/e1，不写产品实现。
真实模型 Key 只从主进程加密存储/环境读取；图片必须真实进入多模态消息。
微信不可用记 BLOCKED，E1 只能 partial；不得用 React 截图冒充。
所有文件所有权、负例、证据与完成定义见本文件。
```
