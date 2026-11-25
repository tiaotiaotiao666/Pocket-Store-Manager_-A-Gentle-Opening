# Workspace Agent E0 当前交接（2026-11-25）

> 状态：**E0 技术闭环通过（静态 + 真实 Flash direct）；微信运行时仍 BLOCKED；E1 可开工。**
> 基线：`origin/main@f481e85`。2026-11-26 本轮继续修复 E0 并已真实调用 Flash；下一轮见
> `Workspace-Agent-E1-下一轮任务-2026-11-26.md`。
> 执行者：上一轮 Flash Team + 2026-11-26 收口。接口冻结仍以 rev15 为准。

## 0. 2026-11-26 最新结论（优先阅读）

- **真实 Flash 最小链 PASS**（`docs/evidence/workspace-agent/e0-v1/real-chain.json`）：
  真实首页图 sha256 `50c57435…f527`、91,690 B → 3 次真实调用 → `get_context`/`read_file`/`write_files`
  全部成功 → 四项检查 PASS → submit(partial) → 未确认被拒 → 确认后 v2 → undo v1 → redo v2。
- **图片确实进入多模态消息**：`multimodal=true`，返回图片 sha256 与输入逐字节一致；证据不含 Key/data URL。
- **新补用户入口**：`agent:run-turn`（平台创建 run/turn/attempt 并执行 direct 回合）与
  `agent:get-attempt`；preload/facade 共 22 个语义方法。渲染层仍无法传 channel/路径/命令。
- **修复**：assistant 只带 tool_calls 时 `content:null` 被本地规范器误拒（真实第三次调用失败点）；
  adopt 时重算导出树摘要（排除 compose 后写入的 Lock/报告），篡改导出树必然 `AGENT_EVIDENCE_STALE`；
  无微信证据时 runtime 记 `BLOCKED`（不是 `NOT_RUN`）；失败回包保留 `images/multimodal`。
- **仍不能宣称**：微信真实编译/截图、真机/UIA、E0 UI 已接 App、产品卡内部视觉变化、真实视觉修复多轮。

## 1. 现在能做什么、不能做什么

已具备（代码与定向测试可复核）：

- 私有 Workspace/事务/不可变版本/undo/redo（B1/B2）。
- SourceFacts 8 页、AST source-check、Composer source overlay（C1–C4）。
- 桌面 `WorkspaceRunCoordinator` 唯一执行者：startRun → attempt → write/read/search → 派生 bundle → 检查 → submit → adopt。
- 真正的 direct 多轮工具 Runtime 和图片多模态 Runtime（`desktop/agent-runtime`），不是旧单次聊天适配器。
- 上游并发 `ModelCallScheduler`：最多 3，FIFO、排队超时、429/取消释放、direct/HTTP 口径。
- 手工 C4 页面+组件切片可导出；E0 UI 原型在 `src/components/agent/e0/`，**尚未接 App 主链**。

还不能宣称：

- 用户可用功能已交付：E0 UI 原型**尚未接 App 主链**，真实图片入口还不在产品界面里。
- 微信真实编译/截图、UIA/Electron、真机：**BLOCKED/NOT_RUN**。
- 正式 t8 已签署 E0 PASS：`run.cjs` 的阶段 verdict 仍按设计固定 `NOT_RUN`；当前是
  “离线 114/114 可执行用例 PASS + 真实 direct 链 PASS”，签署权仍在 verifier。
- 真实视觉理解已验证”（A 图能描述红色圆/蓝色方块），但**页面级视觉还原质量**未做基准评测。

## 2. 本轮修复（相对上一轮交付）

1. **产品 main 接错 Runtime**：`desktop/main.cjs` 原接 `agent-workspace/direct-runtime.cjs`（只发一条文本），现改为 `desktop/agent-runtime` 的多轮工具/多模态 Runtime，并显式 `vision:true`、传入 `userDataDir`。旧单次适配器保留兼容。
2. **模型可写平台清单**：`write_files/delete_files` 对 `source-bundle.json` 直接返回 `AGENT_PAYLOAD_INVALID`；平台仍是唯一派生者。
3. **adopt 信任可篡改 partial**：现在重新执行当前静态门禁，从 `wechat.verify` 证据推导 runtime 四态；`submission.partial=false` 不能绕过 `partialConfirmed`。
4. **提交门禁补全**：`source.check`、`composer.dry-run`、`mini.check`、`output.consistency` 均必填；`mini/output` 的证据主体正确要求为 `export`。
5. **图片证据卫生测试**：只扫描证据输出（json/md/txt/log），不误扫取证脚本里的普通 JS `data: null`。
6. **独立 W 组**：W13/W14/W15/W17 已更新到新契约并通过。

## 3. 2026-11-26 真实命令与结果

| 命令 | 结果 |
| --- | --- |
| `node scripts/e0-verify/run.cjs --mode offline` | **114 PASS / 0 FAIL / 8 NOT_RUN**（7 条 R 真实模型用例 + A21O 观察项按设计 NOT_RUN） |
| `node docs/evidence/workspace-agent/e0-v1/run-real-chain.cjs` | **PASS**：3 次真实 Flash、图片 sha 一致、四项检查 PASS、partial adopt、undo/redo |
| `node docs/evidence/workspace-agent/e0-r2/run-real-call.cjs` | **PASS**：A 带图正确描述红圆/蓝方；B 不带图、C 只给 assetId 都明确拒绝编造 |
| `node --test ... agent-tools-ipc / desktop-contract / workspace-agent-service` | 新增 run-turn/get-attempt；IPC 与 22 方法桥接回归通过 |
| `node --test ... agent-workspace.coordinator / vertical-chain` | **31/31 PASS**（A08/A09 修复后） |
| 服务端 `workspace-agent.test.ts` + scheduler + `tsc` | **17 + 32 例 PASS，tsc 0** |

未运行：真实微信 CLI/编译截图、Electron/UIA、安装包、MySQL DB 集成、完整 `npm test`。

## 4. 已知问题 / 下一轮（详见 E1 任务书）

### P0 用户 UI（下一轮第一优先）

- E0 UI 原型还没接 `App.jsx/sessionMachine`；渲染层已有 22 个语义方法，但用户仍不能在应用里上传图并启动。
- 需要 `continueTurn`：同一 open attempt 的第二轮修复；当前只能新 run，失败候选不能就地修复。
- 需要产品卡内部修改的真实验收，当前真实链只改了页面 WXML。

### P1 微信/UIA

- 本机微信 CLI 不可用 → `BLOCKED`；不得用 React 截图冒充。UI 必须有 `BLOCKED/NOT_RUN` 展示路径。
- E1-D 在可用环境补 before/after 同 route/尺寸截图；不可用则明确 partial。

### P1 服务端/HTTP

- HTTP `workspace-agent.v1` 仍没有真实桌面 RPC bridge；E 主链用 direct，HTTP 保持 unavailable。
- X9 服务端伪状态正则仍需删除（桌面已不做）。

### P2 基线

- `AGENT_MAX_CONCURRENT` 入口限制为 3；上游真正限制由 `ModelCallScheduler` 保证，不能只看入口变量。
- 旧 catalog/mirror、DB、微信、UIA、安装包环境阻塞未变。

## 5. 写入边界

- 不修改正式 `templates/**`、只读 `miniprogram/**`、全局 Registry。
- 不执行模型/用户提供的命令；不写任意路径；不读取 Key。
- 不 reset/checkout/clean，不覆盖用户未提交资产。
- E1 用户路径未验收前，不扩全 8 页视觉、不宣称产品已交付；微信不可用必须如实 partial。

## 6. 关键入口

- 计划：`docs/handoff/Workspace-Agent-E0闭环纠偏与E阶段-Flash续期计划.md`
- 冻结：`docs/handoff/Workspace-Agent-B阶段接口冻结.md`（rev15）
- 证据：`docs/evidence/workspace-agent/`（e0-w1/w2/r1/r2/u1/v1/reviews）
- Runtime：`desktop/agent-runtime/`
- Coordinator：`desktop/agent-workspace/run-coordinator.cjs`
- Scheduler：`desktop/model-call-scheduler.cjs`
- 独立验证器：`scripts/e0-verify/`
