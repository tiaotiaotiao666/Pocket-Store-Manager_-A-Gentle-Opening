# C4 独立复核（t30）— 人工 menu+product-card 垂直切片（C4 硬门禁）

- 复核对象：C4（t28）人工切片 fixture、`test/agent-workspace.c4-slice.test.cjs`、`docs/evidence/workspace-agent/c4-manual-slice/**`
- 复核者：verifier（只读；除本文件外未写仓库文件；攻击脚本 `.tmp/a30/c4-review.cjs`；未做 git 写操作；未启动 Electron；
  未接模型/未做图片生成）
- 时间：2026-11-24 21:08–21:25（+08:00）；Node v24.14.0；DSH 沙箱 `workspace-write`
- 环境：verifier shell 仍 **spawn EPERM**（`composer-media` 测试失败、`wechat-devtools-run` → `WECHAT_RUN_FAILED spawn EPERM`）；
  官方 npm 门禁 BLOCKED；Captain full-access 的 composer 134/134 只作外部证据，未写成 verifier PASS。
- **Verdict：`pass`（0 findings；C4 静态/导出链满足验收）** —— 运行时部分如实 `BLOCKED/NOT_RUN`，不冒充通过。

## 1. 门禁（真实退出码）

| # | 命令 | 退出码 | 结果 |
| ---: | --- | ---: | --- |
| 1 | `… test/agent-workspace.c4-slice.test.cjs` | **0** | **1/1** |
| 2 | `… "test/agent-workspace*.test.cjs"` | **0** | **64/64** |
| 3 | `… "test/composer*.test.cjs"`（13 文件） | **1** | `134 / 133 pass / 1 fail`；唯一失败 `composer-media` CLI spawnSync EPERM = **BLOCKED 环境、非本任务** |
| 4 | `… "test/frontend-reconstruct*.test.cjs" test/app-frontend-reconstruct.test.cjs` | **0** | **186/186** |
| 5 | root 全量等价（131 文件 / 7 块 / 单进程） | **1** | `1373 / 1364 pass / 7 fail / 2 skip`；失败集 = **A0 的 7 项**（6 沙箱 spawn EPERM + 1 MIRROR），**无 NEW** |
| 6 | 官方 `npm test` / `npm run build` | — | **BLOCKED**（spawn EPERM，未伪装） |

## 2. 独立全链复现（自写脚本，不复用实现者测试）

`.tmp/a30/c4-review.cjs`：**29 项 = 29 PASS / 0 FAIL**。

| 段 | 独立断言 | 结果 |
| --- | --- | --- |
| fixture 人工性 | 4 个 fixture 文件与 Base 字节不同（menu wxml/wxss、product-card wxml/wxss）；`base.treeSha256=df05a262…` 与当前 Base 源树一致；`targetPage=menu`；product-card `scope=page,pages=[menu]`；无 base64/密钥/prompt 痕迹；`assets` 为空 | PASS |
| 全链 | `initProject` → v1；`createAttempt(source v1)` → `transactions.applyChanges` 写 4 fixture 文件 + `source-bundle.json`；`adoptAttempt` → v2（`adoption.sourceKind=agent-edit`）；`resolveVersionSource` treeDigest = adopt 返回值；`compose(sourceOverlay=版本 source)` 成功 | PASS |
| 导出字节 | `pages/menu/index.wxml|wxss` 与 fixture **逐字节一致**；`components/product-card--menu/index.wxml|wxss` 与 fixture **逐字节一致**，js/json 为生成的组件四件套（`component:true`、`Component(`）；menu `usingComponents.product-card=/components/product-card--menu/index`；home 仍指向 Base 共享组件 | PASS |
| source-changes | 独立按 `readBaseFiles` 同口径（文本去 BOM/CRLF→LF）重算：**added 5 / modified 16 / deleted 0 / unchanged 121**，与 `summary` 一致；menu.* = modified 且 sha 与导出字节一致；variant wxml/wxss = added；共享 Base 组件不入 diff；无绝对路径/时间戳、自身不入 diff | PASS |
| 确定性 | 两次 compose（同一 generatedAt、不同 parentDir）`result.treeSha256` 与 `lockDigest` 一致；除 `composition.lock.json`/`generation-report.json`/`生成报告.md` 三个易变 wrapper 外**逐字节一致**；`templates` treeSha 复核期间不变 | PASS |
| 版本链 | adopt→undo(v1)→redo(v2)→reopen：current=v2、treeDigest 与 adopt 一致；`verifyExportIdentity` ok（v2、同 treeDigest） | PASS |
| 检查链 | `inspectOutput(out)` ok、**0 problems、143 files**；`runChecks(out)` ok、0 errors / 0 warnings；C2 `checkProject` 修改后 source 0 issues / **0 new**；C1 `checkSnapshot` ok；menu page-contract 8 handlers + 5 组件事件全部保留 | PASS |
| 负例 | 缺 overlay → `SOURCE_OVERLAY_MISSING` 且**无导出目录**；篡改版本 source 后 compose → `SOURCE_BUNDLE_FILE_HASH_MISMATCH` 且无导出；`verifyExportIdentity` → `AGENT_EXPORT_IDENTITY_MISMATCH`；恢复后 ok；声明文件缺失 → `SOURCE_BUNDLE_FILE_MISSING`；未知组件标签 → `SOURCE_OVERLAY_COMPONENT_UNKNOWN`；声明 sha 篡改 → `SOURCE_BUNDLE_FILE_HASH_MISMATCH`——**均未回退 Base、未产生半套输出** | PASS |
| 人工边界 | 仅 fixture/test/evidence 新增，`templates/**` 复核期间零写入 | PASS |

## 3. 证据交叉核对（实现者归档 vs 独立复算）

`docs/evidence/workspace-agent/c4-manual-slice/`：
`report.md` 的 summary（added 5 / modified 16 / deleted 0 / unchanged 121）、base tree `df05a262…`、
overlay digest `sha256:1b60e839…` 与我的独立复算一致；`source-changes.json` 21 条变更字段/摘要一致；
`export-tree.txt` 的 146 文件 = inspectOutput 143 + lock/report/生成报告 3 个 wrapper；
`wechat-attempt.log` 记录 `Exit: 1 / Status: BLOCKED / WECHAT_RUN_FAILED spawn EPERM`，与我的独立尝试一致。

## 4. 微信与真机（如实）

- 我自行尝试：`node scripts/wechat-devtools-run.cjs <temp export copy> --auto-port 9420` → **EXIT 1**
  `WECHAT_RUN_FAILED spawn EPERM` → **BLOCKED**；**无微信编译、无运行时截图、无交互**；未用 React/预览截图替代。
- 分类切换 / 详情 / 加购减购 / 购物车 / 桌号 / checkout 的真实运行证据 **NOT_RUN**（需在可 spawn 微信 CLI 的机器复跑）。
- 因此 C4 仅**静态与导出链** pass；运行时部分保持 BLOCKED/NOT_RUN，不写成通过。

## 5. 非 finding 观察

1. `order-classic` Plan 的 menu 页未分配插槽（`pages[menu]` 仅 pageId），因此删除 fixture 中 `@slot` 注释**不会**触发
   `SLOT_REQUIRED_BY_PLAN`（C3 语义：仅 Plan 已分配插槽才阻断；slot 负例已在 C3 r2 用 home+POSTER 验证）。
   本条不构成 C4 缺陷，记录口径。
2. page-scoped 变体 js/json 是生成的四件套（非 fixture 字节）；验收只要求 variant wxml/wxss 与 fixture 一致 + 四件套存在，
   与实现一致。
3. `source-changes.json` 在 C3 `buildProjectFiles` 内生成，早于 compose 写 `composition.lock.json`/报告，
   故 diff 不包含这三个 wrapper；独立核对需排除它们才能得到 5/16/121（已在 §2 按此口径）。
4. `composer-media` 失败与微信 BLOCKED 均为当前 verifier shell spawn EPERM 所致；Captain full-access 的
   composer 134/134、微信/真机状态以其外部证据为准，不出现在本报告的 verifier PASS 中。

## 6. 越界核对

- C4 新增：`test/fixtures/workspace-agent/c4-manual-slice/**`（6 文件）、`test/agent-workspace.c4-slice.test.cjs`、
  `docs/evidence/workspace-agent/c4-manual-slice/**`（5 文件）；`git status` 三者均为 `??`（未提交）。
- `scripts/composer/**` 最新 mtime 为 C3 的 `source-overlay.cjs` 20:26 / `emit.cjs` 19:56 / `index.cjs` 19:57，C4 未改；
  `templates/base|components|registry`、`miniprogram`、`src`、`server`、`desktop`、`contracts`、`package.json` 无 C4 写入
  （`contracts/workspace-agent.v1.json`、`server/src/agent/workspace/**` 的 21:0x mtime 属并发 D1，不是 C4）。
- HEAD 仍 `437bf5f`（C4 未提交）；verifier 未做任何 git 写操作；**C4 自身越界为零**。

## 7. 结论

- 人工 menu+product-card 切片在 **B1 事务 → B2 版本 → C3 overlay → Composer 导出 → 静态/一致性/mini/source-check/
  page-contract** 全链上通过独立复现；导出与 fixture 逐字节一致；source-changes 计数与 sha 正确；版本链与失败路径
  fail-closed；测试 1/1、64/64、186/186 不回归，越界为零。
- **verdict=pass（0 findings）**；微信真实编译/截图 `BLOCKED`、真机交互 `NOT_RUN`，按 C4 口径保持未验收，
  未伪造任何运行时证据。
- 证据：本文件；攻击脚本 `.tmp/a30/c4-review.cjs`；临时 userData/导出在 `%TEMP%`（不写仓库）。
