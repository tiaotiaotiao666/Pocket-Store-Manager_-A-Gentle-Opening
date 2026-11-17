# 参考图 → 真实模型候选 → dry-run 实测（P7，归档摘要）

> **provenance / 可复核性（2026-11-17 t37 更正）**
> 本文件记录的是 t13 在 2026-11-17 02:56–02:59 执行的一次真实模型探针的**归档摘要**。
> 原始输入三张合成图、生成脚本 `gen_images.py`、临时探针脚本与候选 attempt 原件曾位于
> `.tmp/frontend-real-probe/`（gitignored 临时目录）和系统临时 userData；这些原件已在
> **F3 收口清理**时删除。仓库内**只剩本摘要**，没有图片二进制、探针脚本或候选工程，
> 也没有它们的 sha256，因此 **无法从仓库独立复核**该链路。
>
> 判定：`real-probe` = **`UNVERIFIABLE`（可复核性不足）**。本目录将计划 §10 第 1 项判为
> `UNVERIFIABLE`；P1 真实链路与三图矩阵见 `completion-criteria.md` §8。
> （计划文件 `docs/handoff/**` 不在 t37 inScope，需由 captain amend 同步第 1 项/P1 行。）
> 以下数字是 t13 当时记录的摘要，**不是**可重跑证据；不得据此宣称"已验收"或"三图通过"。

记录内容（仅摘要）：

- 模型：DeepSeek `deepseek-flash`，`provider=deepseek`、`mock=false`；key 只从 `server/.env` 读取，
  未打印、未落盘。
- 摘要归档副本：`real-probe-evidence.json`（本目录）。
- 结论：第 2 次运行记录为 `planned` 并记录 `DRY_RUN_OK`；微信真实编译/截图记录为
  `BLOCKED / RUNTIME_TOOL_MISSING`。同一输入第 1 次运行记录为 `needs-input`。

## 0. 原执行方式（历史记录，当前不可重放）

t13 当时的做法（原脚本/输入已删除，以下仅说明当时如何得到摘要）：

1. `cd server && npx tsc -p tsconfig.json --outDir %TEMP%\fr-p7-build-<8hex> --noEmit false --incremental false`
   → 只写系统临时目录，服务端源码零改动；
2. 用 `NODE_PATH=<repo>/server/node_modules` 运行临时 CJS 探针，加载编译后的
   `FrontendReconstructService` / `DeepseekChatModel`，读取 `.tmp/frontend-real-probe/clear-home.png`
   后走真实模型；
3. 拿到 `planned` 响应后调用仓库内 P2 `materializeCandidate` 与 P3 `dryRun`、`verifyRuntime`，
   候选写入系统临时 userData（`projects/p7-real/frontend-runs/frun-p7-real/attempts/attempt-1`，
   该目录已随会话清理，未归档）。

> 上述路径仅用于解释摘要来源，**现已不存在**；本目录不提供"可重跑"路径。若要恢复可复核性，
> 需要重建三张合成图 + 探针脚本并重跑真实模型（属新的取证任务，不在 t37 范围）。

## 1. 两次运行摘要（同一输入，t13 记录）

| 项 | A（首次，02:56） | B（复跑，02:58） |
| --- | --- | --- |
| status | `needs-input` | `planned` |
| coverage | `partial`，degradations 3 | `partial`，degradations 2，missingCapabilities 0 |
| draft | 无（draftPages=[]） | `home`，19 个节点 |
| modelCalls | 8 | 4 |
| toolCalls | `get_frontend_capabilities:ok`、`check_frontend_coverage:ok`、`propose_frontend_draft:fail ×5` | 三者全 ok |
| stopReason | `needs_input` | `final_answer` |
| 耗时 | 65027ms（latency 64478ms） | 17484ms（latency 16907ms） |
| materialize | 未执行（无候选） | 摘要记录 `MATERIALIZE_OK`，attempt 1，8 个文件 |
| dry-run | `NOT_RUN`（response-not-planned） | 摘要记录 `DRY_RUN_OK` |
| 微信运行时 | 未执行 | `BLOCKED / RUNTIME_TOOL_MISSING`，截图 0 |

A 的摘要形态：`event=frontend_tool_rejected code=FRONTEND_RESPONSE_INVALID path=$.draft issueCount=1`
连续 5 次，随后 `run_end status=completed stopReason=needs_input`（C1 门禁拒绝草稿）。
**finding F1**：真实链路对模型抖动敏感、无自动重试；同输入两次结果不同。

## 2. 候选与 dry-run 摘要（原始候选已清理，仅摘要）

| 字段 | 记录值（来自 t13 摘要，无法从仓库复核） |
| --- | --- |
| candidateId | `fr-5038d20dde55` |
| version | `1.0.0` |
| integrity（候选树摘要） | `sha256:44e95b72d411a87610caf5d2f0b5dcca1a3b39bda91f4846c5ca478a57faab11` |
| draftDigest | `sha256:5038d20dde5597cdc7d7c24ee0755619d22ab16ea5df4da0422a825445ac2b46` |
| overlay registryDigest | `sha256:6283be45da72cb68a2cd615c3797a2d0221132ceb39971bf13246a983c33163c` |
| requiresSlots | `home-hero` |
| 候选文件（记录） | 8 个：`manifest.json`、`preview/{normal,empty,error,long}.json`、`src/pages/home/{index.json,index.wxml,index.wxss}`（无 `.js`） |
| 降级（记录） | `PAGE_JSON_KEY_UNSUPPORTED` ×2（`navigationBarBackgroundColor`、`navigationBarTextStyle`） |

dry-run 摘要（记录值）：

- `code=DRY_RUN_OK`，issues=[]；
- Composer P0–P6：138 个文件，树摘要 `sha256:efa1c455c35782b6ab9b96cf5061faf38867296a564805d0ec290fbf1e519a73`；
- mini:check：8 页 / 14 组件 / 0 错误；output-consistency：0 problems；
- 可观察项 4 项：通过 1、失败 0、未执行 1、未测量 1、不适用 1（无像素百分比）；
- 生成 WXML 摘要：无 `{{home.}}`/`{{menu.}}`/`{{cart.}}` 规范 token、`{{store.name}}` 原样、
  `home-hero` fallback 成对；处理器记录为 `onModeChange/goMenu/onPickTable/onRetryTables/onRetry/
  goOrders/onOpenOrder/goMine/goMerchant`。

> 以上 `integrity`/`treeSha256` 只是当时写入摘要的字符串，**对应文件已不存在**，无法校验其真实性。

## 3. 微信运行时（BLOCKED，不伪造）

`verifyRuntime` 固定调用 `scripts/wechat-devtools-run.cjs`，记录结果：

```text
status=BLOCKED
code=RUNTIME_TOOL_MISSING
summary=微信运行时 BLOCKED：本机未找到微信开发者工具 cli.bat（可用 WX_CLI_PATH 指定）
screenshots=0
```

本机 `WX_CLI_PATH` 未设，三个候选 `cli.bat` 路径均不存在；因此**没有**微信真实编译、页面截图或
关键下单路径回归证据。计划 §10 第 6 项与总体验收据此保持 `BLOCKED/INCOMPLETE`，不得用 React 预览截图替代。
（t13 还对当时的 attempt 跑过一次固定入口 `frontend-verify --runtime`，退出码 3；该 attempt 已清理，
该记录同样只是摘要。）

## 4. 历史失败重跑摘要（原文件已删除）

原 `.tmp/frontend-real-probe/evidence.json` 在 2026-11-17 01:43 曾被一次失败重跑覆盖（三图均
`FRONTEND_FACTS_INVALID(500)`：clear-home 31995ms、unsupported 18718ms、blurry 11106ms），
并非 P1 早期成功记录。该文件已随 F3 清理删除；其摘要保留在 `real-probe-evidence.json` 的
`historicalProbe` 字段中（仅作历史说明，不再作为证据）。当前快照已由服务端 `A1/F1` 测试与
`frontend:capabilities:check` 证明一致，但**不能**用这些测试替代真实模型三图证据。

## 5. 可复核性状态（t37）

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 合成参考图三张（clear/unsupported/blurry） | 已删除，未归档 | 原在 `.tmp/frontend-real-probe/`；无 sha256 |
| 生成脚本 `gen_images.py` | 已删除，未归档 | 原在 `.tmp/frontend-real-probe/` |
| 临时探针脚本 | 已删除，未归档 | 原在 `%TEMP%` 与本目录之外的临时路径 |
| 候选 attempt 原件 | 已删除，未归档 | 原在系统临时 userData |
| 仓库内证据 | 仅 `real-probe-evidence.json` 摘要 | 不可独立复核 |

**结论：`real-probe` = UNVERIFIABLE。** 若要恢复，需要在新的取证任务中重建合成图/脚本、
重跑真实模型并归档可校验的产物（图片 sha256 + 生成脚本 + 候选摘要），不得在缺少真实产物时恢复 PASS。
