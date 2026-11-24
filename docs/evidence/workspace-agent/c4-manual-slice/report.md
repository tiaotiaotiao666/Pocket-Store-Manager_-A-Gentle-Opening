# C4 人工垂直切片证据（t28）

日期：2026-11-24。环境：Windows / Node v24.14.0 / HEAD 本地工作区（未提交）。
性质：**人工**切片，不接模型、不生成图片；不改正式 `templates/**`、`miniprogram/**`。

## 1. 输入（人工 fixture）

`test/fixtures/workspace-agent/c4-manual-slice/`：

| 文件 | 人工改动 |
|---|---|
| `pages/menu/index.wxml` | 根节点 `c4-menu`；新增静态 hero；商品项加 `c4-menu__product`；保留全部状态/事件/`@slot:menu-hero`/`@slot:menu-aside` 锚点 |
| `pages/menu/index.wxss` | hero 渐变卡片、分类导航间距、商品项留白（纯 WXSS） |
| `components/product-card/index.wxml` | media 内新增“人气推荐”徽标；保留 props/事件绑定 |
| `components/product-card/index.wxss` | 卡片圆角/阴影、图片尺寸、名称字重、徽标样式 |
| `source-bundle.json` | `frontend-source-bundle.v1`：base `ordering-base@1.0.0` + treeSha256 `df05a262…`；targetPage(s)=menu；product-card **page-scoped** pages=[menu]；四个文件 sha256 |
| `README.md` | 改动点与消费方式 |

未调用模型、未新增/生成图片；`deleted`/`assets` 为空。

## 2. 全链与判定

执行：`test/agent-workspace.c4-slice.test.cjs`（1 test，EXIT 0）。

1. `versions.initProject`（v1=Base）。
2. B1：`workspace.createAttempt`（source v1）→ `transactions.applyChanges` 写入 4 个 fixture 文件 + `source-bundle.json`；候选树摘要存在。
3. B2：`versions.adoptAttempt` → v2（`adoption.sourceKind=agent-edit`）；`resolveVersionSource` 的 treeDigest 与 adopt 返回一致；版本 source 中四个文件与 fixture 逐字节一致。
4. C3：`composer.compose` 使用版本 source 作为 overlay → 导出成功。
   - 导出 `pages/menu/index.wxml|wxss` 与 fixture 逐字节一致；
   - `components/product-card--menu/index.{js,json,wxml,wxss}` 存在；wxml/wxss 与 fixture 逐字节一致；
   - menu `usingComponents.product-card=/components/product-card--menu/index`；其他页面仍指向 Base 共享组件。
5. `source-changes.json`（见本目录同名文件）：
   - summary：added 5 / modified 16 / deleted 0 / unchanged 121；
   - `pages/menu/index.wxml|wxss` = modified，sha256 与 fixture 一致；
   - `components/product-card--menu/index.wxml|wxss` = added（page-scoped 变体，未改写共享 Base 组件），sha256 与 fixture 一致；
   - overlay：digest `sha256:1b60e839…`，product-card page scope pages=[menu]。
6. 检查：
   - Composer 内部 `verifyOutput`（静态/安全/usingComponents/媒体）PASS；
   - `desktop/output-consistency.inspectOutput(out)` → ok=true（0 problems，143 files）；
   - `scripts/validate-miniprogram.runChecks(out)`（mini:check 同实现，--root 导出目录）→ ok=true（0 errors/0 warnings；8 页 / 15 组件）；
   - C2 `frontend-source/check.checkProject`：修改后 source 与 Base baseline 对比 → 0 issues / 0 new issues；
   - C1：`agent-source-facts.checkSnapshot()` ok；menu page-contract 的 8 个 required handler 与 5 个组件事件全部保留（页面 JS 未改）。
7. 版本链：adopt → undo(v1) → redo(v2) → reopen 后 `currentVersionId=v2`、`treeDigest` 与 adopt 时一致；`verifyExportIdentity` ok。
8. 重复导出：两个不同 parentDir / generatedAt 的导出 `treeSha256`、`lockDigest` 一致；除 report/lock 易变元数据外逐字节一致，`source-changes.json` 相同。
9. 失败路径（不回退 Base）：
   - 缺 overlay → `SOURCE_OVERLAY_MISSING`，无导出目录；
   - 篡改版本 source 后导出 → `SOURCE_BUNDLE_FILE_HASH_MISMATCH`，无导出目录；
   - `verifyExportIdentity` → `AGENT_EXPORT_IDENTITY_MISMATCH`（明确失败，未回退 Base）。

## 3. 真实命令与退出码

| 命令 | 退出码 | 结果 |
|---|---|---|
| `node --test --experimental-test-isolation=none --test-force-exit test/agent-workspace.c4-slice.test.cjs` | 0 | 1/1 pass |
| `node --test --experimental-test-isolation=none --test-force-exit "test/composer*.test.cjs"` | 1 | 134/133/1；唯一失败为 A0 基线既有 composer-media CLI spawn EPERM（非本任务） |
| `node --test --experimental-test-isolation=none "test/frontend-reconstruct*.test.cjs" test/app-frontend-reconstruct.test.cjs` | 0 | 186/186 pass |
| `node scripts/wechat-devtools-run.cjs <temp export copy> --auto-port 9420` | 1 | **BLOCKED**：`WECHAT_RUN_FAILED spawn EPERM`（见 wechat-attempt.log） |

## 4. 微信与真机

- 微信 DevTools CLI 在本沙箱不可 spawn（EPERM）→ **BLOCKED**；未伪造编译/截图，未用 React/预览截图替代。
- 分类切换 / 详情 / 加购减购 / 购物车 / 桌号 / checkout 的**真机交互**无运行时证据 → **NOT_RUN**。
- 需要在可 spawn 微信 CLI 的机器上复跑本报告第 2 节链 + `wechat.verify`，才可把 C4 的运行时部分判 PASS。

## 5. 结论（供 verifier 复核）

- 人工 Workspace → 版本 → C3 Composer → 静态/一致性/mini/source-check/page-contract → 导出同源：**PASS（静态与导出链）**。
- 撤销/重做/重开/重复导出：**PASS**；缺 overlay/漂移 fail-closed：**PASS**。
- 微信真实编译截图：**BLOCKED**；真机交互：**NOT_RUN**。
- 边界：仅新增 fixture、测试与本证据目录；`templates/**`、`miniprogram/**`、`src/server/desktop/contracts/package.json`、`scripts/composer/**` 零改动；未 commit。
- 本报告不自我批准 C4；需 verifier 独立复核（含 junction/安全与测试未削弱检查）后由 Captain 判定。
