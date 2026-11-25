# Workspace Agent E1 下一轮任务（2026-11-26）

> 前置：E0 已完成技术闭环。
> 依据：`Workspace-Agent-E0-当前交接-2026-11-25.md`、总计划阶段 E、接口冻结 rev15。
> 本轮目标：**第一次让用户在产品 UI 中完成“一张参考图 + 一句设想 → Agent 修改真实源码 → 验证 → 采用/撤销/导出”**。
> 范围只做 `menu` 页 + `product-card` 组件内部；不扩 8 页，不接云端，不伪造微信截图。

## 1. 当前起点（可复核）

- 独立离线验证：**114 PASS / 0 FAIL / 8 NOT_RUN**（`docs/evidence/workspace-agent/e0-v1/run-report.json`）。
- 真实 Flash 最小链：**PASS**（`docs/evidence/workspace-agent/e0-v1/real-chain.json`）。
  - 参考图 91,690 B、sha256 `50c57435…f527` 真实进入多模态消息；
  - 3 次模型调用，`get_context/read_file/write_files` 成功；
  - 四项检查 PASS → submit(partial) → 未确认被拒 → 确认后 v2 → undo v1 → redo v2。
- 主进程新入口：`agent:run-turn`、`agent:get-attempt`；preload/facade 共 22 个语义方法。
- 真实微信编译/截图、UIA、真机仍 `BLOCKED/NOT_RUN`。
- E0 UI 原型在 `src/components/agent/e0/`，**尚未接 App 主链**。

## 2. 本轮完成定义（E1）

一条真实用户路径全部成立，且每一步有本地证据：

1. 用户在项目内选择 `menu`，上传一张参考图，写一句设想，明确同意“发给模型”。
2. 平台创建 attempt，Agent 读真实页面/组件源码，修改页面并影响到 `product-card` 内部样式或结构；
   不能只改页面外层，也不能重建整个工程。
3. UI 显示真实进度、工具标签、修改文件数、treeDigest、静态四态；无证据时显示 `NOT_RUN/BLOCKED`。
4. 平台自动跑 `source.check → composer.dry-run → mini.check → output.consistency`；失败 issues 能回灌给模型做
   **最多 1 次**定向修复（新一轮，不覆盖已提交候选）。
5. 用户可看 diff、采用（partial 必须显式确认）、undo/redo、重开、导出；采用后的导出与候选同源。
6. 微信不可用时：UI 如实显示 `BLOCKED`，采用为 partial，**不得显示“微信验证通过”**。

## 3. 工作包与依赖

### E1-A 接口与契约（workspace-lead，先做）

- 冻结 UI → 主进程的最小语义面：
  - 已有 `runTurn({projectId,targetPage,utterance,imageAssetIds})`、`getAttempt`；
  - 新增 `continueTurn`（同一 open attempt 的第二次 direct 回合，带平台生成的 issues 摘要，用于定向修复）；
  - 新增 `getCandidateView` 或复用 `getDiff + readVerification` 组装安全视图（不得向 renderer 回源码全文/绝对路径）。
- 明确修复预算：同一 attempt 最多 2 个 direct turn；已提交/已采用 attempt 只读。
- 更新 rev15 接口冻结与 `test/agent-tools-ipc.test.cjs`、`test/desktop-contract.test.cjs`、facade 测试。

### E1-B Runtime 修复闭环（runtime-engineer，依赖 A）

- `continueTurn` 输入只含：attempt 句柄、用户原话/补充、平台最近一次 check issues 摘要；
  不接受模型/UI 传 root、命令、任意 prompt 历史或路径。
- 模型仍只能看到 11 个工具；第二轮必须重新写文件后重跑检查，防止拿旧证据提交。
- 截断时不执行工具；失败不覆盖上一可用版本。
- 为 `product-card` 增加真实源码事实读取指引（读 `components/product-card/index.*`），
  验证模型能修改组件内部而不是只写页面 WXML。

### E1-C 产品 UI 接线（product-ui，依赖 A，可与 B 并行）

- 在项目工作台接入图片驱动重构入口；**复用统一会话/右栏，不另起第二套主链**。
- 必需元素（均有 aria 名称/稳定 id）：
  - 目标页选择（仅 8 页，E1 默认 `menu`）；
  - 参考图选择/预览/移除、consent；
  - 设想输入、运行、取消；
  - 真实进度（白名单 stage，未知不静默丢）；
  - 候选摘要：修改文件、treeDigest、四项检查、partial/BLOCKED 原因；
  - diff 查看、采用（partial 二次确认）、undo/redo、导出入口；
  - 错误态：模型失败、检查失败、证据陈旧、取消、桥缺失。
- 旧链截图/进度 IPC 缺陷只做“复用所需”的修复，不把旧 FrontendPack DSL 扩成第二主链。
- 新增 UIA 冒烟：运行 → 看进度 → 采用确认 → 撤销。

### E1-D 独立真实验收（verifier，依赖 B、C）

- 用清晰 `menu` 参考图和一句真实设想，真实 Flash 跑通；
- 证明 `pages/menu/index.wxml|wxss` 与 `components/product-card/index.wxml|wxss` 至少一处**组件内部**变化；
- 至少一次真实 `source.check` / `composer.dry-run` issue → 修复；记录修复前后 revision/treeDigest；
- 采用、partial 确认、undo/redo、重开、导出同源；
- 归档输入图 sha256、模型名、调用次数、工具 trace 摘要、候选/导出摘要、UI 证据；
- 微信/UIA 不可用写 `BLOCKED/NOT_RUN`；若微信可用，补 before/after 同 route/尺寸截图；
- 不得把 mock、React 预览截图、旧 P7 摘要当真实证据。

## 4. DAG 与分工

```text
E1-A 接口冻结（workspace-lead）
  ├─→ E1-B continueTurn + product-card 修复闭环（runtime-engineer）
  │      └─→ E1-D 独立真实验收（verifier）
  └─→ E1-C UI 接线（product-ui）──────────────┘
```

- `workspace-lead`：接口、Coordinator 修复回合、diff/证据视图；不改 renderer 组件、不写微信验证。
- `runtime-engineer`：continueTurn、prompt/工具约束、product-card 源码事实、截断/预算。
- `product-ui`：App/右栏接线、可访问性、进度/diff/采用交互；只经 facade，不直调 IPC。
- `verifier`：独立复现真实图、真实模型、真实证据；不写实现、不自批。
- Captain：先冻结 A 的接口，再放行 B/C；D 只看稳定 commit；发现产品缺陷出 finding 给对应 owner。

## 5. 验收命令（预期）

```powershell
# 静态与契约
node --test --experimental-test-isolation=none test/agent-tools-ipc.test.cjs test/desktop-contract.test.cjs test/workspace-agent-service.test.cjs
node --test --experimental-test-isolation=none test/agent-workspace.coordinator.test.cjs test/agent-workspace.vertical-chain.test.cjs
node scripts/e0-verify/run.cjs --mode offline

# 真实模型（Key 只从环境变量/主进程加密存储读取）
node docs/evidence/workspace-agent/e0-v1/run-real-chain.cjs

# 服务端
cd server; npx vitest run --configLoader native --pool=threads test/workspace-agent.test.ts test/model-scheduler
npx tsc -p tsconfig.json --noEmit --incremental false
```

## 6. 非目标与硬边界

- 不扩全 8 页视觉验收（F 阶段）；不做云项目/协作（J）；不接真实支付。
- 不写 `templates/**`、`miniprogram/**`、全局 Registry；正式资产仍走 Composer/Builder。
- 不让模型提供 shell 命令、root、任意输出目录、绝对路径。
- 不保存图片 data URL/Key/完整 prompt；不把 `partial` 当通过。
- 不 reset/checkout/clean 用户工作区。

## 7. 完成判据

- E1-A/B/C 的定向测试与 UI 冒烟全绿；
- E1-D 真实链 PASS（微信可 BLOCKED）；
- 用户可在 UI 中完成一次真实图片驱动修改、采用、撤销和导出；
- 未完成项必须明确标 `BLOCKED/NOT_RUN`，不得用 mock 或摘要代替原件。
