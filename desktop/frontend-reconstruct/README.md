# desktop/frontend-reconstruct（P2/P3 本地候选链）

图片驱动前端重构的**本地执行侧**：模型只产出 `frontend-pack-draft.v1` JSON DSL，
本目录把它变成受控的 FrontendPack 候选、私有 Registry overlay 和一次原子 attempt，
再完成 dry-run、最多两轮受控修复与微信运行时验证包装。
桌面主进程/UI（IPC、preload、React）在 P4 接入，本目录不依赖 Electron API。

> 契约常量不在这里手写：枚举/上限/正则/键白名单的唯一事实源是
> [`contracts/frontend-reconstruct.v1.json`](../../contracts/frontend-reconstruct.v1.json)，
> 本目录的 `contract.generated.cjs` 由 `node scripts/frontend-contract.cjs --write` 生成。
> 改契约后必须重新生成；`node scripts/frontend-contract.cjs --check` 与
> `test/frontend-contract.test.cjs` 会拦截漂移，服务端对应物是
> `server/src/agent/frontend-reconstruct/contract.generated.ts`。

## 模块

| 文件 | 职责 | 是否 IO |
|---|---|---|
| `schema.cjs` | `frontend-pack-draft.v1` 安全校验（5 类节点 + 白名单样式 + 事实命中） | 否 |
| `render.cjs` | 确定性 renderer：DSL → `manifest.json` / `src/pages/**.{wxml,wxss,json}` / `preview/{normal,empty,error,long}.json` | 否 |
| `workspace.cjs` | 固定布局 `<userData>/projects/<projectId>/frontend-runs/<runId>/`、attempt 分配、路径/symlink/junction 防护 | 是 |
| `registry-overlay.cjs` | 可信 Registry 投影 + 候选 FrontendPack/Recipe overlay（只写私有目录） | 是 |
| `materialize.cjs` | 校验 → 渲染 → staging 写入 → overlay 自校验 → 原子提交 attempt | 是 |
| `dry-run.cjs` | 复用 Composer P0–P6 + `mini:check` + `output-consistency`，返回统一结构化结果 | 是（仅私有 attempt 内） |
| `compare.cjs` | 只对照可观察项（分区顺序/主题/组件/按钮/锚点/空白/关键动作可点） | 是（只读） |
| `repair.cjs` | 最多 2 轮受控修复：只发结构化 issues + 有界 previousDraft | 否（传输层由 P4 注入） |
| `verify-runtime.cjs` | 固定包装 `scripts/wechat-devtools-run.cjs`：固定参数、超时、取消、证据路径 | 是 |

## 用法（P4 接线前的直接入口）

```js
const { materializeCandidate, dryRun, runRepairLoop, verifyRuntime } = require('./desktop/frontend-reconstruct/index.cjs');

const materialized = materializeCandidate({ userDataDir, projectId, runId, draft });
const dry = await dryRun({ materialized, draft, revision: materialized.attempt });
// dry: { ok, code, summary, details, candidateId, revision, artifacts, issues, checks }

if (!dry.ok) {
  const repaired = await runRepairLoop({
    draft, facts, pageFacts, runId, revision: materialized.attempt,
    dryRun: (next, ctx) => dryRun({ draft: next, userDataDir, projectId, runId, revision: materialized.attempt, signal: ctx.signal }),
    repair: (payload, ctx) => requestControlledRepair(payload, ctx), // P4 注入的唯一服务端入口
  });
  // repaired.adoption === 'none' 时禁止采用；keptDraft 永远是进入本轮前的版本。
}

const runtime = await verifyRuntime({ projectDir: dry.artifacts.outputDir, privateRoot: materialized.attemptDir });
// runtime.status ∈ PASS | FAIL | BLOCKED | NOT_RUN；工具不可用只会是 BLOCKED。
```

固定本地命令（不新增 npm script；`--runtime` 只在需要真实微信验证时加）：

```powershell
node scripts/frontend-verify.cjs --attempt <attemptDir> [--draft <draft.json>] [--plan <plan.json>] [--runtime] [--json <evidence.json>]
# 退出码：0 dry-run 通过（runtime 未跑或 PASS）；1 dry-run 失败；2 微信 FAIL；3 微信 BLOCKED/NOT_RUN
```

## P3 结论口径

- dry-run 的 issues 一定带 `code`，能定位时带 DSL `path`/`field` 与输出 `file`；
  无法定位到 DSL path 的本地故障不会被“自动修复”，而是如实判为不可采用。
- `compare.cjs` 只输出 PASS/FAIL/NOT_RUN/NOT_CHECKED/NOT_APPLICABLE，**不做像素百分比**；
  密度与溢出明确标 `not_checked`，关键动作可点只读微信报告，没跑就是 `not_run`。
- 修复预算固定 2 轮；两轮仍失败 → `REPAIR_LIMIT_EXCEEDED`，`adoption:'none'`，
  `keptDraft` 为进入本轮前的 Draft，候选不可采用。
- 微信验证只执行仓库内的 `scripts/wechat-devtools-run.cjs`，参数由 `verify-runtime.cjs` 固定拼装；
  CLI/工具缺失、超时、脚本崩溃、证据缺失、证据与退出码矛盾都判 `BLOCKED`，绝不伪装通过。


## 单一事实源（frontend-reconstruct 的集成口径）

- 全局能力事实与**页面级事实**都来自 P1 打包装箱的
  `server/src/agent/frontend-reconstruct/capabilities.snapshot.json`
  （开发态相对仓库、打包态在 `app.asar` 内同相对路径；`pageFacts` 内嵌其中，
  旧布局则回退 `page-capabilities.snapshot.json`）。
- dataPaths 只接受 P1 的规范命名空间：`<pageId>.<key>`（如 `home.mode`、`menu.products`）、
  `cart.*`（如 `cart.items`/`cart.totalCents`/`cart.count`）与 `store.*`；
  原始 WXML token（`cartSummary.*`、`products.length`）和 `wx:for` 别名（`item.*`）不是事实。
- 快照缺失 / 缺页 / 形状非法 → `MATERIALIZE_FACTS_INVALID`，**绝不**从原始 WXML 猜测或回退。
  快照仍与可信 Base 交叉校验：组件 ⊆ 页面 `usingComponents`、插槽 == Base Manifest 插槽。
- **渲染期映射（canon → WXML）**：DSL 里的规范 dataPath 在写 WXML 前由 renderer 转换，
  绝不明文透传：`<pageId>.<key>` → `{{key}}`（`home.mode`→`{{mode}}`、`menu.products`→`{{products}}`）、
  `cart.items/totalCents/count` → `{{cartSummary.items/totalCents/totalQuantity}}`、`store.*` 原样；
  未知根或未知 cart key → `RENDER_DATA_PATH_UNSUPPORTED`（materialize 映射为
  `MATERIALIZE_DRAFT_INVALID` + `details.draftCode`）。

## 安全不变量（改动必须保持）

1. **不写全局资产**：`userDataDir` 不允许位于仓库内；候选/overlay 只写 attempt 目录；
   overlay 写入额外拒绝 `templates/`、`miniprogram/`、`src/`、`server/` 前缀。
2. **DSL 不是源码**：未知节点/组件/事件/数据路径/样式键、WXML/WXSS/JS/WXS 原文、
   `{{}}` 模板、URL、绝对路径、反斜杠、`..` 一律拒绝；CSS 只由档位表生成。
3. **事实优先**：组件 props/events、控制器动作、dataPath、插槽都必须命中 P1 事实，
   组件/插槽/数据路径还必须在该页面的目录事实里；home 的数据绑定不能挪到 menu，反之亦然。
4. **确定性**：同一 DSL 渲染出的文件逐字节一致、摘要一致（无时间戳/随机数/绝对路径）。
5. **原子与隔离**：每次物化独占 `attempts/attempt-<n>`，先写 `.staging-<8hex>`，
   用与 Composer 相同的 `loadRegistry`（verifyFreeze）验证后才 rename 提交；
   失败只删除本次 attempt，上一个 attempt 永不被覆盖。
6. **可信 Registry 只读**：overlay 索引投影可信条目（路径 + integrity 原样），
   可信资产仍从仓库只读解析，冻结摘要漂移即失败。
7. **mkdir 顺序**：任何创建目录（私有根、overlayRoot、staging 子目录）都先 canonical 化
   **最近已存在祖先**（lstat + realpath 拒 symlink/junction + 受保护路径检查），
   再逐段非递归 mkdir + audit；祖先被换成链接时在创建任何目录之前失败。

## 定向测试

```powershell
node --test --test-isolation=none test/frontend-reconstruct.renderer.test.cjs test/frontend-reconstruct.workspace.test.cjs test/frontend-reconstruct.materialize.test.cjs
node --test --test-isolation=none test/frontend-reconstruct.dryrun.test.cjs test/frontend-reconstruct.repair.test.cjs test/frontend-reconstruct.verify-runtime.test.cjs
```

（本机沙箱内必须加 `--test-isolation=none`；普通终端 `npm test` 用默认隔离。
`verify-runtime` 测试全程注入 `spawnImpl`，不会真的启动微信开发者工具。）
