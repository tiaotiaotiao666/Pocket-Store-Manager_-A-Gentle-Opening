# 图片驱动前端重构 P7 证据（frontend-reconstruct）

> 目录状态：2026-11-17 P7 执行后的最终证据索引；基线 `main@e2eb16ac`。
> 证据等级沿用 [`docs/evidence/README.md`](../README.md)：`L1` 本机 Node 测试/静态门禁、`L2` 本机 Electron、
> `W` 微信开发者工具真实编译、`R` 真机。**本目录不含 prompt、图片 base64、原始模型响应或密钥。**

## 最终结论

**P0–P7 已执行；整体验收 `INCOMPLETE`。** 拆开说：

- P7 的**可执行定向门禁**（verifier #1–#7）全部 exit 0：`registry-check`、`check-packaging`、
  root 定向 9 文件 158/158、server 定向 5 文件 155/155、server `tsc`、`frontend:capabilities:check`、
  `test:desktop` 等价 23/23。详见 [`gates.md`](gates.md)。
- captain 在 danger-full-access 下补跑：root `npm run build` 0（vite 6.4.5 / 4.34s，dist 刷新）、
  `registry:check` 0、`test:desktop` 0、server `tsc` 0、server `npm run build` 0；
  root `npm test` 1（975/971，2 项基线失败）、server `npm test` 1（6 个 MySQL 依赖文件失败）。
- **BASELINE**：`catalog:check`（4 项 `product-detail` 漂移）、`mini:check`、`mirror:check`（MIRROR 摘要/CRLF）
  为仓库既有基线失败；[`baseline.md`](baseline.md) 用 `git diff/status` 证明输入与 HEAD 一致，未用
  `--write`/`mirror:sync` 掩盖。
- **BLOCKED**：`agent:smoke` 无窗口；微信真实编译/截图无 DevTools `cli.bat`，参考图候选的
  `verifyRuntime` 返回 `BLOCKED / RUNTIME_TOOL_MISSING`、截图 0。因此计划 §10 第 6 项与总体验收
  只能 `BLOCKED/INCOMPLETE`，不得宣称“微信运行时通过”。
- **UNVERIFIABLE**：t13 真实模型链路的输入三图、生成脚本、探针与候选 attempt 原件已在 F3 收口清理时删除，
  仓库只剩 `real-probe.md` 的归档摘要与 `real-probe-evidence.json`；没有 sha256，**无法独立复核**。
  因此计划 §10 第 1 项为 `UNVERIFIABLE`，三图矩阵 `clear-home=UNVERIFIABLE`、`unsupported/blurry=UNMET`，
  不得用单一 `clear-home` 摘要冒充三图通过。

真实模型链路只剩归档摘要（`SUMMARY_ONLY / UNVERIFIABLE`）：t13 摘要记录同一张合成图首次运行 `needs-input`
（propose 连续 5 次 `FRONTEND_RESPONSE_INVALID`，8 calls），复跑 `planned`（4 calls）→ 候选
`fr-5038d20dde55`（8 文件、无 `.js`）→ `DRY_RUN_OK`（摘要记录值，不可复核）；微信 `BLOCKED`。这些是**记录值**，不是可重跑证据：
原始图/脚本/候选 attempt 已删除、无 sha256，无法独立复核。仓库固定入口 `node scripts/frontend-verify.cjs`
需要在重新归档的 attempt 上才能执行；t13 记录的退出码 3 仅作历史参考（如实表示 BLOCKED/NOT_RUN）。

## 真实文件清单（7 个文本文件）

| 文件 | 内容 | 等级 | 状态 |
| --- | --- | --- | --- |
| `README.md` | 本索引：最终结论、文件清单、遗留项 | 汇总 | 与下列证据一致 |
| `gates.md` | 计划 §9 门禁：真实命令、退出码、`GATE`/`CAPTAIN_RUN`/`BASELINE`/`BLOCKED` 标注 | L1 | 可执行门禁全绿；全量命令含基线失败 |
| `baseline.md` | catalog 4 项漂移与 MIRROR 摘要/CRLF 的 pre-existing 判定（未执行掩盖型命令） | L1 | 已判定 |
| `real-probe.md` | 真实模型链路归档摘要 + provenance：原件已清理、仓库只剩摘要；同图两次运行差异 | L1 + 真实模型（摘要） | **SUMMARY_ONLY / UNVERIFIABLE**；微信 `BLOCKED` |
| `real-probe-evidence.json` | 上述链路的有界摘要（状态/计数/耗时/摘要值）；`reproducibility.status=UNVERIFIABLE` | L1 + 真实模型（摘要） | **SUMMARY_ONLY / UNVERIFIABLE** |
| `completion-criteria.md` | 计划 §10 九项完成标准逐项 PASS/UNVERIFIABLE/UNMET/BLOCKED 与原因；§8 三图矩阵 | 汇总 | **INCOMPLETE**（第 1 项 `UNVERIFIABLE`；unsupported/blurry `UNMET`） |
| `leak-check.md` | 密钥/base64/prompt/原始响应扫描、候选资产检查、F3 收口后的历史残留记录 | L1 | 无真实泄漏；残留已清理（历史清单） |

本目录**没有**候选工程、截图或图片二进制；t13 候选曾写系统临时目录的
`projects/p7-real/frontend-runs/frun-p7-real/attempts/attempt-1`，该原件已随 F3 清理删除；
`templates/`、`miniprogram/` 与全局 Registry 均未出现候选资产（见 `leak-check.md` §2）。

## 已知遗留与收口状态

- **F1（保留）**：真实链路对模型抖动敏感——同一张图/同一请求可能首次 `needs-input`、复跑才 `planned`；
  [`real-probe.md`](real-probe.md) 的归档摘要如实记录两次运行，不隐藏失败、不把复跑成功写成稳定通过。
  记录值唯一，原件已清理、不可独立复核；后续需评估提示词/调用预算或显式重试策略。
- **F3（已由 captain 收口）**：`leak-check.md` §3 记录的是执行时的探针残留清单；
  captain 在收口时已删除 `server/.tmp-probe/`、`server/src/agent/frontend-reconstruct/.write-probe`、
  `page-capabilities.snapshot.*` 与 `.tmp/frontend-real-probe/`，并确认
  `node scripts/frontend-capabilities.cjs --check` 与 `node scripts/check-packaging.cjs` 仍 exit 0。
  因此 §3 清单是**历史记录**，不代表当前工作区仍存在这些文件。
- **基线修复（独立任务）**：catalog 4 项 `product-detail` 重生成并 review；MIRROR 摘要与换行语义
  （`core.autocrlf=true` + DevTools `project.private.config.json`）统一后重算提交；不得用 `--write`/`mirror:sync`
  在本验证任务中掩盖。
- **微信真实编译/截图/关键下单回归（环境）**：需在装有微信开发者工具并登录的机器上执行
  `node scripts/frontend-verify.cjs --attempt <attemptDir> --draft <draft.json> --runtime`；
  在此之前保持 `BLOCKED`，不得用 React 预览截图替代。
- 计划 §12 已由 P7 回填，并已按 t37 更正 P1/P7 的真实模型口径（`UNVERIFIABLE/UNMET`）；本目录只保存证据索引，
  不重复改写计划验收结论。
