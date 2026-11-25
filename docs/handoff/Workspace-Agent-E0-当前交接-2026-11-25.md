# Workspace Agent E0 当前交接（2026-11-25）

> 状态：**E0 部分完成，未通过最终独立验收；E1–E4 未开放。**
> 基线：原工作区 HEAD `437bf5f`，`origin/main` 已含 A0–D1；本轮 E0 增量从远端 `main` 单独叠加推送。
> 执行者：上一轮 Flash Team + 本轮收口修复。后续接线人先读本文，再读 `Workspace-Agent-E0闭环纠偏与E阶段-Flash续期计划.md` 与接口冻结 rev15。

## 1. 现在能做什么、不能做什么

已具备（代码与定向测试可复核）：

- 私有 Workspace/事务/不可变版本/undo/redo（B1/B2）。
- SourceFacts 8 页、AST source-check、Composer source overlay（C1–C4）。
- 桌面 `WorkspaceRunCoordinator` 唯一执行者：startRun → attempt → write/read/search → 派生 bundle → 检查 → submit → adopt。
- 真正的 direct 多轮工具 Runtime 和图片多模态 Runtime（`desktop/agent-runtime`），不是旧单次聊天适配器。
- 上游并发 `ModelCallScheduler`：最多 3，FIFO、排队超时、429/取消释放、direct/HTTP 口径。
- 手工 C4 页面+组件切片可导出；E0 UI 原型在 `src/components/agent/e0/`，**尚未接 App 主链**。

还不能宣称：

- 真实 Flash 端到端工具循环 + 参考图生成：**NOT_RUN**（本轮未消耗真实 Key）。
- 微信真实编译/截图、UIA/Electron、真机：**BLOCKED/NOT_RUN**。
- E0 最终 verdict：**未由 verifier 出具 PASS**；用户可用功能仍为 0，E1–E4 未开始。

## 2. 本轮修复（相对上一轮交付）

1. **产品 main 接错 Runtime**：`desktop/main.cjs` 原接 `agent-workspace/direct-runtime.cjs`（只发一条文本），现改为 `desktop/agent-runtime` 的多轮工具/多模态 Runtime，并显式 `vision:true`、传入 `userDataDir`。旧单次适配器保留兼容。
2. **模型可写平台清单**：`write_files/delete_files` 对 `source-bundle.json` 直接返回 `AGENT_PAYLOAD_INVALID`；平台仍是唯一派生者。
3. **adopt 信任可篡改 partial**：现在重新执行当前静态门禁，从 `wechat.verify` 证据推导 runtime 四态；`submission.partial=false` 不能绕过 `partialConfirmed`。
4. **提交门禁补全**：`source.check`、`composer.dry-run`、`mini.check`、`output.consistency` 均必填；`mini/output` 的证据主体正确要求为 `export`。
5. **图片证据卫生测试**：只扫描证据输出（json/md/txt/log），不误扫取证脚本里的普通 JS `data: null`。
6. **独立 W 组**：W13/W14/W15/W17 已更新到新契约并通过。

## 3. 本轮真实命令与结果

| 命令 | 结果 |
| --- | --- |
| `node --test --experimental-test-isolation=none test/agent-workspace.vertical-chain.test.cjs test/agent-workspace.direct-runtime.test.cjs` | **15/15 PASS** |
| `node --test ... test/runtime/images.test.cjs` | **26 pass / 1 skip**（skip：本机不允许创建文件 symlink） |
| `node scripts/e0-verify/run.cjs --mode offline --only W13,W14,W15,W17` | 产品用例 **W13–W17 全 PASS**；脚本随后因写 `e0-v1/run-report.json` 触发 sandbox EPERM，报告未更新 |
| 早前 `test/runtime` + scheduler | 84/86（图象卫生失败已修复；1 项环境 skip），调度器全绿 |

未运行：真实 Flash 调用、微信 CLI、Electron/UIA、安装包、server DB、全量 npm 门禁。

## 4. 已知问题 / 下一步（按优先级）

### P0 真实模型最小闭环

1. 用真实 `deepseek-flash` Key 走 `run-real-call.cjs` 或新增主进程脚本：真实参考图 → 模型图片理解 → `read_file` → `write_files` → `source.check` → `composer.dry-run` → `mini/output` → submit → partial adopt。
2. 验证图片真实出现在 content parts、工具结果回填、截断零执行、最多 3 并发。
3. 真实证据归档输入图片 sha、模型名、trace、treeDigest；不得保存 data URL/Key。

### P0 E0 独立验收

- 在可写环境下运行完整 `scripts/e0-verify/run.cjs --mode offline --write`，由 verifier 对稳定 revision 出具 verdict。
- 当前 run-report 过期且不是 verdict，不得当作 PASS。
- 仍需覆盖真实模型、微信/BLOCKED、E0 UI 的不冒充口径。

### P1 UI 接线

- E0 UI 原型目前未接 `App.jsx/sessionMachine`；按总计划 E3 接入图片输入、diff、截图、采用/undo，串行修改，避免多人冲突。
- 旧链 progress/截图 IPC 缺陷仍在，见 `docs/evidence/workspace-agent/ui-survey.md`。

### P1 服务端/HTTP

- HTTP `workspace-agent.v1` 仍没有真实桌面 RPC bridge；E 主链用 direct，HTTP 保持 unavailable，不要伪装可用。
- X9 服务端伪状态正则仍需删除（桌面已不做）。

### P2 基线

- `AGENT_MAX_CONCURRENT` 已为 3；上游真正限制由 `ModelCallScheduler` 保证，不能只看入口变量。
- 旧 catalog/mirror、DB、微信、UIA、安装包环境阻塞未变。

## 5. 写入边界

- 不修改正式 `templates/**`、只读 `miniprogram/**`、全局 Registry。
- 不执行模型/用户提供的命令；不写任意路径；不读取 Key。
- 不 reset/checkout/clean，不覆盖用户未提交资产。
- E0 未 PASS 前，不开放 E1–E4、不做全 8 页视觉验收。

## 6. 关键入口

- 计划：`docs/handoff/Workspace-Agent-E0闭环纠偏与E阶段-Flash续期计划.md`
- 冻结：`docs/handoff/Workspace-Agent-B阶段接口冻结.md`（rev15）
- 证据：`docs/evidence/workspace-agent/`（e0-w1/w2/r1/r2/u1/v1/reviews）
- Runtime：`desktop/agent-runtime/`
- Coordinator：`desktop/agent-workspace/run-coordinator.cjs`
- Scheduler：`desktop/model-call-scheduler.cjs`
- 独立验证器：`scripts/e0-verify/`
