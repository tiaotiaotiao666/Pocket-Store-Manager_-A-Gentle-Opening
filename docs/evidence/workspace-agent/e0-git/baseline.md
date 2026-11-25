# E0-Git：集成身份确认（下一轮唯一基线树）

> 执行者：Captain（`lead`）。时间：2026-11-25。方式：只读 `git rev-parse/status/log/diff/hash-object/cat-file`，
> **未执行** `reset/checkout/clean/stash/rebase/merge`，未改动任何工作区文件（本文件除外）。
> 机器可读分类：`status-classification.json`（同目录，106 条路径逐条记录）。

## 1. 结论（一句话）

本地工作区内容 = **`origin/main`（`a540d78`）的磁盘内容 + 15 个真实的 app-assistant 本地未提交改动 + 7 个未跟踪文件**。
B3/B4/C3/C4/D1 的交付文件在磁盘上**与远端逐字节一致**；本地 `HEAD`（`437bf5f`）只到 C2，缺 B3–D1。
因此**下一轮基线树 = `origin/main` 内容 + 下表 15+7 项**，无需任何破坏性同步，E0 可直接在此基线上叠加。

## 2. 环境与分叉

| 事实 | 值 |
|---|---|
| `git rev-parse HEAD` | `437bf5f0aedb727e39aa7d898eeef9764c1b3b4c`（`新增：C2 共享 source-check`） |
| `git rev-parse origin/main` | `a540d78b44cb817c1c1c06f2da3e02472e90cec2`（`文档：冻结 rev14 + D1 复核证据`） |
| 分叉 | `ahead 5 / behind 22` |
| 本地独有 5 提交 | `9496727` A0/A4 · `ddb0492` D0 · `13928c3` B1/B2 · `49926fd` C1 · `437bf5f` C2 |
| 远端 5 个同内容提交 | `fb6065d` A0/A4 · `8ed7e28` D0 · `5053118` B1/B2 · `183eb16` C1 · `d61d70d` C2（内容同、SHA 不同） |
| 远端真正领先的 17 提交 | `3ff97ea` C1 快照对齐 · `a248685` B3 · `1841c4e` B3 userDataDir 修复 · `3d266c8` rev8 · `7afa6d0` B4 · `369b885` rev10 · `574458d` C3 · `73470f6` rev12 · `f78d6cb` C4 · `cf03352` rev13 · `6d73d5f` D1 · `a540d78` rev14 · 以及上游 5 个非 Agent 提交 `21a4b0f`/`e30e78b`/`e03e287`/`23674c7`/`f407c49` |
| 安全备份分支 | `backup/local-before-sync-20261124` 存在（保留，不动） |
| 状态规模 | `git status --porcelain -uall` 共 **106** 条：35 条 `M `（staged 修改）、2 条 `A `（staged 新增）、25 条 ` M`（仅工作区修改）、44 条 `??`（未跟踪，含被 staged 新增文件的未跟踪同级文件） |

## 3. 逐路径分类（`vsOriginMain`）

| 类别 | 条数 | 含义 |
|---|---:|---|
| `same-as-origin` | **84** | 这些文件的**磁盘内容与 `origin/main` 逐字节相同**，只是本地 `HEAD` 没有它（因为本地只到 C2）。属于**远端已交付**，不是新的本地改动。 |
| `local-edit` | **15** | 磁盘内容**既不同于 `HEAD` 也不同 `origin/main`** → 真正的本地未提交工作（app-assistant 方向）。 |
| `untracked-only` | **7** | 远端与本地 `HEAD` 都没有的文件（计划文档 / 用户笔记 / 验证残留）。 |

### 3.1 `same-as-origin`（84 条）覆盖面（远端已交付，禁止当成本轮新改动）

- B3/B4：`desktop/agent-tools-ipc.cjs`、`desktop/agent-workspace/checks.cjs`、`desktop/main.cjs`、
  `desktop/preload.cjs`、`desktop/project-ipc.cjs`、`desktop/composer-ipc.cjs`、`src/services/workspaceAgent/index.js`、
  `test/agent-tools-ipc.test.cjs`、`test/desktop-contract.test.cjs`、`scripts/agent-checks/*`。
- C3：`scripts/composer/source-overlay.cjs`、`scripts/composer/{emit,index}.cjs`、`test/composer-source-overlay.test.cjs`。
- C4：`test/fixtures/workspace-agent/c4-manual-slice/**`、`test/agent-workspace.c4-slice.test.cjs`、
  `docs/evidence/workspace-agent/c4-manual-slice/*`。
- D1：`contracts/workspace-agent.v1.json`、`server/src/agent/workspace/*.ts`（9 文件）、
  `server/test/workspace-agent.test.ts`、`server/src/agent/agent.module.ts`。
- 上游非 Agent 提交带来的 `templates/base/ordering-base/1.0.0/src/**`（fulfillment-switch、checkout、home、menu）、
  `miniprogram/**` 镜像、`templates/catalog/**`、`templates/registry/**`（堂食桌号与镜像/目录重生成）。
- 既有 11-19/11-20 交付的 `src/components/agent/*`、`src/domain/agentSidebar.mjs`、`test/agent-sidebar*` 等（远端同字节）。

### 3.2 `local-edit`（15 条）：真正的本地未提交工作（app-assistant），**归用户/上一轮，不得回滚**

`git diff --stat origin/main` = **905 插入 / 224 删除**：

| 文件 | 变更 |
|---|---|
| `src/state/sessionMachine.mjs` | +375/-… (最大) |
| `src/components/agent/AgentSidebarPanel.jsx` | +115 |
| `src/App.jsx` | +99 |
| `src/styles/agent-sidebar.css` | +124 |
| `src/components/agent/AppAssistantChangeCard.jsx` | +69 |
| `src/domain/appAssistantProposal.mjs` | +52 |
| `test/app-assistant-reducer.test.cjs` / `-proposal` / `-sidebar-panel` | +99 / +36 / +67 |
| `scripts/app-assistant-smoke.cjs` | +4 |
| `docs/app-assistant-contract.md`、`docs/evidence/app-assistant/README.md`、`docs/evidence/frontend-reconstruct/sidebar-t6-real-chain.md`、`docs/handoff/README.md`、`docs/handoff/当前工作区交接.md` | 文档回填 |

### 3.3 `untracked-only`（7 条）

| 文件 | 归属 |
|---|---|
| `docs/handoff/Workspace-Agent大规模重构与遗留收尾-Flash总计划.md` | 本轮总计划（Captain） |
| `docs/handoff/Workspace-Agent-E0闭环纠偏与E阶段-Flash续期计划.md` | 本轮 E0 计划（Captain） |
| `docs/handoff/图片驱动前端重构-raw生成方案.md` | 既有方案文档（未提交） |
| `Untitled.md`、`测试.md`、`华为云码道CodeArts代码智能体 2026-11-20.md` | 用户笔记（**保留，不纳入交付**） |
| `.resultverify/t6/evidence-run-A/summary.json` | 验证残留（保留，不纳入交付） |

## 4. 逐提交磁盘一致性核对（B3/B4/C3/C4/D1）

对每个远端提交，用 `git hash-object` 比对磁盘内容与提交内 blob：

| 提交 | 内容 | 文件数 | 磁盘一致 | 说明 |
|---|---|---:|---:|---|
| `a248685` | B3 RPC + preload + facade | 9 | 6/9 | 3 个文件被后续提交更新（见下），非丢失 |
| `1841c4e` | B3 `main.cjs` 补 `userDataDir` | 1 | 1/1 | — |
| `7afa6d0` | B4 验证注册表 | 6 | 6/6 | — |
| `3ff97ea` | C1 快照对齐远端模板 | 2 | 2/2 | — |
| `574458d` | C3 Composer 源码覆盖 | 4 | 4/4 | — |
| `f78d6cb` | C4 人工垂直切片 | 7 | 7/7 | — |
| `6d73d5f` | D1 workspace-agent 服务 | 12 | 12/12 | — |

`a248685` 的 3 个“不一致”文件（`desktop/agent-tools-ipc.cjs`、`desktop/main.cjs`、`test/agent-tools-ipc.test.cjs`）
经核对为**被后续提交 7afa6d0 / 1841c4e 更新**，磁盘内容与 `origin/main` 最新 blob **完全一致**：

```
desktop/agent-tools-ipc.cjs     origin/main=0d585429…  worktree=0d585429…  match=True  (last 7afa6d0)
desktop/main.cjs                origin/main=b18c748e…  worktree=b18c748e…  match=True  (last 1841c4e)
test/agent-tools-ipc.test.cjs   origin/main=bd2a3284…  worktree=bd2a3284…  match=True  (last 7afa6d0)
```

**结论：B3/B4/C3/C4/D1 的磁盘文件与远端一致，无本地私改、无丢失。**

## 5. 下一轮唯一基线树（冻结）

```text
基线 = origin/main(a540d78) 的树
     + 15 个 local-edit 文件（app-assistant，未提交，禁止回滚/覆盖）
     + 7 个 untracked-only 文件（计划文档 + 用户笔记 + 验证残留）
```

- 本地 `HEAD`（`437bf5f`）**不是**基线：它缺 B3–D1。任何 E0 交付必须按“磁盘 = origin/main 内容”描述自己的起点。
- 后续若需提交/对齐：只允许“worktree 叠到 `origin/main` + 逐文件裁决 + push”，**禁止** `reset --hard` /
  `checkout -- .` / `clean -fd` / 用 `-X ours|theirs` 整包吞冲突；需要改动这 15 个文件时必须先确认归属人。
- `.resultverify/`、`Untitled.md`、`测试.md`、`华为云码道…md`、`.dsh-acl-recovery/` 一律**不提交、不删除**。

## 6. 本任务未做（如实）

- 未提交任何 commit，未推送，未创建/删除分支。
- 未执行 `npm test` / `npm run build` 等官方门禁（E0-Git 只做集成身份确认；门禁由各任务与 verifier 出具）。
- 未判定 15 个 `local-edit` 的业务正确性（属 app-assistant 方向，不在 E0 范围）。
