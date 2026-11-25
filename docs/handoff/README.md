# 交接区索引

> 新会话先读 `docs/项目概览.md`，再选择本页的活动交接。`archive/` 只用于追溯，不是当前任务入口。

## 活动交接

| 文档 | 适用任务 | 当前状态 |
| --- | --- | --- |
| `Workspace-Agent-E1-下一轮任务-2026-11-26.md` | **E1 目标与验收定义**：真实图片→源码→验证→采用的用户 UI、`continueTurn` 修复、product-card、独立真实验收 | 下一轮；E0 技术闭环已通过，E1 可开工 |
| `Workspace-Agent-E1-AgentTeams执行方案-2026-11-26.md` | **交给 AgentTeams 的完整分工**：3 个屏障、7 个任务卡、文件所有权、DAG、建队参数、停止条件 | 按方案 staged plan 后执行 |
| `Workspace-Agent-E0-当前交接-2026-11-25.md` | **E0 事实入口**：已完成/未完成、真实命令、真实 Flash 证据、已知缺口 | E0 离线 114/114 PASS + 真实 direct PASS；微信 BLOCKED，正式 t8 待签署 |
| `Workspace-Agent-E0闭环纠偏与E阶段-Flash续期计划.md` | **E0 历史任务书**：X1–X12 纠偏、Coordinator、真实图片、attempt 验证/采用 | 主体已落地；保留为根因与边界依据 |
| `Workspace-Agent大规模重构与遗留收尾-Flash总计划.md` | 总体路线图：通用源码 Workspace Agent、8 页图片重构、版本/采用/导出、旧 P7/T16 与业务/安装包欠账 | A–D1 部分落地；下一步先读 E0 续期计划，再回原总计划 F/G/H/I |
| `当前工作区交接.md` | **当前活动**：了解未提交改动、全链路 Agent 打通进度、图片驱动前端重构 P0–P6 与环境阻塞 | 持续更新；T1–T14 已完成，T15/T16 为 `INCOMPLETE`；2026-11-17 新增图片驱动前端重构 P0–P6（契约/视觉服务/私有 workspace/overlay/dry-run/桌面主链/采用持久化/导出同源 + 四个 skills + 过程可观测性）；P7 执行结果见 `docs/evidence/frontend-reconstruct/`（整体 `INCOMPLETE`） |
| `Agent工具体系与交互健壮性.md` | Agent 运行时改造方案（function calling + 工具权限 + 轮次约束 + markdown 渲染与输入边界校验） | 服务端部分已由上游 `agent-run.v1` 落地（2026-11-12）；**桌面端接线与 UI 侧改造仍待做** |
| `图片驱动前端重构-Flash实施计划.md` | 单张参考图 → 受控 FrontendPack 候选 → dry-run/微信验证 → 采用/撤销/持久化；含四个 skills 与完整验收矩阵 | **P0–P7 已执行；P7 部分 `BASELINE`/`BLOCKED`，整体 `INCOMPLETE`**；门禁与真实探针见 [`docs/evidence/frontend-reconstruct/`](../evidence/frontend-reconstruct/README.md)，实测结果以计划 §12 为准（由 P7 回填） |
| `核心闭环重构计划-业务优先.md` | 下一阶段核心业务重构决策、分期实施和前端 facade 契约 | **已启动**；先跑通微信执行与真实前后对比，再重排 Agent 主流程，最后清理历史实现 |
| `P0-执行链打通-构建说明.md` | P0 执行（打包/依赖、统一微信 CLI、交互参与总状态、安装版验证）的改动、门禁与真实证据 | **P0 已完成**；真实 DevTools 证据见 [`docs/evidence/p0/`](../evidence/p0/)，下一步 P1（截图 IPC + Ctrl+Z/redo） |

当前活动任务：**图片驱动前端重构收口与遗留项处理**。P0–P6 已落地；P7 已按计划 §8/§9 执行并保存真实证据，但整体验收为 `INCOMPLETE`：可执行定向门禁通过，`catalog:check`/`mini:check`/`mirror:check` 为 pre-existing 基线失败，`agent:smoke` 与微信真实编译/截图因环境不可用而 `BLOCKED`。P7 证据入口：[`docs/evidence/frontend-reconstruct/README.md`](../evidence/frontend-reconstruct/README.md)、门禁细节 [gates.md](../evidence/frontend-reconstruct/gates.md)、基线判定 [baseline.md](../evidence/frontend-reconstruct/baseline.md)、真实探针 [real-probe.md](../evidence/frontend-reconstruct/real-probe.md)、完成标准 [completion-criteria.md](../evidence/frontend-reconstruct/completion-criteria.md)、泄漏检查 [leak-check.md](../evidence/frontend-reconstruct/leak-check.md)。计划 §12 已由 P7 回填，本索引不重复验收结论；不得据此宣称微信真实运行时或全量门禁已通过。历史背景：2026-11-12 已走通 T16 0–6 步（真实模型 + 微信运行时四页渲染 + 截图回填），但 T16 仍因覆盖缺口为 `INCOMPLETE`。

## 历史摘要

| 文档 | 保留原因 | 当前替代入口 |
| --- | --- | --- |
| `archive/2026-10-31-B2小程序完成.md` | 记录 B2 交付范围、验证结果与剩余验收缺口 | `docs/B2小程序实现说明.md` |
| `archive/2026-10-31-B1业务后端完成.md` | 记录 B1 交付范围、139 项测试与真实联调结果 | `docs/B1业务后端实现说明.md` |
| `archive/2026-10-31-Agent资料收集与DeepSeek接入.md` | 记录 Agent 设计决策、DeepSeek 接入和真实验证 | `agent-turn-contract.md` |
| `archive/2026-10-31-Windows安装包审计.md` | 记录安装包下载阻塞和后续验收要求 | `windows-deployment.md`、待完成目标 |
| `archive/2026-10-31-当前工作区交接.md` | 记录 2026-10-31 的 P0 未提交资产、桌面修复与 M5–M7 状态 | 当前 `当前工作区交接.md` |

## 新交接的编写规则

1. 活动交接直接放在 `handoff/`，以长期主题命名，不使用“本轮”“上一轮”。
2. 开头写日期、状态、适用任务、上游契约和一句话结论。
3. 正文至少包含：已完成事实、改动文件、真实命令与结果、未解决问题、下一步、禁止项。
4. 只写代码和契约无法表达的接续信息；完整 API、字段和环境步骤链接到主文档，避免复制漂移。
5. 阶段完成后更新项目概览和待完成目标，将交接归档或改写为下一活动阶段，并更新本索引。
6. 历史摘要文件名使用 `YYYY-MM-DD-主题.md`，注明“历史”及当前替代入口。
7. 不在交接中保存密钥、Token、完整敏感日志或大段可从代码重建的文件清单。
8. 工作区存在未提交改动时，明确哪些是用户资产；禁止用 reset/checkout/clean 等操作回滚。

> 2026-11-20 追加活动交接：`全应用统一会话Agent-Flash实施计划.md`（右侧栏统一会话 `app-assistant.v1`，T1–T8 已实现，T9 自动化门禁 PASS、真实模型/GUI/微信 NOT_RUN 或 BLOCKED；证据 `docs/evidence/app-assistant/README.md`）。
