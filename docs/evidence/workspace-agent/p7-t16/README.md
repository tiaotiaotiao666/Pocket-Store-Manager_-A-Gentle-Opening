# A4 旧 P7 / T16 证据收口（workspace-agent 重构首轮）

- 任务：`t5` / 总计划 §4 **A4：旧 P7/T16 证据收口**
- 执行者：verifier（独立验证；只写证据，不改产品代码）
- 时间：2026-11-24 16:56–17:04（+08:00）；HEAD `70e0057`；Node v24.14.0；DSH 沙箱 `workspace-write`
- 依赖：A0（`docs/evidence/workspace-agent/baseline/`）已证明官方 `npm test`/`build`/GUI/微信/MySQL 均受环境限制

> 纪律：**旧证据不得改写成通过，也不重造历史**。旧 P7 证据 `docs/evidence/frontend-reconstruct/` 原文不改；
> 本目录只新增本轮复跑结果与判定矩阵；历史步骤（T16 2026-11-12/13 的 0/1/4/5/6 步）保留为历史记录，
> 不重复伪造、也不当作本轮复验。
>
> 本轮新增的 frontend-reconstruct 复跑细节见
> [`docs/evidence/frontend-reconstruct/a4-rerun-2026-11-24.md`](../../frontend-reconstruct/a4-rerun-2026-11-24.md)。

## 1. P7 完成标准九项（复跑后判定，沿用旧口径）

| # | 完成标准 | 本轮判定 | 依据（真实命令/证据） |
| ---: | --- | --- | --- |
| 1 | 单图 → 非选模板的新候选 FrontendPack | **UNVERIFIABLE（不变）** | 旧 `clear-home` 原件已被 F3 清理，只剩 `real-probe-evidence.json` 摘要；A4 未重建三图、未调用模型 → 不可升级为 PASS |
| 2 | 能力覆盖/不确定项可见，缺能力不造假 | **PASS（契约/测试）**；真实三图场景 **UNMET** | server `frontend-reconstruct.{contract,service,runtime,capabilities,capabilities-script}` 155/155 pass（本轮复跑 EXIT 0）；unsupported/blurry 无当前可归档证据 |
| 3 | 页面 JS/业务/门店不被模型改写，视图走白名单 renderer/Composer | **PASS（测试）** | 上述 155/155 + root 160/160（renderer/materialize/dryrun）本轮 EXIT 0 |
| 4 | 候选在私有工作区生成，不改全局模板/Registry，不执行任意命令 | **PASS** | A0：`git status --porcelain -- templates miniprogram` 空、`git diff --quiet` 0；root 定向 workspace 测试 pass；候选只写 %TEMP%（本轮 verify 副本在 %TEMP%） |
| 5 | dry-run 全绿，失败 ≤2 轮修复，失败不覆盖当前版本 | **PASS（测试）**；真实候选 dry-run 新增可执行证据但非 P7 输入 | `frontend-verify --attempt <copy> --runtime` → `DRY_RUN_OK`（candidate `fr-251f19338c2e@1.0.0`、Composer 138 文件、mini:check 通过、consistency 通过），EXIT 3 仅因 runtime BLOCKED；repair 测试在 160/160 内 |
| 6 | 至少一张样例微信真实编译+截图+下单回归 | **BLOCKED → 未满足** | `frontend-verify --runtime` → `BLOCKED / RUNTIME_EVIDENCE_MISSING`（`details.cli=cli.bat, exitCode=1`，screenshots=[]）；CLI 写 AppData 被 EPERM（A0） |
| 7 | 采用/放弃/撤销/取消/重试/持久化/重开/导出同源 | **PASS（L1）**；GUI 走查 **BLOCKED** | root 定向 160/160（含 desktop/materialize/dryrun/Composer）；`agent:smoke` EXIT 2（spawnSync EPERM） |
| 8 | skills/文档齐全、全量测试通过、无秘密/base64 泄漏 | **UNMET** | 全量未全绿：`mini:check`/`mirror:check` PRE_EXISTING（A0）；官方全量测试 BLOCKED（spawn EPERM）；泄漏检查沿用 `leak-check.md`，本轮证据未含密钥/base64 |
| 9 | 生图模型保持未配置 | **PASS** | A0 实测 `IMAGE_API_BASE_URL`/`IMAGE_API_KEY`/`IMAGE_MODEL_NAME`/`VISION_MODEL_NAME` 均为空占位；本轮未接任何生图 |

**P7 整体：仍 `INCOMPLETE`。** 本轮没有把第 1/6/8 项改成通过。

## 2. T16 覆盖缺口逐项判定（旧全链路 Agent 人工走查）

历史记录：2026-11-12 已执行 0–6 步（真实模型 + 微信运行时四页渲染 + 两张截图回填），
2026-11-12/13 判定 `INCOMPLETE`，缺口 = 第 2 步三套模板切换、第 3 步 Ctrl+Z/redo。
以下为**本轮**能否补做的真实判定（环境不允许就 BLOCKED/NOT_RUN，不写 PASS）。

| 步骤 | 旧状态（历史，不改写） | 本轮判定 | 本轮真实依据 / 实际错误 |
| ---: | --- | --- | --- |
| 0 前置（MySQL 3306 / 后端 3000+readyz / Electron / 微信 IDE） | 2026-11-12 PASS（历史） | **BLOCKED** | A0 实测：3306/6379/3000/5173 全 `TcpTestSucceeded=False`；`GET /api/v1/readyz` → 无法连接；`npm run agent:app` → `spawn EPERM`；微信 CLI 初始化写 AppData `EPERM` |
| 1 对话 → 3 套模板候选（真实模型，meta.mock=false） | 2026-11-12 PASS（历史） | **NOT_RUN** | 需后端+MySQL+Electron；本轮后端未起。D0 只证明模型 API 可用，不代表应用链路可跑 |
| 2 三套模板切换 + 并排对比 + 窄窗堆叠 | **FAIL（覆盖缺口）**（历史 STALE_REF） | **BLOCKED**（GUI）；仅 L1 逻辑佐证 | `agent:smoke` EXIT 2 `spawnSync … EPERM`，无窗口/无 UIA 树；`test/session-presentation.test.cjs` + `test/template-revise-diff.test.cjs` 20/20 pass 只覆盖 reducer/面板逻辑，**不等于**真实切换/对比 |
| 3 对话式改模板 + **Ctrl+Z / Ctrl+Shift+Z** 真实生效 | **FAIL（覆盖缺口）**（历史） | **BLOCKED**（GUI）；仅 L1 语义佐证 | 同上：`session-presentation` 的 undo/redo 栈、模板错配丢弃等 20/20 pass，但没有真实键盘事件/GUI 证据 → 不能关闭缺口 |
| 4 传图 + Agent 填表（vision analyzed=true） | 2026-11-12 PASS（核心四项；手工改价/超限未覆盖） | **NOT_RUN** | 后端 3000/MySQL 未起；A4 时间盒内不重建模型调用链路 |
| 5 风格 + 提示词 + 生图占位（local-demo） | 2026-11-12 PASS（历史；UI 未直接显示 local-demo） | **NOT_RUN** | 同上（需 GUI/后端） |
| 6 导出 + 微信开发者工具编译 + 截图回填 | 2026-11-12 PASS（历史） | **BLOCKED** | 本轮 `frontend-verify --runtime` 真实调用 `wechat-devtools-run.cjs` → 退出 1、无 evidence json、`RUNTIME_EVIDENCE_MISSING`；CLI 写 AppData EPERM |
| 7 回填表 / 最终 VERDICT | `INCOMPLETE`（历史） | **维持 `INCOMPLETE`** | 第 2/3 步缺口未关闭；第 0/6 步本轮环境 BLOCKED；没有新 PASS 证据 |

补充：仓库内 `.resultverify/t6/evidence-run-A/`（2026-11-21，已跟踪）含一次 **T6 侧栏链路**的 dry-run 与
5 张微信运行时截图（home/menu/checkout/product-detail/order-detail-paid）。它**不属于 T16 全链路走查**，
也不能当作 P7 微信验收；仅记录其存在，避免误用。

## 3. 本轮可执行项汇总（真实退出码）

| 命令 | 退出码 | 结果 |
| --- | ---: | --- |
| root 定向 9 文件（frontend-reconstruct.* + app-frontend-reconstruct，单进程） | **0** | 160/160 pass，22.8s |
| server 定向 5 文件（`vitest --configLoader native --pool=threads`） | **0** | 155/155 pass，2.70s |
| `frontend:capabilities:check` / `registry:check` / `check:packaging` / desktop 等价 / server tsc | **0** | 见 A0 与 `a4-rerun-2026-11-24.md` |
| `node scripts/frontend-verify.cjs --attempt <T6 attempt 副本> --runtime` | **3** | dry-run `DRY_RUN_OK`（138 文件）；runtime `BLOCKED / RUNTIME_EVIDENCE_MISSING` |
| root `npm test`（官方） | **1** | 122 文件全 `spawn EPERM`，用例未执行 → BLOCKED |
| root `npm run build`（官方） | **1** | `spawn EPERM`（esbuild service）→ BLOCKED |
| `npm run agent:smoke` | **2** | `[agent-smoke] FAIL 无法启动 agent-desktop：spawnSync … EPERM` → BLOCKED |
| root 全量等价（A0 已跑，117 文件单进程分块） | **1** | 1294 tests/1284 pass/8 fail/2 skip；8 fail 中 6 沙箱 spawn、1 PRE_EXISTING（MIRROR）、1 NEW（B1 契约测试，见 t6） |
| server 全量等价（A0 已跑） | **1** | 539 pass/86 skip；6 文件因 MySQL 3306 不可达 BLOCKED |

## 4. 结论

1. P7 的**可执行门禁**在当前树全部通过（160/160、155/155、能力快照、注册表、打包、desktop、tsc），固定验证入口的
   dry-run 可执行（138 文件）；但 P7 **真实模型第 1 项仍 UNVERIFIABLE**、微信第 6 项仍 BLOCKED、整体仍 INCOMPLETE。
2. T16 第 2/3 步缺口**未关闭**（GUI/spawn EPERM），第 0/6 步本轮 BLOCKED，其余步骤 NOT_RUN；VERDICT 维持 INCOMPLETE。
3. 没有重建历史证据、没有新增三图、没有用 L1 测试或 React 预览冒充 GUI/微信；没有运行任何 `--write`/`sync` 洗绿命令。
4. 未改产品代码（`git status` 中产品改动均属团队启动前既有或 B1 已完成改动）；本轮新增仅
   `docs/evidence/frontend-reconstruct/a4-rerun-2026-11-24.md` 与 `docs/evidence/workspace-agent/p7-t16/**`。

## 5. 证据

- `docs/evidence/workspace-agent/p7-t16/README.md`（本文）
- `docs/evidence/workspace-agent/p7-t16/raw/a4-rerun.log`
- `docs/evidence/frontend-reconstruct/a4-rerun-2026-11-24.md`
- 上游：`docs/evidence/frontend-reconstruct/{gates,baseline,real-probe,completion-criteria,leak-check}.md`（未改）
- A0：`docs/evidence/workspace-agent/baseline/{baseline.md,env-probe.md,raw/}`
