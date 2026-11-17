# 计划 §10 完成标准逐项判定（P7，t37 更正）

> 判定规则：`PASS` = 有可复核证据支撑；`UNVERIFIABLE` = 有摘要但原始件缺失、无法独立复核；
> `UNMET` = 条件未满足；`BLOCKED` = 环境不可用。**整体结论仍为 `INCOMPLETE`。**
>
> **t37 更正（2026-11-17）**：F3 收口清理删除了 `.tmp/frontend-real-probe/`（三张合成图、`gen_images.py`、
> 候选 attempt 原件），仓库只剩 `real-probe-evidence.json` 摘要 → 真实模型链路不可独立复核。
> 按 t14-F1 要求，第 1 项由 `PASS` 改为 **`UNVERIFIABLE`**；三图矩阵见本文 §8（clear-home `UNVERIFIABLE`，
> unsupported/blurry `UNMET`）。第 8 项保持 `UNMET`。**没有**用单一 clear-home 运行冒充三图通过。

| # | 完成标准 | 判定 | 证据 / 原因 |
| --- | --- | --- | --- |
| 1 | 单张图片+可选文字可生成不是"选已有模板"的新候选 FrontendPack | **UNVERIFIABLE**（原 PASS，t37 降级） | t13 摘要记录 `clear-home`（28156B）复跑为 `planned`、draft home 19 节点、candidate `fr-5038d20dde55`、`DRY_RUN_OK`；但输入图/候选 attempt 原件已被 F3 清理删除、无 sha256，仓库无法独立复核 → 按 t14-F1 标 UNVERIFIABLE，不得继续标 PASS。真实三图矩阵见 §8 |
| 2 | 能力覆盖和不确定项真实可见，缺必需能力不会生成假页面 | **PASS（契约/测试）**；真实三图见 §8 | 服务端 155 项定向测试覆盖 covered/partial/rejected、模型不能伪造 covered、缺页面/组件/动作拒绝且不写 workspace；`partial`/`degradations` 由服务端计算。真实模型侧：clear-home 摘要记录 partial/2 降级/0 missing（不可复核）；unsupported/blurry 的 rejected/needs-input **无当前可归档证据** → 真实场景部分见 §8 `UNMET`，不能据此宣称三图能力矩阵已验证 |
| 3 | 页面 JS/业务/门店菜品不被模型改写；所有视图经过白名单 renderer 与 Composer | **PASS（测试）**；真实候选摘要不可复核 | 真实候选摘要记录 8 文件无 `.js`、WXML 无 `{{home./menu./cart.}}`、`{{store.name}}` 原样、slot fallback 成对（原件已清理，无法复核）；P2/P4 测试另证 Composer emit 后页面 JS 与 Base 逐字节一致、renderer 白名单拒绝任意源码。测试证据不受原件清理影响 |
| 4 | 候选在私有工作区生成，不改全局模板/Registry，不执行任意命令 | **PASS** | `git diff --quiet -- templates miniprogram` = 0、`git status --porcelain -- templates miniprogram` 为空、`templates/frontend-packs` 无 `fr-5038d20dde55`；P2/P3 测试覆盖私有 workspace 路径/symlink/junction/overlay 拒绝；微信验证只允许固定 `scripts/wechat-devtools-run.cjs`（自定义 scriptPath 被拒）。候选曾写系统临时 userData（已清理），不在仓库 |
| 5 | dry-run 全绿，失败有最多两轮真实修复；失败不覆盖当前版本 | **PASS（测试）**；真实 dry-run 摘要不可复核 | P3 修复测试 12/12：payload 只含结构化 issues+有界 previousDraft、严格 ≤2 轮、第 3 次 `REPAIR_LIMIT_EXCEEDED`、失败 `adoption:'none'` 且 `keptDraft` 为进入本轮前版本；不可 DSL 定位的故障不自动修复。t13 摘要记录真实候选 `DRY_RUN_OK`，但候选原件已清理，无法独立复核 |
| 6 | 至少一张样例完成微信真实编译、截图和关键下单动作回归；否则总体验收标 INCOMPLETE | **BLOCKED → 未满足** | `verify-runtime` 对当时候选记录为 `BLOCKED / RUNTIME_TOOL_MISSING`（本机无 `cli.bat`，截图 0）；没有微信编译、页面截图或下单链路回归。**因此整体 INCOMPLETE**，不得用 React 预览截图替代 |
| 7 | 采用/放弃/撤销/取消/重试/持久化/重开/正式导出可用且同源 | **PASS（L1）**；GUI 走查 `BLOCKED` | P5/P4 定向测试：app+persistence 41/41、desktop 23/23（materialize+dry-run+Composer 全链路、adopt/undo/discard/cancel、旧响应丢弃、失败保留输入、candidateCheck 漂移阻断导出、撤销未校验版本仍阻断）；`t33/t34` 已复核 verified 门禁。GUI 端到端走查因 `agent:smoke` 无法启动标 `BLOCKED` |
| 8 | 四个 skills 和文档齐全，全量测试通过，无秘密/图片 base64 泄漏 | **UNMET**（skills/文档/泄漏 PASS；全量测试未全绿） | skills 11/11、文档已补齐、泄漏扫描通过（`leak-check.md`）；**但** root `npm test` 975/971（2 项基线失败：catalog 4 项漂移、MIRROR 摘要），server `npm test` 460/545（6 个 MySQL 依赖文件失败）→ "全量测试通过"不成立 |
| 9 | 生图模型仍保持未配置，未借此任务接入任何生图 provider | **PASS** | `server/.env` 只读检查：`IMAGE_PROVIDER_NAME=not-configured`、`IMAGE_MODEL_NAME` 为空；本轮未新增生图依赖/端点；能力/视觉链只调用 `DEEPSEEK_VISION_MODEL`（deepseek-flash）做图片理解 |

## §8 三图真实场景矩阵（t14-F2 / t37 更正）

| 样本（合成图） | 计划 §8 期望 | 当前可归档证据 | 判定 |
| --- | --- | --- | --- |
| `clear-home.png`（28156B） | Base 近似首页 → `planned`，有候选与 dry-run | 仅 `real-probe-evidence.json` 摘要（t13 记录：A `needs-input`、B `planned`/partial/19 节点/候选 `fr-5038d20dde55`/`DRY_RUN_OK`/微信 BLOCKED）；**图片与候选原件已被 F3 清理删除，无 sha256** | **UNVERIFIABLE**（有摘要、不可独立复核） |
| `unsupported-home.png`（25739B） | 含不支持业务 → `rejected`、draft=null、缺失能力可见 | 无当前证据；只有 t4 任务报告口头记录（rejected/10 missing）与 2026-11-17 01:43 失败重跑摘要（`FRONTEND_FACTS_INVALID`），两者原件均已删除，且均非当前可复核结果 | **UNMET**（无当前可归档证据） |
| `blurry-home.jpg`（8475B） | 模糊图 → `needs-input`、draft=null、不编造 | 无当前证据；只有 t4 任务报告口头记录（needs-input）与 01:43 失败重跑摘要，原件已删除 | **UNMET**（无当前可归档证据） |

**P1 阶段表口径**：不得用单一 clear-home 运行代替三图真实场景矩阵。P7 的 P1/P7 行必须同时写明
`clear-home=UNVERIFIABLE、unsupported/blurry=UNMET`；整体 INCOMPLETE。
（计划文件 `docs/handoff/**` 不在 t37 inScope，计划 §10/§12 的 P1/P7 行需由 captain amend 同步；
本节 §8 是 P7 证据侧的判定记录。若后续要恢复 PASS，需重新归档三图 + 生成脚本 + 候选摘要并重跑真实模型。）

## 汇报口径（给 captain / 用户，t37 更正）

- 可以说：**P0–P6 本地受控候选重构链已实施并通过定向门禁**；t13 摘要记录过一张参考图候选与 dry-run，
  但**原始件已清理、不可独立复核（UNVERIFIABLE）**。
- 不可以说：**"已验收" / "全量门禁全绿" / "微信运行时通过" / "三图真实场景矩阵通过" / "像素级复刻"**。
- 明确未执行/不可复核：微信真实编译与截图（BLOCKED）、真机 R（范围外）、安装包 L3/L4、
  GUI 端到端走查（BLOCKED）、生图（按计划不接）、三图真实场景矩阵（unsupported/blurry 无当前证据）。
- 基线遗留：catalog 4 项漂移、MIRROR 摘要/CRLF 不一致、server 6 个 MySQL 依赖失败文件 ——
  均为 `baseline.md` 证明的 pre-existing 问题，需独立任务修复，不得靠 `--write`/`mirror:sync` 掩盖。
